"""Plain-assert tests for the deterministic lifecycle/eligibility pipeline —
no pytest dependency (none is installed in this repo's venv today; see
agent/_smoke_test.py for the existing "runnable script, not a framework"
convention this follows). Run directly:

    .venv\\Scripts\\python.exe tests\\test_lifecycle_and_eligibility.py

Exits non-zero on any failure so it's usable in CI later without changes.
Covers Part 26's required cases: resale/rental/unknown rejected,
under-construction/near-possession/new-launch accepted, exact locality
scores higher, wrong configuration scored down, duplicate projects merged,
same query -> same ranking, and the LLM never touches any of this (every
function here is called directly with plain dicts — no network, no API key
needed).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.normalize import classify_lifecycle_status, normalize_all, ALLOWED_LIFECYCLE_STATUSES, reclassify_lifecycle_from_enriched_evidence, looks_like_unrelated_commerce, classify_page_type, is_aggregator_title, looks_like_invalid_name
from agent.dedupe import dedupe, merge_extracted_facts
from agent.scoring import score_all
from agent.graph import _apply_hard_eligibility_filter, _location_terms, _matches_searched_location, _prioritize_for_deep_research
from agent.fact_extraction import extract_project_name, deterministic_extract, extract_sub_listings
from agent.curator import _retrieval_metrics, _empty_result_explanation

failures = []


def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"ok:   {label}")


# ── classify_lifecycle_status ────────────────────────────────────────────
status, ev = classify_lifecycle_status({"title": "Resale 2 BHK Flat in Borivali West", "description": "Owner posted, ready to move, contact for resale price"})
check("resale title -> RESALE", status == "RESALE")
check("resale evidence text captured", bool(ev))

status, _ = classify_lifecycle_status({"title": "2 BHK for Rent in Malad West", "description": "Rental ₹35,000/month, immediate move-in"})
check("rental title -> RENTAL", status == "RENTAL")

status, _ = classify_lifecycle_status({"title": "Arkade Nucleus", "description": "Under construction, possession by December 2027"})
check("under-construction description -> UNDER_CONSTRUCTION", status == "UNDER_CONSTRUCTION")

status, _ = classify_lifecycle_status({"title": "Sheth Vasant Oasis Phase 2", "description": "Near possession, handover expected shortly"})
check("near-possession description -> NEAR_POSSESSION", status == "NEAR_POSSESSION")

status, _ = classify_lifecycle_status({"title": "New launch: Godrej Horizon", "description": "Newly launched residential project in Andheri West"})
check("new-launch title -> NEW_LAUNCH", status == "NEW_LAUNCH")

status, _ = classify_lifecycle_status({"title": "Some Random Listing Title", "description": "Nice apartment with good amenities"})
check("no signal at all -> UNKNOWN", status == "UNKNOWN")

# Regression: live-caught on "1BHK in kandarpada Dahisar West with gym
# nearby" — a genuine developer-marketing Instagram caption ("New Project by
# Pastonji Bliss Tower located near kandarpada metro station... from only 73
# lakhs plus taxes") never used any of "launch"/"pre-launch"/"upcoming
# project", and Instagram content can't be further enriched by fetch_page
# (JS-heavy/login-walled), so it stayed permanently UNKNOWN. "New Project
# by <Name>" is a common, specific, self-announcing developer phrasing.
status, ev = classify_lifecycle_status({
    "title": "Dahisar West New Project by Pastonji Bliss Tower located ...",
    "description": "New Project by Pastonji Bliss Tower located near kandarpada metro station. from only 73 lakhs plus taxes.",
})
check("'New Project by <Name>' developer caption -> NEW_LAUNCH, not UNKNOWN", status == "NEW_LAUNCH")
check("...with real evidence text captured", bool(ev))

# Regression guard: a bare "new project" (no "by") must stay unmatched here —
# too generic, and category pages saying "New Projects in X" are already
# rejected earlier at the aggregator-gate stage (PROJECTS_IN_PLACE_RE), not
# meant to be caught a second time by this lifecycle-phrase check.
status, _ = classify_lifecycle_status({"title": "Some Building", "description": "Check out this new project nearby, prices starting soon"})
check("bare 'new project' (no 'by') does NOT trigger NEW_LAUNCH on its own", status != "NEW_LAUNCH")

# Regression: bare "lease" must not misclassify a genuine new-launch project
# built on government leasehold land ("lease deed" is a land-tenure term,
# not a rental-transaction signal) as RENTAL.
status, _ = classify_lifecycle_status({"title": "Godrej Horizon", "description": "New launch on a 99-year lease deed from MHADA, under construction"})
check("leasehold land-tenure new-launch project -> NOT RENTAL", status != "RENTAL")
status, _ = classify_lifecycle_status({"title": "2 BHK available on lease", "description": "Lease: ₹25,000/month, immediate move-in"})
check("genuine lease-based rental listing -> still RENTAL", status == "RENTAL")

# Regression: a real live false-positive — a portal's "Posted By" FILTER
# WIDGET (facet options "Owner / Builder / Dealer", not a claim about the
# specific listing) matched \bby\s+owner\b because \s+ spans newlines.
status, _ = classify_lifecycle_status({"title": "Arkade Malad West", "description": "Posted By \n Owner Builder Dealer \n \n clear all filters"})
check("portal 'Posted By' filter-widget chrome (newline-separated) -> NOT RESALE", status != "RESALE")
status, _ = classify_lifecycle_status({"title": "2 BHK Flat", "description": "For sale by owner, no brokers please"})
check("genuine same-line 'by owner' mention -> still RESALE", status == "RESALE")

# Regression: live-caught on "1BHK in kandarpada Dahisar West with gym
# nearby" — a real NoBroker resale listing ("Age of Building: >10 years",
# "Ownership Type: Self Owned") never used the word "resale" anywhere on
# the page, so it matched none of the existing RESALE_RE patterns and fell
# through to the possession-year fallback in classify_lifecycle_status(),
# which misread its resale "Possession" field (date the buyer takes
# possession from the seller once the resale deal closes) as a new
# project's construction-completion date and returned NEAR_POSSESSION —
# an eligible status — for a 10+-year-old resale flat.
status, ev = classify_lifecycle_status(
    {
        "title": "LEGEND 4 Dahisar West - Without Brokerage Unfurnished 1 BHK Flat for Sale in LEGEND 4, Mumbai for Rs. 12,000,000 | NoBroker",
        "description": "Age of Building ##### >10 years ##### Ownership Type ##### Self Owned ##### Maintenance Charges",
    },
    possession_year=2026,
)
check("NoBroker 'Ownership Type: Self Owned' listing -> RESALE, not NEAR_POSSESSION via possession-year fallback", status == "RESALE")
check("NoBroker resale evidence text captured", bool(ev))

check("UNKNOWN is never in the allowed set", "UNKNOWN" not in ALLOWED_LIFECYCLE_STATUSES)
check("RESALE is never in the allowed set", "RESALE" not in ALLOWED_LIFECYCLE_STATUSES)
check("RENTAL is never in the allowed set", "RENTAL" not in ALLOWED_LIFECYCLE_STATUSES)

# ── classify_page_type / is_aggregator_title — social-media source gap ──
# Regression: live-caught on the same "1BHK in kandarpada Dahisar West with
# gym nearby" query — a real, currently under-construction project
# ("Pastonji Bliss Tower", Dahisar West, possession Dec 2026, gym among its
# amenities — independently confirmed via a live web search, not assumed)
# was discovered via an Instagram Reel. classify_page_type() unconditionally
# classified ANY social-media-domain source_url as SOCIAL_POST — permanently
# ineligible — even though the connector had already extracted a specific,
# non-generic developer name ("Pastonji Bliss Tower") from this exact
# evidence, discarding a genuine project purely because of where it was
# found.
pastonji_evidence = {
    "source_url": "https://www.instagram.com/reel/DIIYFCHI4JN",
    "title": "Dahisar West New Project by Pastonji Bliss Tower located ...",
    "developer": "Pastonji Bliss Tower",
    "description": "New Project by Pastonji Bliss Tower located near kandarpada metro station. call 8692043332 from only 73 lakhs plus taxes. call Sharma Ji on",
}
check("Instagram-sourced evidence WITH an already-extracted developer name is NOT auto-rejected as SOCIAL_POST",
      classify_page_type(pastonji_evidence) != "SOCIAL_POST")
check("...and is eligible to become a candidate at all", is_aggregator_title(pastonji_evidence) is False)

# Regression guard: genuine social noise (no distinguishing developer/
# project signal extracted) must still be rejected — the fix must not
# blanket-allow every social post through.
noise_evidence = {
    "source_url": "https://www.instagram.com/p/random123",
    "title": "Great sunset view from my new flat!",
    "description": "loving my new place #happy #home",
}
check("Instagram noise with NO extracted developer signal is still rejected as SOCIAL_POST",
      classify_page_type(noise_evidence) == "SOCIAL_POST")
check("...and correctly flagged an aggregator/non-candidate", is_aggregator_title(noise_evidence) is True)

# Regression: live-caught on "2BHK in Borivali East" — two 99acres.com
# titles prefixing PROJECTS_IN_PLACE_RE's "Projects in <Place>" shape with a
# LIFECYCLE-STATUS phrase ("New Launch"/"Under Construction") rather than
# the previously-seen pagination/generic-noun prefixes. Confirmed already
# correctly rejected on THIS (Python) side — PROJECTS_IN_PLACE_RE is
# unanchored and doesn't care what precedes "Projects in", unlike the
# equivalent check on the Node fallback side, which WAS still anchored (see
# backend/tests/test_lifecycle_and_eligibility.cjs for that actual fix).
# Locked in here as an explicit regression guard using the exact live
# strings, not a paraphrase.
for lifecycle_prefixed_title in (
    "New Launch Projects in Borivali East, Mumbai",
    "Under Construction Projects in Borivali East, Mumbai",
):
    ev = {"title": lifecycle_prefixed_title, "description": "", "source_url": "https://www.99acres.com/x", "source_type": "web"}
    check(f"'{lifecycle_prefixed_title}' -> CATEGORY_PAGE (lifecycle-phrase-prefixed 'Projects in')", classify_page_type(ev) == "CATEGORY_PAGE")

# Possession-year fallback (no phrase-level marker, but a real extracted year)
import datetime
this_year = datetime.datetime.now(datetime.timezone.utc).year
status, ev = classify_lifecycle_status({"title": "Kalpataru Vivant", "description": "A residential tower in Thane."}, possession_year=this_year + 3)
check("far-future possession year, no phrase -> UNDER_CONSTRUCTION", status == "UNDER_CONSTRUCTION")
check("possession-year fallback evidence text present", bool(ev))

# ── hard eligibility filter (graph.py) ───────────────────────────────────
scored = [
    {"id": "a", "name": "Arkade Nucleus", "match_score": 90, "is_aggregator": False, "lifecycle_status": "UNDER_CONSTRUCTION"},
    {"id": "b", "name": "Resale 1BHK Borivali", "match_score": 88, "is_aggregator": False, "lifecycle_status": "RESALE"},
    {"id": "c", "name": "1BHK for Rent Borivali", "match_score": 85, "is_aggregator": False, "lifecycle_status": "RENTAL"},
    {"id": "d", "name": "Buy 1 BHK in Borivali", "match_score": 70, "is_aggregator": True, "lifecycle_status": "UNKNOWN"},
    {"id": "e", "name": "Godrej Horizon", "match_score": 82, "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH"},
    {"id": "f", "name": "Mystery Listing", "match_score": 95, "is_aggregator": False, "lifecycle_status": "UNKNOWN"},
]
# First pass (final=False, before deep_research) — RESALE/RENTAL/aggregator
# are rejected immediately (decisive signal); UNKNOWN is DEFERRED (kept, not
# rejected yet) so deep_research gets a real chance to resolve it from the
# full page, not just a thin search snippet.
accepted, rejected = _apply_hard_eligibility_filter(scored, final=False)
accepted_ids = {p["id"] for p in accepted}
check("first pass: resale rejected immediately", "b" not in accepted_ids)
check("first pass: rental rejected immediately", "c" not in accepted_ids)
check("first pass: aggregator page rejected immediately", "d" not in accepted_ids)
check("first pass: UNKNOWN lifecycle is DEFERRED, not rejected yet (even with the highest score, 95)", "f" in accepted_ids)
check("first pass: eligible candidates present", {"a", "e"} <= accepted_ids)
check("every first-pass rejection carries a reason", all(r.get("reason") for r in rejected))
check("first-pass rejected count matches (resale+rental+aggregator only)", len(rejected) == 3)

# Second pass (final=True, after deep_research had its chance) — anything
# STILL UNKNOWN/READY_TO_MOVE at this point is finally rejected for real.
accepted2, rejected2 = _apply_hard_eligibility_filter(scored, final=True)
accepted2_ids = {p["id"] for p in accepted2}
check("final pass: keeps only UNDER_CONSTRUCTION/NEAR_POSSESSION/NEW_LAUNCH", accepted2_ids == {"a", "e"})
check("final pass: UNKNOWN lifecycle now rejected for real, even with the highest score (95)", "f" not in accepted2_ids)
check("final-pass rejected count matches (all 4 disqualifiers)", len(rejected2) == 4)

# ── deterministic ranking / tie-breaker ──────────────────────────────────
tied = [
    {"id": "z-project", "name": "Z Project", "match_score": 0, "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH", "configuration": [], "sources": []},
    {"id": "a-project", "name": "A Project", "match_score": 0, "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH", "configuration": [], "sources": []},
]
ranked = score_all(tied, {})
check("tied scores still produce a deterministic (id-sorted) order", [p["id"] for p in ranked] == ["a-project", "z-project"])
# Run again to confirm the SAME input always gives the SAME output (Part 11)
ranked2 = score_all(tied, {})
check("same query + same candidate data -> same ranking on repeat runs", [p["id"] for p in ranked] == [p["id"] for p in ranked2])

# ── exact locality scores higher than no location match ─────────────────
loc_hit = [{"id": "x", "name": "Test Tower", "location": "Malad West, Mumbai", "configuration": [], "sources": [], "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH"}]
loc_miss = [{"id": "y", "name": "Other Tower", "location": "Pune", "configuration": [], "sources": [], "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH"}]
scored_hit = score_all(loc_hit, {"locations": ["Malad West"]})[0]
scored_miss = score_all(loc_miss, {"locations": ["Malad West"]})[0]
check("exact locality match scores higher than a location miss", scored_hit["match_score"] > scored_miss["match_score"])

# ── wrong configuration scored down ───────────────────────────────────────
right_cfg = [{"id": "p1", "name": "P1", "configuration": ["2 BHK"], "sources": [], "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH"}]
wrong_cfg = [{"id": "p2", "name": "P2", "configuration": ["3 BHK"], "sources": [], "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH"}]
s_right = score_all(right_cfg, {"configurations": ["2 BHK"]})[0]
s_wrong = score_all(wrong_cfg, {"configurations": ["2 BHK"]})[0]
check("matching configuration scores higher than a mismatched one", s_right["match_score"] > s_wrong["match_score"])

# ── deduplication merges same project from two sources ──────────────────
raw = [
    {"property_name": "Arkade Nucleus", "title": "Arkade Nucleus", "location": "Malad West", "source": "99acres", "source_url": "https://99acres.com/a", "source_type": "portal", "price": {"display": "1.71 Cr"}},
    {"property_name": "Arkade Nucleus", "title": "Arkade Nucleus", "location": "Malad West", "source": "magicbricks", "source_url": "https://magicbricks.com/a", "source_type": "portal", "price": {"display": "1.75 Cr"}},
]
normalized = normalize_all(raw)
deduped = dedupe(normalized)
check("two sources naming the same project+location merge into ONE candidate", len(deduped) == 1)
check("both conflicting price observations preserved in field_evidence, not overwritten", len(deduped[0]["field_evidence"].get("price_display", [])) == 2)

# Regression: three real portal pages for the SAME project (price page, FAQ
# page, brochure page — confirmed live 2026-08-17) must merge into one, not
# three, candidates now that portal furniture words are stripped before the
# name+location identity key is built.
noisy_raw = [
    {"property_name": "Arkade Eden Malad West: Price, Photos & Floor Plans", "title": "Arkade Eden Malad West: Price, Photos & Floor Plans", "location": "Malad West", "source": "99acres", "source_url": "https://99acres.com/e1", "source_type": "portal"},
    {"property_name": "Arkade Eden Malad West - Brochure, Pros&Cons, PriceSheet", "title": "Arkade Eden Malad West - Brochure, Pros&Cons, PriceSheet", "location": "Malad West", "source": "magicbricks", "source_url": "https://magicbricks.com/e2", "source_type": "portal"},
]
noisy_deduped = dedupe(normalize_all(noisy_raw))
check("portal price/brochure page-title noise no longer blocks dedup of the same project", len(noisy_deduped) == 1)

# ── Part 6 — fuzzy entity resolution requires MULTIPLE signals ──────────
fuzzy_same_raw = [
    {"property_name": "Arkade Malad West", "title": "Arkade Malad West", "location": "Malad West", "developer": "Arkade Group", "source": "a", "source_url": "https://a.com/1", "source_type": "portal"},
    {"property_name": "Arkade Liberty Garden Malad", "title": "Arkade Liberty Garden Malad", "location": "Liberty Garden, Malad West", "developer": "Arkade Group", "source": "b", "source_url": "https://b.com/2", "source_type": "portal"},
]
fuzzy_merged = dedupe(normalize_all(fuzzy_same_raw))
check("same developer + overlapping distinctive name tokens + contained locality -> merged as ONE project", len(fuzzy_merged) == 1)

fuzzy_generic_word_raw = [
    {"property_name": "Sunshine Heights", "title": "Sunshine Heights", "location": "Malad West", "developer": "Kalpataru", "source": "a", "source_url": "https://a.com/3", "source_type": "portal"},
    {"property_name": "Green Heights", "title": "Green Heights", "location": "Malad West", "developer": "Godrej", "source": "b", "source_url": "https://b.com/4", "source_type": "portal"},
]
fuzzy_not_merged = dedupe(normalize_all(fuzzy_generic_word_raw))
check("two DIFFERENT projects sharing only a generic word (\"Heights\") and locality are NOT merged", len(fuzzy_not_merged) == 2)

fuzzy_no_signal_raw = [
    {"property_name": "Godrej Reserve", "title": "Godrej Reserve", "location": "Andheri West", "developer": "Godrej", "source": "a", "source_url": "https://a.com/5", "source_type": "portal"},
    {"property_name": "Sheth Reserve", "title": "Sheth Reserve", "location": "Andheri West", "developer": "Sheth", "source": "b", "source_url": "https://b.com/6", "source_type": "portal"},
]
fuzzy_no_signal_merged = dedupe(normalize_all(fuzzy_no_signal_raw))
check("different developers with only a generic shared name word are NOT merged even with same locality", len(fuzzy_no_signal_merged) == 2)

# ── reclassify_lifecycle_from_enriched_evidence (the deep-research "second chance") ──
thin_snippet = {"id": "arkade", "name": "Arkade Malad West | Residences at Arkade Liberty Garden", "lifecycle_status": "UNKNOWN", "description": None, "field_evidence": {}, "configuration_evidence": {}, "features": []}
still_unknown = reclassify_lifecycle_from_enriched_evidence(thin_snippet)
check("no new evidence -> still UNKNOWN (never guessed)", still_unknown["lifecycle_status"] == "UNKNOWN")

enriched = dict(thin_snippet)
enriched["field_evidence"] = {"possession_display": [{"field": "possession_display", "value": "Under construction, possession by 2028", "source": "developer site", "source_url": "https://arkade.example/liberty-garden", "captured_at": "2026-08-17T00:00:00Z", "confidence": "high"}]}
now_classified = reclassify_lifecycle_from_enriched_evidence(enriched)
check("deep-research-enriched field_evidence resolves a real UNDER_CONSTRUCTION classification", now_classified["lifecycle_status"] == "UNDER_CONSTRUCTION")
check("evidence text is the real extracted snippet, not fabricated", "2028" in (now_classified.get("lifecycle_evidence_text") or ""))

already_confident = {"id": "x", "lifecycle_status": "RESALE", "lifecycle_evidence_text": "resale flat", "description": "Under construction possession 2029", "field_evidence": {}, "configuration_evidence": {}, "features": []}
unchanged = reclassify_lifecycle_from_enriched_evidence(already_confident)
check("already-confident RESALE classification is NOT overridden by later evidence", unchanged["lifecycle_status"] == "RESALE")

# ── extract_project_name (Part 2 — exact project name extraction) ───────
jsonld_page = {"url": "x", "title": "1 BHK Flats in Borivali West - 99acres", "content": "", "metadata": {}, "retrieved_at": "", "status": "success", "error": None, "structured_data": [{"@type": "Residence", "name": "Kalpataru Vivant"}]}
check("JSON-LD structured-data name wins over a generic search-snippet title", extract_project_name(jsonld_page) == "Kalpataru Vivant")

still_generic_page = {"url": "y", "title": "2 BHK Flats for Sale in Andheri West", "content": "", "metadata": {}, "retrieved_at": "", "status": "success", "error": None, "structured_data": []}
check("a page title that STILL reads as a category page after cleaning -> no name extracted (never a guess)", extract_project_name(still_generic_page) is None)

noisy_title_page = {"url": "z", "title": "Arkade Eden Malad West: Price, Photos & Floor Plans - 99acres", "content": "", "metadata": {}, "retrieved_at": "", "status": "success", "error": None, "structured_data": []}
check("real project name recovered from a noisy page <title> once portal furniture is stripped", extract_project_name(noisy_title_page) == "Arkade Eden Malad West")

# merge_extracted_facts upgrades a generic display name, never downgrades a good one
generic_candidate = {"id": "c1", "name": "1 BHK Flats in Borivali West", "sources": [], "field_evidence": {}, "configuration_evidence": {}}
name_fact = [{"candidate": "c1", "field": "project_name", "value": "Kalpataru Vivant", "source": "developer site", "source_url": "https://kalpataru.example/vivant", "retrieved_at": "2026-08-17T00:00:00Z", "confidence": "high"}]
upgraded = merge_extracted_facts(generic_candidate, name_fact, [])
check("generic display name IS upgraded once deep research extracts a real project name", upgraded["name"] == "Kalpataru Vivant")

good_candidate = {"id": "c2", "name": "Godrej Reserve", "sources": [], "field_evidence": {}, "configuration_evidence": {}}
not_downgraded = merge_extracted_facts(good_candidate, name_fact, [])
check("an already-good display name is NEVER downgraded/replaced", not_downgraded["name"] == "Godrej Reserve")

# Final hard-eligibility pass rejects a candidate whose name STILL reads as
# a category page even after enrichment had its chance (Part 2's explicit
# "no identifiable project name after enrichment -> reject" rule).
still_generic_after_research = [{"id": "g1", "name": "1 BHK Flats in Borivali West", "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH", "match_score": 90, "configuration": [], "sources": []}]
_, final_rejected = _apply_hard_eligibility_filter(still_generic_after_research, final=True)
check("a candidate with no identifiable project name is rejected on the FINAL pass, even with a high score", len(final_rejected) == 1 and "no identifiable project name" in final_rejected[0]["reason"].lower())
first_pass_accepted, _ = _apply_hard_eligibility_filter(still_generic_after_research, final=False)
check("...but NOT rejected on the first pass (deep research hasn't had its chance yet)", len(first_pass_accepted) == 1)

# ── Follow-up: sub-listing extraction from rejected category pages ──────
# Confirmed live: a page correctly rejected as a category page ("New
# Projects in Charkop, Kandivali West") still names real, specific
# projects in its own body text, each anchored by its own genuine RERA
# number ("... P51800079530 is the RERA number of the project Jadeite
# Kaveri ..."). These were being thrown away along with the genuinely-
# generic wrapper page. Text below mirrors the real live pattern.
category_page_text = (
    "Jadeite Kaveri is a premium 1 BHK project priced at Rs.75 Lakhs with possession by Dec 2027. "
    "P51800079530 is the RERA number of the project Jadeite Kaveri. "
    "Ruparel Optima is under construction, offering 1 BHK flats at 650 sq ft carpet area. "
    "P51800081234 is the RERA number of the project Ruparel Optima."
)
category_evidence = {
    "title": "New Projects in Charkop, Kandivali West: 33+ Upcoming Projects",
    "description": category_page_text, "source": "99acres",
    "source_url": "https://99acres.com/charkop-projects", "location": "Charkop, Kandivali West",
}
sub_listings = extract_sub_listings(category_evidence)
check("sub-listing extraction finds both real, RERA-anchored projects", len(sub_listings) == 2)
check("first sub-listing has the correct extracted name", any(s["title"] == "Jadeite Kaveri" for s in sub_listings))
check("first sub-listing carries its OWN real RERA number", any(s["rera"] == "P51800079530" for s in sub_listings))
jadeite = next(s for s in sub_listings if s["title"] == "Jadeite Kaveri")
ruparel = next(s for s in sub_listings if s["title"] == "Ruparel Optima")
check("facts do NOT bleed across adjacent projects — Jadeite's price is its own, not Ruparel's", jadeite["price"]["display"] == "₹75L")
check("facts do NOT bleed across adjacent projects — Ruparel has NO price (never mentioned for it), not Jadeite's ₹75L", ruparel.get("price") is None)
check("carpet area correctly scoped to Ruparel only (never mentioned for Jadeite)", ruparel["carpet_area"]["display"] == "650 sq ft" and jadeite.get("carpet_area") is None)
check("sub-listing source_type correctly reflects category-page provenance", all(s["source_type"] == "category_page_extract" for s in sub_listings))
check("sub-listing source_url points back to the real page it came from", all(s["source_url"] == "https://99acres.com/charkop-projects" for s in sub_listings))

no_rera_category_page = {"title": "Flats for Sale in Malad West", "description": "Many builders offer great flats here with modern amenities and good connectivity.", "source": "99acres", "source_url": "https://99acres.com/x"}
check("a category page with NO real RERA-anchored project mention extracts nothing (never guessed)", extract_sub_listings(no_rera_category_page) == [])

# normalize_all() wiring: the wrapper page stays a rejected aggregator,
# its sub-listings become real, non-aggregator candidates in the SAME pool.
normalized = normalize_all([category_evidence])
check("normalize_all expands a category page into itself + its real sub-listings", len(normalized) == 3)
wrapper = next(p for p in normalized if p["name"] == category_evidence["title"])
check("the wrapper page itself is STILL correctly flagged is_aggregator (rejected as before)", wrapper["is_aggregator"] is True)
extracted_names = {p["name"] for p in normalized} - {category_evidence["title"]}
check("both real sub-listings appear as their own non-aggregator candidates", extracted_names == {"Jadeite Kaveri", "Ruparel Optima"})
check("sub-listing candidates are correctly NOT flagged as aggregator pages themselves", all(p["is_aggregator"] is False for p in normalized if p["name"] in extracted_names))

# ── Follow-up: deep-research must classify lifecycle from the REAL fetched
# page's own title+content, not just a narrow set of already-structured
# fields (the actual root cause of a live false-negative: a genuine
# developer page for "Arkade Malad West | ... Arkade Liberty Garden"
# explicitly says "New Launch at Liberty Garden, Malad West" / "Exclusive
# Pre-Launch Privileges" in its own real text, fetched successfully, and
# STILL came back UNKNOWN because nothing downstream of deterministic_
# extract() ever looked at the page's raw text for lifecycle purposes.
# Real page content used verbatim below, not paraphrased.) ──────────────
real_arkade_page = {
    "url": "https://arkademaladwest.in/Liberty-Garden",
    "title": "Arkade Malad West | 2, 3 & 4 BHK Residences at Arkade Liberty Garden",
    "content": "Overview Amenities Price Plan Floor Plan Location Brochure Call Us New Launch at Liberty Garden, Malad West Arkade Malad West Premium 2, 3 & 4 BHK Residences with Private Decks Exclusive Pre-Launch Privileges for Early Registrations Landmark Redevelopment of Nutan Ayojan Nagar CHS Iconic High-Rise Living by Arkade Developers Discover a distinguished lifestyle at Arkade Liberty Garden, a landmark residential offering in the heart of Malad West.",
    "metadata": {}, "structured_data": [], "retrieved_at": "", "status": "success", "error": None,
}
real_facts, _ = deterministic_extract("Arkade Malad West | 2, 3 & 4 BHK Residences at Arkade Liberty Garden", real_arkade_page)
lifecycle_page_facts = [f for f in real_facts if f["field"] == "lifecycle_status_from_page"]
check("deterministic_extract classifies lifecycle directly from real fetched page content", len(lifecycle_page_facts) == 1 and lifecycle_page_facts[0]["value"] == "NEW_LAUNCH")
check("evidence is the real extracted snippet from the actual page, not fabricated", "new launch" in lifecycle_page_facts[0]["evidence_text"].lower())

real_arkade_candidate = {"id": "ark1", "name": "Arkade Malad West | 2, 3 & 4 BHK Residences at Arkade Liberty Garden", "lifecycle_status": "UNKNOWN", "sources": [], "field_evidence": {}, "configuration_evidence": {}}
real_arkade_merged = merge_extracted_facts(real_arkade_candidate, real_facts, [])
check("merge_extracted_facts applies the page-derived lifecycle to an UNDETERMINED candidate", real_arkade_merged["lifecycle_status"] == "NEW_LAUNCH")

already_confident_resale = {"id": "r1", "name": "Some Resale Flat", "lifecycle_status": "RESALE", "sources": [], "field_evidence": {}, "configuration_evidence": {}}
resale_merged = merge_extracted_facts(already_confident_resale, real_facts, [])
check("an already-confident RESALE classification is NEVER overridden by page-derived lifecycle facts", resale_merged["lifecycle_status"] == "RESALE")

no_signal_page = {"url": "x", "title": "Some Project", "content": "Nice apartments with good amenities in a great location.", "metadata": {}, "structured_data": [], "retrieved_at": "", "status": "success", "error": None}
no_signal_facts, _ = deterministic_extract("Some Project", no_signal_page)
check("a page with no real lifecycle signal emits NO lifecycle_status_from_page fact (never guessed)", not any(f["field"] == "lifecycle_status_from_page" for f in no_signal_facts))

# ── Follow-up: unrelated shopping/e-commerce content rejection ──────────
# Real live false positive: a candidate sourced from an unrelated domain
# (a German butcher shop's site, indexed with keyword-stuffed real-estate
# text) whose actual content is e-commerce spam. Text below is the real
# description this candidate actually had, verbatim.
spam_description = "Jun 11, 2026 — Bhk In Charkop Dhaval. Price Item no : US$ 41 Pay in 4 interest-free payments of $10.25 . null Enjoy 20% off shipping US$ . vihar US$ 28.2-47"
check("unrelated e-commerce spam text is detected", looks_like_unrelated_commerce(spam_description) is not None)
check("a genuine real-estate listing is NEVER flagged as unrelated commerce", looks_like_unrelated_commerce("Dem Icon Charkop is one of the well-known under-construction projects in Charkop, Kandivali West, priced from Rs 65 Lakhs.") is None)

spam_candidate = {"id": "spam1", "name": "Sq Ft Bhk In Charkop Dhaval Sunrise", "description": spam_description, "is_aggregator": False, "lifecycle_status": "NEAR_POSSESSION", "match_score": 54, "configuration": [], "sources": []}
spam_ranked, spam_rejected = _apply_hard_eligibility_filter([spam_candidate], final=True)
check("the spam candidate is rejected outright, even with an eligible-looking lifecycle status", len(spam_ranked) == 0 and len(spam_rejected) == 1)
check("rejection reason correctly names unrelated commerce, not lifecycle", "unrelated shopping" in spam_rejected[0]["reason"].lower())
spam_first_pass, _ = _apply_hard_eligibility_filter([spam_candidate], final=False)
check("unrelated-commerce rejection applies on the FIRST pass too (a confident signal, not deferred like lifecycle UNKNOWN)", len(spam_first_pass) == 0)

# ── Part 1 — geography/locality relevance hard-filter ────────────────────
# Regression for a real live failure: searching "2BHK with deck in Liberty
# Garden near Malad West" (Mumbai) returned two U.S. real-estate listings
# ("Liberty at Mayfield... Las Vegas, NV" and "Liberty at Meriden... KB
# Home") as the FINAL results, because their names happened to contain the
# word "Liberty" — a coincidental single-word match, not genuine location
# relevance. Confirmed and fixed 2026-08-17.
geo_state = {
    "locations": ["Liberty Garden", "Malad West"],
    "micro_locations": [{"query_term": "Liberty Garden", "canonical": "Liberty Garden", "parent": "Malad West", "city": "Mumbai", "is_micro_alias": True}],
}
geo_terms = _location_terms(geo_state)
check("_location_terms resolves raw query terms + resolved city/parent", set(geo_terms) == {"Liberty Garden", "Malad West", "Mumbai"})

wrong_country_candidate = {"id": "lv1", "name": "Liberty at Mayfield Homes for Sale | Las Vegas, NV Real Estate", "location": "Las Vegas, NV", "description": "", "is_aggregator": False, "lifecycle_status": "NEAR_POSSESSION", "match_score": 50, "configuration": [], "sources": []}
real_mumbai_candidate = {"id": "ark1", "name": "Arkade Malad West | 2, 3 & 4 BHK Residences at Arkade Liberty Garden", "location": "Malad West, Mumbai", "description": "", "is_aggregator": False, "lifecycle_status": "UNDER_CONSTRUCTION", "match_score": 80, "configuration": [], "sources": []}
geo_ranked, geo_rejected = _apply_hard_eligibility_filter([wrong_country_candidate, real_mumbai_candidate], final=True, location_terms=geo_terms)
check("a candidate matching only a coincidental single word (\"Liberty\") is REJECTED", len(geo_ranked) == 1 and geo_ranked[0]["id"] == "ark1")
check("the real Mumbai project (whole-phrase match) is kept", any(r["id"] == "ark1" for r in geo_ranked))
check("rejection reason correctly names the geography gate", "searched area" in geo_rejected[0]["reason"].lower())

geo_first_pass, _ = _apply_hard_eligibility_filter([wrong_country_candidate], final=False, location_terms=geo_terms)
check("geography gate NOT enforced on the first pass (deep research hasn't had its chance yet)", len(geo_first_pass) == 1)

no_location_query = _apply_hard_eligibility_filter([wrong_country_candidate], final=True, location_terms=[])
check("a query with NO resolvable location skips this gate entirely (nothing to check against)", len(no_location_query[0]) == 1)

# Regression: a real broken edit found this exact function referencing
# `state.get("micro_locations")` with no `state` parameter on the function
# signature at all (NameError at runtime) — only exercised when a
# candidate's own structured `city` field disagrees with the query's
# resolved city (CONFIRMED wrong location, the early-reject branch), which
# no existing test above reached (wrong_country_candidate carries no `city`
# field). Also confirms this confirmed-wrong-city rejection fires on BOTH
# passes (unlike the ambiguous-location deferral above), and that omitting
# `state` entirely degrades gracefully rather than crashing.
wrong_city_candidate = {"id": "pune1", "name": "Some Pune Project", "location": "Pune", "city": "pune", "description": "", "is_aggregator": False, "lifecycle_status": "NEAR_POSSESSION", "match_score": 60, "configuration": [], "sources": []}
wrong_city_ranked_final, wrong_city_rejected_final = _apply_hard_eligibility_filter([wrong_city_candidate], final=True, location_terms=geo_terms, state=geo_state)
check("a CONFIRMED wrong-city candidate (structured city field, not just text) is rejected on the final pass", len(wrong_city_ranked_final) == 0 and len(wrong_city_rejected_final) == 1)
wrong_city_ranked_first, wrong_city_rejected_first = _apply_hard_eligibility_filter([wrong_city_candidate], final=False, location_terms=geo_terms, state=geo_state)
check("...and ALSO on the first pass — a confirmed wrong city is never deferred, only genuinely ambiguous location is", len(wrong_city_ranked_first) == 0 and len(wrong_city_rejected_first) == 1)
no_state_ranked, _ = _apply_hard_eligibility_filter([wrong_city_candidate], final=True, location_terms=geo_terms)
check("omitting `state` entirely degrades gracefully (treated as no resolved-city signal) rather than crashing", len(no_state_ranked) == 0)

# ── Follow-up: deep-research verification budget is spent on UNDETERMINED
# candidates FIRST, not blind top-N-by-score (the real mechanism behind a
# live false-negative where a genuine under-construction project reached
# zero results because it fell just outside an unprioritized top-3 cut) ──
already_eligible_high_score = {"id": "eligible-hi", "name": "Eligible High Score", "lifecycle_status": "UNDER_CONSTRUCTION", "match_score": 95}
unknown_low_score = {"id": "unknown-lo", "name": "Unknown Low Score", "lifecycle_status": "UNKNOWN", "match_score": 20}
ready_to_move_mid = {"id": "rtm-mid", "name": "Ready To Move Mid", "lifecycle_status": "READY_TO_MOVE", "match_score": 50}
prioritized = _prioritize_for_deep_research([already_eligible_high_score, unknown_low_score, ready_to_move_mid])
check("candidates with UNDETERMINED eligibility (UNKNOWN/READY_TO_MOVE) go FIRST for the deep-research budget, even with a lower match_score", [p["id"] for p in prioritized[:2]] == ["unknown-lo", "rtm-mid"])
check("an already-eligible candidate is still included, just deprioritized (never dropped)", prioritized[2]["id"] == "eligible-hi")
same_priority_a = {"id": "unk-a", "name": "A", "lifecycle_status": "UNKNOWN", "match_score": 30}
same_priority_b = {"id": "unk-b", "name": "B", "lifecycle_status": "UNKNOWN", "match_score": 30}
check("within the same priority group, the incoming (score-sorted) order is preserved — stable sort", [p["id"] for p in _prioritize_for_deep_research([same_priority_a, same_priority_b])] == ["unk-a", "unk-b"])

# ── Part 4/17 — retrieval_metrics + the empty-result explanation built from it ──
metrics_state = {
    "original_query": "1BHK in Borivali West",
    "deduplicated_properties": [
        {"is_aggregator": True, "lifecycle_status": None},
        {"is_aggregator": True, "lifecycle_status": None},
        {"is_aggregator": False, "lifecycle_status": "RESALE"},
        {"is_aggregator": False, "lifecycle_status": "RENTAL"},
        {"is_aggregator": False, "lifecycle_status": "UNKNOWN"},
        {"is_aggregator": False, "lifecycle_status": "NEW_LAUNCH"},
    ],
    "debug_rejected_candidates": [{"name": "x", "reason": "r"}] * 5,
}
m = _retrieval_metrics(metrics_state, metrics_state["debug_rejected_candidates"])
check("retrieval_metrics: total_candidates counted correctly", m["total_candidates"] == 6)
check("retrieval_metrics: aggregator_pages counted correctly", m["aggregator_pages"] == 2)
check("retrieval_metrics: resale_candidates counted correctly", m["resale_candidates"] == 1)
check("retrieval_metrics: rental_candidates counted correctly", m["rental_candidates"] == 1)
check("retrieval_metrics: unknown_candidates counted correctly", m["unknown_candidates"] == 1)
check("retrieval_metrics: eligible_candidates counted correctly", m["eligible_candidates"] == 1)
check("retrieval_metrics: individual_project_candidates = total - aggregator", m["individual_project_candidates"] == 4)

empty_explanation = _empty_result_explanation(metrics_state)
check("empty-result explanation mentions the real reviewed count", "6 candidate" in empty_explanation)
check("empty-result explanation mentions category pages when present", "category" in empty_explanation.lower())
check("empty-result explanation mentions resale/rental when present", "resale/rental" in empty_explanation)
check("empty-result explanation never fabricates a breakdown with zero real candidates", _empty_result_explanation({"deduplicated_properties": [], "debug_rejected_candidates": []}) == "No verified new residential projects found — the sources searched returned nothing for this query.")

# Places transparency (Part 1's explicit test-plan requirement) — a
# zero-result explanation must say Places was ALSO checked (and how many
# candidates it contributed), not leave that connector invisible. Manages
# the real env var directly (save/restore) rather than mocking, matching
# this suite's existing "no mocking framework" convention — _retrieval_
# metrics reads GOOGLE_PLACES_API_KEY from the real environment on
# purpose, mirroring backend/scoring.cjs's identical live-env check.
_orig_places_key = os.environ.get("GOOGLE_PLACES_API_KEY")
os.environ["GOOGLE_PLACES_API_KEY"] = "test-key-for-places-transparency-check"
places_note_state = {
    "original_query": "4bhk in nowhere",
    "deduplicated_properties": [{"is_aggregator": True, "lifecycle_status": None}],
    "debug_rejected_candidates": [{"name": "x", "reason": "r"}],
    "raw_evidence": [{"source": "Google Places"}, {"source": "Google Places"}, {"source": "tavily"}],
}
places_explanation = _empty_result_explanation(places_note_state)
if _orig_places_key is None:
    del os.environ["GOOGLE_PLACES_API_KEY"]
else:
    os.environ["GOOGLE_PLACES_API_KEY"] = _orig_places_key
check("empty-result explanation mentions Google Places was checked, with the real contributed count", "Google Places was also checked (2 additional candidate" in places_explanation)

# ── Places-augmented pipeline (Part 1/2/38) ──────────────────────────────
# looks_like_invalid_name() — real live examples from this investigation,
# not synthetic ones. "Security Alert" is the real candidate name live-
# observed for query "2bhk in borivali east" (traced to a 99acres page that
# most plausibly served a bot-detection/interstitial page instead of its
# real listing content). "Pastonji Bliss Tower" and "Rivali Park" are real
# project names from earlier live investigations in this same codebase.
check("live 'Security Alert' garbage extraction -> looks invalid", looks_like_invalid_name("Security Alert"))
check("real project 'Rivali Park' -> does NOT look invalid", not looks_like_invalid_name("Rivali Park"))
check("real project 'Pastonji Bliss Tower' -> does NOT look invalid", not looks_like_invalid_name("Pastonji Bliss Tower"))
check("real project 'CCI Rivali Park Skyleap' -> does NOT look invalid", not looks_like_invalid_name("CCI Rivali Park Skyleap"))
check("generic UI chrome 'Click Here' -> looks invalid", looks_like_invalid_name("Click Here"))
check("generic UI chrome 'View Details' -> looks invalid", looks_like_invalid_name("View Details"))
check("empty name -> looks invalid", looks_like_invalid_name(""))

# _apply_hard_eligibility_filter's combined Places-verification +
# invalid-name gate (graph.py) — three real scenarios per the test plan:
# resolves cleanly (kept, never even reaches the name-shape check),
# doesn't resolve but has a plausible name (kept — Places absence alone is
# never a rejection), doesn't resolve AND fails the name-shape check
# (rejected, with the exact honest reason the live case was built to
# produce).
places_resolved = {"id": "riv1", "name": "Rivali Park", "location": "Borivali East", "city": "mumbai", "description": "", "is_aggregator": False, "lifecycle_status": "UNDER_CONSTRUCTION", "match_score": 90, "configuration": [], "sources": [], "places_verified": True}
places_unresolved_plausible = {"id": "past1", "name": "Pastonji Bliss Tower", "location": "Dahisar West", "city": "mumbai", "description": "", "is_aggregator": False, "lifecycle_status": "NEW_LAUNCH", "match_score": 70, "configuration": [], "sources": [], "places_verified": False}
places_unresolved_invalid = {"id": "sec1", "name": "Security Alert", "location": "Borivali East", "city": "mumbai", "description": "", "is_aggregator": False, "lifecycle_status": "UNDER_CONSTRUCTION", "match_score": 80, "configuration": [], "sources": [], "places_verified": False}
places_never_checked = {"id": "chk1", "name": "Security Alert", "location": "Borivali East", "city": "mumbai", "description": "", "is_aggregator": False, "lifecycle_status": "UNDER_CONSTRUCTION", "match_score": 80, "configuration": [], "sources": []}  # no places_verified key at all — Places never even attempted (e.g. not configured)
places_ranked, places_rejected = _apply_hard_eligibility_filter(
    [places_resolved, places_unresolved_plausible, places_unresolved_invalid, places_never_checked], final=True,
)
places_kept_ids = {p["id"] for p in places_ranked}
check("Places-resolved candidate ('Rivali Park') is kept", "riv1" in places_kept_ids)
check("Places-unresolved but plausible-name candidate ('Pastonji Bliss Tower') is kept — Places absence alone is never a rejection", "past1" in places_kept_ids)
check("Places-unresolved AND invalid-shaped name ('Security Alert') is REJECTED", "sec1" not in places_kept_ids)
check("...with the exact honest reason", any(r["name"] in ("sec1", "Security Alert") and r["reason"] == "Could not verify this is a real project name" for r in places_rejected))
check("a candidate where Places was NEVER even attempted (key absent, not False) is kept regardless of name shape — None must not be treated as a confirmed non-match", "chk1" in places_kept_ids)

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("All checks passed.")
