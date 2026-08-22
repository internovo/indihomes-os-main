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
import logging
import os
import time
from typing import Optional

logger = logging.getLogger("ai-search-agent.deep_research")

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
# Raised 5 -> 12, and made safe to raise by the two changes below (bounded
# concurrency + a wall-clock deadline). The cap was the funnel: a live
# "2 BHK in Chikuwadi" run found 70 candidates, 45 of which stayed
# lifecycle-UNKNOWN purely because nothing ever fetched a page for them, and
# the strict eligibility policy then rejected all 45. That is not extraction
# failing — it is never having looked.
#
# Raising a SERIAL loop would simply have moved the failure to the 180s
# request timeout, so the cap alone was never the fix; see
# DEEP_RESEARCH_BUDGET_S and DEEP_RESEARCH_CONCURRENCY.
MAX_CANDIDATES_FOR_DEEP_RESEARCH = int(os.getenv("AI_SEARCH_MAX_CANDIDATES_FOR_DEEP_RESEARCH", "12"))
# How many candidates are researched at once. Pages WITHIN one candidate were
# already fetched in parallel (_fetch_and_extract); the candidates themselves
# ran strictly one after another, which is why 3 candidates took ~30s and 12
# would have taken two minutes.
DEEP_RESEARCH_CONCURRENCY = int(os.getenv("AI_SEARCH_DEEP_RESEARCH_CONCURRENCY", "4"))
# Wall-clock ceiling for ONE deep-research pass. When it expires, whatever
# finished is kept and the rest are returned unresearched — a partial result
# inside the timeout beats a complete result the caller never receives,
# because a request that overruns AI_SEARCH_TIMEOUT_MS falls through to the
# shallower Places-direct pipeline and the user sees nothing of this work.
DEEP_RESEARCH_BUDGET_S = float(os.getenv("AI_SEARCH_DEEP_RESEARCH_BUDGET_MS", "45000")) / 1000
MAX_FETCHES_PER_CANDIDATE = int(os.getenv("AI_SEARCH_MAX_FETCHES_PER_CANDIDATE", "3"))
MAX_TARGETED_SEARCHES_PER_ITERATION = int(os.getenv("AI_SEARCH_MAX_TARGETED_SEARCHES_PER_ITERATION", "5"))
# Phase 2.5c — llm_assist_extract's own per-call window stays 4000 chars
# (fact_extraction.py, unchanged); this bounds how many 4000-char WINDOWS
# of a candidate's fetched pages get tried in total (across pages AND
# within one page) before giving up on the still-missing fields. Real
# pages carry their target fields spread across the WHOLE page (Part P0's
# own live measurement: a page's first RERA sits at ~7660 chars, its fifth
# at ~24000) — one page can need several windows. A cap here, not an
# unbounded "try every window of every fetched page," so a very long, very
# thin page can't turn into an unbounded LLM call count.
MAX_LLM_ASSIST_CALLS_PER_CANDIDATE = int(os.getenv("AI_SEARCH_MAX_LLM_ASSIST_CALLS_PER_CANDIDATE", "6"))

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
# Google Maps place links carry no readable page content — fetching one gets a
# JS shell, never the project's details. Two forms were listed; the one Places
# (New) actually returns is `googleMapsUri`, which is
# https://www.google.com/maps/place/?q=place_id:... — and it was NOT matched,
# so every Places-sourced candidate looked fetchable, filled a deep-research
# budget slot and produced nothing. Caught by test_search_harness's
# prioritisation case, which failed against the real function after passing
# against a stub that guessed this was already handled.
_UNFETCHABLE_URL_MARKERS = (
    "maps.google.com/?cid=",
    "maps.google.com/place?cid=",
    "google.com/maps/place",
    "google.com/maps/search",
    "goo.gl/maps",
    "maps.app.goo.gl",
)


# Extensions the /fetch-page route refuses outright with "Unsupported
# content-type: application/json" (and application/pdf). Measured live: 40+
# such failures across 7 of 10 test searches, each one having already spent
# a research slot and a network round-trip to learn what the URL itself
# said up front. Deep research is budget-bounded and its slots are the
# scarcest thing in the run, so a slot spent on a JSON endpoint is a page
# of real evidence not read.
#
# Extension-only, deliberately. A path merely CONTAINING "/api/" is not
# enough — plenty of real project pages sit under marketing paths that
# include such words, and wrongly discarding a readable page is the more
# expensive mistake. The true fix for the remainder is upstream, in
# whichever search connector is surfacing data endpoints as results; this
# stops the budget bleeding meanwhile.
_NON_HTML_URL_SUFFIXES = (
    ".json", ".pdf", ".xml", ".csv", ".rss", ".atom",
    ".zip", ".doc", ".docx", ".xls", ".xlsx",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".mp4", ".mp3",
)


def _is_non_html_url(url: str) -> bool:
    path = (url or "").lower().split("?", 1)[0].split("#", 1)[0].rstrip("/")
    return path.endswith(_NON_HTML_URL_SUFFIXES)


def _is_unfetchable_url(url: str) -> bool:
    lowered = (url or "").lower()
    if any(marker in lowered for marker in _UNFETCHABLE_URL_MARKERS):
        return True
    return _is_non_html_url(url)


# Phase 2.5c — chosen over a "select the section most likely to hold the
# target fields" heuristic. Reasoning: real pages carry their target
# fields spread across GENUINELY DIFFERENT sections (developer/RERA
# usually near the top, amenities/tower-count/connectivity further down,
# sometimes past 20000 chars) — a single heuristic window risks
# confidently picking the WRONG section and missing everything else
# entirely, with no second chance. Chunking with early-stop (see
# _fetch_and_extract below) tries the cheap thing first (chunk 1 of page
# 1 is IDENTICAL to the old text[:4000] behavior) and only escalates when
# fields are genuinely still missing after that — the common case costs
# exactly what it cost before this change. A small overlap so a field
# mention straddling a chunk boundary isn't silently split in half.
_CHUNK_SIZE = 4000
_CHUNK_OVERLAP = 200


# ── Chunking guards ─────────────────────────────────────────────────────────
# Chunking was bounded by BUDGET, not by EVIDENCE: it kept spending calls until
# every field filled or the per-candidate cap ran out. Two live traces showed
# what that costs:
#   * an LLM call on a chunk_len=9 page, and three in a row on chunk_len=128
#   * tower_count consuming 6/6 calls on each of three candidates — 12 of a
#     27-call run — and never being found on any of them
# Roughly a third of all LLM spend, on a free tier that allows ~5 searches a
# day. Two guards, both narrow:
#
# 1. A chunk too small to contain a stated fact is not worth a network call.
#    A page fragment of 9 or 128 characters is a cookie banner or an error
#    stub, not a specification table.
# 2. A FIELD that N consecutive chunks have failed to yield is dropped from
#    the ask — per field, never per page. Chunk 5 may still answer a DIFFERENT
#    field, so the page keeps being read; we just stop paying to re-ask the
#    one question this page has already declined to answer N times.
#
# Both are deliberately conservative: the guards only ever REMOVE calls that
# produced nothing in the observed traces, and chunk 1 of page 1 still behaves
# exactly as it always did.
MIN_CHUNK_CHARS_FOR_LLM = int(os.getenv("AI_SEARCH_MIN_CHUNK_CHARS_FOR_LLM", "200"))
# 3, not 2. Measured on the real traces: a live "Bandra West" candidate did
# eventually yield tower_count on chunk 6, so an aggressive cutoff genuinely
# can lose a late-page field. 3 still removes half the waste of the
# never-answered case while leaving a real page room to answer, and the
# tradeoff is one env var away for anyone who wants to retune it against
# their own numbers.
MAX_EMPTY_CHUNKS_PER_FIELD = int(os.getenv("AI_SEARCH_MAX_EMPTY_CHUNKS_PER_FIELD", "3"))


def _chunk_text(text: str, size: int = _CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP) -> list[str]:
    if len(text) <= size:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + size])
        if start + size >= len(text):
            break
        start += size - overlap
    return chunks


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

    # Phase 2.5b/2.5c — was ONE call, against ONLY pages[0], against ONLY
    # its first 4000 chars, regardless of how many pages were actually
    # fetched (up to MAX_FETCHES_PER_CANDIDATE) or how long each one is (up
    # to 24000 chars, agent-tools-bridge.cjs's FETCH_PAGE_MAX_CHARS). Now
    # walks every fetched page, and within each page every 4000-char
    # window (_chunk_text), stopping the INSTANT every LLM-assistable
    # field is found — chunk 1 of page 1 is identical to the old behavior,
    # so the common case (fields found immediately) costs exactly what it
    # cost before. Bounded overall by MAX_LLM_ASSIST_CALLS_PER_CANDIDATE.
    # Never covers deck/balcony/parking (LLM_ASSISTABLE_FIELDS excludes
    # them) since those are the structured `features` list's job.
    if pages:
        found_fields = {f["field"] for f in facts}
        still_missing = [f for f in fact_extraction.LLM_ASSISTABLE_FIELDS if f not in found_fields]
        calls_made = 0
        skipped_tiny = 0
        # Per-field tally of consecutive chunks that failed to yield it — see
        # the chunking-guards comment above. Reset for a field the moment any
        # chunk does yield it.
        empty_streak: dict[str, int] = {f: 0 for f in still_missing}
        abandoned: list[str] = []
        for page in pages:
            if not still_missing or calls_made >= MAX_LLM_ASSIST_CALLS_PER_CANDIDATE:
                break
            page_text = (page.get("content") or "").strip()
            for chunk in _chunk_text(page_text):
                if not still_missing or calls_made >= MAX_LLM_ASSIST_CALLS_PER_CANDIDATE:
                    break
                # GUARD 1 — a chunk too small to state a fact. Not counted as
                # a call, and not counted against any field's streak: nothing
                # was asked, so nothing was declined.
                if len(chunk) < MIN_CHUNK_CHARS_FOR_LLM:
                    skipped_tiny += 1
                    continue
                calls_made += 1
                # A shallow copy with `content` swapped for this chunk —
                # NOT just {"content", "title"}: llm_assist_extract reads
                # page.get("url")/page.get("retrieved_at") too, for each
                # ExtractedFact's own provenance (source_url/retrieved_at).
                # Dropping those would have silently made every LLM-
                # assisted fact from this loop untraceable back to its
                # real source page.
                chunk_page: FetchedPage = {**page, "content": chunk}
                new_facts = await fact_extraction.llm_assist_extract(name, chunk_page, still_missing)
                found_here = {f["field"] for f in new_facts} if new_facts else set()
                # Reporting-only instrumentation (not a behavior change) —
                # per-call, per-candidate token-cost attribution was asked
                # for explicitly and can't be reconstructed after the fact
                # from llm_providers.py's own per-call logs alone (those
                # don't know which candidate/chunk they were serving).
                logger.warning(
                    "[fetch_and_extract] candidate=%r call=%d/%d chunk_len=%d still_missing_before=%s found=%s",
                    name, calls_made, MAX_LLM_ASSIST_CALLS_PER_CANDIDATE, len(chunk), still_missing, sorted(found_here),
                )
                if new_facts:
                    facts.extend(new_facts)
                    still_missing = [f for f in still_missing if f not in found_here]
                # GUARD 2 — retire a field this page keeps declining to
                # answer. Per FIELD, not per page: the loop carries on
                # reading, it just stops re-asking the same dead question.
                newly_abandoned = []
                for field in list(still_missing):
                    if field in found_here:
                        empty_streak[field] = 0
                        continue
                    empty_streak[field] = empty_streak.get(field, 0) + 1
                    if empty_streak[field] >= MAX_EMPTY_CHUNKS_PER_FIELD:
                        newly_abandoned.append(field)
                if newly_abandoned:
                    still_missing = [f for f in still_missing if f not in newly_abandoned]
                    abandoned.extend(newly_abandoned)
        if calls_made or skipped_tiny:
            logger.warning(
                "[fetch_and_extract] candidate=%r TOTAL calls=%d (skipped %d chunk(s) under %d chars; "
                "stopped asking for %s after %d empty chunk(s)) still_missing_after=%s",
                name, calls_made, skipped_tiny, MIN_CHUNK_CHARS_FOR_LLM,
                sorted(abandoned) or "nothing", MAX_EMPTY_CHUNKS_PER_FIELD,
                sorted(set(still_missing) | set(abandoned)))

    return pages, facts, features, tool_calls


async def research_candidates(
    candidates: list[RankedProperty], *, market: str, already_fetched: set[str],
    max_candidates: int = MAX_CANDIDATES_FOR_DEEP_RESEARCH, max_fetches_per_candidate: int = MAX_FETCHES_PER_CANDIDATE,
    budget_s: Optional[float] = None,
) -> tuple[list[NormalizedProperty], list[ToolCallRecord], list[FetchedPage], list[ExtractedFact]]:
    updated: list[NormalizedProperty] = []
    all_tool_calls: list[ToolCallRecord] = []
    all_pages: list[FetchedPage] = []
    all_facts: list[ExtractedFact] = []

    batch = candidates[:max_candidates]
    if not batch:
        return updated, all_tool_calls, all_pages, all_facts

    # URL planning happens FIRST, serially and with no awaits between the
    # reads and the writes. `already_fetched` is what stops two candidates
    # paying for the same page, and computing every candidate's URL list up
    # front preserves that exactly — interleaving the plan with the fetches
    # would let two candidates each claim the same URL before either recorded
    # it. Nothing here does I/O, so this is cheap.
    planned: list[tuple] = []
    for prop in batch:
        urls = _prioritized_source_urls(prop, max_fetches_per_candidate, already_fetched)
        already_fetched.update(u for u, _ in urls)
        planned.append((prop, urls))

    semaphore = asyncio.Semaphore(max(1, DEEP_RESEARCH_CONCURRENCY))
    # `budget_s` is this pass's share of the RUN's remaining wall clock
    # (graph._budget_for). Without it each pass would spend its own full
    # allowance regardless of how little time the request had left — which is
    # exactly how three 45s passes plus two enrichment nodes came to exceed a
    # 180s request timeout.
    effective_budget = DEEP_RESEARCH_BUDGET_S if budget_s is None else max(0.0, budget_s)
    # time.monotonic(), matching graph.py's run clock exactly — see
    # _remaining_budget's docstring for why not loop.time().
    deadline = time.monotonic() + effective_budget

    async def _research_one(prop: RankedProperty, urls: list) -> tuple:
        """Returns (candidate, tool_calls, pages, facts). Never raises — one
        candidate failing must not lose the whole batch.
        """
        local_calls: list[ToolCallRecord] = []
        local_pages: list[FetchedPage] = []
        local_facts: list[ExtractedFact] = []
        current = prop
        async with semaphore:
            # Checked after acquiring the slot, not before: a candidate that
            # waited out the budget is returned unresearched rather than
            # started and abandoned mid-fetch.
            if time.monotonic() >= deadline:
                return prop, local_calls, local_pages, local_facts
            try:
                if urls:
                    pages, facts, features, tool_calls = await _fetch_and_extract(
                        prop.get("name", ""), urls, candidate_id=prop.get("id"))
                    local_calls.extend(tool_calls)
                    local_pages.extend(pages)
                    local_facts.extend(facts)
                    current = dedupe_mod.merge_extracted_facts(prop, facts, features)

                # Part 2 (Places-augmented pipeline) — per-candidate name
                # verification, on EVERY candidate reaching this bounded loop
                # regardless of source or whether a page was even fetchable (a
                # candidate's name can already be final even with no fetchable
                # URL). Skipped whenever a verification attempt was ALREADY
                # made — `places_verified` already True (discovered by
                # places_search itself, or a prior iteration's lookup resolved
                # it) OR False (a prior iteration already tried and found
                # nothing); `is None` is the only case that still runs it.
                # Without this, a candidate checked in iteration 1 was
                # re-verified every iteration — a real, observed, wasteful
                # duplicate call — burning Places quota for a known result.
                # A candidate that does NOT resolve is NOT itself rejected
                # (see places_verify's own scope comment); only graph.py's
                # hard-eligibility filter's looks_like_invalid_name() check,
                # consulted ONLY when this is False, gates anything.
                if current.get("places_verified") is None:
                    locality = current.get("micro_location") or current.get("location")
                    city = current.get("city")
                    match, verify_record = await tools_mod.places_verify(current.get("name", ""), locality, city)
                    local_calls.append(verify_record)
                    current = dict(current)
                    if match:
                        current["places_verified"] = True
                        current["places_lat"] = match.get("lat")
                        current["places_lon"] = match.get("lon")
                        current["places_place_id"] = match.get("placeId")
                        current["places_address"] = match.get("address")
                    else:
                        current["places_verified"] = False
            except Exception as e:  # noqa: BLE001 — degrade the candidate, never the batch
                logger.warning("[deep_research] %s failed: %s", prop.get("name"), e)
                return prop, local_calls, local_pages, local_facts
        return current, local_calls, local_pages, local_facts

    results = await asyncio.gather(*[_research_one(prop, urls) for prop, urls in planned],
                                   return_exceptions=True)

    researched = 0
    for (prop, _urls), result in zip(planned, results):
        if isinstance(result, Exception):
            logger.warning("[deep_research] %s raised: %s", prop.get("name"), result)
            updated.append(prop)
            continue
        current, calls, pages, facts = result
        # Order is preserved: gather returns results positionally, so the
        # caller's prioritisation (graph._prioritize_for_deep_research) still
        # holds regardless of which candidate happened to finish first.
        updated.append(current)
        all_tool_calls.extend(calls)
        all_pages.extend(pages)
        all_facts.extend(facts)
        if pages or calls:
            researched += 1

    no_source = sum(1 for _p, urls in planned if not urls)
    logger.warning(
        "[deep_research] researched %d/%d candidates (%d had no fetchable source URL) "
        "(cap %d, concurrency %d, budget %.0fs)",
        researched, len(batch), no_source, max_candidates, DEEP_RESEARCH_CONCURRENCY, effective_budget)

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
