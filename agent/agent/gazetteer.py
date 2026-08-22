"""Loads the SAME mmr-gazetteer.json the Node frontend/backend already use
(src/components/screens/ProjectSelection.jsx's LocationCombobox, scoring.cjs,
azure-search.cjs, legacy-portal-connector.cjs) — one shared gazetteer file,
not a second location intelligence system. This module only *reads* it and
adds no locations of its own.
"""
from __future__ import annotations

import difflib
import json
import logging
from functools import lru_cache
from pathlib import Path

# ai-search-agent/agent/gazetteer.py -> repo root is two levels up.
_SHARED = Path(__file__).resolve().parent.parent.parent / "shared"
GAZETTEER_PATH = _SHARED / "mmr-gazetteer.json"
# One file per market, same schema, same contract. Dubai was added because a
# market='dubai' search had NO gazetteer at all: every locality resolved to
# itself with parent=None and city=None, which forced graph.py's geography
# gate into exact-phrase-only matching (a listing saying "Marina, Dubai" was
# rejected for a "Dubai Marina" query) and made derive_city() return None for
# every Dubai property. It also printed a warning telling the user to add
# their Dubai locality to the *Mumbai* gazetteer.
GAZETTEER_PATHS = {
    "india": GAZETTEER_PATH,
    "dubai": _SHARED / "dubai-gazetteer.json",
}
DEFAULT_MARKET = "india"

logger = logging.getLogger("ai-search-agent.gazetteer")


@lru_cache(maxsize=4)
def load_gazetteer(market: str = DEFAULT_MARKET) -> dict:
    path = GAZETTEER_PATHS.get(market or DEFAULT_MARKET, GAZETTEER_PATH)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=4)
def _alias_index(market: str = DEFAULT_MARKET) -> dict[str, dict]:
    """lowercased micro-alias name -> {canonical, parent, city}"""
    g = load_gazetteer(market)
    return {k.lower(): v for k, v in (g.get("aliases") or {}).items()}


@lru_cache(maxsize=4)
def _city_locality_index(market: str = DEFAULT_MARKET) -> dict[str, str]:
    """lowercased locality/suburb name -> city, from the 'cities' section."""
    g = load_gazetteer(market)
    out: dict[str, str] = {}
    for city, localities in (g.get("cities") or {}).items():
        for loc in localities:
            out[loc.lower()] = city
    return out


def _lookup_order(market: str | None) -> list[str]:
    """The market's own gazetteer first, then every other market.

    Why a fallback rather than threading `market` through every caller:
    resolve_location is reached from query_understanding, scoring,
    normalize.derive_city and fact_extraction's candidate gate, none of which
    currently carry a market. Adding the parameter to all four is a change to
    the India path — which is working and shipping — for no India benefit.

    The fallback is only safe because the two files share NO term: 335 India
    terms and 166 Dubai terms, zero overlap, asserted by
    test_search_harness.test_gazetteer so it stays true. A colliding name
    added later fails that test rather than silently resolving a Mumbai query
    to a Dubai community. The market's own file is still checked FIRST, so
    when a caller does know the market the collision question is moot.
    """
    first = market or DEFAULT_MARKET
    return [first] + [m for m in GAZETTEER_PATHS if m != first]


def resolve_location(term: str, market: str = DEFAULT_MARKET) -> dict:
    """Mirrors scoring.cjs's expandLocationTerm()/resolveLocationTerms(): a
    micro-locality alias (e.g. "Gawamin") resolves to its canonical name,
    parent suburb, and city; a locality already in the 'cities' list
    resolves to its city with no alias involved; anything else resolves to
    itself with no known parent/city (never invented).
    """
    key = term.strip().lower()
    for m in _lookup_order(market):
        alias = _alias_index(m).get(key)
        if alias:
            # An alias entry may be a LIST when the same name exists in more
            # than one place. Live: "2bhk in Samata Nagar" returned zero. There
            # is a Samata Nagar in Kandivali East AND one in Thane; the
            # gazetteer claimed only the Mumbai one, search returned Thane
            # projects (TenX Habitat, Dosti Vihar, Tarangan — all Thane West),
            # and the geography gate rejected every one for being in the wrong
            # city. Mumbai is full of these: Shanti Nagar, Azad Nagar, Anand
            # Nagar and Tilak Nagar all exist several times over, which is why
            # some entries already carry a disambiguating suffix.
            #
            # The first entry stays the primary answer, so every existing
            # caller sees exactly what it saw before; `alternatives` is
            # additive, and the geography gate widens to accept any of them
            # rather than silently picking one and discarding a real match.
            entries = alias if isinstance(alias, list) else [alias]
            primary = entries[0]
            return {
                "query_term": term,
                "canonical": primary["canonical"],
                "parent": primary.get("parent"),
                "city": primary.get("city"),
                "is_micro_alias": True,
                "alternatives": [
                    {"canonical": e["canonical"], "parent": e.get("parent"), "city": e.get("city")}
                    for e in entries[1:]
                ],
            }
        city = _city_locality_index(m).get(key)
        if city:
            return {
                "query_term": term,
                "canonical": term,
                "parent": None,
                "city": city,
                "is_micro_alias": False,
            }
    near = _near_miss(key, market)
    if near:
        # Resolve on the gazetteer's OWN casing, not the lowercased index key
        # — otherwise a corrected city-list locality comes back as
        # "borivali west", and acronym localities (DIFC, JVC) get mangled.
        resolved = resolve_location(_display_name(near, market), market)
        # Never silent. The caller surfaces `corrected_from` to the user, so
        # they always see that we searched something other than what they
        # typed and can correct us.
        resolved["corrected_from"] = term
        logger.warning("[gazetteer] %r is not a known locality — searched %r instead", term, near)
        return resolved
    return {
        "query_term": term,
        "canonical": term,
        "parent": None,
        "city": None,
        "is_micro_alias": False,
    }


# A locality one character away from a real one currently costs the user the
# entire search. Live: "1bhk in Sampta Nagar" found 64 real candidates and
# returned ZERO, because "Sampta Nagar" is not in the gazetteer while
# "Samata Nagar" (Kandivali East, Mumbai) is. With no parent and no city to
# widen with, the geography gate falls back to exact-phrase matching and
# rejects everything. Mumbai locality names are transliterations with several
# accepted spellings each, so this is a permanent condition, not a one-off.
_NEAR_MISS_CUTOFF = 0.86
_DIRECTIONS = {"east", "west", "north", "south"}


def _near_miss(key: str, market: str | None) -> str | None:
    """The one gazetteer term a mistyped locality almost certainly meant, or
    None. Deliberately conservative: a wrong correction is worse than none.
    """
    if len(key) < 5:
        return None  # too short for edit distance to mean anything
    candidates: list[str] = []
    for m in _lookup_order(market):
        candidates.extend(_alias_index(m).keys())
        candidates.extend(_city_locality_index(m).keys())
    best = difflib.get_close_matches(key, candidates, n=1, cutoff=_NEAR_MISS_CUTOFF)
    if not best:
        return None
    match = best[0]
    # HARD GUARD: never cross a directional suffix. "Malad West" and "Malad
    # East" are 0.8 similar and are different places; silently swapping one
    # for the other would be a far worse failure than returning nothing.
    if _direction_of(key) != _direction_of(match):
        return None
    # Require a shared word stem too, so similarity alone can't carry it.
    if not (set(key.split()) & set(match.split())):
        stem_a, stem_b = key.split()[0], match.split()[0]
        if not (stem_a.startswith(stem_b[:4]) or stem_b.startswith(stem_a[:4])):
            return None
    return match


@lru_cache(maxsize=4)
def _display_index(market: str = DEFAULT_MARKET) -> dict[str, str]:
    """lowercased term -> the gazetteer's own casing for it."""
    g = load_gazetteer(market)
    out = {k.lower(): k for k in (g.get("aliases") or {})}
    for localities in (g.get("cities") or {}).values():
        for loc in localities:
            out.setdefault(loc.lower(), loc)
    return out


def _display_name(key: str, market: str | None) -> str:
    for m in _lookup_order(market):
        hit = _display_index(m).get(key)
        if hit:
            return hit
    return key


def _direction_of(term: str) -> str | None:
    for w in term.split():
        if w in _DIRECTIONS:
            return w
    return None


def base_locality(term: str) -> str:
    """Mirrors scoring.cjs's baseLocality() / ProjectSelection.jsx's
    baseLocality() — strips a trailing directional suffix so "Borivali East"
    and "Borivali West" are recognized as siblings. Kept as the same simple
    one-line transform in every runtime deliberately (not a shared import —
    three different languages touch this repo), not a second definition of
    what a locality IS.
    """
    import re
    return re.sub(r"\s+(east|west|north|south)\.?$", "", term.strip(), flags=re.IGNORECASE).strip().lower()
