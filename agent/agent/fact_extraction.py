"""Fact extraction (Part 14) — turns one fetch_page() result into a list of
per-field ExtractedFact items, each carrying its own source/url/timestamp/
confidence (Part 15). Deterministic regex extraction runs first, mirroring
the same patterns normalize.py/query_understanding.py and (on the Node side)
external-search.cjs already use for the exact same fields — this is
deliberately NOT a second, differently-calibrated parser.

A bounded LLM assist (the 'extraction' role, Part 18) only runs for the
SPECIFIC fields the caller says are still missing (`fields_needed`), and
only over the page's already-short extracted text (never raw HTML, never a
field that's already known) — Part 17/19's cost rule. Its system prompt is
absolute: answer ONLY with what the text actually states; anything not
literally present must come back null. This is Part 17's rule enforced at
the prompt level, not just documented — the deterministic pass is always
the fallback of record if the LLM returns nothing usable or invents a
shape we don't recognize.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Optional

from .llm_providers import LLMRouter
from .state import EvidenceItem, ExtractedFact, FeatureEvidence, FetchedPage

_RERA_RE = re.compile(r"\b(P[A-Z]{0,2}\d{9,13})\b", re.IGNORECASE)

_CR_RE = re.compile(r"(\d+\.?\d*)\s*(?:cr|crore)\b", re.IGNORECASE)
_LAKH_RE = re.compile(r"(\d+\.?\d*)\s*(?:l|lakh|lakhs)\b", re.IGNORECASE)
_PRICE_PER_SQFT_RE = re.compile(r"(?:₹|rs\.?)\s*(\d[\d,]*)\s*(?:/|per)\s*sq\.?\s*\.?\s*ft", re.IGNORECASE)

_FLOORS_RE = re.compile(r"\bG\s*\+\s*(\d{1,3})\b", re.IGNORECASE)
_FLOORS_ALT_RE = re.compile(r"(\d{1,3})\s*floors?\b", re.IGNORECASE)
_TOWERS_RE = re.compile(r"(\d{1,2})\s*towers?\b", re.IGNORECASE)

_CONNECTIVITY_RE = re.compile(
    r"((?:metro|railway|rail(?:way)?\s*station|station|airport|highway|expressway)"
    r"[^.]{0,45}?\d+(?:\.\d+)?\s*(?:km|kms|kilometers?|min|mins|minutes))",
    re.IGNORECASE,
)

_DECK_RE = re.compile(r"\b(?:private\s+)?decks?\b", re.IGNORECASE)
_BALCONY_RE = re.compile(r"\bbalcon(?:y|ies)\b", re.IGNORECASE)
_PARKING_RE = re.compile(r"\bparking\b", re.IGNORECASE)

# Feature-scope classification (Part 3.5) — "2 BHK with deck" means the
# UNIT has a deck, not the project/building/tower. Purely heuristic (a
# ~60-char window around the mention, scanned for scope-indicating words),
# same accepted trade-off as every other regex in this codebase.
_UNIT_SCOPE_RE = re.compile(
    r"\bprivate\b|\bpersonal\b|\bown\b|\battached\b|\bin-unit\b|\bin\s+unit\b"
    r"|\beach\s+(?:unit|apartment|home|residence|flat)\b|\bevery\s+(?:unit|apartment|home|residence|flat)\b"
    r"|\bwithin\s+(?:the\s+)?(?:unit|apartment|flat|residence)\b|\d\s*bhk",
    re.IGNORECASE,
)
_BUILDING_SCOPE_RE = re.compile(
    r"\blevel\s*\d+\b|\bfloor\s*\d+\b|\d+\s*(?:st|nd|rd|th)\s*(?:level|floor)\b"
    r"|\beco\s*deck\b|\brooftop\b|\bpodium\b|\bclubhouse\b|\bcommon\s+area\b|\bshared\b"
    r"|\btower\b|\bbuilding\b|\bproject\b|\bdevelopment\b|\bcomplex\b|\bamenit",
    re.IGNORECASE,
)


def classify_feature_scope(text: str, match_start: int, match_end: int) -> str:
    """Returns 'unit' | 'tower' | 'building' | 'project' | 'unknown' for a
    feature mention at text[match_start:match_end], based on scope-
    indicating words in a window around it. Deliberately conservative when
    ambiguous (returns 'unknown', never guesses 'unit') — Part 3.5's rule
    is a false negative (missing a real unit-level deck) is far cheaper
    than a false positive (crediting a project-level amenity as if it were
    the specific unit's own).
    """
    window_start = max(0, match_start - 60)
    window_end = min(len(text), match_end + 60)
    window = text[window_start:window_end]
    building_match = _BUILDING_SCOPE_RE.search(window)
    unit_match = _UNIT_SCOPE_RE.search(window)
    if unit_match and not building_match:
        return "unit"
    if building_match and not unit_match:
        w = building_match.group(0).lower()
        if "tower" in w:
            return "tower"
        if "building" in w:
            return "building"
        return "project"
    if unit_match and building_match:
        # Both present in the window — prefer whichever text is CLOSER to
        # the actual feature mention (the nearer phrase is more likely to
        # be the one actually modifying it).
        rel_pos = match_start - window_start
        unit_dist = abs(unit_match.start() - rel_pos)
        building_dist = abs(building_match.start() - rel_pos)
        return "unit" if unit_dist < building_dist else "project"
    return "unknown"
_LANDMARK_RE = re.compile(r"\b(?:near|close to|walking distance from|adjacent to)\s+([A-Z][A-Za-z0-9&.'\- ]{2,40})")

_PROPERTY_TYPE_TERMS = [
    ("villa", "Villa"), ("penthouse", "Penthouse"), ("row house", "Row House"),
    ("bungalow", "Bungalow"), ("plot", "Plot"), ("studio", "Studio Apartment"), ("duplex", "Duplex"),
]

_NOT_A_DEVELOPER = {"owner", "agent", "broker", "appointment", "invite", "request"}


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


# Cross-candidate fact bleeding on a MULTI-PROJECT page (Part 2's fix,
# generalized) — confirmed live: fetching a category page
# (".../under-construction-projects-in-borivali-west-mumbai...") as one of
# "Amann Solitaire"'s source URLs let `_RERA_RE.search(text)` grab
# "THE ZONE"'s RERA number instead, because .search() just takes the FIRST
# match anywhere on the page with zero regard for which project's section
# it's actually in. extract_sub_listings() already solved this exact
# problem for ITS OWN separate code path (_sentences_mentioning_name) but
# that fix never covered this, the main extraction path every fetched page
# actually goes through. Same principle here, applied more generally: when
# a pattern has multiple matches AND the candidate's own name appears
# literally in the text, prefer whichever match sits CLOSEST (by character
# distance) to a mention of the candidate's own name — not just the first
# one on the page. Falls back to the plain first-match behavior (unchanged)
# when there's only one match (no ambiguity to resolve) or the candidate
# name doesn't literally appear in the text at all (nothing to anchor to) —
# never a regression for the common single-project-page case.
def _nearest_match(text: str, candidate: str, pattern: re.Pattern) -> Optional[re.Match]:
    matches = list(pattern.finditer(text))
    if not matches:
        return None
    if len(matches) == 1 or not candidate:
        return matches[0]
    name_positions = [m.start() for m in re.finditer(re.escape(candidate), text, re.IGNORECASE)]
    if not name_positions:
        return matches[0]
    def _dist(m: re.Match) -> int:
        return min(abs(m.start() - p) for p in name_positions)
    return min(matches, key=_dist)


def _extract_area_facts(text: str) -> tuple[Optional[str], Optional[str]]:
    """Same "scan every '<N> sq ft' mention, bucket by nearby carpet/built-up
    keyword on EITHER side" approach as external-search.cjs's
    extractAreaFacts — both listing conventions ("650 sq ft carpet" and
    "carpet area: 650 sq ft") need to work.
    """
    carpet, built_up = None, None
    for m in re.finditer(r"(\d{3,5})\s*sq\.?\s*\.?\s*ft\.?", text, re.IGNORECASE):
        start, end = max(0, m.start() - 20), min(len(text), m.end() + 20)
        around = text[start:end].lower()
        label = f"{m.group(1)} sq ft"
        if "carpet" in around and not carpet:
            carpet = label
        elif re.search(r"built[\s-]?up|super\s*built", around) and not built_up:
            built_up = label
        elif not carpet:
            carpet = label
    return carpet, built_up


def _parse_sqft_value(display: Optional[str]) -> Optional[float]:
    """Phase 2 — the numeric value parsed straight back out of a "<N> sq ft"
    display string this module itself just built (_extract_area_facts) —
    never re-derived from raw text a second time, so it can never disagree
    with the display string sitting right next to it. Returns None (never
    a guess) for anything that doesn't contain a recognizable number.
    """
    if not display:
        return None
    m = re.search(r"(\d{3,5}(?:\.\d+)?)", display)
    return float(m.group(1)) if m else None


def _extract_price(text: str, candidate: Optional[str] = None) -> tuple[Optional[float], Optional[str]]:
    cr = _nearest_match(text, candidate, _CR_RE) if candidate else _CR_RE.search(text)
    if cr:
        return float(cr.group(1)), f"₹{cr.group(1)} Cr"
    lakh = _nearest_match(text, candidate, _LAKH_RE) if candidate else _LAKH_RE.search(text)
    if lakh:
        return float(lakh.group(1)) / 100, f"₹{lakh.group(1)}L"
    return None, None


# Possession semantics (Part P0.5) — the live bug this exists to fix:
# "possession": "2008" was produced from a BARE 4-digit year found ANYWHERE
# in the page text (a RERA registration year, a "since 2008" developer
# founding blurb, an unrelated date) with zero regard for whether the text
# actually says anything about possession. A year is ONLY ever treated as
# a possession date when a possession/handover/completion/occupancy word
# appears near it — no contextual anchor, no possession fact, full stop.
_POSSESSION_CONTEXT_RE = re.compile(r"possession|handover|hand[\s-]?over|deliver|completion|occupancy|ready\s+to\s+move", re.IGNORECASE)
_MONTH_YEAR_RE = re.compile(r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{4})", re.IGNORECASE)
_BARE_YEAR_RE = re.compile(r"\b(20\d\d)\b")
_CONTEXT_WINDOW = 55


def _extract_possession_and_status(text: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Returns (possession_display, project_status, evidence_text). Never
    returns a year (bare or month+year) without a possession/handover/
    completion/occupancy word within _CONTEXT_WINDOW chars of it — see
    module docstring above. Scans ALL month+year mentions (not just the
    first) so a genuinely context-anchored one further down the page isn't
    missed because an earlier, unrelated year came first.
    """
    if re.search(r"ready to move|immediate possession|move[-\s]?in ready|ready possession", text, re.IGNORECASE):
        m = re.search(r"[^.]*ready to move[^.]*|[^.]*immediate possession[^.]*|[^.]*ready possession[^.]*", text, re.IGNORECASE)
        return "Ready to Move", "Ready to move", (m.group(0).strip() if m else "ready to move")

    for m in _MONTH_YEAR_RE.finditer(text):
        window_start = max(0, m.start() - _CONTEXT_WINDOW)
        window = text[window_start:m.start()]
        if _POSSESSION_CONTEXT_RE.search(window):
            year = int(m.group(2))
            status = "Under construction" if year >= datetime.now(timezone.utc).year else None
            evidence = text[window_start:min(len(text), m.end() + 10)].strip()
            return f"{m.group(1)[:3]} {m.group(2)}", status, evidence

    for m in _BARE_YEAR_RE.finditer(text):
        window_start = max(0, m.start() - _CONTEXT_WINDOW)
        window_end = min(len(text), m.end() + 15)
        window = text[window_start:window_end]
        if _POSSESSION_CONTEXT_RE.search(window):
            year = int(m.group(1))
            status = "Under construction" if year >= datetime.now(timezone.utc).year else None
            return m.group(1), status, window.strip()

    return None, None, None


_DEVELOPER_BY_RE = re.compile(r"\bby\s+([A-Z][A-Za-z&.\-]+(?:\s+[A-Z][A-Za-z&.\-]+){0,3})")
_DEVELOPER_LABEL_RE = re.compile(r"\bDeveloper[:\-]\s*([A-Za-z0-9&.\-\s]{3,50})", re.IGNORECASE)


def _extract_developer(text: str, candidate: Optional[str] = None) -> Optional[str]:
    m = _nearest_match(text, candidate, _DEVELOPER_BY_RE) if candidate else _DEVELOPER_BY_RE.search(text)
    if m:
        name = _clean(m.group(1))
        if name.split(" ")[0].lower() not in _NOT_A_DEVELOPER and len(name) <= 60:
            return name
    m = _nearest_match(text, candidate, _DEVELOPER_LABEL_RE) if candidate else _DEVELOPER_LABEL_RE.search(text)
    if m:
        return _clean(m.group(1))
    return None


def _extract_property_type(text: str) -> Optional[str]:
    t = text.lower()
    for term, label in _PROPERTY_TYPE_TERMS:
        if term in t:
            return label
    return None


def _extract_floors_towers(text: str) -> tuple[Optional[str], Optional[int]]:
    g = _FLOORS_RE.search(text)
    total_floors = f"G+{g.group(1)}" if g else None
    if not total_floors:
        f = _FLOORS_ALT_RE.search(text)
        if f:
            total_floors = f"{f.group(1)} floors"
    towers_match = _TOWERS_RE.search(text)
    tower_count = int(towers_match.group(1)) if towers_match else None
    return total_floors, tower_count


def _extract_landmarks(text: str) -> list[str]:
    found: list[str] = []
    for m in _LANDMARK_RE.finditer(text):
        name = _clean(m.group(1))
        if name and name not in found:
            found.append(name)
        if len(found) >= 3:
            break
    return found


# Configuration association (Part P0.6) — a price/carpet-area/possession/
# feature mention found NEAR a "<N> BHK" phrase belongs to that specific
# configuration, not to the whole property. Deliberately narrow (100-char
# window, closest mention wins) — a false "no configuration found" is
# always safer than wrongly tying a 1 BHK's price to a 2 BHK.
_BHK_RE = re.compile(r"(\d)\s*bhk", re.IGNORECASE)
_CONFIG_WINDOW = 100


def _nearest_configuration(text: str, pos: int) -> Optional[str]:
    """Strongly prefers a BHK label BEFORE the value, only falling back to
    one AFTER it when no preceding label exists in the window. Real
    "<config> - <area> - <price>" listings put the label first — a plain
    nearest-distance heuristic misattributes almost every value to the
    NEXT row's label instead of its own, because the price for row N sits
    fewer characters from row N+1's label (right after it) than from its
    own row's label (further back, past the area figure) — confirmed live:
    "1 BHK - 442 sq ft - Rs.85L. 2 BHK - 643 sq ft..." put the 1 BHK price
    onto the 2 BHK row under pure nearest-distance scoring.
    """
    start = max(0, pos - _CONFIG_WINDOW)
    end = min(len(text), pos + _CONFIG_WINDOW)
    before, after = text[start:pos], text[pos:end]
    closest_before, best_dist = None, None
    for m in _BHK_RE.finditer(before):
        dist = pos - (start + m.end())
        if best_dist is None or dist < best_dist:
            closest_before, best_dist = f"{m.group(1)} BHK", dist
    if closest_before:
        return closest_before
    for m in _BHK_RE.finditer(after):
        return f"{m.group(1)} BHK"
    return None


def _extract_configuration_specific_facts(candidate: str, text: str, source: str, source_url: Optional[str], retrieved_at: str) -> list[ExtractedFact]:
    """Scans every carpet-area and price mention for a nearby BHK figure
    (Part P0.6's "2 BHK — 643 sq ft — ₹1.7 Cr" example) and, when found,
    emits a configuration-SCOPED fact rather than letting normalize.py's
    flat property-level fields (which apply to the whole candidate
    regardless of configuration) be the only representation. Facts with no
    identifiable nearby configuration are simply not emitted here — the
    existing flat extraction already covers the unscoped case.
    """
    facts: list[ExtractedFact] = []
    for m in re.finditer(r"(\d{3,5})\s*sq\.?\s*\.?\s*ft\.?", text, re.IGNORECASE):
        config = _nearest_configuration(text, m.start())
        if not config:
            continue
        window_start, window_end = max(0, m.start() - 40), min(len(text), m.end() + 40)
        facts.append(ExtractedFact(
            candidate=candidate, field="carpet_area", value=f"{m.group(1)} sq ft",
            configuration=config, source=source, source_url=source_url, retrieved_at=retrieved_at,
            confidence="medium", method="deterministic", evidence_text=text[window_start:window_end].strip(),
        ))
    for m in re.finditer(r"(?:₹|rs\.?)\s*(\d+\.?\d*)\s*(cr|crore|l|lakh|lakhs)\b", text, re.IGNORECASE):
        config = _nearest_configuration(text, m.start())
        if not config:
            continue
        unit = m.group(2).lower()
        display = f"₹{m.group(1)} {'Cr' if unit.startswith('cr') else 'L'}"
        window_start, window_end = max(0, m.start() - 40), min(len(text), m.end() + 40)
        facts.append(ExtractedFact(
            candidate=candidate, field="price", value=display,
            configuration=config, source=source, source_url=source_url, retrieved_at=retrieved_at,
            confidence="medium", method="deterministic", evidence_text=text[window_start:window_end].strip(),
        ))
    return facts


AMENITY_TERMS = [
    "swimming pool", "pool", "gym", "gymnasium", "clubhouse", "club house",
    "garden", "jogging track", "kids play area", "children's play area",
    "play area", "security", "power backup", "lift", "elevator",
    "terrace", "yoga", "amphitheatre", "sports court",
    "tennis court", "badminton court", "indoor games", "party hall",
    "banquet hall", "senior citizen", "jacuzzi", "sauna", "spa", "library",
    "co-working",
]


# ── Exact project name extraction (Part 2) ──────────────────────────────
# is_aggregator_title() already rejects a WHOLE candidate whose page reads
# like a category/search-results page. This is a narrower, separate
# concern: even a candidate that survives that check can still carry an
# unhelpful DISPLAY name — the search-snippet's raw title, full of portal
# SEO furniture ("Arkade Malad West - Premium Residential Apartments in
# Malad West, Mumbai") instead of the actual project name a buyer would
# recognize ("Arkade Malad West"). Deterministic-only, no LLM guess at a
# name — this task's "never invent project data" rule applies here as much
# as anywhere. Two real, extractive sources, in priority order:
#   1. JSON-LD structured data (schema.org Product/Residence/... `name`)
#      — the page's OWN machine-readable claim, highest confidence.
#   2. The fetched page's real <title> tag (the ACTUAL page deep_research
#      just fetched, not the search-snippet title), cleaned of the same
#      portal-furniture words dedupe.py's _core_name_key strips, plus a
#      trailing "- 99acres"/"| MagicBricks"-style site-name suffix.
# Returns None (never a guess) when neither source yields a name that
# doesn't itself still read as a category-page title.
_STRUCTURED_NAME_TYPES = {
    "product", "residence", "apartmentcomplex", "house",
    "realestatelisting", "singlefamilyresidence", "place",
}
_TRAILING_SITE_SUFFIX_RE = re.compile(
    r"\s*[|\-–]\s*(99acres|magicbricks|housing\.com|nobroker|squareyards|proptiger|makaan|commonfloor)\b.*$",
    re.IGNORECASE,
)


def _name_from_structured_data(structured_data: list) -> Optional[str]:
    for block in structured_data or []:
        items = block if isinstance(block, list) else [block]
        for item in items:
            if not isinstance(item, dict):
                continue
            t = str(item.get("@type") or "").lower()
            name = item.get("name")
            if t in _STRUCTURED_NAME_TYPES and isinstance(name, str) and name.strip():
                return _clean(name)
    return None


def _clean_page_title(title: str) -> Optional[str]:
    if not title:
        return None
    from .dedupe import _PORTAL_NOISE_RE  # same fixed word list dedup keys on
    cleaned = _PORTAL_NOISE_RE.sub("", title)
    cleaned = _TRAILING_SITE_SUFFIX_RE.sub("", cleaned)
    # Removing the noise words above leaves orphaned punctuation behind
    # ("Arkade Eden Malad West: , &" from stripping "Price, Photos & Floor
    # Plans") — collapse any run of separator punctuation into a single
    # space, then trim leading/trailing separator punctuation.
    cleaned = re.sub(r"[,&:|–]+", " ", cleaned)
    cleaned = re.sub(r"^[\s\-–,:|&]+|[\s\-–,:|&]+$", "", cleaned)
    cleaned = _clean(cleaned)
    return cleaned or None


def extract_project_name(page: FetchedPage) -> Optional[str]:
    structured = _name_from_structured_data(page.get("structured_data") or [])
    if structured:
        return structured
    cleaned = _clean_page_title(page.get("title") or "")
    if not cleaned:
        return None
    # A cleaned title that STILL reads as a category page ("1 BHK Flats in
    # Borivali West") after stripping portal furniture is not an
    # identifiable project name — reject the extraction, never return a
    # guess. Reuses the same page-type classifier the aggregator-rejection
    # gate uses, so "looks like a real project" means the same thing in
    # both places.
    from .normalize import is_aggregator_title
    if is_aggregator_title({"title": cleaned, "description": ""}):
        return None
    return cleaned


def deterministic_extract(candidate: str, page: FetchedPage) -> tuple[list[ExtractedFact], list[FeatureEvidence]]:
    """The regex pass — always run, regardless of `fields_needed`, since
    it's essentially free (Part 19). Only produces a fact when the pattern
    actually matched something in THIS page's text — never a null-value
    ExtractedFact (an absent fact is simply not emitted, not emitted-as-null;
    see gap_checker.py for how "still missing after this" is decided).

    Returns (facts, features) — `features` is the canonical unit-feature
    list (Part P0.1) for deck/balcony/parking; EVERY real mention is
    recorded there regardless of scope (unit/tower/building/project/
    unknown), never filtered out at extraction time. scoring.py is the
    ONLY place that decides whether a given feature+scope actually
    satisfies a query requirement — this function's job is just to report
    what the text says and where it says it, honestly.
    """
    text = page.get("content") or ""
    if not text:
        return [], []
    source = (page.get("metadata") or {}).get("source_name") or page.get("url") or "web"
    retrieved_at = page.get("retrieved_at") or datetime.now(timezone.utc).isoformat()
    url = page.get("url")

    facts: list[ExtractedFact] = []
    features: list[FeatureEvidence] = []

    def emit(field: str, value, confidence: str = "medium", **kwargs):
        if value is None or value == "" or value == []:
            return
        facts.append(ExtractedFact(candidate=candidate, field=field, value=value, source=source,
                                    source_url=url, retrieved_at=retrieved_at, confidence=confidence,
                                    method="deterministic", **kwargs))

    resolved_name = extract_project_name(page)
    emit("project_name", resolved_name, confidence="high" if _name_from_structured_data(page.get("structured_data") or []) else "medium")

    # Anchor name for cross-candidate bleed protection below — the
    # RESOLVED page-title name when this page has one (most precise, it's
    # literally this page's own claimed identity), falling back to the
    # caller-provided `candidate` string (the name this fetch was made
    # FOR) when the page's own title didn't yield a usable name. Either way
    # gives _nearest_match something concrete to anchor RERA/price to on a
    # page that turns out to describe more than one project.
    anchor_name = resolved_name or candidate

    # Follow-up spec (Part 3/5/7) — the REAL fix for "UNKNOWN before
    # verification vs. UNKNOWN after verification". normalize.py's
    # reclassify_lifecycle_from_enriched_evidence() (called later, once
    # per candidate in node_final_scoring) only ever reconstructs its
    # evidence text from a narrow set of ALREADY-STRUCTURED fields
    # (possession-related field_evidence, configuration possession
    # buckets, deck/balcony/parking feature snippets) — it never sees the
    # actual fetched page's own title/content, even though THIS function
    # has that text right here. Confirmed live: a real developer page
    # (arkademaladwest.in/Liberty-Garden) explicitly says "New Launch at
    # Liberty Garden, Malad West" / "Exclusive Pre-Launch Privileges" in
    # its own real text — a successful fetch, genuine content, unambiguous
    # NEW_LAUNCH signal — and STILL came back classified UNKNOWN, because
    # nothing downstream of this function ever looked at `text` for
    # lifecycle purposes. Classify directly against this page's own real
    # title+content (never the search snippet) and emit it as a fact so
    # dedupe.merge_extracted_facts can apply it exactly like the
    # project_name upgrade above — only when the candidate's CURRENT
    # status is still undetermined, never overriding an already-confident
    # classification.
    from .normalize import classify_lifecycle_status as _classify_lifecycle_from_page
    page_lifecycle_status, page_lifecycle_evidence = _classify_lifecycle_from_page(
        {"title": page.get("title") or candidate, "description": text[:4000]},
    )
    if page_lifecycle_status != "UNKNOWN":
        emit("lifecycle_status_from_page", page_lifecycle_status, confidence="high", evidence_text=page_lifecycle_evidence)

    rera = _nearest_match(text, anchor_name, _RERA_RE)
    emit("rera_number", rera.group(1).upper() if rera else None, confidence="high")

    carpet, built_up = _extract_area_facts(text)
    emit("carpet_area", carpet)
    emit("built_up_area", built_up)

    price_cr, price_display = _extract_price(text, anchor_name)
    emit("price", price_display)
    ppsf = _PRICE_PER_SQFT_RE.search(text)
    emit("price_per_sqft", f"₹{ppsf.group(1)}/sq ft" if ppsf else None)

    # Configuration-scoped price/carpet-area (Part P0.6) — additive,
    # alongside (never replacing) the flat property-level facts above; the
    # flat fields stay honest about being property-level/unscoped, these
    # are the ones a configuration-aware inventory table should actually
    # read for a specific BHK row.
    facts.extend(_extract_configuration_specific_facts(candidate, text, source, url, retrieved_at))

    possession, status, possession_evidence = _extract_possession_and_status(text)
    emit("possession", possession, evidence_text=possession_evidence)
    emit("project_status", status)

    emit("developer", _extract_developer(text, anchor_name))
    emit("property_type", _extract_property_type(text))

    total_floors, tower_count = _extract_floors_towers(text)
    emit("total_floors", total_floors)
    emit("tower_count", tower_count)

    connectivity_match = _CONNECTIVITY_RE.search(text)
    emit("connectivity", connectivity_match.group(1) if connectivity_match else None)

    landmarks = _extract_landmarks(text)
    emit("nearby_landmarks", landmarks if landmarks else None)

    # Strip the candidate's OWN name before scanning for amenity words — a
    # project literally named "...Garden..." or "...Greens..." would
    # otherwise false-positive-match the "garden" amenity term purely from
    # its own name appearing in the page text (confirmed while building
    # this: "Arkade Liberty Garden" matched the "garden" amenity every
    # time). Same reasoning as query-parser.cjs's maskLocations() before
    # its own amenity extraction.
    amenity_scan_text = re.sub(re.escape(candidate), " ", text, flags=re.IGNORECASE).lower() if candidate else text.lower()
    hits = [a for a in AMENITY_TERMS if a in amenity_scan_text]
    # Drop a shorter term wholly contained in a longer matched term ("pool"
    # inside "swimming pool") so both don't independently match the same
    # mention.
    found_amenities = [a for a in hits if not any(b != a and a in b and len(b) > len(a) for b in hits)]
    emit("amenities", found_amenities if found_amenities else None)

    # Canonical unit-feature evidence (Part P0.1) — every real mention of
    # deck/balcony/parking, at whatever scope, becomes its own
    # FeatureEvidence entry (with the nearest configuration if one can be
    # established). Nothing is filtered or collapsed to a single boolean
    # here — "2 BHK with deck" being satisfied or not is scoring.py's
    # decision to make from this list, not this function's.
    for feature, feature_re in (("deck", _DECK_RE), ("balcony", _BALCONY_RE), ("parking", _PARKING_RE)):
        for m in feature_re.finditer(text):
            scope = classify_feature_scope(text, m.start(), m.end())
            config = _nearest_configuration(text, m.start())
            window_start, window_end = max(0, m.start() - 60), min(len(text), m.end() + 60)
            features.append(FeatureEvidence(
                feature=feature, scope=scope, configuration=config,
                evidence_text=text[window_start:window_end].strip(),
                source=source, source_url=url, confidence="high" if scope == "unit" else "medium",
            ))

    return facts, features


# Fields the LLM assist is allowed to help with — deliberately excludes
# anything that's an identity/legal fact best left to the RERA regex/regex-
# only pass (rera_number) to keep the highest-stakes field 100%
# deterministic; the assist is for the softer, prose-shaped facts a regex
# genuinely struggles with (e.g. "project_status" phrased unusually,
# "connectivity" spread across a sentence the regex didn't anchor right).
#  deck/balcony/parking deliberately excluded — they're handled entirely
# through the structured `features` list now (Part P0.1/P0.2), which the
# LLM-assist path (a flat field:value dict) has no way to represent
# faithfully (it would have no scope/configuration, defeating the entire
# point of the canonical structure).
LLM_ASSISTABLE_FIELDS = {
    "developer", "property_type", "possession", "project_status", "total_floors",
    "tower_count", "connectivity", "nearby_landmarks", "amenities",
}


async def llm_assist_extract(candidate: str, page: FetchedPage, fields_needed: list[str]) -> list[ExtractedFact]:
    """Extraction-role LLM pass — ONLY for fields in `fields_needed` that
    are also LLM-assistable, and ONLY over this page's already-short
    excerpt. Never called for a field the deterministic pass already found
    (that's the caller's job to filter, via fields_needed) — see
    deep_research.py's call site.
    """
    text = (page.get("content") or "").strip()
    targets = [f for f in fields_needed if f in LLM_ASSISTABLE_FIELDS]
    if not text or not targets:
        return []
    router = LLMRouter("extraction")
    if not router.is_configured():
        return []
    system = (
        "You extract real-estate facts from ONE web page excerpt. You may ONLY report a value that is "
        "LITERALLY stated in the given text. If the text does not state a field, its value MUST be null — "
        "never guess, infer from general knowledge, or fill in a typical/plausible value. "
        "Respond as strict JSON: {\"facts\": {\"<field>\": <value or null>, ...}}. "
        f"Only include these fields: {', '.join(targets)}."
    )
    user = json.dumps({"candidate": candidate, "page_title": page.get("title"), "page_text": text[:4000]})
    # Phase 1a — 500 was the original budget; Phase 0 confirmed live that
    # Groq's reasoning model (openai/gpt-oss-120b) can spend the bulk of a
    # tight budget on internal reasoning tokens before emitting any JSON
    # against a dense 4000-char excerpt, producing an empty
    # `json_validate_failed`. reasoning_effort="low" (llm_providers.py) is
    # the primary fix; this raised ceiling is the second layer of margin.
    result, provider_label = await router.complete_json(system, user, max_tokens=int(os.getenv("AI_SEARCH_EXTRACTION_MAX_TOKENS", "1500")))
    if not result:
        return []
    raw_facts = result.get("facts") or {}
    facts: list[ExtractedFact] = []
    retrieved_at = page.get("retrieved_at") or datetime.now(timezone.utc).isoformat()
    for field, value in raw_facts.items():
        if field not in targets or value in (None, "", []):
            continue
        facts.append(ExtractedFact(candidate=candidate, field=field, value=value,
                                    source=f"llm:{provider_label}" if provider_label else "llm",
                                    source_url=page.get("url"), retrieved_at=retrieved_at,
                                    confidence="medium", method="llm"))
    return facts


# ── Sub-listing extraction from rejected category/search-results pages ─────
# Confirmed live: a page correctly rejected as a category page (its TITLE
# reads like a locality browse page — "New Projects in Charkop, Kandivali
# West") still has real, specific, individually-named projects sitting in
# its own description/body text, each with its own genuine RERA number,
# price, and carpet area — e.g. "...Jadeite Kaveri... P51800079530 is the
# RERA number of the project Jadeite Kaveri...". Rejecting the whole page
# threw these away along with the genuinely-generic wrapper. This pulls
# each one out as its own EvidenceItem, which then flows through the
# EXISTING normalize -> dedupe -> score -> eligibility pipeline exactly
# like any other discovered candidate — never a second scoring path, and
# never a guessed project name: every sub-listing here is anchored by a
# real, shape-validated RERA number (_RERA_RE, the same strict pattern
# used everywhere else in this codebase) found literally in the text; no
# RERA match nearby means no sub-listing, full stop.
_RERA_OF_PROJECT_RE = re.compile(
    r"is\s+the\s+rera\s+number\s+of\s+the\s+project\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?=[.,;:\n]|\s+(?:with|located|is|has|offers)\b|$)",
    re.IGNORECASE,
)
# A candidate project-name phrase: 2-5 consecutive Title-Case words (real
# project names are proper nouns — "Jadeite Kaveri", "Sagar Soham
# Heights"), never a bare lowercase run. Deliberately excludes anything
# that, once matched, is ENTIRELY generic filler (reuses normalize.py's own
# GENERIC_FILLER_WORDS list so "the same word means the same thing" holds
# across this codebase) — a real project name always has at least one
# distinctive word left over.
_TITLE_CASE_PHRASE_RE = re.compile(r"\b(?:[A-Z][a-z0-9]+(?:\s+|-)){1,4}[A-Z][a-z0-9]+\b")


def _is_generic_phrase(phrase: str) -> bool:
    from .normalize import GENERIC_FILLER_WORDS
    words = re.findall(r"[A-Za-z]+", phrase)
    return not words or all(w.lower() in GENERIC_FILLER_WORDS for w in words)


def _nearest_project_name(text: str, rera_start: int, rera_end: int) -> Optional[str]:
    # Highest confidence: the explicit "<RERA number> is the RERA number of
    # the project <NAME>" phrasing — the name is stated outright, not
    # inferred from capitalization at all.
    window = text[max(0, rera_start - 40):min(len(text), rera_end + 160)]
    explicit = _RERA_OF_PROJECT_RE.search(window)
    if explicit:
        name = _clean(explicit.group(1))
        if name and not _is_generic_phrase(name):
            return name

    # Fallback: the nearest real (non-generic) Title-Case phrase — checked
    # BEFORE the RERA number first (the far more common portal layout is
    # "Name ... facts ... RERA: <number>"), then after.
    before = text[max(0, rera_start - 150):rera_start]
    candidates_before = [m.group(0) for m in _TITLE_CASE_PHRASE_RE.finditer(before) if not _is_generic_phrase(m.group(0))]
    if candidates_before:
        return _clean(candidates_before[-1])  # nearest = last match before the RERA number

    after = text[rera_end:min(len(text), rera_end + 150)]
    candidates_after = [m.group(0) for m in _TITLE_CASE_PHRASE_RE.finditer(after) if not _is_generic_phrase(m.group(0))]
    if candidates_after:
        return _clean(candidates_after[0])  # nearest = first match after

    return None


def _sentences_mentioning_name(text: str, name: str, rera_start: int, rera_end: int, radius: int = 400) -> str:
    """Bounds fact extraction to sentences that actually mention THIS
    project's own name (or the RERA sentence itself) — a fixed character
    radius around the RERA match alone bleeds into a NEIGHBORING project's
    price/carpet-area/possession when a category page lists several
    projects close together in the same paragraph (confirmed with a
    synthetic reproduction during development: a ±200-char window around
    one project's RERA number picked up the PREVIOUS project's price).
    Falls back to the raw radius window only if no sentence-level split
    happens to contain the name (e.g. it was itself split awkwardly).
    """
    window_start = max(0, rera_start - radius)
    window_end = min(len(text), rera_end + radius)
    window = text[window_start:window_end]
    sentences = re.split(r"(?<=[.!?])\s+", window)
    name_lower = name.lower()
    kept = [s for s in sentences if name_lower in s.lower()]
    return " ".join(kept) if kept else window


def extract_sub_listings(evidence: EvidenceItem) -> list[EvidenceItem]:
    """Only ever called by normalize.py's normalize_all() on an item whose
    OWN page reads as a category/search-results page (Part 2 of the
    follow-up spec) — never on an already-individual listing, which has no
    reason to contain OTHER projects' details. Returns [] (never fabricates
    a listing) when no RERA-anchored name can be found in the text.
    """
    text = f"{evidence.get('title') or ''} {evidence.get('description') or ''} {evidence.get('raw_text') or ''}".strip()
    if not text:
        return []
    sub_items: list[EvidenceItem] = []
    seen_rera: set[str] = set()
    seen_names: set[str] = set()
    for m in _RERA_RE.finditer(text):
        rera = m.group(1).upper()
        if rera in seen_rera:
            continue
        name = _nearest_project_name(text, m.start(), m.end())
        if not name or name.lower() in seen_names:
            continue
        seen_rera.add(rera)
        seen_names.add(name.lower())

        # Real facts, scoped to sentences that mention THIS project's own
        # name — never a raw character window, which can bleed a
        # NEIGHBORING project's price/area/possession into this one when
        # several projects are described close together (see
        # _sentences_mentioning_name's own comment).
        fact_window = _sentences_mentioning_name(text, name, m.start(), m.end())
        _, price_display = _extract_price(fact_window)
        carpet, built_up = _extract_area_facts(fact_window)
        possession, _, possession_evidence = _extract_possession_and_status(fact_window)

        sub_items.append(EvidenceItem(
            title=name, property_name=name,
            description=fact_window.strip(),
            source=evidence.get("source") or "web",
            source_url=evidence.get("source_url"),
            source_type="category_page_extract",
            location=evidence.get("location"),
            price={"min_inr": None, "max_inr": None, "display": price_display} if price_display else None,
            # Phase 2 — value_sqft used to be hardcoded None here always,
            # even though `carpet`/`built_up` are themselves already a
            # "<N> sq ft" string this same function just built two lines
            # up — _parse_sqft_value reads the number straight back out,
            # never re-derived from raw text a second time.
            carpet_area={"value_sqft": _parse_sqft_value(carpet or built_up), "display": carpet or built_up} if (carpet or built_up) else None,
            possession=possession,
            rera=rera,
            captured_at=evidence.get("captured_at") or datetime.now(timezone.utc).isoformat(),
            confidence="medium",
        ))
    return sub_items
