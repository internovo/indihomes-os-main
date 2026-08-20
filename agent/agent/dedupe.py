"""Deterministic property deduplication + conflict-preserving evidence
merge. Two sources naming the same project (even with slightly different
title-case/portal-suffix noise) become ONE property with BOTH observations
kept in `field_evidence` — never silently overwritten, per the brief's
explicit "Property A: 99acres ₹1.71 Cr, MagicBricks ₹1.75 Cr — preserve
both" example.

Matching keys, in priority order:
1. RERA number (authoritative — if two evidence items share a RERA, they're
   the same project regardless of name-text differences).
2. normalized project name + normalized locality.
3. exact source_url (two evidence items literally the same page/listing).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from .state import ExtractedFact, FeatureEvidence, FieldEvidence, NormalizedProperty


def _key(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


# Portal titles for the SAME project routinely differ only by which page of
# that portal they came from — a price page, an FAQ page, a brochure page —
# e.g. "Arkade Eden Malad West: Price, Photos & Floor Plans" vs "Arkade Eden
# FAQs - Malad West, Mumbai" vs "Arkade Eden Malad West - Brochure,
# Pros&Cons, PriceSheet". Confirmed live (2026-08-17 verification run): all
# three landed as three separate, undeduplicated candidates because the raw
# name_loc_key below compared the full noisy title, not the project's actual
# name. Stripping these known portal-furniture words BEFORE building the key
# (never touching the name actually displayed to the user) collapses all
# three onto the same "arkadeeden" core. Conservative and explicit — a fixed
# word list, not a fuzzy/similarity match, so it can't accidentally merge two
# genuinely different projects that happen to share a real name fragment.
_PORTAL_NOISE_RE = re.compile(
    r"\bprice(\s*sheet|\s*list)?\b|\bphotos?\b|\bfloor\s*plans?\b|\bfaqs?\b|"
    r"\bbrochure\b|\bpros\s*(&|and)?\s*cons\b|\breviews?\b|\boverview\b|"
    r"\bgallery\b|\bamenities\b|\bvideo\s*tour\b|\bmap\b",
    re.IGNORECASE,
)
def _core_name_key(text: str | None) -> str:
    return _key(_PORTAL_NOISE_RE.sub("", text or ""))


# A RERA value is only trustworthy as a cross-property merge key when it
# actually LOOKS like a real registration number (Maharashtra RERA codes:
# P/PR/PM/PA + ~9-13 digits, per the same pattern external-search.cjs's
# extractReraFromText uses). Defense in depth against the exact bug found
# live: a placeholder string like "Present (number not extracted)" being
# treated as if it were a real, unique RERA number would silently merge
# every property carrying that same placeholder into ONE entity. The actual
# source of that placeholder (agent-tools-bridge.cjs's toEvidence()) has
# been fixed to never emit it in the first place — this check means a
# similar mistake anywhere else can't cause the same cross-contamination.
_RERA_SHAPE_RE = re.compile(r"^P[A-Z]{0,2}\d{9,13}$", re.IGNORECASE)
def _looks_like_real_rera(value: str | None) -> bool:
    return bool(value) and bool(_RERA_SHAPE_RE.match(str(value).strip()))


TRACKED_FIELDS = ["price_display", "configuration", "possession_display", "rera", "location", "developer"]


def _field_evidence_entry(prop: NormalizedProperty, field: str) -> FieldEvidence | None:
    value = prop.get(field)
    if not value:
        return None
    src = (prop.get("sources") or [{}])[0]
    return FieldEvidence(
        field=field, value=value, source=src.get("name") or "unknown",
        source_url=src.get("url"), captured_at=src.get("captured_at") or datetime.now(timezone.utc).isoformat(),
        confidence="high" if src.get("source_type") == "portal" else "medium",
    )


def _merge_into(target: NormalizedProperty, incoming: NormalizedProperty) -> None:
    target["sources"] = (target.get("sources") or []) + (incoming.get("sources") or [])
    target["evidence_count"] = target.get("evidence_count", 0) + 1
    target["source_types"] = list(dict.fromkeys((target.get("source_types") or []) + (incoming.get("source_types") or [])))

    for field in TRACKED_FIELDS:
        entry = _field_evidence_entry(incoming, field)
        if not entry:
            continue
        target.setdefault("field_evidence", {}).setdefault(field, [])
        # A genuinely new value for this field (not already recorded, even
        # if it conflicts with what's there) is appended, never dropped —
        # this IS the conflict, preserved for the curator to explain.
        existing_values = {str(e["value"]) for e in target["field_evidence"][field]}
        if str(entry["value"]) not in existing_values:
            target["field_evidence"][field].append(entry)

    # Fill genuinely missing top-level fields from the incoming item —
    # doesn't touch a field that already has a value (that's what
    # field_evidence is for), only fills honest gaps.
    for field in ["developer", "location", "price_min_inr", "price_max_inr", "price_display",
                  "carpet_area_sqft", "possession_year", "possession_display", "rera", "description"]:
        if not target.get(field) and incoming.get(field):
            target[field] = incoming[field]
    if incoming.get("configuration"):
        target["configuration"] = list(dict.fromkeys((target.get("configuration") or []) + incoming["configuration"]))
    if incoming.get("amenities"):
        target["amenities"] = list(dict.fromkeys((target.get("amenities") or []) + incoming["amenities"]))
    # Preserve deep-research-derived features/configuration_evidence across
    # a re-dedupe (e.g. node_targeted_research's dedupe(merged +
    # newly_normalized)) regardless of which item happened to become
    # `target` vs `incoming` — these carry real provenance and must never
    # be silently dropped just because a fresh, feature-less normalize()
    # result became the group's first-seen entry.
    if incoming.get("features"):
        target["features"] = _merge_features(target.get("features") or [], incoming["features"])
    if incoming.get("configuration_evidence"):
        merged_cfg = dict(target.get("configuration_evidence") or {})
        for cfg, bucket in incoming["configuration_evidence"].items():
            merged_cfg[cfg] = {**bucket, **merged_cfg.get(cfg, {})}
        target["configuration_evidence"] = merged_cfg
    # A non-aggregator source describing the same project is stronger
    # evidence this is a real, specific listing than a category page —
    # let it override, never the other way around.
    if not incoming.get("is_aggregator"):
        target["is_aggregator"] = False


# fact_extraction.py's raw field name -> the NormalizedProperty top-level
# key it should backfill (never overwrite) when present. A field with no
# entry here (project_status/property_type/total_floors/tower_count/
# connectivity/nearby_landmarks/price_per_sqft) has no OLDER top-level
# counterpart to reconcile with — deep research is the only source for
# these, so they're written under their own field_extraction name directly.
# deck/balcony/parking are DELIBERATELY absent — those are represented
# ONLY via the canonical `features` list now (Part P0.1/P0.2), never as a
# flat top-level string scoring.py could substring-match against.
_EXTRACTED_FIELD_TO_TOP_LEVEL = {
    "rera_number": "rera", "developer": "developer",
    "possession": "possession_display", "price": "price_display",
    "carpet_area": "carpet_area_display", "built_up_area": "built_up_area_display",
}


def _merge_features(existing: list[FeatureEvidence], incoming: list[FeatureEvidence]) -> list[FeatureEvidence]:
    seen = {(f["feature"], f["scope"], f.get("configuration"), f.get("source_url")) for f in existing}
    merged = list(existing)
    for f in incoming:
        key = (f["feature"], f["scope"], f.get("configuration"), f.get("source_url"))
        if key not in seen:
            seen.add(key)
            merged.append(f)
    return merged


def merge_extracted_facts(prop: NormalizedProperty, facts: list[ExtractedFact], features: list[FeatureEvidence] | None = None) -> NormalizedProperty:
    """Folds fetch_page-derived ExtractedFacts (fact_extraction.py) into ONE
    candidate — same "append to field_evidence, never silently overwrite a
    real top-level value, a genuine conflict is preserved, not resolved"
    philosophy as _merge_into() above, extended to the richer field set
    deep page research adds on top of what raw search-snippet evidence
    already carried (Part 15/16).

    `features` (Part P0.1) is merged separately, into `prop["features"]` —
    the canonical unit-feature list scoring.py reads instead of ever
    substring-matching `description`/`amenities` for deck/balcony/parking.

    A fact carrying `configuration` (Part P0.6 — "2 BHK — 690 sq ft — ₹1.7
    Cr") is routed into `configuration_evidence[configuration]`, NEVER into
    the flat property-level field — that's what stops a 1 BHK's price from
    silently becoming the 2 BHK's.
    """
    if not facts and not features:
        return prop
    out = dict(prop)
    field_evidence = {k: list(v) for k, v in (out.get("field_evidence") or {}).items()}
    configuration_evidence = {k: dict(v) for k, v in (out.get("configuration_evidence") or {}).items()}

    for fact in facts:
        field = fact["field"]
        config = fact.get("configuration")

        if config:
            # Configuration-scoped — belongs on THAT configuration's own
            # bucket, never on the flat property-level field (Part P0.6).
            bucket = configuration_evidence.setdefault(config, {})
            existing_entries = bucket.setdefault(f"{field}_evidence", [])
            if not any(str(e["value"]) == str(fact["value"]) for e in existing_entries):
                existing_entries.append({
                    "value": fact["value"], "source": fact["source"], "source_url": fact.get("source_url"),
                    "confidence": fact.get("confidence", "medium"), "evidence_text": fact.get("evidence_text"),
                })
            if not bucket.get(field):
                bucket[field] = fact["value"]
            continue

        entries = field_evidence.get(field, [])
        existing_values = {str(e["value"]) for e in entries}
        if str(fact["value"]) not in existing_values:
            entries = entries + [FieldEvidence(
                field=field, value=fact["value"], source=fact["source"],
                source_url=fact.get("source_url"), captured_at=fact.get("retrieved_at") or datetime.now(timezone.utc).isoformat(),
                confidence=fact.get("confidence", "medium"),
            )]
        field_evidence[field] = entries

        if field == "amenities" and isinstance(fact["value"], list):
            out["amenities"] = list(dict.fromkeys((out.get("amenities") or []) + fact["value"]))
        elif field == "nearby_landmarks" and isinstance(fact["value"], list):
            out["nearby_landmarks"] = list(dict.fromkeys((out.get("nearby_landmarks") or []) + fact["value"]))
        elif field == "project_name":
            # Part 2 — unlike every other field here, `out["name"]` is NEVER
            # actually empty (every candidate starts with SOME name from its
            # search snippet), so the normal "only fill if missing" rule
            # below would never apply this. Deliberately different rule: only
            # UPGRADE the display name, and only when the CURRENT one reads
            # like a category-page title (portal SEO furniture, not an
            # actual project name a buyer would recognize) — never downgrade
            # a name that's already good, never apply an extraction that
            # itself still looks generic (fact_extraction.extract_project_
            # name already refuses to emit a fact in that case). The raw
            # original name is still preserved above in field_evidence
            # either way — never lost, just no longer what's DISPLAYED.
            from .normalize import is_aggregator_title
            current_name = out.get("name") or ""
            if is_aggregator_title({"title": current_name, "description": ""}):
                out["name"] = fact["value"]
        elif field == "lifecycle_status_from_page":
            # Follow-up spec (Part 3/5/7) — the actual fix for "UNKNOWN
            # before verification vs. UNKNOWN after verification": applies
            # fact_extraction's direct classification of the REAL fetched
            # page's own title+content (see that function's own comment for
            # the full "Arkade Malad West / New Launch" story this was
            # built to fix). Same "only upgrade an undetermined status,
            # never override an already-confident one" rule as everywhere
            # else this pattern is used — a candidate already confidently
            # RESALE/RENTAL/eligible from earlier evidence is untouched.
            if (out.get("lifecycle_status") or "UNKNOWN") in ("UNKNOWN", "READY_TO_MOVE"):
                out["lifecycle_status"] = fact["value"]
                out["lifecycle_evidence_text"] = fact.get("evidence_text") or out.get("lifecycle_evidence_text")
        else:
            top_level_key = _EXTRACTED_FIELD_TO_TOP_LEVEL.get(field, field)
            if not out.get(top_level_key):
                out[top_level_key] = fact["value"]

    if features:
        out["features"] = _merge_features(out.get("features") or [], features)

    out["field_evidence"] = field_evidence
    out["configuration_evidence"] = configuration_evidence
    newly_seen_urls = {f["source_url"] for f in facts if f.get("source_url")}
    if newly_seen_urls:
        out["evidence_count"] = out.get("evidence_count", 0) + len(newly_seen_urls)
    return out


def merge_updated_candidates(existing: list[NormalizedProperty], updated: list[NormalizedProperty]) -> list[NormalizedProperty]:
    """Splices deep-research-enriched candidates back into the full
    deduplicated list by id, replacing the pre-enrichment entry — every
    candidate NOT touched by deep research (outside the top-N budget)
    passes through unchanged.
    """
    by_id = {u["id"]: u for u in updated if u.get("id")}
    return [by_id.get(p.get("id"), p) for p in existing]


# ── Fuzzy entity resolution (Part 6) — a SEPARATE, stricter tier from the
# exact name+location key dedupe() already uses above. Only reached when
# RERA/URL/exact-name+location all miss. Deliberately requires MULTIPLE
# independent signals to agree — name-token overlap alone is NEVER
# sufficient, since genuinely different projects routinely share a common
# word ("Heights", "Residency", "Garden", a compass direction). Distinct
# name tokens (after stripping both portal furniture AND this generic
# filler) must overlap meaningfully AND at least one of {same developer,
# same/contained locality string} must also agree before two candidates
# are merged. No lat/lon proximity signal is available at this pipeline
# stage — candidates aren't geocoded until Project Intelligence — so that
# part of the spec's suggested signal set is a real, disclosed limitation
# here, not faked with invented coordinates.
_GENERIC_PROJECT_WORDS = {
    "heights", "residency", "enclave", "residences", "towers", "tower",
    "apartments", "apartment", "homes", "home", "gardens", "garden",
    "greens", "green", "park", "phase", "west", "east", "north", "south",
    "project", "residential", "properties", "property",
}


def _name_tokens(name: str) -> set[str]:
    stripped = _PORTAL_NOISE_RE.sub("", name or "")
    return set(re.findall(r"[a-z0-9]+", stripped.lower())) - _GENERIC_PROJECT_WORDS


def _fuzzy_match(existing: NormalizedProperty, candidate: NormalizedProperty) -> bool:
    ta, tb = _name_tokens(existing.get("name")), _name_tokens(candidate.get("name"))
    if not ta or not tb:
        return False
    overlap = len(ta & tb) / len(ta | tb)
    if overlap < 0.5:
        return False
    dev_a, dev_b = _key(existing.get("developer")), _key(candidate.get("developer"))
    same_developer = bool(dev_a) and bool(dev_b) and dev_a == dev_b
    loc_a, loc_b = _key(existing.get("location")), _key(candidate.get("location"))
    same_locality = bool(loc_a) and bool(loc_b) and (loc_a == loc_b or loc_a in loc_b or loc_b in loc_a)
    return same_developer or same_locality


def dedupe(properties: list[NormalizedProperty]) -> list[NormalizedProperty]:
    groups: dict[str, NormalizedProperty] = {}
    rera_index: dict[str, str] = {}
    url_index: dict[str, str] = {}

    for p in properties:
        source_url = (p.get("sources") or [{}])[0].get("url")
        rera = p.get("rera")
        name_loc_key = f"{_core_name_key(p.get('name'))}::{_key(p.get('location'))}"

        # A category page's extracted sub-listings (normalize.py's
        # extract_sub_listings, source_type "category_page_extract") inherit
        # the PARENT page's URL verbatim — they're synthetic entries pulled
        # out of one real page's body text, not each their own fetched page.
        # Live-caught bug (Mahatre Wadi trace): the URL tier below treated
        # that shared, inherited URL as if it identified one real listing,
        # so the SECOND sub-listing extracted from a page always got
        # redirected into the FIRST sub-listing's group via url_index —
        # regardless of their distinct names/RERA numbers — collapsing e.g.
        # "Arkade Vistas"/"Im Applaud"/"Mahant Sahyadree" back into one
        # candidate, exactly the bug extract_sub_listings exists to avoid.
        # Excluded from both matching against and registering into
        # url_index; they still correctly merge via the RERA or
        # name+locality tiers when two sub-listings really are the same
        # project.
        is_synthetic_url = "category_page_extract" in (p.get("source_types") or [])

        key = name_loc_key
        if rera and _looks_like_real_rera(rera) and rera in rera_index:
            key = rera_index[rera]
        elif not is_synthetic_url and source_url and source_url in url_index:
            key = url_index[source_url]
        elif key not in groups:
            # Part 6 fuzzy tier — only tried once the three exact-match
            # tiers above have all missed. Small per-search candidate
            # counts (a handful to a few dozen) make an O(existing groups)
            # scan per candidate cheap; correctness over cleverness here.
            for existing_key, existing_group in groups.items():
                if _fuzzy_match(existing_group, p):
                    key = existing_key
                    break

        if key not in groups:
            fresh = dict(p)
            fresh["id"] = key
            fresh["field_evidence"] = {}
            for field in TRACKED_FIELDS:
                entry = _field_evidence_entry(fresh, field)
                if entry:
                    fresh["field_evidence"][field] = [entry]
            groups[key] = fresh
        else:
            _merge_into(groups[key], p)

        if rera and _looks_like_real_rera(rera):
            rera_index[rera] = key
        if not is_synthetic_url and source_url:
            url_index[source_url] = key

    return list(groups.values())
