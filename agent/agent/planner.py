"""Research planner — decides which search tools are worth calling for THIS
query, instead of blindly fanning out to every tool on every request (Part
4's explicit instruction). Deterministic rules, not an LLM call: the
decision only depends on what query_understanding already extracted, which
is exactly the kind of "cheap/deterministic" step Part 22 says shouldn't be
spent on an LLM.
"""
from __future__ import annotations

from .state import CandidateGap, ParsedRequirements


def build_search_plan(parsed: ParsedRequirements, market: str) -> list[str]:
    plan: list[str] = []

    has_location = bool(parsed.get("locations"))

    # tavily_search is the primary AI-native web research tool (Part 29) —
    # included first and unconditionally, same reasoning as web_search/
    # apify_search below: it's cheap to no-op (the bridge returns an empty
    # note when TAVILY_API_KEY isn't set) and has an independent failure
    # mode from Google/Bing/Apify, so it's always worth trying rather than
    # gating it behind a heuristic.
    plan.append("tavily_search")

    # web_search (Google/Bing) and apify_search (an independent web-search
    # backend routed through an Apify actor) are both "general web" tools
    # with different failure modes (Google CSE 403s independently of Apify
    # being fine, as observed live in this deployment) — worth trying both
    # rather than picking one, since either can be the one that actually
    # returns something for a given request.
    plan.append("web_search")
    plan.append("apify_search")

    # Portal scraping (99acres/MagicBricks direct) is comparatively
    # expensive (a real browser launch) and only useful once we can narrow
    # it to a covered city — skip it entirely for a location-less query
    # rather than scraping a broad, unfiltered city dump nobody asked for.
    if has_location:
        plan.append("portal_search")

    # Developer/builder site search is most useful once we already have
    # candidate project names to search for specifically (second-stage,
    # handled by targeted_research) — for the FIRST pass, only worth it when
    # the query already names amenities/specifics that suggest the user has
    # a particular project family in mind (heuristic: amenities present
    # alongside a location — "2 BHK with deck on Liberty Garden" reads like
    # someone who's seen a specific listing, not a generic browse).
    if has_location and parsed.get("amenities"):
        plan.append("developer_search")

    # Lifecycle-biased search variant (follow-up spec Part 9) — the
    # standard discovery searches above all use the user's own query text
    # verbatim, which reads like a generic buyer query ("1 BHK in Charkop
    # Kandivali West") and correspondingly surfaces mostly portal
    # category/browse pages for that phrasing. A second search biased
    # toward the same lifecycle language the eligibility classifier itself
    # looks for ("under construction", "new project", "near possession")
    # surfaces different, more specific pages the plain query alone
    # tends to miss — through the SAME existing tavily_search tool, never
    # a hardcoded project name. Gated on has_location for the same reason
    # portal_search is: an unbounded, location-less version would just be
    # noise. This is a discovery-stage query REWRITE, not an extra
    # enrichment fetch — deep_research's own cap/prioritization (Part 4/19)
    # is what actually bounds page-fetch cost.
    if has_location:
        plan.append("lifecycle_variant_search")

    return plan


def build_targeted_query(property_name: str, location: str | None) -> str:
    """Generic second-stage per-project query — kept as the fallback when a
    candidate has no CandidateGap (nothing specific to chase, but still
    worth one broad follow-up pass).
    """
    parts = [property_name]
    if location:
        parts.append(location)
    parts.append("price configuration possession RERA amenities")
    return " ".join(parts)


# Field -> the search phrase that actually finds it (Part 12). Deliberately
# specific, not "<name> <field>" for every field — "RERA" alone is a much
# better search term than "RERA number", and an amenity gap searches for
# the amenity ALONGSIDE the configuration (a bare "<name> deck" search
# tends to surface unrelated deck/patio furniture listings instead of the
# project itself).
_FIELD_QUERY_HINTS = {
    "developer": "developer builder",
    "rera": "RERA number registration",
    "possession": "possession date",
    "carpet_area": "carpet area sq ft",
    "price": "price per sq ft",
}


def build_field_aware_targeted_queries(gap: CandidateGap, location: str | None, configuration: str | None, market_limit: int = 5) -> list[str]:
    """Turns ONE candidate's CandidateGap into a short list of SPECIFIC
    search queries (Part 12) — one per missing/weak field (using its query
    hint), one per conflicting field (phrased to re-confirm, not just
    re-search), and one per still-unconfirmed requested amenity (phrased
    WITH the configuration so it reads like a real listing search, not a
    generic amenity search). Capped at `market_limit` (MAX_TARGETED_
    SEARCHES_PER_ITERATION, Part 13) — missing fields are prioritized over
    weak/conflicting ones since "we have nothing" beats "we have one
    low-confidence value" as a reason to spend another search.
    """
    name = gap["candidate"]
    loc = f" {location}" if location else ""
    queries: list[str] = []

    known_amenity_gaps = {f for f in gap.get("missing_fields", []) if f not in _FIELD_QUERY_HINTS}
    core_missing = [f for f in gap.get("missing_fields", []) if f in _FIELD_QUERY_HINTS]

    for field in core_missing:
        queries.append(f"{name}{loc} {_FIELD_QUERY_HINTS[field]}")
    for amenity in known_amenity_gaps:
        cfg = f" {configuration}" if configuration else ""
        queries.append(f"{name}{loc}{cfg} {amenity}")
    for field in gap.get("weak_fields", []):
        hint = _FIELD_QUERY_HINTS.get(field)
        if hint:
            queries.append(f"{name}{loc} {hint}")
    for field in gap.get("conflicting_fields", []):
        hint = _FIELD_QUERY_HINTS.get(field, field)
        queries.append(f"{name}{loc} confirm {hint}")

    if not queries:
        queries.append(build_targeted_query(name, location))

    # De-dupe while preserving priority order (missing-fields queries first).
    seen = set()
    deduped = []
    for q in queries:
        if q not in seen:
            seen.add(q)
            deduped.append(q)
    return deduped[:market_limit]


def build_research_plan(parsed: ParsedRequirements, market: str) -> dict:
    """The richer, structured research strategy Part 7 asks for — additive
    alongside build_search_plan()'s tool list (which still drives the
    existing 5-tool fan-out unchanged). Carried in state.research_plan and
    surfaced in research_metadata so a LangSmith trace / API caller can see
    WHAT the planner decided to do, not just which tools it called.
    """
    locations = parsed.get("locations") or []
    configs = parsed.get("configurations") or []
    amenities = parsed.get("amenities") or []
    loc_text = " ".join(locations)
    cfg_text = " & ".join(configs)

    discovery_queries = []
    base = " ".join(x for x in [cfg_text, loc_text] if x)
    if base:
        discovery_queries.append(base)
        if amenities:
            discovery_queries.append(f"{base} {' '.join(amenities)}")

    portal_queries = [f"{base} site:99acres.com", f"{base} site:magicbricks.com"] if (base and locations) else []
    developer_queries = [f"{base} official developer builder site"] if base else []

    return {
        "discovery_queries": discovery_queries or ([parsed.get("keywords", [""])[0]] if parsed.get("keywords") else []),
        "portal_queries": portal_queries,
        "developer_queries": developer_queries,
        "candidate_fields_to_verify": ["developer", "rera", "possession", "carpet_area", "price"] + amenities,
        "candidate_urls_to_fetch": [],  # filled in by deep_research.py once real candidate sources exist
        "missing_information_strategy": (
            "For each promising candidate, fetch its best-ranked source page(s), extract "
            "structured facts, then run field-aware targeted searches for anything still "
            "missing/weak/conflicting — never repeat the original generic query verbatim."
        ),
    }
