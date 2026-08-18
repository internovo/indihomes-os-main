"""LLM provider abstraction — Grok (xAI) / Gemini / Groq / NVIDIA NIM (Nemotron) /
any OpenAI-compatible endpoint / an optional local model. NO Anthropic
anywhere in this file or anything it imports — that's a hard project rule
(see requirements.md).

All providers speak the OpenAI chat-completions wire format (xAI, Gemini,
Groq, and NVIDIA NIM all expose OpenAI-compatible endpoints; "openai"/
"local" are that format by definition), so one thin client class covers all
of them — no per-provider SDK branching.

Role-based routing (Part 22 of the brief): MODEL_REASONING / MODEL_EXTRACTION
/ MODEL_FALLBACK env vars each hold a provider key ("xai" | "gemini" |
"groq" | "nvidia" | "openai" | "local") naming which provider handles that
role. A role's candidate list is [that provider, MODEL_FALLBACK's provider,
then every other configured provider] — deduplicated — so a role always has
somewhere to fall back to if its preferred provider is unset or its call
fails.

Groq/NVIDIA added as the primary providers after Gemini's prepaid credits
ran out mid-session (confirmed live: RESOURCE_EXHAUSTED 429) and no
XAI_API_KEY was ever configured — both were entirely idle as a result
despite being 2 of the 4 originally-supported providers. Groq's default
model is intentionally NOT llama-3.3-70b-versatile: Groq announced its
deprecation June 17, 2026 in favor of openai/gpt-oss-120b (Groq's own
migration recommendation) — defaulting to a model already flagged for
shutdown would just recreate the exact "model 404s, circuit breaks, falls
back to nothing" failure this file exists to prevent.

If NO provider is configured at all, `LLMRouter.is_configured()` returns
False and every caller in this codebase treats that as "run the
deterministic-only path" (Part 28: graceful degradation), never a crash and
never a fabricated LLM-shaped response.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Optional

from openai import AsyncOpenAI

logger = logging.getLogger("ai-search-agent.llm")

# ── Per-process provider circuit breaker (Part P0.7/P0.8) ──────────────────
# LLMRouter is instantiated FRESH at every call site (once per candidate's
# extraction pass, once for the curator, ...) — without a process-level
# memory of "this provider/model just returned a permanent error", every
# one of those fresh instances independently retries and refails against
# the exact same dead model. Verified live: a deprecated Gemini model
# (models/gemini-2.0-flash, "no longer available") produced 10 repeated
# identical 404s across one research run before this existed.
_provider_state: dict[str, dict] = {}  # provider key -> {"unavailable_until": monotonic time, "reason": str}
_PERMANENT_ERROR_MARKERS = (
    # Model-availability errors — will fail identically until someone
    # fixes the configured model name.
    "no longer available", "model not found", "does not exist", "not_found",
    "unsupported_model", "invalid model", "model_not_found", "decommission",
    # Billing/quota errors — verified live (a real Gemini key hitting
    # "Your prepayment credits are depleted", HTTP 429 RESOURCE_EXHAUSTED)
    # — equally permanent for the rest of THIS billing cycle/run, so
    # equally worth circuit-breaking rather than retrying per candidate.
    "resource_exhausted", "quota", "credits are depleted", "insufficient_quota",
    "billing", "prepayment",
    # Auth errors — a bad/revoked key will fail identically on every call.
    "invalid_api_key", "unauthorized", "permission_denied", "api key not valid",
)
CIRCUIT_TTL_S = int(os.getenv("LLM_PROVIDER_CIRCUIT_TTL_MS", "300000")) / 1000

# Call-budget counters (Part P0.8) — reset once per top-level research
# request (app.py/graph.py's very first node) so they reflect THIS run,
# never the whole process's lifetime; read into research_metadata by the
# curator.
_llm_metrics = {"llm_calls": 0, "llm_failures": 0, "llm_fallbacks": 0}


def reset_llm_metrics() -> None:
    _llm_metrics["llm_calls"] = 0
    _llm_metrics["llm_failures"] = 0
    _llm_metrics["llm_fallbacks"] = 0


def get_llm_metrics() -> dict:
    return dict(_llm_metrics)


def _is_permanent_error(error_str: str) -> bool:
    e = error_str.lower()
    return any(marker in e for marker in _PERMANENT_ERROR_MARKERS)


def provider_unavailable(key: str) -> Optional[str]:
    state = _provider_state.get(key)
    if state and state["unavailable_until"] > time.monotonic():
        return state["reason"]
    return None


def _mark_provider_unavailable(key: str, reason: str) -> None:
    _provider_state[key] = {"unavailable_until": time.monotonic() + CIRCUIT_TTL_S, "reason": reason}
    logger.warning("[llm-provider:%s] circuit broken for %ss (permanent-looking error): %s", key, CIRCUIT_TTL_S, reason)


@dataclass(frozen=True)
class ProviderSpec:
    key: str
    label: str
    base_url: Optional[str]      # None -> official OpenAI default
    key_env: str                 # env var holding the API key (or, for
                                  # 'local', the base URL itself)
    model_env: str
    default_model: str


PROVIDER_SPECS: dict[str, ProviderSpec] = {
    "xai": ProviderSpec(
        "xai", "Grok (xAI)", "https://api.x.ai/v1",
        "XAI_API_KEY", "XAI_MODEL", "grok-4-fast",
    ),
    "gemini": ProviderSpec(
        "gemini", "Gemini (Google)",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "GEMINI_API_KEY", "GEMINI_MODEL", "gemini-2.5-flash",
    ),
    "groq": ProviderSpec(
        "groq", "Groq", "https://api.groq.com/openai/v1",
        "GROQ_API_KEY", "GROQ_MODEL", "openai/gpt-oss-120b",
    ),
    "nvidia": ProviderSpec(
        "nvidia", "NVIDIA NIM (Nemotron)", "https://integrate.api.nvidia.com/v1",
        "NVIDIA_API_KEY", "NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b",
    ),
    "openai": ProviderSpec(
        "openai", "OpenAI-compatible", None,
        "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-4o-mini",
    ),
    "local": ProviderSpec(
        "local", "Local/open-source model", None,
        "LOCAL_LLM_BASE_URL", "LOCAL_LLM_MODEL", "",
    ),
}

ROLE_ENV = {
    "reasoning": "MODEL_REASONING",
    "extraction": "MODEL_EXTRACTION",
    "fallback": "MODEL_FALLBACK",
}
# Switched from xai/gemini defaults — xai was never configured (no
# XAI_API_KEY was ever set in this deployment) and gemini's prepaid credits
# ran out mid-session (RESOURCE_EXHAUSTED, confirmed live), so both original
# defaults were pointing at providers that were either always-idle or
# freshly dead. groq is the new default for every role: it's the provider
# actually configured and working in this deployment right now.
ROLE_DEFAULT_PROVIDER = {
    "reasoning": "groq",    # planning + curation
    "extraction": "groq",   # lightweight structured extraction/reranking
    "fallback": "nvidia",   # a genuinely independent provider/account from groq, not just a second model on the same one
}


def _extract_json(text: str) -> Optional[dict]:
    """Best-effort JSON extraction for a provider/model that ignored the
    requested json_object response format and wrapped its answer in prose
    or a markdown fence — tried only after a direct json.loads fails.
    """
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        try:
            return json.loads(brace.group(0))
        except json.JSONDecodeError:
            pass
    return None


class LLMClient:
    def __init__(self, key: str, label: str, base_url: Optional[str], api_key: str, model: str):
        self.key = key
        self.label = label
        self.model = model
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url) if base_url else AsyncOpenAI(api_key=api_key)

    async def complete_json(self, system: str, user: str, max_tokens: int = 2000, temperature: float = 0.2) -> Optional[dict]:
        _llm_metrics["llm_calls"] += 1
        try:
            resp = await self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                max_tokens=max_tokens,
                temperature=temperature,
                response_format={"type": "json_object"},
            )
        except Exception as e:  # noqa: BLE001 - any provider/network failure must degrade, not crash
            _llm_metrics["llm_failures"] += 1
            err = str(e)
            logger.warning("[llm:%s] request failed: %s", self.key, err)
            if _is_permanent_error(err):
                # A permanent config error (deprecated/unknown model) will
                # fail identically on every future call in this process
                # until someone fixes the model name — circuit-break it
                # instead of paying the same failed request over and over
                # (Part P0.7).
                _mark_provider_unavailable(self.key, f"{self.model}: {err[:200]}")
            return None
        content = (resp.choices[0].message.content or "").strip()
        if not content:
            return None
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            parsed = _extract_json(content)
            if parsed is None:
                logger.warning("[llm:%s] response was not valid JSON", self.key)
            return parsed


def _build_client(spec: ProviderSpec) -> Optional[LLMClient]:
    if spec.key == "local":
        base_url = os.getenv(spec.key_env)
        model = os.getenv(spec.model_env)
        if not base_url or not model:
            return None
        return LLMClient(spec.key, spec.label, base_url, os.getenv("LOCAL_LLM_API_KEY", "not-needed"), model)
    api_key = os.getenv(spec.key_env)
    if not api_key:
        return None
    model = os.getenv(spec.model_env) or spec.default_model
    return LLMClient(spec.key, spec.label, spec.base_url, api_key, model)


class LLMRouter:
    """One router per role. Builds its candidate chain once at construction;
    `complete_json` tries each candidate in order and returns as soon as one
    succeeds — real primary-then-fallback behavior, not just a config flag.
    """

    def __init__(self, role: str):
        self.role = role
        preferred = os.getenv(ROLE_ENV.get(role, ""), ROLE_DEFAULT_PROVIDER.get(role, "groq"))
        fallback = os.getenv(ROLE_ENV["fallback"], ROLE_DEFAULT_PROVIDER["fallback"])
        order = [preferred, fallback, "groq", "nvidia", "xai", "gemini", "openai", "local"]
        seen: set[str] = set()
        self.candidates: list[LLMClient] = []
        self.attempted_providers: list[str] = []
        for key in order:
            if key in seen or key not in PROVIDER_SPECS:
                continue
            seen.add(key)
            client = _build_client(PROVIDER_SPECS[key])
            if client:
                self.candidates.append(client)

    def is_configured(self) -> bool:
        return bool(self.candidates)

    def provider_labels(self) -> list[str]:
        return [c.label for c in self.candidates]

    async def complete_json(self, system: str, user: str, **kwargs) -> tuple[Optional[dict], Optional[str]]:
        for i, client in enumerate(self.candidates):
            broken_reason = provider_unavailable(client.key)
            if broken_reason is not None:
                # Skip WITHOUT a network call — this provider already
                # failed permanently earlier in this process (Part P0.7);
                # move straight to the next candidate instead of paying
                # the same doomed request again.
                logger.info("[llm-router:%s] skipping %s (circuit broken: %s)", self.role, client.label, broken_reason)
                if i > 0 or len(self.candidates) > 1:
                    _llm_metrics["llm_fallbacks"] += 1
                continue
            result = await client.complete_json(system, user, **kwargs)
            if result is not None:
                return result, client.label
            logger.info("[llm-router:%s] %s returned nothing usable, trying next candidate", self.role, client.label)
            if i < len(self.candidates) - 1:
                _llm_metrics["llm_fallbacks"] += 1
        return None, None
