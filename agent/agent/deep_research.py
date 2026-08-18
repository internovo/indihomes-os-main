"""Deep page research (Part 4/6/8-16) — the capability that turns discovered
candidate NAMES into researched candidate FACTS: pick the best already-known
source URL(s) per candidate (source hierarchy, Part 34), fetch_page() them,
extract structured facts, and merge those facts back into the candidate via
dedupe.py's conflict-preserving merge (never overwrite a real value, always
record a genuine conflict).

Two entry points sharing this machinery:
- research_candidates(): first-pass, broad — top-N candidates, whatever
  source URLs discovery search already found for them. No new search
  calls; this step is pure "go read what we already found".
- targeted_research_candidates(): loop-only, gap-driven — runs field-aware
  searches (planner.build_field_aware_targeted_queries) for candidates
  research_gap_checker flagged, THEN fetches+extracts from whatever NEW
  URLs those specific searches turned up. This is where "search again" for
  a SPECIFIC missing fact actually happens (Part 3/12).

Both are bounded by MAX_FETCHES_PER_CANDIDATE / MAX_TARGETED_SEARCHES_PER_
ITERATION (env-configurable, Part 13/45) and thread an `already_fetched`
URL set through so the SAME url is never fetched twice in one research
session.
"""
from __future__ import annotations

import asyncio
import os
from typing import Optional

from . import dedupe as dedupe_mod
from . import fact_extraction
from . import planner as planner_mod
from . import tools as tools_mod
from .state import CandidateGap, EvidenceItem, ExtractedFact, FeatureEvidence, FetchedPage, NormalizedProperty, RankedProperty, ToolCallRecord

# Was 3 — raised to 5 (still a small, deterministic, explainable,
# env-configurable cap, not "research everything") after a live false-
# negative: a genuine under-construction project reached zero results
# because it fell just outside an unprioritized top-3 cut. Combined with
# graph.py's _prioritize_for_deep_research() (candidates with UNDETERMINED
# eligibility now go first within this budget), 5 gives a realistic query
# with several individual-project candidates a real chance to actually get
# verified, without turning this into "fetch every result".
MAX_CANDIDATES_FOR_DEEP_RESEARCH = int(os.getenv("AI_SEARCH_MAX_CANDIDATES_FOR_DEEP_RESEARCH", "5"))
MAX_FETCHES_PER_CANDIDATE = int(os.getenv("AI_SEARCH_MAX_FETCHES_PER_CANDIDATE", "3"))
MAX_TARGETED_SEARCHES_PER_ITERATION = int(os.getenv("AI_SEARCH_MAX_TARGETED_SEARCHES_PER_ITERATION", "5"))

# Source hierarchy (Part 34) — lower number wins when choosing which of a
# candidate's already-known source URLs to actually spend a fetch on.
_SOURCE_PRIORITY = {"official": 0, "developer": 1, "portal": 2, "web": 3, "category_page_extract": 4}

# A Google Maps place-detail "cid" link (https://maps.google.com/?cid=...) is
# a REDIRECT into Google's own app, not a fetchable content page — there is
# no HTML for fact_extraction to read on the other end of it. Confirmed live
# (LangSmith trace, 2026-08-18): two separate fetch_page attempts on cid
# URLs took 17.2s and 15.8s before failing with ReadTimeout — nearly the
# entire per-candidate fetch budget spent on a URL that could never have
# returned useful content even on success. Places-sourced candidates already
# carry everything Places itself knows (name/address/lat/lon, set directly
# in normalize.py) — there's nothing this fetch could add, only cost.
# Excluded from source-URL selection entirely; a candidate whose ONLY known
# source is a cid link simply gets zero fetches, same as a candidate with no
# sources at all, rather than wasting a fetch attempt on it.
def _is_unfetchable_url(url: str) -> bool:
    return "maps.google.com/?cid=" in url or "maps.google.com/place?cid=" in url


def _prioritized_source_urls(prop: NormalizedProperty, limit: int, already_fetched: set[str]) -> list[tuple[str, str]]:
    sources = prop.get("sources") or []
    candidates = [s for s in sources if s.get("url") and s["url"] not in already_fetched and not _is_unfetchable_url(s["url"])]
    candidates.sort(key=lambda s: _SOURCE_PRIORITY.get(s.get("source_type"), 4))
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for s in candidates:
        url = s["url"]
        if url in seen:
            continue
        seen.add(url)
        out.append((url, s.get("source_type") or "web"))
        if len(out) >= limit:
            break
    return out


async def _fetch_and_extract(name: str, urls: list[tuple[str, str]], candidate_id: Optional[str] = None) -> tuple[list[FetchedPage], list[ExtractedFact], list[FeatureEvidence], list[ToolCallRecord]]:
    pages: list[FetchedPage] = []
    facts: list[ExtractedFact] = []
    features: list[FeatureEvidence] = []
    tool_calls: list[ToolCallRecord] = []
    # Follow-up spec Part 1/19 — this candidate's own up-to-MAX_FETCHES_
    # PER_CANDIDATE URLs are fetched IN PARALLEL, not one-at-a-time.
    # Confirmed as a real, live-measured latency contributor: raising
    # MAX_CANDIDATES_FOR_DEEP_RESEARCH (3 -> 5, same follow-up spec) to
    # give more UNKNOWN candidates a real verification chance directly
    # multiplied this loop's SEQUENTIAL cost (up to 5 candidates x up to 3
    # fetches each, one after another) enough to push a real request past
    # the whole-pipeline timeout and fall all the way back to the Node
    # pipeline — the opposite of the intended fix. These fetches have no
    # dependency on each other (different URLs for the same candidate),
    # so there's no correctness reason for them to be sequential.
    results = await asyncio.gather(*[
        tools_mod.fetch_page(url, candidate=name, candidate_id=candidate_id, source_type=source_type)
        for url, source_type in urls
    ])
    for page, record in results:
        tool_calls.append(record)
        if page["status"] != "success":
            continue
        pages.append(page)
        page_facts, page_features = fact_extraction.deterministic_extract(name, page)
        facts.extend(page_facts)
        features.extend(page_features)

    # ONE bounded LLM assist call per candidate (not per page) — only for
    # fields still missing after every deterministic pass across all of
    # this candidate's fetched pages, and only against the single richest
    # (first successful) page — Part 17/19's cost rule. Never covers deck/
    # balcony/parking (LLM_ASSISTABLE_FIELDS excludes them — see fact_
    # extraction.py) since those are the structured `features` list's job.
    if pages:
        found_fields = {f["field"] for f in facts}
        still_missing = [f for f in fact_extraction.LLM_ASSISTABLE_FIELDS if f not in found_fields]
        if still_missing:
            facts.extend(await fact_extraction.llm_assist_extract(name, pages[0], still_missing))

    return pages, facts, features, tool_calls


async def research_candidates(
    candidates: list[RankedProperty], *, market: str, already_fetched: set[str],
    max_candidates: int = MAX_CANDIDATES_FOR_DEEP_RESEARCH, max_fetches_per_candidate: int = MAX_FETCHES_PER_CANDIDATE,
) -> tuple[list[NormalizedProperty], list[ToolCallRecord], list[FetchedPage], list[ExtractedFact]]:
    updated: list[NormalizedProperty] = []
    all_tool_calls: list[ToolCallRecord] = []
    all_pages: list[FetchedPage] = []
    all_facts: list[ExtractedFact] = []

    for prop in candidates[:max_candidates]:
        name = prop.get("name", "")
        urls = _prioritized_source_urls(prop, max_fetches_per_candidate, already_fetched)
        current = prop
        if urls:
            pages, facts, features, tool_calls = await _fetch_and_extract(name, urls, candidate_id=prop.get("id"))
            already_fetched.update(u for u, _ in urls)
            all_tool_calls.extend(tool_calls)
            all_pages.extend(pages)
            all_facts.extend(facts)
            current = dedupe_mod.merge_extracted_facts(prop, facts, features)

        # Part 2 (Places-augmented pipeline) — per-candidate name
        # verification, on EVERY candidate reaching this bounded loop
        # regardless of source or whether a page was even fetchable (a
        # candidate's name can already be final even with no fetchable
        # URL). Skipped whenever a verification attempt was ALREADY made —
        # `places_verified` already present as True (discovered by
        # places_search itself, or a prior iteration's lookup resolved it)
        # OR False (a prior iteration already tried and found nothing) —
        # `is None` (the key genuinely never set) is the only case that
        # still runs it. This loop can re-enter across the gap-driven
        # research iterations (Part 3/12); without this, a candidate
        # already checked in iteration 1 was being re-verified — a real,
        # observed, wasteful duplicate call live-caught during this pass —
        # every iteration, burning real Places API quota for a result
        # already known. A candidate that does NOT resolve is NOT itself
        # rejected (see places_verify's own scope comment) — only graph.py's
        # hard-eligibility filter's separate looks_like_invalid_name()
        # check, consulted ONLY when this is False, actually gates anything.
        if current.get("places_verified") is None:
            locality = current.get("micro_location") or current.get("location")
            city = current.get("city")
            match, verify_record = await tools_mod.places_verify(current.get("name", ""), locality, city)
            all_tool_calls.append(verify_record)
            current = dict(current)
            if match:
                current["places_verified"] = True
                current["places_lat"] = match.get("lat")
                current["places_lon"] = match.get("lon")
                current["places_place_id"] = match.get("placeId")
                current["places_address"] = match.get("address")
            else:
                current["places_verified"] = False

        updated.append(current)

    return updated, all_tool_calls, all_pages, all_facts


async def targeted_research_candidates(
    candidates: list[RankedProperty], gaps: list[CandidateGap], *, market: str, already_fetched: set[str],
    max_targeted_searches: int = MAX_TARGETED_SEARCHES_PER_ITERATION, max_fetches_per_candidate: int = MAX_FETCHES_PER_CANDIDATE,
) -> tuple[list[NormalizedProperty], list[ToolCallRecord], list[FetchedPage], list[ExtractedFact], list[EvidenceItem]]:
    gaps_by_name = {g["candidate"]: g for g in gaps}
    updated: list[NormalizedProperty] = []
    all_tool_calls: list[ToolCallRecord] = []
    all_pages: list[FetchedPage] = []
    all_facts: list[ExtractedFact] = []
    all_new_evidence: list[EvidenceItem] = []
    queries_used = 0

    for prop in candidates:
        name = prop.get("name", "")
        gap = gaps_by_name.get(name)
        if not gap:
            continue
        location = prop.get("location")
        configuration = " & ".join(prop.get("configuration") or []) or None
        queries = planner_mod.build_field_aware_targeted_queries(
            gap, location, configuration, market_limit=max(0, max_targeted_searches - queries_used),
        )

        candidate_new_evidence: list[EvidenceItem] = []
        for q in queries:
            if queries_used >= max_targeted_searches:
                break
            queries_used += 1
            # Same fix as _fetch_and_extract above — web_search and
            # tavily_search for the SAME query text are two independent
            # tools with no dependency on each other's result; running them
            # sequentially was pure wasted wall-clock time, and this loop
            # runs once per targeted query per candidate (confirmed as a
            # real, live-measured latency contributor: this is the exact
            # loop the original bridge-retry-storm evidence came from).
            (evidence, record), (evidence2, record2) = await asyncio.gather(
                tools_mod.web_search(q, market),
                tools_mod.tavily_search(q, market, depth="advanced"),
            )
            all_tool_calls.append(record)
            candidate_new_evidence.extend(evidence)
            all_tool_calls.append(record2)
            candidate_new_evidence.extend(evidence2)

        all_new_evidence.extend(candidate_new_evidence)

        # Fetch+extract from the best NEW url this candidate's targeted
        # searches actually turned up — same source-hierarchy prioritization
        # as the first pass, just over freshly-discovered URLs instead of
        # the candidate's pre-existing sources.
        fresh_sources = [
            {"url": e.get("source_url"), "source_type": e.get("source_type") or "web"}
            for e in candidate_new_evidence if e.get("source_url")
        ]
        urls = _prioritized_source_urls(
            NormalizedProperty(sources=fresh_sources), max_fetches_per_candidate, already_fetched,  # type: ignore[call-arg]
        )
        pages, facts, features, fetch_tool_calls = await _fetch_and_extract(name, urls, candidate_id=prop.get("id"))
        already_fetched.update(u for u, _ in urls)
        all_tool_calls.extend(fetch_tool_calls)
        all_pages.extend(pages)
        all_facts.extend(facts)

        updated.append(dedupe_mod.merge_extracted_facts(prop, facts, features))

    return updated, all_tool_calls, all_pages, all_facts, all_new_evidence
