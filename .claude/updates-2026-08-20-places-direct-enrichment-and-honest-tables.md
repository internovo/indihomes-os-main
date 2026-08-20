# 2026-08-20 — Places-direct enrichment, LLM "why," honest tables

Full detail (root cause, exact diffs, live verification, two real
debugging discoveries) lives in `structure.md`'s "Places-direct grows real
teeth" section — this file is a short index into that.

Two user decisions, both final and built exactly to spec: (1) Places-direct
should get real per-property web search for pricing, accepting it's now
slower; (2) unit config table is carpet + price only, no Total/Available/
Movement at all, not even a placeholder.

## Item 0 — agent-first routing: confirmed intact, unchanged

## Item 3 — Places-direct's bounded per-result enrichment (the big one)

New `agent/agent/tools.py enrich_property()` + `POST /agent/enrich-property`
(agent/app.py, same pattern as the existing `/agent/rera-lookup`), called
from `server.cjs`'s new `enrichPlacesResults()` for the top 12 Places
results (by relevance rank), in parallel, each bounded to 25s
(`PLACES_ENRICH_TIMEOUT_MS`). RESALE/RENTAL/READY_TO_MOVE → excluded
outright. Genuinely inconclusive → kept, `lifecycleStatus: 'UNKNOWN'`.
Agent unreachable → graceful, fast degrade (measured live: 0.86s for a
full 20-result response, all correctly unenriched).

**Two real debugging discoveries, not part of the original ask:**
- `web_search`'s own connectors (Google CSE + Bing) are dead in this
  deployment (CSE 403s, Bing unconfigured) — a pre-existing gap
  `rera_lookup()` silently had all along, first exposed by this pass
  actually depending on it. Fixed with a `tavily_search` fallback.
- **Real measured false-positive rate on category-page text: 9 of 12
  (75%)** in one live batch came back RESALE/RENTAL — traced to
  `classify_lifecycle_status()` reading portal navigation/filter-widget
  text ("Property Types / Flat for rent in Mumbai") as if it described
  the specific building, the same shape of bug as an earlier documented
  fix, just unpatched for this new input shape. **Deliberately not
  patched** — the task said reuse the classifier as-is. Disclosed as a
  real, known limitation for a follow-up pass to address (likely: prefer
  a more specific single-listing URL over a category page for this
  query).

**Real measured timing**: 45.06s wall-clock for a 12-candidate parallel
batch at a looser 45s-per-call test cap (one call didn't finish in time);
production's real 25s cap means the actual ceiling is ~25s — still >4x
faster than the 108.9s full-agent-path search documented earlier this
session, while genuinely no longer near-instant. Both numbers are real
measurements, not estimates.

## Item 4 — booking/rental/travel platform filter

New `places-client.cjs isBookingOrRentalPlatform()` (booking.com/Airbnb/
MakeMyTrip/OYO/goibibo/etc. by name or website, plus Places'
`lodging`/`hotel`/`travel_agency`/`vacation_rental_agency` types) — applied
before item 3's search ever runs. 7 new unit tests, all passing.

## Item 1 — real "why" via LLM, made visible

`key_match` (curator.py's LLM-grounded one-sentence reason) already
existed but was never actually shown — the card's `why` used a separate
mechanical picker instead. Fixed the priority so `key_match` wins first.
Tightened the LLM prompt and the no-LLM deterministic fallback to both
produce a real, location-preferred sentence. Places-direct's own
deterministic reason is untouched, no LLM call there.

## Item 2 — lifecycle badge, extended to Places-direct

`LIFECYCLE_LABEL` gained `UNKNOWN: 'Status unknown'` (muted, distinct
styling) and a previously-missing `PRE_LAUNCH` entry (a real gap found
along the way).

## Item 5 — Competitor Analysis strict filter

`aiSearchSiblings` now carries real `lifecycleStatus`; Competitor Analysis
excludes anything outside `{NEW_LAUNCH, PRE_LAUNCH, UNDER_CONSTRUCTION,
NEAR_POSSESSION}` — stricter than the main list, which labels instead of
hides.

## Item 6 — Project Description card removed

Confirmed AI Project Summary already has the same content as a fallback
first. Deleted the card plus ~115 lines of now-dead markdown-rendering
helper functions (confirmed no other callers before deleting).

## Item 7 — unit config table: Config/Carpet/Price only

Total/Available/Movement columns gone entirely, plus the now-dead
`movement()` helper and "Drishti flags" banner that depended on them. New
`configEvidenceRows` fallback reads `current.configuration_evidence` — the
same field/shape for both agent-sourced and (via item 3) Places-direct-
sourced properties.

## Tests & verification

+7 Node unit tests (`isBookingOrRentalPlatform`). Both existing suites
re-run clean throughout. `npm run build` re-confirmed after every frontend
change (bundle ~5KB smaller from dead-code removal). Every timing/exclusion
number above was directly measured via live requests or a standalone
script, not estimated.
