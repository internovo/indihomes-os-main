# 2026-08-20 — strict lifecycle eligibility + honest result cards

Full detail (root cause, exact diffs, live verification) lives in
`structure.md`'s "Strict eligibility (no escape hatches) + honest result
cards" section — this file is a short index into that.

## 1. Closed the eligibility escape hatches

`agent/agent/normalize.py`'s `ALLOWED_LIFECYCLE_STATUSES` was already
exactly `{NEW_LAUNCH, PRE_LAUNCH, UNDER_CONSTRUCTION, NEAR_POSSESSION}` —
verified, not assumed, no change needed. The real gap:
`agent/agent/graph.py`'s `_apply_hard_eligibility_filter()` had two escape
hatches on the final pass that ACCEPTED a candidate outside that set anyway
(a Places-verified acceptance, and a broader "UNKNOWN + valid-looking name"
acceptance), both capped-score-and-honestly-labeled instead of rejected.
**Both removed entirely**, not weakened — READY_TO_MOVE/RESALE/RENTAL/
still-UNKNOWN-after-research is now rejected outright, no exceptions.
Live-verified: a real query against the agent went from 20 UNKNOWN
candidates (some of which would previously have shown capped-and-labeled)
to 3 final results, all confirmed UNDER_CONSTRUCTION.

The task also asked to mirror this into `backend/scoring.cjs`/
`external-search.cjs` — but that logic was already deleted from the Node
fallback in the prior session pass (see
`updates-2026-08-20-agent-supervisor-and-fallback-simplification.md`).
Surfaced this conflict directly; the user chose to leave the Node fallback
as-is (no lifecycle classification there at all).

## 2. One short "why" per card, everywhere

New `scoring.cjs`'s `pickPrimaryMatchReason()` — shared by all three
`/api/ai-search` branches — picks ONE reason (location match preferred,
then configuration match, then first-available) instead of joining every
reason with " · ". `match_reasons` (the full list) is untouched for other
consumers (Project Intelligence). Live-verified on all three pipelines:
Places-direct, Node-fallback, and the agent path all now return a single
short reason under 40 characters in the common case.

## 3. Price — option (b): honest "Price not available"

Places-direct has no price data (Google Places doesn't carry it). A
per-card price lookup (option a) was rejected: up to 20 results per query
× one extra search call each would erase Places-direct's whole reason for
existing (fast, no extra research). Implemented option (b): `FactChip`
gained an `emptyLabel` prop, used only for price, so a missing price
always shows "Price not available" instead of silently disappearing.
Confirmed live that the agent and Node-fallback paths already show real
prices when they have them (unaffected by this change).

## 4. RERA badge always renders

`FieldBadge` gained a new `none` kind ("Not available", no warning icon,
muted grey) — deliberately distinct from the existing `unverified` kind
(which has a ⚠ icon and would read as an error). `PropertyCard` now always
shows either the real RERA number or "RERA not available", never nothing.

## Tests

`backend/tests/test_lifecycle_and_eligibility.cjs`: +5 checks for
`pickPrimaryMatchReason`. `agent/tests/test_lifecycle_and_eligibility.py`:
the two test blocks asserting the old escape-hatch acceptance were
rewritten to assert strict rejection instead. Both suites (+ the bridge
circuit-breaker suite) re-run clean; `npm run build` re-confirmed.
