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

from openai import AsyncOpenAI, APIStatusError

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
    # "403"/"forbidden" added after Phase 0 confirmed live NVIDIA was
    # paying a doomed round-trip on every single call (body: {'status':
    # 403, 'title': 'Forbidden', 'detail': 'Authorization failed'}) because
    # neither word was in this tuple — a 403 is exactly as permanent as a
    # 401 for this codebase's purposes (a bad/unentitled key fails
    # identically until a human fixes it), it just wasn't circuit-breaking.
    "invalid_api_key", "unauthorized", "permission_denied", "api key not valid",
    "403", "forbidden", "model not available", "no access",
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


def _extract_error_detail(status_code: int, body) -> str:
    """A short, human-readable `"<status>: <real message>"` string from a
    provider's raw error body — used by /health?probe=true so a probe
    failure shows the actual HTTP detail instead of the generic
    "provider returned no usable JSON" every other caller of
    complete_json() sees (that generic message is correct for THEM — they
    only need to know to fall back, not why). Providers use genuinely
    different body shapes (confirmed live): NVIDIA is a flat dict with
    `detail` ({'status': 403, 'title': 'Forbidden', 'detail':
    'Authorization failed'}); Gemini wraps a LIST containing one
    {'error': {'code', 'message', 'status'}} dict; Groq is a flat dict with
    `message`/`code`. Handles all three without guessing a fourth shape.
    """
    if isinstance(body, list) and body and isinstance(body[0], dict):
        body = body[0]
    msg = None
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            # Prefer the short machine-readable `status` (e.g.
            # "RESOURCE_EXHAUSTED") over the long human `message` — the
            # short form is what's actually useful in a one-line probe
            # result; the full message is still in the permanent per-call
            # warning log for anyone who needs it.
            msg = err.get("status") or err.get("message")
        else:
            msg = body.get("detail") or body.get("message") or body.get("title")
    if not msg:
        msg = str(body)[:150]
    return f"{status_code}: {msg}"


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

    async def _attempt(self, system: str, user: str, max_tokens: int, temperature: float) -> tuple[Optional[dict], bool, Optional[str]]:
        """One real API call. Returns (parsed_json_or_None, truncation_shaped, error_detail).

        error_detail is a real `"<status>: <message>"` string (via
        _extract_error_detail) whenever the call didn't produce a usable
        result — None only on genuine success. Threaded through so
        /health?probe=true can show the real reason (Phase 1, item 2 —
        the generic "provider returned no usable JSON" the rest of the
        codebase sees isn't useful at 3am).

        truncation_shaped is True exactly when Phase 0's diagnostic run
        showed this failure mode: Groq's `json_validate_failed` 400 with an
        empty `failed_generation` (the reasoning model spent its entire
        max_tokens budget on internal reasoning tokens before emitting any
        JSON — confirmed live, `x-ratelimit-remaining-tokens` showed real
        TPM headroom both times, ruling out rate limiting as the cause), or
        a genuine `finish_reason == "length"` on a 200. Neither is a
        permanent provider error and neither may circuit-break the
        provider — `complete_json` below gives it exactly one retry with a
        bigger budget instead.
        """
        _llm_metrics["llm_calls"] += 1
        kwargs = dict(
            model=self.model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=max_tokens,
            temperature=temperature,
            response_format={"type": "json_object"},
        )
        # Phase 1a — Groq's openai/gpt-oss-120b is a reasoning model whose
        # internal reasoning tokens draw from the SAME max_tokens budget as
        # the actual JSON answer (Phase 0 confirmed live: a real
        # extraction-shaped call against a dense page excerpt spent 284 of
        # 321 completion tokens on reasoning alone). reasoning_effort="low"
        # cuts that consumption dramatically without touching what gets
        # extracted (confirmed live, same prompt: 43 of 85 tokens) — it only
        # throttles HOW MUCH the model reasons before answering, never what
        # it's allowed to say, so Rule 2/3 (never fabricate, deterministic
        # stays the source of truth) are untouched by this. Passed via
        # extra_body since this SDK version's typed create() doesn't
        # recognize the parameter (raises TypeError if passed directly) but
        # forwards extra_body verbatim into the request JSON. Groq-only —
        # not a documented parameter for the other OpenAI-compatible
        # providers this file talks to.
        if self.key == "groq":
            kwargs["extra_body"] = {"reasoning_effort": "low"}
        try:
            resp = await self._client.chat.completions.create(**kwargs)
        except Exception as e:  # noqa: BLE001 - any provider/network failure must degrade, not crash
            _llm_metrics["llm_failures"] += 1
            err = str(e)
            truncation_shaped = False
            error_detail = f"{type(e).__name__}: {err[:200]}"
            # Phase 0 diagnostic instrumentation — logs the FULL raw error
            # body, not str(e) truncated, plus every rate-limit header a
            # real 429 would carry (retry-after/x-ratelimit-remaining-
            # tokens/x-ratelimit-reset-tokens) — present only on a genuine
            # rate-limit response, absent on a truncation-shaped 400. Kept
            # permanently, not just for the one-off diagnostic run — this is
            # exactly the visibility that was missing before Phase 0.
            if isinstance(e, APIStatusError):
                headers = dict(e.response.headers) if getattr(e, "response", None) is not None else {}
                rate_limit_headers = {
                    k: v for k, v in headers.items()
                    if k.lower() in ("retry-after", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
                                      "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests")
                }
                logger.warning(
                    "[llm:%s] model=%s request failed: status_code=%s body=%s rate_limit_headers=%s",
                    self.key, self.model, e.status_code, e.body, rate_limit_headers,
                )
                body = e.body if isinstance(e.body, dict) else {}
                truncation_shaped = body.get("code") == "json_validate_failed"
                error_detail = _extract_error_detail(e.status_code, e.body)
            else:
                logger.warning("[llm:%s] model=%s request failed (non-APIStatusError): %s: %s", self.key, self.model, type(e).__name__, err)
            if _is_permanent_error(err):
                # A permanent config error (deprecated/unknown model) will
                # fail identically on every future call in this process
                # until someone fixes the model name — circuit-break it
                # instead of paying the same failed request over and over
                # (Part P0.7). A truncation-shaped failure is never in
                # _PERMANENT_ERROR_MARKERS, so this never fires for it.
                _mark_provider_unavailable(self.key, f"{self.model}: {err[:200]}")
            return None, truncation_shaped, error_detail
        usage = resp.usage
        finish_reason = resp.choices[0].finish_reason
        logger.warning(
            "[llm:%s] model=%s SUCCESS finish_reason=%s usage(prompt=%s, completion=%s, total=%s)",
            self.key, self.model, finish_reason,
            getattr(usage, "prompt_tokens", None), getattr(usage, "completion_tokens", None), getattr(usage, "total_tokens", None),
        )
        content = (resp.choices[0].message.content or "").strip()
        if not content:
            return None, finish_reason == "length", f"200: empty content (finish_reason={finish_reason})"
        try:
            return json.loads(content), False, None
        except json.JSONDecodeError:
            parsed = _extract_json(content)
            if parsed is None:
                # Phase 0 diagnostic instrumentation — the raw content that
                # failed to parse, so a truncated-mid-JSON payload is
                # visibly distinguishable from prose/markdown-wrapped JSON
                # that _extract_json also couldn't rescue.
                logger.warning(
                    "[llm:%s] response was not valid JSON (length=%d): %r",
                    self.key, len(content), content[:500],
                )
            return parsed, (finish_reason == "length" if parsed is None else False), (None if parsed is not None else "200: response was not valid JSON")

    async def _complete_json_with_error(self, system: str, user: str, max_tokens: int = 2000, temperature: float = 0.2) -> tuple[Optional[dict], Optional[str]]:
        """Same one-retry-on-truncation orchestration as complete_json below,
        but also returns the real error_detail from the LAST attempt —
        used by /health?probe=true (item 2: the generic message every
        other caller sees isn't useful at 3am). complete_json() itself
        keeps its existing Optional[dict]-only contract so nothing else in
        the codebase (LLMRouter and every caller through it) needs to
        change.
        """
        result, truncation_shaped, error_detail = await self._attempt(system, user, max_tokens, temperature)
        if result is not None or not truncation_shaped:
            return result, error_detail
        retry_max_tokens = min(max_tokens * 2, 4000)
        logger.warning("[llm:%s] retrying once with max_tokens=%d after a truncation-shaped failure", self.key, retry_max_tokens)
        result, _, error_detail = await self._attempt(system, user, retry_max_tokens, temperature)
        return result, error_detail

    async def complete_json(self, system: str, user: str, max_tokens: int = 2000, temperature: float = 0.2) -> Optional[dict]:
        # Phase 1a — exactly ONE retry with roughly double the budget,
        # capped, for a truncation-shaped failure only (see _attempt's
        # docstring) — never treated as a permanent provider error and
        # never circuit-broken, this is a per-call budget problem, not a
        # dead provider. Capped at 4000 rather than doubling unboundedly:
        # Groq's real account TPM ceiling (8000, confirmed live in Phase 0)
        # means an unbounded doubling risks trading one failure for
        # another. Delegates to _complete_json_with_error (same retry
        # logic, also used by the health probe) rather than duplicating it.
        result, _ = await self._complete_json_with_error(system, user, max_tokens, temperature)
        return result


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
