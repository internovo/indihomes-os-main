"""Search tools — thin async HTTP clients calling the Node bridge
(agent-tools-bridge.cjs), which itself wraps the existing Google CSE / Bing
/ Apify / 99acres-MagicBricks / IndiHomes-official connectors. No search or
scraping logic lives here; this module's only job is: call the bridge, time
it, cache it, and turn its response into (List[EvidenceItem], ToolCallRecord).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

import httpx
from langsmith import traceable

from . import cache
from . import fact_extraction as _fact_extraction
from .state import EvidenceItem, FetchedPage, ToolCallRecord

logger = logging.getLogger("ai-search-agent.tools")

NODE_BASE_URL = os.getenv("AGENT_NODE_BASE_URL", "http://localhost:3001")
INTERNAL_TOKEN = os.getenv("AGENT_INTERNAL_TOKEN", "dev-local-agent-token")
# The WHOLE-REQUEST timeout (server.cjs's own POST /agent/ai-search timeout,
# sized for the entire deep-research pipeline) is a different concern from a
# SINGLE bridge call's timeout — reusing AI_SEARCH_TIMEOUT_MS for both meant
# raising one to fix the whole-pipeline latency silently made every
# individual tool call wait just as long before giving up on a dead bridge.
# AGENT_BRIDGE_TIMEOUT_MS is deliberately its own, much shorter, variable.
TIMEOUT_S = int(os.getenv("AGENT_BRIDGE_TIMEOUT_MS", "15000")) / 1000
CONNECT_TIMEOUT_S = int(os.getenv("AGENT_BRIDGE_CONNECT_TIMEOUT_MS", "3000")) / 1000
MAX_RETRIES = max(0, int(os.getenv("AGENT_BRIDGE_MAX_RETRIES", "2")))
BACKOFF_BASE_S = int(os.getenv("AGENT_BRIDGE_BACKOFF_BASE_MS", "400")) / 1000
# Once the bridge is confirmed unreachable, remember that for this long so
# every OTHER tool call in the same (and near-future) research request
# fails fast instead of each independently burning through its own
# retry+backoff budget against a dependency already known to be down
# (Part 3.2/3.3 — "never spin", "per-run unavailable-tool suppression").
# Short enough that a real, transient Node restart recovers on its own
# within one request-service's lifetime, not just on the next process boot.
BRIDGE_UNAVAILABLE_TTL_S = int(os.getenv("AGENT_BRIDGE_UNAVAILABLE_TTL_MS", "30000")) / 1000

_headers = {"X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json"}

# Per-process circuit-breaker state — NOT per-request, deliberately: a bridge
# outage discovered by the first tool call in a fan-out (tavily_search, say)
# should stop web_search/apify_search/portal_search/developer_search (all
# running concurrently in the SAME request) from each independently
# retrying the same dead dependency, not just stop retries on FUTURE
# requests.
_bridge_state = {"unavailable_until": 0.0, "last_error": None}


def bridge_marked_unavailable() -> Optional[str]:
    """Returns the last known error string if the bridge is currently
    marked unavailable (within BRIDGE_UNAVAILABLE_TTL_S), else None.
    """
    if _bridge_state["unavailable_until"] > time.monotonic():
        return _bridge_state["last_error"]
    return None


def _mark_bridge_unavailable(error: str) -> None:
    _bridge_state["unavailable_until"] = time.monotonic() + BRIDGE_UNAVAILABLE_TTL_S
    _bridge_state["last_error"] = error
    logger.warning("[bridge] marked unavailable for %ss: %s", BRIDGE_UNAVAILABLE_TTL_S, error)


def _mark_bridge_available() -> None:
    if _bridge_state["unavailable_until"]:
        logger.info("[bridge] recovered — clearing unavailable state")
    _bridge_state["unavailable_until"] = 0.0
    _bridge_state["last_error"] = None


async def check_bridge_available(*, force: bool = False) -> tuple[bool, Optional[str]]:
    """Preflight (Part 3.2) — a fast (short connect-timeout), cheap GET
    against the bridge's own /status route, used by graph.py's very first
    node so a dead bridge is discovered ONCE, fast, before fanning out 5
    tool calls that would each individually wait out their own timeout
    against the same unreachable dependency. `force=True` bypasses the
    remembered-unavailable short-circuit (used by the preflight node
    itself, which IS the thing that decides whether to remember it).
    """
    if not force:
        err = bridge_marked_unavailable()
        if err is not None:
            return False, err
    start = time.monotonic()
    try:
        timeout = httpx.Timeout(TIMEOUT_S, connect=CONNECT_TIMEOUT_S)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{NODE_BASE_URL}/internal/agent-tools/status", headers=_headers)
        if resp.status_code >= 400:
            err = f"HTTP {resp.status_code}"
            _mark_bridge_unavailable(err)
            return False, err
        _mark_bridge_available()
        return True, None
    except httpx.HTTPError as e:
        err = f"{type(e).__name__}: {e}"
        _mark_bridge_unavailable(err)
        return False, err
    finally:
        logger.info("[bridge] preflight took %dms", int((time.monotonic() - start) * 1000))


async def _call_bridge(
    path: str, payload: dict, *, cache_namespace: Optional[str] = None, cache_key: Optional[str] = None,
    ttl_s: Optional[float] = None, timeout_s: Optional[float] = None, max_retries: Optional[int] = None,
) -> tuple[dict, int, Optional[str], bool]:
    """Returns (response_json, duration_ms, error, cache_hit). Never raises —
    a tool failure must degrade the plan, not crash the graph (Part 28).

    `timeout_s`/`max_retries` let a specific SLOW-BUT-LEGITIMATE tool (see
    apify_search below) use its own budget instead of the shared default —
    added after a confirmed live failure mode: AGENT_BRIDGE_TIMEOUT_MS
    (15s default) is structurally shorter than Apify's own real
    run-sync-get-dataset-items latency (APIFY_TIMEOUT_MS, 60s default on
    the Node side) — meaning every apify_search call was GUARANTEED to
    ReadTimeout on the Python side even though the bridge/Apify were both
    working exactly as designed, just slow.

    Only a genuine CONNECTION-level failure (ConnectError/ConnectTimeout —
    the bridge process itself never answered the TCP handshake) trips the
    shared circuit breaker other tools check. A ReadTimeout — the bridge
    DID accept the connection, it just took longer than THIS caller's
    patience to respond — is deliberately NOT treated as "the bridge is
    down": confirmed live, apify_search's own ReadTimeouts were marking the
    ENTIRE bridge unavailable for BRIDGE_UNAVAILABLE_TTL_S, which then
    short-circuited ~10 unrelated, otherwise-healthy fetch_page/web_search/
    tavily_search calls in a single targeted-research pass with an instant
    "bridge_unavailable" error — wasting the verification budget on
    candidates that had nothing to do with Apify being slow. Retried only
    for connection-level failures, with backoff; once THOSE are exhausted
    the shared circuit trips. A ReadTimeout fails this ONE call and moves
    on, without punishing every other tool.
    """
    if cache_namespace and cache_key:
        hit = cache.get(cache_namespace, cache_key, ttl_s if ttl_s is not None else cache.SOURCE_TTL_S)
        if hit is not None:
            return hit, 0, None, True

    early_err = bridge_marked_unavailable()
    if early_err is not None:
        return {"evidence": [], "error": f"bridge_unavailable: {early_err}"}, 0, f"bridge_unavailable: {early_err}", False

    start = time.monotonic()
    effective_timeout_s = timeout_s if timeout_s is not None else TIMEOUT_S
    effective_max_retries = max_retries if max_retries is not None else MAX_RETRIES
    timeout = httpx.Timeout(effective_timeout_s, connect=CONNECT_TIMEOUT_S)
    last_connect_error: Optional[str] = None
    for attempt in range(effective_max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(f"{NODE_BASE_URL}{path}", json=payload, headers=_headers)
            duration_ms = int((time.monotonic() - start) * 1000)
            _mark_bridge_available()
            if resp.status_code >= 400:
                body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                err = body.get("error") or f"HTTP {resp.status_code}"
                return {"evidence": [], "error": err}, duration_ms, err, False
            data = resp.json()
            if cache_namespace and cache_key and data.get("evidence"):
                cache.set(cache_namespace, cache_key, data)
            return data, duration_ms, None, False
        except httpx.ReadTimeout as e:
            # The bridge IS reachable — it accepted the connection and was
            # actively working, just not fast enough for this call's own
            # budget. NEVER marks the shared bridge-down circuit (see this
            # function's docstring) and never retried with the SAME short
            # timeout (retrying wouldn't make Apify faster) — fails this
            # one call cleanly and lets other tools proceed unaffected.
            duration_ms = int((time.monotonic() - start) * 1000)
            err = f"{type(e).__name__}: {e}"
            return {"evidence": [], "error": err}, duration_ms, err, False
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            last_connect_error = f"{type(e).__name__}: {e}"
            if attempt < effective_max_retries:
                backoff = BACKOFF_BASE_S * (2 ** attempt)
                logger.warning("[bridge] %s attempt %d/%d failed (%s), retrying in %.1fs", path, attempt + 1, effective_max_retries + 1, last_connect_error, backoff)
                await asyncio.sleep(backoff)
                continue
        except httpx.HTTPError as e:
            # A non-connection HTTP-layer error (malformed response, etc.) —
            # not the "dependency is down" failure mode retries exist for.
            duration_ms = int((time.monotonic() - start) * 1000)
            return {"evidence": [], "error": str(e)}, duration_ms, str(e), False

    duration_ms = int((time.monotonic() - start) * 1000)
    _mark_bridge_unavailable(last_connect_error or "connection failed")
    err = f"bridge_unavailable: {last_connect_error}"
    return {"evidence": [], "error": err}, duration_ms, err, False


@traceable(name="tavily_search", run_type="tool")
async def tavily_search(query: str, market: str, depth: str = "basic") -> tuple[list[EvidenceItem], ToolCallRecord]:
    """AI-native web search (Part 29) — a distinct tool from web_search's
    Google/Bing, tried in parallel rather than only as its fallback.
    `depth='basic'` for first-pass discovery, `depth='advanced'` for
    per-candidate targeted research (see graph.py's targeted_research node)
    — deliberately not always 'advanced', to avoid burning API credits on
    every broad query per Part 32.
    """
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/tavily-search", {"query": query, "market": market, "depth": depth},
        cache_namespace=f"tavily-search-{depth}", cache_key=f"{market}:{query.lower()}",
    )
    evidence = data.get("evidence", [])
    return evidence, ToolCallRecord(tool="tavily_search", args={"query": query, "market": market, "depth": depth},
                                     status="error" if err and not evidence else "ok", count=len(evidence),
                                     duration_ms=duration_ms, error=err, cache_hit=cache_hit)


@traceable(name="web_search", run_type="tool")
async def web_search(query: str, market: str) -> tuple[list[EvidenceItem], ToolCallRecord]:
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/web-search", {"query": query, "market": market},
        cache_namespace="web-search", cache_key=f"{market}:{query.lower()}",
    )
    evidence = data.get("evidence", [])
    return evidence, ToolCallRecord(tool="web_search", args={"query": query, "market": market},
                                     status="error" if err and not evidence else "ok", count=len(evidence),
                                     duration_ms=duration_ms, error=err, cache_hit=cache_hit)


@traceable(name="developer_search", run_type="tool")
async def developer_search(query: str, market: str) -> tuple[list[EvidenceItem], ToolCallRecord]:
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/developer-search", {"query": query, "market": market},
        cache_namespace="developer-search", cache_key=f"{market}:{query.lower()}",
    )
    evidence = data.get("evidence", [])
    return evidence, ToolCallRecord(tool="developer_search", args={"query": query, "market": market},
                                     status="error" if err and not evidence else "ok", count=len(evidence),
                                     duration_ms=duration_ms, error=err, cache_hit=cache_hit)


@traceable(name="portal_search", run_type="tool")
async def portal_search(query: str, market: str, locations: list[str], configuration: Optional[str], budget_max: Optional[float]) -> tuple[list[EvidenceItem], ToolCallRecord]:
    payload = {"query": query, "market": market, "locations": locations, "configuration": configuration,
               "budgetMax": int(budget_max * 1e7) if budget_max else None}
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/portal-search", payload,
        cache_namespace="portal-search", cache_key=f"{market}:{','.join(sorted(locations))}:{configuration or ''}",
    )
    evidence = data.get("evidence", [])
    return evidence, ToolCallRecord(tool="portal_search", args=payload,
                                     status="error" if err and not evidence else "ok", count=len(evidence),
                                     duration_ms=duration_ms, error=err, cache_hit=cache_hit)


# ── places_search — Google Places (New)-based candidate discovery (Part 1
# of the Places-augmented pipeline). Runs ALONGSIDE the tools above, in the
# SAME discovery fan-out (see graph.py's node_discovery_search) — never a
# replacement for any of them.
#
# Real scope, disclosed here (and reflected honestly downstream — an empty
# result from this tool is never treated as "no projects exist"): Google
# Places indexes real, physically-existing, publicly-listed buildings —
# strongest for READY-TO-MOVE/completed inventory a developer has already
# registered with Google Business/Maps. A genuine pre-launch or early-
# construction project (marketed via Instagram/portal listings before the
# building physically exists, or before the developer has set up a Places
# listing for it) will often NOT appear here yet. This tool contributing
# candidate NAMES does not itself make them eligible — every Places-sourced
# candidate still goes through the SAME lifecycle/geography hard-eligibility
# gate as everything else; Places evidence carries no lifecycle language on
# its own (a bare address, not "under construction"/"new launch"), so a
# Places-only candidate with no other corroborating evidence correctly stays
# UNKNOWN and is rejected on the final pass exactly like today — this tool
# does NOT create a bypass for completed/ready-to-move buildings.
@traceable(name="places_search", run_type="tool")
async def places_search(query: str, market: str, locations: list[str], configuration: Optional[str]) -> tuple[list[EvidenceItem], ToolCallRecord]:
    payload = {"query": query, "market": market, "locations": locations, "configuration": configuration}
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/places-search", payload,
        cache_namespace="places-search", cache_key=f"{market}:{','.join(sorted(locations))}:{configuration or ''}",
    )
    evidence = data.get("evidence", [])
    return evidence, ToolCallRecord(tool="places_search", args=payload,
                                     status="error" if err and not evidence else "ok", count=len(evidence),
                                     duration_ms=duration_ms, error=err, cache_hit=cache_hit)


# ── places_verify — Part 2's per-candidate name-verification lookup, called
# from deep_research.py's research_candidates() loop once a candidate's name
# is finalized (post extract_project_name) — bounded by the SAME
# MAX_CANDIDATES_FOR_DEEP_RESEARCH budget that loop already has, not a new
# unbounded pass over every discovered candidate. Returns None (never a
# fabricated match) whenever Places simply doesn't have this building yet —
# an expected, common outcome for a genuine pre-launch project, not treated
# as evidence against it (see normalize.looks_like_invalid_name, the actual
# gate for a garbage-name extraction, only consulted when this returns None).
@traceable(name="places_verify", run_type="tool")
async def places_verify(name: str, locality: Optional[str], city: Optional[str]) -> tuple[Optional[dict], ToolCallRecord]:
    payload = {"name": name, "locality": locality, "city": city}
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/places-verify", payload,
        cache_namespace="places-verify", cache_key=f"{name.lower()}:{(locality or '').lower()}:{(city or '').lower()}",
    )
    found = bool(data.get("found"))
    return (data.get("place") if found else None), ToolCallRecord(
        tool="places_verify", args=payload, status="error" if err else "ok",
        count=1 if found else 0, duration_ms=duration_ms, error=err, cache_hit=cache_hit)


# apify-search's own real latency (Node's APIFY_TIMEOUT_MS, 60s default —
# a genuinely synchronous "run-sync-get-dataset-items" Apify API call, see
# external-connectors.cjs) is structurally longer than the shared
# AGENT_BRIDGE_TIMEOUT_MS (15s default) every other, much-faster tool uses.
# A dedicated, generous timeout (own env var, defaults to comfortably
# longer than Node's own 60s default) means a normal, legitimately-slow
# apify_search call is just slow, never a guaranteed failure. Zero retries
# — if it's still not back within this already-generous budget, retrying
# with the same budget won't make Apify faster, it'll just double the
# wait for no benefit; this tool is best-effort by design (see
# planner.py — apify_search only ever runs once, in the first discovery
# pass, never inside the per-candidate targeted-research loop).
APIFY_TIMEOUT_S = int(os.getenv("AGENT_BRIDGE_APIFY_TIMEOUT_MS", "70000")) / 1000


@traceable(name="apify_search", run_type="tool")
async def apify_search(query: str, market: str) -> tuple[list[EvidenceItem], ToolCallRecord]:
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/apify-search", {"query": query, "market": market},
        cache_namespace="apify-search", cache_key=f"{market}:{query.lower()}",
        timeout_s=APIFY_TIMEOUT_S, max_retries=0,
    )
    evidence = data.get("evidence", [])
    return evidence, ToolCallRecord(tool="apify_search", args={"query": query, "market": market},
                                     status="error" if err and not evidence else "ok", count=len(evidence),
                                     duration_ms=duration_ms, error=err, cache_hit=cache_hit)


# ── rera_lookup — targeted RERA enrichment for a project ALREADY selected
# in Project Intelligence (Property Search or AI Search), not a discovery
# tool. Built to close a real gap: the only pre-existing enrichment path
# (/api/ai-research, Claude-driven) is permanently dead in this deployment
# (no ANTHROPIC_API_KEY) and was never wired to auto-fire for a normally-
# selected project anyway (only for a manually-onboarded one). This reuses
# the SAME working tools/extraction every other part of this pipeline
# already depends on (web_search + fetch_page + fact_extraction's
# nearest_match-protected RERA regex) — no new scraper, no new LLM
# dependency, no parallel extraction path.


@traceable(name="rera_lookup", run_type="tool")
async def rera_lookup(name: str, locality: Optional[str], city: Optional[str]) -> tuple[Optional[str], ToolCallRecord]:
    """Returns (rera_number_or_None, ToolCallRecord). Never fabricates —
    only a RERA number literally extracted from real fetched page text,
    verified against `name` via fact_extraction's own nearest_match
    protection (the exact fix built this session for cross-candidate fact
    bleeding on a multi-project page), is ever returned. The source
    URL/page is deliberately not returned to the caller — this tool's
    only job is the number itself; server.cjs's route never forwards
    provider/URL details to the frontend either way (source/debug removal).
    """
    start = time.monotonic()
    query = f"{name} {locality or ''} RERA number registration".strip()
    evidence, _ = await web_search(query, "india")
    urls = [e.get("source_url") for e in evidence[:3] if e.get("source_url")]
    rera_found = None
    for url in urls:
        page, _ = await fetch_page(url, candidate=name, source_type="rera-lookup")
        if page.get("status") != "success" or not page.get("content"):
            continue
        facts, _ = _fact_extraction.deterministic_extract(name, page)
        for f in facts:
            if f["field"] == "rera_number" and f["value"]:
                rera_found = f["value"]
                break
        if rera_found:
            break
    duration_ms = int((time.monotonic() - start) * 1000)
    return rera_found, ToolCallRecord(
        tool="rera_lookup", args={"name": name, "locality": locality, "city": city},
        status="ok", count=1 if rera_found else 0, duration_ms=duration_ms, error=None, cache_hit=False,
    )


@traceable(name="official_lookup", run_type="tool")
async def official_lookup(name: str) -> tuple[Optional[dict], ToolCallRecord]:
    data, duration_ms, err, cache_hit = await _call_bridge("/internal/agent-tools/official-lookup", {"name": name})
    return data.get("project"), ToolCallRecord(tool="official_lookup", args={"name": name},
                                                status="error" if err else "ok", count=1 if data.get("found") else 0,
                                                duration_ms=duration_ms, error=err, cache_hit=cache_hit)


# ── fetch_page — the deep-research capability (Part 4). Calls the bridge's
# /fetch-page route (agent-tools-bridge.cjs), which does the actual HTTP/
# browser retrieval + text/JSON-LD extraction — this function's only job,
# same as every other tool here, is: call the bridge, cache it, shape it
# into FetchedPage + ToolCallRecord. File-cached at the SOURCE_TTL_S tier
# (Part 22) keyed by the normalized URL, so re-fetching the same page within
# one research session (first pass + any later targeted-research loop) is
# always a cache hit, never a second network request.
@traceable(name="fetch_page", run_type="tool")
async def fetch_page(url: str, *, candidate: Optional[str] = None, candidate_id: Optional[str] = None, source_type: str = "web") -> tuple[FetchedPage, ToolCallRecord]:
    data, duration_ms, err, cache_hit = await _call_bridge(
        "/internal/agent-tools/fetch-page", {"url": url},
        cache_namespace="fetch-page", cache_key=url, ttl_s=cache.SOURCE_TTL_S,
    )
    page = FetchedPage(
        url=data.get("url", url), candidate=candidate,
        title=data.get("title"), content=data.get("content"),
        metadata=data.get("metadata") or {}, structured_data=data.get("structured_data") or [],
        retrieved_at=data.get("retrieved_at") or "", status=data.get("status", "error" if err else "success"),
        error=data.get("error") or err, source_type=source_type,
        retrieved_via=(data.get("metadata") or {}).get("retrievedVia"),
    )
    ok = page["status"] == "success"
    # candidate_id in `args` (Part P1.19) — auto-captured by @traceable as
    # this call's trace input, so a LangSmith trace can answer "which
    # candidate ID was this fetch for" without cross-referencing anything
    # else. Not a ToolCallRecord field (that struct is shared with every
    # other tool, most of which have no single candidate) — kept local to
    # this call's own trace/args instead of widening the shared schema.
    return page, ToolCallRecord(tool="fetch_page", args={"url": url, "candidate": candidate, "candidate_id": candidate_id},
                                 status="ok" if ok else "error", count=1 if ok else 0,
                                 duration_ms=duration_ms, error=page.get("error"), cache_hit=cache_hit)
