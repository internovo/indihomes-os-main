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
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

from .llm_providers import LLMRouter
from .state import EvidenceItem, ExtractedFact, FeatureEvidence, FetchedPage

logger = logging.getLogger("ai-search-agent.fact_extraction")

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

# Live bug this table caused: an Andheri APARTMENT was chipped "Villa" on
# the card. Two reasons, both visible in the old list. "villa" sat first and
# the scan returned on the first bare substring hit anywhere on the page — a
# "Villas" nav link, a related-projects rail, a footer, an ad, a
# "villa-style clubhouse" amenity, or the developer's other project all win
# outright. And there was no "apartment" entry AT ALL, so the single most
# common property type in Mumbai could never be produced; an apartment could
# only ever come out None or mislabelled.
#
# Order no longer decides anything (see _extract_property_type — it counts
# word-boundary matches and takes the most-stated type), but the specific
# types are still listed before the generic ones so that a genuine
# "3 BHK duplex apartment" resolves to Duplex on a tie rather than Apartment.
_PROPERTY_TYPE_TERMS = [
    ("villa", "Villa"), ("penthouse", "Penthouse"), ("row house", "Row House"),
    ("bungalow", "Bungalow"), ("plot", "Plot"), ("studio", "Studio Apartment"), ("duplex", "Duplex"),
    ("apartment", "Apartment"), ("flat", "Apartment"),
]

_NOT_A_DEVELOPER = {
    "owner", "agent", "broker", "appointment", "invite", "request",
    # Live bug: "developer": "Cloudflare Privacy" was returned as a real
    # builder name. These are WHOIS/CDN/registrar artifacts that appear in
    # page text and footers, never a promoter.
    "cloudflare", "privacy", "proxy", "whois", "redacted", "registrant",
    "godaddy", "namecheap", "domains", "registrar", "hostinger", "wordpress",
    "unknown", "n/a", "na", "tbd",
}


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


_NEAREST_WINDOW_CHARS = 1500


def _nearest_window(text: str, candidate: str, radius: int = _NEAREST_WINDOW_CHARS) -> Optional[str]:
    """The slice of the page around every mention of the candidate's name.

    _nearest_match anchors a REGEX to the candidate. This anchors a plain
    scan to it, for extractors that count occurrences rather than matching
    one pattern — so a related-projects rail or a footer further down the
    page cannot outvote the project the page is actually about.
    """
    if not candidate:
        return None
    spans = [m.start() for m in re.finditer(re.escape(candidate), text, re.IGNORECASE)]
    if not spans:
        return None
    return " ".join(text[max(0, p - radius):min(len(text), p + radius)] for p in spans[:5])


def _extract_area_facts(text: str) -> tuple[Optional[str], Optional[str]]:
    """Same "scan every '<N> sq ft' mention, bucket by nearby carpet/built-up
    keyword on EITHER side" approach as external-search.cjs's
    extractAreaFacts — both listing conventions ("650 sq ft carpet" and
    "carpet area: 650 sq ft") need to work.
    """
    carpet, built_up = None, None
    # (?<![\d,.]) — refuse to start mid-number. Without it "1,064 Sq.Ft."
    # yields "064 sq ft", which then reaches the config table as a real carpet
    # area (confirmed live on a propertycrow.com range "381 - 1,064 Sq.Ft.").
    for m in re.finditer(r"(?<![\d,.])(\d{3,5})\s*sq\.?\s*\.?\s*ft\.?", text, re.IGNORECASE):
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


# Live bugs, both shipped to a user as a project's builder: "Cloudflare
# Privacy" (a WHOIS/CDN artifact in page text) and "Dec" (a fragment of a
# possession date, "...by Dec 2027"). Both arrived via the _DEVELOPER_LABEL_RE
# branch below, which returned whatever it matched with NO validation at all —
# no blocklist, no length check — while the _DEVELOPER_BY_RE branch above did
# validate. One validator, applied to both.
_MONTHS = {"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept",
           "oct", "nov", "dec", "january", "february", "march", "april", "june",
           "july", "august", "september", "october", "november", "december"}
_WEEKDAYS = {"mon", "tue", "tues", "wed", "thu", "thurs", "fri", "sat", "sun"}


def _is_valid_developer_name(name: str) -> bool:
    """A wrong developer is worse than a null one — it is a specific, checkable
    claim about who is building someone's home.
    """
    if not name or len(name) > 60:
        return False
    words = re.findall(r"[A-Za-z]+", name)
    if not words:
        return False
    lowered = [w.lower() for w in words]
    # Any word being a registrar/CDN/privacy artifact disqualifies the whole
    # phrase, not just the first — "Cloudflare Privacy" failed a first-word-
    # only check when the artifact sat second.
    if any(w in _NOT_A_DEVELOPER for w in lowered):
        return False
    # A date fragment is never a builder. "Dec", "Dec 2027", "March".
    if all(w in _MONTHS or w in _WEEKDAYS for w in lowered):
        return False
    # Needs at least one real, non-date word of substance.
    if not any(len(w) >= 3 and w not in _MONTHS and w not in _WEEKDAYS for w in lowered):
        return False
    # Mostly digits ("2027 Ltd") reads as a date or a code, not a name.
    if len(re.findall(r"\d", name)) > len(re.findall(r"[A-Za-z]", name)):
        return False
    return True


def _extract_developer(text: str, candidate: Optional[str] = None) -> Optional[str]:
    m = _nearest_match(text, candidate, _DEVELOPER_BY_RE) if candidate else _DEVELOPER_BY_RE.search(text)
    if m:
        name = _clean(m.group(1))
        if _is_valid_developer_name(name):
            return name
    m = _nearest_match(text, candidate, _DEVELOPER_LABEL_RE) if candidate else _DEVELOPER_LABEL_RE.search(text)
    if m:
        name = _clean(m.group(1))
        if _is_valid_developer_name(name):
            return name
    return None


_PROPERTY_TYPE_MIN_MENTIONS = 2
_PROPERTY_TYPE_SNIPPET_CHARS = 400


def _extract_property_type(text: str, candidate: Optional[str] = None) -> Optional[str]:
    """The property type this page is actually ABOUT, not the first one it
    happens to mention.

    Three changes from the first-substring-hit version, each tied to a way
    the old one was wrong on real pages:

      * Word boundaries. "plot" matched inside "plots of land available
        nearby" — and inside "plotting"; "flat" matches "flatted factory".
      * Most-mentioned wins, not list order. A page about an apartment
        mentions "apartment" many times and "villa" once, in a nav link.
      * A single stray mention is not evidence. A type stated exactly once
        on a long page is ignored unless it is the ONLY type present, which
        is what kills the one-"Villas"-link-in-the-footer case outright.

    When a candidate name is known the scan is narrowed to the text around
    it first — same anchoring _extract_developer already uses — so a
    related-projects rail lower down the page cannot outvote the project the
    page is for. Ties break toward the more specific type (list order).
    """
    scan = text
    if candidate:
        near = _nearest_window(text, candidate)
        if near:
            scan = near
    t = scan.lower()
    counts: dict[str, int] = {}
    for term, label in _PROPERTY_TYPE_TERMS:
        n = len(re.findall(rf"\b{re.escape(term)}s?\b", t))
        if n:
            counts.setdefault(label, 0)
            counts[label] += n
    if not counts:
        # Nothing in the narrowed window — fall back to the whole page
        # rather than reporting None for a page that does state a type.
        if candidate and scan is not text:
            return _extract_property_type(text, candidate=None)
        return None
    order = {label: i for i, (_, label) in enumerate(_PROPERTY_TYPE_TERMS)}
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], order[kv[0]]))
    best = ranked[0]
    # A TIE is not a weak signal, it is the signature of a filter list.
    # Found by the T1-01/T1-10 test run, which still returned "Villa" for
    # "I Stay Tower in Marol" AFTER the most-mentioned-wins fix was live:
    # a portal category page renders "Property Type: Apartment | Villa |
    # Plot | Independent House", every term appears the same number of
    # times, and breaking that tie toward the more specific type handed the
    # answer to Villa. When the page does not state one type more often
    # than another, it is not telling us the type of anything.
    if len(ranked) > 1 and ranked[1][1] >= best[1]:
        return None
    # On a full page one passing mention is furniture, not a statement about
    # this project. On a title or a search snippet one mention is the whole
    # of what the source said, so it counts.
    threshold = 1 if len(t) < _PROPERTY_TYPE_SNIPPET_CHARS else _PROPERTY_TYPE_MIN_MENTIONS
    if best[1] < threshold:
        return None
    return best[0]


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


# ── JSON-LD / structured-data extraction ────────────────────────────────────
# agent-tools-bridge.cjs:300 (extractJsonLd) already parses every
# <script type="application/ld+json"> block off every page this pipeline
# fetches, and hands them over as FetchedPage["structured_data"]. Until now
# the ONLY consumer was _name_from_structured_data() — the project name was
# read and the rest of the payload discarded, while the regex pass and a
# bounded LLM chased the same facts through the page's prose.
#
# This is the cheapest source in the whole harness: already downloaded, no
# network call, no LLM call, and published by the site FOR machines to read,
# so it is both more reliable than prose scraping and uncomplicated to use.
#
# Deliberately ADDITIVE and non-destructive:
#   * It runs first, but dedupe.merge_extracted_facts() only writes a
#     top-level field when that field is still empty, so nothing here can
#     overwrite a value the existing pipeline already established.
#   * It emits the SAME field names deterministic_extract() already emits,
#     so no downstream mapping, scoring rule or UI key changes.
#   * A field absent from the payload is simply not emitted. Never a
#     default, never an inferred value (Rule 2).
# If the structured data is missing or malformed, this returns [] and the
# existing regex path runs exactly as it does today.

_SD_PROPERTY_TYPES = {
    "residence", "apartment", "apartmentcomplex", "singlefamilyresidence",
    "house", "product", "place", "realestatelisting", "accommodation",
    "offer", "aggregateoffer", "localbusiness", "realestateagent",
}


def _sd_iter_nodes(blob, depth: int = 0):
    """Yields every dict in a JSON-LD payload, following @graph, arrays and
    nested values. Real pages nest these arbitrarily (a @graph of a Product
    whose offers is an array of Offers), so a flat top-level scan misses most
    of what is actually there.
    """
    if depth > 8 or blob is None:
        return
    if isinstance(blob, list):
        for item in blob:
            yield from _sd_iter_nodes(item, depth + 1)
        return
    if not isinstance(blob, dict):
        return
    yield blob
    for value in blob.values():
        if isinstance(value, (dict, list)):
            yield from _sd_iter_nodes(value, depth + 1)


def _sd_types(node: dict) -> set:
    raw = node.get("@type") or node.get("type") or []
    if isinstance(raw, str):
        raw = [raw]
    return {str(t).split("/")[-1].strip().lower() for t in raw if t}


def _sd_text(value) -> Optional[str]:
    """Schema.org values are wildly inconsistent — a bare string, a
    {"@value": ...} wrapper, a list of either, or a nested node with a name.
    Normalizes to one clean string, or None when there is nothing usable.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return _clean(value) or None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        for item in value:
            got = _sd_text(item)
            if got:
                return got
        return None
    if isinstance(value, dict):
        for key in ("@value", "name", "value", "text"):
            got = _sd_text(value.get(key))
            if got:
                return got
    return None


def _sd_quantitative(value) -> Optional[str]:
    """QuantitativeValue -> a display string ("650 sq ft"). Accepts the bare
    string form too, since plenty of pages emit floorSize as text.
    """
    if isinstance(value, dict):
        number = value.get("value") or value.get("@value")
        unit = _sd_text(value.get("unitText")) or _sd_text(value.get("unitCode")) or ""
        if number is None:
            return _sd_text(value)
        unit_l = str(unit).lower()
        if unit_l in ("sqft", "ft2", "foot", "square foot", "square feet", "sq ft", "fte"):
            unit = "sq ft"
        elif unit_l in ("mtk", "sqm", "m2", "square metre", "square meter"):
            unit = "sq m"
        return _clean(f"{number} {unit}".strip())
    return _sd_text(value)


def _sd_amenities(node: dict) -> list:
    """amenityFeature is a LocationFeatureSpecification (or a list of them).
    Only a feature explicitly marked available counts — an entry with
    value=False is the page stating the amenity is ABSENT, and reading it as
    present would be exactly the kind of confident-but-wrong fact Rule 2
    exists to prevent.
    """
    out: list = []
    raw = node.get("amenityFeature") or node.get("amenities")
    if raw is None:
        return out
    items = raw if isinstance(raw, list) else [raw]
    for item in items:
        if isinstance(item, dict):
            if item.get("value") is False:
                continue
            name = _sd_text(item.get("name")) or _sd_text(item)
        else:
            name = _sd_text(item)
        if name and name.lower() not in [o.lower() for o in out]:
            out.append(name)
    return out


def extract_from_structured_data(candidate: str, page: FetchedPage) -> list[ExtractedFact]:
    """Deterministic facts read out of the page's own JSON-LD. Returns [] when
    the page carries none, or none of a shape we recognise — never a guess at
    an unknown shape.
    """
    blocks = page.get("structured_data") or []
    if not blocks:
        return []

    source = (page.get("metadata") or {}).get("source_name") or page.get("url") or "web"
    retrieved_at = page.get("retrieved_at") or datetime.now(timezone.utc).isoformat()
    url = page.get("url")
    facts: list[ExtractedFact] = []
    seen: set = set()

    def emit(field: str, value, confidence: str = "high", **kwargs):
        # "high" by default: this is the publisher's own machine-readable
        # statement of the fact, not a phrase a regex found near a keyword.
        if value is None or value == "" or value == []:
            return
        if field in seen:
            return
        seen.add(field)
        facts.append(ExtractedFact(
            candidate=candidate, field=field, value=value, source=source,
            source_url=url, retrieved_at=retrieved_at, confidence=confidence,
            method="deterministic", **kwargs,
        ))

    try:
        nodes = [n for n in _sd_iter_nodes(blocks) if isinstance(n, dict)]
    except Exception:  # noqa: BLE001 — malformed JSON-LD must never break extraction
        logger.debug("[structured-data] unwalkable payload on %s", url)
        return []

    relevant = [n for n in nodes if _sd_types(n) & _SD_PROPERTY_TYPES] or nodes

    for node in relevant:
        try:
            types = _sd_types(node)

            if "offer" in types or "aggregateoffer" in types:
                low = node.get("lowPrice") or node.get("price")
                high = node.get("highPrice")
                if low is not None:
                    display = f"{low} - {high}" if high is not None else str(low)
                    emit("price", _clean(display))
                continue

            emit("project_name", _sd_text(node.get("name")))

            addr = node.get("address")
            if isinstance(addr, dict):
                locality = (_sd_text(addr.get("addressLocality"))
                            or _sd_text(addr.get("addressRegion"))
                            or _sd_text(addr.get("streetAddress")))
                emit("location_from_structured_data", locality)
            elif addr is not None:
                emit("location_from_structured_data", _sd_text(addr))

            geo = node.get("geo")
            if isinstance(geo, dict):
                lat, lon = geo.get("latitude"), geo.get("longitude")
                if lat is not None and lon is not None:
                    # Not consumed by the map yet — the Location Map still
                    # reads placesLat/placesLon. Emitted so the coordinate is
                    # captured with provenance now, and wiring it up later is
                    # a read, not another fetch.
                    emit("latitude", str(lat))
                    emit("longitude", str(lon))

            emit("carpet_area", _sd_quantitative(node.get("floorSize")))
            emit("built_up_area", _sd_quantitative(node.get("builtUpArea")))

            rooms = node.get("numberOfBedrooms") or node.get("numberOfRooms")
            rooms_text = _sd_quantitative(rooms) if rooms is not None else None
            if rooms_text:
                emit("configuration_from_structured_data", rooms_text)

            floors = node.get("numberOfFloors") or node.get("floorLevel")
            emit("total_floors", _sd_text(floors))

            price = node.get("price") or node.get("priceRange")
            emit("price", _sd_text(price))

            amenities = _sd_amenities(node)
            if amenities:
                emit("amenities", amenities)

            for key in ("brand", "provider", "author", "developer", "builder"):
                dev = _sd_text(node.get(key))
                if dev:
                    emit("developer", dev)
                    break

            desc = _sd_text(node.get("description"))
            if desc and len(desc) > 40:
                emit("description_from_structured_data", desc)

        except Exception:  # noqa: BLE001 — one odd node must not lose the others
            logger.debug("[structured-data] skipped an unreadable node on %s", url)
            continue

    if facts:
        logger.info("[structured-data] %s: %d field(s) from JSON-LD (%s)",
                    (candidate or "?")[:60], len(facts), ", ".join(f["field"] for f in facts))
    return facts


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

    # JSON-LD first — the publisher's own machine-readable statement of these
    # facts, already downloaded with this page. Ordered ahead of the regex
    # pass only so its higher-confidence entry lands first in field_evidence;
    # it cannot suppress or overwrite anything below, because every fact from
    # both passes goes through the same conflict-preserving merge.
    facts.extend(extract_from_structured_data(candidate, page))

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
    emit("property_type", _extract_property_type(text, anchor_name))

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


# ── Candidate-name gate ─────────────────────────────────────────────────────
# Real, measured failure (live "2bhk in bandra west" trace): the eligibility
# loop's candidate list GREW every pass — 18 -> 26 -> 44 — because every page
# this pipeline fetches gets mined for new candidate names, and
# _nearest_project_name() below accepts "the nearest Title-Case phrase within
# 150 characters of a RERA number" as a project. On a real portal page the
# text near a RERA number is a download button, a brokerage tag, an amenity
# chip or a street name, so pass 3 was researching things like:
#
#   "Download-Icon Rera-Tag No"   "Rera-Tag No-Brokerage-Tag"
#   "Download-Icon Shortlist-Button Tuple"   "Instagram"
#   "Kids Play Pool With Water"   "Sea View"   "Nearby Landmark"
#   "Hill Road"   "Linking Road"   "Bandra West"
#   "crores to 5 crores - Property in Bandra West, Mumbai"
#
# Each of those then consumed a full per-candidate LLM chunk budget, and each
# page fetched on its behalf bred more of the same — a feedback loop, not a
# long list. That, not extraction quality, is what produced 481s runs and
# constant Groq 429s.
#
# The old guard was _is_generic_phrase(), a BLOCKLIST of filler words. A
# blocklist cannot win here: nobody can enumerate every button label and
# amenity chip on the Indian property web. What follows is a structural
# reject test instead — it asks "does this string look like page furniture,
# a street, a locality, or an SEO page title?" rather than trying to list
# every junk phrase.
#
# Deliberately a REJECT test, not a positive allowlist. A strict "must
# contain a known developer or a residential suffix" rule would also have
# dropped real candidates from this same trace ("Two Roses", "Inspira One",
# "Bhoomi Amogh"), and silently losing real projects is worse than keeping a
# borderline one. Every rejection returns its reason so it can be logged and
# argued with, never a silent drop.

# Page chrome, controls and site furniture — text that only exists because a
# web page has buttons.
_NAME_REJECT_UI = (
    "icon", "button", "tuple", "shortlist", "download", "dropdown", "checkbox",
    "breadcrumb", "navbar", "sitemap", "tag no", "-tag", "brokerage", "read more",
    "view all", "click here", "sign in", "log in", "contact us", "get callback",
    "enquire now", "post property", "advertise", "cookie", "subscribe",
)

# Social platforms — a post is never a project.
_NAME_REJECT_SOCIAL = (
    "instagram", "facebook", "twitter", "youtube", "linkedin", "whatsapp",
    "pinterest", "telegram",
)

# SEO / listing-page title markers. A name carrying one of these is a page
# title that happens to mention a project, not the project's own name.
_NAME_REJECT_TITLE = (
    "price list", "floor plan", "amenities", "reviews", "review", "faq",
    "common questions", "for sale", "for rent", "properties in", "property in",
    "flats in", "apartments in", "projects in", "builders in", "developers in",
    "top real estate", "new projects", "ready to move", "resale", "sq ft",
    "sqft", "per sq", "crore", "lakh", "brochure", "photos", "videos",
    "near me", "price &", "& review", "buy ", "rent ", "onwards",
    "99acres", "magicbricks", "quikrhomes", "housing.com", "squareyards",
    "nobroker", "realtypromoo", "makaan", "commonfloor", "proptiger",
    # "projects by" — PLURAL, and the plural is the whole point. Caught in
    # the T1-01/T1-10 test run: "Under Construction Projects by I STAY
    # HOUSING PRIVATE LIMITED" reached the results twice. It slipped through
    # because the list already had "new projects" and "projects in" but not
    # "projects by" — a developer's category page listing ALL their projects.
    #
    # The SINGULAR "new project by <Developer>" must keep passing: it is a
    # real, self-announcing developer marketing phrase for ONE project, and
    # normalize.NEW_LAUNCH_RE deliberately treats it as a launch signal (see
    # its comment about the live Pastonji Bliss Tower caption). Substring
    # matching gives us that for free — "projects by" cannot match "project
    # by". That distinction is load-bearing; do not "simplify" this to
    # "project by".
    "projects by",
    # Added from the live "2 BHK in Kandarpada" trace, where these reached
    # deep research and burned real LLM budget: an encyclopedia article
    # ("Kandarpada metro station - Wikipedia"), a portal's own boilerplate
    # ("India Real Estate Property Site"), and a price fragment
    # ("Cr Onwards", caught by "onwards" above).
    "wikipedia", "real estate", "property site", "property portal",
    "metro station", "railway station", "bus station",
)

# A publisher's domain appended after a dash ("... - Ghar.tv", "... -
# Housing.com"). Matched rather than listed, since the set of Indian property
# publishers is open-ended; see _strip_title_noise for why this is the ONLY
# case where a plain " - " is treated as a title separator.
_NAME_PUBLISHER_TAIL_RE = re.compile(r"\s+[-–—]\s+[A-Za-z0-9][\w-]*\.[A-Za-z]{2,5}\s*$")

# Amenity / feature vocabulary. Only rejects when the name is made ENTIRELY of
# these plus filler — "Prof. Almeida Park" keeps its distinctive words and
# survives, "Kids Play Pool With Water" does not.
_NAME_AMENITY_WORDS = {
    "pool", "swimming", "gym", "gymnasium", "view", "sea", "garden", "park",
    "club", "clubhouse", "play", "kids", "children", "parking", "lift",
    "elevator", "terrace", "deck", "balcony", "landmark", "landmarks",
    "nearby", "water", "jogging", "track", "security", "cctv", "gazebo",
    "lawn", "yoga", "spa", "gate", "power", "backup", "amenity", "amenities",
    "facility", "facilities", "feature", "features", "nearest", "connectivity",
    # Qualifiers that only ever appear attached to an amenity ("Covered
    # Parking", "Reserved Parking", "Open Terrace") — harmless on a real name,
    # since the all()-test below still needs EVERY word to be amenity-ish.
    "covered", "open", "reserved", "allotted", "dedicated", "visitor",
    "common", "indoor", "outdoor", "rooftop", "multipurpose", "hall", "area",
    "zone", "corner", "court", "room", "centre", "center", "space",
    "facing", "front", "side", "level", "floor", "floors", "access",
    "ground", "basement", "podium", "stilt", "upper", "lower", "entrance",
}

# Joining words, so an amenity chip written as a phrase ("Kids Play Pool With
# Water") still tests as entirely-amenity. Kept local rather than relying on
# normalize.GENERIC_FILLER_WORDS containing every preposition — that list is
# tuned for a different job and must not be widened for this one.
_NAME_CONNECTOR_WORDS = {
    "with", "and", "the", "of", "a", "an", "in", "at", "for", "to", "by", "on",
    "or", "from", "plus", "amp",
}

# Last-word test for streets and infrastructure. "Hill Road" and "Linking
# Road" are roads; "Link Road Residency" ends in Residency and survives.
_NAME_ROUTE_LAST_WORDS = {
    "road", "rd", "marg", "street", "st", "lane", "chowk", "circle", "junction",
    "highway", "expressway", "flyover", "bridge", "crossing", "naka", "phatak",
    "station", "depot", "bypass", "corridor",
}

# Trailing city qualifiers stripped before testing, so "Balmoral Hall Bandra
# West, Mumbai" is judged on "Balmoral Hall Bandra West".
_NAME_TRAILING_CITIES = (
    "mumbai", "navi mumbai", "thane", "pune", "dubai", "maharashtra", "india",
)

_NAME_TITLE_SPLIT_RE = re.compile(r"\s*[|—–]\s*")

# Portal furniture that gets appended to a REAL project's name after a colon or
# a dash: "Arkade Eden Malad West: Price, Photos & Floor Plans". Rejecting those
# outright dropped a genuine project (caught by test_lifecycle_and_eligibility's
# dedup regression, which needs both spellings of the same project to survive
# and merge). The tail is cut only when it actually looks like furniture, so
# "Sunteck City - Avenue 2" and "Bandra West: An affluent residential pocket"
# are both left exactly as they were — the first is a real phase name, the
# second must still be rejected as a headline.
_SEO_TAIL_MARKERS = (
    "price", "photo", "floor plan", "brochure", "pros", "cons", "review",
    "amenit", "faq", "gallery", "video", "rates", "offers", "pricesheet",
    "price sheet", "location map", "master plan", "specification",
)
_SEO_TAIL_SPLIT_RE = re.compile(r"\s*(?::|\s-\s|\s–\s)\s*")


def _strip_title_noise(name: str) -> str:
    """Trims an SEO page title down to the part that might be a real project
    name. Splits on the separators portals actually use to append their own
    branding ("|", em dash, en dash) and keeps the FIRST segment, then drops a
    trailing city qualifier.

    Deliberately does NOT split on a plain " - ": real project names use it
    for phases and locality suffixes ("Silverbay By Transcon - Bandra West",
    "Sunteck City - Avenue 2"), and truncating there would merge distinct
    phases of the same development into one candidate.

    This runs BEFORE the reject test, so it recovers real projects that were
    only failing because of the publisher's tail — e.g. "Hiranandani Bay
    Heights Bandra West - Price & Review | RealtyPromoo" is judged on
    "Hiranandani Bay Heights Bandra West" and survives.
    """
    head = _NAME_TITLE_SPLIT_RE.split(name.strip())[0].strip()
    if not head:
        head = name.strip()
    # "Rishab Mahesh Darshan Dahisar West, Mumbai - Ghar.tv" -> drop the
    # publisher, keep the project. Only fires when what follows the dash
    # looks like a domain, so real hyphenated names ("Sunteck City - Avenue
    # 2") are untouched.
    head = _NAME_PUBLISHER_TAIL_RE.sub("", head).strip()
    # Cut a ": <furniture>" / " - <furniture>" tail, and only that.
    first, sep, tail = re.split(r"(:|\s-\s|\s–\s)", head, maxsplit=1) + ["", ""] if False else (
        (lambda parts: (parts[0], parts[1] if len(parts) > 1 else "", parts[2] if len(parts) > 2 else ""))(
            re.split(r"(:|\s-\s|\s–\s)", head, maxsplit=1)))
    if sep and tail and any(marker in tail.lower() for marker in _SEO_TAIL_MARKERS) and len(first.strip()) >= 4:
        head = first.strip()
    lowered = head.lower()
    for city in _NAME_TRAILING_CITIES:
        for sep in (", ", " - ", " "):
            suffix = f"{sep}{city}"
            if lowered.endswith(suffix) and len(head) > len(suffix) + 3:
                head = head[: -len(suffix)].strip().rstrip(",-–—")
                lowered = head.lower()
                break
    return head.strip().strip(",-–—").strip()


def candidate_name_reject_reason(name: str) -> Optional[str]:
    """Returns why `name` is not a plausible project name, or None if it is
    acceptable. Structural only — no network call, no LLM, no gazetteer of
    project names (we do not have one; if we ever do, it belongs here as an
    additional ACCEPT signal, not as a replacement for these rejects).
    """
    if not name:
        return "empty"
    cleaned = _strip_title_noise(name)
    if not cleaned:
        return "empty after title-noise strip"
    lowered = cleaned.lower()

    if len(cleaned) < 3:
        return "too short to be a project name"
    if len(cleaned) > 90:
        return "too long — reads as a page title, not a name"

    words = re.findall(r"[A-Za-z]+", lowered)
    if not words:
        return "no alphabetic words"
    if len(words) > 10:
        return "too many words — reads as a sentence or headline"

    # A colon in a name is a headline construction ("L Nagpal Builders: One of
    # the Mumbai's Top Developer", "Bandra West: An affluent residential
    # pocket"), never how a project is named.
    if ":" in cleaned:
        return "contains ':' — headline, not a project name"

    for marker in _NAME_REJECT_UI:
        if marker in lowered:
            return f"page furniture ({marker!r})"
    for marker in _NAME_REJECT_SOCIAL:
        if marker in lowered:
            return f"social platform ({marker!r})"
    for marker in _NAME_REJECT_TITLE:
        if marker in lowered:
            return f"SEO/listing page title ({marker!r})"

    if words[-1] in _NAME_ROUTE_LAST_WORDS:
        return f"street or infrastructure name (ends in {words[-1]!r})"

    # A dangling article is the signature of a truncated page title
    # ("Mumbai The"), never how a project is named.
    if words[-1] in ("the", "a", "an", "of", "in", "at", "and"):
        return f"truncated fragment (ends in {words[-1]!r})"

    from .normalize import GENERIC_FILLER_WORDS
    if all(w in _NAME_AMENITY_WORDS or w in _NAME_CONNECTOR_WORDS or w in GENERIC_FILLER_WORDS
           for w in words):
        return "amenity or feature label, not a project"

    # A bare locality is the single most damaging false candidate: it matches
    # the query, so it ranks first, and then every enrichment call is spent on
    # a neighbourhood. Checked against the SAME shared gazetteer the rest of
    # the repo uses — never a second location list. base_locality() is used so
    # "Bandra West" and "Bandra" are both caught.
    try:
        from . import gazetteer as gazetteer_mod
        localities = gazetteer_mod._city_locality_index()
        aliases = gazetteer_mod._alias_index()

        def _is_locality(term: str) -> bool:
            t = term.strip().lower()
            return bool(t) and (t in localities or t in aliases
                                or gazetteer_mod.base_locality(t) in localities)

        if _is_locality(lowered):
            return "bare locality name from the shared gazetteer"
        # "Kandarpada, Dahisar West" — a locality and its parent suburb, comma
        # joined. Reached deep research in the live Kandarpada trace and spent
        # six LLM calls finding nothing, because there is nothing: it is a
        # neighbourhood, not a building. Every comma-separated part being a
        # known locality is the signal; a real project with a locality suffix
        # ("Balmoral Hall Bandra West") still has its own distinctive part.
        parts = [x for x in (seg.strip() for seg in cleaned.split(",")) if x]
        if len(parts) > 1 and all(_is_locality(x) for x in parts):
            return "locality pair from the shared gazetteer, not a project"

        # Space-joined locality stacks — "Chikoowadi Borivali West" reached the
        # #1 result slot in a live run and consumed a full six-call enrichment
        # budget, because it is not a comma pair and not an exact gazetteer
        # match. Strip every known place name (longest first, so "Borivali
        # West" goes before "Borivali") and see whether anything distinctive is
        # left. A real project keeps its own word — "Balmoral Hall Bandra West"
        # still has "Balmoral Hall"; a locality stack has nothing left at all.
        remainder = lowered
        for term in sorted(set(list(localities) + list(aliases)), key=len, reverse=True):
            if len(term) < 4:
                continue
            if term in remainder:
                remainder = remainder.replace(term, " ")
        leftover = [w for w in re.findall(r"[a-z]+", remainder)
                    if w not in GENERIC_FILLER_WORDS and w not in _NAME_CONNECTOR_WORDS
                    and w not in ("mumbai", "thane", "pune", "maharashtra", "india", "west", "east", "north", "south")]
        if not leftover:
            return "made entirely of gazetteer place names — a location, not a project"
    except Exception:  # noqa: BLE001 — a gazetteer read failure must not reject a real name
        pass

    return None


def sanitize_candidate_name(name: Optional[str]) -> Optional[str]:
    """The single entry point every candidate name passes through. Returns the
    cleaned name when it is plausibly a project, else None (with the reason
    logged at debug level so a wrongly-dropped name is diagnosable).
    """
    if not name or not name.strip():
        return None
    reason = candidate_name_reject_reason(name)
    if reason:
        logger.debug("[candidate-gate] rejected %r: %s", name, reason)
        return None
    return _strip_title_noise(name)


def _nearest_project_name(text: str, rera_start: int, rera_end: int) -> Optional[str]:
    # Highest confidence: the explicit "<RERA number> is the RERA number of
    # the project <NAME>" phrasing — the name is stated outright, not
    # inferred from capitalization at all.
    # Every return below goes through sanitize_candidate_name() — see the
    # candidate-gate block above. Without it this function's "nearest
    # Title-Case phrase" heuristic happily returns the download button or
    # amenity chip that sits next to a RERA number on a real portal page, and
    # each one becomes a candidate that consumes a full research budget.
    window = text[max(0, rera_start - 40):min(len(text), rera_end + 160)]
    explicit = _RERA_OF_PROJECT_RE.search(window)
    if explicit:
        name = sanitize_candidate_name(_clean(explicit.group(1)))
        if name and not _is_generic_phrase(name):
            return name

    # Fallback: the nearest real (non-generic) Title-Case phrase — checked
    # BEFORE the RERA number first (the far more common portal layout is
    # "Name ... facts ... RERA: <number>"), then after. Scans outward instead
    # of taking only the single nearest match: the nearest phrase is very
    # often page furniture, and the real name sits just past it.
    before = text[max(0, rera_start - 150):rera_start]
    candidates_before = [m.group(0) for m in _TITLE_CASE_PHRASE_RE.finditer(before) if not _is_generic_phrase(m.group(0))]
    for raw in reversed(candidates_before):  # nearest first, walking backwards
        name = sanitize_candidate_name(_clean(raw))
        if name:
            return name

    after = text[rera_end:min(len(text), rera_end + 150)]
    candidates_after = [m.group(0) for m in _TITLE_CASE_PHRASE_RE.finditer(after) if not _is_generic_phrase(m.group(0))]
    for raw in candidates_after:  # nearest first, walking forwards
        name = sanitize_candidate_name(_clean(raw))
        if name:
            return name

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
