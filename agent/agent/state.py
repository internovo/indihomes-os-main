"""LangGraph state schema for the AI Search research agent.

Design notes:
- TypedDict (not a Pydantic BaseModel) because LangGraph's StateGraph reads/
  writes plain dict-like state natively; TypedDict gives us static typing
  without any runtime validation overhead on every node transition.
- Fields written by more than one node running in parallel (parallel_search's
  fan-out branches all append to `raw_evidence`/`tool_calls`) use
  `Annotated[..., operator.add]` so LangGraph *merges* concurrent branch
  updates by concatenation instead of the default "last write wins" (which
  would silently drop every branch's evidence except whichever happened to
  finish last).
- Deliberately NOT storing raw HTML/screenshots here (per the brief) — tools
  only ever produce already-extracted EvidenceItem dicts. If a tool scrapes a
  page, the raw markup is discarded the moment structured fields are pulled
  out of it; only `raw_text` (a short excerpt, not the full page) survives
  into state, for the curator to quote if useful.
"""
from __future__ import annotations

import operator
from typing import Annotated, Literal, Optional, TypedDict


class ParsedRequirements(TypedDict, total=False):
    locations: list[str]          # e.g. ["Liberty Garden", "Malad West"]
    configurations: list[str]     # e.g. ["2 BHK"]
    budget_max_cr: Optional[float]
    possession_text: Optional[str]      # raw extracted phrase, e.g. "by 2027"
    possession_year_max: Optional[int]
    amenities: list[str]          # e.g. ["private deck"]
    keywords: list[str]           # leftover free-text signal, not a hard filter
    market: str                   # 'india' | 'dubai'


class ResolvedLocation(TypedDict):
    query_term: str
    canonical: str
    parent: Optional[str]
    city: Optional[str]
    is_micro_alias: bool


class EvidenceItem(TypedDict, total=False):
    source: str                # connector id, e.g. "99acres", "google-cse"
    source_url: str
    # "category_page_extract" — a sub-listing pulled out of a rejected
    # category/search-results page's own body text (see fact_extraction.
    # extract_sub_listings), not a page fetched/scraped directly for this
    # specific project. Lower source-priority than a direct portal listing
    # (deep_research.py's _SOURCE_PRIORITY) since it's extracted from prose,
    # not structured listing fields — but still real, evidenced, and never
    # fabricated (only ever created when a genuine RERA number anchors it).
    source_type: Literal["portal", "developer", "web", "official", "category_page_extract"]
    title: str
    property_name: str
    developer: Optional[str]
    location: Optional[str]
    configuration: list[str]
    price: dict                 # {min_inr: int|None, max_inr: int|None, display: str|None}
    carpet_area: dict           # {value_sqft: float|None, display: str|None}
    possession: Optional[str]
    rera: Optional[str]
    amenities: list[str]
    description: Optional[str]
    raw_text: Optional[str]     # short excerpt only, never a full page
    captured_at: str            # ISO timestamp
    confidence: Literal["high", "medium", "low"]


class ToolCallRecord(TypedDict, total=False):
    tool: str
    args: dict
    status: Literal["ok", "error", "skipped"]
    count: int
    duration_ms: int
    error: Optional[str]
    cache_hit: bool


class FetchedPage(TypedDict, total=False):
    """One fetch_page() result (Part 4/5) — already-extracted text, never
    raw HTML surviving into graph state (see module docstring below)."""
    url: str
    candidate: Optional[str]        # which candidate this fetch was for, if any (None for a discovery-stage fetch)
    title: Optional[str]
    content: Optional[str]          # short extracted excerpt, already capped by the bridge
    metadata: dict
    structured_data: list
    retrieved_at: str
    status: Literal["success", "error"]
    error: Optional[str]
    source_type: Literal["portal", "developer", "web", "official"]
    retrieved_via: Optional[str]    # 'http' | 'browser' | 'cache'


class ExtractedFact(TypedDict, total=False):
    """One field pulled from a fetched page, with provenance — the same
    conflict-preserving shape dedupe.py's FieldEvidence already uses, so
    merge_extracted_facts() (dedupe.py) can fold these in with zero new
    reconciliation logic."""
    candidate: str
    field: str
    value: object
    source: str
    source_url: Optional[str]
    retrieved_at: str
    confidence: Literal["high", "medium", "low"]
    method: Literal["deterministic", "llm"]
    evidence_text: Optional[str]     # the actual snippet the value/scope was read from (Part P0.5/P0.10 provenance)
    configuration: Optional[str]     # e.g. "2 BHK" — set when this fact is scoped to one specific configuration, not the whole property (Part P0.6)


class FeatureEvidence(TypedDict, total=False):
    """Canonical unit-feature representation (Part P0.1) — deck/balcony/
    parking (and any future boolean-ish unit feature) ALWAYS produce this
    shape, regardless of scope. scoring.py reads ONLY this list to decide
    whether a requested feature (e.g. "deck") is satisfied — it never
    re-derives the answer by substring-searching raw description text
    (Part P0.2's explicit rule)."""
    feature: str                     # "deck" | "balcony" | "parking"
    scope: Literal["unit", "tower", "building", "project", "locality", "unknown"]
    configuration: Optional[str]     # e.g. "2 BHK", or None when not tied to one specific configuration
    evidence_text: str
    source: str
    source_url: Optional[str]
    confidence: Literal["high", "medium", "low"]


class CandidateGap(TypedDict, total=False):
    """Per-candidate field-level research gap (Part 11) — what the OLD
    boolean route_research_gap() collapsed into one yes/no for the whole
    result set, this keeps per-candidate and per-field so targeted_research
    can generate SPECIFIC follow-up queries instead of repeating the
    original generic search."""
    candidate: str
    missing_fields: list[str]
    weak_fields: list[str]         # present but low-confidence/single-source
    conflicting_fields: list[str]  # field_evidence has >1 distinct value


class VerificationResult(TypedDict, total=False):
    """Cross-source verification outcome for one candidate (Part 16) —
    structured form of what candidate_verifier's plain warning strings
    already detect, kept alongside them (not replacing) so the API can
    expose `field: conflict` as data, not just prose."""
    candidate: str
    conflicts: dict[str, list[str]]     # field -> distinct values found
    corroborated_fields: list[str]      # fields where >=2 sources agree


class FieldEvidence(TypedDict):
    field: str
    value: object
    source: str
    source_url: Optional[str]
    captured_at: str
    confidence: str


class NormalizedProperty(TypedDict, total=False):
    id: str                     # deterministic dedup key
    name: str
    developer: Optional[str]
    location: Optional[str]
    micro_location: Optional[str]
    city: Optional[str]
    configuration: list[str]
    price_min_inr: Optional[int]
    price_max_inr: Optional[int]
    price_display: Optional[str]
    carpet_area_sqft: Optional[float]
    possession_year: Optional[int]
    possession_display: Optional[str]
    rera: Optional[str]
    amenities: list[str]
    description: Optional[str]
    sources: list[dict]          # [{name, url, captured_at}]
    field_evidence: dict[str, list[FieldEvidence]]   # per-field provenance + conflicts
    evidence_count: int
    source_types: list[str]
    is_aggregator: bool  # looks like a portal category/search-results page, not an individual project

    # ── Deep-research-only fields (Part 14) — absent until deep_research.py
    # actually fetches and extracts a page for this candidate; never
    # fabricated, never defaulted. field_evidence carries provenance for
    # these same keys too (see dedupe.py's merge_extracted_facts).
    property_type: Optional[str]
    carpet_area_display: Optional[str]
    built_up_area_display: Optional[str]
    price_per_sqft: Optional[str]
    project_status: Optional[str]
    total_floors: Optional[str]
    tower_count: Optional[int]
    connectivity: Optional[str]
    nearby_landmarks: list[str]

    # ── Canonical unit-feature evidence (Part P0.1/P0.2) — REPLACES the
    # earlier flat deck_status/balcony_status/parking_status strings.
    # scoring.py's amenity/feature matcher reads ONLY this list (never
    # substring-searches `description`) to decide whether a requested
    # feature like "deck" is genuinely satisfied at unit scope.
    features: list[FeatureEvidence]

    # ── Configuration-specific facts (Part P0.6) — keyed by configuration
    # string (e.g. "2 BHK"), each value a small dict of whatever fields were
    # actually tied to THAT configuration by fact_extraction.py (price,
    # carpet_area, possession, ...). A flat property-level field (price_
    # display, carpet_area_sqft, ...) must NEVER be assumed to apply to
    # every configuration when more than one is listed — this is the
    # structure that keeps a 1 BHK price from silently becoming the 2 BHK
    # price. Absent/empty when nothing configuration-specific was found.
    configuration_evidence: dict[str, dict]

    # Candidate eligibility classification (Part P0.3) — kept alongside the
    # existing is_aggregator boolean for transparency/LangSmith metadata
    # (why was this NOT treated as a candidate).
    page_type: Optional[str]

    # Lifecycle / transaction-type (deterministic, see normalize.py's
    # classify_lifecycle_status) — UNDER_CONSTRUCTION | NEAR_POSSESSION |
    # NEW_LAUNCH | READY_TO_MOVE | RESALE | RENTAL | UNKNOWN. Never set by
    # an LLM; graph.py's hard eligibility filter rejects anything outside
    # ALLOWED_LIFECYCLE_STATUSES before scoring, the same gate is_aggregator
    # already uses.
    lifecycle_status: str
    lifecycle_evidence_text: Optional[str]


class RankedProperty(NormalizedProperty, total=False):
    match_score: int
    match_tier: Literal["PRIMARY", "SECONDARY", "TERTIARY"]
    match_reasons: list[str]
    mismatches: list[str]
    matched_requirements: list[str]
    limitations: list[str]


class ResearchState(TypedDict, total=False):
    # Input
    original_query: str
    normalized_query: str
    market: str

    # Bridge health (Part 3.2) — set once by the preflight node; every
    # search/deep-research node reads this to skip fast instead of each
    # independently retrying a dependency already known to be down.
    bridge_unavailable: bool

    # Understanding
    parsed_requirements: ParsedRequirements
    locations: list[str]
    micro_locations: list[ResolvedLocation]
    configurations: list[str]
    budget: dict
    possession: dict
    amenities: list[str]

    # Planning
    search_plan: list[str]
    # Structured research strategy (Part 7) — discovery_queries/portal_queries/
    # developer_queries/candidate_fields_to_verify/missing_information_strategy.
    # Additive alongside search_plan (which still drives the existing 5-tool
    # fan-out unchanged) — this is the richer plan deep_research/
    # targeted_research read from.
    research_plan: dict

    # Evidence collection (fan-out safe — see module docstring)
    tool_calls: Annotated[list[ToolCallRecord], operator.add]
    raw_evidence: Annotated[list[EvidenceItem], operator.add]
    warnings: Annotated[list[str], operator.add]
    errors: Annotated[list[str], operator.add]

    # Processing pipeline
    normalized_properties: list[NormalizedProperty]
    deduplicated_properties: list[NormalizedProperty]
    ranked_properties: list[RankedProperty]
    selected_properties: list[RankedProperty]

    # Deep research (Part 4/8-16) — accumulate across loop passes via
    # operator.add (each pass returns only its OWN new items; the reducer
    # concatenates rather than overwriting the prior pass's pages/facts).
    fetched_pages: Annotated[list[FetchedPage], operator.add]
    extracted_facts: Annotated[list[ExtractedFact], operator.add]
    # Current-pass snapshots (recomputed, not accumulated, each time the
    # gap-checker/verifier runs — these describe the LATEST state, not a
    # history of every prior pass).
    research_gaps: list[CandidateGap]
    verification_results: list[VerificationResult]

    # Dev-only debug trace (Part 27) — candidates the hard eligibility
    # filter rejected, with a human-readable reason each. Recomputed
    # (never accumulated) each time the scorer runs, same convention as
    # research_gaps/verification_results above. curator.py only attaches
    # this to final_response when AI_SEARCH_DEBUG_TRACE=true is set on the
    # server — never sent to a production user by default.
    debug_rejected_candidates: list[dict]

    # Research-gap loop
    research_iterations: int
    needs_more_research: bool
    targeted_research_targets: list[str]

    # Search-quality metrics (Part 29) — assembled once by the curator from
    # everything else already in state; never a second source of truth.
    research_metrics: dict

    # Output
    project_intelligence: dict[str, dict]   # keyed by property id
    citations: list[dict]
    research_summary: str
    final_response: dict

    timestamps: dict[str, str]
