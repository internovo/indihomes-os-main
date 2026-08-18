"""Loads the SAME mmr-gazetteer.json the Node frontend/backend already use
(src/components/screens/ProjectSelection.jsx's LocationCombobox, scoring.cjs,
azure-search.cjs, legacy-portal-connector.cjs) — one shared gazetteer file,
not a second location intelligence system. This module only *reads* it and
adds no locations of its own.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

# ai-search-agent/agent/gazetteer.py -> repo root is two levels up.
GAZETTEER_PATH = Path(__file__).resolve().parent.parent.parent / "shared" / "mmr-gazetteer.json"


@lru_cache(maxsize=1)
def load_gazetteer() -> dict:
    with open(GAZETTEER_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _alias_index() -> dict[str, dict]:
    """lowercased micro-alias name -> {canonical, parent, city}"""
    g = load_gazetteer()
    return {k.lower(): v for k, v in (g.get("aliases") or {}).items()}


@lru_cache(maxsize=1)
def _city_locality_index() -> dict[str, str]:
    """lowercased locality/suburb name -> city, from the 'cities' section."""
    g = load_gazetteer()
    out: dict[str, str] = {}
    for city, localities in (g.get("cities") or {}).items():
        for loc in localities:
            out[loc.lower()] = city
    return out


def resolve_location(term: str) -> dict:
    """Mirrors scoring.cjs's expandLocationTerm()/resolveLocationTerms(): a
    micro-locality alias (e.g. "Gawamin") resolves to its canonical name,
    parent suburb, and city; a locality already in the 'cities' list
    resolves to its city with no alias involved; anything else resolves to
    itself with no known parent/city (never invented).
    """
    key = term.strip().lower()
    alias = _alias_index().get(key)
    if alias:
        return {
            "query_term": term,
            "canonical": alias["canonical"],
            "parent": alias.get("parent"),
            "city": alias.get("city"),
            "is_micro_alias": True,
        }
    city = _city_locality_index().get(key)
    if city:
        return {
            "query_term": term,
            "canonical": term,
            "parent": None,
            "city": city,
            "is_micro_alias": False,
        }
    return {
        "query_term": term,
        "canonical": term,
        "parent": None,
        "city": None,
        "is_micro_alias": False,
    }


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
