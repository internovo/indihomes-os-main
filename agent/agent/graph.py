"""The actual LangGraph StateGraph — the evolved "discover -> inspect ->
fetch -> extract -> verify -> identify gaps -> search again -> verify ->
rank -> curate" pipeline (this task's core architectural change), built
with real conditional routing and a bounded research-gap loop, not a
single monolithic prompt.

    START
      -> query_understanding -> location_resolution -> research_planner
      -> {tavily_search, web_search, serper_search, apify_search, portal_search, developer_search, places_search}  (fan-out, DISCOVERY)
      -> evidence_normalizer -> deduplicator -> candidate_verifier
      -> candidate_scorer -> deep_research (DEEP PAGE RESEARCH, fetch_page + fact extraction)
      -> research_gap_checker (per-candidate, per-field: missing/weak/conflicting)
           - needs_more_research -> targeted_research (field-aware search + fetch + extract)
                                       -> candidate_verifier (loop back)
           - sufficient -> final_scoring -> display_enrichment (Phase 2.5a — top-MAX_SELECTED only, gap-aware, wall-clock-bounded)
                                              -> location_enrichment (Places: score/connectivity/landmarks, deterministic)
                                              -> curator -> structured_output -> END

`deep_research` and `research_gap_checker` are the two genuinely new nodes
this pass adds (Part 4/11); `candidate_verifier` was extended (not
replaced) to also produce structured `verification_results` alongside its
existing plain-text warnings (Part 16). `final_scoring` re-runs the SAME
deterministic scorer used earlier in the graph, now over deep-research-
enriched evidence — a thin re-invocation, not a second scoring system.

tavily_search is the primary AI-native web research tool (Part 29) —
always attempted (like web_search/apify_search) at 'basic' depth on the
DISCOVERY pass; targeted_research additionally fires it at 'advanced'
depth per gap-flagged candidate during the field-aware second-stage loop.

Each of the five search nodes is a no-op (returns {}) when its tool wasn't
included in `search_plan` — this keeps the graph's edge structure static
(the diagram's actual shape) while still skipping tools the planner decided
weren't worth calling, per Part 4/7 of the original brief.

Every node here is auto-traced by LangSmith as its own run whenever
LANGSMITH_TRACING=true (LangGraph's compiled graph is a LangChain Runnable;
no extra code is needed for node-level tracing) — see tools.py/fact_
extraction.py/deep_research.py for the @traceable-decorated functions
CALLED from inside these nodes, which is where finer-grained spans
(one per actual tool/fetch/LLM call) come from.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone

from langgraph.graph import END, START, StateGraph

from . import dedupe as dedupe_mod
from . import deep_research as deep_research_mod
from . import gap_checker as gap_checker_mod
from . import llm_providers
from . import normalize as normalize_mod
from . import planner as planner_mod
from . import tools as tools_mod
from .curator import curate, MAX_SELECTED
from .query_understanding import parse_query, resolve_all_locations
from .scoring import score_all
from .state import ResearchState

logger = logging.getLogger("ai-search-agent.graph")

# ── Bounded-loop / cost-control knobs (Part 45) — every one env-
# configurable, sensible defaults, all recorded into research_metadata by
# the curator so a LangSmith trace / API response shows exactly what
# budget this request ran under.
MAX_RESEARCH_ITERATIONS = int(os.getenv("AI_SEARCH_MAX_RESEARCH_ITERATIONS", "2"))
TARGETED_RESEARCH_TOP_N = int(os.getenv("AI_SEARCH_TARGETED_RESEARCH_TOP_N", "3"))
MIN_STRONG_RESULTS = int(os.getenv("AI_SEARCH_MIN_STRONG_RESULTS", "2"))  # if we already have this many PRIMARY/SECONDARY hits AND no real gaps, don't bother looping
# Phase 2.5a — the eligibility-research loop above spends its budget on
# whichever candidates are UNDETERMINED (_prioritize_for_deep_research),
# which is frequently NOT the same set that ends up in the top-MAX_SELECTED
# actually returned (Phase 2's own live-measured finding: 4/79 deduplicated
# candidates had real carpet data, 0/8 displayed did). This is a SEPARATE
# wall-clock budget, deliberately its own env var rather than reusing
# AI_SEARCH_TIMEOUT_MS — this step runs once, after eligibility is already
# decided, and must never itself be the reason a request times out into
# Places-direct; a hard cap here, not a soft one, on purpose.
DISPLAY_ENRICHMENT_BUDGET_S = int(os.getenv("AI_SEARCH_DISPLAY_ENRICHMENT_BUDGET_MS", "90000")) / 1000

# The whole run's wall clock. Deliberately below the Node side's
# AI_SEARCH_TIMEOUT_MS (180000) with margin to spare: a result the caller
# never receives is worth nothing, and overrunning that timeout drops the
# user onto the shallower Places-direct pipeline, throwing away everything
# this pipeline just did.
TOTAL_BUDGET_S = float(os.getenv("AI_SEARCH_TOTAL_BUDGET_MS", "150000")) / 1000
# targeted_research was the last unbounded node. Live "1bhk in Marol": it ran
# TWICE between the deep_research passes, each time firing 5 web + 5 tavily
# searches plus page fetches with no ceiling — so by the third deep_research
# pass the run clock was already spent ("budget 0s") and both enrichment nodes
# were clamped to nothing. Every other bounded node had a budget; this one
# quietly consumed whatever was left.
TARGETED_RESEARCH_BUDGET_S = float(os.getenv("AI_SEARCH_TARGETED_RESEARCH_BUDGET_MS", "40000")) / 1000

# Bounding each node individually is not enough: the ELIGIBILITY LOOP
# (deep_research → targeted_research → deep_research …) always has one more
# gap to chase, so it will spend every second the clock allows and leave the
# tail with nothing. The tail — display_enrichment and location_enrichment —
# is what fills the EIGHT CARDS THE USER ACTUALLY SEES (price, carpet, RERA,
# location score). Live "1bhk in Marol": the loop ran to the end of the run,
# display_enrichment logged "timed out after 90s" having in fact waited ~0s,
# location_enrichment got 0s, and every card rendered "Price not available"
# even though earlier passes had already found prices. This many seconds are
# fenced off from the loop and cannot be spent by it.
#
# 45s = location_enrichment's full 20s + a ~25s display slice. Sized to be
# the SMALLER share of the run on purpose: the loop is what finds candidates
# at all, and starving discovery to polish cards that then have nothing on
# them is the opposite failure. Enough for the tail to do real work, not
# enough to squeeze research.
TAIL_RESERVE_S = float(os.getenv("AI_SEARCH_TAIL_RESERVE_MS", "45000")) / 1000
# Left for curation, scoring and serialising the response after the tail.
CURATION_MARGIN_S = 15.0


def _remaining_budget(state: "ResearchState") -> float:
    """Seconds left in the whole run. Large-but-finite when no deadline was
    set (a node invoked directly in a test), never unbounded.

    time.monotonic(), NOT asyncio.get_event_loop().time(). Live crash this
    fixes: LangGraph runs a conditional-edge router (route_research_gap) in a
    worker thread via run_in_executor, and that thread has no event loop, so
    get_event_loop() raises "There is no current event loop in thread
    'asyncio_0'" and the whole request 500s. time.monotonic() is the same
    clock the default loop uses, needs no loop, and is safe from any thread —
    which is why the deadline is SET with it too, so both ends agree.
    """
    deadline = state.get("deadline_at")
    if not deadline:
        return TOTAL_BUDGET_S
    return max(0.0, deadline - time.monotonic())


def _budget_for(state: "ResearchState", node_budget_s: float, reserve_s: float = 0.0) -> float:
    """A node's own budget, clamped to what the run actually has left, minus
    any slice reserved for nodes that still have to run AFTER this one.

    Without the reserve, a node that is merely well-behaved about its own
    clamp still starves everything downstream: display_enrichment taking the
    whole remaining clock left location_enrichment with 0s in every live run.
    """
    return max(0.0, min(node_budget_s, _remaining_budget(state) - reserve_s))


# ── Bridge preflight (Part 3.2) ─────────────────────────────────────────────
# Every discovery/deep-research tool depends on the SAME Node bridge
# (agent-tools-bridge.cjs) — if it's unreachable, fanning out 5 parallel
# search calls just means 5 independent timeouts before the same conclusion
# is reached 5 times over. This node checks ONCE, fast (a short connect-
# timeout GET against /internal/agent-tools/status), before any of that
# fan-out — every downstream node reads `bridge_unavailable` off state and
# no-ops immediately instead of attempting (and individually retrying) a
# call already known to be doomed.
async def node_bridge_preflight(state: ResearchState) -> dict:
    # Reset the per-process LLM call-budget counters (Part P0.8) HERE —
    # this is the very first node of every top-level request, so
    # research_metadata.llm_calls/llm_failures/llm_fallbacks always reflect
    # THIS run only, never the FastAPI process's whole lifetime. Provider
    # circuit-breaker state (llm_providers._provider_state) is intentionally
    # NOT reset here — that needs to persist ACROSS requests within its TTL,
    # or a permanently-broken model would just get re-discovered broken on
    # every single new search.
    llm_providers.reset_llm_metrics()
    # One clock for the whole run, started here — the first node of every
    # request. Set on BOTH exits so the bridge-down path is bounded too.
    deadline_at = time.monotonic() + TOTAL_BUDGET_S
    logger.warning("[bridge-preflight] run budget %.0fs", TOTAL_BUDGET_S)
    available, error = await tools_mod.check_bridge_available(force=True)
    if not available:
        logger.error("[bridge-preflight] bridge unavailable: %s", error)
        return {
            "deadline_at": deadline_at,
            "bridge_unavailable": True,
            "errors": [f"Node tool bridge unavailable ({tools_mod.NODE_BASE_URL}): {error}"],
            "tool_calls": [{"tool": "bridge_preflight", "status": "error", "count": 0, "duration_ms": 0, "error": error}],
        }
    return {"deadline_at": deadline_at, "bridge_unavailable": False,
            "tool_calls": [{"tool": "bridge_preflight", "status": "ok", "count": 1, "duration_ms": 0, "error": None}]}


def _bridge_skip_record(tool: str) -> dict:
    return {"tool_calls": [{"tool": tool, "status": "skipped", "count": 0, "duration_ms": 0, "error": "bridge_unavailable"}]}


# ── Understanding / planning ────────────────────────────────────────────────

async def node_query_understanding(state: ResearchState) -> dict:
    text = state["original_query"]
    market = state.get("market", "india")
    parsed = parse_query(text, market)
    return {
        "normalized_query": text.strip().lower(),
        "parsed_requirements": parsed,
        "locations": parsed.get("locations", []),
        "configurations": parsed.get("configurations", []),
        "budget": {"max_cr": parsed.get("budget_max_cr")},
        "possession": {"text": parsed.get("possession_text"), "year_max": parsed.get("possession_year_max")},
        "amenities": parsed.get("amenities", []),
        "timestamps": {"query_understanding": datetime.now(timezone.utc).isoformat()},
    }


async def node_location_resolution(state: ResearchState) -> dict:
    resolved = resolve_all_locations(state.get("locations", []))
    # A locality the shared gazetteer doesn't know resolves to itself with no
    # parent and no city, which silently makes the geography gate below far
    # stricter: _location_terms() then has exactly ONE term to match on, so a
    # real project that describes itself by its parent suburb ("Kandivali
    # West") instead of the micro-locality the user typed is rejected as
    # wrong-geography.
    #
    # Confirmed live: "2 BHK in Chikuwadi" found 64 candidates, several of
    # them real under-construction projects, and returned zero — Chikuwadi is
    # absent from shared/mmr-gazetteer.json, while the otherwise identical
    # "Kandarpada" query works because that alias IS present (parent Borivali
    # West, city Mumbai). Surfaced as a warning rather than silently widened:
    # guessing a parent suburb is exactly how a Las Vegas listing once
    # reached a Mumbai search (see _location_terms' own comment).
    unresolved = [r["query_term"] for r in resolved if not r.get("city") and not r.get("parent")]
    warnings: list[str] = []
    # A locality that was spelling-corrected is told to the user in their own
    # terms, ALWAYS. Live: "1bhk in Sampta Nagar" found 64 real candidates and
    # returned zero, because the gazetteer holds "Samata Nagar" (Kandivali
    # East) and the typed spelling was one letter off. Correcting it silently
    # would be worse than the zero — the user must be able to see we searched
    # something other than what they typed, and say we got it wrong.
    corrected = [r for r in resolved if r.get("corrected_from")]
    for r in corrected:
        logger.warning("[location_resolution] corrected %r -> %r", r["corrected_from"], r["canonical"])
        where = f" ({r['parent']})" if r.get("parent") else (f" ({r['city']})" if r.get("city") else "")
        warnings.append(
            f"Showing results for {r['canonical']}{where}. "
            f"“{r['corrected_from']}” is not a locality we recognise — "
            f"search again with a different spelling if that is not what you meant."
        )
    if unresolved:
        logger.warning("[location_resolution] not in the shared gazetteer: %s — geography gate will be strict", unresolved)
        # User-facing wording only: the old text told a home buyer to edit a
        # JSON file in the repo.
        warnings.append(
            f"We don't recognise “{', '.join(unresolved)}” as a locality, so results were matched "
            f"on that exact name only. Try the parent suburb, or a different spelling."
        )
    return {"micro_locations": resolved, "warnings": warnings}


async def node_research_planner(state: ResearchState) -> dict:
    parsed = state.get("parsed_requirements", {})
    market = state.get("market", "india")
    plan = planner_mod.build_search_plan(parsed, market)
    research_plan = planner_mod.build_research_plan(parsed, market)
    logger.info("[planner] plan=%s for query=%r", plan, state.get("original_query"))
    return {"search_plan": plan, "research_plan": research_plan}


# ── Parallel search fan-out (DISCOVERY) ─────────────────────────────────────

def _search_query_text(state: ResearchState) -> str:
    # Prefer the original free-text query — it carries nuance (e.g. "with
    # deck") the structured filters alone would lose for a web-search tool.
    return state["original_query"]


async def node_tavily_search(state: ResearchState) -> dict:
    if "tavily_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("tavily_search")
    evidence, record = await tools_mod.tavily_search(
        _search_query_text(state), state.get("market", "india"), depth="basic",
        langsmith_extra={"metadata": {"stage": "discovery", "market": state.get("market", "india")}, "tags": ["discovery"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


async def node_web_search(state: ResearchState) -> dict:
    if "web_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("web_search")
    evidence, record = await tools_mod.web_search(
        _search_query_text(state), state.get("market", "india"),
        langsmith_extra={"metadata": {"stage": "discovery", "market": state.get("market", "india")}, "tags": ["discovery"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


async def node_serper_search(state: ResearchState) -> dict:
    if "serper_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("serper_search")
    evidence, record = await tools_mod.serper_search(
        _search_query_text(state), state.get("market", "india"),
        langsmith_extra={"metadata": {"stage": "discovery", "market": state.get("market", "india")}, "tags": ["discovery"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


def _lifecycle_variant_query_text(state: ResearchState) -> str:
    """Follow-up spec Part 9 — a query REWRITE, not a project-name guess:
    the same user query plus lifecycle-status language, so this search
    surfaces individual project/builder pages that mention their
    construction status explicitly (which the plain query alone tends to
    miss in favor of generic portal browse pages for that phrasing).
    """
    return f"{state['original_query']} under construction OR new launch OR near possession"


async def node_lifecycle_variant_search(state: ResearchState) -> dict:
    if "lifecycle_variant_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("lifecycle_variant_search")
    evidence, record = await tools_mod.tavily_search(
        _lifecycle_variant_query_text(state), state.get("market", "india"), depth="basic",
        langsmith_extra={"metadata": {"stage": "discovery", "variant": "lifecycle", "market": state.get("market", "india")}, "tags": ["discovery", "lifecycle-variant"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


async def node_apify_search(state: ResearchState) -> dict:
    if "apify_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("apify_search")
    evidence, record = await tools_mod.apify_search(
        _search_query_text(state), state.get("market", "india"),
        langsmith_extra={"metadata": {"stage": "discovery", "market": state.get("market", "india")}, "tags": ["discovery"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


async def node_portal_search(state: ResearchState) -> dict:
    if "portal_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("portal_search")
    parsed = state.get("parsed_requirements", {})
    evidence, record = await tools_mod.portal_search(
        _search_query_text(state), state.get("market", "india"),
        state.get("locations", []),
        (parsed.get("configurations") or [None])[0],
        parsed.get("budget_max_cr"),
        langsmith_extra={"metadata": {"stage": "discovery", "market": state.get("market", "india")}, "tags": ["discovery"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


async def node_developer_search(state: ResearchState) -> dict:
    if "developer_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("developer_search")
    evidence, record = await tools_mod.developer_search(
        _search_query_text(state), state.get("market", "india"),
        langsmith_extra={"metadata": {"stage": "discovery", "market": state.get("market", "india")}, "tags": ["discovery"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


async def node_places_search(state: ResearchState) -> dict:
    if "places_search" not in state.get("search_plan", []):
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("places_search")
    parsed = state.get("parsed_requirements", {})
    evidence, record = await tools_mod.places_search(
        _search_query_text(state), state.get("market", "india"),
        state.get("locations", []),
        (parsed.get("configurations") or [None])[0],
        langsmith_extra={"metadata": {"stage": "discovery", "market": state.get("market", "india")}, "tags": ["discovery"]},
    )
    return {"raw_evidence": evidence, "tool_calls": [record]}


# ── Candidate identification (normalize -> dedupe) ──────────────────────────

async def node_evidence_normalizer(state: ResearchState) -> dict:
    normalized = normalize_mod.normalize_all(state.get("raw_evidence", []))
    return {"normalized_properties": normalized}


async def node_deduplicator(state: ResearchState) -> dict:
    deduped = dedupe_mod.dedupe(state.get("normalized_properties", []))
    return {"deduplicated_properties": deduped}


async def node_candidate_verifier(state: ResearchState) -> dict:
    """Cross-source verification (Part 16) — flags (never silently
    resolves) per-field conflicts across sources, both as the original
    plain-text warnings AND as structured VerificationResults the API can
    expose as data (`field: conflicting values`), not just prose.
    """
    warnings: list[str] = []
    verification_results: list[dict] = []
    for prop in state.get("deduplicated_properties", []):
        conflicts: dict[str, list[str]] = {}
        corroborated: list[str] = []
        for field, entries in (prop.get("field_evidence") or {}).items():
            values = {str(e["value"]) for e in entries}
            if len(values) > 1:
                warnings.append(f"{prop.get('name')}: sources disagree on {field} ({', '.join(sorted(values))})")
                conflicts[field] = sorted(values)
            elif len(entries) >= 2:
                corroborated.append(field)
        if conflicts or corroborated:
            verification_results.append({"candidate": prop.get("name", ""), "conflicts": conflicts, "corroborated_fields": corroborated})
    return {"warnings": warnings, "verification_results": verification_results}


# Hard eligibility gate (Part 2/3) — the single choke point both scoring
# nodes (initial + final, post-deep-research) run through. Two independent
# deterministic disqualifiers: is_aggregator (this isn't an individual
# project/listing page at all — Part P0.3's existing classifier) and
# lifecycle_status (it IS an individual listing, but it's resale/rental/
# unknown-lifecycle — normalize.py's classify_lifecycle_status). Either one
# is a hard REJECT, never a score cap, never a lower tier.
#
# RESALE/RENTAL are ALWAYS rejected immediately, at either pass — that's a
# confident, decisive signal straight from the snippet text; more research
# on a resale listing doesn't make it stop being resale. UNKNOWN and
# READY_TO_MOVE are DEFERRED (kept, not rejected) on the FIRST pass
# (final=False, before deep_research) — a thin search-snippet not
# mentioning possession/construction status is a limitation of THAT
# SNIPPET, not proof the underlying project is ineligible, and deep_research
# is specifically what fetches the real, full page next and (via
# reclassify_lifecycle_from_enriched_evidence below) gets a genuine second
# chance at classifying it correctly. Only on the SECOND pass (final=True,
# after deep_research has had that chance) does UNKNOWN/READY_TO_MOVE
# finally get rejected — by then the pipeline did everything it could to
# resolve it, and "still unknown" is real information, not undercooked.
# Every rejection is recorded with its reason (never silently dropped) so
# the dev-only debug trace (Part 27, curator.py gates this on AI_SEARCH_
# DEBUG_TRACE before it ever reaches the API response) can show exactly why.
def _location_terms(state: ResearchState) -> list[str]:
    """Part 1 — the raw location phrases the query actually named, PLUS
    each one's resolved city (e.g. "Liberty Garden" -> city "Mumbai"),
    deduped. Used as the geography-relevance gate below: a candidate
    genuinely about the searched area must mention at least ONE of these
    as a real phrase somewhere in its own text. Deliberately whole-phrase
    terms, not split into individual words — "Liberty Garden" as a query
    term must NOT be satisfied by a candidate that merely contains the
    single word "Liberty" (confirmed live: a Las Vegas, NV home-builder
    listing named "Liberty at Mayfield" matched on that word alone and
    reached final results for a Mumbai search before this gate existed).
    """
    terms = list(state.get("locations", []) or [])
    for loc in state.get("micro_locations", []) or []:
        if loc.get("city"):
            terms.append(loc["city"])
        if loc.get("parent"):
            terms.append(loc["parent"])
    return list(dict.fromkeys(t for t in terms if t and len(t) >= 3))


def _specific_location_terms(state: ResearchState) -> list[str]:
    """The terms that actually pin down WHERE the user asked about: the
    locality phrases they typed, plus each one's parent suburb. Deliberately
    NOT the resolved city.

    Live bug: "2 BHK in Chikuwadi" returned a Nerul, NAVI MUMBAI project as its
    top result. Chikuwadi resolves to city "Mumbai", "Navi Mumbai" contains the
    substring "mumbai", and the gate passed on that alone — so a whole
    different city satisfied a micro-locality query. A city is the right
    fallback ONLY when the city is what was asked for.
    """
    terms = list(state.get("locations", []) or [])
    for loc in state.get("micro_locations", []) or []:
        if loc.get("parent"):
            terms.append(loc["parent"])
        # An ambiguous locality's OTHER real locations count too. "Samata
        # Nagar" exists in Kandivali East and in Thane; the gazetteer names
        # one as primary, and without this every candidate from the other one
        # is thrown away as wrong-location. Live: a "2bhk in Samata Nagar"
        # search surfaced TenX Habitat, Dosti Vihar and Tarangan — all real
        # Thane West projects — and rejected all of them.
        for alt in loc.get("alternatives") or []:
            if alt.get("parent"):
                terms.append(alt["parent"])
            if alt.get("canonical"):
                terms.append(alt["canonical"])
    return list(dict.fromkeys(t for t in terms if t and len(t) >= 3))


def _matches_searched_location(prop: dict, location_terms: list[str], specific_terms: list[str] | None = None) -> bool:
    if not location_terms:
        return True  # nothing to check against — query had no resolvable location
    text = " ".join(str(prop.get(k) or "") for k in ("name", "location", "micro_location", "city", "description")).lower()
    # A specific term (the locality asked for, or its parent suburb) is what
    # counts. Matching the city alone is not geographic relevance when the
    # query named something smaller than a city — see _specific_location_terms.
    if specific_terms:
        return any(term.lower() in text for term in specific_terms)
    return any(term.lower() in text for term in location_terms)


def _apply_hard_eligibility_filter(scored: list, final: bool = False, location_terms: list[str] | None = None, state: "ResearchState | None" = None, specific_terms: list[str] | None = None) -> tuple[list, list]:
    accepted, rejected = [], []
    for p in scored:
        if p.get("is_aggregator"):
            rejected.append({"name": p.get("name") or p.get("id"), "reason": "Reads like a portal category/search-results page, not an individual project listing"})
            continue
        # Follow-up spec — a confirmed live false positive: a search
        # connector returned a candidate sourced from an unrelated domain
        # (a German butcher shop's site) that got indexed with keyword-
        # stuffed text mentioning the searched locality/possession year,
        # but whose actual content is shopping/e-commerce spam ("Pay in 4
        # interest-free payments... free shipping"), not a real-estate
        # listing. Checked unconditionally on both passes (same as resale/
        # rental below) — this is a confident, high-precision signal, not
        # something more research would resolve differently.
        unrelated_evidence = normalize_mod.looks_like_unrelated_commerce(f"{p.get('name') or ''} {p.get('description') or ''}")
        if unrelated_evidence:
            rejected.append({"name": p.get("name") or p.get("id"), "reason": "Reads like unrelated shopping/e-commerce content, not a real-estate listing", "evidence": unrelated_evidence})
            continue
        status = p.get("lifecycle_status") or "UNKNOWN"
        if status in ("RESALE", "RENTAL"):
            reason = "Resale listing — not new-project inventory" if status == "RESALE" else "Rental listing — not for sale"
            rejected.append({"name": p.get("name") or p.get("id"), "reason": reason, "evidence": p.get("lifecycle_evidence_text")})
            continue
        if status not in normalize_mod.ALLOWED_LIFECYCLE_STATUSES:
            if not final:
                # Deferred, not accepted-as-eligible — deep_research gets a
                # real shot at this candidate next; node_final_scoring will
                # make the actual accept/reject call once that's happened.
                accepted.append(p)
                continue
            # Final pass, still outside the allowed set (READY_TO_MOVE, or
            # UNKNOWN even after deep research had every chance to resolve
            # it) — rejected outright, no exceptions. This used to have two
            # escape hatches here: a Places-verified acceptance ("a real,
            # existing building shouldn't be discarded just because Places
            # doesn't track construction status") and a broader "any
            # UNKNOWN + valid-looking name" acceptance — both accepted the
            # candidate anyway with a score capped to TERTIARY and an
            # honest "status not confirmed" label, rather than rejecting.
            # Removed per explicit policy: this search must strictly show
            # only new-launch/pre-launch/under-construction/near-possession
            # inventory. A real building whose construction status simply
            # never resolved — however confidently Places verified its
            # existence, however plausible its name looks — is not
            # confirmed new-project inventory, so it is not shown, full
            # stop. No capped/labeled middle ground.
            reason = (
                "Ready-to-move / completed inventory — outside the active new-project search policy" if status == "READY_TO_MOVE"
                else "Launch/construction status could not be confirmed as new-project inventory even after deep research"
            )
            rejected.append({"name": p.get("name") or p.get("id"), "reason": reason, "evidence": p.get("lifecycle_evidence_text")})
            continue
        # Part 2 — even a candidate with an eligible lifecycle status must be
        # an IDENTIFIABLE project, not just a page that happens to survive
        # is_aggregator (computed once, from the ORIGINAL search-snippet
        # title, at normalize time). fact_extraction.extract_project_name +
        # dedupe.merge_extracted_facts already upgrade `name` to a real
        # extracted project name whenever deep research finds one and the
        # original was generic; if that never happened (extraction found
        # nothing better, or this candidate was outside the deep-research
        # budget) and the CURRENT name still reads as a category-page title
        # on the FINAL pass (enrichment already had its chance), reject —
        # never display a locality-landing-page title as if it were a
        # project name.
        if final and normalize_mod.is_aggregator_title({"title": p.get("name") or "", "description": ""}):
            rejected.append({"name": p.get("name") or p.get("id"), "reason": "No identifiable project name could be established, even after deep research"})
            continue
        # Part 2 of the Places-augmented pipeline — a candidate whose NAME
        # itself reads as invalid (portal UI chrome, an interstitial/error
        # page's own title, or — live-caught — a bare source-platform name
        # like "Instagram" leaking through from generic embed metadata) is
        # rejected on the FINAL pass regardless of whether Places
        # verification ever ran for it.
        #
        # PREVIOUSLY this also required `p.get("places_verified") is False`
        # (an ATTEMPTED-AND-FAILED Places lookup) before this check could
        # fire at all — intended to protect a real project that Places
        # simply doesn't have listed. But `places_verify()` in
        # deep_research.py only ever runs for candidates that made the
        # bounded top-N deep-research budget cut; a candidate that scored
        # too low to make that cut (live-caught: an "Instagram" candidate
        # at 8% match, well outside the top 5) never gets verified at all
        # — `places_verified` stays None forever — so the OLD `is False`
        # requirement silently exempted exactly the lowest-quality, most-
        # likely-garbage candidates from ever being name-checked. A name
        # that independently matches looks_like_invalid_name()'s pattern
        # family (UI chrome / interstitial phrasing / a bare social-
        # platform name) is disqualifying on its own — that heuristic
        # doesn't depend on Places at all to be a strong signal by itself;
        # Places-verification-failure was never the thing making it valid,
        # it was only ever an extra corroborating signal for names that are
        # NOT already independently invalid-shaped.
        if final and normalize_mod.looks_like_invalid_name(p.get("name") or ""):
            rejected.append({"name": p.get("name") or p.get("id"), "reason": "Could not verify this is a real project name"})
            continue
        # Part 1 — geography-relevance gate. Applied on both passes. On the
        # first pass (final=False) we defer rejection for candidates where
        # geography cannot yet be determined (UNKNOWN), preserving them for deep
        # research. Only reject CONFIRMED WRONG LOCATION before expensive research.
        # On the final pass, enforce strictly using enriched text from deep research.
        if location_terms:
            matched = _matches_searched_location(p, location_terms, specific_terms)

            if matched:
                # Candidate mentions at least one searched location term — accept
                # on both passes; deep research will verify the finer geography.
                accepted.append(p)
                continue

            # No searched location term matched in this candidate's text.
            # Check if the candidate's own city field indicates a different city
            # from the query's resolved cities — this is a CONFIRMED WRONG LOCATION.
            prop_city = (p.get("city") or "").lower()
            query_resolved_cities = {t.get("city", "").lower() for t in ((state.get("micro_locations") if state else None) or []) if t.get("city")}

            if prop_city and prop_city not in query_resolved_cities:
                # Candidate's city is not among the query's resolved cities →
                # CONFIRMED WRONG LOCATION — reject before expensive deep research
                rejected.append({
                    "name": p.get("name") or p.get("id"),
                    "reason": "Does not appear to be located in the searched area — candidate is about a different locality/city",
                    "evidence": p.get("lifecycle_evidence_text"),
                })
                continue

            # Location is ambiguous/unknown from current evidence.
            # On the first pass (before deep research), defer — preserve for research.
            if not final:
                accepted.append(p)
                continue

            # Final pass with no location match — reject (deep research should have
            # resolved the geography by now).
            rejected.append({"name": p.get("name") or p.get("id"), "reason": "Does not appear to be located in the searched area — no match to the searched locality/city found in this candidate's own text"})
            continue
        accepted.append(p)
    return accepted, rejected


async def node_candidate_scorer(state: ResearchState) -> dict:
    scored = score_all(state.get("deduplicated_properties", []), state.get("parsed_requirements", {}))
    # Aggregator/category pages ("BHK Flats in X", "Daulat Nagar, Borivali
    # East, Mumbai") are excluded outright here, not just capped to TERTIARY
    # — a real production search showed 5 aggregator-page results, zero
    # real listings, all shown to the user, back when this only capped the
    # score. A real listing whose title happens to trip is_aggregator_
    # title() is an acceptable rare false-positive versus routinely
    # presenting non-listings as search results.
    # location_terms + state passed here (not just on the final pass) so the
    # Part 1 geography gate's own "applied on both passes" defer-then-enforce
    # design actually runs on the first pass too — a CONFIRMED wrong-city
    # candidate is rejected before wasting deep-research budget on it, same
    # efficiency argument as the lifecycle-status two-pass gate right above
    # it; an AMBIGUOUS-location candidate is deferred, never rejected here.
    ranked, rejected = _apply_hard_eligibility_filter(scored, location_terms=_location_terms(state), state=state,
                                                     specific_terms=_specific_location_terms(state))
    return {"ranked_properties": ranked, "debug_rejected_candidates": rejected}


# ── Deep page research (Part 4/6/8-16) ──────────────────────────────────────

# Verification-priority ordering for the FIXED deep-research budget
# (Part 4/19 of the follow-up spec, extended by the "pre-deep-research
# candidate ranking" pass) — deep_research always spends its budget on
# candidates[:max_candidates] IN WHATEVER ORDER IT'S GIVEN, so that order is
# the actual lever controlling which candidates get a real chance to
# resolve their eligibility. node_targeted_research's own TARGETED_RESEARCH_
# TOP_N-bounded budget uses this SAME function (see node_targeted_research
# below) — one priority function feeds both budgets, not two independently
# invented ones.
#
# Two-level sort:
#   1. COARSE group — candidates whose eligibility is still UNDETERMINED
#      (lifecycle status outside ALLOWED_LIFECYCLE_STATUSES) go first. This
#      is the dominant signal: spending the research budget there can
#      change an accept/reject decision, while spending it on an
#      already-eligible candidate mostly just enriches display fields.
#      Confirmed as the real mechanism behind a live false-negative (a
#      genuine "Dem Icon Charkop" under-construction project reached zero
#      results in one run because it didn't make an unprioritized top-3
#      cut, then correctly resolved once given the chance) — this grouping
#      is NOT renegotiated by the finer-grained score below; it stays the
#      primary key so that fix can't regress.
#   2. WITHIN each group — a real multi-factor priority score (not just
#      score_all()'s pass-through relevance order), combining:
#        - identity quality (inverse of looks_like_invalid_name() risk — a
#          garbage-looking name shouldn't consume scarce research budget
#          ahead of a clean, specific one)
#        - location match strength (does the candidate's OWN location field
#          actually match the query's parsed locations — exact/parent/
#          nearby/none — not just "was found during a location-scoped
#          search")
#        - query match (score_all()'s own match_score — already blends
#          configuration/budget/possession/amenity alignment)
#        - lifecycle evidence presence (a candidate with SOME lifecycle
#          signal, even a weak possession-year fallback, ranks above one
#          with none at all — more promising to resolve with one more push)
#        - data completeness (how many of developer/rera/possession/
#          carpet_area/price are already known)
#      multiplied by a near-duplicate PENALTY (ranked down, never hard-
#      excluded) when another candidate in the SAME batch fuzzy-matches it
#      (dedupe.py's own multi-signal fuzzy tier — name-token overlap AND
#      same developer/locality) — spending research budget on two probable
#      near-duplicates of the same real project is lower-value than
#      spreading it across genuinely distinct candidates.
def _identity_quality(p: dict) -> float:
    if normalize_mod.looks_like_invalid_name(p.get("name") or ""):
        return 0.2
    if len((p.get("name") or "").split()) <= 1:
        return 0.6  # a single bare word is thin, though not flagged invalid
    return 1.0


def _location_match_strength(p: dict) -> float:
    matched = p.get("matched_requirements") or []
    if "location" in matched:
        return 1.0  # Tier 1 — exact_micro_locality (scoring.py's _score_location)
    reasons = " ".join(p.get("match_reasons") or [])
    if "not independently verified" in reasons:
        return 0.6  # Tier 2 — parent_locality credit
    if "Nearby locality" in reasons:
        return 0.3  # Tier 3 — nearby/sibling locality
    if any("does not match" in (m or "").lower() for m in (p.get("mismatches") or [])):
        return 0.0  # Tier 4 — confirmed no match
    return 0.5  # no location requested, or no signal either way — neutral


def _lifecycle_evidence_presence(p: dict) -> float:
    if p.get("lifecycle_evidence_text"):
        return 1.0
    if (p.get("lifecycle_status") or "UNKNOWN") == "READY_TO_MOVE":
        return 0.5  # a possession-year fallback guess — weak, but SOME signal
    return 0.0


def _data_completeness(p: dict) -> float:
    # Phase 2 — was carpet_area_sqft (permanently None before this pass's
    # fix), meaning every single candidate scored exactly 1/5 less complete
    # than it actually was, unconditionally, regardless of real data.
    fields = ("developer", "rera", "possession_display", "carpet_area_display", "price_display")
    return sum(1 for f in fields if p.get(f)) / len(fields)


def _near_duplicate_penalty(p: dict, batch: list) -> float:
    for other in batch:
        if other is p:
            continue
        if dedupe_mod._fuzzy_match(other, p):
            return 0.5
    return 1.0


def _candidate_priority_score(p: dict, batch: list) -> float:
    base = (
        0.30 * _identity_quality(p)
        + 0.20 * _location_match_strength(p)
        + 0.20 * max(0.0, min(1.0, (p.get("match_score") or 0) / 100))
        + 0.15 * _lifecycle_evidence_presence(p)
        + 0.15 * _data_completeness(p)
    )
    return base * _near_duplicate_penalty(p, batch)


def _has_fetchable_source(p: dict) -> bool:
    """Whether deep research could actually READ anything for this candidate.

    A candidate discovered by Google Places carries a maps URL and nothing
    fetchable, so no amount of deep-research budget can resolve its lifecycle
    status — there is no page to open.
    """
    for src in (p.get("sources") or []):
        url = src.get("url")
        if url and not deep_research_mod._is_unfetchable_url(url):
            return True
    return False


def _prioritize_for_deep_research(candidates: list) -> list:
    def undetermined_first(p) -> int:
        status = p.get("lifecycle_status") or "UNKNOWN"
        return 0 if status not in normalize_mod.ALLOWED_LIFECYCLE_STATUSES else 1

    # Live bug, surfaced by deep_research's new "researched N/M" line:
    # node_deep_research was researching ZERO candidates, run after run, while
    # every actual page fetch came from targeted_research instead. Cause: this
    # ordering put lifecycle-UNDETERMINED candidates first (correct — those are
    # the ones research can change), but ~20 of them per query come from Google
    # Places, which supplies a maps URL and no readable page. They filled every
    # budget slot, contributed nothing, and the candidates that DID have a
    # fetchable page never got a slot.
    #
    # Fetchability now sorts ahead of everything: a candidate research cannot
    # read is a candidate research cannot help, whatever its eligibility state.
    # Unfetchable candidates are not dropped — they sort last, and still get
    # their Places name-verification pass.
    def fetchable_first(p) -> int:
        return 0 if _has_fetchable_source(p) else 1

    # Deterministic: ties broken on original (already score_all()-ordered)
    # index, never on dict/insertion-order accidents.
    indexed = list(enumerate(candidates))
    indexed.sort(key=lambda t: (fetchable_first(t[1]), undetermined_first(t[1]),
                                -_candidate_priority_score(t[1], candidates), t[0]))
    return [p for _, p in indexed]


async def node_deep_research(state: ResearchState) -> dict:
    """First (and every loop-back) pass of ACTUAL page reading — fetches
    the best already-known source URL(s) for the top-N candidates and
    extracts structured facts from them. This is what separates "search
    result" from "researched candidate" (Part 3's core distinction).
    """
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("deep_research")
    candidates = _prioritize_for_deep_research(state.get("ranked_properties", []))
    logger.warning("[node:deep_research] ELIGIBILITY-LOOP first pass, %d candidates: %s", len(candidates), [c.get("name") for c in candidates])
    already_fetched = {p["url"] for p in state.get("fetched_pages", []) if p.get("url")}
    budget_s = _budget_for(state, deep_research_mod.DEEP_RESEARCH_BUDGET_S)
    updated, tool_calls, pages, facts = await deep_research_mod.research_candidates(
        candidates, market=state.get("market", "india"), already_fetched=already_fetched,
        budget_s=budget_s,
    )
    # Re-dedupe AFTER the merge, matching node_targeted_research and
    # node_display_enrichment, which both already do this. This node was the
    # one merge point without it — and it is the single most important place
    # to have it, because merge_extracted_facts is where a fetched page's
    # rera_number first becomes the candidate's top-level `rera`. Two
    # candidates that were legitimately distinct at discovery time (one had
    # no RERA yet) become provably the same project at exactly this moment.
    #
    # Live: "Gami Avant" + "Gami Avant - Vashi" both reached the user sharing
    # RERA P51700079740, and "24K residence Hirani" + "24k Residences by
    # Hirani Group" both reached the user sharing P51800047979. Without this
    # line the "sufficient" branch runs final_scoring -> display_enrichment
    # -> location_enrichment -> curator, none of which re-dedupes the RANKED
    # list, so the duplicate pair occupies two of the eight display slots.
    merged = dedupe_mod.dedupe(
        dedupe_mod.merge_updated_candidates(state.get("deduplicated_properties", []), updated))
    return {"deduplicated_properties": merged, "tool_calls": tool_calls, "fetched_pages": pages, "extracted_facts": facts}


async def node_research_gap_checker(state: ResearchState) -> dict:
    """Field-aware gap analysis (Part 11) — replaces the old whole-result-
    set boolean with per-candidate missing/weak/conflicting field lists,
    which is what lets targeted_research generate SPECIFIC follow-up
    queries instead of repeating the original generic search.
    Uses the same prioritized candidate ordering as node_deep_research
    so that gap analysis and research selection act on the identical
    candidate subset (Part 1: consistent candidate identity).
    """
    from . import deep_research as deep_research_mod
    ranked = state.get("ranked_properties", [])
    prioritized = _prioritize_for_deep_research(ranked)
    candidates = prioritized[:deep_research_mod.MAX_CANDIDATES_FOR_DEEP_RESEARCH]
    gaps = gap_checker_mod.compute_gaps(candidates, state.get("parsed_requirements", {}))
    return {"research_gaps": gaps}


def route_research_gap(state: ResearchState) -> str:
    if state.get("bridge_unavailable"):
        # Part 3.3 — no point looping into targeted_research (more search
        # calls) when the dependency every search call needs is already
        # known to be down; preserve whatever evidence discovery already
        # gathered and go straight to scoring/curation with it.
        return "sufficient"
    iterations = state.get("research_iterations", 0)
    if iterations >= MAX_RESEARCH_ITERATIONS:
        return "sufficient"
    # Out of wall clock — stop looping and return what we have. Another
    # research pass that finishes after the caller has given up is not a
    # better answer, it is no answer: the request falls through to the
    # shallower Places-direct pipeline and all of this work is discarded.
    # TAIL_RESERVE_S is fenced off for display/location enrichment (the nodes
    # that fill the visible cards) plus a margin for curation and output —
    # the loop is not allowed to spend it, however many gaps are still open.
    remaining = _remaining_budget(state)
    if remaining <= TAIL_RESERVE_S + CURATION_MARGIN_S:
        logger.warning("[route_research_gap] %.0fs left (tail reserve %.0fs) — stopping the research loop so the displayed candidates can be enriched", remaining, TAIL_RESERVE_S)
        return "sufficient"
    ranked = state.get("ranked_properties", [])
    if not ranked:
        return "sufficient"  # nothing to dig deeper into — looping wouldn't help
    gaps = state.get("research_gaps", [])
    has_real_gap = any(g.get("missing_fields") or g.get("conflicting_fields") for g in gaps)
    if not has_real_gap:
        return "sufficient"
    strong = [p for p in ranked if p.get("match_tier") in ("PRIMARY", "SECONDARY")]
    strong_names = {p.get("name") for p in strong}
    gappy_candidates = {g["candidate"] for g in gaps if g.get("missing_fields") or g.get("conflicting_fields")}
    # If ALL candidates with real gaps are already among the strong candidates,
    # the gap is on a candidate that's already well-represented — no need for
    # another research pass. This fixes the issue where a strong candidate
    # outside the inspected top range contains critical gaps but the routing
    # decision concluded "sufficient" merely because the top-N inspection
    # set didn't include it (Part 3).
    if gappy_candidates.issubset(strong_names):
        return "sufficient"
    # If there are candidates with critical gaps outside the strong set,
    # research must continue to give them a chance — the routing decision
    # cannot incorrectly declare "sufficient" merely because the inspected
    # subset is smaller than the ranked candidate set (Part 3).
    return "needs_more_research"


async def node_targeted_research(state: ResearchState) -> dict:
    """Second-stage, per-candidate, FIELD-AWARE research (Part 12) — for
    every candidate research_gap_checker flagged, generates specific
    queries from its actual gap (missing RERA -> "RERA number
    registration", weak possession -> a re-confirm search, unconfirmed
    "deck" -> a configuration+amenity search), runs them, then fetches +
    extracts from whatever new page that turns up. Merges fresh evidence
    into the SAME deduplicated_properties rather than starting over.
    """
    if state.get("bridge_unavailable"):
        return {**_bridge_skip_record("targeted_research"), "research_iterations": state.get("research_iterations", 0) + 1}
    gaps = state.get("research_gaps", [])
    gappy_names = {g["candidate"] for g in gaps if g.get("missing_fields") or g.get("conflicting_fields") or g.get("weak_fields")}
    # Same undetermined-lifecycle-first priority as node_deep_research's
    # _prioritize_for_deep_research — previously this just took
    # ranked_properties in whatever order they already ranked in, sliced by
    # name membership in gappy_names. With TARGETED_RESEARCH_TOP_N bounded
    # to 3 candidates per loop iteration, a query surfacing many thin
    # (Places-sourced, lifecycle-UNKNOWN) candidates alongside a few
    # already-eligible ones spent this scarce budget in score order, not on
    # the candidates whose ELIGIBILITY actually still hinges on it —
    # confirmed live: 20 Places-contributed candidates, all needing a real
    # lifecycle-resolving search, competing for the same 3-per-iteration
    # slots as already-eligible candidates that only needed minor
    # enrichment. Prioritizing here means the limited budget is spent where
    # it can actually change an accept/reject decision, not just polish a
    # candidate already accepted.
    prioritized = _prioritize_for_deep_research(state.get("ranked_properties", []))
    top = [p for p in prioritized if p.get("name") in gappy_names][:TARGETED_RESEARCH_TOP_N]
    already_fetched = {p["url"] for p in state.get("fetched_pages", []) if p.get("url")}
    logger.warning("[node:targeted_research] ELIGIBILITY-LOOP gap-driven pass, %d candidates: %s", len(top), [p.get("name") for p in top])

    budget_s = _budget_for(state, TARGETED_RESEARCH_BUDGET_S)
    try:
        updated, tool_calls, pages, facts, new_evidence = await asyncio.wait_for(
            deep_research_mod.targeted_research_candidates(
                top, gaps, market=state.get("market", "india"), already_fetched=already_fetched,
            ),
            timeout=budget_s,
        )
    except asyncio.TimeoutError:
        # Same all-or-nothing shape as every other bounded node here: the
        # candidates keep whatever the earlier passes established, and the
        # run moves on to curation with time still on the clock.
        logger.warning("[targeted_research] timed out after %.0fs — continuing with what earlier passes found", budget_s)
        return {
            "tool_calls": [{"tool": "targeted_research", "status": "error", "count": 0,
                            "duration_ms": int(budget_s * 1000), "error": "timed out"}],
            "research_iterations": state.get("research_iterations", 0) + 1,
        }

    newly_normalized = normalize_mod.normalize_all(new_evidence)
    merged = dedupe_mod.merge_updated_candidates(state.get("deduplicated_properties", []), updated)
    merged = dedupe_mod.dedupe(merged + newly_normalized)

    return {
        "raw_evidence": new_evidence,
        "tool_calls": tool_calls,
        "fetched_pages": pages,
        "extracted_facts": facts,
        "deduplicated_properties": merged,
        "research_iterations": state.get("research_iterations", 0) + 1,
        "targeted_research_targets": [p.get("name", "") for p in top],
    }


async def node_final_scoring(state: ResearchState) -> dict:
    """Re-runs the SAME deterministic scorer over deep-research-enriched
    evidence — a thin re-invocation (Part 31: "improve scoring only where
    required by the new evidence", never a second scoring system).
    """
    # Re-classify lifecycle using whatever deep_research/targeted_research
    # actually enriched (real fetched-page description/possession text,
    # sometimes a config-specific possession year fact_extraction.py pulled
    # from the full page) — a candidate deferred as UNKNOWN on the first
    # pass (node_candidate_scorer) gets its genuine second chance here,
    # BEFORE the final=True hard filter below makes the real call.
    enriched = [normalize_mod.reclassify_lifecycle_from_enriched_evidence(p) for p in state.get("deduplicated_properties", [])]
    scored = score_all(enriched, state.get("parsed_requirements", {}))
    ranked, rejected = _apply_hard_eligibility_filter(scored, final=True, location_terms=_location_terms(state), state=state,
                                                     specific_terms=_specific_location_terms(state))
    return {"ranked_properties": ranked, "debug_rejected_candidates": rejected}


async def node_display_enrichment(state: ResearchState) -> dict:
    """Phase 2.5a — the eligibility-research loop (node_deep_research/
    node_targeted_research, via _prioritize_for_deep_research) deliberately
    spends its bounded budget resolving WHETHER a candidate is eligible,
    never on WHAT to show once ranking is already decided. Real,
    live-measured consequence (Phase 2): 4 of 79 deduplicated candidates
    had real carpet data; 0 of the final 8 displayed did — research and
    display were selecting different candidates. Runs strictly AFTER
    final_scoring (ranking/eligibility is already final here — this node
    NEVER re-decides it, never re-runs scoring) and enriches ONLY the exact
    top-MAX_SELECTED slice curator.py is about to return. Reuses
    deep_research.targeted_research_candidates() — the SAME gap-driven
    search+fetch+extract machinery the eligibility loop already uses — via
    a separate, display-scoped gap computation (gap_checker.
    compute_display_gaps), never a second research pipeline.
    """
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("display_enrichment")
    ranked = state.get("ranked_properties", [])
    top = ranked[:MAX_SELECTED]
    if not top:
        return {}
    gaps = gap_checker_mod.compute_display_gaps(top)
    if not gaps:
        logger.warning("[node:display_enrichment] all %d displayed candidates already have every display field — no-op", len(top))
        return {}  # every candidate we're about to show already has every display field
    already_fetched = {p["url"] for p in state.get("fetched_pages", []) if p.get("url")}
    logger.warning("[node:display_enrichment] DISPLAY-SCOPED pass, %d/%d displayed candidates have a gap: %s", len(gaps), len(top), [(g["candidate"], g["missing_fields"]) for g in gaps])
    # Reserve location_enrichment's slice: this node runs immediately before
    # it, and left unreserved it takes the whole remaining clock every time.
    display_budget_s = _budget_for(state, DISPLAY_ENRICHMENT_BUDGET_S,
                                   reserve_s=LOCATION_ENRICHMENT_BUDGET_S)
    try:
        updated, tool_calls, pages, facts, new_evidence = await asyncio.wait_for(
            deep_research_mod.targeted_research_candidates(
                top, gaps, market=state.get("market", "india"), already_fetched=already_fetched,
            ),
            timeout=display_budget_s,
        )
    except asyncio.TimeoutError:
        # The CLAMPED budget, not the constant — see location_enrichment.
        logger.warning("[display_enrichment] timed out after %.0fs (run clock) — showing the top-%d unenriched (bounded, all-or-nothing, matching every other timeout in this pipeline)", display_budget_s, MAX_SELECTED)
        return {"tool_calls": [{"tool": "display_enrichment", "status": "error", "count": 0, "duration_ms": int(display_budget_s * 1000), "error": "timed out"}]}

    newly_normalized = normalize_mod.normalize_all(new_evidence)
    merged_dedup = dedupe_mod.merge_updated_candidates(state.get("deduplicated_properties", []), updated)
    merged_dedup = dedupe_mod.dedupe(merged_dedup + newly_normalized)
    # merge_updated_candidates does a wholesale replace-by-id — safe here
    # ONLY because `updated`'s entries originate from merge_extracted_facts
    # starting from `dict(prop)` on these EXACT RankedProperty items (`top`
    # itself, passed straight into targeted_research_candidates above), so
    # every ranking field (match_score/match_tier/match_reasons/
    # limitations) is already carried through intact, not a stripped-down
    # NormalizedProperty that would silently drop them and break curator.py.
    merged_ranked = dedupe_mod.merge_updated_candidates(ranked, updated)
    return {
        "deduplicated_properties": merged_dedup,
        "ranked_properties": merged_ranked,
        "tool_calls": tool_calls,
        "fetched_pages": pages,
        "extracted_facts": facts,
        "raw_evidence": new_evidence,
    }


LOCATION_ENRICHMENT_BUDGET_S = float(os.getenv("AI_SEARCH_LOCATION_ENRICHMENT_BUDGET_MS", "20000")) / 1000


def _candidate_coordinate(p: dict) -> "tuple[float, float] | None":
    """The candidate's real coordinate, or None. Two honest sources, in
    authority order: a Places-verified location (places_lat/places_lon, set by
    normalize.py from a real Places match), then a `geo` block read out of the
    page's own JSON-LD (fact_extraction.extract_from_structured_data).

    Deliberately does NOT geocode the name as a fallback. A wrong coordinate
    produces a confident, wrong Location Score with real-looking place names
    attached to it, which is worse for a buyer than an empty tab.
    """
    for lat_key, lon_key in (("places_lat", "places_lon"), ("latitude", "longitude")):
        lat, lon = p.get(lat_key), p.get(lon_key)
        try:
            if lat is not None and lon is not None:
                lat_f, lon_f = float(lat), float(lon)
                # Guard against a 0,0 placeholder ever being treated as real.
                if lat_f or lon_f:
                    return lat_f, lon_f
        except (TypeError, ValueError):
            continue
    return None


async def node_location_enrichment(state: ResearchState) -> dict:
    """Location Score, connectivity and nearby landmarks for the candidates
    actually about to be displayed — one deterministic Google Places call
    each, no LLM, run in parallel and bounded by its own wall clock.

    Scoped to the top-MAX_SELECTED slice for the same reason
    display_enrichment is: research budget spent on candidates that never get
    shown is the mismatch the live traces kept surfacing.

    ADDITIVE by construction:
      * `connectivity` / `nearby_landmarks` are only filled when the existing
        pipeline left them empty — this never overwrites an extracted value.
      * `location_score` / `location_intel` are new fields; nothing else reads
        them today, so nothing else can change behaviour because of them.
      * A candidate with no real coordinate is skipped, not geocoded.
      * Any failure returns the candidates untouched — this node can make the
        result poorer only by being slow, which is what the budget bounds.
    """
    ranked = state.get("ranked_properties", [])
    if not ranked:
        return {}
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("location_enrichment")

    top = ranked[:MAX_SELECTED]
    targets = [(i, p, coord) for i, p in enumerate(top) if (coord := _candidate_coordinate(p))]
    if not targets:
        logger.warning("[node:location_enrichment] none of the %d displayed candidates has a real coordinate — skipped (never geocoded from a name)", len(top))
        return {}

    logger.warning("[node:location_enrichment] %d/%d displayed candidates have a coordinate", len(targets), len(top))
    try:
        location_budget_s = _budget_for(state, LOCATION_ENRICHMENT_BUDGET_S)
        results = await asyncio.wait_for(
            asyncio.gather(*[tools_mod.places_nearby(lat, lon) for _, _, (lat, lon) in targets],
                           return_exceptions=True),
            timeout=location_budget_s,
        )
    except asyncio.TimeoutError:
        # The CLAMPED budget, not the constant — a run with no clock left
        # reported "timed out after 20.0s" having actually waited ~0s, which
        # made an exhausted run look like a slow Places call.
        logger.warning("[location_enrichment] timed out after %.0fs (run clock) — displaying candidates without location intel", location_budget_s)
        return {"tool_calls": [{"tool": "location_enrichment", "status": "error", "count": 0,
                                "duration_ms": int(location_budget_s * 1000), "error": "timed out"}]}

    enriched = list(ranked)
    tool_calls: list = []
    filled = 0
    for (idx, prop, _coord), result in zip(targets, results):
        if isinstance(result, Exception):
            logger.warning("[location_enrichment] %s failed: %s", prop.get("name"), result)
            continue
        data, record = result
        tool_calls.append(record)
        if not data or not data.get("configured"):
            continue
        updated = dict(prop)
        updated["location_intel"] = {
            "by_dimension": data.get("by_dimension") or {},
            "source": "google-places-nearby",
        }
        if data.get("location_score"):
            updated["location_score"] = data["location_score"]
        # Fill-if-empty only — an extracted value always wins, so this can
        # never regress a candidate that already had these.
        if data.get("connectivity") and not updated.get("connectivity"):
            updated["connectivity"] = data["connectivity"]
        if data.get("nearby_landmarks") and not updated.get("nearby_landmarks"):
            updated["nearby_landmarks"] = data["nearby_landmarks"]
        enriched[idx] = updated
        filled += 1

    logger.warning("[node:location_enrichment] enriched %d/%d displayed candidates", filled, len(top))
    return {"ranked_properties": enriched, "tool_calls": tool_calls}


async def node_curator(state: ResearchState) -> dict:
    return await curate(state)


async def node_structured_output(state: ResearchState) -> dict:
    resp = dict(state.get("final_response") or {})
    resp.setdefault("research_metadata", {})
    resp["research_metadata"]["duration_ms"] = None  # filled by the FastAPI layer, which has the wall-clock start time
    return {"final_response": resp, "timestamps": {"completed": datetime.now(timezone.utc).isoformat()}}


def build_graph():
    g = StateGraph(ResearchState)

    g.add_node("bridge_preflight", node_bridge_preflight)
    g.add_node("query_understanding", node_query_understanding)
    g.add_node("location_resolution", node_location_resolution)
    g.add_node("research_planner", node_research_planner)
    g.add_node("tavily_search", node_tavily_search)
    g.add_node("web_search", node_web_search)
    g.add_node("serper_search", node_serper_search)
    g.add_node("apify_search", node_apify_search)
    g.add_node("portal_search", node_portal_search)
    g.add_node("developer_search", node_developer_search)
    g.add_node("lifecycle_variant_search", node_lifecycle_variant_search)
    g.add_node("places_search", node_places_search)
    g.add_node("evidence_normalizer", node_evidence_normalizer)
    g.add_node("deduplicator", node_deduplicator)
    g.add_node("candidate_verifier", node_candidate_verifier)
    g.add_node("candidate_scorer", node_candidate_scorer)
    g.add_node("deep_research", node_deep_research)
    g.add_node("research_gap_checker", node_research_gap_checker)
    g.add_node("targeted_research", node_targeted_research)
    g.add_node("final_scoring", node_final_scoring)
    g.add_node("display_enrichment", node_display_enrichment)
    g.add_node("location_enrichment", node_location_enrichment)
    g.add_node("curator", node_curator)
    g.add_node("structured_output", node_structured_output)

    g.add_edge(START, "bridge_preflight")
    g.add_edge("bridge_preflight", "query_understanding")
    g.add_edge("query_understanding", "location_resolution")
    g.add_edge("location_resolution", "research_planner")

    for search_node in ["tavily_search", "web_search", "serper_search", "apify_search", "portal_search", "developer_search", "lifecycle_variant_search", "places_search"]:
        g.add_edge("research_planner", search_node)
        g.add_edge(search_node, "evidence_normalizer")

    g.add_edge("evidence_normalizer", "deduplicator")
    g.add_edge("deduplicator", "candidate_verifier")
    g.add_edge("candidate_verifier", "candidate_scorer")
    g.add_edge("candidate_scorer", "deep_research")
    g.add_edge("deep_research", "research_gap_checker")

    g.add_conditional_edges(
        "research_gap_checker", route_research_gap,
        {"needs_more_research": "targeted_research", "sufficient": "final_scoring"},
    )
    g.add_edge("targeted_research", "candidate_verifier")  # loop back through verify -> score -> deep_research -> gap_check

    g.add_edge("final_scoring", "display_enrichment")
    g.add_edge("display_enrichment", "location_enrichment")
    g.add_edge("location_enrichment", "curator")
    g.add_edge("curator", "structured_output")
    g.add_edge("structured_output", END)

    return g.compile()


_compiled_graph = None


def get_graph():
    global _compiled_graph
    if _compiled_graph is None:
        _compiled_graph = build_graph()
    return _compiled_graph
