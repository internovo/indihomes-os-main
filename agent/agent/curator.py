"""Curator node — the ONLY place an LLM is allowed to touch the final
output, and even here it may only select/summarize/explain properties that
already exist with real scores and real sources; it can never invent a
field. If no LLM provider is configured (this deployment's actual state
today), `curate()` still produces the full, correct structured response —
summary text is assembled deterministically instead of LLM-written, and
every property's fields are exactly what the deterministic scorer already
computed. This is Part 28's "LLM unavailable -> source-backed degraded
result", exercised for real, not just planned for.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

from . import dedupe as dedupe_mod
from . import fact_extraction as fact_extraction_mod
from . import normalize as normalize_mod
from .llm_providers import LLMRouter, get_llm_metrics
from .state import RankedProperty, ResearchState

logger = logging.getLogger("ai-search-agent.curator")

MAX_SELECTED = 8


# ── Richer per-property response fields (Part 30) — all additive; every
# existing field above stays exactly as it was (Part 35: backward
# compatible, server.cjs's adaptAgentProperty only needs to ADD reads for
# these, never change existing ones).

def _evidence_list(prop: RankedProperty, limit: int = 20) -> list[dict]:
    """Flattens field_evidence into the compact {field, value, source, url,
    confidence} shape Part 30 asks for — every fact this candidate carries,
    with exactly where it came from (Part 15).
    """
    out = []
    for field, entries in (prop.get("field_evidence") or {}).items():
        for e in entries:
            out.append({
                "field": field, "value": e.get("value"), "source": e.get("source"),
                "url": e.get("source_url"), "confidence": e.get("confidence"),
            })
    return out[:limit]


def _feature_status(prop: RankedProperty, feature_name: str, wanted_configuration: Optional[str] = None) -> Optional[dict]:
    """Reads ONLY the canonical `features` list (Part P0.1/P1.11) — never
    `amenities`/`description` text — to report a unit-vs-project-scope
    status for deck/balcony/parking. Returns None when the feature was
    never mentioned anywhere in evidence (nothing to report either way);
    otherwise a small dict the API/UI can render directly, e.g.
    {"status": "Verified", "scope": "unit", "configuration": "2 BHK"} or
    {"status": "Not verified — project-level only", "scope": "project"}.
    """
    entries = [f for f in (prop.get("features") or []) if f.get("feature") == feature_name]
    if not entries:
        return None
    for f in entries:
        if f.get("scope") != "unit":
            continue
        cfg = f.get("configuration")
        if wanted_configuration is None or cfg is None or cfg.lower() == wanted_configuration.lower():
            return {"status": "Verified", "scope": "unit", "configuration": cfg, "evidence_text": f.get("evidence_text"), "source": f.get("source"), "url": f.get("source_url")}
    # Real evidence exists but never at unit scope (or not for the
    # requested configuration) — Part P1.11's "eco deck on 10th floor must
    # NOT become '2 BHK has a deck'" rule.
    other = entries[0]
    return {"status": f"Not verified for the unit — mentioned at {other.get('scope')} scope only", "scope": other.get("scope"), "configuration": None, "evidence_text": other.get("evidence_text"), "source": other.get("source"), "url": other.get("source_url")}


def _deck_status(prop: RankedProperty, requested_amenities: list[str]) -> Optional[str]:
    """Back-compat string form of _feature_status('deck') for the existing
    `deck` response field — "Verified" / "Not verified" / omitted. See
    _feature_status for the richer structured form (now also exposed as
    `featureEvidence` on the response, Part P1.11).
    """
    requested_configs = None  # curate() passes the richer dict separately; this stays field-generic
    status = _feature_status(prop, "deck", requested_configs)
    if status and status["status"] == "Verified":
        return "Verified"
    if status:
        return "Not verified"
    requested = any(a.lower() == "deck" for a in requested_amenities)
    return "Not verified" if requested else None


def _property_warnings(prop: RankedProperty, verification_by_candidate: dict[str, dict]) -> list[str]:
    warnings = list(prop.get("limitations") or [])
    vr = verification_by_candidate.get(prop.get("name", ""))
    if vr:
        for field, values in (vr.get("conflicts") or {}).items():
            warnings.append(f"Sources disagree on {field}: {', '.join(values)}")
    return warnings


def _research_metrics(state: ResearchState) -> dict:
    """Search-quality metrics (Part 29) — assembled entirely from data
    already in state; never a second source of truth. Lets us tell,
    request over request, whether the deep-research loop is actually
    improving quality (more verified fields, fewer conflicts) rather than
    just running longer.
    """
    tool_calls = state.get("tool_calls", [])
    ranked = state.get("ranked_properties", [])
    gaps = state.get("research_gaps", [])
    metrics = {
        "total_searches": len(tool_calls),
        "successful_searches": len([t for t in tool_calls if t.get("status") == "ok"]),
        "failed_searches": len([t for t in tool_calls if t.get("status") == "error"]),
        "cache_hits": len([t for t in tool_calls if t.get("cache_hit")]),
        "candidate_count": len(ranked),
        "verified_candidate_count": len([p for p in ranked if (p.get("evidence_count") or 0) >= 2]),
        "pages_fetched": len(state.get("fetched_pages", [])),
        "facts_extracted": len(state.get("extracted_facts", [])),
        "research_iterations": state.get("research_iterations", 0),
        "sources_used": sorted(set(tc["tool"] for tc in tool_calls if tc.get("count", 0) > 0)),
        "source_conflicts": len([v for v in state.get("verification_results", []) if v.get("conflicts")]),
        "missing_field_count": sum(len(g.get("missing_fields", [])) for g in gaps),
        "bridge_unavailable": bool(state.get("bridge_unavailable")),
    }
    # Part P0.8 — LLM call budget for THIS run (llm_providers.reset_llm_metrics()
    # is called once, at the very first graph node, so these never carry over
    # from an earlier request).
    metrics.update(get_llm_metrics())
    return metrics


def _retrieval_metrics(state: ResearchState, rejected: list[dict]) -> dict:
    """Part 4 — structured counts so a zero-result search's ROOT CAUSE is
    distinguishable: genuinely no eligible projects vs. sources returned
    only category pages vs. candidates were resale/rental vs. lifecycle
    couldn't be verified vs. an upstream source/API failure (that last
    case shows up as total_candidates itself being unexpectedly low —
    cross-reference against research_metadata.metrics.failed_searches).
    Computed straight from deduplicated_properties' own real fields
    (is_aggregator, lifecycle_status) — never inferred from a rejection
    reason STRING, which would silently break the moment that wording
    changes.
    """
    props = state.get("deduplicated_properties", [])
    total = len(props)
    aggregator = sum(1 for p in props if p.get("is_aggregator"))
    resale = sum(1 for p in props if not p.get("is_aggregator") and p.get("lifecycle_status") == "RESALE")
    rental = sum(1 for p in props if not p.get("is_aggregator") and p.get("lifecycle_status") == "RENTAL")
    eligible = sum(
        1 for p in props
        if not p.get("is_aggregator") and (p.get("lifecycle_status") or "UNKNOWN") in normalize_mod.ALLOWED_LIFECYCLE_STATUSES
    )
    unknown = total - aggregator - resale - rental - eligible
    # Part 2 of the Places-augmented pipeline — counted from the real
    # per-candidate rejection reason, not re-derived from lifecycle status
    # (a name-invalid rejection can happen to an otherwise lifecycle-
    # eligible candidate, so it isn't captured by `unknown` above).
    invalid_name = sum(1 for r in rejected if r.get("reason") == "Could not verify this is a real project name")
    return {
        "total_candidates": total,
        "individual_project_candidates": total - aggregator,
        "aggregator_pages": aggregator,
        "resale_candidates": resale,
        "rental_candidates": rental,
        "unknown_candidates": max(unknown, 0),
        "invalid_name_candidates": invalid_name,
        "eligible_candidates": eligible,
        "rejected_candidates": len(rejected),
        # Places transparency (Part 1/38) — real, regardless of query
        # outcome, never inferred: how many raw candidates this specific
        # run's discovery actually got from places_search, and whether
        # Places is even configured at all (a query with no resolvable
        # location skips places_search entirely per planner.py — that's
        # not "unconfigured", so this is checked independently).
        "places_configured": bool(os.environ.get("GOOGLE_PLACES_API_KEY") or os.environ.get("VITE_GOOGLE_MAPS_KEY")),
        "places_contributed_candidates": sum(1 for e in (state.get("raw_evidence") or []) if e.get("source") == "Google Places"),
    }


def _research_limits() -> dict:
    """Part 45 — the actual bounds this request ran under, read from the
    same env vars graph.py/deep_research.py use (not imported from graph.py
    directly, to avoid a curator<->graph import cycle — graph.py already
    imports curate() from this module)."""
    return {
        "max_research_iterations": int(os.getenv("AI_SEARCH_MAX_RESEARCH_ITERATIONS", "2")),
        "max_candidates_for_deep_research": int(os.getenv("AI_SEARCH_MAX_CANDIDATES_FOR_DEEP_RESEARCH", "3")),
        "max_fetches_per_candidate": int(os.getenv("AI_SEARCH_MAX_FETCHES_PER_CANDIDATE", "3")),
        "max_targeted_searches_per_iteration": int(os.getenv("AI_SEARCH_MAX_TARGETED_SEARCHES_PER_ITERATION", "5")),
    }





# ── STEP 9a — the field ledger ──────────────────────────────────────────────
# The harness's core data structure, built read-only first. For every field
# the product displays it answers three questions: is it filled, WHO filled
# it, and if it is empty, was that because nothing was found or because
# nothing was ever asked.
#
# Deliberately an OBSERVATION over the existing pipeline rather than a rewrite
# of it. The full harness design also has a resolution LOOP that walks this
# ledger and calls the highest-authority untried source per missing field —
# that is a real change to how research is scheduled, and shipping it blind
# is exactly what turned Phase 2.5 into a 481s regression. The ledger is what
# makes that loop measurable first: once we can see "developer: never asked
# of the developer site", the loop has something true to act on.
#
# `field_evidence` (dedupe.py) already records provenance per field; this
# reads it, adds the fields it does not track, and states the gap honestly.

# Display field -> where its value lives on a RankedProperty, and which
# sources in this pipeline can currently supply it at all.
_LEDGER_FIELDS = {
    "rera":             ("rera",                  ["page-text", "json-ld", "portal", "developer-site"]),
    "price":            ("price_display",         ["page-text", "json-ld", "portal", "developer-site"]),
    "carpet_area":      ("carpet_area_display",   ["page-text", "json-ld", "developer-site"]),
    "configuration":    ("configuration",         ["page-text", "portal", "developer-site"]),
    "developer":        ("developer",             ["page-text", "json-ld", "developer-site"]),
    "possession":       ("possession_display",    ["page-text", "portal", "developer-site"]),
    "project_status":   ("project_status",        ["page-text"]),
    "amenities":        ("amenities",             ["page-text", "json-ld", "developer-site"]),
    "property_type":    ("property_type",         ["page-text", "json-ld"]),
    "total_floors":     ("total_floors",          ["page-text", "json-ld"]),
    "tower_count":      ("tower_count",           ["page-text"]),
    "connectivity":     ("connectivity",          ["google-places-nearby", "page-text"]),
    "nearby_landmarks": ("nearby_landmarks",      ["google-places-nearby", "page-text"]),
    "location_score":   ("location_score",        ["google-places-nearby"]),
    "coordinates":      ("places_lat",            ["google-places-verify", "json-ld"]),
}


def _field_ledger(prop: RankedProperty) -> dict:
    """Per-field state for ONE candidate: filled/empty, which source answered,
    how many independent sources agreed, and whether the sources that could
    have answered were actually consulted.
    """
    evidence = prop.get("field_evidence") or {}
    fetched_any = bool(prop.get("sources"))
    ledger = {}
    for field, (attr, possible_sources) in _LEDGER_FIELDS.items():
        value = prop.get(attr)
        filled = bool(value)
        entries = evidence.get(attr) or evidence.get(field) or []
        answered_by = None
        if entries:
            answered_by = entries[0].get("source")
        elif filled and field in ("connectivity", "nearby_landmarks", "location_score"):
            # Filled by node_location_enrichment, which writes onto the
            # property directly rather than through field_evidence.
            answered_by = (prop.get("location_intel") or {}).get("source") or "google-places-nearby"
        ledger[field] = {
            "filled": filled,
            "answered_by": answered_by,
            "corroborating_sources": len({e.get("source") for e in entries if e.get("source")}) or (1 if filled else 0),
            "possible_sources": possible_sources,
            # The distinction the harness exists to make: "we looked and it
            # wasn't there" is a real answer; "we never looked" is a gap in
            # OUR coverage, and the two must never read the same.
            "status": ("filled" if filled
                       else "searched_not_found" if fetched_any
                       else "never_researched"),
        }
    filled_count = sum(1 for v in ledger.values() if v["filled"])
    return {
        "fields": ledger,
        "filled": filled_count,
        "total": len(_LEDGER_FIELDS),
        "never_researched": [f for f, v in ledger.items() if v["status"] == "never_researched"],
    }


# ── STEP 7 — deterministic AI Project Summary fallback ──────────────────────
# Used when no LLM is available (or it returned nothing usable). Says only
# what the extracted fields actually contain, and returns None rather than a
# sentence when there is nothing real to say — the same honest-null rule the
# rest of this pipeline follows.
def _deterministic_project_summary(prop: RankedProperty) -> Optional[str]:
    configs = ", ".join(str(c) for c in (prop.get("configuration") or []))
    location = prop.get("location")
    lifecycle = (prop.get("lifecycle_status") or "").replace("_", " ").lower() or None
    parts: list[str] = []

    name = prop.get("display_name") or prop.get("name") or "This project"
    if configs and location:
        parts.append(f"{name} offers {configs} in {location}.")
    elif location:
        parts.append(f"{name} is located in {location}.")
    elif configs:
        parts.append(f"{name} offers {configs}.")

    status_bits = []
    if lifecycle:
        status_bits.append(f"currently {lifecycle}")
    if prop.get("possession_display"):
        status_bits.append(f"with possession {prop['possession_display']}")
    if prop.get("developer"):
        status_bits.append(f"by {prop['developer']}")
    if status_bits:
        parts.append("It is " + ", ".join(status_bits) + ".")

    if prop.get("price_display"):
        parts.append(f"Priced at {prop['price_display']}.")
    if prop.get("rera"):
        parts.append(f"RERA registered ({prop['rera']}).")

    return " ".join(parts) if parts else None


# ── STEP 6 — Competitor Analysis ────────────────────────────────────────────
# `"competitors": []` was hardcoded. Nothing ever populated it, so the tab was
# permanently empty. Everything needed is already in hand: the OTHER ranked
# candidates from this same query are, by construction, real projects in the
# same locality at a comparable configuration — which is what a competitor is.
#
# Deterministic and evidence-only. A competitor is a real candidate we
# researched in this run, carried with its own price/config/source, never an
# invented name and never a project we cannot cite.
_COMPETITOR_MAX = 4


def _price_band_inr(prop: RankedProperty) -> Optional[tuple]:
    lo, hi = prop.get("price_min_inr"), prop.get("price_max_inr")
    lo = lo if isinstance(lo, (int, float)) else None
    hi = hi if isinstance(hi, (int, float)) else None
    if lo is None and hi is None:
        return None
    return (lo if lo is not None else hi, hi if hi is not None else lo)


def _competitors_for(prop: RankedProperty, peers: list) -> list:
    """Other real candidates from THIS query, ranked by how comparable they
    are: same locality first, then overlapping configuration, then closeness
    of price band. Returns [] rather than reaching for anything invented when
    there is nothing genuinely comparable.
    """
    if not peers:
        return []
    own_id = prop.get("id")
    own_loc = (prop.get("location") or "").strip().lower()
    own_cfg = {str(c).lower() for c in (prop.get("configuration") or [])}
    own_band = _price_band_inr(prop)

    scored = []
    for peer in peers:
        if peer.get("id") == own_id or not peer.get("name"):
            continue
        peer_loc = (peer.get("location") or "").strip().lower()
        peer_cfg = {str(c).lower() for c in (peer.get("configuration") or [])}
        same_locality = bool(own_loc and peer_loc and (own_loc in peer_loc or peer_loc in own_loc))
        shared_cfg = sorted(own_cfg & peer_cfg)
        peer_band = _price_band_inr(peer)
        # Lower sorts first.
        price_gap = float("inf")
        if own_band and peer_band:
            price_gap = abs(((own_band[0] + own_band[1]) / 2) - ((peer_band[0] + peer_band[1]) / 2))
        # Must be comparable on SOMETHING real. Caught in test: a ₹60 L
        # 1 BHK in Thane West was being offered as a competitor to a ₹1.7 Cr
        # 2/3 BHK in Kandivali West, on the basis that both turned up in the
        # same search — which is a fact about our retrieval, not about the
        # market. Fewer, defensible competitors beat a padded list.
        if not same_locality and not shared_cfg:
            continue
        scored.append((0 if same_locality else 1, 0 if shared_cfg else 1, price_gap, peer, shared_cfg, same_locality))

    scored.sort(key=lambda t: (t[0], t[1], t[2]))
    out = []
    for _, _, _, peer, shared_cfg, same_locality in scored[:_COMPETITOR_MAX]:
        basis = []
        if same_locality:
            basis.append("same locality")
        if shared_cfg:
            basis.append(f"also offers {', '.join(shared_cfg).upper()}")
        if peer.get("price_display") and prop.get("price_display"):
            basis.append("comparable price band")
        out.append({
            "name": peer.get("display_name") or peer.get("name"),
            "developer": peer.get("developer"),
            "location": peer.get("location"),
            "configuration": peer.get("configuration") or [],
            "price": peer.get("price_display"),
            "possession": peer.get("possession_display"),
            "rera": peer.get("rera"),
            # Why this is shown as a competitor, in the user's terms — never a
            # bare list the reader has to take on trust.
            "comparison_basis": basis,
            "sources": [s.get("url") for s in (peer.get("sources") or []) if s.get("url")][:2],
        })
    return out


# ── STEP 8 — Target Audience Recommendation ─────────────────────────────────
# Nothing named target_audience existed anywhere in the agent; the tab had no
# data source at all. This is the single easiest field in the product to fill
# with confident nonsense ("ideal for young professionals and growing
# families") that is true of every property ever listed and grounded in
# nothing — output which is WORSE than an empty tab, because one obviously
# generic field teaches the reader that the whole panel is guesswork.
#
# So: derived ONLY from fields we actually hold, every segment carries the
# fields it was derived from, and when the inputs are missing the answer is
# null rather than a plausible sentence.
_CR = 10_000_000


def _target_audience(prop: RankedProperty, location_score: Optional[dict]) -> Optional[dict]:
    configs = [str(c).upper() for c in (prop.get("configuration") or [])]
    band = _price_band_inr(prop)
    possession = prop.get("possession_display")
    lifecycle = prop.get("lifecycle_status")
    components = (location_score or {}).get("components") or {}

    segments: list[dict] = []

    def add(segment: str, because: str, derived_from: list):
        segments.append({"segment": segment, "because": because, "derived_from": derived_from})

    bhk_numbers = sorted({int(c[0]) for c in configs if c and c[0].isdigit()})
    if bhk_numbers:
        smallest = bhk_numbers[0]
        if smallest <= 1:
            add("First-time buyers and single occupants",
                f"smallest configuration offered is {smallest} BHK", ["configuration"])
        elif smallest == 2:
            add("Small families and first-time upgraders",
                "2 BHK is the entry configuration", ["configuration"])
        if max(bhk_numbers) >= 3:
            add("Larger or multi-generational families",
                f"{max(bhk_numbers)} BHK configurations available", ["configuration"])

    if band:
        avg_cr = ((band[0] + band[1]) / 2) / _CR
        if avg_cr >= 5:
            add("Luxury segment buyers", f"price band averages ₹{avg_cr:.1f} Cr", ["price"])
        elif avg_cr >= 2:
            add("Mid-to-premium segment buyers", f"price band averages ₹{avg_cr:.1f} Cr", ["price"])
        else:
            add("Value segment buyers", f"price band averages ₹{avg_cr:.1f} Cr", ["price"])

    # Under-construction inventory suits a buyer who can wait; it does not
    # suit someone who needs to move now. Only stated when we actually know
    # the lifecycle stage.
    if lifecycle in ("NEW_LAUNCH", "PRE_LAUNCH", "UNDER_CONSTRUCTION"):
        add("Investors and buyers with a flexible move-in date",
            f"lifecycle stage is {lifecycle.replace('_', ' ').lower()}"
            + (f", possession {possession}" if possession else ""),
            ["lifecycle_status"] + (["possession"] if possession else []))
    elif lifecycle == "NEAR_POSSESSION":
        add("Buyers needing to move in soon",
            "project is near possession" + (f" ({possession})" if possession else ""),
            ["lifecycle_status"] + (["possession"] if possession else []))

    education = components.get("education") or {}
    transit = components.get("rail_metro") or {}
    if education.get("nearest") and education["nearest"].get("distance_m", 99999) <= 800:
        add("Families with school-age children",
            f"{education['nearest']['name']} is {education['nearest']['distance_m']} m away",
            ["location_score.education"])
    if transit.get("nearest") and transit["nearest"].get("distance_m", 99999) <= 1000:
        add("Daily commuters",
            f"{transit['nearest']['name']} is {transit['nearest']['distance_m']} m away",
            ["location_score.rail_metro"])

    if not segments:
        return None
    return {
        "segments": segments,
        "method": "derived deterministically from this project's own extracted fields — never inferred from general knowledge",
    }


def _project_intelligence_payload(prop: RankedProperty, peers: list | None = None) -> dict:
    """Conforms to the SAME `research` state shape ProjectIntelligence.jsx
    already reads (research?.rera / .configs / .amenities / .usps /
    .competitors / .summary / .possession) — see that component's
    `official`/`live`/`research` resolution chain. Deliberately leaves
    `nearby` unset: Part 17 requires the existing OSM/Overpass map pipeline
    to remain the sole source for Nearby Infrastructure, so this payload
    never supplies (or overrides) that field.
    """
    sources = prop.get("sources", [])
    source_urls = [s["url"] for s in sources if s.get("url")]
    # Part P0.6/P1.9 — a 1 BHK's price/carpet-area must never appear on the
    # 2 BHK row. ONLY use configuration_evidence (real, per-config-tagged
    # facts from fact_extraction.py); the flat property-level carpet_area_
    # sqft/price_display are reused ONLY when this property lists exactly
    # ONE configuration (no ambiguity possible — there's nothing else that
    # flat value could be misattributed to). With 2+ configurations and no
    # config-specific evidence for a given row, that row's price/carpet
    # honestly says "Not verified" rather than reusing the whole
    # property's number.
    config_list = prop.get("configuration") or []
    config_evidence = prop.get("configuration_evidence") or {}
    single_config = len(config_list) == 1
    configs = []
    for c in config_list:
        bucket = config_evidence.get(c) or next((v for k, v in config_evidence.items() if k.lower() == c.lower()), {})
        if bucket.get("carpet_area"):
            carpet = bucket["carpet_area"]
        elif single_config and prop.get("carpet_area_sqft"):
            carpet = f"{prop.get('carpet_area_sqft')} sq ft"
        else:
            carpet = None
        if bucket.get("price"):
            price = bucket["price"]
        elif single_config and prop.get("price_display"):
            price = prop.get("price_display")
        else:
            price = None
        configs.append({"type": c, "carpet": carpet, "total": None, "available": None, "price": price})
    usps: list[dict] = []
    if prop.get("rera"):
        usps.append({"insight": f"RERA registered ({prop['rera']})", "reason": "RERA number found in source evidence", "sources": source_urls[:2]})
    if len(set(s.get("name") for s in sources if s.get("name"))) >= 2:
        usps.append({"insight": "Corroborated across multiple independent sources", "reason": f"{len(sources)} evidence item(s) from independent portals/web sources", "sources": source_urls[:3]})
    for a in (prop.get("amenities") or [])[:3]:
        usps.append({"insight": a.title(), "reason": "Amenity confirmed in source listing text", "sources": source_urls[:1]})

    # RERA conflict (Part P1.10) — if sources disagree, say so rather than
    # silently keeping whichever value happened to land in `rera` first.
    rera_entries = (prop.get("field_evidence") or {}).get("rera") or []
    rera_values = sorted({str(e["value"]) for e in rera_entries if e.get("value")})
    rera_conflict = len(rera_values) > 1

    return {
        "official": None,
        "rera": prop.get("rera"),
        "rera_confidence": 0.6 if prop.get("rera") else 0,
        "rera_conflict": rera_conflict,
        "rera_conflicting_values": rera_values if rera_conflict else [],
        "configs": configs,
        "configuration_evidence": config_evidence,
        "amenities": prop.get("amenities") or [],
        "features": prop.get("features") or [],
        "usps": [u["insight"] for u in usps],  # flat list — matches ProjectIntelligence.jsx's displayUSPs shape
        "usp_evidence": usps,                   # richer form, kept alongside for anything that wants provenance
        # STEP 6 — real competitors from this same search, each carried with
        # its own price/config/source and an explicit comparison_basis. [] when
        # nothing genuinely comparable was found; never an invented name.
        "competitors": _competitors_for(prop, peers or []),
        # STEP 8 — derived only from this project's own extracted fields, each
        # segment carrying what it was derived from. None when the inputs
        # aren't there, rather than a plausible-sounding sentence.
        "target_audience": _target_audience(prop, prop.get("location_score")),
        # STEP 9a — per-field provenance and coverage for this candidate.
        "field_ledger": _field_ledger(prop),
        # Location Score / Nearby Infrastructure tabs. Deterministic, from
        # Google Places around this candidate's real coordinate; every score
        # ships its own component breakdown (nearest place, distance, the
        # thresholds used) so it is defensible to a buyer, not a bare number.
        "location_score": prop.get("location_score"),
        "location_intel": prop.get("location_intel"),
        "connectivity": prop.get("connectivity"),
        "nearby_landmarks": prop.get("nearby_landmarks") or [],
        # STEP 7 — the AI Project Summary. Was `prop["description"]`: RAW
        # SCRAPED PAGE TEXT, which on a 99acres category page describes
        # several projects at once and on the Places-direct path degrades to
        # little more than an address. Now an LLM-written summary grounded
        # strictly in this project's own extracted fields, falling back to a
        # deterministic sentence built from the same fields when no LLM is
        # available — never back to the scraped text. The raw text is still
        # carried, unchanged, under the property's own `description` key.
        "summary": prop.get("project_summary") or _deterministic_project_summary(prop),
        "possession": prop.get("possession_display"),
        "_provider": "ai-search-agent",
        "_note": "Populated from AI Search Agent research evidence — no separate live-web research re-run.",
        "_webSources": source_urls,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


# Part 25 (test query 5, "1BHK rental in Borivali") — this search mode is
# for new residential PROJECTS only; a query that's explicitly asking for a
# rental should say so plainly rather than just returning an unexplained
# empty result (the hard eligibility filter already rejects every RENTAL-
# classified candidate regardless, so a rental-intent query naturally lands
# on the empty-result summary below — this makes that empty result
# self-explanatory instead of looking like the search simply failed).
_RENTAL_INTENT_RE = re.compile(r"\brent(al)?\b|\bto\s+let\b|\blease\b|\bpaying\s*guest\b|\bpg\b", re.IGNORECASE)


def _empty_result_explanation(state: ResearchState) -> str:
    """Part 17 — a genuinely empty (but correctly filtered) result set must
    explain WHY in plain language, not just say "no results" and leave the
    user guessing whether that means "nothing exists" vs. "everything we
    found was disqualified." Built from the SAME real counts debug_trace's
    retrieval_metrics uses — this is the user-facing summary sentence, not
    the full structured breakdown (candidate-level rejection reasons/URLs
    stay debug-only, per Part 4/17).
    """
    m = _retrieval_metrics(state, state.get("debug_rejected_candidates", []))
    if m["total_candidates"] == 0:
        return "No verified new residential projects found — the sources searched returned nothing for this query."
    parts = [f"{m['total_candidates']} candidate{'s' if m['total_candidates'] != 1 else ''} were reviewed."]
    breakdown = []
    if m["aggregator_pages"]:
        breakdown.append(f"{m['aggregator_pages']} were portal category/search-results pages, not individual projects")
    if m["resale_candidates"] or m["rental_candidates"]:
        rr = m["resale_candidates"] + m["rental_candidates"]
        breakdown.append(f"{rr} were resale/rental listings")
    if m["unknown_candidates"]:
        breakdown.append(f"{m['unknown_candidates']} had a lifecycle stage that couldn't be confidently verified")
    if m.get("invalid_name_candidates"):
        breakdown.append(f"{m['invalid_name_candidates']} had a name that could not be verified as a real project")
    if breakdown:
        parts.append(" ".join([", ".join(breakdown[:-1] + [f"and {breakdown[-1]}"]) if len(breakdown) > 1 else breakdown[0]]) + ".")
    else:
        parts.append("None matched the active new-project search policy.")
    # Places transparency (Part 1's explicit requirement) — say plainly
    # that Google Places was ALSO checked (and how many candidates it
    # contributed), rather than leaving that connector's involvement
    # invisible in a zero-result response. Only when actually configured.
    if m.get("places_configured"):
        n = m.get("places_contributed_candidates", 0)
        parts.append(f"Google Places was also checked ({n} additional candidate{'s' if n != 1 else ''} found{', none eligible' if n else ''}).")
    return "No verified new residential projects found. " + " ".join(parts)


def _deterministic_summary(state: ResearchState, selected: list[RankedProperty]) -> str:
    query = state.get("original_query", "")
    if not selected:
        if _RENTAL_INTENT_RE.search(query):
            return ("This search is for new residential projects for sale (under-construction, near-possession, "
                    "or new-launch) — rental listings are not shown here. Try Property Search or a rental-specific "
                    f"listing site for \"{query}\".")
        return _empty_result_explanation(state) + " Try a broader location or fewer requirements."
    primary = [p for p in selected if p["match_tier"] == "PRIMARY"]
    secondary = [p for p in selected if p["match_tier"] == "SECONDARY"]
    bits = [f"Found {len(selected)} candidate propert{'y' if len(selected)==1 else 'ies'} for \"{query}\"."]
    if primary:
        bits.append(f"{len(primary)} strongly match your stated requirements.")
    if secondary:
        bits.append(f"{len(secondary)} are close alternatives with at least one limitation noted below.")
    return " ".join(bits)


def _collapse_duplicate_reras(ranked: list) -> list:
    """Last gate before the response: never show one project twice.

    A bare `ranked[:MAX_SELECTED]` slice let "Gami Avant" and "Gami Avant -
    Vashi" — one project, one RERA (P51700079740) — take two of the eight
    display slots, and did the same for "24K residence Hirani" / "24k
    Residences by Hirani Group" (P51800047979). node_deep_research now
    re-dedupes, which fixes the cause; this is the backstop, because the
    RANKED list is never itself passed through dedupe() at any point.

    First-wins, deliberately: ranking is already final here, so the earlier
    entry is the better-scoring one. Full dedupe() is NOT used — its
    _merge_into picks target vs incoming by first-seen, which would take
    match_score/match_tier/match_reasons from an arbitrary member and
    silently reorder the results the user sees.
    """
    seen: set[str] = set()
    out = []
    for p in ranked:
        rera = p.get("rera")
        if rera and dedupe_mod._looks_like_real_rera(rera):
            key = str(rera).upper()
            if key in seen:
                logger.warning(
                    "[curator] dropped duplicate %r — same RERA %s as a higher-ranked result",
                    p.get("name"), key)
                continue
            seen.add(key)
        out.append(p)
    return out


async def curate(state: ResearchState) -> dict:
    ranked = _collapse_duplicate_reras(state.get("ranked_properties", []))
    selected = ranked[:MAX_SELECTED]

    project_intelligence = {p["id"]: _project_intelligence_payload(p, peers=selected) for p in selected}
    citations = [
        {"name": s.get("name"), "url": s.get("url"), "retrieved_at": s.get("captured_at")}
        for p in selected for s in (p.get("sources") or []) if s.get("url")
    ]
    # De-dupe citations by URL, preserve order.
    seen_urls = set()
    deduped_citations = []
    for c in citations:
        if c["url"] in seen_urls:
            continue
        seen_urls.add(c["url"])
        deduped_citations.append(c)

    router = LLMRouter("reasoning")
    summary: Optional[str] = None
    used_provider: Optional[str] = None
    # `warnings` uses operator.add as its LangGraph reducer — this node must
    # return only the NEW warnings it's adding, never the full accumulated
    # list (that would get concatenated onto itself and duplicate).
    new_warnings: list[str] = []

    if router.is_configured() and selected:
        system = (
            "You are a real-estate research curator. You are given ALREADY-SCORED, "
            "ALREADY-SOURCED property candidates. You must NEVER invent or change any "
            "factual field (price, BHK, possession, RERA, developer, amenities, location). "
            "You may only: pick which of the given candidates to feature, write a short "
            "(2-3 sentence) summary of the result set, write one short 'key_match' "
            "sentence per property explaining why it matches, and write a clean "
            "'display_name' per property. RULES FOR key_match: write ONE genuine, "
            "natural-language sentence grounded ONLY in the match_reasons/fields already "
            "given for that property (e.g. 'This 2 BHK in Malad West is under construction "
            "and within your ₹1.5Cr budget.') — never a fact not present in the data, "
            "never just copying a match_reasons string verbatim without turning it into a "
            "real sentence, and never mentioning a field that's null/missing for this "
            "property. "
            "RULES FOR display_name: many raw titles are generic portal SEO text "
            "('BHK / Bedroom Apartment / Flat for rent in JB Nagar Mumbai for 25000 - "
            "Makaan.com') rather than an actual project/building name \u2014 rewrite these into "
            "a short, plain, factual label built ONLY from the fields already given "
            "(configuration + location + price/possession, e.g. '2 BHK Apartment, JB Nagar "
            "\u2014 \u20b940,000/mo'). If the raw name/title genuinely IS a real, specific project "
            "or building name (not generic portal boilerplate), keep it as-is \u2014 do not "
            "invent a building name that was never given to you, and do not remove a real "
            "one. When unsure whether a name is real, keep it unchanged rather than guess. "
            "RULES FOR project_summary: 2-3 sentences describing THIS project, written "
            "ONLY from the fields given for it — configuration, location, price, possession, "
            "developer, amenities, RERA, lifecycle stage. This replaces raw scraped page text "
            "as the AI Project Summary, so it must never restate marketing copy, never mention "
            "a field that is null for this property, and never add a fact not in the data. If "
            "too little is known to say anything real, return an empty string for that id "
            "rather than padding it. "
            "Respond as strict JSON: "
            '{"summary": str, "key_matches": {"<property_id>": str}, "display_names": {"<property_id>": str}, "project_summaries": {"<property_id>": str}}'
        )
        user = json.dumps({
            "query": state.get("original_query"),
            "requirements": state.get("parsed_requirements"),
            "candidates": [
                {"id": p["id"], "name": p["name"], "configuration": p.get("configuration"),
                 "location": p.get("location"), "price": p.get("price_display"),
                 "possession": p.get("possession_display"),
                 # STEP 7 — the extra grounded fields a project summary is
                 # written FROM. Sent because the summary must come from
                 # facts we extracted, never from raw scraped page text.
                 "developer": p.get("developer"), "rera": p.get("rera"),
                 "lifecycle_status": p.get("lifecycle_status"),
                 "carpet_area": p.get("carpet_area_display"),
                 "amenities": (p.get("amenities") or [])[:8],
                 "match_score": p["match_score"], "match_tier": p["match_tier"],
                 "match_reasons": p["match_reasons"], "limitations": p["limitations"]}
                for p in selected
            ],
        }, default=str)
        result, provider_label = await router.complete_json(system, user, max_tokens=1200)
        if result:
            summary = result.get("summary")
            key_matches = result.get("key_matches") or {}
            display_names = result.get("display_names") or {}
            project_summaries = result.get("project_summaries") or {}
            for p in selected:
                if p["id"] in key_matches:
                    p["key_match"] = key_matches[p["id"]]
                written = (project_summaries.get(p["id"]) or "").strip()
                if written:
                    p["project_summary"] = written
                # A presentational relabel only — the real, original scraped
                # name (p["name"]) is untouched and still carried in the
                # response separately, so nothing is silently lost even if
                # the LLM's rewrite is imperfect.
                #
                # ...except that "carried separately" is not what the user
                # SEES. Node's adaptAgentProperty does
                # `name: p.display_name || p.name` (server.cjs), so an
                # unwanted rewrite becomes the card title and the real name
                # survives only as `rawName`. Live "1bhk in Marol": the
                # candidate the graph researched as "Naman Premier" — an
                # unambiguously real project name — was relabelled
                # "1 BHK Apartment, Marol — ₹2.00 Cr (possession 2025)",
                # which is very nearly the exemplar string in the prompt
                # above. The prompt already says "if the raw name genuinely
                # IS a real project name, keep it as-is", but that is prose:
                # nothing enforced it, and the model reached for the
                # exemplar anyway.
                #
                # So the rewrite is now EARNED, not assumed. The candidate
                # gate (fact_extraction.candidate_name_reject_reason) is the
                # same deterministic test that already decides, everywhere
                # else in this pipeline, whether a string is a real project
                # name or portal SEO furniture. If the raw name passes that
                # gate, it IS a project name and the LLM does not get to
                # replace it. Only names the gate rejects — the genuine
                # "BHK / Flat for rent in JB Nagar Mumbai for 25000 -
                # Makaan.com" case the rewrite exists for — are relabelled.
                proposed = (display_names.get(p["id"]) or "").strip()
                if proposed and proposed != p["name"]:
                    raw_reject_reason = fact_extraction_mod.candidate_name_reject_reason(p["name"])
                    if raw_reject_reason:
                        p["display_name"] = proposed
                        logger.info(
                            "[curator] relabelled %r -> %r (raw name rejected by the candidate gate: %s)",
                            p["name"], proposed, raw_reject_reason)
                    else:
                        # Keep the real name. Not a silent drop: this is the
                        # single most user-visible thing the curator can get
                        # wrong, so it is logged every time it is prevented.
                        logger.warning(
                            "[curator] KEPT real project name %r — ignoring the LLM's proposed relabel %r "
                            "(the raw name passes the candidate gate, so it is not portal boilerplate)",
                            p["name"], proposed)
            used_provider = provider_label
        else:
            new_warnings.append("LLM curator was configured but returned no usable result — used deterministic summary instead.")

    if not summary:
        summary = _deterministic_summary(state, selected)
    for p in selected:
        if "key_match" not in p:
            # No LLM configured (or it returned nothing usable) — same
            # location-preferred, then-configuration, then-first-available
            # priority as scoring.cjs's pickPrimaryMatchReason (Node side),
            # so a candidate without a real key_match still gets the most
            # relevant single reason, not just whichever happened to be
            # first in match_reasons' own (budget-first) internal order.
            reasons = p["match_reasons"] or []
            p["key_match"] = (
                next((r for r in reasons if "location" in r.lower() or "locality" in r.lower() or "located" in r.lower()), None)
                or next((r for r in reasons if "bhk" in r.lower() or "configuration" in r.lower()), None)
                or (reasons[0] if reasons else "Matches your search on available evidence.")
            )

    requested_amenities = (state.get("parsed_requirements") or {}).get("amenities") or []
    verification_by_candidate = {v["candidate"]: v for v in state.get("verification_results", [])}

    final_response = {
        "query": state.get("original_query"),
        "summary": summary,
        # Part 1e — always present (not debug-gated), unlike the richer
        # per-candidate breakdown in debug_trace below. These are aggregate
        # COUNTS ONLY (no candidate names/URLs), safe for the frontend to
        # read directly — this is what lets ProjectSelection.jsx distinguish
        # "no candidates found at all" vs. "candidates found but explicitly
        # disqualified" vs. "candidates found and plausible, but couldn't be
        # verified" instead of collapsing all three into one generic empty
        # state (a false "no ready/near-possession properties exist" claim
        # when verification simply hadn't resolved anything yet).
        "retrieval_metrics": _retrieval_metrics(state, state.get("debug_rejected_candidates", [])),
        "properties": [
            {
                # ── Existing fields — untouched (Part 35 backward compatibility) ──
                "id": p["id"], "name": p["name"], "display_name": p.get("display_name"), "developer": p.get("developer"),
                "location": p.get("location"), "city": p.get("city"), "configuration": p.get("configuration"),
                "price": p.get("price_display"), "carpet_area": p.get("carpet_area_sqft"),
                "possession": p.get("possession_display"),
                "match_score": p["match_score"], "match_tier": p["match_tier"],
                "match_reasons": p["match_reasons"], "key_match": p.get("key_match"),
                "limitations": p["limitations"], "rera": p.get("rera"),
                "sources": p.get("sources"),
                "project_intelligence": project_intelligence[p["id"]],
                # ── New, additive fields (Part 30) — deep-research-only facts
                # stay null/omitted when never fetched/extracted, never guessed.
                "title": p.get("display_name") or p["name"], "projectName": p["name"],
                "propertyType": p.get("property_type"),
                "carpetAreaDisplay": p.get("carpet_area_display"), "builtUpArea": p.get("built_up_area_display"),
                "pricePerSqFt": p.get("price_per_sqft"), "reraNumber": p.get("rera"),
                "projectStatus": p.get("project_status"), "totalFloors": p.get("total_floors"),
                "towerCount": p.get("tower_count"), "connectivity": p.get("connectivity"),
                "nearbyLandmarks": p.get("nearby_landmarks") or [], "amenities": p.get("amenities") or [],
                # Deterministic Google Places location intel (node_location_
                # enrichment). Null when the candidate had no real coordinate
                # — never geocoded from a name, because a wrong coordinate
                # yields a confident wrong score with real place names on it.
                "locationScore": p.get("location_score"), "locationIntel": p.get("location_intel"),
                "deck": _deck_status(p, requested_amenities), "description": p.get("description"),
                "source": (p.get("sources") or [{}])[0].get("name"), "sourceUrl": (p.get("sources") or [{}])[0].get("url"),
                "matchScore": p["match_score"], "matchReasons": p["match_reasons"],
                "warnings": _property_warnings(p, verification_by_candidate),
                "evidence": _evidence_list(p),
                "dataQuality": "high" if (p.get("evidence_count") or 0) >= 3 else "medium" if (p.get("evidence_count") or 0) >= 2 else "low",
                # ── Part P1.3/P1.7/P1.9/P1.11 — the raw structured evidence
                # Project Intelligence needs to build its OWN candidate-
                # specific view without re-deriving anything or re-
                # searching: per-field provenance/conflicts, per-
                # configuration facts, and per-feature scope evidence.
                "field_evidence": p.get("field_evidence") or {},
                "configuration_evidence": p.get("configuration_evidence") or {},
                "featureEvidence": p.get("features") or [],
                "sourceType": "official" if p.get("developer") and any(s.get("source_type") == "official" for s in (p.get("sources") or [])) else "external",
                # Deterministic lifecycle classification (Part 2/22) —
                # already hard-filtered to an eligible stage by the time a
                # property reaches `selected` (see graph.py's
                # _apply_hard_eligibility_filter); surfaced here so the UI
                # can label it and quote the real evidence text it was
                # classified from, never fabricated.
                "lifecycleStatus": p.get("lifecycle_status"),
                "lifecycleEvidence": p.get("lifecycle_evidence_text"),
                # Google Places-derived fields (Part 1/2/38) — real
                # coordinates/place ID Google itself resolved (either this
                # candidate WAS discovered by places_search, or a later
                # places_verify lookup confirmed it) so Project
                # Intelligence's map can use these directly instead of
                # falling back to Nominatim/Google Geocoding string-
                # matching. placesVerified is False (verification
                # attempted, not found) or None (never attempted) for
                # everything else — never a fabricated coordinate.
                "placesVerified": p.get("places_verified"),
                "placesLat": p.get("places_lat"), "placesLon": p.get("places_lon"),
                "placesPlaceId": p.get("places_place_id"), "placesAddress": p.get("places_address"),
            }
            for p in selected
        ],
        "citations": deduped_citations,
        "research_metadata": {
            "sources_used": sorted(set(tc["tool"] for tc in state.get("tool_calls", []) if tc.get("count", 0) > 0)),
            "tool_calls": state.get("tool_calls", []),
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "research_iterations": state.get("research_iterations", 0),
            "llm_curator_used": used_provider,
            # ── New (Part 29/45) — additive keys alongside the ones above.
            "metrics": _research_metrics(state),
            "limits": _research_limits(),
            "research_gaps": state.get("research_gaps", []),
            "verification_results": state.get("verification_results", []),
        },
    }
    # Dev-only debug trace (Part 27) — query -> normalized requirements ->
    # candidates rejected by the hard eligibility filter, with reasons.
    # OFF by default; only attached when AI_SEARCH_DEBUG_TRACE=true is set
    # on the server itself (never a client-supplied flag) — a production
    # deployment that never sets this env var never sends this data over
    # the wire at all, regardless of what the frontend requests.
    if os.environ.get("AI_SEARCH_DEBUG_TRACE") == "true":
        rejected = state.get("debug_rejected_candidates", [])
        final_response["debug_trace"] = {
            "query": state.get("original_query"),
            "normalized_requirements": state.get("parsed_requirements"),
            "candidates_retrieved": len(state.get("deduplicated_properties", [])),
            "candidates_rejected": rejected,
            "candidates_qualified": len(selected),
            "final_order": [p["id"] for p in selected],
            # Same counts already computed onto final_response.retrieval_
            # metrics above (Part 1e) — referenced here, not recomputed, so
            # debug_trace's own copy can't silently drift from what's always
            # shown. Kept as its own key for this block's existing shape.
            "retrieval_metrics": final_response["retrieval_metrics"],
        }

    return {
        "selected_properties": selected,
        "project_intelligence": project_intelligence,
        "citations": deduped_citations,
        "research_summary": summary,
        "final_response": final_response,
        "warnings": new_warnings,
    }
