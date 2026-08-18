# Current State

Status snapshot of what's actually built, working, and verified — as
opposed to planned (`roadmap.md`) or historical (`ai-search/changelog.md`).
Dated to the most recent verified pass in this repo's history.

## Working and live-verified

- **Core CRM screens** (Command Center, Lead Scoring, Lead Capture, Sales
  CRM, Project Selection/Intelligence) — built on the official IndiHomes
  Projects API + SQLite, functioning.
- **AI Search — LangGraph pipeline** (`agent/agent/`). Deep-research
  pipeline with real page-fetch, deterministic lifecycle/eligibility
  classification, structured fact extraction with provenance, geography
  hard-filter, fuzzy entity resolution, retrieval-metrics-based honest
  empty-result explanations. Live-verified across many real queries
  (Malad West, Charkop Kandivali, Dahisar West/Kandarpada, IC Colony
  Borivali). Test coverage: `agent/tests/test_lifecycle_and_eligibility.py`
  (99 checks as of the most recent pass).
- **AI Search — Node fallback pipeline** (`backend/external-search.cjs` +
  `backend/scoring.cjs`). Mirrors the Python pipeline's classifiers; used
  automatically whenever the agent is unreachable. Test coverage:
  `backend/tests/test_lifecycle_and_eligibility.cjs` (39 checks).
- **Lead events / AI Activity / qualification pipeline**
  (`lead-journey.cjs`, `qualification.cjs`, `lead-events.cjs`). WhatsApp/
  voice bot activity ingested via `POST /api/lead-events`, surfaced on the
  Lead Capture detail view (AI Activity card, Lead Journey checkpoint
  tracker).
- **Meta integration** — Lead Ads client + Conversions API sync, hourly
  `runMetaCapiSync()` sweep covering qualification status too.
- **Project Intelligence** — description/inventory, USPs/audience, nearby
  infrastructure, competitor analysis (Google Places, radius-configurable,
  non-residential place types filtered out).

## Known, disclosed limitations (not bugs — intentionally not chased)

- **No frontend router.** `view` is a plain `useState` string; a hard
  refresh loses all in-memory state including a selected AI Search
  candidate.
- **Dedup gaps on garbled source text.** The same real project can still
  surface as 2-4 separate cards when different portals' extracted
  `location` text differs wildly (one observed case: a portal's
  "location" field was literally "Dem Icon Rera, Details, Legal
  Documents, Construction Status" — a garbled extraction, not a real
  place name — which defeats both the exact-key and fuzzy dedup tiers).
- **Instagram-sourced candidates: no name-extraction/dedup refinement
  yet.** Since the social-media aggregator-gate fix (see
  `ai-search/known-bugs.md`), genuine developer-marketing Instagram posts
  can now surface as eligible candidates, but two posts from the same
  developer account about the same underlying project can appear as
  separate, poorly-named cards (one literally titled "Instagram" — a
  title-extraction fallback artifact). Both are honestly low-scored and
  correctly caveated, never fabricated — this is a display-quality gap,
  not a correctness bug.
- **No candidate cancellation on agent timeout.** When the backend's
  `AI_SEARCH_TIMEOUT_MS` fires, the Python agent is not told to stop — it
  keeps computing to completion in the background for a result nobody
  will see (confirmed live: ~150s of real Tavily/Apify/Gemini API spend
  discarded on a single timed-out request). See `ai-search/known-bugs.md`
  and `roadmap.md`'s async-job-pattern proposal.
- **AI Search is a single synchronous HTTP request/response** for a
  pipeline that can genuinely take 50-170+ seconds. No progress signal
  from the backend; the frontend's "Ranking matching properties…" stage
  indicator is a purely client-side timer with no real completion signal.
- **No in-app "share this AI Search candidate to a lead's WhatsApp"
  flow.** `detail_shared` ("Property details shared") is populated
  exclusively by an external system (`Indihomes-chatbot-V1`) via the
  generic lead-events ingest — fully decoupled from Project
  Intelligence/AI Search. Building an in-app trigger for this was
  evaluated and deliberately not attempted (a substantial net-new
  feature, not a fix to something broken).
- **Competitor Analysis / Geocoding fallback depend on
  `GOOGLE_PLACES_API_KEY`** having Places API (New) + Geocoding API
  enabled on the owning Google Cloud project — an external configuration
  state outside this codebase's control. As of the most recent status
  check, the configured key returns `403 API_KEY_SERVICE_BLOCKED`.

## Testing discipline in effect

Every correctness pass documented in `ai-search/changelog.md` was
verified against the real, live pipeline (real Tavily/Google/Gemini
calls, real running backend + agent processes), not unit-tested in
isolation only. Plain-assert test scripts (no pytest/jest dependency) are
run directly:

```
agent/.venv/Scripts/python.exe agent/tests/test_lifecycle_and_eligibility.py
node backend/tests/test_lifecycle_and_eligibility.cjs
```

Both exit non-zero on failure.
