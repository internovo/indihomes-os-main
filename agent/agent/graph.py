"""The actual LangGraph StateGraph — the evolved "discover -> inspect ->
fetch -> extract -> verify -> identify gaps -> search again -> verify ->
rank -> curate" pipeline (this task's core architectural change), built
with real conditional routing and a bounded research-gap loop, not a
single monolithic prompt.

    START
      -> query_understanding -> location_resolution -> research_planner
      -> {tavily_search, web_search, apify_search, portal_search, developer_search, places_search}  (fan-out, DISCOVERY)
      -> evidence_normalizer -> deduplicator -> candidate_verifier
      -> candidate_scorer -> deep_research (DEEP PAGE RESEARCH, fetch_page + fact extraction)
      -> research_gap_checker (per-candidate, per-field: missing/weak/conflicting)
           - needs_more_research -> targeted_research (field-aware search + fetch + extract)
                                       -> candidate_verifier (loop back)
           - sufficient -> final_scoring -> curator -> structured_output -> END

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

import logging
import os
from datetime import datetime, timezone

from langgraph.graph import END, START, StateGraph

from . import dedupe as dedupe_mod
from . import deep_research as deep_research_mod
from . import gap_checker as gap_checker_mod
from . import llm_providers
from . import normalize as normalize_mod
from . import planner as planner_mod
from . import tools as tools_mod
from .curator import curate
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
    available, error = await tools_mod.check_bridge_available(force=True)
    if not available:
        logger.error("[bridge-preflight] bridge unavailable: %s", error)
        return {
            "bridge_unavailable": True,
            "errors": [f"Node tool bridge unavailable ({tools_mod.NODE_BASE_URL}): {error}"],
            "tool_calls": [{"tool": "bridge_preflight", "status": "error", "count": 0, "duration_ms": 0, "error": error}],
        }
    return {"bridge_unavailable": False, "tool_calls": [{"tool": "bridge_preflight", "status": "ok", "count": 1, "duration_ms": 0, "error": None}]}


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
    return {"micro_locations": resolved}


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


def _matches_searched_location(prop: dict, location_terms: list[str]) -> bool:
    if not location_terms:
        return True  # nothing to check against — query had no resolvable location
    text = " ".join(str(prop.get(k) or "") for k in ("name", "location", "micro_location", "city", "description")).lower()
    return any(term.lower() in text for term in location_terms)


def _apply_hard_eligibility_filter(scored: list, final: bool = False, location_terms: list[str] | None = None, state: "ResearchState | None" = None) -> tuple[list, list]:
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
            # Places-verified escape hatch — the architectural change this
            # comment documents: a candidate Google Places itself confirmed
            # is a REAL, EXISTING building (places_verified is True, real
            # lat/lon/place_id attached) should not be thrown away purely
            # because nothing in its text ever stated a construction status
            # — Places doesn't track that at all, so a real building found
            # via Places is STRUCTURALLY unable to ever satisfy this gate the
            # normal way. Confirmed live: a real search returned candidates
            # correctly rejected here despite Places independently verifying
            # them as genuine buildings in the searched area. Rather than
            # keep silently discarding real, verified inventory, this now
            # ACCEPTS a Places-verified candidate whose lifecycle status
            # simply couldn't be determined — but marks it
            # `_unverified_lifecycle=True` so scoring.py caps its tier and
            # the frontend renders it as "real building, launch status not
            # confirmed" rather than claiming it's a verified new-launch
            # project. This is exactly the same honesty standard Competitor
            # Analysis already uses (real buildings, no lifecycle claim at
            # all) — not a relaxation of what "confirmed new-launch" means
            # for every OTHER candidate, which keeps the existing strict
            # rule unchanged.
            if p.get("places_verified") is True:
                p = dict(p)
                p["_unverified_lifecycle"] = True
                # Cap here, not in scoring.py — score_all() already ran
                # before this filter (node_final_scoring's own order), so
                # this is the first point that KNOWS the candidate is
                # Places-verified-but-lifecycle-unconfirmed. Never claim
                # PRIMARY/SECONDARY ("strongly matches") for a building
                # whose construction status is honestly unknown — same 55
                # ceiling this codebase already uses for a wrong-location or
                # aggregator-page result, for the same reason: real, but not
                # a strong confirmed match.
                p["match_score"] = min(p.get("match_score", 0), 55)
                p["match_tier"] = "TERTIARY" if p["match_score"] >= 40 else "LOW_MATCH"
                p["match_reasons"] = list(p.get("match_reasons") or []) + [
                    "Real building confirmed via Google Places near your search — new-launch/construction status could not be independently verified"
                ]
                accepted.append(p)
                continue
            reason = (
                "Ready-to-move / completed inventory — outside the active new-project search policy" if status == "READY_TO_MOVE"
                else "Lifecycle stage could not be confidently determined even after deep research"
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
            matched = _matches_searched_location(p, location_terms)

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
    ranked, rejected = _apply_hard_eligibility_filter(scored, location_terms=_location_terms(state), state=state)
    return {"ranked_properties": ranked, "debug_rejected_candidates": rejected}


# ── Deep page research (Part 4/6/8-16) ──────────────────────────────────────

# Verification-priority ordering for the FIXED deep-research budget
# (Part 4/19 of the follow-up spec) — deep_research always spends its
# budget on candidates[:max_candidates] IN WHATEVER ORDER IT'S GIVEN, so
# that order is the actual lever controlling which candidates get a real
# chance to resolve their eligibility. Previously that was just
# score_all()'s display-ranking order — a candidate with an undetermined
# (UNKNOWN/READY_TO_MOVE) lifecycle competed for the same fixed slots as
# one that's ALREADY confidently eligible, on pure match_score, with no
# regard for which kind of candidate actually NEEDS the research spend to
# determine eligibility at all. Confirmed as the real mechanism behind a
# live false-negative (a genuine "Dem Icon Charkop" under-construction
# project reached zero results in one run because it didn't make an
# unprioritized top-3 cut, then correctly resolved once given the chance).
# Fix: candidates whose eligibility is still UNDETERMINED go first — they
# are strictly the higher-value target for a bounded research budget, since
# spending it there can change an accept/reject decision, while spending it
# on an already-eligible candidate mostly just enriches display fields.
# Stable sort — WITHIN each priority group, score_all()'s own relevance
# ordering (location/configuration/etc, Part 19's "prioritize using
# location relevance, configuration relevance..." requirement) is
# preserved untouched, never re-decided here.
def _prioritize_for_deep_research(candidates: list) -> list:
    def priority(p) -> int:
        status = p.get("lifecycle_status") or "UNKNOWN"
        return 0 if status not in normalize_mod.ALLOWED_LIFECYCLE_STATUSES else 1
    return sorted(candidates, key=priority)


async def node_deep_research(state: ResearchState) -> dict:
    """First (and every loop-back) pass of ACTUAL page reading — fetches
    the best already-known source URL(s) for the top-N candidates and
    extracts structured facts from them. This is what separates "search
    result" from "researched candidate" (Part 3's core distinction).
    """
    if state.get("bridge_unavailable"):
        return _bridge_skip_record("deep_research")
    candidates = _prioritize_for_deep_research(state.get("ranked_properties", []))
    already_fetched = {p["url"] for p in state.get("fetched_pages", []) if p.get("url")}
    updated, tool_calls, pages, facts = await deep_research_mod.research_candidates(
        candidates, market=state.get("market", "india"), already_fetched=already_fetched,
    )
    merged = dedupe_mod.merge_updated_candidates(state.get("deduplicated_properties", []), updated)
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

    updated, tool_calls, pages, facts, new_evidence = await deep_research_mod.targeted_research_candidates(
        top, gaps, market=state.get("market", "india"), already_fetched=already_fetched,
    )

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
    ranked, rejected = _apply_hard_eligibility_filter(scored, final=True, location_terms=_location_terms(state), state=state)
    return {"ranked_properties": ranked, "debug_rejected_candidates": rejected}


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
    g.add_node("curator", node_curator)
    g.add_node("structured_output", node_structured_output)

    g.add_edge(START, "bridge_preflight")
    g.add_edge("bridge_preflight", "query_understanding")
    g.add_edge("query_understanding", "location_resolution")
    g.add_edge("location_resolution", "research_planner")

    for search_node in ["tavily_search", "web_search", "apify_search", "portal_search", "developer_search", "lifecycle_variant_search", "places_search"]:
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

    g.add_edge("final_scoring", "curator")
    g.add_edge("curator", "structured_output")
    g.add_edge("structured_output", END)

    return g.compile()


_compiled_graph = None


def get_graph():
    global _compiled_graph
    if _compiled_graph is None:
        _compiled_graph = build_graph()
    return _compiled_graph
