"""Deterministic property match scoring — a Python port of scoring.cjs's
just-recalibrated graduated logic (exact/sibling-nearby/none location
credit, whitespace-insensitive configuration matching, small possession-
close partial credit, the "wrong area caps below SECONDARY" rule), plus an
`evidence_quality` dimension standing in for scoring.cjs's IndiHomes-catalog
`completeness` (this is external, multi-source evidence, so "quality" here
means how many independent sources corroborate this property and how fresh
they are — not listing-field completeness against IndiHomes' own schema).

Same weight priorities and same 80/60/40 PRIMARY/SECONDARY/TERTIARY
thresholds as the rest of the app, so a project scored here and a project
scored by scoring.cjs mean the same thing to a salesperson looking at both
screens.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from .gazetteer import base_locality, resolve_location
from .state import NormalizedProperty, ParsedRequirements, RankedProperty

WEIGHTS = {"location": 30, "configuration": 25, "possession": 20, "budget": 15, "amenity": 10, "quality": 10}
NEARBY_LOCATION_CREDIT = 0.35   # same calibration as scoring.cjs — keeps a sibling-locality match below PRIMARY
# Confirmed only at the PARENT locality level when a more specific micro-
# locality was requested (Part 3.6) — real signal (being in the right
# broader area beats a totally unrelated sibling suburb), but deliberately
# weaker than exact_micro_locality; sits between "exact" (1.0) and
# "nearby sibling" (0.35).
PARENT_LOCALITY_CREDIT = 0.6
POSSESSION_CLOSE_CREDIT = 0.05  # same calibration as scoring.cjs


def _score_location(prop: NormalizedProperty, parsed: ParsedRequirements, reasons: list[str], mismatches: list[str]) -> Optional[int]:
    """Locality tiers (Part 3.6) — exact_micro_locality > parent_locality
    > nearby_locality > unknown. The live bug this fixes: a query for
    "Liberty Garden, Malad West" extracts BOTH terms; "Malad West" (Liberty
    Garden's own parent, per the gazetteer) is easy for almost any Malad-
    area candidate to satisfy, and the OLD code let confirming it alone —
    with Liberty Garden itself never independently verified — count as a
    full "Exact location match", because the parent was blindly folded
    into the SAME "exact" candidate set as the micro-locality itself. A
    candidate only genuinely in Malad West (not verifiably in Liberty
    Garden specifically) must score as PARENT-locality evidence, with an
    honest reason, not silently laundered into "exact".
    """
    locations = parsed.get("locations") or []
    if not locations:
        return None
    hay = f"{prop.get('location') or ''} {prop.get('name') or ''}".lower()
    resolved_locations = [(loc, resolve_location(loc)) for loc in locations]

    # A requested term that is ITSELF the parent of another requested
    # micro-alias term (both "Liberty Garden" and "Malad West" extracted
    # from the same query) is excluded from Tier 1's own-canonical check —
    # its presence in evidence is exactly what Tier 2 exists to credit
    # correctly (as parent-locality evidence FOR the micro-term), not as
    # an independent "exact match" in its own right, which would just
    # launder the same weaker signal into full credit via loop order.
    micro_parents = {resolved["parent"].lower() for _, resolved in resolved_locations if resolved.get("is_micro_alias") and resolved.get("parent")}

    # Tier 1 — exact_micro_locality: the term's OWN canonical name (never
    # merely its parent/city) is actually present in the candidate's
    # evidence.
    for loc, resolved in resolved_locations:
        if loc.lower() in micro_parents and not resolved.get("is_micro_alias"):
            continue  # this term IS another requested term's parent — handled by Tier 2, not here
        exact_candidates = {loc.lower(), resolved["canonical"].lower()}
        if any(c and c in hay for c in exact_candidates):
            reasons.append(f"Exact location match: {loc}")
            return WEIGHTS["location"]

    # Tier 2 — parent_locality: a requested term is a micro-alias and its
    # PARENT is confirmed, but the micro-locality itself never
    # independently is. Real, useful signal — explicitly weaker than
    # confirming the exact spot requested, never silently counted as exact.
    for loc, resolved in resolved_locations:
        if resolved.get("is_micro_alias") and resolved.get("parent"):
            parent = resolved["parent"].lower()
            if parent in hay:
                reasons.append(f"Located in {resolved['parent']}; {loc} not independently verified")
                return round(WEIGHTS["location"] * PARENT_LOCALITY_CREDIT)

    # Tier 3 — nearby_locality: same directional-suffix family (requested
    # Borivali East, only Borivali West confirmed).
    for loc, _ in resolved_locations:
        base = base_locality(loc)
        if base and len(base) > 2 and base != loc.lower() and base in hay:
            reasons.append(f"Nearby locality ({loc} area) — not the exact requested locality")
            return round(WEIGHTS["location"] * NEARBY_LOCATION_CREDIT)

    # Tier 4 — unknown/no match.
    mismatches.append("Location does not match your requested area")
    return 0


def _score_configuration(prop: NormalizedProperty, parsed: ParsedRequirements, reasons: list[str], mismatches: list[str]) -> Optional[int]:
    wanted = parsed.get("configurations") or []
    if not wanted:
        return None
    hay = re.sub(r"\s+", "", " ".join(prop.get("configuration") or []).lower())
    for w in wanted:
        if re.sub(r"\s+", "", w.lower()) in hay:
            reasons.append(f"{w} available")
            return WEIGHTS["configuration"]
    mismatches.append("Requested configuration not listed")
    return 0


def _score_possession(prop: NormalizedProperty, parsed: ParsedRequirements, reasons: list[str], mismatches: list[str]) -> Optional[int]:
    target_year = parsed.get("possession_year_max")
    if target_year is None:
        return None
    py = prop.get("possession_year")
    label = prop.get("possession_display") or py
    if py is None:
        mismatches.append("Possession date not published")
        return 0
    if py <= target_year:
        reasons.append(f"Possession {label} is within your requested window")
        return WEIGHTS["possession"]
    if py - target_year <= 1:
        reasons.append(f"Possession {label} is outside your preferred {target_year} window (close)")
        return round(WEIGHTS["possession"] * POSSESSION_CLOSE_CREDIT)
    mismatches.append(f"Possession {label} is well outside your requested window")
    return 0


def _score_budget(prop: NormalizedProperty, parsed: ParsedRequirements, reasons: list[str], mismatches: list[str]) -> Optional[int]:
    cr = parsed.get("budget_max_cr")
    if cr is None:
        return None
    budget_max_inr = cr * 1e7
    price = prop.get("price_max_inr") or prop.get("price_min_inr")
    if price is None:
        mismatches.append("Price not published")
        return 0
    if price <= budget_max_inr:
        reasons.append(f"Within your ₹{cr}Cr budget")
        return WEIGHTS["budget"]
    over_pct = (price - budget_max_inr) / budget_max_inr
    if over_pct <= 0.15:
        reasons.append("Slightly above your budget")
        return round(WEIGHTS["budget"] * 0.4)
    mismatches.append("Above your budget")
    return 0


# Scope-sensitive unit features (Part P0.1/P0.2) — for these, and ONLY
# these, the scorer reads the canonical `features` list exclusively. It
# never falls back to substring-matching `description`/`amenities` for
# them, at any point, under any condition — that fallback is exactly what
# let a project-level "eco deck on the 10th floor" satisfy "2 BHK with
# deck" in the reported live bug. Generic amenities (pool/gym/clubhouse/
# garden/...) are NOT scope-sensitive in the same way and keep the
# existing (unaffected, never the reported bug) description/amenities
# text check below.
SCOPE_SENSITIVE_FEATURES = {"deck", "balcony", "parking"}


def _feature_satisfied(prop: NormalizedProperty, feature_name: str, wanted_configuration: Optional[str]) -> tuple[bool, Optional[dict]]:
    """Consults ONLY prop['features'] (fact_extraction.py's canonical,
    scope-classified evidence) — never text. Satisfied only when a
    unit-scoped mention exists AND either no specific configuration was
    requested, the mention itself isn't tied to a specific configuration,
    or the mention's configuration matches the requested one (Part P0.9's
    "3 BHK deck when query asks 2 BHK" must NOT satisfy — a configuration-
    tagged mention for a DIFFERENT configuration is excluded here).
    """
    for f in (prop.get("features") or []):
        if f.get("feature") != feature_name or f.get("scope") != "unit":
            continue
        cfg = f.get("configuration")
        if wanted_configuration is None or cfg is None or cfg.lower() == wanted_configuration.lower():
            return True, f
    return False, None


def _score_amenities(prop: NormalizedProperty, parsed: ParsedRequirements, reasons: list[str], mismatches: list[str]) -> Optional[int]:
    """A requested special requirement (e.g. "deck") must be an explicit,
    per-amenity VERIFIED/not-verified signal, not a generic "some amenities
    didn't match" sentence — "2 BHK in Liberty Garden" must never read as a
    perfect match for a "2 BHK with deck" query just because BHK+locality
    both matched. Every unmatched requested amenity is named individually
    ("deck: not verified"), both in `reasons`' sibling `mismatches` list
    AND (see gap_checker.py) as its own research gap.
    """
    wanted = parsed.get("amenities") or []
    if not wanted:
        return None
    wanted_configs = parsed.get("configurations") or []
    wanted_configuration = wanted_configs[0] if wanted_configs else None

    scope_sensitive_wanted = [w for w in wanted if w.lower() in SCOPE_SENSITIVE_FEATURES]
    generic_wanted = [w for w in wanted if w.lower() not in SCOPE_SENSITIVE_FEATURES]
    matched: list[str] = []
    unmatched: list[str] = []

    for w in scope_sensitive_wanted:
        ok, evidence = _feature_satisfied(prop, w.lower(), wanted_configuration)
        if ok:
            matched.append(w)
            cfg_note = f" for {evidence['configuration']}" if evidence and evidence.get("configuration") else ""
            reasons.append(f"{w} confirmed at unit scope{cfg_note}")
        else:
            unmatched.append(w)
            other_scope = next((f["scope"] for f in (prop.get("features") or []) if f.get("feature") == w.lower()), None)
            if other_scope:
                mismatches.append(f"{w}: mentioned at {other_scope} scope — not confirmed for the unit itself")
            else:
                mismatches.append(f"{w}: not verified")

    if generic_wanted:
        have = [a.lower() for a in (prop.get("amenities") or [])]
        hay = " ".join(have) + " " + (prop.get("description") or "").lower()
        for w in generic_wanted:
            if w.lower() in hay:
                matched.append(w)
                reasons.append(f"{w} confirmed")
            else:
                unmatched.append(w)
                mismatches.append(f"{w}: not verified")

    if not matched and not (prop.get("amenities") or prop.get("description") or prop.get("features")):
        return None  # genuinely no amenity/feature data at all — not applicable, not a fabricated 0
    return round(WEIGHTS["amenity"] * (len(matched) / len(wanted)))


def _score_evidence_quality(prop: NormalizedProperty, reasons: list[str], mismatches: list[str]) -> int:
    if prop.get("is_aggregator"):
        # A portal category/search-results page ("2 BHK Flats for Sale in
        # X"), not an individual project — same signal scoring.cjs already
        # penalizes for AI Search's external results (real bug found there:
        # aggregator pages tied with genuine listings on an identical
        # score purely by mentioning the locality). Flagged as a
        # limitation, not silently dropped, so the curator/UI can explain
        # why this result is weaker even if the location/config numbers
        # look fine on their own.
        mismatches.append("Reads like a portal category/search page, not a specific project listing")
        return 0
    source_count = len(set(s.get("name") for s in (prop.get("sources") or []) if s.get("name")))
    pts = 0.0
    if source_count >= 2:
        pts += 0.5
        reasons.append(f"Corroborated by {source_count} independent sources")
    elif source_count == 1:
        pts += 0.25
    if prop.get("rera"):
        pts += 0.25
    # Part 2 of the Places-augmented pipeline — a real Google Places match
    # is a genuine, independent corroborating signal (an external, Google-
    # verified building actually exists at this name/locality), folded in
    # here as a small AUGMENTING bonus alongside the existing source-count/
    # RERA/freshness signals — never a replacement for them, never a hard
    # requirement (see places_verify's own scope comment: a genuine
    # pre-launch project absent from Places must never be penalized for
    # that absence — `places_verified is False` adds nothing here, same as
    # `None`/never-attempted).
    if prop.get("places_verified") is True:
        pts += 0.25
        reasons.append("Verified via Google Places")
    freshest = None
    for s in (prop.get("sources") or []):
        ts = s.get("captured_at")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        except ValueError:
            continue
        if freshest is None or dt > freshest:
            freshest = dt
    if freshest:
        age_days = (datetime.now(timezone.utc) - freshest).days
        if age_days <= 7:
            pts += 0.25
        elif age_days <= 30:
            pts += 0.1
    return round(WEIGHTS["quality"] * min(1.0, pts))


def score_property(prop: NormalizedProperty, parsed: ParsedRequirements) -> RankedProperty:
    reasons: list[str] = []
    mismatches: list[str] = []
    matched_requirements: list[str] = []

    location_pts = _score_location(prop, parsed, reasons, mismatches)
    config_pts = _score_configuration(prop, parsed, reasons, mismatches)
    possession_pts = _score_possession(prop, parsed, reasons, mismatches)
    budget_pts = _score_budget(prop, parsed, reasons, mismatches)
    amenity_pts = _score_amenities(prop, parsed, reasons, mismatches)

    parts = [
        ("location", location_pts), ("configuration", config_pts), ("possession", possession_pts),
        ("budget", budget_pts), ("amenity", amenity_pts),
    ]
    applicable = sum(WEIGHTS[k] for k, v in parts if v is not None)
    earned = sum(v for _, v in parts if v is not None)
    for k, v in parts:
        if v is not None and v >= WEIGHTS[k] * 0.99:
            matched_requirements.append(k)

    quality_reasons: list[str] = []
    quality_mismatches: list[str] = []
    quality_pts = _score_evidence_quality(prop, quality_reasons, quality_mismatches)
    mismatches = mismatches + quality_mismatches

    if applicable == 0:
        score = round((quality_pts / WEIGHTS["quality"]) * 100)
    else:
        score = round(((earned + quality_pts) / (applicable + WEIGHTS["quality"])) * 100)

    # Same rule as scoring.cjs: an explicitly requested location this
    # property has zero relation to caps the score below SECONDARY,
    # regardless of how well everything else lines up.
    if parsed.get("locations") and location_pts == 0:
        score = min(score, 55)
    # A category/aggregator page can legitimately mention the right
    # locality/BHK in its title (that's WHY it ranked in a text search) but
    # it isn't a specific property — capped the same way a wrong-location
    # result is, so it can never outrank a genuine listing regardless of
    # keyword overlap.
    if prop.get("is_aggregator"):
        score = min(score, 55)
    score = max(0, min(100, score))

    tier = "PRIMARY" if score >= 80 else "SECONDARY" if score >= 60 else "TERTIARY"

    ranked: RankedProperty = dict(prop)  # type: ignore[assignment]
    ranked["match_score"] = score
    ranked["match_tier"] = tier
    ranked["match_reasons"] = reasons + quality_reasons
    ranked["mismatches"] = mismatches
    ranked["matched_requirements"] = matched_requirements
    ranked["limitations"] = mismatches  # same list, distinct field name for the curator/API contract
    return ranked


def score_all(properties: list[NormalizedProperty], parsed: ParsedRequirements) -> list[RankedProperty]:
    ranked = [score_property(p, parsed) for p in properties]
    # Deterministic ranking (Part 8/11): match_score first, then a stable
    # tie-breaker on the candidate's own canonical id/name — without this,
    # two candidates tied on score keep whatever relative order they
    # happened to arrive in from raw_evidence, which is a LangGraph
    # parallel-fan-out reducer (operator.add) and can differ run-to-run
    # depending on which search tool's coroutine finished first. Sorting by
    # (-score, id) makes the SAME query + SAME candidate dataset always
    # produce the SAME order, regardless of arrival order upstream.
    ranked.sort(key=lambda p: (-p["match_score"], str(p.get("id") or p.get("name") or "")))
    return ranked
