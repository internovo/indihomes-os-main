# IndiHomes OS — System Architecture

## Top-level layout

```
frontend/   Vite + React app (screens, shared UI, static data)
backend/    Express API — all scraping/connector/CRM logic (18+ .cjs modules)
agent/      Python LangGraph research agent (AI Search deep-research pipeline)
shared/     Data used by both backend and agent (mmr-gazetteer.json)
docs/       Documentation
```

## How the pieces talk to each other

**Frontend → Backend.** The browser calls the Express API over HTTP using
`VITE_API_URL`. No shared code, no server-side rendering — a plain REST
boundary.

**Backend → Agent.** `backend/agent-tools-bridge.cjs` and the Python agent
talk over HTTP (`AGENT_SERVICE_URL`, default `http://localhost:8008`), not
via file imports. The bridge also exposes `/internal/agent-tools/*` routes
that the agent calls back into — e.g. `fetch-page`, which escalates to
`fetchRenderedPage()` on `backend/legacy-portal-connector.cjs` for
JS-heavy pages (the same Playwright launch that file already had — not a
second scraping framework).

**`shared/mmr-gazetteer.json`.** Read by 4 backend files (`scoring.cjs`,
`query-parser.cjs`, `azure-search.cjs`, `legacy-portal-connector.cjs`) and
by `agent/agent/gazetteer.py`. Lives in `shared/` because both sides need
it, not because of a build requirement.

**Backend internal requires.** All `.cjs` files live together in
`backend/`; internal `require('./other.cjs')` calls are all sibling
requires.

## Backend module map

| File | Responsibility |
|---|---|
| `server.cjs` | Express app, all route definitions, the `/api/ai-search` orchestration |
| `db.cjs` | SQLite access layer |
| `scoring.cjs` | Lead/project scoring — mirrors `agent/agent/scoring.py`'s deterministic classifiers for the Node fallback path |
| `llm.cjs` | LLM provider glue (Anthropic/Groq/Gemini) |
| `query-parser.cjs` | Natural-language query → structured filters |
| `azure-search.cjs` | Azure AI Search retrieval layer |
| `external-search.cjs` | Orchestrates external (non-IndiHomes) search — the Node fallback pipeline for AI Search |
| `external-connectors.cjs` | Tavily/Google CSE/Bing/Apify/legacy-portal connectors |
| `legacy-portal-connector.cjs` | Direct 99acres/MagicBricks Playwright connector |
| `agent-tools-bridge.cjs` | HTTP bridge the Python agent calls as its "tools" |
| `lead-journey.cjs` | WhatsApp/voice checkpoint timeline for a lead |
| `qualification.cjs` | Qualified/disqualified status logic, qualification-aware PATCH path |
| `lead-events.cjs` | Generic external event ingest (`POST /api/lead-events`) — how the WhatsApp/voice bot reports activity |
| `meta-client.cjs` / `meta-capi.cjs` | Meta Lead Ads client / Meta Conversions API sync |
| `indihomes-client.cjs` / `indihomes-leads-client.cjs` | Official IndiHomes Projects/Leads API clients |
| `housing-client.cjs` | Housing.com builder leads |
| `redis-cache.cjs` | AI Search result caching |

## Two AI Search pipelines, by design

AI Search has **two independent implementations** of the same
lifecycle/eligibility/dedup logic, kept in sync deliberately:

1. **Primary — `agent/agent/` (Python, LangGraph).** A multi-step agentic
   pipeline: discovery search → normalize → dedupe → score → curate →
   deep-research → gap-check → reclassify → final score. Has real
   page-fetch, LLM-driven fact extraction, and LangSmith tracing. See
   `docs/main-docs/../ai-search/architecture.md` for the full flow.
2. **Fallback — `backend/external-search.cjs` + `backend/scoring.cjs`
   (Node).** No LLM, no page-fetch/enrichment — pure connector search +
   regex-based classification. Used whenever `LANGGRAPH_ENABLED` is unset,
   or whenever the Python agent is unreachable/errors/times out (the
   `/api/ai-search` route catches any agent failure and falls through
   silently, exactly as if the flag were off — "a broken agent must never
   make AI Search worse than it already was").

Because the fallback is a *permanent, load-bearing safety net* (not a
transitional shim), several deterministic classifiers
(`classifyLifecycleStatus`, `isAggregatorTitle`, `RESALE_RE`/`RENTAL_RE`,
dedup key-building) are **mirrored line-for-line** between
`agent/agent/normalize.py`/`dedupe.py` and `backend/scoring.cjs`/
`external-search.cjs`. Bug fixes to these classifiers must be applied to
both, or the two pipelines will disagree on the same query depending on
which one happens to be live.

## Frontend module map

Screens live in `frontend/src/components/screens/`: `CommandCenter`,
`LeadScoring`, `LeadCapture`, `ProjectSelection` (Property Search + AI
Search), `ProjectIntelligence`, `SalesCRM`, `WhatsAppAgent`,
`AICallingAgent`, `AIRecommendations`, `AIAnalytics`, `AIWorkforce`,
`CampaignDeployment`, `CampaignRecommendations`, `CreativeStudio`,
`BuilderCollaboration`, `JunkDetection`, `UserManagement`,
`CallerDashboard`. Shared building blocks live in `components/shared/` and
`components/ui/`; layout chrome (`Sidebar`, `TopBar`) in
`components/layout/`.

The app has **no router** — `view` is a plain `useState` string in
`App.jsx`. A hard page refresh loses all in-memory state, including a
selected AI Search candidate. This is a known, disclosed, whole-app
limitation (see `current-state.md`), not something any single pass has
fixed.

## Config/env surface

- `LANGGRAPH_ENABLED` — gates whether `/api/ai-search` calls the Python
  agent at all.
- `AGENT_SERVICE_URL` — where the agent listens (default
  `http://localhost:8008`).
- `AI_SEARCH_TIMEOUT_MS` — bounds the backend's fetch to the agent (see
  `ai-search/known-bugs.md` for the real observed-latency history behind
  this value).
- `AI_SEARCH_DEBUG_TRACE` — dev-only; when `true` **on the agent
  process**, attaches a `debug_trace` block (query → normalized
  requirements → every rejected candidate + reason → qualified count →
  final order) to the response. Gated server-side, never shipped by
  default. (On the Node fallback path, the equivalent flag is read on the
  backend process itself, since that pipeline has no separate agent
  process.)
- `AGENT_BRIDGE_TIMEOUT_MS` / `AGENT_BRIDGE_CONNECT_TIMEOUT_MS` /
  `AGENT_BRIDGE_MAX_RETRIES` / `AGENT_BRIDGE_BACKOFF_BASE_MS` /
  `AGENT_BRIDGE_UNAVAILABLE_TTL_MS` — bound and circuit-break the agent's
  own calls back into `agent-tools-bridge.cjs`.
- `LLM_PROVIDER_CIRCUIT_TTL_MS` — process-level circuit breaker for a
  failing LLM provider.
- `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` —
  optional tracing, fully separate from application behavior.

No Azure index schema changes, no new environment variables beyond the
above have been introduced by any pass to date without being documented
here or in `decisions.md`.
