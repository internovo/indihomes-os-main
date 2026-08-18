"""Deterministic query understanding — a line-for-line Python port of
query-parser.cjs's extraction rules (the same file /api/nl-filters and AI
Search already use on the Node side), so Property Search and this agent
agree on what "2 BHK in Borivali East under 1.5 Cr" means. This is
intentionally NOT a second, independently-invented parser — every regex
here mirrors its Node counterpart 1:1, including the directional-suffix
fix and amenity vocabulary added there in the same pass as this agent.

An optional LLM assist (query_understanding_llm_assist) can add free-text
`keywords` the deterministic pass doesn't try to capture (e.g. "with a
view", "corner unit") — but it NEVER overrides a deterministic field
(location/config/budget/possession/amenities all stay 100% regex-derived,
per the brief's "LLM is not the source of truth" rule).
"""
from __future__ import annotations

import re
from typing import Optional

from .gazetteer import base_locality, load_gazetteer, resolve_location
from .state import ParsedRequirements, ResolvedLocation

BHK_STOPWORDS = {
    "under", "near", "ready", "move", "bhk", "cr", "crore", "lakh", "lakhs",
    "budget", "possession", "by", "for", "with", "and", "the", "in", "at",
    "between", "from", "to", "flat", "flats", "apartment", "apartments",
    "property", "properties", "project", "projects", "home", "homes",
}


def _is_stopword(w: str) -> bool:
    return w.lower() in BHK_STOPWORDS


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _proper_case(s: str) -> str:
    return " ".join(w[:1].upper() + w[1:].lower() for w in _clean(s).split(" ") if w)


def extract_budget_max_cr(text: str) -> Optional[float]:
    t = text.lower()
    m = re.search(r"(\d+\.?\d*)\s*(?:l|lakh|lakhs)?\s*[-–to]+\s*(\d+\.?\d*)\s*cr", t)
    if m:
        return float(m.group(2))
    m = re.search(r"(\d+\.?\d*)\s*(?:cr|crore)", t)
    if m:
        return float(m.group(1))
    m = re.search(r"(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*(?:l|lakh|lakhs)\b", t)
    if m:
        return float(m.group(2)) / 100
    m = re.search(r"(\d+\.?\d*)\s*(?:l|lakh|lakhs)\b", t)
    if m:
        return float(m.group(1)) / 100
    return None


def extract_configuration(text: str) -> str:
    m = re.search(r"(\d+(?:\s*[&,]\s*\d+)+)\s*(?:BHK|bed(?:room)?s?)", text, re.IGNORECASE)
    if m:
        nums = re.findall(r"\d+", m.group(1))
        return " & ".join(f"{n} BHK" for n in nums)
    m = re.search(r"(\d+)\s*(?:BHK|bed(?:room)?s?)", text, re.IGNORECASE)
    if m:
        return f"{m.group(1)} BHK"
    if re.search(r"\bstudio\b", text, re.IGNORECASE):
        return "Studio"
    return ""


def extract_possession(text: str) -> str:
    t = text.lower()
    if re.search(r"ready to move|immediate possession|move[-\s]?in ready|ready possession", t):
        return "Ready to Move"
    m = re.search(r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{4})", text, re.IGNORECASE)
    if m:
        return f"{m.group(1)[:3]} {m.group(2)}"
    m = re.search(r"q([1-4])\s*[/\-]?\s*(\d{4})", t)
    if m:
        return f"Q{m.group(1)} {m.group(2)}"
    m = re.search(r"by\s+(20\d\d)", t)
    if m:
        return m.group(1)
    m = re.search(r"\b(20\d\d)\b", t)
    if m:
        return m.group(1)
    return ""


AMENITY_TERMS = [
    "swimming pool", "pool", "gym", "gymnasium", "clubhouse", "club house",
    "garden", "jogging track", "kids play area", "children's play area",
    "play area", "security", "power backup", "lift", "elevator", "parking",
    "terrace", "deck", "private deck", "yoga", "amphitheatre", "sports court",
    "tennis court", "badminton court", "indoor games", "party hall",
    "banquet hall", "senior citizen", "jacuzzi", "sauna", "spa", "library",
    "co-working",
]


def extract_amenities(text: str) -> list[str]:
    t = text.lower()
    found = [a for a in AMENITY_TERMS if a in t]
    # Drop a shorter term wholly contained in a longer matched term
    # ("pool" inside "swimming pool", "deck" inside "private deck").
    return [a for a in found if not any(b != a and a in b and len(b) > len(a) for b in found)]


from functools import lru_cache


@lru_cache(maxsize=1)
def _known_gazetteer_terms() -> list[str]:
    """Every locality/alias name the shared gazetteer actually knows about,
    longest-first so "Malad West" is tried before the shorter "Malad" and
    "Liberty Garden" is found as its own term rather than swallowed into a
    longer generic capture. Purely data-driven (reads mmr-gazetteer.json),
    not a hardcoded place list.
    """
    g = load_gazetteer()
    terms: set[str] = set()
    for locs in (g.get("cities") or {}).values():
        terms.update(locs)
    for alias in (g.get("aliases") or {}).values():
        terms.add(alias["canonical"])
    return sorted(terms, key=len, reverse=True)


def _gazetteer_scan_locations(text: str) -> list[str]:
    """Scans the raw query text for literal, known gazetteer terms as
    whole-word phrases (case-insensitive), longest match first, marking
    matched spans so a shorter term can't also match inside an
    already-claimed span (e.g. "Malad" inside an already-matched "Malad
    West"). This is what correctly splits "...on Liberty Garden Malad
    West" into TWO locations ("Liberty Garden" + "Malad West") instead of
    the generic directional-suffix tier below swallowing both into one
    unresolvable string — "Liberty Garden" is a real gazetteer alias, this
    tier is what actually finds it.
    """
    claimed = [False] * len(text)
    found: list[tuple[int, str]] = []
    for term in _known_gazetteer_terms():
        for m in re.finditer(re.escape(term), text, re.IGNORECASE):
            start, end = m.start(), m.end()
            if any(claimed[start:end]):
                continue
            # Whole-word boundary check (avoid "Malad" matching inside "Maladjusted").
            before_ok = start == 0 or not text[start - 1].isalnum()
            after_ok = end == len(text) or not text[end].isalnum()
            if not (before_ok and after_ok):
                continue
            for i in range(start, end):
                claimed[i] = True
            found.append((start, term))
    found.sort(key=lambda x: x[0])
    return [t for _, t in found]


def extract_locations(text: str) -> list[str]:
    gazetteer_hits = _gazetteer_scan_locations(text)
    if len(gazetteer_hits) >= 1:
        return [_proper_case(h) for h in dict.fromkeys(gazetteer_hits)][:5]

    found: list[str] = []

    phrase_re = re.compile(
        r"\b(?:in|at|near|around)\s+([A-Za-z][A-Za-z\s]{1,30}?)"
        r"(?=\s+(?:under|for|with|by|possession|budget|bhk|ready|\d)|[,.]|$)",
        re.IGNORECASE,
    )
    for m in phrase_re.finditer(text):
        loc = _clean(m.group(1))
        if loc and len(loc) > 2 and not _is_stopword(loc):
            found.append(loc)

    # Directional-suffix tier — same fix as query-parser.cjs: catches
    # "Borivali east" typed with a lowercase direction word, which the
    # Title-Case-only tier below would otherwise collapse to just "Borivali".
    if not found:
        dir_re = re.compile(r"\b((?:[A-Za-z]+\s+){0,2}[A-Za-z]+)\s+(east|west|north|south)\b", re.IGNORECASE)
        for m in dir_re.finditer(text):
            words = _clean(m.group(1)).split(" ")
            if all(_is_stopword(w) for w in words):
                continue
            found.append(f"{_clean(m.group(1))} {m.group(2)}")

    if not found:
        cap_re = re.compile(r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b")
        for m in cap_re.finditer(text):
            words = m.group(1).split(" ")
            if all(_is_stopword(w) for w in words):
                continue
            if len(m.group(1)) > 2:
                found.append(m.group(1))

    if not found:
        trimmed = text.strip()
        words = trimmed.split() if trimmed else []
        if 1 <= len(words) <= 4 and not re.search(r"\d", trimmed) and not re.search(r"[.,!?]", trimmed):
            non_stop = [w for w in words if not _is_stopword(w) and len(w) > 1]
            if non_stop and len(non_stop) == len(words):
                found.append(_clean(" ".join(non_stop)))

    seen = []
    for f in found:
        pc = _proper_case(f)
        if pc not in seen:
            seen.append(pc)
    return seen[:5]


def _mask_locations(text: str, locations: list[str]) -> str:
    """Blanks out already-extracted location substrings before amenity
    extraction runs, so a locality name that happens to contain a generic
    amenity word ("Liberty GARDEN") is never misread as a request for that
    amenity. Longest-first so a shorter location name can't leave a
    fragment of a longer one behind.
    """
    masked = text
    for loc in sorted(locations, key=len, reverse=True):
        masked = re.sub(re.escape(loc), " ", masked, flags=re.IGNORECASE)
    return masked


def parse_query(text: str, market: str = "india") -> ParsedRequirements:
    """The deterministic core — identical output shape/semantics to
    query-parser.cjs's parseNLQuery(), plus amenities (also added there in
    this same pass).
    """
    cr = extract_budget_max_cr(text)
    possession_text = extract_possession(text)
    year_match = re.search(r"20\d\d", possession_text)
    locations = extract_locations(text)
    return ParsedRequirements(
        locations=locations,
        configurations=[extract_configuration(text)] if extract_configuration(text) else [],
        budget_max_cr=cr,
        possession_text=possession_text or None,
        possession_year_max=int(year_match.group(0)) if year_match and "ready" not in possession_text.lower() else None,
        amenities=extract_amenities(_mask_locations(text, locations)),
        keywords=[],
        market=market,
    )


def resolve_all_locations(locations: list[str]) -> list[ResolvedLocation]:
    """Runs every extracted location term through the shared gazetteer —
    the exact same resolution Property Search's LocationCombobox and
    scoring.cjs use, so "Liberty Garden" resolves to Malad West here too.
    """
    return [resolve_location(loc) for loc in locations]
