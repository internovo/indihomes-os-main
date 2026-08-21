"""Field-aware research gap analysis (Part 11) — upgrades the old
route_research_gap() from a single whole-result-set yes/no into a per-
candidate, per-field breakdown: which fields are missing outright, which
are present but weak (single low-confidence source), and which have
genuinely conflicting values across sources. This is what drives
targeted_research's SPECIFIC follow-up queries (Part 12) instead of it
just repeating the original generic search.

`important_fields` are query-aware: a field the user didn't ask about
(e.g. RERA, for a query that never mentioned it) still counts toward
"missing" — RERA/possession/price/carpet_area/developer are always worth
knowing for a real candidate regardless of what was asked — but a
REQUESTED amenity (e.g. "deck") is added on top as its own required field,
per Part 32 ("the deck requirement must influence candidate extraction,
research gaps, scoring, and match reasons").
"""
from __future__ import annotations

from .state import CandidateGap, ParsedRequirements, RankedProperty

# Always worth knowing for a real property candidate, independent of what
# the user's query happened to ask about — these are the facts a
# salesperson needs regardless (Part 14's field list, the "always useful"
# subset).
CORE_FIELDS = ["developer", "rera", "possession_display", "carpet_area_display", "price_display"]

# Maps a CORE_FIELDS key to the field_evidence key dedupe.py actually
# tracks (TRACKED_FIELDS in dedupe.py) — used to decide "weak" (single
# low-confidence source) vs "missing" (no evidence entries at all).
# Phase 2 — carpet_area_display maps to "carpet_area", NOT "carpet_area_
# display": dedupe.py's merge_extracted_facts keys field_evidence entries
# by the RAW ExtractedFact.field name ("carpet_area", from
# fact_extraction.py's emit("carpet_area", ...)), never by the top-level
# property key it backfills. carpet_area_sqft was never tracked in
# field_evidence at all (dedupe.py's TRACKED_FIELDS doesn't include it),
# so a "weak" judgment on it was structurally impossible before this fix.
_EVIDENCE_FIELD_MAP = {
    "developer": "developer", "rera": "rera",
    "possession_display": "possession_display", "price_display": "price_display",
    "carpet_area_display": "carpet_area",
}


def _field_present(prop: RankedProperty, field: str) -> bool:
    return bool(prop.get(field))


def _field_is_weak(prop: RankedProperty, field: str) -> bool:
    evidence_key = _EVIDENCE_FIELD_MAP.get(field)
    if not evidence_key:
        return False
    entries = (prop.get("field_evidence") or {}).get(evidence_key) or []
    if not entries:
        return False  # no evidence at all -> that's "missing", not "weak"
    return len(entries) == 1 and entries[0].get("confidence") == "low"


def _field_conflicts(prop: RankedProperty) -> list[str]:
    conflicting = []
    for field, entries in (prop.get("field_evidence") or {}).items():
        values = {str(e["value"]) for e in entries}
        if len(values) > 1:
            conflicting.append(field)
    return conflicting


def compute_gaps(candidates: list[RankedProperty], parsed: ParsedRequirements) -> list[CandidateGap]:
    requested_amenities = parsed.get("amenities") or []
    gaps: list[CandidateGap] = []

    for prop in candidates:
        missing: list[str] = []
        weak: list[str] = []

        # Lifecycle status (Places-augmented pipeline follow-up) — the real
        # gap this closes: a Google Places-sourced candidate (a real,
        # existing building) carries no construction-status language at all
        # (Places doesn't track that), so it starts at UNKNOWN lifecycle and
        # STAYS there forever unless something specifically goes looking for
        # this fact. Every OTHER field check below (developer/rera/
        # possession/carpet/price) already existed, but none of them are a
        # substitute for a query actually aimed at "is this under
        # construction / newly launched / near possession" — confirmed live:
        # a real search returned 20 Places-contributed candidates and
        # rejected every single one as unresolved-lifecycle, because nothing
        # in the targeted-research loop was ever asked to go find that fact
        # specifically. UNKNOWN and READY_TO_MOVE both still need this —
        # READY_TO_MOVE is itself only a possession-year FALLBACK guess
        # (classify_lifecycle_status's own comment) and deserves a real
        # chance to resolve to something more specific too.
        if (prop.get("lifecycle_status") or "UNKNOWN") in ("UNKNOWN", "READY_TO_MOVE"):
            missing.append("lifecycle")

        if not _field_present(prop, "developer"):
            missing.append("developer")
        elif _field_is_weak(prop, "developer"):
            weak.append("developer")

        if not _field_present(prop, "rera"):
            missing.append("rera")

        if not _field_present(prop, "possession_display"):
            missing.append("possession")
        elif _field_is_weak(prop, "possession_display"):
            weak.append("possession")

        if not _field_present(prop, "carpet_area_display"):
            missing.append("carpet_area")
        elif _field_is_weak(prop, "carpet_area_display"):
            weak.append("carpet_area")

        if not (prop.get("price_display") or prop.get("price_max_inr") or prop.get("price_min_inr")):
            missing.append("price")
        elif _field_is_weak(prop, "price_display"):
            weak.append("price")

        # Special-requirement amenities (Part 32) — a REQUESTED amenity not
        # found anywhere in this candidate's evidence/description is a real
        # gap, not just "not applicable"; this is what stops "2 BHK +
        # Liberty Garden" alone from reading as a perfect match when "deck"
        # was never actually confirmed.
        have_amenities = [a.lower() for a in (prop.get("amenities") or [])]
        hay = " ".join(have_amenities) + " " + (prop.get("description") or "").lower()
        for amenity in requested_amenities:
            if amenity.lower() not in hay:
                missing.append(amenity)

        conflicting = _field_conflicts(prop)

        if missing or weak or conflicting:
            gaps.append(CandidateGap(candidate=prop.get("name", ""), missing_fields=missing,
                                      weak_fields=weak, conflicting_fields=conflicting))

    return gaps


# Phase 2.5a — a SEPARATE field set from CORE_FIELDS above, on purpose:
# CORE_FIELDS drives the ELIGIBILITY research loop (route_research_gap) —
# lifecycle/developer/rera/possession/carpet/price, the facts that decide
# whether a candidate is even shown at all. This one drives a DIFFERENT
# question — once a candidate has ALREADY been decided eligible and ranked
# into the top-MAX_SELECTED that will actually be RETURNED, what's still
# missing from what the listing card / Project Intelligence panel actually
# DISPLAY. Real, live-measured reason this needs to be its own list, not a
# superset check on CORE_FIELDS: 4/79 deduplicated candidates had real
# carpet data in one live run; 0/8 displayed did — research budget and
# display selection were choosing different candidates entirely.
# Each entry is (the real NormalizedProperty/RankedProperty key to check
# presence on, the label to emit into CandidateGap.missing_fields — the
# label must be a key `planner.build_field_aware_targeted_queries` can
# turn into an actual search query via _FIELD_QUERY_HINTS, so a check-key
# that differs from its own display-facing name (carpet_area_display ->
# carpet_area) is deliberate, not a typo).
DISPLAY_FIELD_CHECKS = [
    ("developer", "developer"),
    ("carpet_area_display", "carpet_area"),
    ("amenities", "amenities"),
    ("possession_display", "possession"),
    ("connectivity", "connectivity"),
    ("nearby_landmarks", "nearby_landmarks"),
    ("tower_count", "tower_count"),
    ("property_type", "property_type"),
]


def compute_display_gaps(candidates: list[RankedProperty]) -> list[CandidateGap]:
    """Phase 2.5a — same _field_present presence check as compute_gaps
    above, over DISPLAY_FIELD_CHECKS instead of CORE_FIELDS. Deliberately
    ignores weak/conflicting (that distinction exists to drive the
    eligibility-verification loop's re-confirm-vs-fill-gap query choice;
    for display purposes "we have something to show" is the only question
    that matters) and never touches `candidates` beyond reading — the
    caller (graph.py's node_display_enrichment) is responsible for slicing
    to the actual top-MAX_SELECTED before calling this, never the whole
    candidate pool.
    """
    gaps: list[CandidateGap] = []
    for prop in candidates:
        missing = [label for check_key, label in DISPLAY_FIELD_CHECKS if not _field_present(prop, check_key)]
        if missing:
            gaps.append(CandidateGap(candidate=prop.get("name", ""), missing_fields=missing, weak_fields=[], conflicting_fields=[]))
    return gaps
