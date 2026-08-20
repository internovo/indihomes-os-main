# 2026-08-20 — agent supervisor, pipeline label, Node fallback simplification

Three changes, aimed at reducing complexity, not adding it. Full detail (root
cause, exact diffs, live verification) lives in `structure.md`'s "Reduction
pass" section — this file is a short index into that, per the request to
track updates here.

## 1. Agent supervisor — `backend/scripts/run-agent.ps1` (new)

The Python agent (`agent/app.py`, port 8008) had crashed from port conflicts
repeatedly throughout this project's history with nothing restarting it, so
AI Search silently fell back to a worse pipeline with no visible signal.

- A boring `while ($true)` loop — no pm2/systemd/Docker/new dependency.
  Restarts the agent if it exits, with a 5-second minimum restart interval
  (backoff) so a genuinely broken agent doesn't spin in a tight crash loop.
- On startup, checks whether `AGENT_PORT` (default 8008) is already
  listening and does nothing if so — the actual recurring failure mode here
  ("port already in use" from an old instance that never died), handled the
  simple way instead of finding-and-killing.
- `run-indihomes.ps1` now launches this supervisor in the background
  (non-blocking) before `npm run start`.
- **Live-verified**: started the supervisor, confirmed the agent came up on
  :8008, force-killed its `python.exe` process to simulate a crash, confirmed
  the supervisor brought it back up on its own with no human intervention.
  Process tree inspected directly (`run-agent.ps1` → `python app.py` →
  uvicorn worker), not assumed from logs.

## 2. Explicit `pipeline` field — `backend/server.cjs`, `ProjectSelection.jsx`

`/api/ai-search` already had three branches (Places-direct → agent → Node
fallback) but which one answered a request was only inferable from
inconsistent ad-hoc fields. Now every response carries
`pipeline: 'agent' | 'places-direct' | 'node-fallback'` explicitly, and the
frontend shows a small, unobtrusive label near the results ("via full
research" / "via nearby buildings" / "via quick search" — plain language,
no internal names).

- **Live-verified** against a running backend: a plain India query →
  `places-direct`; the same query in Dubai market with the agent down →
  `node-fallback`; the identical query with the agent started → `agent`
  (with a real `research_metadata` block attached). All three confirmed by
  actual HTTP requests, not read from the code.

## 3. Deleted the Node fallback's duplicated classification logic

`backend/external-search.cjs` used to independently re-implement the same
lifecycle/aggregator-page/geography/dedup classification the Python agent
already does — every correctness fix had to be made twice (see the many
"mirrors X exactly" comments throughout `structure.md`'s history). Since the
agent is now reliably kept up (change #1) and Places-direct already covers
the simple "show real buildings" case without any classification at all,
this duplication was investigated and found genuinely redundant.

**What was checked before deleting anything**: grepped every caller of the
functions in question (`isAggregatorTitle`, `classifyLifecycleStatus`,
`ALLOWED_LIFECYCLE_STATUSES`, `extractSubListings`, the fuzzy dedup tier)
across `backend/` and `frontend/`. All of them were called only from
`external-search.cjs`'s own `queryExternal()` — nothing else in the app
depended on them. `scoring.cjs`'s `scoreIndiHomesProject`/`filtersFromBuckets`
(used by Filter/Property Search against the official IndiHomes catalog — a
completely unrelated feature) were confirmed untouched.

**Deleted**: `isAggregatorTitle()`, `classifyLifecycleStatus()`,
`ALLOWED_LIFECYCLE_STATUSES`, the geography whole-phrase hard filter, the
fuzzy dedup tier inside `mergeDuplicateProperties` (exact-key tier stays),
and `extractSubListings()` (existed only to backfill from pages
`isAggregatorTitle` rejected). 524 lines deleted across `scoring.cjs`
(725 → 495) and `external-search.cjs` (841 → 547).

**Kept**: spam detection (`looksLikeUnrelatedCommerce`), the garbage-name
sanity gate (`looksLikeInvalidName` + Places-verify — a name-shape check,
not a lifecycle judgment), relevance scoring/ranking (`scoreExternalProject`
— ranks, never rejects), RERA/carpet-area/floor/connectivity extraction,
exact-key dedup, and the low-confidence floor.

This path is now genuinely last-resort (agent down AND Places-direct
unavailable) and behaves the same honest, unclassified way Places-direct
does — connector results shown as-is, no resale/rental/category-page
rejection.

**Tests**: `backend/tests/test_lifecycle_and_eligibility.cjs` trimmed from
70 to 28 checks — the deleted logic's own tests were deleted with it, every
other check kept as regression coverage and still passes. `agent/tests/`
(Python) is completely untouched — the agent keeps its full classification
pipeline. Both suites verified passing after all changes.
