# IndiHomes OS — External Requirements

This lists every external credential the app can use: what breaks or stays degraded without it, where to get it, and the exact `.env` variable name(s). Nothing here is required to get the app running at all except the first section — everything else degrades gracefully to a clear "not configured" state rather than crashing.

**How to check what's currently configured** — this file is a reference for *what exists to configure*, not a live status snapshot (that goes stale the moment a key is added or removed). To see the actual current state, start the server (`npm run server` / `node server.cjs`) and read the `[startup] Integration status:` block it prints — it's generated fresh from `validateEnv()` in `server.cjs` every time the process boots, so it always reflects reality at that moment, not whatever was true when this file was last edited.

---

## Required (app won't serve Filter Search data at all without this)

- **`INDIHOMES_API_BASE_URL`** — already defaults correctly (`https://api.indihomes.co.in/api/v1`), no action needed. Filter Search (`GET /api/projects`) is the official IndiHomes catalog API — it's the *only* data source for Filter Search, and it needs no auth token.

---

## Known limitation (do not "fix" this by enabling Claude)

Project Intelligence's **Competitor Analysis**, **Nearby Infrastructure**'s AI-sourced supplementary list, **Pros/Cons**, and **Connectivity** boxes require a live-web-search-capable LLM provider. This app's `llm.webSearchAvailable()` only returns `true` for the Anthropic provider — Groq (currently configured in this environment) and Gemini do **not** support live web search in this codebase.

**Anthropic is intentionally not used in this deployment.** Do not set `ANTHROPIC_API_KEY` to "fix" this. Instead:

- Competitor Analysis will permanently show "Not available in this deployment" with a one-line explanation (not a bare "Not found" that reads like a data-quality bug) — this is already reflected in `ProjectIntelligence.jsx`.
- Nearby Infrastructure's *primary* data source is real, geocoded OpenStreetMap places (`/api/nearby-places`, no LLM involved) — unaffected. Only its secondary AI-sourced supplementary list is missing.
- Official IndiHomes data (description, inventory, RERA, amenities, possession) works fully regardless — Project Intelligence never requires an LLM to load.
- The code deliberately keeps the door open for a future non-Anthropic live-search provider (`llm.webSearchAvailable()` is a single, swappable check) rather than assuming Anthropic is the only possible answer — if a different provider ever adds real web search support, wiring it in shouldn't require touching every call site that currently checks for Claude specifically.

---

## Strongly recommended (a core feature is materially degraded without this)

- **`SUREPASS_API_TOKEN`** — powers the "Verify on MahaRERA" button's real government-registry check and the RERA certificate PDF link in Project Intelligence. Without it, RERA numbers still show (sourced from IndiHomes' own data or, as a last resort, extracted from the listing description) but can't be government-verified in-app — the "Verify on MahaRERA" button stays disabled with an explanatory tooltip.
  Get it: a Surepass account + API token. Sandbox: `https://sandbox.surepass.app` (no signup cost, test data only). Production requires a Surepass business account.
  Set: `SUREPASS_API_TOKEN=...` — optionally `SUREPASS_BASE_URL=...` when moving off the sandbox default.

---

## Strongly recommended — Competitor Analysis (Google Places API)

Project Intelligence's **Competitor Analysis** card needs this to show anything. Without it, the card honestly shows "Not connected" instead of a fabricated competitor list — nothing breaks, the feature is just off.

Steps:
1. Go to `https://console.cloud.google.com/` and open (or create) a project.
2. Search for **"Places API (New)"** in the API library and click **Enable**.
3. Go to **APIs & Services → Credentials → Create Credentials → API key**. Copy the key.
4. (Recommended) Click the new key → restrict it to **Places API (New)** only, with no HTTP referrer restriction (this key is called from the server, not the browser).
5. Add one line to your `.env` file: `GOOGLE_PLACES_API_KEY=<the key you copied>`.
6. Restart the server (`node server.cjs`). Check the `[startup] Integration status:` log line for "Competitor Analysis (Google Places)" — it should say "configured".

If you already have a working, unrestricted `VITE_GOOGLE_MAPS_KEY` with Places API enabled, you can reuse it instead of creating a second key — the server falls back to it automatically. A dedicated `GOOGLE_PLACES_API_KEY` is still recommended so the browser-facing key can stay locked to your website's domain.

---

## AI Search Agent (LangGraph) — a real multi-step research pipeline, optional

AI Search can run through a dedicated research agent (`ai-search-agent/`, a
Python FastAPI service running a LangGraph `StateGraph`) instead of the
single-pass connector query below it. It's a genuinely staged pipeline —
query understanding → location resolution (same shared gazetteer as
everywhere else) → research planning → parallel search across multiple
tools → evidence normalization → deduplication (conflicting prices/
possession dates across sources are preserved, never silently overwritten)
→ deterministic scoring → an optional LLM curator pass → structured output
— not a single prompt wrapped around one search API. See
`ai-search-agent/README.md` for the architecture in full.

**No Anthropic dependency anywhere in this pipeline or its optional LLM
providers** — Grok (xAI) and Gemini only, both reached via their
OpenAI-compatible endpoints through the one `openai` Python package, no
separate provider SDKs.

**It's fully optional and additive.** With `LANGGRAPH_ENABLED` unset (the
default), `/api/ai-search` behaves exactly as it did before this pipeline
existed — the section below ("AI Search external connectors") the flag
still runs, untouched. Even with the flag on, if the agent service is down,
unreachable, or times out, `/api/ai-search` silently falls back to that
same existing path rather than erroring the request — the agent can only
ever make a result better than the fallback, never worse or absent.

### Setting it up

1. **Python 3.11+** on the machine running the backend (a dedicated venv is
   strongly recommended — do not install into a shared/system Python):
   ```
   cd ai-search-agent
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt        # Windows
   # .venv/bin/pip install -r requirements.txt           # macOS/Linux
   ```
2. Add the env vars below to the **repo-root** `.env` (the agent service
   loads the same file the Node backend does — one source of truth for
   credentials, not a second `.env` to keep in sync).
3. Start the agent service (a long-running process, separate from
   `npm run server` — not spawned per-request, since importing LangGraph/the
   LLM SDKs on every search would be far too slow):
   ```
   cd ai-search-agent
   .venv\Scripts\python app.py
   ```
   It listens on `AGENT_PORT` (default `8008`), bound to `127.0.0.1` only.
4. Set `LANGGRAPH_ENABLED=true` in `.env` and restart `npm run server`.
   Confirm with `curl http://localhost:8008/health` — it reports which LLM
   providers (if any) are actually configured and reachable.

### Environment variables

| Variable | Required? | Frontend/Backend | Secret? | What it does / what happens if missing |
|---|---|---|---|---|
| `LANGGRAPH_ENABLED` | No (default off) | Backend (Node) | No | Routes `/api/ai-search` through the agent service. Unset/false = the pre-existing external-search.cjs path, unchanged. |
| `AGENT_SERVICE_URL` | No | Backend (Node) | No | Where Node reaches the Python service. Defaults to `http://localhost:8008` — only change for a non-default port or a separate host. |
| `AGENT_PORT` | No | Backend (Python) | No | Which port the FastAPI service binds. Default `8008`. |
| `AGENT_INTERNAL_TOKEN` | No (has a dev default) | Backend (both) | Yes, in any non-local deployment | Shared secret between Node and the Python agent for the internal tool-bridge (`/internal/agent-tools/*`) — the agent's only way to reach the real search connectors. Defaults to a fixed local-dev value; **set a real random value if this ever runs anywhere but localhost.** |
| `AI_SEARCH_TIMEOUT_MS` | No | Backend (both) | No | Per-request timeout for Node→agent calls and each individual tool call inside the agent. Default `45000` (45s). Too low on a slow connection risks falling back to the legacy path even when the agent would have succeeded. |
| `AI_SEARCH_CACHE_TTL_MS` | No | Backend (Python) | No | TTL for a full curated response, keyed by normalized query. Default 10 minutes — see "Caching strategy" in the agent's README. |
| `AI_SEARCH_SOURCE_CACHE_TTL_MS` | No | Backend (Python) | No | TTL for raw per-tool evidence (what stops every request from re-scraping the same portal). Default 6 hours. |
| `AI_SEARCH_INTEL_CACHE_TTL_MS` | No | Backend (Python) | No | TTL for an assembled `project_intelligence` payload. Default 24 hours. |
| `AI_SEARCH_MAX_RESEARCH_ITERATIONS` | No | Backend (Python) | No | Caps the research-gap loop (Part 19's "dig deeper into promising candidates" step). Default `1` — raising it trades latency/cost for depth. |
| `TAVILY_API_KEY` | No (optional, strongly recommended) | Backend (Node) | **Yes** | AI-native web search — the agent's primary research tool (tried in parallel with Google/Bing/Apify, not instead of them). Without it, the agent still works: the other configured connectors (or the deterministic path if none are) fill in. |
| `TAVILY_SEARCH_ENABLED` | No (default `false`) | Backend (Node) | No | Must be `true` (in addition to a key) for the connector to run — same on/off convention as `EXTERNAL_SCRAPING_ENABLED`/`LEGACY_PORTAL_SCRAPING_ENABLED` below. |
| `TAVILY_MAX_RESULTS` | No | Backend (Node) | No | Default `10`. Caps evidence volume (and API usage) per query. |
| `TAVILY_SEARCH_DEPTH` | No | Backend (Node) | No | Default `basic`. Sets the depth for the agent's first-pass discovery search only — targeted per-candidate research (once promising project names are known) always calls Tavily at `advanced` depth regardless of this setting, per the "don't spend advanced-search credits on a broad first pass" rule. |
| `TAVILY_TIMEOUT_MS` | No | Backend (Node) | No | Default `15000`. |
| `XAI_API_KEY` | No (optional) | Backend (Python) | **Yes** | Grok, via xAI's OpenAI-compatible API. Without it, the "reasoning" role (planning/curation) skips straight to its next configured fallback, or the fully deterministic path if nothing is configured. |
| `XAI_MODEL` | No | Backend (Python) | No | Defaults to `grok-4-fast`. |
| `GEMINI_API_KEY` | No (optional) | Backend (Python) | **Yes** | Gemini, via Google's OpenAI-compatible endpoint. Same graceful-skip behavior as xAI if unset. **This repo's `.env` already has one set** (shared with Project Intelligence's enrichment LLM) — confirmed live in this deployment that it authenticates but the configured `GEMINI_MODEL` may be stale/deprecated or the project's prepaid credits exhausted; both fail closed (logged, never crash) into the deterministic path. Check `/health` on the agent service to see the real current state. |
| `GEMINI_MODEL` | No | Backend (Python) | No | Defaults to `gemini-2.5-flash`. If Gemini calls 404, this is almost always a stale model name — check `https://ai.google.dev/gemini-api/docs/models` for the current name. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | No (optional) | Backend (Python) | **Yes** | Any OpenAI-compatible provider as a third option. Default model `gpt-4o-mini`. |
| `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_MODEL` / `LOCAL_LLM_API_KEY` | No (optional) | Backend (Python) | No (local) | An open-source/self-hosted model (e.g. Ollama, vLLM) exposing an OpenAI-compatible endpoint — for lightweight extraction/reranking without any per-token API cost. |
| `MODEL_REASONING` / `MODEL_EXTRACTION` / `MODEL_FALLBACK` | No | Backend (Python) | No | Which provider key (`xai`/`gemini`/`openai`/`local`) handles each role. Defaults: reasoning=`xai`, extraction=`gemini`, fallback=`gemini`. Each role always has a full fallback chain regardless of these settings — they only set the *preferred* order. |

None of the LLM provider keys are required — the agent produces a complete,
correctly-scored, real-evidence-backed result with zero LLM keys configured
(verified live in this deployment); they only add an LLM-written summary
and per-property "why" sentence on top of that same evidence.

### Recommended AI Search setup, by tier

**Minimum recommended** — real results, no LLM-written summary:
`TAVILY_API_KEY` + `TAVILY_SEARCH_ENABLED=true`, plus `AZURE_SEARCH_ENDPOINT`/
`AZURE_SEARCH_ADMIN_KEY` (required for the legacy path's retrieval layer;
the agent path doesn't need Azure).

**Recommended production setup** — adds redundancy across independent
search providers plus an LLM-written summary/curation pass:
`TAVILY_API_KEY` + `GOOGLE_CUSTOM_SEARCH_API_KEY`/`_CX` +
`BING_SEARCH_API_KEY`, plus one configured LLM provider (`XAI_API_KEY` or
`GEMINI_API_KEY` or `OPENAI_API_KEY` or `LOCAL_LLM_BASE_URL`).

**Optional enrichment**: `APIFY_TOKEN` + `APIFY_EXTERNAL_ACTOR_ID` +
`EXTERNAL_SCRAPING_ENABLED=true`.

**Optional legacy portals**: `LEGACY_PORTAL_SCRAPING_ENABLED=true` (see its
own known-limitations section above — residential-IP-only, narrow city
coverage).

No tier above is mandatory — every connector degrades independently and
gracefully; AI Search only goes fully empty if literally none of them (nor
Azure, for the legacy path) are configured.

### Setup steps for the search/scrape sources the agent's tools call

These are the SAME connectors "AI Search external connectors" below already
documents — the agent doesn't add any new source, it calls the existing
ones through an internal HTTP bridge (`agent-tools-bridge.cjs`,
`/internal/agent-tools/*` on the Node server). Follow that section's setup
steps for:

- **Tavily** (`TAVILY_API_KEY` + `TAVILY_SEARCH_ENABLED=true`) — **strongly
  recommended**, the agent's `tavily_search` tool, called in parallel with
  Google/Bing on every search (basic depth) and again per promising
  candidate during targeted research (advanced depth). An AI-native search
  API — its own retrieval already returns extracted page content rather
  than a bare snippet, which measurably improves the agent's ability to
  find and read actual builder/project pages compared to Google/Bing
  snippets alone. Get it: create an account at `https://tavily.com`,
  copy the API key from the dashboard.
- **Google Custom Search** (`GOOGLE_CUSTOM_SEARCH_API_KEY` + `_CX`) — the
  agent's `web_search`/`developer_search` tools. **Known issue in this
  deployment**: configured but returns `403: This project does not have
  the access to Custom Search JSON API` — the Custom Search JSON API needs
  to be explicitly enabled on the matching Google Cloud project (see that
  section's step 2); a key + search-engine ID alone isn't sufficient.
- **Bing Web Search** (`BING_SEARCH_API_KEY`) — same tools, tried alongside
  Google.
- **Apify** (`APIFY_TOKEN` + `APIFY_EXTERNAL_ACTOR_ID` + `EXTERNAL_SCRAPING_ENABLED=true`)
  — the `apify_search` tool. **Confirmed working live in this deployment**
  and, in practice, the most reliable of the web-search tools here (Google
  CSE's 403 above doesn't affect it — different code path entirely).
- **`LEGACY_PORTAL_SCRAPING_ENABLED=true`** (needs `npx playwright install
  chromium` once) — the `portal_search` tool (99acres + MagicBricks direct
  browse). See "Known limitations of the 99acres/MagicBricks connector"
  below — this is the most fragile tool in the plan and the agent is
  designed to work fine without it.
- Nothing extra is needed for the `official_lookup` tool — it calls the
  same always-on IndiHomes catalog API Filter Search uses.

### Known limitations of the 99acres/MagicBricks connector

Carried over, unchanged, from the existing `legacy-portal-connector.cjs`
(the agent's `portal_search` tool wraps this file directly, it doesn't
reimplement it):

- **Selector fragility**: both portals are React/Next SPAs; the connector
  tries a `__NEXT_DATA__`/Redux-state extraction first and falls back to
  generic CSS-class-substring DOM selectors (`[class*="projectCard"]`,
  etc.) if that's absent. A portal redesign can silently drop the DOM
  fallback's hit rate without throwing an error — it just finds fewer (or
  zero) items, logged server-side (`[legacy-portal-connector] ... -> N
  parsed`) but not surfaced as a failure to the UI, per this app's
  "no raw connector errors to sales users" rule.
- **Datacenter-IP blocking**: both sites' WAF blocks headless/datacenter
  traffic; this connector uses a real (non-headless, off-screen-positioned)
  browser window as a workaround, which only reliably works from a
  residential IP. **It has not been validated from a hosted/production IP**
  — expect it to silently contribute nothing once this app is deployed off
  a local machine, same limitation this app's now-retired Filter Search
  scraper had.
- **Narrow city coverage**: only Mumbai/Thane/Pune/Navi Mumbai have scrape
  URLs configured (`CITY_URLS_99ACRES`/`CITY_URLS_MAGICBRICKS`) — a
  resolved locality outside those four cities means this tool contributes
  nothing for that query (by design — it doesn't guess a URL).
- **"New projects" scope only**: both scraped pages are each portal's
  *new-projects* listing, a narrower set than their full resale/rental
  inventory — a real, currently-listed resale unit (which `apify_search`'s
  general web search DOES find, confirmed live) can legitimately return
  zero hits here. Not a bug; a scope difference between the two tools.
- **No public API for either portal** — the two `CONNECTORS` stub entries
  named `99acres`/`magicbricks` in `external-connectors.cjs` are placeholders
  for a possible future partner API agreement; they are permanently
  unconfigured today and are a *different* thing from this scraper
  (`legacy-portal-scraper`), which is the one actually wired into the plan.

### Aggregator/category-page filtering

A meaningful fraction of what web search returns for a real-estate query is
a portal's own *category* page ("14+ Apartments for Sale in Liberty
Garden") rather than an individual project/unit listing. The agent detects
this deterministically (a known info-page marker, or — after stripping
locality names via the shared gazetteer and generic real-estate filler
words — literally nothing distinctive left in the title) and caps such
results at TERTIARY regardless of how well their generic title happens to
match the query's keywords, so a real listing (which always names a
project/builder/unit) is never outranked by a search-results page that
merely mentions the right locality. See `ai-search-agent/agent/normalize.py`'s
`is_aggregator_title()`.

---

## AI Search external connectors (optional — configure at least one for AI Search to return real results, both India and Dubai)

- **`TAVILY_API_KEY`** + **`TAVILY_SEARCH_ENABLED=true`** — Tavily AI web search. **Strongly recommended** as the primary connector — see "AI Search Agent (LangGraph)" above for the full explanation of its role. Also used directly by the legacy (non-agent) `external-search.cjs` path, since it's registered in the same `CONNECTORS` list as Google/Bing/Apify.
  Get it: `https://tavily.com` → sign up → copy the API key from the dashboard.

- **`GOOGLE_CUSTOM_SEARCH_API_KEY`** + **`GOOGLE_CUSTOM_SEARCH_CX`** — Google Programmable Search Engine.
  Get it: create a search engine at `https://programmablesearchengine.google.com/`, then **enable the "Custom Search JSON API"** on the matching Google Cloud project at `https://console.cloud.google.com/apis/library/customsearch.googleapis.com` — a search engine + key alone is not enough; the API itself must be explicitly enabled on that Cloud project or every call 403s with "This project does not have the access to Custom Search JSON API" (a real failure mode seen in this deployment).

- **`BING_SEARCH_API_KEY`** — Azure Bing Web Search resource. The fastest fallback if Google 403s or its quota runs out, since it's a single API key with no partner agreement or actor setup.
  Get it: Azure Portal → create a "Bing Search v7" resource → Keys tab.

- **`APIFY_TOKEN`** + **`APIFY_EXTERNAL_ACTOR_ID`** — an Apify account + a Google-search actor (this deployment is tested against `apify~google-search-scraper`). Also needs `EXTERNAL_SCRAPING_ENABLED=true`.
  Get it: `https://console.apify.com` → Settings → Integrations, for the token; the actor ID is the actor's slug (`owner~actor-name`) from its Apify Store page.

- **`LEGACY_PORTAL_SCRAPING_ENABLED=true`** — no key needed, just a flag. Drives a direct (non-headless, off-screen-positioned) browse of 99acres/MagicBricks' public new-projects pages for AI Search, capped to Mumbai/Thane/Pune/Navi Mumbai. Needs Playwright's Chromium installed locally (`npx playwright install chromium`). Only reliable from a residential IP in production — datacenter IPs get WAF-blocked by both sites (see the code comment in `legacy-portal-connector.cjs` for the full explanation, and this app's own history of the same problem with the old Filter Search scraper).

All three above are also required, indirectly, for Azure AI Search to have anything to index — see the next section.

---

## Azure AI Search (required for AI Search's autocomplete/facets and the external-listings index to work at all)

- **`AZURE_SEARCH_ENDPOINT`** + **`AZURE_SEARCH_ADMIN_KEY`** — an Azure AI Search resource.
  Get it: Azure Portal → create an "AI Search" resource → Keys tab (use the **admin** key, not a query key — this app needs write access to index documents).
  Optional: `AZURE_SEARCH_EXTERNAL_INDEX` (defaults to `external-projects`) if you want a non-default index name.

---

## Lead Capture integrations (optional, per source — Lead Capture's local inbox always works regardless)

- **`HOUSING_API_KEY`** + **`HOUSING_USER_ID`** — Housing.com builder-leads API access.
  Get it: contact Housing.com's builder partnerships team. `HOUSING_API_URL` already defaults correctly.

- **`META_PAGE_ACCESS_TOKEN`** + **`META_PAGE_ID`** + **`META_WEBHOOK_VERIFY_TOKEN`** — Meta Lead Ads sync.
  Get it, step by step:
  1. Go to `https://developers.facebook.com/apps` and create (or open) a Meta App, add the **Lead Ads** product.
  2. Go to Graph API Explorer (or your app's token generation flow) and generate a **long-lived PAGE access token** — not a user token — for the specific Page the ad forms live on. A user token here is exactly what causes the real error this app hit: `(#10) User has insufficient privileges on the page`.
  3. When generating the token, grant these permissions: `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `ads_management`.
  4. Copy the Page's numeric ID into `META_PAGE_ID`.
  5. Add `META_PAGE_ACCESS_TOKEN=<the token>` to `.env`.
  6. The webhook subscription (`META_WEBHOOK_VERIFY_TOKEN`) is optional — the hourly poll works without it, it's only needed for push-based (near-real-time) sync. `META_GRAPH_VERSION` already defaults correctly. (`META_ACCESS_TOKEN` still works as a fallback name if you already had it set — `META_PAGE_ACCESS_TOKEN` is preferred since it's explicit about the token type required.)

- **`META_CAPI_ACCESS_TOKEN`** + **`META_DATASET_ID`** — Meta Conversions API reporting (reports each Meta lead's real CRM-push outcome — success or failed — back to Meta; a backend job, no UI button, run manually via `POST /api/leads/sync-meta-capi` or on the built-in hourly interval once configured).
  Get it, step by step:
  1. Go to Meta **Events Manager** (`https://business.facebook.com/events_manager2`) → Data Sources → create a new **Conversions API-only** dataset (no pixel needed). Copy its Dataset ID into `META_DATASET_ID`.
  2. In that dataset's Settings, generate a **System User access token** (or a Conversions API token) with `ads_management` permission on the dataset. Add it as `META_CAPI_ACCESS_TOKEN`.
  3. While testing: open the dataset's **Test Events** tab, copy the test event code shown there into `META_CAPI_TEST_EVENT_CODE`, run a sync, and confirm the events show up in Events Manager before removing that variable to go live.
  4. **Note on event meaning:** this app's only real "CRM status" is `leads.crm_status` (whether the push to IndiHomes' own `createLead` API succeeded) — there is no "interested/not interested" or "qualified/disqualified" signal anywhere in this codebase's data today. Events are named accordingly (`Lead_CRM_Push_Success` / `Lead_CRM_Push_Failed`), not as a fabricated qualification signal. If a real lead-qualification concept is added later, `meta-capi.cjs` is the one file to update.

- **`INDIHOMES_LEAD_PUSH_ENABLED=true`** — no key needed. Pushes every new (first-touch) captured lead to IndiHomes' own `createLead` endpoint (already live, no auth required per the Integration Brief) — the only path that reaches IndiHomes' actual system of record. Optional: `INDIHOMES_LEAD_PUSH_TIMEOUT_MS` to tune the request timeout. (As of 2026-08-13 this path is fixed — the underlying `createLead()` call had a bug where its actual network request was accidentally left commented out, so no push had ever gone through even when this flag was enabled.)

---

## Reference — every variable in one place

| Variable | Section |
|---|---|
| `INDIHOMES_API_BASE_URL` | Required (defaults correctly) |
| `SUREPASS_API_TOKEN`, `SUREPASS_BASE_URL` | Strongly recommended |
| `GOOGLE_PLACES_API_KEY` | Strongly recommended — Competitor Analysis |
| `LANGGRAPH_ENABLED`, `AGENT_SERVICE_URL`, `AGENT_PORT`, `AGENT_INTERNAL_TOKEN`, `AI_SEARCH_TIMEOUT_MS`, `AI_SEARCH_CACHE_TTL_MS`, `AI_SEARCH_SOURCE_CACHE_TTL_MS`, `AI_SEARCH_INTEL_CACHE_TTL_MS`, `AI_SEARCH_MAX_RESEARCH_ITERATIONS` | AI Search Agent (LangGraph) |
| `XAI_API_KEY`, `XAI_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, `MODEL_REASONING`, `MODEL_EXTRACTION`, `MODEL_FALLBACK` | AI Search Agent — LLM providers (no Anthropic) |
| `TAVILY_API_KEY`, `TAVILY_SEARCH_ENABLED`, `TAVILY_MAX_RESULTS`, `TAVILY_SEARCH_DEPTH`, `TAVILY_TIMEOUT_MS` | AI Search connector — strongly recommended |
| `GOOGLE_CUSTOM_SEARCH_API_KEY`, `GOOGLE_CUSTOM_SEARCH_CX` | AI Search connector |
| `BING_SEARCH_API_KEY` | AI Search connector |
| `APIFY_TOKEN`, `APIFY_EXTERNAL_ACTOR_ID`, `EXTERNAL_SCRAPING_ENABLED` | AI Search connector |
| `LEGACY_PORTAL_SCRAPING_ENABLED` | AI Search connector |
| `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_ADMIN_KEY`, `AZURE_SEARCH_EXTERNAL_INDEX` | Azure AI Search |
| `HOUSING_API_KEY`, `HOUSING_USER_ID`, `HOUSING_API_URL` | Lead Capture |
| `META_PAGE_ACCESS_TOKEN` (or `META_ACCESS_TOKEN`), `META_PAGE_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION` | Lead Capture |
| `META_CAPI_ACCESS_TOKEN`, `META_DATASET_ID`, `META_CAPI_TEST_EVENT_CODE` | Lead Capture — Meta Conversions API |
| `INDIHOMES_LEAD_PUSH_ENABLED`, `INDIHOMES_LEAD_PUSH_TIMEOUT_MS` | Lead Capture |

See `.env.example` for the full annotated list with inline comments, including local-dev-only settings (`PORT`, `DB_PATH`, `DISABLE_AUTO_SCRAPE`, etc.) not covered above since they're not external credentials.
