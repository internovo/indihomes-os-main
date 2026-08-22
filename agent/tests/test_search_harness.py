"""Search-harness regression tests.

Every case here is a bug that actually reached a user in a live run — the
candidate name, developer string, carpet area or locality in each assertion is
real output, not an invented example. Plain asserts, no pytest, exits non-zero
on failure, matching this repo's other test scripts:

    agent/.venv/Scripts/python.exe agent/tests/test_search_harness.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import fact_extraction  # noqa: E402
from agent import graph  # noqa: E402
from agent import gazetteer  # noqa: E402
from agent import dedupe  # noqa: E402
from agent.curator import (  # noqa: E402
    _collapse_duplicate_reras, _competitors_for, _deterministic_project_summary,
    _field_ledger, _target_audience,
)

PASSED = 0
FAILED: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok    {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}{('  -> ' + detail) if detail else ''}")


# ── 1. Candidate-name gate ──────────────────────────────────────────────────
# The candidate list grew 18 -> 26 -> 44 in one live run because every fetched
# page was mined for new candidates and page furniture qualified as a project.
def test_candidate_gate() -> None:
    print("\n[1] candidate-name gate")
    real = [
        "Rock Highland By Origin Corp", "Ruparel Zinnia Borivali", "Krishraj Towers",
        "Utopia Garden Grove Phase 2", "Shreeji Aikyam", "Prapti Apartments Chikoowadi",
        "Balmoral Hall Bandra West", "Two Roses", "Inspira One", "Bhoomi Amogh",
        "Sunteck City - Avenue 2", "Silverbay By Transcon - Bandra West",
        "Kolte Patil Vaayu", "NL Aryavarta", "Vasant Aradhana Tower",
        "Shimpoli Niranjan Co-operative Hsg. Society Ltd.",
    ]
    junk = [
        "Bandra West", "Andheri West",                       # bare locality
        "Chikoowadi Borivali West", "Kandarpada, Dahisar West",  # locality stacks
        "Hill Road", "Linking Road",                          # streets
        "Sea View", "Kids Play Pool With Water", "Swimming Pool",  # amenity chips
        "Download-Icon Rera-Tag No", "Rera-Tag No-Brokerage-Tag", "Instagram",  # page furniture
        "Kandarpada metro station - Wikipedia", "India Real Estate Property Site",
        "Cr Onwards", "Mumbai The",                           # fragments
    ]
    for name in real:
        check(f"keeps {name!r}", fact_extraction.sanitize_candidate_name(name) is not None,
              str(fact_extraction.candidate_name_reject_reason(name)))
    for name in junk:
        check(f"drops {name!r}", fact_extraction.sanitize_candidate_name(name) is None,
              repr(fact_extraction.sanitize_candidate_name(name)))

    # A real project wearing a publisher's tail must be recovered, not dropped.
    check("recovers project from publisher tail",
          fact_extraction.sanitize_candidate_name(
              "Rishab Mahesh Darshan Dahisar West, Mumbai - Ghar.tv") == "Rishab Mahesh Darshan Dahisar West")


# ── 2. Developer extraction ─────────────────────────────────────────────────
# "Cloudflare Privacy" and "Dec" were both shipped as a project's builder.
def test_developer_validation() -> None:
    print("\n[2] developer validation")
    for bad in ["Cloudflare Privacy", "Dec", "Dec 2027", "Privacy Proxy", "Redacted For Privacy",
                "March", "N/A", "2027 2028"]:
        check(f"rejects developer {bad!r}", not fact_extraction._is_valid_developer_name(bad))
    for good in ["Origin Corp", "Rustomjee", "Kolte Patil Developers", "JOY Builders",
                 "Sumit Group", "L&T Realty", "Godrej Properties"]:
        check(f"accepts developer {good!r}", fact_extraction._is_valid_developer_name(good))


# ── 3. Carpet-area parsing ──────────────────────────────────────────────────
# "Carpet: 381 - 1,064 Sq.Ft." produced a carpet area of "064 sq ft".
def test_carpet_area_parsing() -> None:
    print("\n[3] carpet-area parsing")
    carpet, _built = fact_extraction._extract_area_facts("Carpet: 381 - 1,064 Sq.Ft.")
    check("no digits taken from inside '1,064'", carpet != "064 sq ft", repr(carpet))
    carpet, _built = fact_extraction._extract_area_facts("carpet area 758 sq ft")
    check("still reads a plain carpet area", carpet == "758 sq ft", repr(carpet))
    carpet, _built = fact_extraction._extract_area_facts("carpet areas ranging from 533 sq ft to 707 sq ft")
    check("still reads the first of a range", carpet == "533 sq ft", repr(carpet))


# ── 4. Gazetteer ────────────────────────────────────────────────────────────
# "2 BHK in Chikuwadi" returned ZERO results from 64 real candidates because
# the locality was missing, leaving the geography gate one term to match on.
def test_gazetteer() -> None:
    print("\n[4] gazetteer")
    resolved = gazetteer.resolve_location("Chikuwadi")
    check("Chikuwadi resolves to a parent suburb", resolved.get("parent") == "Borivali West", str(resolved))
    check("Chikuwadi resolves to a city", resolved.get("city") == "Mumbai", str(resolved))
    check("Chikoowadi spelling resolves too",
          gazetteer.resolve_location("Chikoowadi").get("parent") == "Borivali West")
    check("Kandarpada still resolves (no regression)",
          gazetteer.resolve_location("Kandarpada").get("parent") == "Borivali West")

    raw = json.loads((Path(__file__).resolve().parent.parent.parent / "shared" / "mmr-gazetteer.json").read_text(encoding="utf-8"))
    known_suburbs = {s for subs in raw["cities"].values() for s in subs}
    # An alias value is a dict, or a LIST of dicts when the same locality name
    # exists in more than one place (see the ambiguity block below).
    def _entries(v):
        return v if isinstance(v, list) else [v]
    orphans = [(k, e["parent"]) for k, v in raw["aliases"].items() for e in _entries(v)
               if e.get("parent") and e["parent"] not in known_suburbs]
    check("every alias parent is a real suburb", not orphans, str(orphans[:5]))

    # ── Ambiguous locality names ───────────────────────────────────────────
    # Live: "2bhk in Samata Nagar" returned ZERO. There is a Samata Nagar in
    # Kandivali East AND one in Thane. The gazetteer claimed only the Mumbai
    # one, so when search surfaced real Thane West projects (TenX Habitat,
    # Dosti Vihar, Tarangan) the geography gate rejected every one of them as
    # wrong-city. Mumbai is full of these — Shanti Nagar, Azad Nagar, Anand
    # Nagar and Tilak Nagar all exist several times over.
    amb = gazetteer.resolve_location("Samata Nagar")
    check("an ambiguous locality keeps its primary answer unchanged",
          amb["parent"] == "Kandivali East" and amb["city"] == "Mumbai", str(amb))
    check("...and carries the other real location as an alternative",
          any(a.get("city") == "Thane" for a in amb.get("alternatives") or []), str(amb))
    check("an unambiguous alias has no alternatives",
          gazetteer.resolve_location("Chikuwadi").get("alternatives") == [])

    amb_state = {"locations": ["Samata Nagar"], "micro_locations": [amb]}
    amb_terms = graph._location_terms(amb_state)
    amb_specific = graph._specific_location_terms(amb_state)
    check("the geography gate widens to BOTH real localities",
          "Kandivali East" in amb_specific and "Thane West" in amb_specific, str(amb_specific))
    check("a Thane West project is accepted for a Samata Nagar query",
          graph._matches_searched_location(
              {"name": "TenX Habitat", "location": "Pokhran Road", "city": "Thane",
               "description": "2 BHK in Thane West"}, amb_terms, amb_specific))
    check("a Kandivali East project is still accepted",
          graph._matches_searched_location(
              {"name": "X", "location": "Samata Nagar", "city": "Mumbai",
               "description": "2 BHK in Kandivali East"}, amb_terms, amb_specific))
    check("ambiguity does NOT open the gate to an unrelated city",
          not graph._matches_searched_location(
              {"name": "Adinath", "location": "Nerul", "city": "Navi Mumbai",
               "description": "2 BHK in Navi Mumbai"}, amb_terms, amb_specific))

    # ── Near-miss spelling correction ──────────────────────────────────────
    # Live: "1bhk in Sampta Nagar" found 64 real candidates and returned
    # ZERO. The gazetteer holds "Samata Nagar" (Kandivali East); the typed
    # spelling was one letter off, so it resolved to itself with no parent
    # and no city, and the geography gate — with nothing to widen by — threw
    # away all 64. Mumbai locality names are transliterations with several
    # accepted spellings each, so this is permanent, not a one-off typo.
    for typed, want in (("Sampta Nagar", "Samata Nagar"), ("Chikuwadii", "Chikuwadi"),
                        ("Kandarpadaa", "Kandarpada"), ("Borivli West", "Borivali West")):
        got = gazetteer.resolve_location(typed)
        check(f"{typed!r} is corrected to {want!r}", got["canonical"] == want, str(got))
        check(f"{typed!r} correction is disclosed, never silent",
              got.get("corrected_from") == typed)
    check("a corrected city-list locality keeps the gazetteer's own casing",
          gazetteer.resolve_location("Borivli West")["canonical"] == "Borivali West")

    # The guard that matters most: a directional suffix is a DIFFERENT PLACE,
    # not a spelling variant. "Malad West"/"Malad East" are 0.8 similar.
    # Silently swapping one for the other is far worse than returning nothing.
    for exact in ("Malad West", "Malad East", "Borivali East", "Andheri West", "Powai", "Nerul"):
        got = gazetteer.resolve_location(exact)
        check(f"{exact!r} is never spelling-corrected into another place",
              got.get("corrected_from") is None, str(got))
    check("gibberish is not corrected into a real locality",
          gazetteer.resolve_location("Zzzzzz Nagar").get("corrected_from") is None)
    check("'Samta Nagar' is a real alternate spelling, resolved outright",
          gazetteer.resolve_location("Samta Nagar").get("corrected_from") is None
          and gazetteer.resolve_location("Samta Nagar")["parent"] == "Kandivali East")


# ── 5. Geography gate ───────────────────────────────────────────────────────
# A Nerul, NAVI MUMBAI project was the top result for a Chikuwadi query: the
# candidate matched on the city term "Mumbai", which "Navi Mumbai" contains.
def test_geography_gate() -> None:
    print("\n[5] geography gate")
    state = {"locations": ["Chikuwadi"],
             "micro_locations": [{"query_term": "Chikuwadi", "canonical": "Chikuwadi",
                                  "parent": "Borivali West", "city": "Mumbai"}]}
    terms = graph._location_terms(state)
    specific = graph._specific_location_terms(state)
    check("city is not a specific term", "Mumbai" not in specific, str(specific))
    check("parent suburb IS a specific term", "Borivali West" in specific, str(specific))

    nerul = {"name": "Adinath Society Sector 20 Nerul", "location": "Nerul",
             "city": "Navi Mumbai", "description": "2 BHK in Navi Mumbai"}
    check("rejects a Navi Mumbai project for a Chikuwadi query",
          not graph._matches_searched_location(nerul, terms, specific))

    borivali = {"name": "Prapti Apartments", "location": "Borivali West",
                "city": "Mumbai", "description": "2 BHK in Chikoowadi, Borivali West"}
    check("accepts a Borivali West project", graph._matches_searched_location(borivali, terms, specific))

    city_query = {"locations": ["Mumbai"], "micro_locations": [{"query_term": "Mumbai", "canonical": "Mumbai"}]}
    check("a city-level query still matches on the city",
          graph._matches_searched_location(nerul, graph._location_terms(city_query),
                                           graph._specific_location_terms(city_query)))


# ── 6. Deep-research prioritisation ─────────────────────────────────────────
# node_deep_research researched ZERO candidates run after run: Places-sourced
# candidates (a maps URL, no readable page) filled every budget slot.
def test_research_prioritisation() -> None:
    print("\n[6] deep-research prioritisation")
    places = [{"name": f"Places-{i}", "lifecycle_status": "UNKNOWN", "match_score": 90,
               "sources": [{"url": "https://www.google.com/maps/place/?q=place_id:X"}]} for i in range(6)]
    real = [{"name": f"Real-{i}", "lifecycle_status": "UNKNOWN", "match_score": 10,
             "sources": [{"url": f"https://www.99acres.com/p{i}"}]} for i in range(3)]
    order = [c["name"] for c in graph._prioritize_for_deep_research(places + real)]
    check("fetchable candidates take the first slots",
          all(n.startswith("Real") for n in order[:3]), str(order[:4]))
    check("unfetchable candidates are kept, not dropped", len(order) == 9, str(len(order)))


# ── 7. Lifecycle policy ─────────────────────────────────────────────────────
# Only new-project inventory may ever be shown.
def test_lifecycle_policy() -> None:
    print("\n[7] lifecycle policy")
    from agent import normalize
    check("allowed set is exactly the new-project stages",
          normalize.ALLOWED_LIFECYCLE_STATUSES == {"UNDER_CONSTRUCTION", "NEAR_POSSESSION", "NEW_LAUNCH", "PRE_LAUNCH"},
          str(normalize.ALLOWED_LIFECYCLE_STATUSES))
    for status in ("RESALE", "RENTAL"):
        accepted, rejected = graph._apply_hard_eligibility_filter(
            [{"id": "x", "name": "Some Tower", "lifecycle_status": status}], final=False)
        check(f"{status} rejected before any research is spent", not accepted and len(rejected) == 1)
    accepted, _rej = graph._apply_hard_eligibility_filter(
        [{"id": "x", "name": "Some Tower", "lifecycle_status": "READY_TO_MOVE"}], final=False)
    check("READY_TO_MOVE deferred on the first pass (page evidence may upgrade it)", len(accepted) == 1)
    _acc, rejected = graph._apply_hard_eligibility_filter(
        [{"id": "x", "name": "Some Tower", "lifecycle_status": "READY_TO_MOVE"}], final=True)
    check("READY_TO_MOVE rejected on the final pass", len(rejected) == 1)


# ── 8. Project Intelligence payload ─────────────────────────────────────────
def test_project_intelligence() -> None:
    print("\n[8] project intelligence")
    subject = {"id": "a", "name": "Rock Highland", "location": "Kandivali West",
               "configuration": ["2 BHK", "3 BHK"], "price_min_inr": 16000000, "price_max_inr": 17800000,
               "price_display": "₹1.6 Cr - ₹1.78 Cr", "possession_display": "Dec 2027",
               "developer": "Origin Corp", "rera": "P51800079751",
               "lifecycle_status": "UNDER_CONSTRUCTION", "carpet_area_display": "758 sq ft",
               "amenities": ["Swimming Pool"], "sources": [{"url": "https://x/1", "name": "99acres"}],
               "field_evidence": {"rera": [{"source": "99acres"}],
                                  "price_display": [{"source": "99acres"}, {"source": "housing"}]},
               "location_score": {"score": 88, "components": {
                   "education": {"nearest": {"name": "Kasturba School", "distance_m": 109}},
                   "rail_metro": {"nearest": {"name": "Borivali", "distance_m": 387}}}}}
    peer = {"id": "b", "name": "Ruparel Zinnia", "location": "Kandivali West",
            "configuration": ["2 BHK"], "price_min_inr": 15000000, "price_max_inr": 15000000,
            "price_display": "₹1.5 Cr", "sources": [{"url": "https://y/2"}]}
    far = {"id": "c", "name": "Far Away Towers", "location": "Thane West",
           "configuration": ["1 BHK"], "price_min_inr": 6000000, "price_max_inr": 6000000,
           "sources": []}

    competitors = _competitors_for(subject, [subject, peer, far])
    check("a comparable peer is offered as a competitor",
          [c["name"] for c in competitors] == ["Ruparel Zinnia"], str([c["name"] for c in competitors]))
    check("every competitor states why it is comparable",
          all(c["comparison_basis"] for c in competitors))
    check("no competitors invented from an empty peer set", _competitors_for(subject, []) == [])

    audience = _target_audience(subject, subject["location_score"])
    check("target audience is produced from real fields", audience is not None)
    check("every audience segment cites what it came from",
          all(s["derived_from"] for s in audience["segments"]))
    check("no audience invented with no inputs", _target_audience({"id": "z"}, None) is None)

    summary = _deterministic_project_summary(subject)
    check("summary states real facts", summary and "Kandivali West" in summary and "Origin Corp" in summary, str(summary))
    check("summary is None when nothing is known",
          _deterministic_project_summary({"id": "z", "name": "X"}) is None)

    ledger = _field_ledger(subject)
    check("ledger reports rera as filled", ledger["fields"]["rera"]["filled"])
    check("ledger names who answered", ledger["fields"]["rera"]["answered_by"] == "99acres")
    check("ledger counts corroborating sources", ledger["fields"]["price"]["corroborating_sources"] == 2)
    check("ledger separates 'searched, not found' from 'never asked'",
          ledger["fields"]["tower_count"]["status"] == "searched_not_found"
          and _field_ledger(far)["fields"]["tower_count"]["status"] == "never_researched")


# ── 9. JSON-LD extraction ───────────────────────────────────────────────────
def test_structured_data() -> None:
    print("\n[9] JSON-LD extraction")
    page = {"url": "https://x/p", "retrieved_at": "t", "metadata": {"source_name": "99acres"},
            "structured_data": [{"@context": "https://schema.org", "@graph": [
                {"@type": "Residence", "name": "Rustomjee Erika",
                 "floorSize": {"@type": "QuantitativeValue", "value": 758, "unitText": "SQFT"},
                 "geo": {"@type": "GeoCoordinates", "latitude": 19.1364, "longitude": 72.8296},
                 "amenityFeature": [
                     {"@type": "LocationFeatureSpecification", "name": "Swimming Pool", "value": True},
                     {"@type": "LocationFeatureSpecification", "name": "Helipad", "value": False}],
                 "brand": {"@type": "Organization", "name": "Rustomjee"}}]}]}
    by_field = {f["field"]: f["value"] for f in fact_extraction.extract_from_structured_data("Rustomjee Erika", page)}
    check("reads carpet area from floorSize", by_field.get("carpet_area") == "758 sq ft", str(by_field.get("carpet_area")))
    check("reads developer from brand", by_field.get("developer") == "Rustomjee")
    check("reads coordinates from geo", by_field.get("latitude") == "19.1364")
    check("an amenity marked value:false is NOT reported as present",
          by_field.get("amenities") == ["Swimming Pool"], str(by_field.get("amenities")))
    for malformed in ([], None, ["a string"], [{"@type": "WebPage"}], [{"@graph": {"@type": "Residence"}}]):
        try:
            fact_extraction.extract_from_structured_data("c", {"structured_data": malformed, "url": "u", "retrieved_at": "t"})
        except Exception as exc:  # noqa: BLE001
            check(f"malformed JSON-LD {malformed!r} does not raise", False, repr(exc))
            break
    else:
        check("malformed JSON-LD never raises", True)


# ── 10. Chunking guards ────────────────────────────────────────────────────
# Chunking was budget-gated, not evidence-gated: live traces show an LLM call
# on a 9-character chunk, and tower_count consuming 6/6 calls on each of three
# candidates without ever being found.
def test_chunking_guards() -> None:
    print("\n[10] chunking guards")
    from agent import deep_research
    check("a chunk too small to state a fact is skipped",
          deep_research.MIN_CHUNK_CHARS_FOR_LLM >= 100, str(deep_research.MIN_CHUNK_CHARS_FOR_LLM))
    check("a field is retired after a few empty chunks, not at the budget cap",
          1 < deep_research.MAX_EMPTY_CHUNKS_PER_FIELD < deep_research.MAX_LLM_ASSIST_CALLS_PER_CANDIDATE,
          f"{deep_research.MAX_EMPTY_CHUNKS_PER_FIELD} vs cap {deep_research.MAX_LLM_ASSIST_CALLS_PER_CANDIDATE}")
    check("the guard still leaves room for a field stated part-way down a page",
          deep_research.MAX_EMPTY_CHUNKS_PER_FIELD >= 3, str(deep_research.MAX_EMPTY_CHUNKS_PER_FIELD))
    # A 9-char page must produce a single chunk that the guard then skips.
    check("a 9-character page yields one chunk, below the guard threshold",
          len(deep_research._chunk_text("x" * 9)) == 1
          and len(deep_research._chunk_text("x" * 9)[0]) < deep_research.MIN_CHUNK_CHARS_FOR_LLM)


# ── 11. Global run budget ──────────────────────────────────────────────────
# The per-node budgets summed to more than any caller would wait:
# deep_research 45s x 3 passes + display_enrichment 90s + location_enrichment
# 20s = 245s of allowance against a 180s request timeout. Every node was
# individually well-behaved; nothing owned the total. A live
# POST /agent/ai-search for "1 BHK in Marol" timed out at 200s.
def test_global_run_budget() -> None:
    print("\n[11] global run budget")
    import time
    from agent import deep_research

    node_sum = (deep_research.DEEP_RESEARCH_BUDGET_S * 3
                + graph.TARGETED_RESEARCH_BUDGET_S * 2
                + graph.DISPLAY_ENRICHMENT_BUDGET_S + graph.LOCATION_ENRICHMENT_BUDGET_S)
    check("the run budget is below the Node-side 180s request timeout",
          graph.TOTAL_BUDGET_S < 180, f"{graph.TOTAL_BUDGET_S}s")
    check("the run budget is the binding constraint, not the sum of node budgets",
          graph.TOTAL_BUDGET_S < node_sum, f"total {graph.TOTAL_BUDGET_S}s vs node sum {node_sum}s")

    def _budget_checks() -> None:
        now = time.monotonic()
        plenty = {"deadline_at": now + 120}
        nearly_out = {"deadline_at": now + 5}
        spent = {"deadline_at": now - 1}
        check("a node keeps its own budget when there is time",
              graph._budget_for(plenty, deep_research.DEEP_RESEARCH_BUDGET_S) == deep_research.DEEP_RESEARCH_BUDGET_S)
        check("a node is clamped to the time actually left",
              graph._budget_for(nearly_out, deep_research.DEEP_RESEARCH_BUDGET_S) <= 5.001)
        check("a spent budget clamps to zero, never negative",
              graph._budget_for(spent, deep_research.DEEP_RESEARCH_BUDGET_S) == 0.0)
        check("no deadline set falls back to the full budget, never unbounded",
              graph._budget_for({}, deep_research.DEEP_RESEARCH_BUDGET_S) == deep_research.DEEP_RESEARCH_BUDGET_S)

        # ── The tail reserve ───────────────────────────────────────────────
        # display_enrichment and location_enrichment fill the visible cards.
        # Live: the eligibility loop spent the whole clock, display waited 0s
        # while logging "timed out after 90s", location got 0s, and the cards
        # read "Price not available" for prices the run had already found.
        some_left = {"deadline_at": now + 70}
        check("a node leaves the reserved slice for the node that runs after it",
              graph._budget_for(some_left, 90, reserve_s=20) <= 50.001)
        check("a reserve larger than the time left yields zero, never negative",
              graph._budget_for({"deadline_at": now + 10}, 90, reserve_s=20) == 0.0)
        check("the tail reserve leaves location_enrichment its full budget plus a real display slice",
              graph.TAIL_RESERVE_S > graph.LOCATION_ENRICHMENT_BUDGET_S + 10,
              f"reserve {graph.TAIL_RESERVE_S}s vs location {graph.LOCATION_ENRICHMENT_BUDGET_S}s")
        check("the tail reserve still leaves the research loop the larger share of the run",
              graph.TAIL_RESERVE_S + graph.CURATION_MARGIN_S < graph.TOTAL_BUDGET_S / 2,
              f"reserve+margin {graph.TAIL_RESERVE_S + graph.CURATION_MARGIN_S}s of {graph.TOTAL_BUDGET_S}s")

        ranked = [{"name": "A", "match_tier": "TERTIARY"}]
        gaps = [{"candidate": "B", "missing_fields": ["rera"]}]
        with_time = {"deadline_at": now + 120, "research_iterations": 0,
                     "ranked_properties": ranked, "research_gaps": gaps}
        out_of_time = {"deadline_at": now + 5, "research_iterations": 0,
                       "ranked_properties": ranked, "research_gaps": gaps}
        # Not "out of time" in any absolute sense — there are still seconds on
        # the clock. They belong to the tail, and the loop may not have them.
        tail_only = {"deadline_at": now + graph.TAIL_RESERVE_S + 5,
                     "research_iterations": 0,
                     "ranked_properties": ranked, "research_gaps": gaps}
        check("the research loop keeps going while there is time",
              graph.route_research_gap(with_time) == "needs_more_research")
        check("the research loop stops when the clock runs out, leaving room to curate",
              graph.route_research_gap(out_of_time) == "sufficient")
        check("the research loop stops once only the tail reserve is left, gaps or no gaps",
              graph.route_research_gap(tail_only) == "sufficient")

    _budget_checks()

    # ── Structural invariant: no unbounded research node ────────────────────
    # node_targeted_research was the last node in the pipeline with NO budget
    # of its own. It ran twice per run between deep_research passes, each
    # firing 5 web + 5 tavily searches plus page fetches, and it ate the run
    # clock: the live trace showed the third deep_research pass getting
    # "budget 0s" and BOTH enrichment nodes clamped to nothing. Rather than
    # naming the four nodes (a list that goes stale the moment a fifth is
    # added), this asserts the RULE: anything in graph.py that awaits
    # research under asyncio.wait_for must take its timeout from a local
    # clamped by _budget_for.
    import ast as _ast
    import inspect as _inspect

    _src = _inspect.getsource(graph)
    _tree = _ast.parse(_src)
    for _fn in _ast.walk(_tree):
        if not isinstance(_fn, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
            continue
        _waits = [n for n in _ast.walk(_fn)
                  if isinstance(n, _ast.Call)
                  and isinstance(n.func, _ast.Attribute) and n.func.attr == "wait_for"]
        if not _waits:
            continue
        _calls_budget_for = any(
            isinstance(n, _ast.Call) and isinstance(n.func, _ast.Name) and n.func.id == "_budget_for"
            for n in _ast.walk(_fn))
        check(f"{_fn.name} clamps its wait to the run clock via _budget_for", _calls_budget_for)
        # Every name assigned anywhere in the function body. The bug this
        # catches for real: display_budget_s was referenced in three places
        # (the timeout, the timeout log, the duration_ms) but a no-op string
        # replacement meant it was never assigned — a NameError waiting for
        # the first run that reached that node with a gap to fill.
        _assigned = {t.id for n in _ast.walk(_fn) if isinstance(n, _ast.Assign)
                     for t in _ast.walk(n) if isinstance(t, _ast.Name) and isinstance(t.ctx, _ast.Store)}
        _assigned |= {a.arg for a in _fn.args.args}
        for _w in _waits:
            for _kw in _w.keywords:
                if _kw.arg == "timeout" and isinstance(_kw.value, _ast.Name):
                    check(f"{_fn.name}: timeout name {_kw.value.id!r} is actually assigned",
                          _kw.value.id in _assigned)

    # The crash this guards: LangGraph runs conditional-edge routers in a
    # worker thread with no event loop. route_research_gap called
    # _remaining_budget there and asyncio.get_event_loop() raised
    # "There is no current event loop in thread 'asyncio_0'", 500-ing the
    # whole request AFTER 6 candidates had already been researched.
    from concurrent.futures import ThreadPoolExecutor
    ranked = [{"name": "A", "match_tier": "TERTIARY"}]
    gaps = [{"candidate": "B", "missing_fields": ["rera"]}]
    state = {"deadline_at": time.monotonic() + 120, "research_iterations": 0,
             "ranked_properties": ranked, "research_gaps": gaps}
    with ThreadPoolExecutor(max_workers=1) as pool:
        try:
            routed = pool.submit(graph.route_research_gap, state).result()
            check("the gap router works from a worker thread with no event loop",
                  routed == "needs_more_research", routed)
        except RuntimeError as exc:
            check("the gap router works from a worker thread with no event loop", False, repr(exc))
        try:
            left = pool.submit(graph._remaining_budget, state).result()
            check("_remaining_budget works from a thread with no event loop", left > 0, str(left))
        except RuntimeError as exc:
            check("_remaining_budget works from a thread with no event loop", False, repr(exc))
    check("deadline_at is a declared state channel (LangGraph drops undeclared keys)",
          "deadline_at" in getattr(__import__("agent.state", fromlist=["ResearchState"]).ResearchState,
                                   "__annotations__", {}))


# ── 12. Location score ──────────────────────────────────────────────────────
# The first scoring model counted places within 2 km and returned 100/100 for
# every dense Mumbai address — a constant, not a score.
def test_location_score_discriminates() -> None:
    print("\n[10] location score")
    node = Path(__file__).resolve().parent.parent.parent / "backend" / "places-client.cjs"
    check("places-client.cjs scores on distance, not count",
          "dimensionPoints" in node.read_text(encoding="utf-8")
          and "full_marks_within_m" in node.read_text(encoding="utf-8"))
    check("rail/metro is its own dimension, separate from buses",
          '"rail_metro"' in node.read_text(encoding="utf-8") or "rail_metro:" in node.read_text(encoding="utf-8"))


# ── 12. What the card actually shows ───────────────────────────────────────
# Three defects that all reached the same live "1bhk in Marol" result card.
# None was a rendering bug; each was a real value being replaced or mangled
# on the way to the screen.
def test_displayed_values() -> None:
    print("\n[12] displayed values")
    from agent.normalize import normalize_configuration

    # (a) The LLM curator rewrote the REAL project name "Naman Premier" into
    # "1 BHK Apartment, Marol — ₹2.00 Cr (possession 2025)" — almost exactly
    # the exemplar string in its own prompt — and server.cjs's
    # `name: p.display_name || p.name` promoted the label over the name.
    # The prompt already said "keep a real name as-is"; nothing enforced it.
    # The candidate gate is now the enforcement.
    for real in ("Naman Premier", "Stay Project", "Sunteck City - Avenue 2",
                 "Naman Premier Marol ANDHERI by Naman Regency Developers"):
        check(f"a real project name is never eligible for LLM relabelling: {real!r}",
              fact_extraction.candidate_name_reject_reason(real) is None)
    for boilerplate in (
        "BHK / Bedroom Apartment / Flat for rent in JB Nagar Mumbai for 25000 - Makaan.com",
        "1 BHK Apartment, Marol — ₹2.00 Cr (possession 2025)",
    ):
        check(f"portal boilerplate stays eligible for relabelling: {boilerplate[:40]!r}...",
              fact_extraction.candidate_name_reject_reason(boilerplate) is not None)

    # (b) The card read "1 BHK & 2 BHK & 1 BHK & 2 BHK". normalize appended
    # the compound "1 BHK & 2 BHK" as ONE element while another page supplied
    # atomic ones; dedupe compares whole strings, so both survived and Node
    # joined the lot.
    check("a compound configuration is split into atomic elements",
          normalize_configuration({"configuration": ["1 BHK & 2 BHK"]}) == ["1 BHK", "2 BHK"])
    check("compound + atomic from different pages dedupe to one set",
          normalize_configuration({"configuration": ["1 BHK & 2 BHK", "1 BHK", "2 BHK"]})
          == ["1 BHK", "2 BHK"])
    check("re.search-singular no longer drops every config after the first",
          "2 BHK" in normalize_configuration({"configuration": ["1 BHK & 2 BHK & 3 BHK"]}))
    check("a non-BHK configuration is still passed through verbatim",
          normalize_configuration({"configuration": ["Studio"]}) == ["Studio"])

    # (c) An Andheri apartment was chipped "Villa": the scan returned on the
    # first bare substring hit and "villa" was first in the table, so one
    # footer link decided the field. There was also no "apartment" entry.
    apartment_page = ("Naman Premier is a premium apartment project in Marol offering 1 and 2 BHK homes. " * 8
                      + " Footer: Villas | Plots | Row Houses")
    check("a footer 'Villas' link no longer outvotes the apartment the page is about",
          fact_extraction._extract_property_type(apartment_page, "Naman Premier") == "Apartment")
    check("a genuine villa page still reads as Villa",
          fact_extraction._extract_property_type(
              "Adarsh Villas offers luxury villas with private gardens. Each villa has a plunge pool. " * 4,
              "Adarsh Villas") == "Villa")
    check("a single stray mention on a long page is not evidence of a type",
          fact_extraction._extract_property_type(
              "Lorem ipsum about the neighbourhood and its history. " * 20 + " Villas nearby.", None) is None)
    check("'apartment' is a producible property type at all",
          any(label == "Apartment" for _, label in fact_extraction._PROPERTY_TYPE_TERMS))
    check("word boundaries are used — 'plot' does not match inside 'plotting'",
          fact_extraction._extract_property_type("plotting the route " * 30, None) is None)
    # Survived the FIRST property_type fix and was caught by the T1-01/T1-10
    # live run, which still chipped "Villa" on "I Stay Tower in Marol": a
    # portal category page renders "Property Type: Apartment | Villa | Plot",
    # every term ties, and breaking the tie toward the more specific type
    # handed the answer to Villa. A tie is the signature of a filter list.
    check("a tied type list (a category page's filter row) states nothing",
          fact_extraction._extract_property_type(
              "Property Type: Apartment | Villa | Plot | Independent House. " * 4, "X") is None)

    # The aggregator title that reached the results twice in the live run.
    # The list already had "new projects" and "projects in" but not
    # "projects by" — a developer's category page listing ALL their projects.
    for junk in ("Under Construction Projects by I STAY HOUSING PRIVATE LIMITED",
                 "Projects by Kanakia Spaces", "Residential Projects by Godrej"):
        check(f"a '<...> Projects by <Developer>' category title is rejected: {junk[:34]!r}",
              fact_extraction.candidate_name_reject_reason(junk) is not None)
    # ...while the SINGULAR phrase stays valid: normalize.NEW_LAUNCH_RE
    # relies on "new project by <Developer>" as a real launch signal.
    check("the singular 'New Project by <Developer>' is still a valid name",
          fact_extraction.candidate_name_reject_reason("New Project by Pastonji Bliss Tower") is None)

    # (d) location was being set to the project's OWN NAME. normalize_location
    # fell back to extract_locations(), whose last-resort tier grabs any
    # Title-Case phrase — correct for a user query, catastrophic for a
    # candidate title, where the only Title-Case text IS the project name.
    # Live, "2 BHK in Andheri West": all 5 results had location == name and
    # city == null.
    from agent.normalize import derive_city, normalize_location
    for name in ("Spenta Anthea", "Transcon Triumph", "Linkbay Residences",
                 "Under Construction Projects by I STAY HOUSING PRIVATE LIMITED"):
        got = normalize_location({"title": name})
        check(f"a project name never becomes its own location: {name[:34]!r}", got is None, str(got))
    # ...while a title that really does name a place still resolves, with a city.
    for title, want_city in (("2 BHK Flats in Liberty Garden, Malad West", "Mumbai"),
                             ("Arkade Eden Malad West", "Mumbai"),
                             ("1 BHK in Marol Andheri East", "Mumbai")):
        loc = normalize_location({"title": title})
        check(f"a real locality in a title still resolves, with a city: {title[:34]!r}",
              bool(loc) and derive_city(loc) == want_city, f"{loc!r} -> {derive_city(loc)!r}")
    check("the JSON-LD locality is mapped to `location`, not a dead key",
          dedupe._EXTRACTED_FIELD_TO_TOP_LEVEL.get("location_from_structured_data") == "location")

    # (e) one project, two display names, one RERA — both took a display slot.
    ranked = [
        {"id": "a", "name": "Gami Avant", "rera": "P51700079740", "match_score": 90},
        {"id": "b", "name": "Gami Avant - Vashi", "rera": "P51700079740", "match_score": 70},
        {"id": "c", "name": "Some Other Project", "rera": "P51800047979", "match_score": 60},
        {"id": "d", "name": "No RERA Project", "rera": None, "match_score": 50},
        {"id": "e", "name": "Also No RERA", "rera": None, "match_score": 40},
    ]
    collapsed = _collapse_duplicate_reras(ranked)
    check("two entries sharing one RERA collapse to one",
          [p["id"] for p in collapsed] == ["a", "c", "d", "e"], str([p["id"] for p in collapsed]))
    check("the HIGHER-ranked member survives (ranking is already final here)",
          collapsed[0]["name"] == "Gami Avant")
    check("candidates without a RERA are never collapsed into each other",
          len([p for p in collapsed if not p.get("rera")]) == 2)

    # (f) 40+ fetches per run were spent on URLs that /fetch-page refuses
    # outright ("Unsupported content-type: application/json" / pdf), each one
    # having already consumed a scarce deep-research slot.
    from agent.deep_research import _is_unfetchable_url
    for url in ("https://x.com/api/projects.json", "https://x.com/brochure.pdf",
                "https://x.com/sitemap.xml", "https://x.com/data.json?cb=1"):
        check(f"a non-HTML URL is skipped before it costs a slot: {url[-28:]!r}", _is_unfetchable_url(url))
    for url in ("https://99acres.com/project-page", "https://developer.com/our-projects/",
                "https://x.com/api/v1/listings?id=3"):
        check(f"a readable page is NOT discarded: {url[-30:]!r}", not _is_unfetchable_url(url))


# ── 13. Dubai market ───────────────────────────────────────────────────────
# A live market='dubai' search returned ZERO properties. Two gates each
# independently caused it: the lifecycle classifier had never heard the word
# "off-plan" (Dubai's standard term for exactly the inventory this pipeline
# is restricted to), and there was no Dubai gazetteer at all, so every
# locality resolved to itself with no parent and no city and the geography
# gate degraded to exact-phrase-only matching.
def test_dubai_market() -> None:
    print("\n[13] dubai market")
    import json as _json
    from agent import gazetteer as gz
    from agent.normalize import ALLOWED_LIFECYCLE_STATUSES, classify_lifecycle_status
    from agent.query_understanding import extract_configuration, parse_query

    def _lifecycle(desc: str) -> str:
        return classify_lifecycle_status({"title": "T", "description": desc})[0]

    # Eligible Dubai inventory must now pass the lifecycle gate.
    for desc in ("Off-plan apartments in Dubai Marina, handover Q4 2027, 60/40 payment plan",
                 "Off plan project, completion December 2027",
                 "Now selling off-plan villas, handover 2028"):
        status = _lifecycle(desc)
        check(f"off-plan is eligible new-project inventory: {desc[:38]!r}",
              status in ALLOWED_LIFECYCLE_STATUSES, status)
    check("'nearing handover' reads as NEAR_POSSESSION",
          _lifecycle("Nearing handover, Q1 2027") == "NEAR_POSSESSION")

    # ...and COMPLETED Dubai inventory must still be excluded. Adding Dubai
    # vocabulary only to the eligible side would have made the lifecycle
    # filter leak instead of merely failing closed — the user's constraint is
    # under-construction / near-possession / new-launch ONLY.
    for desc in ("Ready property, handed over in 2023",
                 "Ready to move studios in Dubai South",
                 "Handover completed, vacant unit"):
        status = _lifecycle(desc)
        check(f"completed Dubai inventory stays excluded: {desc[:34]!r}",
              status not in ALLOWED_LIFECYCLE_STATUSES, status)

    # The union lookup in gazetteer._lookup_order is only safe while the two
    # files share no term. If this fails, a Mumbai query can resolve to a
    # Dubai community — fix the collision, do not delete this check.
    def _terms(market: str) -> set[str]:
        g = gz.load_gazetteer(market)
        out = {k.lower() for k in (g.get("aliases") or {})}
        for locs in (g.get("cities") or {}).values():
            out |= {loc.lower() for loc in locs}
        return out
    collisions = _terms("india") & _terms("dubai")
    check("the india and dubai gazetteers share no term (union lookup stays unambiguous)",
          not collisions, str(sorted(collisions)[:5]))

    # Every alias must point at a real parent/city in its own file — the same
    # integrity rule the Mumbai gazetteer is held to.
    dubai = _json.loads(gz.GAZETTEER_PATHS["dubai"].read_text(encoding="utf-8"))
    localities = {loc for locs in dubai["cities"].values() for loc in locs}
    orphans = [k for k, v in dubai["aliases"].items() if v["parent"] not in localities]
    check("no Dubai alias points at a parent that isn't in the cities list", not orphans, str(orphans[:5]))
    bad_city = [k for k, v in dubai["aliases"].items() if v["city"] not in dubai["cities"]]
    check("no Dubai alias points at an unknown emirate", not bad_city, str(bad_city[:5]))

    # Resolution: a Dubai locality now carries a parent and a city, which is
    # what lets graph.py's geography gate widen beyond the exact typed phrase.
    for term, city in (("Dubai Marina", "Dubai"), ("JVC", "Dubai"), ("Arjan", "Dubai"),
                       ("Business Bay", "Dubai"), ("Al Marjan Island", "Ras Al Khaimah")):
        check(f"{term!r} resolves to a known city", gz.resolve_location(term).get("city") == city)
    check("'JVC' resolves to its full canonical name",
          gz.resolve_location("JVC")["canonical"] == "Jumeirah Village Circle")
    check("India resolution is unchanged by the union",
          gz.resolve_location("Chikuwadi").get("parent") == "Borivali West")

    # Query parsing.
    check("'2BR' is a configuration — the UAE writes bedrooms this way",
          extract_configuration("2BR apartment in JVC") == "2 BHK")
    check("'BR' cannot match inside an ordinary word",
          extract_configuration("brochure available") == "")
    check("an all-caps locality acronym is not title-cased into 'Jvc'",
          parse_query("2BR apartment in JVC", "dubai")["locations"] == ["JVC"])
    check("'handover' ends a locality capture, so 'Arjan handover 2027' is not one place",
          parse_query("villa in Arjan handover 2027", "dubai")["locations"] == ["Arjan"])
    check("'Dubai Marina' is extracted as one gazetteer term",
          parse_query("2bhk in Dubai Marina", "dubai")["locations"] == ["Dubai Marina"])
    check("India query parsing is unchanged",
          parse_query("1bhk in Marol", "india")["locations"] == ["Marol"])


# ── 14. "Why this project was listed" ──────────────────────────────────────
# match_reasons reached the browser and was stored, then collapsed to ONE
# string in four separate places and never rendered. Three places were also
# grepping the sentences to recover which field produced them, which breaks
# silently on any rewording. The reasons now carry their field.
def test_why_listed() -> None:
    print("\n[14] why this project was listed")
    from agent.scoring import score_property

    prop = {
        "id": "x", "name": "Arkade Eden", "location": "Malad West", "city": "Mumbai",
        "configuration": ["1 BHK", "2 BHK"], "possession_year": 2027, "possession_display": "Dec 2027",
        "price_min_inr": 12_000_000, "price_max_inr": 14_000_000, "price_display": "Rs 1.2-1.4 Cr",
        "lifecycle_status": "UNDER_CONSTRUCTION", "lifecycle_evidence_text": "under construction",
        "amenities": ["gymnasium"], "sources": [{"url": "https://a.com"}, {"url": "https://b.com"}],
        "places_verified": True, "evidence_count": 2,
    }
    parsed = {"locations": ["Malad West"], "configurations": ["2 BHK"],
              "possession_year": 2027, "budget_max_cr": 1.5, "amenities": ["gym"]}
    r = score_property(prop, parsed)
    structured = r.get("match_reasons_structured") or []

    check("every scored reason is mirrored, wording untouched",
          [s["reason"] for s in structured if s["field"] != "lifecycle"] == r["match_reasons"])
    check("each reason carries the field that produced it",
          all(s.get("field") for s in structured))
    check("the location reason is tagged 'location', not grepped from the sentence",
          any(s["field"] == "location" and "Malad West" in s["reason"] for s in structured))
    check("full credit is distinguishable from partial",
          {s["credit"] for s in structured} <= {"full", "partial", "none"})
    check("the lifecycle gate appears as a reason — it is why the property qualified",
          any(s["field"] == "lifecycle" for s in structured))

    # A partial match must be VISIBLE. matched_requirements records only
    # >=99% credit, so a parent-locality or over-budget match was invisible
    # to every structured consumer before this.
    partial = dict(prop, location="Malad", city="Mumbai", price_min_inr=16_000_000, price_max_inr=17_000_000)
    rp = score_property(partial, parsed)
    sp = rp.get("match_reasons_structured") or []
    check("a partial-credit reason is still reported, marked partial",
          any(s["credit"] == "partial" for s in sp) or not sp, str([(s["field"], s["credit"]) for s in sp]))
    check("match_reasons itself is unchanged in shape (existing consumers safe)",
          isinstance(r["match_reasons"], list) and all(isinstance(x, str) for x in r["match_reasons"]))


# ── 15. RERA verification is a real check, not a claim ─────────────────────
# The old card showed "(unverified)" beside EVERY real registration number,
# so the warning meant nothing. Verified live before building this: a plain
# GET on MahaRERA's certificate_no search returns the correct record with no
# CAPTCHA. P51800047979 resolves to "JEEVAN SHOBHA CHSL AND BHANSALI CHSL"
# (promoter HIRANI REALTORS LLP) while being marketed as "24k Residences by
# Hirani Group" — a normal Mumbai redevelopment naming difference, NOT a
# fake number, and the code must not treat it as one.
def test_rera_verification_client() -> None:
    print("\n[15] rera verification client")
    import subprocess
    client = Path(__file__).resolve().parent.parent.parent / "backend" / "maharera-client.cjs"
    check("maharera-client.cjs exists", client.exists())
    if not client.exists():
        return
    src = client.read_text(encoding="utf-8")
    check("lookup is by registration number only (enumeration does NOT work over GET)",
          "certificate_no" in src and "project_pincode: ''" in src)
    # Checks for browser CODE, not the word: the module's own header comment
    # explains why it uses no headful Chromium, and a bare substring test
    # fails on that explanation.
    check("no browser, no headful escalation — a plain GET or nothing",
          "require('playwright')" not in src and ".launch(" not in src
          and "fetchRenderedPage" not in src)
    check("an honest identifying User-Agent, not a spoofed browser string",
          "IndiHomes-RERA-Verify" in src)
    check("requests to the register are rate-limited",
          "MIN_GAP_MS" in src)
    check("'could not check' is distinct from 'the register says no'",
          "'unchecked'" in src and "'not_found'" in src)

    node = subprocess.run(
        ["node", "-e", f"""
        const m = require({str(client)!r});
        const html = '<h3># P51700079740</h3><div>Gami Avant</div>'
          + '<div>LAL GEBI INFRA PRIVATE LIMITED</div><div>State</div><div>MAHARASHTRA</div>'
          + '<div>Pincode</div><div>400703</div><div>District</div><div>Thane</div>';
        const ok = m._parseResult(html, 'P51700079740');
        const nf = m._parseResult('<p>No Records Found</p>', 'P51700079740');
        const bad = m._parseResult('<p>P51700079740</p>', 'P51700079740');
        console.log(JSON.stringify({{
          name: ok.project_name, promoter: ok.promoter_name, pincode: ok.pincode, district: ok.district,
          notFound: nf.reason, unparsed: bad.reason,
          shapeOk: m.isMahareraNumber('P51700079740'), shapeBad: m.isMahareraNumber('ABC123'),
          hiraniIsLegit: m.namesCorrespond('24k Residences by Hirani Group','JEEVAN SHOBHA CHSL AND BHANSALI CHSL','HIRANI REALTORS LLP'),
          unrelated: m.namesCorrespond('Lodha Amara','JEEVAN SHOBHA CHSL','HIRANI REALTORS LLP'),
        }}));
        """], capture_output=True, text=True, timeout=30)
    if node.returncode != 0:
        check("the parser runs under node", False, node.stderr[:200])
        return
    d = json.loads(node.stdout.strip())
    check("parses the registered project name off the real page shape", d["name"] == "Gami Avant", str(d))
    check("parses the promoter", d["promoter"] == "LAL GEBI INFRA PRIVATE LIMITED")
    check("parses pincode and district", d["pincode"] == "400703" and d["district"] == "Thane")
    check("'No Records Found' is not_found", d["notFound"] == "not_found")
    check("an unrecognised page shape is 'unparsed', never a guessed name", d["unparsed"] == "unparsed")
    check("only MahaRERA-shaped numbers are looked up", d["shapeOk"] and not d["shapeBad"])
    check("a society-registered redevelopment is NOT called a name mismatch", d["hiraniIsLegit"])
    check("a genuinely unrelated name IS a mismatch", not d["unrelated"])


for fn in (test_candidate_gate, test_developer_validation, test_carpet_area_parsing, test_gazetteer,
           test_geography_gate, test_research_prioritisation, test_lifecycle_policy,
           test_project_intelligence, test_structured_data, test_chunking_guards,
           test_global_run_budget, test_location_score_discriminates, test_displayed_values,
           test_dubai_market, test_why_listed, test_rera_verification_client):
    fn()

print(f"\n{'=' * 62}\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for name in FAILED:
        print(f"  FAILED: {name}")
    sys.exit(1)
print("search harness: all green")
