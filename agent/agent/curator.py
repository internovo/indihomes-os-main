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
import os
import re
from datetime import datetime, timezone
from typing import Optional

from . import normalize as normalize_mod
from .llm_providers import LLMRouter, get_llm_metrics
from .state import RankedProperty, ResearchState

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


def _project_intelligence_payload(prop: RankedProperty) -> dict:
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
        "competitors": [],
        "summary": prop.get("description") or None,
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


async def curate(state: ResearchState) -> dict:
    ranked = state.get("ranked_properties", [])
    selected = ranked[:MAX_SELECTED]

    project_intelligence = {p["id"]: _project_intelligence_payload(p) for p in selected}
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
            "Respond as strict JSON: "
            '{"summary": str, "key_matches": {"<property_id>": str}, "display_names": {"<property_id>": str}}'
        )
        user = json.dumps({
            "query": state.get("original_query"),
            "requirements": state.get("parsed_requirements"),
            "candidates": [
                {"id": p["id"], "name": p["name"], "configuration": p.get("configuration"),
                 "location": p.get("location"), "price": p.get("price_display"),
                 "possession": p.get("possession_display"),
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
            for p in selected:
                if p["id"] in key_matches:
                    p["key_match"] = key_matches[p["id"]]
                # A presentational relabel only — the real, original scraped
                # name (p["name"]) is untouched and still carried in the
                # response separately, so nothing is silently lost even if
                # the LLM's rewrite is imperfect.
                if p["id"] in display_names and display_names[p["id"]]:
                    p["display_name"] = display_names[p["id"]]
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
