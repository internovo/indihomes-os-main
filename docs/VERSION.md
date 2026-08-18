# IndiHomes Platform — Version History

---

## v0.4.1 — 2026-07-03 · Claude Analyst Search

> Full detail: [IndiHomes-v0.4.1-Release-Notes.docx](./IndiHomes-v0.4.1-Release-Notes.docx)

### Changed
- **Claude is now the AI engine** — Anthropic `claude-sonnet-4-6` primary across all AI features; Groq (Llama 4 Scout) as automatic fallback; per-provider model env vars (`ANTHROPIC_MODEL`/`GROQ_MODEL`/`GEMINI_MODEL`)
- **AI Search → one Claude analyst response** — detailed tabulated markdown report grounded in live web research (Tavily) + our dataset: opening read → Comparison Table (Project/Developer/Location/Config/Price/Possession/RERA/Match %) → Primary matches with reasoning → Secondary/Stretch with exact gaps → Excluded → Analyst Verdict → `[n]` source citations + linked Sources box
- **Chat mode removed** — two search modes only (Filter / AI Search), per stakeholder direction; `/api/ai-chat` endpoint kept server-side, unused
- **In-app markdown renderer** — dependency-free; Claude's tables render as real styled HTML tables

### Fixed
- **Production data degradation (recurrence)** — "Scrape now" on the IP-blocked hosted server had overwritten good data at runtime (24/1). Fixes: `POST /api/scrape` returns 409 on blocked hosts (UI alerts); runtime guard rejects any scrape yielding <50% of current projects; seed refreshed & restored (**164 projects / 143 RERA / 54 intel**)
- Module locks removed; modules renumbered sequentially 01–18; user identity → Aarti Rawat

### Verified
- Local: 5,889-char report, table rendered in UI, 7 sources, 0 console errors; all 18 screens + all controls pass
- Production: `provider: anthropic`, 4,759-char report with table + 7 sources; scrape guard 409 confirmed

### Cost note
- Claude API is paid (≈₹2–4 per analyst search); Tavily free tier 1,000 searches/mo; Groq fallback free

---

## v0.4.0 — 2026-07-02 · AI Property Intelligence Agent

> Full detail: [IndiHomes-v0.4.0-Release-Notes.docx](./IndiHomes-v0.4.0-Release-Notes.docx)

### Features Added
- **AI Search** — natural-language query → extracted filter chips → projects ranked Primary/Secondary/Stretch/Excluded with match % and exact-gap "why" + executive summary
- **Live web discovery** — AI Search & Chat also search the open web (Tavily) in parallel; "Discovered on the live web" section with price, possession, RERA, match %, and clickable source links
- **AI Chat** — conversational search that asks for missing criteria ("What's your budget?"), keeps running filter state, honours "just search", renders full ranked results in chat (`POST /api/ai-chat`)
- **Live Web Research panel** (Project Intelligence) — dynamic on-demand research fills every box (summary, RERA, configs w/ carpet+price, price range, possession, amenities, connectivity, USPs, pros/cons) with a cited Sources list; works for ALL properties, no pre-scraping/storage
- **AI Due-Diligence report** — 14-section analyst report grounded in scraped facts with honest missing-data + sources
- **Predictive free-text Location** — type "gore" → Goregaon / Goregaon East / Goregaon West (case-insensitive); chips; East/West locality granularity added
- **Location & Configuration multi-select** + labelled filter fields; **nearby-location suggestion chips** (select Malad → +Goregaon +Kandivali +Borivali +Jogeshwari, no AI tokens)
- **Description → boxes auto-fill** — LLM parses scraped description prose into configs/USPs/amenities/units/towers/possession + clean summary (strictly extractive); `POST /api/reenrich-intel`

### Tech
- `llm.cjs` provider-agnostic LLM layer (Claude/Groq/Gemini via env; `LLM_MODEL` override) — currently **Groq · Llama 4 Scout** (free)
- `fetchWithRetry()` honours 429 rate-limit hints; model rotated for fresh per-model daily quota
- Web search layer: **Tavily** (default) / Serper — unaffected by portal IP blocks
- New endpoints: `/api/ai-search`, `/api/ai-chat`, `/api/ai-analyze`, `/api/ai-research`, `/api/ai-status`, `/api/research-status`
- All keys server-side (.env / Railway variables), never in the browser

### Fixes
- **Wrong-project intel (critical)** — "Lodha Luxuria" showed "Runwal One" data; dispatcher now routes by the listing link's site + name-validates every result; 15 bad cached entries purged & re-scraped
- Multi-phase RERA formatting — 13 phase numbers rendered as chips + "+N more (phases)" expander; fact grid overflow-armored
- Seed intel overwrites on boot so stale bad entries can't persist on the hosted DB
- App user identity → Aarti Rawat

### Verified (local + production)
- Web discovery: 7 projects (local) / 9 (production) for the demo query, with sources
- AI Chat asks for budget on partial query, then searches — verified on production
- Godrej Exquisite (zero scraped data) → full profile incl. RERA `P51700024496` + 6 cited sources

---

## v0.3.0 — 2026-07-01

### Deployment
| Layer | Platform | URL |
|---|---|---|
| **Frontend** | Vercel | https://indihomes-platform.vercel.app |
| **Backend API** | Railway | https://indihomes-api-production.up.railway.app |
| **Source repo** | GitHub | https://github.com/pragadeeshwaran7/Indihomes |

> As of 2026-07-01 the platform lives in its own standalone repo (`pragadeeshwaran7/Indihomes`).
> Vercel is Git-connected (auto-deploys on push to `main`). Railway connection: see notes below.

---

### Features Added / Updated

#### Project Intelligence — Real Scraped Data (no synthetic fallbacks)
- Deleted `syntheticIntel()` function entirely; all data is now sourced from live scrapers or marked unavailable
- Added `FieldBadge` component with three tiers: `verified` (green, scraped), `ai` (purple, LLM-derived), `unverified` (gray, inferred/unavailable)
- `resolveSourceLabel()` uses prefix matching so `99acres-local` correctly maps to the 99acres badge style
- RERA card: displays real scraped RERA numbers; no fake fallback; shows "Not found on listing" when genuinely absent
- "Verify on MahaRERA" button now opens the live MahaRERA portal
- "Export Brief" generates a real `.txt` file (browser download) with only genuine scraped fields
- "Onboard New Project" prompts for a name and triggers a live scrape automatically
- Demand Trend now shows Google Trends real-time data (`searchTrend.label`)
- Nearby Infrastructure map via OpenStreetMap Overpass API (airports, hospitals, schools, malls)
- Location map renders as an embedded Google Maps iframe using scraped lat/long
- Total/Available units: shows "Not published" (99acres genuinely hides per-config counts)
- Price movement defaults to `null` — shows "— not available" instead of fabricated "Steady"
- DRISHTI AI Signals section clearly labeled with `FieldBadge kind="ai"`
- Competitor analysis badge fixed (fallback to `live._sources?.competitors`)
- StrictMode double-fetch race condition fixed (`fetchedRef.current[key] = 'pending'`)

#### Project Selection → Project Intelligence Flow
- "Analyse Selected" button in Project Selection now passes the chosen project objects to the Intelligence view
- `onAnalyse(chosen)` callback wired from `App.jsx` through `ProjectSelection` → `ProjectIntelligence`
- `SOURCE_STYLE` extended: `99acres-local` and `magicbricks-local` badges now styled correctly

#### 99acres Scraper (`scripts/scrape_99acres.py`)
- Non-headless Chrome off-screen (`--window-position=-3000,-3000`) to bypass Akamai WAF on residential IPs
- New fields extracted: `latitude`, `longitude`, `localityName`, `reraVerifyUrl`, `reraQrUrl`
- `clean_html(text)` strips embedded marketing HTML tags from descriptions
- `known_url` fast path: skips search step if `listingUrl` already contains `npxid`
- Reads `window.__initialData__.projectDetailState.pageData`
- Page load timeout: 30 s

#### MagicBricks Scraper (`scripts/scrape_magicbricks.py`) — NEW
- Per-project scraper using `window.SERVER_PRELOADED_STATE_.projectDetailData`
- RERA extraction from `prjMobileBean.infoBean.reraValidity` (bracket-stripped, multi-phase split)
- Amenities from `mb.amenitiesList[].amenityName`
- Lat/long from `infoBean.psmLatitude` / `psmLongitude`

#### MagicBricks City Discovery (`scripts/scrape_magicbricks_list.py`) — NEW
- Discovers currently-listed projects per city via MagicBricks search results page
- Extracts `projectSocietyLink` slugs from `SERVER_PRELOADED_STATE_.searchResult`
- Returns `[{name, city, listingUrl}]`

#### Shared Chrome Utilities (`scripts/chrome_utils.py`)
- `detect_chrome_major_version()` — cross-platform (Linux via subprocess, Windows via PowerShell)
- `make_chrome_options()` — `--window-position=-3000,-3000` on Windows only; `--no-sandbox` + `--disable-dev-shm-usage` on Linux
- `make_driver(log=...)` — shared factory with `set_page_load_timeout(30)`

#### Backend API (`server.cjs`)
- `fetchNearbyInfra(lat, lon)` — Overpass API with required `User-Agent: IndiHomesOS/1.0` header
- `fetchSearchTrend(keyword)` — Google Trends via `google-trends-api` (no API key needed)
- `runPythonMagicBricksScraper()` / `runPythonMagicBricksListScraper()` — queued Python spawns
- `scrapeMagicBricksLocalList()` — replaces broken SSR approach
- `enrichProjectsWithRera()` — extended to handle MagicBricks listing URLs
- `scraperLog` ring buffer (300 entries) — accessible at `/api/debug/scraper-log`
- `/api/debug/connectivity` — diagnostic endpoint (runs `debug_connectivity.py`)
- `DISABLE_AUTO_SCRAPE=true` env var gates the 60-second auto-refresh cycle
- `apifyQuotaExceededUntil` cooldown — prevents repeated 90 s waits on a known-failed API
- Cache fix: only cache responses where `_scraped && !_error` (failures no longer lock in for 24 h)
- `pyScraperQueue` — Promise queue serialises Python spawns, prevents chromedriver binary race
- `discovered_rera` — enrichment table survives full snapshot rebuilds
- Root route returns health-check JSON: `{ ok:true, service:'IndiHomes API' }`

#### SQLite Persistence (`db.cjs`) — NEW
- Three tables: `project_intel`, `projects_snapshot`, `discovered_rera`
- 24 h TTL on cached intelligence; 20-row retention window on snapshots
- `DB_PATH` configurable via env var; defaults to `data.sqlite` in project root

#### Dockerfile + docker-entrypoint.sh — NEW
- Base: `node:22-bookworm-slim`
- Installs: Google Chrome Stable, Xvfb, Python 3, system fonts
- Python venv at `/opt/venv`; `PYTHON_BIN` env var used by server
- `docker-entrypoint.sh`: cleans stale Xvfb lock → starts Xvfb on `:99` → `exec node server.cjs`

---

### Fixes
| Issue | Fix |
|---|---|
| Port 3456 conflict | Removed hardcoded `--port 5173` from launch config |
| Apify quota exceeded | Cooldown timer; better error surfaced to UI |
| `parseBHK("2 & 3 BHK")` only returning `3 BHK` | Shared-suffix regex |
| Railway IP blocked by 99acres & MagicBricks | Diagnosed via connectivity diagnostic; `DISABLE_AUTO_SCRAPE=true` prevents snapshot degradation from Railway scrapes; workaround: upload `data.sqlite` from local machine |
| `--window-position` hangs Chrome on Railway/Xvfb | Made Windows-only in `chrome_utils.py` |
| Overpass API 406 | Added `User-Agent` header |
| `SOURCE_LABELS` exact-match bug | Prefix matching in `resolveSourceLabel()` |
| HTML-polluted descriptions | `clean_html()` in both scrapers |
| MagicBricks RERA bracket prefix | `strip('[]')` before split in `parse_rera_validity()` |
| Fake RERA fallback `P51700047865` | Removed entirely; honest "Not found" shown |
| Stale intel cache entries | Only cache `_scraped && !_error` |
| `npm ci --omit=dev` strips express/cors on Railway | Moved to `dependencies` in `package.json` |
| Xvfb stale lock on Railway restart | `rm -f /tmp/.X99-lock` in entrypoint |

---

### Known Limitations (v0.3.0)
- **Railway IP blocked**: 99acres and MagicBricks both return decoy/blocked responses from Railway's datacenter IP. Fix requires a residential proxy (BrightData, IPRoyal, Smartproxy). Current workaround: upload fresh `data.sqlite` from local machine.
- **MahaRERA form automation**: District filter won't cascade via automation. Deprioritised.
- **Housing.com**: Not built. Deprioritised after shipping MagicBricks.
- **Apify quota**: Monthly quota exceeded as of ~June 30, 2026; resets ~July 2, 2026. Serves as third-fallback only.
- **Total/Available units**: 99acres does not publish per-configuration unit counts; shows "Not published".

---

### Tech Stack

| Category | Technology |
|---|---|
| **Frontend** | React 18, Vite 5, plain CSS-in-JS |
| **Backend** | Node.js 22, Express 4, CommonJS (`server.cjs`) |
| **Persistence** | SQLite via `node:sqlite` (Node 22 built-in, experimental) |
| **Scraping** | Python 3 + `undetected-chromedriver`, Selenium, Xvfb (Linux) |
| **Containerisation** | Docker (`node:22-bookworm-slim` + Chrome Stable + Xvfb) |
| **Frontend hosting** | Vercel (static Vite build, `VITE_API_URL` env var) |
| **Backend hosting** | Railway (Docker, persistent volume for `data.sqlite`) |

### LLM / AI
| Usage | Model |
|---|---|
| DRISHTI AI Signals (templated analysis bullets) | Clearly labeled `FieldBadge kind="ai"` — no live LLM call in current release; template-based |
| Development assistant | Claude Sonnet 4.6 (Anthropic) |

### APIs & Integrations
| API | Usage | Key required |
|---|---|---|
| 99acres | Project data, RERA, lat/long, pricing | No (scraped) |
| MagicBricks | Project data, RERA, amenities, lat/long | No (scraped) |
| OpenStreetMap Overpass | Nearby infrastructure (hospitals, airports, schools) | No (free) |
| Google Trends (`google-trends-api`) | Demand trend / search interest | No |
| Apify | Fallback scraper (quota-limited) | Yes (`APIFY_TOKEN`) |
| MahaRERA portal | Verify link only (no automation) | No |

---

## v0.2.0 — 2026-06-30 (mid-session)

> Internal build; not independently tagged. Predecessor state before MagicBricks integration and Railway IP diagnosis.

- 99acres scraper working on residential IP
- SQLite persistence added
- Field-level badges introduced
- Export Brief, Onboard New Project buttons implemented
- Vercel + Railway initial deployment

---

## v0.1.0 — 2026-06-29

> First deployment. Commit: `28c7fa0 feat: initial release with secure Groq LLM extraction`

- Static React UI (Vite)
- All data synthetic / AI-estimated
- No backend persistence
- Express API with in-memory project list
- Apify as sole scraping backend
