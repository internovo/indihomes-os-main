# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

IndiHomes OS — a real-estate CRM + AI-powered property search platform. Three runtimes in one repo:

- `frontend/` — Vite + React app (no build step for backend, no SSR).
- `backend/` — single Express API (`server.cjs`) + ~18 sibling `.cjs` modules for scraping, CRM, lead scoring, and connectors.
- `agent/` — Python/FastAPI service running a LangGraph deep-research pipeline for AI Search.
- `shared/mmr-gazetteer.json` — locality data read by both `backend/` and `agent/`.

Read `docs/main-docs/architecture.md` and `docs/main-docs/current-state.md` first for the authoritative system map and known limitations — this file only summarizes what changes how you should work in the code. `structure.md` documents the frontend/backend/agent/shared/docs reorg and exactly which path a `require()`/import resolves against, useful if something doesn't resolve as expected.

## Commands

```bash
npm run dev             # Vite dev server on :5174 (frontend only)
npm run server           # Express API on :3001 (backend/server.cjs)
npm run start             # both concurrently — normal local dev
npm run build              # production frontend build -> dist/ (repo root)
npm run free-port           # kill whatever is holding backend's port
npm run publish-seed          # publish backend/seed/projects-seed.json
```

Backend tests (plain-assert scripts, no jest/pytest — run directly, exit non-zero on failure):

```bash
node backend/tests/test_lifecycle_and_eligibility.cjs
agent/.venv/Scripts/python.exe agent/tests/test_lifecycle_and_eligibility.py
agent/.venv/Scripts/python.exe agent/tests/test_bridge_circuit_breaker.py
```

Run the agent service standalone (Python, separate venv from Node):

```bash
cd agent
.venv\Scripts\python app.py          # Windows
.venv/bin/python app.py               # macOS/Linux
```
Listens on `127.0.0.1:${AGENT_PORT:-8008}`; `GET /health` reports which LLM providers are actually reachable.

Run one query through the full agent graph without going through Node/the browser:
```bash
agent/.venv/Scripts/python.exe agent/_smoke_test.py "2 BHK in Borivali East under 1.5 Cr"
```

`test-indihomes.ps1` is an end-to-end smoke test against a running backend (`-BaseUrl`, default `http://localhost:3001`); `run-indihomes.ps1` installs deps if needed, launches the agent supervisor in the background, and runs `npm run start`.

There is no lint/format tooling configured in this repo.

## Architecture

### Three AI Search pipelines, in a strict fallback order — the agent is PRIMARY

AI Search (`POST /api/ai-search`) tries three sources in order, each falling through to the next on failure/non-configuration/no results. The response always carries an explicit `pipeline: 'places-direct' | 'agent' | 'node-fallback'` field so it's never ambiguous which one actually answered a request (mirrored in the frontend as a small "via nearby buildings" / "via full research" / "via quick search" label near the results):

1. **The LangGraph agent (`agent/agent/`, Python) — PRIMARY, tried first for every search.** This is a deliberate architecture choice, not a performance detail: most searches now genuinely take real time (35-140+ seconds observed live; `AI_SEARCH_TIMEOUT_MS`/`AGENT_TIMEOUT_MS`, 120000ms, bounds the wait — a real timeout falls through to Places-direct exactly like any other agent failure, verified live, no special-casing needed) rather than Places-direct's near-instant answers, and that tradeoff is intentional and accepted, not a regression to chase. Multi-step agentic pipeline: query understanding → location resolution → parallel tool fan-out (Tavily/web/Apify/portal/developer search/Places) → evidence normalization → dedup → deterministic lifecycle/eligibility scoring → gap-check/targeted re-research loop → LLM curation → structured output. See `agent/README.md` for the full graph, the bridge circuit-breaker design, and the hard eligibility gate. Gated on `LANGGRAPH_ENABLED=true`; kept reliably up by `backend/scripts/run-agent.ps1`'s supervisor (restarts it on crash, does nothing if one's already listening on `AGENT_PORT` — the actual recurring failure mode this project has hit). `ALLOWED_LIFECYCLE_STATUSES` (`agent/agent/normalize.py`) is exactly `{NEW_LAUNCH, PRE_LAUNCH, UNDER_CONSTRUCTION, NEAR_POSSESSION}` — `graph.py`'s `_apply_hard_eligibility_filter()` rejects everything else (READY_TO_MOVE, RESALE, RENTAL, or still-UNKNOWN after deep research) outright on the final pass, **no exceptions**. There used to be two escape hatches here (a Places-verified acceptance and a broader "UNKNOWN + valid-looking name" acceptance, both capped-score-and-honestly-labeled rather than rejected) — both were deliberately removed; this search strictly shows only confirmed new-project inventory, never a "real building, status unconfirmed" middle ground.
2. **Places-direct (`server.cjs`, India market only) — the FALLBACK.** Reached only when the agent above is disabled/unreachable/times out/throws. A direct Google Places text search for real, named residential buildings near the query's location, filtered first against known booking/rental/travel platforms (`places-client.cjs`'s `isBookingOrRentalPlatform` — booking.com/Airbnb/MakeMyTrip/OYO/`lodging` type/etc., deterministic, checked before any search runs). No longer purely instant/data-free: the top `PLACES_ENRICH_MAX_RESULTS` (12) results by Places' own relevance rank each get one bounded real web search + page fetch (`enrichPlacesResults`/`enrichOnePlacesResult` in `server.cjs`, calling the agent's own `POST /agent/enrich-property` — `agent/agent/tools.py`'s `enrich_property()`, reusing the exact same `fact_extraction.deterministic_extract`/`normalize.classify_lifecycle_status` machinery the main pipeline uses, never a second classifier) for real price + a lifecycle/exclusion check — a confirmed RESALE/RENTAL/READY_TO_MOVE result is excluded outright (the "no old properties" rule), a genuinely inconclusive one is kept and labeled `lifecycleStatus: 'UNKNOWN'`. Bounded by its own `PLACES_ENRICH_TIMEOUT_MS` (25000ms, separate from `AGENT_TIMEOUT_MS`) per candidate, run in parallel — degrades gracefully (fast) exactly like every other agent-dependent call when the agent's unreachable. This is deliberately slower than before (real, measured: ~25-45s for the bounded batch, vs previously near-instant) — an explicit, accepted tradeoff, not a regression to chase. **Known, disclosed limitation** (found via live measurement, not assumed): `classify_lifecycle_status()` run against a broad portal/category page (this enrichment's first search result often isn't a single tightly-scoped project page the way the main pipeline's candidate selection produces) has shown a materially higher false-positive RESALE/RENTAL rate here than in the main pipeline — see `structure.md`'s own section on this pass for the real measured numbers and reasoning; deliberately not patched, since the task's instruction was to reuse the classifier as-is, not tune a second one.
3. **`backend/external-search.cjs` — genuinely-last-resort fallback.** Reached only when both of the above are unavailable/unconfigured. No LLM, no page-fetch, and (as of the "Reduction pass" in `structure.md`) **no lifecycle/aggregator-page/geography classification** — that logic used to be duplicated here and has been deleted. This path now just does connector search, basic relevance scoring/ranking (`scoring.cjs`'s `scoreExternalProject`), spam/garbage-name sanity filtering, and exact-key dedup — it shows what a connector actually returned, honestly, the same unclassified way Places-direct does. `server.cjs`'s `/api/ai-search` route catches any agent failure and falls through silently ("a broken pipeline must never make AI Search worse than it already was").

Because the agent is now the only pipeline doing real lifecycle/eligibility classification, a correctness fix to that logic (`agent/agent/normalize.py`/`dedupe.py`/`scoring.py`) no longer needs a second copy kept in sync on the Node side — see `structure.md`'s "Reduction pass" section for the full before/after and why it was safe to delete (nothing outside `external-search.cjs`'s own `queryExternal()` called the removed functions).

A category page's `extract_sub_listings()`-derived sub-listings (`agent/agent/fact_extraction.py`) all inherit their PARENT page's `source_url` verbatim — `dedupe.py`'s URL-matching tier must never treat that shared, inherited URL as if it uniquely identifies one real listing (`source_type == "category_page_extract"` items are excluded from the URL tier entirely — matched only by RERA/name+locality/fuzzy). Getting this wrong silently collapses N genuinely different projects extracted from one category page into one fake merged candidate — see `structure.md`'s "AI Search root-cause pass" section (2026-08-20) for the live before/after.

Before any pipeline (agent/Places-direct/Node-fallback) processes a query, `server.cjs`'s `/api/ai-search` route runs `queryParser.isPropertySearchQuery()` once — a cheap, deterministic (no LLM) property-search-shaped-signal check that rejects prompt-injection/off-topic queries with a fixed `pipeline: 'blocked'` response before any branching.

`backend/agent-tools-bridge.cjs` is the HTTP bridge the Python agent calls back into (`/internal/agent-tools/*`, token-gated via `AGENT_INTERNAL_TOKEN`) to reuse existing Node connectors (Tavily, Google CSE, Bing, Apify, the 99acres/MagicBricks Playwright connector, the official IndiHomes catalog) — none of those connectors have a second implementation in Python.

### Backend (`backend/`)

All `.cjs` files are siblings in one flat directory — internal `require('./other.cjs')` calls all resolve within `backend/`. `server.cjs` is a single large Express app with every route defined inline (grep it for `app.get(`/`app.post(` rather than expecting a router-per-resource split). `db.cjs` uses Node's built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3` or another driver — `backend/data.sqlite` (gitignored, contains real lead PII) is the live database, seeded from `backend/seed/projects-seed.json`.

Key modules beyond `server.cjs`/`db.cjs`: `scoring.cjs` (IndiHomes-catalog project scoring for Filter/Property Search, plus the Node fallback's basic external-listing scoring/ranking — no longer eligibility classification, see above), `query-parser.cjs` (NL query → filters), `lead-events.cjs` (generic external event ingest — how the WhatsApp/voice bot reports activity via `POST /api/lead-events`), `qualification.cjs`, `lead-journey.cjs`, `meta-client.cjs`/`meta-capi.cjs` (Meta Lead Ads + Conversions API), `indihomes-client.cjs`/`indihomes-leads-client.cjs` (official IndiHomes APIs), `housing-client.cjs`, `redis-cache.cjs`.

### AI Search result cards never show a blank space for why/price/RERA/lifecycle

`ProjectSelection.jsx`'s `PropertyCard` follows the same "never silently blank, always honest" convention the rest of this app uses. **Why**: ONE short reason — for the agent path, `curator.py`'s `key_match` (a genuine, LLM-written, grounded-only-in-real-fields sentence) is preferred; `scoring.cjs`'s `pickPrimaryMatchReason()` (picks one reason from `match_reasons`, location preferred, never every reason joined with " · ") is the fallback for `key_match`-empty cases and is what the Node-fallback/Places-direct branches use directly (no LLM on those paths). **Price**: a real value, or an explicit "Price not available" — Places-direct's top `PLACES_ENRICH_MAX_RESULTS` results now get a real per-result price search (see the pipeline section above); a result outside that bound, or where nothing was found, still shows the honest empty state, never fabricated. **RERA**: a real number (`unverified` kind badge) or an explicit neutral "RERA not available" (`FieldBadge`'s `none` kind, no warning icon — a missing RERA number is a normal state, not a failure). **Lifecycle**: `LIFECYCLE_LABEL` renders a real eligible stage, or (Places-direct only, post-enrichment) an honest muted "Status unknown" — the agent path never emits UNKNOWN to the frontend at all (hard-rejected upstream).

AI Search's loading state (`ProjectSelection.jsx`'s `RESEARCH_STAGES` cycling message + spinner) reflects the agent-primary wait: the 5-stage cycle runs on a 4500ms interval and LOOPS (never freezes on the last stage, which used to misleadingly imply near-completion for the ~30-190+s a real wait spends past the old 4.4s full-cycle time), plus a real ticking elapsed-seconds counter (`elapsedSec`) that's the clearest "still working, not hung" signal for a wait this long.

`ProjectIntelligence.jsx`'s unit configuration table is Config/Carpet/Price only (Total/Available/Movement were removed from the table structure entirely, per an explicit final decision — not even an honest placeholder) — sourced from `current.configuration_evidence` (a dict keyed by configuration string, same field/shape whether it came from the agent's own deep research or Places-direct's per-result enrichment) as a fallback when there's no official IndiHomes `flatInventory`. The standalone "Project Description" card was removed (the AI Project Summary tile already carries the same content as its own fallback). Competitor Analysis (`siblingCompetitors`) strictly excludes any sibling whose `lifecycleStatus` isn't a confirmed eligible stage — deliberately stricter than the main results list, which labels an unknown status instead of hiding it.

### Frontend (`frontend/src/`)

**No router.** `App.jsx` keeps `view` as a plain `useState` string mapped against a `SCREENS` object; navigation is `setView(...)`, not URL-based. A hard refresh loses all in-memory state, including a selected AI Search candidate — this is a known, disclosed limitation, not a bug to silently fix as a side effect of unrelated work. Screens live in `components/screens/` (one file per app screen); shared building blocks in `components/shared/` and `components/ui/`; layout chrome (`Sidebar`, `TopBar`) in `components/layout/`.

### Config surface worth knowing

- `LANGGRAPH_ENABLED` / `AGENT_SERVICE_URL` / `AGENT_PORT` / `AGENT_INTERNAL_TOKEN` — gate and wire the Python agent.
- `AI_SEARCH_TIMEOUT_MS` and the `AGENT_BRIDGE_*` family — bound and circuit-break Node↔agent calls; see `agent/README.md`'s "Bridge reliability" section before touching timeout logic (a past incident conflated `ReadTimeout` with a dead bridge and poisoned unrelated calls).
- `AI_SEARCH_DEBUG_TRACE` — dev-only, attaches a `debug_trace` block to the AI Search response; read on the agent process for the LangGraph path, on the backend process for the Node fallback path (each pipeline reads its own copy).
- Full list of runtime env vars: `.env.example` (documented inline, grouped by feature).

Full list of file-level responsibilities, request/response wiring, and env vars is in `docs/main-docs/architecture.md` — prefer reading it over re-deriving the module map from scratch.
