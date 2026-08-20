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

### Three AI Search pipelines, in a strict fallback order

AI Search (`POST /api/ai-search`) tries three sources in order, each falling through to the next on failure/non-configuration/no results. The response always carries an explicit `pipeline: 'places-direct' | 'agent' | 'node-fallback'` field so it's never ambiguous which one actually answered a request (mirrored in the frontend as a small "via nearby buildings" / "via full research" / "via quick search" label near the results):

1. **Places-direct (`server.cjs`, India market only).** A direct Google Places text search for real, named residential buildings near the query's location — no lifecycle/eligibility classification (Places has no such concept), just honest real buildings. Tried first.
2. **The LangGraph agent (`agent/agent/`, Python) — primary classifying pipeline.** Multi-step agentic pipeline: query understanding → location resolution → parallel tool fan-out (Tavily/web/Apify/portal/developer search/Places) → evidence normalization → dedup → deterministic lifecycle/eligibility scoring → gap-check/targeted re-research loop → LLM curation → structured output. See `agent/README.md` for the full graph, the bridge circuit-breaker design, and the hard eligibility gate. Gated on `LANGGRAPH_ENABLED=true`; kept reliably up by `backend/scripts/run-agent.ps1`'s supervisor (restarts it on crash, does nothing if one's already listening on `AGENT_PORT` — the actual recurring failure mode this project has hit).
3. **`backend/external-search.cjs` — genuinely-last-resort fallback.** Reached only when both of the above are unavailable/unconfigured. No LLM, no page-fetch, and (as of the "Reduction pass" in `structure.md`) **no lifecycle/aggregator-page/geography classification** — that logic used to be duplicated here and has been deleted. This path now just does connector search, basic relevance scoring/ranking (`scoring.cjs`'s `scoreExternalProject`), spam/garbage-name sanity filtering, and exact-key dedup — it shows what a connector actually returned, honestly, the same unclassified way Places-direct does. `server.cjs`'s `/api/ai-search` route catches any agent failure and falls through silently ("a broken pipeline must never make AI Search worse than it already was").

Because the agent is now the only pipeline doing real lifecycle/eligibility classification, a correctness fix to that logic (`agent/agent/normalize.py`/`dedupe.py`/`scoring.py`) no longer needs a second copy kept in sync on the Node side — see `structure.md`'s "Reduction pass" section for the full before/after and why it was safe to delete (nothing outside `external-search.cjs`'s own `queryExternal()` called the removed functions).

`backend/agent-tools-bridge.cjs` is the HTTP bridge the Python agent calls back into (`/internal/agent-tools/*`, token-gated via `AGENT_INTERNAL_TOKEN`) to reuse existing Node connectors (Tavily, Google CSE, Bing, Apify, the 99acres/MagicBricks Playwright connector, the official IndiHomes catalog) — none of those connectors have a second implementation in Python.

### Backend (`backend/`)

All `.cjs` files are siblings in one flat directory — internal `require('./other.cjs')` calls all resolve within `backend/`. `server.cjs` is a single large Express app with every route defined inline (grep it for `app.get(`/`app.post(` rather than expecting a router-per-resource split). `db.cjs` uses Node's built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3` or another driver — `backend/data.sqlite` (gitignored, contains real lead PII) is the live database, seeded from `backend/seed/projects-seed.json`.

Key modules beyond `server.cjs`/`db.cjs`: `scoring.cjs` (IndiHomes-catalog project scoring for Filter/Property Search, plus the Node fallback's basic external-listing scoring/ranking — no longer eligibility classification, see above), `query-parser.cjs` (NL query → filters), `lead-events.cjs` (generic external event ingest — how the WhatsApp/voice bot reports activity via `POST /api/lead-events`), `qualification.cjs`, `lead-journey.cjs`, `meta-client.cjs`/`meta-capi.cjs` (Meta Lead Ads + Conversions API), `indihomes-client.cjs`/`indihomes-leads-client.cjs` (official IndiHomes APIs), `housing-client.cjs`, `redis-cache.cjs`.

### Frontend (`frontend/src/`)

**No router.** `App.jsx` keeps `view` as a plain `useState` string mapped against a `SCREENS` object; navigation is `setView(...)`, not URL-based. A hard refresh loses all in-memory state, including a selected AI Search candidate — this is a known, disclosed limitation, not a bug to silently fix as a side effect of unrelated work. Screens live in `components/screens/` (one file per app screen); shared building blocks in `components/shared/` and `components/ui/`; layout chrome (`Sidebar`, `TopBar`) in `components/layout/`.

### Config surface worth knowing

- `LANGGRAPH_ENABLED` / `AGENT_SERVICE_URL` / `AGENT_PORT` / `AGENT_INTERNAL_TOKEN` — gate and wire the Python agent.
- `AI_SEARCH_TIMEOUT_MS` and the `AGENT_BRIDGE_*` family — bound and circuit-break Node↔agent calls; see `agent/README.md`'s "Bridge reliability" section before touching timeout logic (a past incident conflated `ReadTimeout` with a dead bridge and poisoned unrelated calls).
- `AI_SEARCH_DEBUG_TRACE` — dev-only, attaches a `debug_trace` block to the AI Search response; read on the agent process for the LangGraph path, on the backend process for the Node fallback path (each pipeline reads its own copy).
- Full list of runtime env vars: `.env.example` (documented inline, grouped by feature).

Full list of file-level responsibilities, request/response wiring, and env vars is in `docs/main-docs/architecture.md` — prefer reading it over re-deriving the module map from scratch.
