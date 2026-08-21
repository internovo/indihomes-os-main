"""FastAPI entrypoint for the AI Search research agent — the "small HTTP
service" Part 1 asks for when a Node-only integration isn't practical. Node
(server.cjs) calls POST /agent/ai-search when LANGGRAPH_ENABLED=true; the
existing external-search.cjs path is untouched and used whenever this
service is disabled or unreachable (Part 28: production safety).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

# Load the SAME .env the Node backend uses (repo root), so both services
# agree on which connectors/providers are configured — one source of truth
# for credentials, not a second .env to keep in sync.
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

logging.basicConfig(level=os.getenv("AGENT_LOG_LEVEL", "INFO"))
logger = logging.getLogger("ai-search-agent")

from agent.graph import get_graph  # noqa: E402  (import after dotenv load so env-dependent modules see it)
from agent.llm_providers import LLMRouter, PROVIDER_SPECS, _build_client, _provider_state  # noqa: E402
from agent import tools as agent_tools  # noqa: E402

app = FastAPI(title="IndiHomes AI Search Agent", version="1.0.0")


class AISearchRequest(BaseModel):
    query: str
    market: str = "india"


# Section 5 fix (RERA enrichment) — a lightweight, SCOPED sibling to the
# main /agent/ai-search pipeline, not a variant of it. Takes an ALREADY-
# IDENTIFIED project (from Property Search or AI Search — either entry
# point) and runs one targeted lookup for its RERA number only, reusing
# tools.rera_lookup (web_search + fetch_page + fact_extraction's own
# nearest_match-protected regex, the same extraction machinery the main
# pipeline already depends on). Deliberately outside the LangGraph state
# machine — no discovery/dedup/scoring/eligibility needed when the project
# is already known, just one extraction pass.
class ReraLookupRequest(BaseModel):
    name: str
    locality: str | None = None
    city: str | None = None


@app.post("/agent/rera-lookup")
async def rera_lookup_route(req: ReraLookupRequest):
    rera, record = await agent_tools.rera_lookup(req.name, req.locality, req.city)
    # Source URL/provider deliberately never returned here (Part 2's
    # explicit "never show source/provider in the UI" rule) — only the
    # extracted number itself and whether the lookup found anything.
    return {"rera": rera, "found": bool(rera), "duration_ms": record["duration_ms"]}


# System A (Places-direct) enrichment — a lightweight, SCOPED sibling to
# /agent/rera-lookup above, same reasoning: an already-identified building
# (this time from Google Places, not RERA lookup) gets ONE bounded real
# web search + extraction pass, reusing tools.enrich_property (itself
# reusing deep_research's own fact_extraction/normalize machinery) rather
# than a second extraction pipeline. Called from server.cjs's Places-direct
# branch, bounded to the top 10-15 results by Places' own relevance rank —
# never the full 20, and never blocking Places-direct's own discovery call.
class EnrichPropertyRequest(BaseModel):
    name: str
    locality: str | None = None
    city: str | None = None
    configuration: str | None = None
    market: str = "india"


@app.post("/agent/enrich-property")
async def enrich_property_route(req: EnrichPropertyRequest):
    result, record = await agent_tools.enrich_property(req.name, req.locality, req.city, req.configuration, req.market)
    result["duration_ms"] = record["duration_ms"]
    return result


def _circuit_breaker_snapshot() -> dict:
    """Phase 1c — the current LLM circuit-breaker state
    (llm_providers._provider_state), included in BOTH /health modes (cheap
    default and ?probe=true) so a provider that's ALREADY known-broken this
    process (Part P0.7's circuit breaker) is visible without needing a real
    network call to rediscover it. Only currently-tripped entries — an
    expired TTL is the same as never having tripped.
    """
    now = time.monotonic()
    return {
        key: {"reason": state["reason"], "seconds_remaining": max(0.0, round(state["unavailable_until"] - now, 1))}
        for key, state in _provider_state.items()
        if state["unavailable_until"] > now
    }


async def _probe_one_provider(key: str, client) -> dict:
    """Phase 1c — one real, minimal completion (~10 tokens) against ONE
    configured provider, short-timeout, meant to be run in parallel across
    every configured provider. This is what `reasoning_configured: true`
    should have meant all along — Phase 0's whole investigation started
    from `/health` reporting all three providers healthy while all three
    were actually failing, because the cheap default only ever checked
    "is an API key present," never "does this provider answer."
    """
    start = time.monotonic()
    try:
        # max_tokens=50, not the originally-planned ~10 — found live while
        # verifying this probe: even a TRIVIAL prompt against Groq's
        # openai/gpt-oss-120b, WITH reasoning_effort="low" already active,
        # reliably fails below max_tokens=30 (a fixed ~14-token reasoning
        # floor this model pays regardless of question complexity — 10 and
        # 20 both failed with the identical json_validate_failed/empty
        # failed_generation shape as the real production failures; 30+
        # succeeded every time). 50 leaves real margin above that floor
        # without meaningfully lengthening the probe.
        # _complete_json_with_error (not complete_json) — the real
        # "<status>: <message>" detail (e.g. "403: Authorization failed",
        # "429: RESOURCE_EXHAUSTED"), not the generic "no usable result"
        # every other caller of complete_json sees. That generic message is
        # correct for them (they only need to know to fall back); a probe
        # exists specifically to answer "why," so it needs the real detail.
        result, error_detail = await asyncio.wait_for(
            client._complete_json_with_error("Respond with JSON only.", 'Reply with exactly {"ok": true}.', max_tokens=50),
            timeout=10.0,
        )
        ok = isinstance(result, dict)
        return {"key": key, "label": client.label, "model": client.model, "ok": ok,
                "error": None if ok else error_detail,
                "latency_ms": int((time.monotonic() - start) * 1000)}
    except asyncio.TimeoutError:
        return {"key": key, "label": client.label, "model": client.model, "ok": False,
                "error": "probe timed out (10s)", "latency_ms": int((time.monotonic() - start) * 1000)}
    except Exception as e:  # noqa: BLE001 - a probe failure must report, never crash /health
        return {"key": key, "label": client.label, "model": client.model, "ok": False,
                "error": str(e)[:300], "latency_ms": int((time.monotonic() - start) * 1000)}


@app.get("/health")
async def health(probe: bool = False):
    reasoning = LLMRouter("reasoning")
    extraction = LLMRouter("extraction")
    response = {
        "ok": True,
        "llm": {
            "reasoning_configured": reasoning.is_configured(),
            "reasoning_providers": reasoning.provider_labels(),
            "extraction_configured": extraction.is_configured(),
            "extraction_providers": extraction.provider_labels(),
        },
        "circuit_breaker": _circuit_breaker_snapshot(),
        # Presence-only — never echoes the actual key value. LANGSMITH_TRACING
        # must be the literal string "true" for LangGraph/LangChain's
        # tracing callback to actually attach; a key with tracing left off
        # is a common "why aren't traces showing up" cause (Part 43/46).
        "langsmith": {
            "tracing_enabled": os.getenv("LANGSMITH_TRACING", "").lower() == "true",
            "api_key_configured": bool(os.getenv("LANGSMITH_API_KEY")),
            "project": os.getenv("LANGSMITH_PROJECT") or None,
            "endpoint": os.getenv("LANGSMITH_ENDPOINT") or "https://api.smith.langchain.com (default)",
        },
    }
    # Phase 1c — ?probe=true only: a real, minimal completion per configured
    # provider, run in parallel. Deliberately NOT the default (this spends
    # real tokens/quota on every call to a health endpoint, which is exactly
    # the kind of always-on cost a cheap health check shouldn't carry) — the
    # default response above stays free, same as before this pass.
    if probe:
        clients = {key: _build_client(spec) for key, spec in PROVIDER_SPECS.items()}
        clients = {key: c for key, c in clients.items() if c is not None}
        results = await asyncio.gather(*[_probe_one_provider(key, c) for key, c in clients.items()])
        response["llm"]["probe"] = list(results)
    return response


AGENT_VERSION = os.getenv("AGENT_VERSION", "2.0.0")  # bumped for the deep-research pipeline this pass adds


@app.post("/agent/ai-search")
async def ai_search(req: AISearchRequest):
    start = time.monotonic()
    graph = get_graph()
    # Tags/metadata on the top-level invocation (Part 26) — LangSmith
    # attaches these to the run tree ROOT, so every node/tool span nested
    # under this one call inherits them; a trace can be filtered/grouped by
    # market or agent_version in the LangSmith UI without opening each run.
    result = await graph.ainvoke(
        {"original_query": req.query, "market": req.market, "research_iterations": 0},
        config={
            "recursion_limit": 50,
            "tags": ["ai-search", req.market],
            "metadata": {"search_query": req.query, "market": req.market, "agent_version": AGENT_VERSION},
        },
    )
    duration_ms = int((time.monotonic() - start) * 1000)
    response = result.get("final_response") or {}
    response.setdefault("research_metadata", {})
    response["research_metadata"]["duration_ms"] = duration_ms
    response["research_metadata"]["agent_version"] = AGENT_VERSION
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=int(os.getenv("AGENT_PORT", "8008")), reload=False)
