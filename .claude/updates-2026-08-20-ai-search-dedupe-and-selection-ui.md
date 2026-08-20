# 2026-08-20 — AI Search root-cause pass: category-page merge collapse, portal_search fallback, injection defense, AI Search bulk selection

Six-item investigation grounded in a live "2BHK in Mahatre Wadi" trace. Full
narrative, live before/after evidence, and reasoning for every item is in
`structure.md`'s "AI Search root-cause pass" section (2026-08-20) — this
file is a short index of what changed, for anyone scanning dated updates
rather than the full narrative doc.

## Files changed

- `agent/agent/normalize.py` — `PORTAL_CATEGORY_TITLE_RE` now matches a
  bare "BHK Flats in X" category-page title with no leading count.
- `backend/agent-tools-bridge.cjs` — `FETCH_PAGE_MAX_CHARS` 6000 → 24000;
  `htmlToText()` strips `<nav>`/`<header>`/`<footer>` and filters blank
  lines more robustly.
- `agent/agent/dedupe.py` — **the real root-cause fix.** `dedupe()`'s
  URL-matching tier no longer matches/registers
  `source_type == "category_page_extract"` items (a category page's
  extracted sub-listings, which all inherit their parent page's URL
  verbatim) — stops N distinct sub-listings from one category page being
  force-merged into one fake candidate purely because they share an
  inherited, non-unique URL.
- `agent/agent/tools.py` — `portal_search()` falls back to `tavily_search()`
  (already portal-site-scoped) when the legacy Playwright portal connector
  returns nothing, same pattern as the existing `web_search` fallback.
- `backend/query-parser.cjs` — new `isPropertySearchQuery()` (deterministic
  property-search-shaped-signal check, no LLM).
- `backend/server.cjs` — `/api/ai-search` calls `isPropertySearchQuery()`
  once, before the agent/Places-direct/Node-fallback branching; returns a
  fixed `pipeline: 'blocked'` response for anything that fails the check.
- `frontend/src/components/screens/ProjectIntelligence.jsx` — geocode
  `useEffect` now depends on `knownGeo?.lat`/`knownGeo?.lon`; `mapQuery`
  prefers `current.projectName` over the possibly LLM-rewritten
  `current.name`.
- `frontend/src/components/screens/ProjectSelection.jsx` — `BriefBar`
  generalized (parameterized subtitle/action copy/icon/color) and reused
  for AI Search's new checkbox + "Analyse Selected" bulk flow
  (`AnalystReport`'s own `selectMode`/`selectedIds` state); `PropertyCard`
  gained a selection checkbox matching `ProjectCard`'s.
- `frontend/src/App.jsx` — the app's real scrollable viewport (the
  `overflowY:'auto'` div wrapping every screen) now resets `scrollTop` to
  0 on every `changeView`, fixing the reported "lands at the bottom of
  Project Intelligence" navigation bug.
- `agent/tests/test_lifecycle_and_eligibility.py` — 3 new checks:
  `dedupe()` run directly on a category-page-extraction scenario with 2
  sub-listings sharing one inherited URL, asserting they stay 3 distinct
  candidates with their own RERA intact.
- `backend/tests/test_lifecycle_and_eligibility.cjs` — 16 new checks for
  `isPropertySearchQuery`.

## Verification

- `node backend/tests/test_lifecycle_and_eligibility.cjs` — all pass.
- `agent/tests/test_lifecycle_and_eligibility.py` — 137 checks, all pass.
- `agent/tests/test_bridge_circuit_breaker.py` — all pass.
- `npm run build` — clean.
- Live, against the real running backend (port 3001) + agent (port 8008)
  processes, restarted between fix stages to pick up each change:
  - "2BHK in Mahatre Wadi" re-run 3 times (before all fixes / after
    classification+extraction fixes only / after the dedupe fix too) —
    `verification_results`/`source_conflicts` dropped from 7 giant
    merged-conflict candidates to 0 only once the dedupe fix landed; see
    `structure.md` for the full table.
  - `portal_search` tool call: `status: ok, count: 10, duration_ms: 448`.
  - `POST /api/ai-search {"query":"asdkjahsdkjahsd"}` → real
    `pipeline: 'blocked'` response with the expected warning text.

## Known gap, disclosed

Item 6 (bulk selection UI + scroll-to-top fix) was built and its React
state/props wiring traced by hand, and `npm run build` passes clean — but
no browser-automation tool was available in this session to actually click
through in a live browser and confirm visually. Not claimed as
browser-verified; flagged honestly instead.
