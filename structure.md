# IndiHomes OS — Restructured Layout

This document explains how the codebase was reorganized from the original
flat layout into `frontend/`, `backend/`, `agent/`, `shared/`, and `docs/`.

**No application logic was changed.** Every edit below is a *path/wiring*
change (an import path, a `require()` target, an npm script, a Docker
`COPY` line) made necessary purely by moving a file to a new folder. Every
`.cjs` file was `node --check`ed and every `.py` file was
`python3 -m py_compile`d after the move to confirm nothing broke.

## New top-level layout

```
.
├── frontend/               # Vite + React app (was: root-level src/, index.html, vite.config.js)
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── index.css
│       ├── components/
│       │   ├── layout/     # Sidebar, TopBar
│       │   ├── screens/    # one file per app screen (CommandCenter, LeadScoring, ...)
│       │   ├── shared/     # Chip, ModuleHeader, StatCard
│       │   └── ui/         # low-level building blocks (EditableField, StatusPill, tokens...)
│       └── data/           # static frontend data (campaigns.js, leads.js, projects.js)
│
├── backend/                 # Express API + all scraping/connector logic (was: 18 .cjs files loose at repo root)
│   ├── server.cjs           # main Express app / route definitions
│   ├── db.cjs                # SQLite access layer
│   ├── scoring.cjs           # lead/project scoring logic
│   ├── llm.cjs                # LLM provider glue (Anthropic/Groq/Gemini)
│   ├── query-parser.cjs       # NL query -> filters
│   ├── azure-search.cjs       # Azure AI Search retrieval layer
│   ├── external-search.cjs    # orchestrates external (non-IndiHomes) search
│   ├── external-connectors.cjs# Tavily/Google CSE/Bing/Apify/legacy-portal connectors
│   ├── redis-cache.cjs
│   ├── meta-capi.cjs          # Meta Conversions API
│   ├── meta-client.cjs        # Meta Lead Ads client
│   ├── indihomes-client.cjs   # official IndiHomes Projects API client
│   ├── indihomes-leads-client.cjs
│   ├── housing-client.cjs     # Housing.com builder leads
│   ├── legacy-portal-connector.cjs  # direct 99acres/MagicBricks Playwright connector
│   ├── legacy-scrapers.cjs
│   ├── lead-intake.cjs
│   ├── agent-tools-bridge.cjs # HTTP bridge the Python agent calls as its "tools"
│   ├── seed/
│   │   └── projects-seed.json
│   └── scripts/              # ops/scraping scripts (was: root-level scripts/)
│       ├── free-port.mjs, publish-seed.mjs, refresh-and-publish.mjs, prescrape-intel.mjs
│       ├── register-refresh-task.ps1
│       ├── requirements.txt
│       ├── chrome_utils.py, debug_connectivity.py
│       └── scrape_99acres*.py, scrape_magicbricks*.py
│
├── agent/                    # Python LangGraph research agent (was: ai-search-agent/, renamed only)
│   ├── app.py                 # FastAPI(?)/HTTP entrypoint, called by backend/agent-tools-bridge.cjs
│   ├── requirements.txt
│   ├── README.md
│   ├── _smoke_test.py
│   └── agent/                 # planner, tools, scoring, gazetteer, cache, etc. (internal structure untouched)
│
├── shared/                    # data used by BOTH backend and agent (was: mmr-gazetteer.json at repo root)
│   └── mmr-gazetteer.json
│
├── docs/                      # documentation & status reports (was: loose .md/.docx files at repo root)
│   ├── STATUS.md, VERSION.md, requirements.md, INDIHO_3.DOC
│   └── IndiHomes-*.docx (release notes, status snapshots, procurement doc)
│
├── package.json, package-lock.json   # unchanged location — npm needs these at repo root
├── Dockerfile, docker-entrypoint.sh  # unchanged location — deploy convention
├── run-indihomes.ps1, test-indihomes.ps1
├── .env.example, .gitignore, .dockerignore
├── .claude/launch.json
└── structure.md               # this file
```

## How it's wired together (routing rules)

**Frontend → Backend:** the browser talks to the API over HTTP using
`VITE_API_URL` (from `.env`) — this was already decoupled from file paths,
so it needed no changes.

**Backend → Agent:** `backend/agent-tools-bridge.cjs` and the agent talk to
each other over HTTP (`AGENT_SERVICE_URL`, default `http://localhost:8008`),
not via file imports — also unaffected by the move.

**Backend internal requires:** every `.cjs` file's `require('./other.cjs')`
call pointed at a sibling file. Since *all* `.cjs` files moved into
`backend/` together, every one of those relative requires still resolves
correctly with zero edits.

**`shared/mmr-gazetteer.json`:** this file is read by 4 backend files
(`scoring.cjs`, `query-parser.cjs`, `azure-search.cjs`,
`legacy-portal-connector.cjs`) *and* by `agent/agent/gazetteer.py`. Since it
serves both `backend/` and `agent/`, it now lives in a `shared/` folder
instead of inside either one. Updated:
- the 4 backend `require('./mmr-gazetteer.json')` → `require('../shared/mmr-gazetteer.json')`
- `agent/agent/gazetteer.py`'s `GAZETTEER_PATH` → now points at `.../shared/mmr-gazetteer.json`

**`backend/seed/` and `backend/scripts/`:** these moved *together* with the
files that reference them (`server.cjs`, `publish-seed.mjs`), and those
files compute their paths relative to their own location (`__dirname`), so
no edits were needed — the relationship was already relative, not hardcoded.

**`backend/scripts/register-refresh-task.ps1`:** the one script whose path
math needed a real fix. It used to sit one level under the repo root
(`scripts/`) and computed `RepoRoot` as `..` from its own location. It now
sits two levels under the repo root (`backend/scripts/`), so it now computes
`RepoRoot` as `..\..` to keep pointing at the true repo root, and its target
script (`refresh-and-publish.mjs`) is now referenced directly via
`$PSScriptRoot` (same folder) instead of rebuilding the old path. Net
effect: identical runtime behavior, correct new paths.

**`server.cjs`'s one dead/vestigial require:** line 15 has
`try { scoreProjects = require(path.resolve(__dirname, '..', 'indihomes', 'scorer.js')) } catch(_) {}`
wrapped in a silent `try/catch` — it already pointed *outside* the repo
before this reorg and was never found (dead code, tolerated by the
`catch`). Since `server.cjs` moved one folder deeper, an extra `'..'` was
added to keep it resolving to the *exact same* external path it always
pointed at, so its (already no-op) behavior is unchanged.

## What changed in each config/deploy file, and why

| File | Change | Why |
|---|---|---|
| `frontend/vite.config.js` | added explicit `root` (pinned to `frontend/`) and `build.outDir: '../dist'` | Vite's root used to default correctly since it ran from repo root; now the config file lives inside `frontend/`, so root is pinned explicitly, and the build output is redirected up one level so `dist/` still lands at the repo root, exactly as before |
| `package.json` scripts | `dev`/`build`/`preview` now pass `--config frontend/vite.config.js`; `server`/`free-port`/`preserver`/`publish-seed` now point at `backend/...` | scripts moved, npm always runs from repo root |
| `docker-entrypoint.sh` | `node server.cjs` → `node backend/server.cjs` | server.cjs moved |
| `Dockerfile` | `scripts/requirements.txt` → `backend/scripts/requirements.txt` (2 lines) | scripts/ moved |
| `.gitignore` | `ai-search-agent/...` → `agent/...` | folder renamed |

Files intentionally **left untouched** because nothing about their content
depends on file location: `.env.example` (pure env vars), `.dockerignore`
(patterns are basename-matched, location-independent), `run-indihomes.ps1`
and `test-indihomes.ps1` (they only call `npm run <script>` by name, never
touch file paths directly), `.claude/launch.json` (same — npm script names
only), `package-lock.json`.

## Note on `docs/*.docx` and `docs/INDIHO_3.DOC`

These are binary Word documents. They were moved into `docs/` in this
restructuring, but binary files could not be transferred through the
filesystem tool used to write this repo to your Desktop (it only writes
text). If they're missing from the Desktop copy, copy them manually from
the original `git clone` — they are pure documentation and were not opened
or altered.

---

## Lead events / AI Activity / Meta qualification feature

Added on top of the restructuring above — see `backend/LEAD_EVENTS_INTEGRATION.md`
for the full writeup. Short version: three new backend files
(`lead-journey.cjs`, `qualification.cjs`, `lead-events.cjs`), extensions to
`db.cjs` and `meta-capi.cjs`, and `server.cjs` itself was directly wired
(new require + router mount, the `PATCH /api/leads/:id` handler now routes
status/sub-status through a qualification-aware path, the hourly
`runMetaCapiSync()` sweep also covers qualification, and
`GET /api/leads/sync-status` reports the new pipeline's status). The Lead
Capture screen's detail view gained an "AI Activity" card (WhatsApp/voice
mascots with a delivery tick, plus a status/sub-status strip) and a "Lead
Journey" vertical checkpoint tracker.

Every new backend module was fully tested in a sandbox (a real throwaway
SQLite file, a real Express server, real HTTP requests) before being
copied here; the actual boot of `server.cjs` with these changes folded in
was **not** executed from where this was built (no ability to run this
repo's Node process directly) — see `backend/LEAD_EVENTS_INTEGRATION.md`'s
"Testing performed" section for the exact pre-flight checklist to run
before trusting this in production, including backing up `data.sqlite`
first.

---

## Lead Capture AI Activity + Project Intelligence layout + AI Search enrichment

A later pass on top of everything above — same "minimal, targeted change"
discipline, no rewritten architecture, no removed functionality.

**Lead Capture (`frontend/src/components/screens/LeadCapture.jsx`):**
- The leads table's last column ("CRM") is now "AI Activity" — small
  WhatsApp/voice mascot dots per row (`AiActivityMini`/`MiniMascotDot`),
  backed by four new lightweight `EXISTS(...)` boolean columns
  (`ai_whatsapp_active`, `ai_whatsapp_failed`, `ai_voice_active`,
  `ai_voice_failed`) `db.cjs`'s `listLeadsStmt` now projects straight off
  `lead_events` — one query for the whole list, not one fetch per row. The
  CRM push status itself is untouched server-side and still visible on
  every lead's detail view (`CrmBadge` in the Lead Overview card).
- The Lead Detail AI Activity card's status strip now has explicit
  "Status" (an inline `StatusEditor` — the exact same qualification-aware
  PATCH path, reused not duplicated) and "Sub Status" labels, plus a
  three-state `QualificationBadge` (Qualified / Disqualified / "Not yet
  classified") so a lead that hasn't reached either extreme is never just
  silently blank.

**Project Intelligence (`frontend/src/components/ui/SectionCard.jsx` +
`frontend/src/components/screens/ProjectIntelligence.jsx`):**
- `SectionCard` now stretches to fill its grid cell (`height:'100%'`,
  flex column, body `flex:1`) instead of sizing purely to its own content.
- The four paired-card grid rows (Description/Inventory, USPs/Audience,
  Nearby Infra/Map, Competitors/...) no longer force `alignItems:'start'`,
  so CSS Grid's default `stretch` applies — a short card's bottom edge now
  lines up with its taller sibling instead of leaving a misaligned gap.
  Existing `EmptyState`/`EmptyValue` components (already used throughout
  this file) still own every "no data" case — nothing new invented there.
- Project Description's clamp-to-~150px + real "Read more" toggle
  (`DescriptionSummary`) already produced a 5–10 line initial view before
  this pass; left as-is (Regenerate button, source attribution, AI-signals
  block: also untouched).

**AI Search (`backend/external-connectors.cjs`, `backend/external-search.cjs`,
`frontend/src/components/screens/ProjectSelection.jsx`):**
- Connectors (`baseExternalProject`) now extract amenities (reusing
  `query-parser.cjs`'s existing amenity vocabulary), a conservative
  developer guess (only on an explicit "by X" / "Developer: X" mention),
  and a property-type keyword — all purely extractive from the listing's
  own title/snippet text, no extra request, no LLM call.
- `external-search.cjs` now also extracts carpet/built-up area, floor/tower
  count, and a connectivity mention from the same already-fetched text;
  computes a structural `dataQuality` (high/medium/low) signal; folds
  requested-amenity matches into the existing real `why`/match-reason
  string; and merges same-project duplicates surfaced by two different
  connectors (`mergeDuplicateProperties`, exact normalized-name match only)
  so "Sources: MagicBricks + Developer Website" collapses into one card
  instead of two. A very-low-confidence floor (`match_score >= 15`) trims
  clearly-irrelevant results, but never down to zero. No Azure index schema
  change was needed — every new field either already existed in
  `externalSchema` (amenities/developer/propertyType/description) or is
  derived at query time from already-stored text.
- `ProjectSelection.jsx`'s `PropertyCard` now renders a real hierarchy
  (identity row → key facts → secondary facts → amenities → match-reason
  line → action) instead of one comma-joined meta line, using the same
  `FieldBadge`/chip language already used elsewhere in the app.

No Azure/DB schema changes, no new environment variables, no new paid
provider — see the implementation report in this session's conversation
for the full validation notes and known limitations (no connector API keys
configured in this environment, so the enrichment code is verified by
direct unit checks and a full `require()`/build pass, not a live search).

---

## AI Search agent — upgraded to an agentic deep-research pipeline

A later pass, on the Python agent (`agent/`) this repo already had (see
`agent/README.md` for the full writeup — this is a pointer, not a
duplicate). Short version: the existing LangGraph pipeline (discovery
search → normalize → dedupe → score → curate) gained real per-candidate
page research — a new `fetch_page` tool (`agent/tools.py`, backed by a new
`/internal/agent-tools/fetch-page` route in `backend/agent-tools-bridge.cjs`,
escalating to a new `fetchRenderedPage()` export on
`backend/legacy-portal-connector.cjs` for JS-heavy pages — same Playwright
launch that file already had, not a second scraping framework), structured
fact extraction with provenance (`agent/fact_extraction.py`, new), a
field-aware research-gap checker (`agent/gap_checker.py`, new) that drives
specific targeted follow-up searches instead of repeating the original
query, and cross-source conflict preservation extended into a structured
`VerificationResult`. The loop (deep_research → gap-check → targeted
research → verify → re-score) is bounded by env-configurable limits
(`AI_SEARCH_MAX_RESEARCH_ITERATIONS` and friends), all recorded into every
response's `research_metadata.limits`. LangSmith tracing was added
(`@traceable` on the tool/fetch functions, automatic on every graph node)
— fully optional, verified live against this deployment's own configured
LangSmith project. `backend/server.cjs`'s `adaptAgentProperty()` gained
additive fields only; the existing `/api/ai-search` response contract is
unchanged. `frontend/src/components/screens/ProjectSelection.jsx`'s AI
Search result card no longer renders a separate "Source: ..." badge (the
underlying source data is still carried on the object, just not shown as
its own field on that card).

---

## AI Search correctness pass (P0) — bridge reliability, deck semantics, category-page rejection, possession, config-scoped facts, LLM circuit breaking

A follow-up pass fixing specific correctness bugs a real smoke test
exposed in the deep-research pipeline above — this is a bug-fix pass, not
new features; no architecture change, LangGraph untouched. Every item
below was verified against the real, live pipeline (real Tavily/Google/
Gemini calls), not just unit-tested in isolation — see the session's own
"tests run" report for exact commands/output. **Not yet done as of this
pass: the AI-Search → Project Intelligence candidate handoff, Lead
Capture AI Activity/Status editing, and the LangSmith trace-metadata
expansion (candidate_id/field_being_verified/etc.) — those come next.**

**Bridge reliability (`agent/agent/tools.py`, `agent/agent/graph.py`,
`agent/agent/state.py`):** a new `AGENT_BRIDGE_TIMEOUT_MS`/
`AGENT_BRIDGE_CONNECT_TIMEOUT_MS` pair (separate from the whole-request
`AI_SEARCH_TIMEOUT_MS`) bounds a single bridge call with a short connect
timeout; bounded retry+exponential backoff (`AGENT_BRIDGE_MAX_RETRIES`/
`AGENT_BRIDGE_BACKOFF_BASE_MS`) only for connection failures, never for a
real HTTP response; a per-process circuit breaker
(`AGENT_BRIDGE_UNAVAILABLE_TTL_MS`) remembers a confirmed-down bridge so
every other concurrent/future tool call fails instantly instead of
repeating the same doomed retry. A new `bridge_preflight` graph node runs
once, first, before the 5-way search fan-out. Verified live: a dead-port
test went from what would have been minutes of timeouts to ~2.3s of clean
failure with a well-formed empty response.

**Deck/balcony/parking scope semantics (`agent/agent/fact_extraction.py`,
`agent/agent/dedupe.py`, `agent/agent/scoring.py`, `agent/agent/state.py`):**
replaced the old flat `deck_status`/`balcony_status`/`parking_status`
strings (set "confirmed" on ANY mention of the word, anywhere, any scope)
with a canonical `FeatureEvidence` list (`{feature, scope, configuration,
evidence_text, source, source_url, confidence}`) — every real mention is
recorded regardless of scope, but `scoring.py`'s `_score_amenities` now
reads **only** this structured list for deck/balcony/parking and never
substring-searches `description`/`amenities` text for them (the old path
let a project-level "eco deck on the 10th floor" satisfy a "2 BHK with
deck" query). A feature only satisfies a query when a `scope: "unit"`
entry exists, and (when the query named a configuration) that entry's own
`configuration` matches — a 3 BHK's deck no longer satisfies a 2 BHK
request. Verified with all 7 required cases (project-only, unit-only,
mixed, balcony-without-deck, unknown-scope, 2-BHK-specific, 3-BHK-when-
2-BHK-requested) plus a live full-pipeline run where a real project's
noisy "deck deck deck..." description no longer produced a false "deck
confirmed" match reason.

**Locality tiers (`agent/agent/scoring.py`'s `_score_location`):** a query
naming both a micro-locality and its parent (e.g. "Liberty Garden, Malad
West" — the gazetteer already records Malad West as Liberty Garden's
parent) no longer lets confirming ONLY the parent count as an "exact"
match for the micro-locality; a new `PARENT_LOCALITY_CREDIT` (60%) tier
sits between exact (100%) and nearby-sibling (35%), with the honest reason
"Located in Malad West; Liberty Garden not independently verified." —
verified live, previously-PRIMARY-93 candidates dropped to a correctly-
labeled SECONDARY 64-68 once this was in place.

**Category/search-results/collection-page rejection
(`agent/agent/normalize.py`):** `is_aggregator_title()` is now a thin
wrapper around a new `classify_page_type()` returning one of
`INDIVIDUAL_LISTING/INDIVIDUAL_PROJECT/CATEGORY_PAGE/SEARCH_RESULTS_PAGE/
COLLECTION_PAGE/DEVELOPER_DIRECTORY/SOCIAL_POST/UNKNOWN` — only the first
two may ever become a ranked candidate (the existing hard filter in
`graph.py`'s `node_candidate_scorer`/`node_final_scoring` was already
correct; the classifier feeding it wasn't). Added un-anchored pagination-
prefix ("Page 3 - ...") and "Projects in \<Place\>" signals specifically
because the old anchored-at-start regex missed a title that had a prefix
before the category-page language — the exact live bug ("Page 3 - RERA
registered Projects in Malad West" scoring PRIMARY 93). Verified against
all 7 rejection examples from the brief plus 2 real listing titles (both
correctly still pass through).

**Possession semantics (`agent/agent/fact_extraction.py`):** a bare 4-digit
year is no longer ever treated as a possession date on its own — every
possession extraction (month+year or bare year) now requires a
possession/handover/completion/occupancy word within ~55 characters, and
carries its matched `evidence_text` for provenance. Fixes the live bug
where an unrelated year (a RERA/founding-year mention) was reported as
`"possession": "2008"`. Cross-source possession conflicts were already
preserved via the existing `field_evidence` mechanism (unchanged, already
worked) — this pass fixed the extraction, not the conflict-preservation.

**Configuration-scoped facts (`agent/agent/fact_extraction.py`,
`agent/agent/dedupe.py`, `agent/agent/state.py`):** a new
`_extract_configuration_specific_facts()` scans "\<N\> BHK — area — price"
mentions and emits `ExtractedFact`s carrying `configuration`, routed by
`dedupe.py`'s `merge_extracted_facts()` into a new per-property
`configuration_evidence` dict (keyed by configuration string) instead of
the flat property-level price/carpet-area fields — a 1 BHK's price can no
longer silently become the 2 BHK's. The association heuristic
(`_nearest_configuration`) strongly prefers a BHK label appearing BEFORE
the value (matching how real "config - area - price" listings read) after
a live test showed the naive nearest-distance version misattributing
every value to the NEXT row's label instead of its own.

**LLM provider circuit breaking + call budget
(`agent/agent/llm_providers.py`, `agent/agent/graph.py`,
`agent/agent/curator.py`):** `LLMRouter` is instantiated fresh at every
call site (once per candidate, once for the curator), so a per-instance
failure memory did nothing to stop repeated identical failures against
the same broken provider/model — a live run produced 10 repeated Gemini
404s before this existed. Added a process-level circuit breaker
(`LLM_PROVIDER_CIRCUIT_TTL_MS`, default 5 min) keyed by provider, tripped
on model-not-found/quota-exhausted/billing/auth error text; a
circuit-broken provider is skipped with zero network call on every
subsequent attempt within the TTL. Verified live against two REAL
distinct failure modes hit during this build (a deprecated model 404, and
— after the deployment's own `.env` was updated to a valid model — a
genuine `RESOURCE_EXHAUSTED` prepayment-credits-depleted 429): 5 fresh
`LLMRouter` instantiations now produce exactly 1 network call instead of
5. Call-budget counters (`llm_calls`/`llm_failures`/`llm_fallbacks`,
reset once per top-level request in the new `bridge_preflight` node) are
recorded into every response's `research_metadata.metrics`.

---

  ## AI Search → Project Intelligence candidate handoff (P1)

  Root cause traced (not assumed): the handoff itself was never actually
  broken — `App.jsx` passes the selected candidate as a plain JS object via
  React state (`onAnalyse(projects) -> setSelectedProjects`), no
  serialization, no routing. The bug was behavioral: `ProjectIntelligence.jsx`
  only trusted a candidate's own evidence when `_agentIntel` was already
  set (true only for LangGraph-path results); everything from the older
  `external-search.cjs` connector path fell through to `runResearch()` —
  a **generic** `/api/ai-research` call keyed on bare `{name, builder,
  city}` that discarded every already-known field and could return a
  different project's data. `external-search.cjs` also never assigned an
  `id` at all (array-index + `Date.now()` was the only "identity"
  `toAnalysableProject` had to work with).

  **Fixed (`frontend/src/components/screens/ProjectSelection.jsx`):**
  `toAnalysableProject` now always resolves a canonical `id` (RERA →
  normalized name+location → source URL — same priority as the two backend
  paths below), carries the full candidate shape (`title`/`projectName`/
  `match_reasons`/`limitations`/`evidence`/`field_evidence`/
  `configuration_evidence`/`featureEvidence`/`deck`), and **always**
  populates `_agentIntel` — either the agent's own `project_intelligence`
  payload, or (new) `buildIntelFromCandidate()`, which synthesizes the same
  shape directly from this exact candidate's own already-known fields. The
  generic search fallback is never reached for an AI-Search-sourced
  candidate as a result.

  **Fixed (`frontend/src/components/screens/ProjectIntelligence.jsx`):**
  the per-project cache/lock key changed from `${name}::${builder}` (a real
  collision risk between two differently-sourced candidates sharing a
  name) to the candidate's own canonical `id`; `runResearch()` (the
  Claude-driven generic path) is now structurally unreachable whenever
  `current._autoResearch` is set, no matter what. Added a scope-verified
  unit-feature display (deck/balcony/parking, Part 3.5's semantics
  surfaced in the UI) and an explicit RERA-conflict badge.

  **Fixed (`backend/external-search.cjs`):** added
  `buildCanonicalCandidateId()` (same priority as `agent/dedupe.py`'s dedup
  key) so every legacy-path result also carries a real, stable `id`.

  **Fixed (`agent/agent/curator.py`):** `_deck_status` was reading a
  `deck_status` field the P0 pass had already removed (a real regression,
  caught and fixed here) — rewritten to read the canonical `features` list.
  The `configs[]` inventory-table builder previously applied ONE flat
  property-level price/carpet-area to EVERY configuration row (a live "1
  BHK price shown as 2 BHK price" bug) — now sources each row from
  `configuration_evidence` (Part P0.6), falling back to the flat value only
  when the property lists exactly one configuration (no ambiguity
  possible). Added RERA-conflict detection and passthrough of
  `field_evidence`/`configuration_evidence`/`features` on every property.

  **Not addressed in this pass (by design, per "smallest number of
  components" / no architecture rewrite):** the app has no router/URL
  persistence at all (`view` is a plain `useState` string) — a hard page
  refresh loses all in-memory state, including the selected candidate; this
  is a pre-existing, whole-app limitation, not something introduced or
  fixed here. On-demand "research more for this exact candidate" from
  within Project Intelligence (beyond what the original AI Search request's
  deep-research pass already gathered) was not built — gaps are shown
  honestly ("Not verified") rather than triggering new research.

  ---

  ## Wiring fix — browser AI Search was silently falling back to the pre-P0 pipeline

  Not a code bug in the P0/P1 pass itself — an **operational** gap the live
  browser exposed: `_smoke_test.py` calls the compiled LangGraph directly;
  the browser goes through `server.cjs`'s `/api/ai-search` →
  `AGENT_SERVICE_URL` (`http://localhost:8008`). Two real, separate causes
  compounded:

  1. **The Python agent process wasn't running** — nothing listening on
    :8008 — so `LANGGRAPH_ENABLED=true` silently fell through to the
    legacy `external-search.cjs` connector path (this fallback itself is
    correct, intentional behavior — "a broken agent must never make AI
    Search worse than it already was" — but it meant the browser was never
    exercising the P0-fixed pipeline at all).
  2. **`AI_SEARCH_TIMEOUT_MS` in the real `.env` was still `45000`** (the
    pre-deep-research default) — even with the agent running, a real P0
    query genuinely takes 50-110s, so the Node server aborted the request
    and fell back anyway. Bumped to `120000` (a plain timeout integer, not
    a secret — matches the value `.env.example` already documented as the
    fix for this exact tradeoff).

  Confirmed live: `backend/scoring.cjs`'s `isAggregatorTitle()` (the
  LEGACY Node-side classifier, independent of `agent/agent/normalize.py`)
  has the exact same anchored-regex gap P0 fixed on the Python side — it
  does **not** catch a "Page N - ..." prefix either. This is why "Page 7 -
  2 BHK Flats in Malad West, Mumbai" scored PRIMARY 97 in the browser while
  the smoke test (which only ever exercises the Python pipeline) never
  showed it. **Deliberately left unpatched** per explicit instruction not
  to touch classifier/scoring logic in this fix — the correct fix was
  routing the browser to the already-fixed pipeline, not duplicating the
  fix into the fallback path too. Restarting the stale Node process (it
  predated several recent commits, including the `external-search.cjs`
  candidate-id fix) resolved a compounding `id: undefined` symptom in the
  same investigation.
  (The `isAggregatorTitle()`/`classify_page_type()` pagination-prefix gap
  noted above was later actually fixed — see "AI Property Search — hard
  lifecycle/eligibility filter" below, a subsequent task whose scope
  explicitly covered it.)

  ## AI Property Search — hard lifecycle/eligibility filter + Project
  ## Intelligence fixes (deterministic-filtering pass)

  Full trace of the existing search architecture (both pipelines) found the
  real gap the earlier passes hadn't touched: `is_aggregator`/
  `isAggregatorTitle()` (P0) only ever asked "is this an individual listing
  page at all, or a portal category/search-results page" — it never asked
  "is this individual listing a **resale/rental** transaction, or genuinely
  new-project inventory." A resale flat's own listing page is shaped
  exactly like a real project's (a title, a price, a BHK count, a
  description) and sailed straight through untouched. Confirmed live: the
  curator's own LLM-relabeling prompt used a **rental** listing
  ("Bedroom Apartment for rent in JB Nagar... for 25000 - Makaan.com") as
  its illustrative "generic title that just needs a nicer display name"
  example — proof the system expected rentals to reach the curator, not be
  rejected.

  **New deterministic lifecycle classifier** (regex-only, no LLM, mirrored
  in both pipelines so they agree):
  - `agent/agent/normalize.py`: `classify_lifecycle_status()` →
    `UNDER_CONSTRUCTION | NEAR_POSSESSION | NEW_LAUNCH | READY_TO_MOVE |
    RESALE | RENTAL | UNKNOWN`, stored as `NormalizedProperty.lifecycle_status`
    + `.lifecycle_evidence_text` (the real matched snippet, never fabricated).
    Also fixed, in the same file: `PORTAL_SEO_SUFFIX_RE` catches a live-
    reproduced gap ("Buy 1 BHK in Borivali | New Projects & Properties in
    Borivali" — the anchored category regex never saw past the "Buy 1 BHK
    in Borivali" prefix before the pipe).
  - `backend/scoring.cjs`: `classifyLifecycleStatus()` — same regex
    families, same enum, exported alongside the existing `isAggregatorTitle`
    (same `PORTAL_SEO_SUFFIX_RE` fix mirrored here too).
  - **Hard filter, not a score cap**: `agent/agent/graph.py`'s
    `_apply_hard_eligibility_filter()` and `backend/external-search.cjs`'s
    `.filter()` chain reject RESALE/RENTAL/an aggregator page immediately;
    UNKNOWN/READY_TO_MOVE are only rejected on the **final** pass
    (`node_final_scoring`, `final=True`) — the **first** pass
    (`node_candidate_scorer`) defers them so `deep_research` gets a genuine
    chance to fetch the real page and resolve them via
    `reclassify_lifecycle_from_enriched_evidence()` before the final call is
    made. (Live-verified: a candidate first classified UNKNOWN from a thin
    search snippet was correctly resolved to `NEW_LAUNCH`/`UNDER_CONSTRUCTION`
    after deep research fetched its real page — see below.)
  - **Deterministic ranking**: `score_all()` (Python) and
    `mergeDuplicateProperties()`/final sort (Node) now tie-break on the
    candidate's own stable `id` when `match_score` ties, so the same query +
    same candidate dataset always produces the same order (previously tied
    on whatever order the LangGraph parallel fan-out / `Promise.allSettled`
    connectors happened to resolve in, which can vary run-to-run).
    `external-search.cjs`'s `buildCanonicalCandidateId()`'s last-resort
    fallback no longer uses `Math.random()` — a deterministic hash of
    whatever fields exist instead.
  - **Adapter gap fixed**: `server.cjs`'s `adaptAgentProperty()` (reshapes
    the agent's response for the frontend) wasn't copying `lifecycleStatus`/
    `lifecycleEvidence` through at all — fixed.
  - **Dev-only debug trace** (never shipped to production by default):
    `AI_SEARCH_DEBUG_TRACE=true` on either backend process attaches a
    `debug_trace` block (query → normalized requirements → every rejected
    candidate + reason → qualified count → final order) to the API
    response — reuses the existing `?debug=1` frontend convention
    (`frontend/src/components/ui/debug.js`) as the intended display gate,
    and is additionally gated server-side so it's never computed/sent at
    all unless that env var is explicitly set.

  **Project Intelligence fixes**:
  - `backend/server.cjs`'s `/api/competing-projects` — radius is now a
    configurable `radiusKm` query param (still defaults to 3km, clamped
    0.5–15km); results are now post-filtered against a `NON_RESIDENTIAL_PLACE_TYPES`
    set (school/hospital/restaurant/shop/office/bank/... — Google Places'
    own `types` field, not a guess) so a shop or office that happens to
    match the "residential apartment project" text bias no longer appears
    as a "competitor."
  - `frontend/…/ProjectIntelligence.jsx`'s Competitor Analysis card — fixed
    a real bug where a genuine search **failure** (Places API error/down)
    and a genuine **zero-results** search were both rendered as "No
    competing residential projects found." The fetch effect was silently
    dropping the backend's `error` field; now surfaced as a distinct
    "Competitor data unavailable" state.
  - Nearby Infrastructure item names — fixed the truncation the user's
    screenshots showed ("Government Genera...", "Dr. Reena Mokal Nur...").
    The 2-up grid tile (added earlier this same session) forced a
    single-line ellipsis at roughly half the card's width; now a
    single-column, full-width row per item with a proper 2-line clamp
    (`-webkit-line-clamp`) and the `title` tooltip retained for the rare
    still-too-long name.
  - `ProjectSelection.jsx`'s `RankedResults` — a genuinely empty (but
    correctly filtered) result set used to render nothing at all (`return
    null`), silently swallowing curator.py's own "No verified properties
    matched..." explanation. Now shows an explicit "No eligible new
    residential projects found" state with the real reason and a
    suggestion to try a nearby locality/different configuration/wider
    budget — never silently blank, never padded with ineligible results to
    hit a count.
  - A rental-intent query (e.g. "1BHK rental in Borivali") now gets an
    explicit "this search is for new residential projects, not rentals"
    summary instead of an unexplained empty result — added to both
    `curator.py`'s `_deterministic_summary()` and `external-search.cjs`'s
    message-building, gated on the query text containing rental keywords.

  **Tests added** (plain-assert scripts, no new framework dependency — none
  was installed in this repo before): `agent/tests/test_lifecycle_and_eligibility.py`
  (30 checks) and `backend/tests/test_lifecycle_and_eligibility.cjs` (17
  checks), both run directly against the real modules (no mocks), covering
  resale/rental/unknown rejection, eligible-stage acceptance, the two-pass
  defer-then-reclassify behavior, deterministic tie-break ordering,
  exact-locality/configuration scoring, and dedup merging.

  **Known remaining limitations** (see the final report given directly to
  the user for full detail): dedup only merges candidates whose normalized
  name+location strings match exactly (or share a RERA/URL) — two sources
  describing the same real project under genuinely different title text can
  still appear as separate candidates, one correctly classified and one
  not (observed live: two different "Arkade Malad West" listings, one
  correctly `UNDER_CONSTRUCTION`, one deep-research-classified `RENTAL` from
  a different source URL). Competitor Analysis and the Google Geocoding
  fallback both depend on `GOOGLE_PLACES_API_KEY`/Places API (New) + the
  Geocoding API being enabled on the owning Google Cloud project — an
  external configuration state this pass cannot fix from application code.

  ### Independent verification + follow-up fixes (same pass, after review)

  The above was independently re-verified (both test suites re-run directly,
  both backends restarted and re-checked live, `npm run build` re-confirmed)
  rather than taken on trust, which surfaced four additional real bugs — all
  fixed, tested, and live-verified in this same pass:

  - **`RENTAL_RE` false-positive on land tenure**: bare `\blease\b` matched
    "99-year **lease deed** from MHADA" — a completely standard Indian
    real-estate land-tenure phrase in genuine new-launch listings, not a
    rental signal. Fixed with a negative lookahead (`\blease\b(?!\s*deed)`)
    in both `agent/agent/normalize.py`'s `RENTAL_RE` and
    `backend/scoring.cjs`'s `RENTAL_RE`. Regression tests added to both
    suites.
  - **Dedup didn't strip portal page-furniture from the name before keying**:
    live-verified on the "2BHK with deck in Liberty Garden near Malad West"
    query — "Arkade Eden Malad West: Price, Photos & Floor Plans", "Arkade
    Eden FAQs - Malad West, Mumbai", and "Arkade Eden Malad West - Brochure,
    Pros&Cons, PriceSheet" all appeared as separate, undeduplicated
    candidates. Added `_core_name_key()` (Python, `agent/agent/dedupe.py`) /
    `coreNameKey()` (Node, `backend/external-search.cjs`) / the same in
    `ProjectSelection.jsx`'s own copy — a fixed word-list strip (price,
    photos, floor plans, FAQs, brochure, pros & cons, price sheet, reviews,
    overview, gallery, amenities, video tour, map) applied before the
    name+location identity key is built. Deliberately a fixed list, not a
    fuzzy/similarity match, so it can't accidentally merge two genuinely
    different projects. Regression tests added to both suites. **Still not a
    complete fix** — the "FAQs" variant above embeds "Mumbai" directly in the
    name text differently than the other two, so 2 of 3 now merge, not 3 of
    3; a full fix would need to strip resolved locality/city tokens too,
    which was deliberately not attempted here (real false-merge risk,
    correctness takes priority over completeness per the task's own
    governing rule).
  - **Node's identity-key builder leaked stray colons from the original
    title text**: `buildCanonicalCandidateId()` in both
    `backend/external-search.cjs` and `ProjectSelection.jsx` built
    `` `${name}::${location}` `` first and ran one shared sanitizer that
    special-cased `:` to survive — so a colon anywhere in the ORIGINAL name
    (e.g. "Malad West:" vs another source's "Malad West -") leaked into the
    key and could by itself block a dedup match the noise-stripping fix
    above was supposed to enable. Fixed by sanitizing each field to bare
    `[a-z0-9]` independently before joining with the intentional `::`
    separator — matching `agent/dedupe.py`'s `_key()` behavior exactly.
    Regression test added to the Node suite.
  - **`ProjectSelection.jsx`'s own fallback copy of `buildCanonicalCandidateId`
    still used `Math.random()`** for its last-resort anonymous id (a
    candidate with no RERA/name/location/URL at all) — a direct violation of
    this task's own "never `Math.random()` in the result path" rule, missed
    by the earlier pass since it only touched the Python/Node copies. Fixed
    with a small deterministic string hash (DJB2-family, browser-safe, no
    new dependency) so the same degenerate input always produces the same id.

  ## Exact-property correctness pass — name extraction, geography gate, entity
  ## resolution, activity/journey UI, retrieval metrics

  Follow-up pass on top of the deterministic-filtering work above, after the
  user supplied real screenshots and a much more detailed spec. Investigated
  directly (no delegated/background agent this time, after the previous pass's
  agent exceeded its read-only instructions — see that section's own
  disclosure). Every fix below was independently syntax-checked, unit-tested,
  and — for the search-pipeline changes — verified against at least one real,
  live `/api/ai-search` call against the actual running services, not just
  code review.

  **1. Exact project name extraction (`agent/agent/fact_extraction.py`,
  `agent/agent/dedupe.py`, `agent/agent/graph.py`)** — the gap: a candidate
  could survive `is_aggregator_title` (a real individual listing page, not a
  category page) yet still DISPLAY as its noisy raw search-snippet title
  ("Arkade Malad West - Premium Residential Apartments in Malad West, Mumbai")
  instead of the actual project name. `property_name` existed as a
  `NormalizedProperty` field but nothing ever populated it. New
  `extract_project_name()`: tries the fetched page's own JSON-LD structured
  data (`schema.org` `Product`/`Residence`/... `name` — the page's own
  machine-readable claim, highest confidence) first, then falls back to the
  real fetched-page `<title>` tag (not the search snippet) cleaned of the same
  portal-furniture words dedup's `_core_name_key` strips — returns `None`
  (never a guess) if the cleaned result still reads as a category-page title.
  `dedupe.merge_extracted_facts()` upgrades `name` only when the CURRENT name
  looks generic (never downgrades an already-good one); `graph.py`'s
  `_apply_hard_eligibility_filter` now rejects, on the FINAL pass only (after
  deep research has had its chance), any candidate whose name still reads as a
  category page — "No identifiable project name could be established, even
  after deep research." No Node-side equivalent — the Node fallback pipeline
  has no page-fetch/enrichment capability at all (architectural, not a
  shortcut; documented, not silently skipped).

  **2. Geography/locality relevance hard-filter — the biggest live-caught bug
  this pass (`agent/agent/graph.py`, `backend/external-search.cjs`)** —
  location was previously only ever a SCORING dimension (a soft cap), never a
  hard gate. Confirmed live: searching "2BHK with deck in Liberty Garden near
  Malad West" (Mumbai) returned, as the FINAL results, "Liberty at Mayfield
  Homes for Sale | Las Vegas, NV Real Estate" and "Liberty at Meriden... A New
  Home Community by KB Home" — two U.S. listings that matched on nothing but
  the single coincidental word "Liberty". New `_location_terms()` /
  `_matches_searched_location()` (Python) and the equivalent inline filter
  (Node, using `query-parser.cjs`'s `extractLocations`): a candidate's own
  name+location+description text must contain, as a WHOLE PHRASE (never a
  single split word — "Liberty" alone does not satisfy "Liberty Garden"), the
  query's own location term(s) or resolved city, or it's rejected outright.
  Skipped entirely when the query has no resolvable location (nothing to check
  against). Same "defer to the final pass" discipline as the lifecycle gate.
  Live re-verified after the fix: the same query now correctly returns ZERO
  results with an honest breakdown, instead of two wrong-country listings.

  **3. Fuzzy entity resolution requiring multiple signals (`agent/agent/dedupe.py`,
  `backend/external-search.cjs`)** — the exact-key dedupe tier (RERA / URL /
  normalized name+location) still couldn't merge "Arkade Malad West" and
  "Arkade Liberty Garden Malad" as the same project. New fuzzy tier, only
  tried when the exact tiers all miss: requires distinctive name-token overlap
  (≥50%, after stripping both portal furniture AND a fixed list of generic
  project words — "Heights"/"Residency"/"Garden"/a compass direction/etc.)
  **AND** at least one of {same developer, same/contained locality string} —
  name similarity alone is never sufficient, exactly per the spec's explicit
  rule (verified: two different projects sharing only "Heights" and the same
  locality do NOT merge). No lat/lon proximity signal is available at this
  pipeline stage (candidates aren't geocoded until Project Intelligence) — a
  real, disclosed limitation, not faked with invented coordinates. Also fixed
  a separate pre-existing bug found along the way: `external-search.cjs`'s
  actual merge function (`mergeDuplicateProperties`) used a DIFFERENT, weaker
  key (name-only, no portal-noise stripping, no locality component at all —
  meaning two different real projects sharing an identical name in different
  cities could have silently merged) than `buildCanonicalCandidateId` — now
  unified.

  **4. `retrieval_metrics` + honest empty-result explanations (`agent/agent/curator.py`,
  `backend/external-search.cjs`)** — new structured counts
  (`total_candidates`, `individual_project_candidates`, `aggregator_pages`,
  `resale_candidates`, `rental_candidates`, `unknown_candidates`,
  `eligible_candidates`, `rejected_candidates`), computed from each
  candidate's own real `is_aggregator`/`lifecycle_status` fields (never
  inferred from a rejection-reason STRING, which would silently break if that
  wording changed). Full breakdown stays inside the existing dev-only
  `debug_trace` (`AI_SEARCH_DEBUG_TRACE=true`, server-side only, never
  client-controllable). A new, ALWAYS-shown (not debug-gated) plain-language
  summary sentence is now built from the same counts whenever a search
  returns zero results — e.g. "32 candidates were reviewed. 19 were portal
  category/search-results pages, not individual projects, 2 were
  resale/rental listings, and 8 had a lifecycle stage that couldn't be
  confidently verified" (this exact sentence is real output from a live run
  during this pass) — replacing a flat "no results" with a genuine answer to
  "why."

  **5. `RENTAL_RE` false-positive on land tenure (`agent/agent/normalize.py`,
  `backend/scoring.cjs`)** — bare `\blease\b` matched "99-year **lease deed**
  from MHADA" — a standard Indian land-tenure phrase in genuine new-launch
  listings, not a rental signal. Fixed with a negative lookahead
  (`\blease\b(?!\s*deed)`) in both pipelines.

  **6. India/Dubai market toggle — reverse case (`frontend/.../ProjectSelection.jsx`)**
  — the existing auto-switch (added in an earlier pass) only ever corrected
  India → Dubai when a query clearly named a Dubai/UAE location. No
  corresponding Dubai → India correction existed, so a user already on the
  Dubai/UAE tab (a prior search, or `sessionMemory` restoring a stale market
  value on remount) typing a plainly-Indian query ("1bhk in borivali west")
  stayed on Dubai and ran the search against Dubai/AED sources. New symmetric
  check: `INDIA_TERMS` (bhk/₹/INR/major India metro+Mumbai-locality names —
  "bhk" alone is a near-unambiguous signal, since Dubai/UAE listings say
  "bedroom"/"BR"/"studio", never "BHK") triggers a switch back to India,
  unless the query ALSO contains an explicit Dubai term (which still wins, as
  the more specific signal).

  **7. Lead Activity page structure (`frontend/.../LeadCapture.jsx`)** — "Lead
  Journey" (the WATI/voice checkpoint timeline — template sent → delivered →
  replied → requirements/options/property-details shared → advisor → CRM tag)
  and "Activity" (the edit-history/audit feed) were sandwiched between
  Requirements and Conversations. Both moved to the very end of the page,
  after Conversations, per the required page structure (header → info →
  requirements → conversations → WhatsApp/voice → activity → END). "AI
  Activity" (the WhatsApp bot/voice-agent mascot summary) stayed in its
  existing position — it maps to the spec's separate "WhatsApp/Voice" section,
  not "Activity".

  **8. Journey timeline visual weight (`frontend/.../LeadCapture.jsx`'s
  `JourneyStep`)** — previously a flat list of same-sized dots with only
  color+font-weight distinguishing reached from future steps (read as
  uniformly faint). Now: a filled dot with a checkmark + solid colored
  connector line for anything reached, a hollow outline dot + light dashed
  connector for anything still ahead — same visual language as a shipping
  tracker, applied only to real backend-reported checkpoints (a step is never
  marked complete unless `step.reached` is actually true from
  `GET /api/leads/:id/journey`).

  **9. "Property details shared" info-icon payload — already fully wired**
  (verified, not just assumed): `lead-journey.cjs`'s `detail_shared` checkpoint
  already had `info: true`, and `lead-events.cjs`'s `/journey` endpoint already
  generically attaches `match.payload` (the real stored event payload) to
  ANY step with `info: true` and a reached match — no backend change needed.
  Only change: the empty-payload text now reads exactly "Payload not
  available" (previously "No additional details recorded for this event."),
  matching the spec's exact required wording.

  **10. Result card source/verification (`frontend/.../ProjectSelection.jsx`'s
  `PropertyCard`)** — an earlier pass had deliberately removed the source
  badge from the compact search-result card ("per-request cleanup"). The
  current spec explicitly re-requests it ("Source: [Verified source]"); added
  back as a small, real `p.sourceName` label (linked to `p.sourceUrl` when
  present) — never fabricated, never a "Verified" claim beyond what's
  actually true (this is provenance, not a correctness guarantee).

  **11. "AI Search → Project Intelligence → WhatsApp share → Lead Activity"
  canonical-ID handoff — investigated, found NOT to exist as an in-app flow**
  (honest finding, not a shortfall): there is no button/action anywhere in
  ProjectIntelligence.jsx or LeadCapture.jsx that lets a user pick an AI
  Search candidate and push it toward a specific lead's WhatsApp conversation.
  `detail_shared` ("Property details shared") is populated exclusively by an
  EXTERNAL system (`Indihomes-chatbot-V1`/Phase 2, via the generic
  `POST /api/lead-events` ingest — see `LEAD_EVENTS_INTEGRATION.md`), entirely
  decoupled from this app's own AI Search/Project Intelligence screens. What
  IS true and verified: whatever payload that external system sends is stored
  and displayed completely faithfully (`payload: body.payload || null` in
  `lead-events.cjs`, never reduced/truncated on the receiving side). Building
  an actual in-app "share this exact candidate to a lead" feature would be a
  substantial new feature (a new UI trigger, a new backend endpoint, and an
  integration hook into a WhatsApp-send capability that doesn't exist in this
  repo at all) — deliberately NOT attempted here, since it's a large net-new
  feature rather than a fix to something broken, and conflicts with "prefer
  the smallest correct change" / "preserve existing functionality."

  **Tests**: `agent/tests/test_lifecycle_and_eligibility.py` grew from 30 to
  53 checks; `backend/tests/test_lifecycle_and_eligibility.cjs` from 17 to 22.
  New coverage: the leasehold false-positive, the 3-way portal-noise dedup
  case (both pipelines), the fuzzy multi-signal merge (both pipelines, plus
  the two false-merge-risk cases it must NOT trigger on), exact project name
  extraction (JSON-LD, cleaned-title, still-generic-rejected), the
  name-upgrade-never-downgrade rule, the final-pass no-identifiable-name
  rejection, the geography/locality gate (the real Las Vegas case, both
  pipelines, plus the "skip when no resolvable location" and
  "not-yet-enforced-on-first-pass" cases), and `retrieval_metrics` +
  the empty-result explanation sentence. Both suites re-run clean after every
  change in this pass, not just at the end.

  **Live verification**: 3 real `/api/ai-search` calls against the actual
  running backend + Python agent (not the Node fallback — the agent was
  reachable throughout), restarting both processes after each code change
  that needed to be re-verified. Full results in the final report given
  directly to the user for this pass.

  ## Critical follow-up — the pipeline was verifying correctly but not
  ## VERIFYING ENOUGH before rejecting

  Immediately after the pass above, live browser testing surfaced a real
  regression: "1BHK in Charkop Kandivali west" returned zero results ("20
  candidates reviewed... 8 had a lifecycle stage that couldn't be confidently
  verified"). Investigated live (debug trace on) rather than guessed at.

  **Root cause #1 — the deep-research budget wasn't prioritized toward the
  candidates that actually needed it.** `node_deep_research` always spent its
  fixed budget (`MAX_CANDIDATES_FOR_DEEP_RESEARCH`, was 3) on
  `ranked_properties[:budget]` in pure match_score order — a candidate with an
  UNDETERMINED (UNKNOWN/READY_TO_MOVE) lifecycle competed for the same fixed
  slots as one already confidently eligible, with no regard for which kind of
  candidate actually needed the spend to determine eligibility at all. New
  `_prioritize_for_deep_research()` (`agent/agent/graph.py`) puts undetermined
  candidates first (stable sort — score order preserved within each group);
  cap raised 3 → 5 (still small, deterministic, env-configurable).

  **Root cause #2 (the real smoking gun) — lifecycle reclassification never
  looked at the actual fetched page.** `reclassify_lifecycle_from_enriched_
  evidence()` only ever reconstructed its evidence text from a narrow set of
  ALREADY-STRUCTURED fields (possession-related `field_evidence`,
  configuration possession buckets, deck/balcony/parking feature snippets) —
  it never once looked at the real fetched page's own title/content, even
  though `deep_research.py` has that text right there. Proven directly: fetched
  `https://arkademaladwest.in/Liberty-Garden` by hand — real page, real 10KB of
  text, explicitly says *"New Launch at Liberty Garden, Malad West"* / *"Exclusive
  Pre-Launch Privileges for Early Registrations"* — and the pipeline still
  returned this exact candidate as UNKNOWN with zero evidence. Fixed:
  `fact_extraction.deterministic_extract()` now ALSO classifies lifecycle
  directly against the real fetched page's own title+content (never the search
  snippet) and emits it as a `lifecycle_status_from_page` fact;
  `dedupe.merge_extracted_facts()` applies it — same "only upgrade an
  undetermined status, never override an already-confident one" rule used
  throughout this codebase.

  **Root cause #3 (found while validating #2) — a real new false-positive.**
  Scanning more raw page text (per fix #2) exposed a `RESALE_RE` bug that a
  short search snippet never had: `\bby\s+owner\b` (with `\s+` spanning
  newlines) matched a portal's "Posted By [newline] Owner Builder Dealer
  [newline] clear" FILTER-WIDGET chrome — a facet list, not a claim about the
  specific listing. Fixed in both pipelines: `[ \t]+` (no newline) still
  catches a genuine same-line mention ("for sale by owner") while refusing to
  match across separate UI elements.

  **Retrieval breadth (Part 9)**: every discovery search previously used the
  user's raw query text verbatim, once, for every tool — which reads like a
  generic buyer query and correspondingly surfaces mostly portal browse pages.
  New `lifecycle_variant_search` graph node (gated on the query having a
  resolvable location, same as `portal_search`): a SECOND `tavily_search` call
  with the query rewritten to include lifecycle language ("... under
  construction OR new launch OR near possession") — through the existing tool,
  never a hardcoded project name. Confirmed firing in a live tool-call trace.

  **Live re-verification, same query, after all three fixes**:
  "1BHK in Charkop Kandivali west" went from 0 results (the regression) → 5
  results, including a genuinely NEW distinct project not seen in earlier runs
  ("CHARKOP 1 KAVERI CHSL", UNDER_CONSTRUCTION, real evidence: "Status | Under
  Construction"). "2BHK with deck in Liberty Garden near Malad West" now
  correctly surfaces "Arkade Malad West | ... Arkade Liberty Garden" itself —
  PRIMARY, NEW_LAUNCH, real evidence, real developer-site source URL — the
  exact project this whole investigation started from, previously lost to a
  verification gap, not an over-strict eligibility rule.

  **Known remaining limitation** (disclosed, not fixed this pass): the same
  project (e.g. "Dem Icon") still appears as 2-4 separate cards when different
  portals' pages for it have wildly different location-field text (one page's
  extracted "location" was literally "Dem Icon Rera, Details, Legal Documents,
  Construction Status" — a garbled extraction, not a real place name) that
  defeats both the exact-key and fuzzy-tier dedup. A real, narrower bug for
  future work — not chased further this pass given the core verification-gap
  fix was the priority.

  **Tests**: Python suite 53 → 72 checks; Node suite 22 → 26. New coverage:
  deep-research prioritization (undetermined-first, stable within group),
  lifecycle classification from real fetched page content (using the actual
  Arkade page text verbatim, not paraphrased), the "Posted By" filter-widget
  false-positive regression (both pipelines).

  ## "2BHK in Borivali East" — a new category-page shape, a configuration-
  ## mismatch scoring gap, and a broken in-flight edit found along the way

  Live evidence: "2BHK in Borivali East" returned "New Launch Projects in
  Borivali East, Mumbai" (PRIMARY, 58%) and "Under Construction Projects in
  Borivali East, Mumbai" (SECONDARY, 58%) — both 99acres.com category pages,
  both explicitly 3 BHK (own match reasons said "3 BHK does not match your 2
  BHK request"). Investigated directly against the real current code, not
  memory — this surfaced three distinct, real issues, only two of which were
  the ones originally suspected.

  **Bug 1 — root cause traced, NOT a new gap in `agent/agent/normalize.py`.**
  `classify_page_type()`'s `PROJECTS_IN_PLACE_RE` (`\bprojects?\s+in\s+[A-Z]`,
  added for the "Page 3 - RERA registered Projects in Malad West" fix earlier
  in this doc) is unanchored and generic — confirmed live, both exact titles
  above (and the whole family: "Ready to Move/Upcoming/Ongoing Projects in
  X") already classify `CATEGORY_PAGE` on the Python side with zero code
  change needed. The real gap was in `backend/scoring.cjs`'s
  `isAggregatorTitle()`, which never received this fix — its own "Projects
  in X" pattern was still anchored at the START of the title (`^\s*...new
  projects?\b`), so a lifecycle-status phrase prefix ("New Launch"/"Under
  Construction") defeated it, the exact same class of gap "Page 3 -" once
  exploited on the Python side before `PROJECTS_IN_PLACE_RE` existed there.
  Fixed: added the same unanchored `PROJECTS_IN_PLACE_RE` to
  `backend/scoring.cjs`. Live-verified against the real running Node fallback
  pipeline (agent temporarily stopped to force it): "Under Construction
  Projects in Borivali East, Mumbai" now appears in `debug_trace`'s
  `candidates_rejected`, reason "Reads like a portal category/search-results
  page..." — correctly excluded, honest zero-result summary instead.

  **Bug 2 — configuration mismatch: option (b) chosen (score/tier cap, not a
  hard exclusion).** `backend/scoring.cjs`'s `scoreExternalProject` already
  had a precedent for exactly this situation, right next to the config
  scoring: a location mismatch caps `confidence` at 55 (`Math.min(confidence,
  55)`, comment: "TERTIARY fallback at best, never a strong match"). Applied
  the identical pattern to configuration — a query-specified BHK count that
  didn't score (unknown OR explicitly wrong, same "any non-match caps it"
  rule the location cap already uses) also caps at 55. Chose the cap over a
  hard exclusion (option a) because: (1) it's the more directly-precedented
  pattern in this exact function, not an invented new rule; (2) the project
  is still real and in the right place — hiding it entirely would violate
  this codebase's own "never silently blank, never padded... explain
  honestly" philosophy already established for TERTIARY results; the
  complaint was specifically about the TIER/PRESENTATION ("presented as a
  strong match"), which a cap resolves precisely without discarding
  information a salesperson might still find useful (e.g. "this developer
  has other projects nearby").

  **The actual proximate cause was one level deeper than either bug
  description assumed.** `ProjectSelection.jsx`'s `PropertyCard`:
  `const tierLabel = p.match_tier || rankOf(i).label` — the Node fallback
  path had NEVER set `match_tier` on its results at all (confirmed:
  `frontend/.../ProjectSelection.jsx`'s own comment already called this out
  — "the legacy (pre-agent) external-search path, which never set
  match_tier"), so the frontend fell back to pure ARRAY-POSITION labeling —
  first result always "PRIMARY", second always "SECONDARY", entirely
  independent of score. This is why two results sharing the identical 58%
  score got two different tier badges. Fixed at the root: `scoreExternalProject`
  now also returns a real `tier` (`confidence >= 80 ? 'PRIMARY' : >= 60 ?
  'SECONDARY' : 'TERTIARY'`, mirroring `agent/agent/scoring.py`'s
  `score_property` exactly, same thresholds, same uppercase labels), wired
  through as `match_tier` on every Node-fallback property in
  `external-search.cjs`. This is a general fix, not scoped to configuration
  mismatches only — the positional-labeling bug is now structurally
  unreachable for this pipeline's results, for any future query.

  **A separate, real, broken in-flight edit was found and fixed while
  investigating** (not part of either bug above — discovered because the
  Python test suite failed to even import): `agent/agent/graph.py`'s
  `_apply_hard_eligibility_filter`'s "Part 1 — geography-relevance gate"
  block (lines ~371-411) was sitting at the wrong indentation (column 0
  instead of the enclosing `for p in scored:` loop's 8-space body level) —
  a `SyntaxError: unexpected indent` that would have crashed the agent
  process on any restart. Once re-indented, a second bug surfaced: the block
  referenced `state.get("micro_locations")` but the function signature never
  received a `state` parameter at all (`NameError` at runtime, only
  exercised when a candidate carries a structured `city` field that
  disagrees with the query's resolved city — no existing test reached this
  branch). Fixed: added `state: ResearchState | None = None` to
  `_apply_hard_eligibility_filter`'s signature, passed `state=state` from
  both call sites. While fixing this, also completed the block's own
  documented intent — its comment says the geography gate is "Applied on
  both passes," but `node_candidate_scorer` (the first-pass caller) never
  actually passed `location_terms` at all, so the two-pass defer-then-
  enforce behavior it describes was dead code on the first pass; now wired
  identically to the final-pass call site (`node_final_scoring`), so a
  CONFIRMED wrong-city candidate is rejected before wasting deep-research
  budget on it — the same efficiency argument already used for the
  lifecycle-status two-pass gate immediately above it in the same function.

  **Competitor-analysis click-through — confirmed working, nothing to fix.**
  Traced the full handoff: `toAnalysableProject` → `current.name`/`location`/
  `city` (populated for AI-Search candidates from both pipelines) → Location
  Map's `mapQuery` (generic string join, no dependency on `official`/
  IndiHomes-catalog-only fields) → `NearbyMap` geocodes it → `onGeo`
  populates `projectGeo.lat/lon` → a `useEffect` fires `/api/competing-
  projects?lat=...&lon=...`. No special-casing anywhere that would exclude
  an AI-Search-sourced candidate. Directly probed the live endpoint for
  Borivali East's real coordinates: 8 real named nearby properties returned
  with distances and Maps links. Also notable: the `GOOGLE_PLACES_API_KEY`
  "403 API_KEY_SERVICE_BLOCKED" issue disclosed as a known limitation
  earlier in this doc appears to be resolved as of this pass — the same key
  now returns real data live.

  **Tests**: Python suite 99 → 104 checks (new: the lifecycle-phrase-
  prefixed "Projects in" family already correctly rejected, both exact
  live-evidence strings; the `state`-dependent confirmed-wrong-city branch,
  previously untested and the exact branch that had the `NameError`). Node
  suite 39 → 47 checks (new: both exact live-evidence titles now rejected by
  `isAggregatorTitle`, the whole lifecycle-phrase family; the configuration-
  mismatch cap and its real-tier computation, both exact live-evidence items
  plus a non-category-page control proving the fix is independent of Bug 1).
  Both suites re-run clean after every change, not just at the end.

  ## Places-augmented pipeline — a new discovery source + per-candidate
  ## entity verification, and the real "Security Alert" root cause

  Live evidence: "2bhk in borivali east" returned "Security Alert" as a
  PRIMARY 100%-match result — a garbage extraction, not a real project.
  Separately, Competitor Analysis (the existing `/api/competing-projects`
  endpoint) independently proved Google Places has real, well-named,
  correctly-addressed residential-building signal this pipeline wasn't
  using at the DISCOVERY stage at all.

  **Part 1 — new discovery connector.** `agent/agent/tools.py`'s
  `places_search()` (mirrored as `placesConnector` in
  `backend/external-connectors.cjs`, both built on a newly-extracted shared
  `backend/places-client.cjs` — the SAME endpoint/auth/residential-type-
  filter `/api/competing-projects` already used successfully, deduplicated
  rather than copied a third time) calls Google Places Text Search
  ("residential apartment [configuration] near [locality]", no
  locationBias — discovery has no already-known coordinates to search
  around yet, unlike `/api/competing-projects`). Wired into the SAME
  discovery fan-out as every other tool (`agent/agent/graph.py`'s
  `node_places_search`, `agent/agent/planner.py` gates it on
  has-a-resolvable-location + India market, same reasoning as
  `portal_search`/`lifecycle_variant_search`). Real scope, disclosed in
  code comments and every empty result: strongest for ready-to-move/
  completed buildings a developer has already registered with Google
  Business/Maps; a genuine pre-launch/early-construction project often
  isn't in Places yet. **Deliberately does not create an eligibility
  bypass** — a Places-only candidate carries no lifecycle language of its
  own (a bare address, not "under construction"), so it correctly still
  goes through the SAME lifecycle/geography hard-gate as every other
  candidate and stays UNKNOWN → rejected on the final pass exactly like
  today, unless something else corroborates it. Real Places fields (lat/
  lon/place ID/formatted address) thread through `EvidenceItem` →
  `NormalizedProperty` (`places_lat`/`places_lon`/`places_place_id`/
  `places_address`, `places_verified=True` — trivially, it came FROM
  Places) → `curator.py`'s `final_response.properties`
  (`placesLat`/`placesLon`/`placesPlaceId`/`placesAddress`) →
  `server.cjs`'s `adaptAgentProperty` → `ProjectSelection.jsx`'s
  `toAnalysableProject` → `ProjectIntelligence.jsx`'s `NearbyMap`, which now
  accepts a `knownGeo` prop and skips its own Nominatim/Google-Geocoding
  round-trip entirely when a candidate already carries a real, Places-
  resolved coordinate.

  **Part 2 — per-candidate entity verification.** After a name is
  finalized (`agent/agent/deep_research.py`'s `research_candidates()`, the
  SAME `MAX_CANDIDATES_FOR_DEEP_RESEARCH`-bounded loop deep-research
  already uses — no new unbounded pass), `places_verify()` looks up that
  exact name + locality via Places Text Search. A resolved match is a
  POSITIVE signal only — `places_verified=True`, real coordinates
  attached, a small +0.25 bonus folded into `scoring.py`'s existing
  evidence-quality dimension (`_score_evidence_quality`, same weight
  family as the RERA/source-count/freshness bonuses already there, never a
  new top-level scoring dimension). A candidate that does NOT resolve is
  **not itself rejected** — many legitimate new-launch projects genuinely
  aren't in Places yet — `places_verified=False` only BECOMES a gate in
  combination with a separate, independent check: `looks_like_invalid_name()`
  (`agent/agent/normalize.py`, mirrored as `looksLikeInvalidName()` in
  `backend/scoring.cjs`) — a regex PATTERN FAMILY (portal UI chrome/
  interstitial/generic-action phrasing: "Click Here", "View Details",
  "Security Alert", etc. — deliberately not a blocklist of the one bad
  example) plus a short-generic-word structural fallback. Only when BOTH
  "Places doesn't know this name" AND "the name itself doesn't read as a
  real project name" are true does `agent/agent/graph.py`'s
  `_apply_hard_eligibility_filter` reject it (final pass only, same
  discipline as the existing "no identifiable project name" gate right
  above it), with the honest reason "Could not verify this is a real
  project name." Mirrored on the Node fallback path inline in
  `external-search.cjs` (bounded to the top 8 already-eligible candidates,
  matching the `/api/competing-projects` "top 8" convention) since that
  pipeline has no separate "name finalization" step to hook.

  **Root cause of "Security Alert", traced (not assumed).** The exact
  source URL from the live run wasn't recoverable (this session's own
  extensive re-testing had already rotated the agent's tool-call cache by
  the time this was investigated) — but re-fetching the SAME URL that
  produced it moments later returned entirely different, legitimate
  category-page content (real listings: Chandak Greenairy, AVA Maple,
  Balaji Heights, real RERA numbers, real builders). The most plausible
  explanation, consistent with this evidence: 99acres served a bot-
  detection/interstitial page instead of its real content under this
  session's own repeated automated access, and `extract_project_name()`
  picked up that interstitial's title as if it were the project name. The
  fix doesn't depend on fully diagnosing 99acres' bot-detection behavior —
  `looks_like_invalid_name()` catches the resulting garbage name on its
  own shape, regardless of root cause.

  **A real false positive, caught by live testing before it shipped.** An
  earlier version of the name-similarity check (`namesLooselyMatch()`,
  Node; Places-side matching only exists on the Node side, since the
  Python tool trusts the bridge's `found` boolean) used token-SET overlap
  and matched "Security Alert" against a completely unrelated Places
  result: "Alert Securitas | Security Guard Services in Mumbai" (a real
  security-guard company, not a residential building) — purely because
  both share the tokens "security" and "alert" as separate words,
  confirmed via a live `/places-verify` call before this was caught.
  Tightened to CONTIGUOUS SUBSTRING containment (either direction) instead
  — rejects that exact case while still matching the real, common shapes
  ("Rivali Park" inside "RIVALI PARK"; "CCI Rivali Park Skyleap"
  containing/inside a shorter official "Rivali Park" Places entry).

  **Live re-verification.** "2bhk in borivali east": "Security Alert" is
  gone from results; the real surviving candidate ("Rivali Park By CCI
  Project Pvt Ltd...") is unaffected. Directly confirmed via a live
  `/internal/agent-tools/places-verify` call: "Security Alert" →
  `found: false`; "Rivali Park" → `found: true`, resolves to the real
  "RIVALI PARK" Places entry with real coordinates. "2bhk in dahisar west"
  (the query that was zero-result in an earlier pass, before that pass's
  own separate SOCIAL_URL_RE/NEW_LAUNCH_RE fixes) now returns real results
  with `places_contributed_candidates: 20` in `retrieval_metrics` —
  confirming Places discovery is genuinely contributing candidates to this
  locality, not silently absent. The empty-result explanation sentence
  (`curator.py`'s `_empty_result_explanation` / `external-search.cjs`'s
  message-building) now appends "Google Places was also checked (N
  additional candidates found...)" whenever Places is configured, even on
  a zero-result response — verified via a direct unit test (an organic
  zero-result live case wasn't reproducible during this pass; this
  session's own earlier fixes made most tested localities non-empty).

  **API cost.** Bounded and small: Part 1 is at most 1 Places Text Search
  call per query (skipped entirely for a location-less query). Part 2 is
  at most `MAX_CANDIDATES_FOR_DEEP_RESEARCH` (5) calls on the agent path,
  8 on the Node fallback path — and skips a candidate that already carries
  `places_verified` (either True from Part 1 discovery, or already
  attempted in a prior gap-driven research iteration), so a genuinely
  identical candidate is never re-verified. **Known, disclosed exception**:
  live-observed 7 Part-2 calls instead of 5 on one run — traced to two
  DIFFERENT candidate objects (different source URLs) that happened to
  extract the exact same generic fallback title ("Property in Borivali
  East, Mumbai - Real Estate in Borivali East, Mumbai") and weren't merged
  by dedup's exact-key tier (their `location` field text apparently
  differs enough to defeat it) — the same class of pre-existing dedup
  granularity gap already disclosed elsewhere in this doc (the "Dem Icon"
  2-4-separate-cards case), not a new bug introduced by this pass. Worst
  case is still bounded (≤ budget + a small, disclosed dedup-overlap slop),
  not unbounded — not chased further here given it's a narrow, low-cost,
  pre-existing gap rather than a Places-specific one.

  **Tests**: Python suite 104 → 117 checks (new: `looks_like_invalid_name`
  against the real live "Security Alert"/"Pastonji Bliss Tower"/"Rivali
  Park" examples; `_apply_hard_eligibility_filter`'s combined Places-
  verification + invalid-name gate, all three required scenarios — resolves
  cleanly, doesn't resolve but plausible, doesn't resolve and invalid — plus
  the `None`-vs-`False` distinction; the Places-transparency empty-result
  sentence). Node suite 47 → 58 checks (new: `looksLikeInvalidName` on the
  same real examples; `namesLooselyMatch`'s real false-positive regression
  test, using the ACTUAL unrelated business Places returned live, not a
  paraphrase). Both suites re-run clean after every change, including the
  cost-optimization fix made after live-testing surfaced the redundant-call
  observation above.

  ## AI Property Search + Project Intelligence — priority-ranking,
  ## lifecycle-status precedence, Dubai disambiguation, honest empty
  ## states, and a Competitor Analysis / map redesign

  A follow-up pass covering five numbered areas of a much broader spec.
  Every item was checked against the LIVE current code first (not assumed
  from this document's own history) — several described-as-gaps turned out
  to already be built; those are marked accordingly rather than rebuilt.
  Both the Python agent and the Node fallback pipeline were kept in sync
  everywhere a mirrored fix applies; both test suites were re-run after
  every change (not just at the end) and both backend services were
  restarted and re-probed live, not just unit-tested. Full live
  verification: a real agent process was restarted with this pass's code,
  a real `/agent/ai-search` call ("1BHK in Charkop Kandivali west") ran the
  full discovery → deep-research → gap-check → targeted-research → final-
  scoring → curate pipeline end-to-end against real Tavily/Google/Groq/
  Places calls, and the Project Intelligence screen was driven with a real
  headless-Chromium session (Playwright) to screenshot the actual rendered
  layout, not just reason about the JSX.

  ### 1. AI Property Search

  **1a — category pages as final results: already working, confirmed live.**
  Re-tested the exact two titles the spec named: `is_aggregator_title()`
  (Python) and `isAggregatorTitle()` (Node) both already correctly reject
  "2 BHK Flats in Dadar West" and "Properties for Sale in Dubai Marina" —
  no code change needed for these two. Live testing surfaced a THIRD,
  related shape that did slip through on both sides: "372+ 1 BHK Flats in
  Kandivali West, Mumbai" (a real 99acres.com category-page title returned
  by a live search during this pass) scored as an individual candidate
  because `PORTAL_CATEGORY_TITLE_RE`'s (Python) / the equivalent inline
  regex's (Node) leading-count group only ever expected a bare `bhk` word
  right after an optional leading count ("372+ BHK Flats"), never a full
  CONFIGURATION with its own number appearing between the count and the
  noun ("372+ **1 BHK** Flats") — the exact way this SEO title shape is
  actually phrased. Fixed in both `agent/agent/normalize.py`'s
  `PORTAL_CATEGORY_TITLE_RE` and `backend/scoring.cjs`'s inline pattern
  (both regex changes only, per the task's own "extend the existing
  regex/heuristic rather than building a second detection path" — same
  file, same function, one more group). Verified the fix doesn't regress
  either exact spec test case, a real project name ("Shreeji Sai Divine"),
  or a multi-config count ("50+ 2 & 3 BHK Apartments in Thane").

  **1b — pre-deep-research candidate ranking: genuinely new, built.**
  `graph.py`'s `_prioritize_for_deep_research()` previously only did a
  binary sort (undetermined-lifecycle candidates first, stable-sort
  preserving `score_all()`'s order within each group) — confirmed exactly
  as the spec described. Replaced the within-group ordering with a real
  weighted multi-factor score (`_candidate_priority_score()`): identity
  quality (`looks_like_invalid_name()` risk), location match strength
  (reads `scoring.py`'s own tier language out of `matched_requirements`/
  `match_reasons` — exact/parent/nearby/none), query match (reuses
  `score_all()`'s own `match_score`, never re-derived), lifecycle evidence
  presence (a weak possession-year-fallback signal outranks no signal at
  all), and data completeness (developer/rera/possession/carpet_area/price
  known-field count) — weighted 30/20/20/15/15, multiplied by a
  near-duplicate PENALTY (never a hard exclusion) using dedupe.py's own
  `_fuzzy_match()` against the rest of the SAME batch. The coarse
  undetermined-first GROUPING stays the dominant, first sort key
  (unchanged) — the live false-negative that fix addressed (a genuine
  under-construction project losing an unprioritized top-3 cut) must not
  regress under a fancier secondary score. `node_targeted_research`'s
  budget already called this exact same function, so it inherited the
  richer ranking for free — no second implementation. No Node-side mirror:
  the Node fallback pipeline has no deep-research/page-fetch capability at
  all to prioritize a budget for (same pre-existing architectural
  asymmetry documented earlier in this file).

  **1c — lifecycle status set and precedence: partially already correct,
  two real gaps fixed.** `NEAR_POSSESSION` already existed as its own
  distinct status (the task's premise that it didn't was wrong — confirmed
  by reading the live code, not assumed) — no work needed there.
  `PRE_LAUNCH` genuinely did not exist as its own status; "pre-launch" was
  folded into `NEW_LAUNCH_RE`. Split out into its own `PRE_LAUNCH_RE`
  (`agent/agent/normalize.py` and `backend/scoring.cjs`, mirrored exactly)
  matching the spec's exact phrase list ("pre-launch", "coming soon",
  "register your interest", "launching soon"), added to
  `ALLOWED_LIFECYCLE_STATUSES` on both sides (a pre-launch project is new-
  project inventory, not a disqualifying stage — arguably more relevant to
  this search than `READY_TO_MOVE`, which stays excluded). Separately, a
  REAL precedence bug: `classify_lifecycle_status()`/`classifyLifecycleStatus()`
  checked `NEW_LAUNCH`/`UNDER_CONSTRUCTION` BEFORE `READY_TO_MOVE`, so a
  page mentioning both an explicit "Ready to Move"/"Immediate Possession"
  claim AND a weaker/generic "under construction" phrase elsewhere (a
  realistic multi-phase-project page) would classify as still-building —
  the exact failure mode the spec called out ("a Ready to Move property is
  never shown as Under Construction"). Fixed by moving the `READY_TO_MOVE`
  check to immediately after the RESALE/RENTAL disqualifiers (both
  pipelines) — an explicit completion claim now always wins, regardless of
  what else is on the page. Also added genuine ~6-month MONTH-precision to
  the `NEAR_POSSESSION` possession-date fallback (`_parse_possession_month_year()`
  / `parsePossessionMonthYear()`, both sides) — previously this fallback
  only ever compared whole YEARS; when a month is parseable from
  `possession_display` ("Dec 2027"), a date <0 months out reads as already
  past (`READY_TO_MOVE`), ≤6 months out reads `NEAR_POSSESSION`, further out
  reads `UNDER_CONSTRUCTION` — falls back to the coarser year-only
  bucketing when only a bare year is known. New tests added to both suites
  (6 checks each) covering PRE_LAUNCH classification, the precedence fix
  (using a realistic "Phase 1 ready to move / Phase 2 under construction"
  fixture), and both month-precision fallback directions.

  **1d — UNKNOWN must not auto-reject: broadened as the spec explicitly
  asked, beyond the existing Places-only escape hatch.** Confirmed live and
  in code: the existing Places-verified escape hatch
  (`_apply_hard_eligibility_filter`, `external-search.cjs`'s equivalent
  filter) was real and working, but ONLY covered candidates ALREADY
  Places-verified — every other UNKNOWN candidate was still hard-rejected
  on the final pass purely for LACKING lifecycle evidence, which is exactly
  the "absence of evidence treated as disqualifying evidence" anti-pattern
  the spec calls out. Broadened on both sides: an UNKNOWN candidate (never
  `READY_TO_MOVE`, which is a CONFIRMED stage outside this search's policy,
  not an absence of evidence, and stays rejected) is now accepted with the
  same honest cap/reason treatment as the Places-verified path UNLESS its
  name independently `looks_like_invalid_name()` — the one remaining
  POSITIVE disqualifying signal, applied regardless of source. On the Node
  side this required restructuring the eligibility filter to DEFER (not
  reject) every UNKNOWN candidate into the existing `placesVerify` pass
  (previously only candidates already Places-sourced got that reprieve),
  and unifying the invalid-name rejection into one pass that runs
  regardless of whether Places is even configured (previously that check
  only ran inside the Places-configured branch, so an invalid-shaped name
  slipped through entirely with Places unconfigured). 1b's priority
  ranking is what gives these candidates a genuine research shot before
  this gate is ever reached, exactly as the spec asked. Live-verified
  against a real "1BHK in Charkop Kandivali west" run: the pre-existing
  Places-verified escape hatch fired correctly for 6 real buildings (capped
  TERTIARY 55, honest "status could not be independently verified"
  reason); the broadened non-Places branch is directly covered by two new
  unit-test fixtures (a real-looking UNKNOWN name accepted-and-capped, an
  invalid-looking UNKNOWN name still rejected despite the highest score in
  the batch) since a single live run's top-N selection happened to be
  dominated by the higher-scoring Places-verified candidates. One
  pre-existing, unrelated stale test assertion was found and corrected
  while verifying this (documented inline in the test file) — it asserted
  behavior contradicting this file's own already-documented "Security
  Alert" root-cause fix, and was already failing before this pass touched
  anything (confirmed via `git stash`).

  **1e — zero-result messaging, three distinct cases: a genuine gap,
  fixed.** `retrieval_metrics` (the structured aggregator/resale/rental/
  unknown/eligible counts curator.py's `_retrieval_metrics()` already
  computed) existed ONLY inside the dev-only `debug_trace` block on both
  the Python (`curator.py`) and Node (`external-search.cjs`) sides — never
  forwarded to the frontend in a production response, so
  `ProjectSelection.jsx` had no structured signal to distinguish "no
  candidates found" from "candidates found but explicitly disqualified"
  from "candidates found and plausible but unverified," and fell back to
  one generic message for all three. Fixed: `retrieval_metrics` (aggregate
  COUNTS ONLY — no candidate names/URLs, safe to always expose, distinct
  from the debug-gated per-candidate breakdown which stays debug-only) is
  now a top-level field on both `final_response` (curator.py) and the Node
  `queryExternal()` result, forwarded through `server.cjs`'s `/api/ai-search`
  on both the agent and Node-fallback branches. `ProjectSelection.jsx`'s
  `RankedResults` empty state now reads it to render one of three distinct
  headlines/details: `total_candidates === 0` → "No relevant candidates
  found"; `unknown_candidates > 0` → "Found N possible matches — none could
  be confirmed as eligible" (the honest, previously-missing "we found
  contenders, verification just didn't resolve" case — explicitly NOT
  worded as "no such properties exist"); otherwise → "N candidates
  reviewed — none matched your criteria" (explicit resale/rental/category-
  page disqualifications). Falls back to the existing generic message
  when `retrieval_metrics` is absent (an older cached response, or a
  connector-failure short-circuit that never reached the counting logic) —
  never a hard dependency that could blank the whole empty-state block.
  Live-verified: a real `/agent/ai-search` response now carries
  `retrieval_metrics` at the top level (confirmed via a direct capture of
  the real JSON, not just code review).

  **1f — Dubai Marina location/amenity disambiguation: a genuine gap,
  fixed.** The shared gazetteer (`mmr-gazetteer.json`) is Mumbai-region-
  only — Dubai locations were already falling through to the generic
  Title-Case/directional-suffix tiers in `extract_locations()`/
  `extractLocations()`, which (confirmed by direct testing, not assumed)
  already correctly told "Dubai" / "Dubai Marina" / "Marina View" / "near
  Dubai Marina" apart as distinct location strings — no conflation existed
  there. The real gap: `AMENITY_TERMS` had zero "view"-type entries at all,
  so "properties with marina view" extracted NEITHER a location (correctly
  — the existing stopword filtering already prevented that) NOR an
  amenity (the actual bug — the amenity was simply lost). Fixed with a new
  `VIEW_AMENITY_RE` (`with/having/offering/featuring/boasts/overlooking` +
  an optional article + a landmark word + "view") mirrored exactly in
  `agent/agent/query_understanding.py` and `backend/query-parser.cjs`: its
  matches are extracted as amenities AND masked out of the text BEFORE
  location extraction runs, so "with Marina View" (any casing) never gets
  mis-captured as the location "Marina View" by the generic Title-Case
  tier, while a bare "Marina View" (no such amenity-context prefix) is
  untouched and still resolves as its own distinct location, never
  conflated with "Dubai Marina." Also added plain "marina view"/"sea
  view"/etc. terms to `AMENITY_TERMS` as a forward-compatible fallback for
  phrasing without an amenity-context prefix. All 6 of the spec's named
  test queries verified identically on both the Python and Node sides
  (direct function calls, not just reasoning): "Dubai", "Dubai Marina",
  "Marina View", "near Dubai Marina", "properties with marina view", and
  "2BR with Marina View" (capitalized — proving the fix isn't case-based).
  New tests added to both suites (6 checks each).

  ### 2. Property Search → Project Intelligence data flow

  **Already working, confirmed, left alone — no genuine gap found.**
  `indihomes-client.cjs`'s `fetchProjectByName` remains the sole path
  (confirmed by reading the file — no second integration exists).
  `cleanDescription()` (already fixed in an earlier pass — preserves real
  markdown line breaks instead of flattening them) and
  `ProjectIntelligence.jsx`'s `displayDescription = official?.description
  || live?.description || research?.summary || ''` resolution chain carry
  the description through with no truncation anywhere in between —
  verified by tracing every step, not just spot-checking output. Audited
  the entire screen for "via Apify"/"via 99acres"-style connector-name
  leakage as the spec asked: no literal internal-connector strings
  (Apify/Tavily/LangGraph/LangSmith/Google CSE) appear anywhere in the
  file. The one family of source-naming that DOES appear — `SourceTag`'s
  colored "99acres"/"MagicBricks"/"Housing.com" badges and the RERA
  Details card's plain-text "Source: 99acres listing" row — was weighed
  against the spec's own carve-out for FieldBadge-style provenance and
  judged to be the SAME category of intentional, already-designed honesty
  signal (a consistent color-coded badge system used identically across
  four different cards, not a raw debug string), and in the RERA card's
  case directly load-bearing compliance context ("this number is
  advertiser-submitted, not government-verified — verify before
  marketing"). Left unchanged rather than removed, since removing it would
  delete real provenance information a salesperson doing due diligence can
  use, not "internal implementation detail no salesperson needs to see."

  ### 3. Project Intelligence UI — blank space + hierarchy

  **A real section-order gap, fixed; blank-space audit found nothing new
  to fix.** A fresh live screenshot pass (real headless-Chromium session,
  not code-only reasoning) found the actual rendered section order was:
  header/KPI row → Description+Inventory → Sales Velocity → USP+Target
  Audience → **Location Map+Nearby Infrastructure** → **RERA+Competitor
  Analysis**. This does not match the required hierarchy — Competitor
  Analysis must come directly after Target Audience, with the map/nearby
  section LAST. Fixed by swapping the two grid rows in
  `ProjectIntelligence.jsx` (RERA+Competitor Analysis now renders before
  Location Map+Nearby Infrastructure) — a pure JSX reorder, no logic
  change, no new state depended on paint order (`displayCompetitors` etc.
  are plain component-scope values, unaffected by where in the JSX tree
  they're read). Re-screenshotted after the fix and confirmed the new
  order live. No disproportionate blank space was found in this fresh
  pass — every card's `EmptyState`/`SectionCard` stretch-alignment from
  earlier passes is still intact and rendering correctly for a project
  with no live-scraped data (the default/unonboarded "Lodha Amara" mock
  used for this pass's live check legitimately has no description/
  inventory/USPs on file, and correctly shows honest empty states rather
  than blank space, for each of those cards).

  ### 4. Competitor Analysis — comparison depth

  **Baseline confirmed working live; redesigned for compactness + genuine
  field overlap, per spec.** `/api/competing-projects` (Google Places) is
  live and returning real data (verified with a direct call — 8 real named
  Thane-area buildings with distances and Maps links) despite the
  server's own startup-log disclaimer still saying "NOT verified callable
  ... last live probe returned 403" — that disclaimer is a stale,
  never-rechecked boot-time string, not the live behavior; confirmed the
  underlying "resolved as of this pass" claim from an earlier session is
  still true today. Redesigned the card list from two divergent branches
  (a large "real Places result" block vs. a differently-shaped "legacy
  Claude-research" block) into one compact, unified row: name (ellipsis-
  truncated, not wrapped) + address/builder on one sub-line, distance-or-
  status badge on the right, and — genuinely new — a field-overlap row
  that renders ONLY when the competitor's OWN object carries a real
  `config`/`price`/`possession` value (checked against the selected
  project's own `current.config`/`current.budgetLabel`), color-coding a
  configuration match/mismatch in green/red. Google Places entries
  (confirmed: `/api/competing-projects`'s response has no config/price/
  possession fields at all — Places genuinely doesn't carry this) never
  show that row, so nothing is fabricated for the common case; the row is
  forward-compatible for the legacy research-sourced shape (`comp.price`/
  `comp.status`) that already carries some of this. **Known, disclosed
  limitation, not attempted this pass**: there is no live mechanism to
  cross-reference an arbitrary Google-Places-found nearby building against
  AI Search's own richer candidate pipeline (which DOES have real
  config/price/possession/lifecycle) — `/api/competing-projects` is a bare
  lat/lon geo endpoint with no query context to re-run that pipeline
  against, and doing so per nearby building would mean a new, expensive,
  unbounded search call per competitor. Building that cross-reference
  would be a substantial new feature (a new endpoint, a new join strategy)
  rather than a fix to something broken, so it was not attempted here —
  the field-overlap UI is real and ready for that data whenever/if it
  becomes available, it just isn't populated for a Places-only competitor
  today.

  ### 5. Map / Nearby Projects redesign

  **Reused the existing Leaflet/CARTO map exactly as instructed; the
  marker/list sync was genuinely new and had one real bug fixed along the
  way.** Added `lat`/`lon` to `/api/competing-projects`'s response (were
  computed server-side for the distance calculation already, just never
  forwarded) so Competitor Analysis's real coordinates can reach the map at
  all. `NearbyMap` now plots each competitor with real coordinates as a
  distinct small purple-diamond marker (visually separate from the
  project's own navy teardrop pin and the generic OSM infrastructure
  dots), and `selectedCompetitorId` state (lifted to the shared parent
  component) syncs a click on a Competitor Analysis list row to a
  pan-and-open-popup on its marker, and a marker click back to highlighting
  the same list row. **A real bug found and fixed during live
  verification, not just written and assumed correct**: the first
  implementation folded competitor-marker drawing into the SAME `useEffect`
  that geocodes the project and draws OSM places — that effect's
  dependency array is `[projectQuery, fallbackQuery]` only, so it captured
  `competitors` in a stale closure at whatever (initially empty) value it
  held when the effect last ran; since Competitor Analysis's own fetch
  resolves asynchronously and independently, real competitor data arriving
  later never triggered a redraw, and a live screenshot showed zero purple
  markers despite 8 real competitors listed in the card next to it. Fixed
  by moving marker drawing into its own `useEffect` keyed on
  `[competitors, status]`, which correctly redraws whenever competitor data
  changes after the map is already up. Live-verified end to end with a
  real headless-Chromium session against the real running app: 8 purple
  diamond markers now render at their real coordinates; clicking a list
  row ("Kalpataru Immensa, Thane") highlights that row AND pans the map to
  open exactly that marker's popup (captured the live popup's own text:
  "Kalpataru Immensa, Thane · 0.3 km away" — confirming the sync resolves
  to the correct marker, not just any marker). Distance-shown and
  professional loading/error/empty states were already built and reused
  unchanged, per the spec's own instruction not to duplicate them.

  ### Final report — status of each of the 5 sections

  1. **AI Property Search** — 1a/1c/1d/1e/1f each had at least one real,
     live-confirmed gap, all fixed (see above for the specific root cause
     and fix per sub-item); 1b was genuinely new and built as specified;
     one pre-existing failing/stale test assertion (unrelated to this
     pass's own changes) was found and corrected along the way.
  2. **Property Search → Project Intelligence data flow** — already
     working; audited and confirmed, nothing changed.
  3. **Project Intelligence UI hierarchy** — one real section-order gap
     (Competitor Analysis was after, not before, the map section), fixed;
     no blank-space regressions found in a fresh live screenshot pass.
  4. **Competitor Analysis depth** — baseline confirmed working live;
     redesigned to a compact, unified card with genuine (never invented)
     field-overlap comparison; cross-referencing a Places-only competitor
     against AI Search's own richer pipeline is a disclosed, un-attempted
     limitation (a new feature, not a fix).
  5. **Map / Nearby Projects redesign** — synced map/list selection was
     genuinely new and is now built and live-verified, including a real
     stale-closure bug caught and fixed during that verification, not
     shipped on the strength of the code reading correctly alone.

  **Tests**: Python suite 117 → 134 checks; Node suite 58 → 70 checks. Both
  suites re-run clean after every change in this pass. Both backend
  services (the Python agent and the Node/Express server) and the frontend
  dev server were restarted with this pass's code and driven live — a real
  `/agent/ai-search` call end-to-end, a real `/api/competing-projects`
  call, and a real Playwright-driven browser session against
  `localhost:5174` — rather than trusting static code review alone for any
  of the five sections.

  ---

  ## Reduction pass — agent supervisor, an explicit pipeline label, and
  ## deleting the Node fallback's duplicated classification logic

  A deliberately shrinking pass, not a feature pass: three changes aimed at
  reducing the complexity this doc has been accumulating, requested after
  the Python agent (`agent/app.py`) had crashed from port conflicts
  repeatedly throughout this project's history with nothing restarting it
  — every time, AI Search silently fell back to a worse pipeline with no
  visible signal, which is also why the Node fallback's classification
  logic kept having to be patched a second time (see the "Wiring fix" and
  "AI Property Search — hard lifecycle/eligibility filter" sections above)
  instead of the agent just being reliably up.

  **1. Agent supervisor (`backend/scripts/run-agent.ps1`, new).** A boring
  `while ($true)` loop — no pm2, no systemd, no Docker, no new dependency.
  Starts `agent/app.py` via `agent/.venv/Scripts/python.exe`; if the
  process exits, restarts it, with a basic backoff (won't restart more
  than once every 5 seconds, so a genuinely broken agent degrades to a
  slow retry loop instead of a tight crash loop). On startup, checks
  whether `AGENT_PORT` (default 8008) is already listening
  (`Get-NetTCPConnection`) and, if so, does nothing — this is the actual
  recurring failure mode this project has hit ("port already in use"
  because an old instance never died), and treating an already-occupied
  port as "already running" is simpler and safer than finding and killing
  whatever's listening. `run-indihomes.ps1` (the existing "start
  everything" script — untouched otherwise) now launches this supervisor
  in the background, non-blocking, before `npm run start`, skipped with an
  explanation if `agent\.venv` isn't set up yet. Live-verified: started the
  supervisor, confirmed the agent came up on :8008, killed its `python.exe`
  process directly (`Stop-Process -Force`, simulating a crash), confirmed
  the port went down immediately and the supervisor brought a fresh
  process back up on its own within the same run (no human touching a
  terminal) — the process tree (`run-agent.ps1` → `python app.py` →
  uvicorn worker) was inspected directly via `Get-CimInstance
  Win32_Process`, not assumed from log output alone. One thing this
  surfaced and fixed along the way: an em dash in the script's comments/
  strings broke Windows PowerShell 5.1's parser when the file has no BOM
  (the interpreter reads a non-BOM `.ps1` using the system codepage, not
  UTF-8, so a multi-byte UTF-8 dash gets misread as stray characters) —
  `backend/scripts/register-refresh-task.ps1` has the same latent issue
  and was left as-is (out of scope for this pass), but every new/edited
  `.ps1` file in this pass sticks to plain ASCII punctuation.

  **2. Explicit `pipeline` field on every `/api/ai-search` response
  (`backend/server.cjs`, `frontend/src/components/screens/
  ProjectSelection.jsx`).** The route already had three branches (Places-
  direct discovery → the LangGraph agent → the Node connector fallback,
  each falling through to the next on failure/non-configuration) but which
  one actually answered a given request was only inferable from
  inconsistent ad-hoc fields (`_source: 'places-direct'` on one branch,
  `_agent: true` on another, nothing distinguishing on the third) — this
  is part of why a fix sometimes looked like it "did nothing" during this
  project's history: the request never reached the fixed code path.
  `pipeline: 'agent' | 'places-direct' | 'node-fallback'` is now set
  explicitly on all three branches. `ProjectSelection.jsx`'s
  `AnalystReport` renders a new `PipelineLabel` component — a small,
  unobtrusive line ("via full research" / "via nearby buildings" / "via
  quick search", plain language, no internal pipeline names) above the
  filter chips. Live-verified against the real running backend: a plain
  India-market query returned `pipeline: 'places-direct'`; the same query
  with the agent stopped and a Dubai-market query (Places-direct is
  India-gazetteer-tuned only, so it's skipped for `market: 'dubai'`)
  returned `pipeline: 'node-fallback'`; starting the agent and re-running
  the identical Dubai query returned `pipeline: 'agent'` with a real
  `research_metadata` block attached — all three branches confirmed live,
  not just read from the code.

  **3. Deleted the Node fallback's duplicated classification/eligibility
  logic (`backend/scoring.cjs`, `backend/external-search.cjs`).** This was
  the main ask, investigated before anything was deleted. What depended on
  it: grepped every caller of `isAggregatorTitle`, `classifyLifecycleStatus`,
  `ALLOWED_LIFECYCLE_STATUSES`, `extractSubListings`, and the fuzzy tier
  inside `mergeDuplicateProperties` across the whole repo (`backend/` and
  `frontend/`) — every one of them was called ONLY from inside
  `external-search.cjs`'s own `queryExternal()`, nowhere else. (`scoring.cjs`
  also exports `scoreIndiHomesProject`/`filtersFromBuckets`/
  `filtersFromParams`, which power Filter/Property Search against the
  official IndiHomes catalog — a completely separate, unrelated code path;
  confirmed untouched by grepping `server.cjs`'s own `scoring.` call sites.)
  Nothing else in the codebase depended on the classification logic
  specifically, so it was safe to delete outright rather than route around.

  Deleted: `isAggregatorTitle()` + its `PORTAL_SEO_SUFFIX_RE`/
  `PROJECTS_IN_PLACE_RE`/`PAGINATION_PREFIX_RE`/`isBareLocalityTitle()`/
  `KNOWN_PLACE_NAMES` supporting regexes (scoring.cjs); `classifyLifecycleStatus()`
  + its `RESALE_RE`/`RENTAL_RE`/`UNDER_CONSTRUCTION_RE`/`NEW_LAUNCH_RE`/
  `PRE_LAUNCH_RE`/`NEAR_POSSESSION_RE`/`READY_TO_MOVE_RE`/
  `parsePossessionMonthYear()` and `ALLOWED_LIFECYCLE_STATUSES` (scoring.cjs);
  the geography/locality whole-phrase hard filter and its `locationTerms`
  computation (external-search.cjs); the fuzzy dedup tier
  (`GENERIC_PROJECT_WORDS`/`nameTokens()`/`fuzzyMatch()`) inside
  `mergeDuplicateProperties` — the exact-key tier (RERA → normalized
  name+location) stays, unchanged; and `extractSubListings()` (RERA-anchored
  sub-listing extraction from rejected category pages) — this existed
  purely to backfill listings from pages `isAggregatorTitle()` rejected, so
  it had no remaining purpose once that classifier was gone. 524 lines
  deleted across the two files (`wc -l`: scoring.cjs 725 → 495;
  external-search.cjs 841 → 547).

  **Kept, deliberately** (not part of this ask, still doing real, distinct
  work): `looksLikeUnrelatedCommerce()`/`UNRELATED_COMMERCE_RE` (spam/
  e-commerce content detection — not lifecycle classification) and
  `looksLikeInvalidName()` + the Places-verify identity gate (the
  "Security Alert" bot-interstitial garbage-name catch — a name-SHAPE
  sanity check, independent of any lifecycle judgment); `scoreExternalProject()`
  and its whole 30/25/20/15 scoring shape (ranks/labels results against the
  parsed query, never rejects one outright); RERA/carpet-area/floor-count/
  connectivity extraction (purely extractive fact-gathering, not
  eligibility judgment); the exact-key dedup tier; and the low-confidence
  floor (`match_score >= 15`).

  What `external-search.cjs`'s `queryExternal()` is now: connectors → Azure
  external index → spam filter → score/rank against the query → exact-key
  dedup → Places name-verification sanity gate → done. No resale/rental/
  category-page/geography rejection — a rental listing or a portal category
  page can now appear in this path's results, same as it would from a
  direct Google Places search. This is intentional: this path is reached
  ONLY when both the agent (now reliably kept up by the supervisor above)
  AND Places-direct discovery are unavailable — the genuinely-last-resort
  case — and it now behaves the same honest, unclassified way Places-direct
  already does ("show what a connector returned"), rather than being a
  second, independently-maintained copy of the agent's real eligibility
  pipeline that silently drifted out of sync with it (confirmed, repeatedly,
  earlier in this document) every time one side got a correctness fix the
  other didn't.

  **Tests**: `backend/tests/test_lifecycle_and_eligibility.cjs` — the tests
  for the deleted logic were deleted with it (not left dead), the rest kept
  as regression coverage for what's still real: spam detection, deterministic
  scoring/ranking/tiering, `buildCanonicalCandidateId` determinism, exact-key
  dedup, the Places-verify invalid-name gate, and the Dubai location/amenity
  disambiguation. 70 checks → 28 checks (the drop is the deleted logic's own
  tests, not a coverage regression on what remains — every remaining check
  from the 70 still passes unchanged). `agent/tests/` (Python) is completely
  untouched by this pass — the agent keeps its full classification pipeline;
  it's the one place that logic still needs to live. Both suites re-run
  clean. The file name (`test_lifecycle_and_eligibility.cjs`) is now a bit
  of a misnomer — most of what it tested is gone — but wasn't renamed, to
  avoid a same-pass rename-plus-content-change diff; a future pass touching
  this file again should rename it to something like `test_search_fallback.cjs`.

  ---

  ## Strict eligibility (no escape hatches) + honest result cards
  ## (why/price/RERA never blank)

  A follow-up pass, four items: close a real gap the previous "Reduction
  pass" left open (the agent's own eligibility filter still had two escape
  hatches accepting old/unconfirmed properties instead of rejecting them),
  plus three result-card honesty fixes.

  **1. Confirmed `ALLOWED_LIFECYCLE_STATUSES`, then removed the two escape
  hatches that undermined it (`agent/agent/normalize.py`,
  `agent/agent/graph.py`).** `ALLOWED_LIFECYCLE_STATUSES` in
  `normalize.py` was already exactly `{UNDER_CONSTRUCTION, NEAR_POSSESSION,
  NEW_LAUNCH, PRE_LAUNCH}` — verified against the live file before assuming
  a change was needed, per the task's own instruction; no change required
  there. The real gap: `graph.py`'s `_apply_hard_eligibility_filter()`,
  on the FINAL pass, had two escape hatches that ACCEPTED a candidate
  outside this allowed set anyway — a Places-verified acceptance ("a real,
  existing building shouldn't be discarded just because Places doesn't
  track construction status") and a broader "any UNKNOWN lifecycle + a
  valid-looking name" acceptance (Part 1d from an earlier pass, "absence of
  evidence is not itself disqualifying evidence") — both capped the score
  to TERTIARY-max and attached an honest "status not confirmed" reason
  rather than rejecting outright. Per explicit instruction ("should not
  show old properties," "strictly show properties only"), both were
  deleted, not weakened — a candidate whose status is READY_TO_MOVE,
  RESALE, RENTAL, or stays UNKNOWN even after deep research had its full
  chance is now rejected on the final pass, full stop, no capped/labeled
  middle ground. The `_accept_unverified()` helper and the
  `_unverified_lifecycle` flag it set are gone entirely (grepped the whole
  repo afterward — nothing else referenced them; the one remaining mention
  is a comment documenting what USED to happen, for context). Rejection
  reason text updated to be accurate post-change (the old code had a
  latent bug here too: the generic "still outside the allowed set" branch
  used the reason string "Could not verify this is a real project name"
  for a plain UNKNOWN status, which was actually the WRONG reason — that
  exact string belongs to the separate, independent name-validity gate a
  few lines below, which still exists and still fires on its own merits).

  **Real behavior change, confirmed live**: querying the agent directly
  (`POST http://localhost:8008/agent/ai-search`, bypassing Places-direct)
  with "2 BHK with deck in Liberty Garden near Malad West" — a query with
  real history in this same document — returned `retrieval_metrics:
  {"total_candidates":47,...,"unknown_candidates":20,...,"eligible_candidates":4,
  "rejected_candidates":44}` and exactly 3 final properties, EVERY one
  UNDER_CONSTRUCTION with real evidence — none UNKNOWN, none Places-verified-
  but-unconfirmed. Under the old escape-hatch behavior, a meaningful chunk
  of those 20 UNKNOWN candidates would have surfaced capped-and-labeled;
  now they correctly don't appear at all.

  **The Node fallback — deliberately left untouched, per the user's own
  explicit decision this session.** The task asked to mirror both the
  `ALLOWED_LIFECYCLE_STATUSES` constant and this rejection behavior into
  `backend/scoring.cjs`/`backend/external-search.cjs` — but the previous
  "Reduction pass" (immediately above in this document) had already
  deleted `classifyLifecycleStatus`/`ALLOWED_LIFECYCLE_STATUSES`/
  `isAggregatorTitle` from the Node side entirely, on the reasoning that
  the agent (now reliably kept up by the supervisor) makes that
  duplication unnecessary. Surfaced this conflict directly instead of
  silently either skipping the instruction or silently reintroducing the
  deleted logic; asked, and the user chose to leave the Node fallback
  as-is — it stays a bare, unclassified "show what a connector returned"
  path with no lifecycle concept at all, consistent with the prior pass.

  **2. A real, short "why" on every card (`backend/scoring.cjs`,
  `backend/server.cjs`, `backend/external-search.cjs`,
  `frontend/.../ProjectSelection.jsx`).** The match-reason line had
  previously been removed from `PropertyCard` entirely for reading as a
  long, technical, "·"-joined string (e.g. "Exact location match: X · 2
  BHK available · Possession 2027 is within your requested window · Seen
  today"). New `scoring.pickPrimaryMatchReason(reasons)` — shared by all
  three `/api/ai-search` response-building code paths, not reimplemented
  three times — picks ONE reason: a location-match reason first (a buyer's
  actual stated location is what matters most), then a configuration-match
  reason, then whatever's first in the list as a last resort. `why` on
  each pipeline's response now carries just this one reason (the full
  `match_reasons` LIST is untouched everywhere it's used for other
  purposes, e.g. Project Intelligence's fuller detail view — only the
  compact card's single-line summary changed). `PropertyCard` renders it
  back as a small line under the property name, truncated to ~60
  characters with an ellipsis for the rare longer reason.

  Live-verified on all three pipelines with real requests against a
  running backend: Places-direct → `"Real building found near Borivali
  East"` (36 chars); Node-fallback (Dubai-market query, agent stopped) →
  `"Exact location match: Dubai Marina"` (34 chars, previously would have
  been `"Exact location match: Dubai Marina · Seen today"` with a
  freshness-label suffix folded in — that suffix is gone from `why` now,
  freshness stays available as its own separate field); agent path (real
  `match_reasons` from a live agent response, run through the actual
  `pickPrimaryMatchReason()`) → `"Exact location match: Liberty Garden"`
  (37 chars) and `"Located in Malad West; Liberty Garden not independently
  verified"` (67 chars — the one case that actually hits the frontend's
  60-char truncation, confirmed to still degrade gracefully with an
  ellipsis rather than breaking).

  **3. Price — option (b) implemented, not (a), and why
  (`frontend/.../ProjectSelection.jsx`).** Confirmed current behavior
  first, live, rather than assuming: the agent and Node-fallback paths
  already render a real price when one exists (confirmed via the same live
  Dubai-market node-fallback query above — real extracted prices like "AED
  28,00,000" render correctly). The known gap was real: Places-direct
  (`searchResidentialPlaces`/`places-client.cjs`) always sets `price:
  null`, since Google Places genuinely has no price field at all. Option
  (a) — a per-card price lookup, similar in spirit to the existing RERA
  auto-lookup — was considered and explicitly rejected: the RERA lookup
  runs ONCE, for a single already-selected project in Project Intelligence;
  Places-direct returns up to 20 results PER QUERY, so a price lookup per
  card would mean up to 20 extra search calls on every request, directly
  undermining the one thing Places-direct exists for (being the fast,
  simple, no-extra-research option). Implemented option (b) instead: a
  price chip that ALWAYS renders something — a real value, or an honest
  "Price not available" — via a new `emptyLabel` prop on the existing
  `FactChip` component (kept generic/reusable rather than special-cased
  just for price, though price is the only fact that currently uses it;
  every other optional fact still correctly renders nothing when absent).

  **4. RERA badge always renders something
  (`frontend/src/components/ui/FieldBadge.jsx`,
  `frontend/.../ProjectSelection.jsx`).** `PropertyCard` previously only
  rendered the RERA badge conditionally (`{p.rera && <FieldBadge .../>}`)
  — a missing RERA number showed nothing at all, not an honest label. New
  `FieldBadge` kind, `none` ("Not available", no icon-based warning
  triangle, muted grey `#ABA9B5`) — deliberately NOT reusing the existing
  `unverified` kind for this, since that kind's own ⚠ icon reads as a
  warning/problem, and a missing RERA number is a normal, expected state
  for many real listings, not a failure. `p.rera` present still renders
  the existing "RERA `<number>` (unverified)" badge unchanged; absent now
  renders "RERA not available" instead of nothing.

  **Tests**: `backend/tests/test_lifecycle_and_eligibility.cjs` — 5 new
  checks for `pickPrimaryMatchReason` (location preferred over
  budget/possession/quality, configuration preferred when no location
  reason exists, first-reason fallback, null-safety, and the "Located in
  X; Y not independently verified" parent-locality phrasing still counting
  as a location reason). `agent/tests/test_lifecycle_and_eligibility.py`
  — the two test blocks that asserted the OLD escape-hatch acceptance
  behavior were rewritten to assert the new strict-rejection behavior
  instead (not just deleted — the "Mystery Listing"/"Security Alert" UNKNOWN
  cases are still exercised, now both correctly rejected instead of one
  being accepted-and-capped); every other test block in the file already
  used eligible lifecycle statuses for its own fixtures and needed no
  change, confirmed by re-reading each one rather than assumed. Both
  suites, plus `agent/tests/test_bridge_circuit_breaker.py`, re-run clean.
  `npm run build` re-confirmed. Both backend services restarted with this
  pass's code and driven live for every verification claim above — not
  read from the code alone.

  ---

  ## The agent is now the PRIMARY /api/ai-search path, not Places-direct

  A deliberate architecture change, explicitly NOT a performance
  optimization: the person requesting this understood and accepted that
  most searches now take real time (35-140+ seconds observed) instead of
  Places-direct's near-instant answers.

  **1. Reordered the three branches (`backend/server.cjs`'s
  `/api/ai-search`).** Was: Places-direct → agent (gated on
  `LANGGRAPH_ENABLED=true`) → Node fallback. Now: agent FIRST → Places-
  direct SECOND (now the fallback) → Node fallback THIRD (unchanged). Pure
  reorder — each block's own code, try/catch, early `return res.json(...)`,
  and silent-fall-through-on-error behavior is untouched, only the
  sequence changed (plus updating each block's own descriptive comments to
  stop saying "tried FIRST" when they no longer are).

  **2. Timeout/fall-through logic checked, no bug found, value NOT
  changed.** `queryAgent()`'s `AbortSignal.timeout(AGENT_TIMEOUT_MS)`
  (120000ms, from `.env`'s `AI_SEARCH_TIMEOUT_MS`) throws on expiry exactly
  like any other fetch failure — it's inside the SAME try/catch the route
  already had, so a timeout falls through to Places-direct identically to
  a connection refusal or an HTTP error. No frontend-side fetch timeout
  exists either (confirmed by reading `ProjectSelection.jsx`'s own fetch
  call — no `AbortSignal`/timeout wrapper), so the browser genuinely waits
  as long as the backend does. **Live-verified, twice, for real**: two
  full `/api/ai-search` requests ("2 BHK in Bandra West", "1 BHK in
  Andheri JB Nagar") each took ~120s, logged `agent service unavailable...
  The operation was aborted due to timeout`, and correctly returned
  `pipeline: 'places-direct'` with real results — not a failed request.
  Separately confirmed the agent itself wasn't hung, just slower than the
  budget: the same Bandra West query, run directly against the agent
  (bypassing the route's timeout) with a 4-minute curl budget, completed
  in `duration_ms: 194520` (194.5s) with a genuine, thoroughly-researched
  zero-candidate result (`total_candidates: 60`, 71 tool calls, 2 research
  iterations — the max — `candidate_count: 0`) — Bandra West apparently
  has no new-launch/under-construction inventory reachable through the
  configured connectors right now, which is a real answer, not a bug.

  **3. Frontend loading state — genuinely inadequate for the new wait
  length, fixed (`frontend/.../ProjectSelection.jsx`).** The 5-stage
  cycling message (`RESEARCH_STAGES`) advanced every 1100ms and stopped at
  the last stage — all 5 stages burned through in ~4.4s, then the UI froze
  on "Ranking matching properties…" (implying near-completion) for the
  remaining ~30-190+ seconds of a real wait, with only the spinner still
  animating. Fixed with two small, targeted changes, not a rebuild: the
  interval slowed to 4500ms, and the stage index now LOOPS (`% length`)
  instead of freezing at the end — cycling back through the same honest
  phrases reads truer than parking on one implying the search is almost
  done. Added a real elapsed-seconds counter (new `elapsedSec` state,
  ticked every second, cleared alongside the existing stage timer) — the
  clearest unambiguous "still working, not hung" signal for a wait this
  long; a "can take up to 2 minutes" note appears once elapsed exceeds
  10s, so a fast Places-direct/Node-fallback answer never shows it at all.

  **4. Pipeline label copy — confirmed correct as-is, no change needed.**
  `PIPELINE_LABEL`'s `"via full research"` (small, muted `#A8A6B3` text,
  no icon, no "rare case" styling) reads exactly as well as the common
  case as it did as the rare one — it was never phrased or styled as an
  exception in the first place. Confirmed by reading the component, not
  assumed.

  **Live verification, in full**: with a fresh backend + agent running,
  ran the same Liberty Garden query that produced a genuine agent success
  earlier in this document — `pipeline: 'agent'`, `_agent: true`,
  `research_metadata` present, 3 real UNDER_CONSTRUCTION properties, real
  wall-clock time **108.9 seconds** (`time curl`, not estimated), each
  card's `why` short (36 and 64 chars — the 64-char one is the one real
  case that hits the frontend's 60-char truncation, confirmed to degrade
  gracefully), price/RERA real where available. **LangSmith confirmed
  directly via its own REST API** (not just config presence this time):
  queried `https://api.smith.langchain.com/api/v1/runs/query` for the
  `Property_Ai-search` project's root runs and got back 4 real `LangGraph`
  chain traces, `status: "success"`, with `inputs.original_query` matching
  every query run this pass and `start_time`/`end_time` matching the
  observed wall-clock durations exactly (e.g. one trace ran
  10:48:56→10:50:44, a 108s span matching the 108.9s `time curl` result to
  within a second). **Fallback path deliberately re-tested with the agent
  genuinely fully stopped** (a leftover supervisor process from an earlier
  session pass was found still running and quietly keeping the agent
  alive during an earlier fallback-test attempt — a testing-hygiene
  mistake caught and corrected mid-verification, not a code bug; once
  every agent process was actually confirmed dead via `Get-CimInstance`,
  not just assumed from a `Stop-Process` call) — a search with the agent
  truly unreachable failed over in **0.81 seconds** (`fetch failed`,
  correctly caught, no 120s wait), returning `pipeline: 'places-direct'`
  with 20 real results — never a broken/failed request either way.

  **Tests**: both suites re-run clean, unchanged (a pure reorder, per the
  task's own expectation — no test content needed to change, and none
  did).

  ---

  ## Places-direct grows real teeth — bounded per-result price + lifecycle
  ## enrichment, a genuine LLM "why," and two honest table simplifications

  Seven items, two of them user-decided-final ("System A should get a real
  per-property web search for pricing, accepting slower" / "unit config
  table: carpet + price only, no Total/Available/Movement at all, not even
  a placeholder"). Every claim below is from actual live testing, including
  two real debugging discoveries this pass surfaced that weren't part of
  the original ask.

  **0. Agent-first routing — confirmed intact, unchanged.** Re-read
  `server.cjs`'s `/api/ai-search`: the agent block (`LANGGRAPH_ENABLED`
  check) still precedes the Places-direct block, exactly as the previous
  pass left it.

  **3 (built first — everything else in this pass hangs off it). Places-
  direct's bounded per-result enrichment.** New `agent/agent/tools.py`
  `enrich_property()` — modeled exactly on the existing `rera_lookup()`
  (one bounded web search, up to 2 page fetches, reusing
  `fact_extraction.deterministic_extract()` — which already calls
  `normalize.classify_lifecycle_status()` against the real fetched page's
  own text, never a second classifier) — and a new
  `POST /agent/enrich-property` route in `app.py`, same pattern as the
  existing `/agent/rera-lookup`. `backend/server.cjs`'s Places-direct
  branch gained `enrichPlacesResults()`/`enrichOnePlacesResult()`: bounded
  to the top `PLACES_ENRICH_MAX_RESULTS` (12) candidates by Places' own
  relevance rank, run in parallel via `Promise.allSettled`, each bounded by
  its own `PLACES_ENRICH_TIMEOUT_MS` (25000ms, deliberately separate from
  `AGENT_TIMEOUT_MS`). A confirmed RESALE/RENTAL/READY_TO_MOVE result is
  **excluded from the response entirely** (the "no old properties"
  requirement); a genuinely inconclusive one is kept with
  `lifecycleStatus: 'UNKNOWN'`; a candidate outside the top-12 bound is
  returned unchanged (never checked, same behavior as before this pass).
  Degrades gracefully exactly like every other agent-dependent call in
  this file — if the agent is unreachable, each enrichment call fails fast
  (confirmed live: ~0.86s for a full 20-result Places-direct response with
  the agent genuinely down, all 20 properties correctly falling back to
  `price: null`/no lifecycle badge, never blocking or erroring).

  **Real debugging discovery #1 — `web_search`'s own connectors were dead
  in this deployment.** First live test of the new endpoint returned
  `{"price":null,...,"lifecycle_status":"UNKNOWN"}` in 1.27s — suspiciously
  fast and empty. Traced directly (isolated a standalone Python script
  calling `tools.web_search()` alone, not assumed): `web_search` maps to
  Google CSE + Bing only (`agent-tools-bridge.cjs`'s `/web-search` route)
  — Google CSE 403s in this deployment (a pre-existing, previously-
  documented key-restriction issue), and Bing isn't configured at all, so
  `web_search` genuinely, correctly returns zero evidence every time,
  `status: "ok"`. This is a real pre-existing gap `rera_lookup()` (which
  uses the identical `web_search` call) has silently had all along — this
  pass is what exposed it, by being the first caller to actually depend on
  `web_search` alone succeeding for its whole result. Fixed: `enrich_property()`
  falls back to `tavily_search` (the one connector confirmed healthy in
  every other live test this session) when `web_search` comes back empty —
  same tool the main deep-research pipeline already leans on for this
  exact purpose, not a new one. Re-tested live: real price (`₹5.65 Cr`),
  real RERA (`P51800003067`), and real per-configuration
  `configuration_evidence` (2/3/4 BHK rows with real carpet-area/price
  evidence from an actual MagicBricks page) all came back correctly after
  the fix.

  **Real debugging discovery #2 — a genuinely high false-positive rate on
  raw category-page text, disclosed not hidden.** A real, controlled
  measurement (standalone script calling `searchResidentialPlaces` for "2
  BHK in Borivali East", then `/agent/enrich-property` for the top 12 in
  parallel, timed) came back **9 of 12 (75%) classified RESALE or
  RENTAL** — meaning the real production code would have excluded 9 of
  those 12 outright. Investigated rather than assumed a bug: every one of
  the 9 was a MagicBricks/portal page — the SAME class of false-positive
  documented earlier in this file for "Rivali Park" (also reproduced in
  this pass, live: a real, previously-confirmed-legitimate UNDER_CONSTRUCTION
  project came back `lifecycle_status: "RENTAL"`, evidence text
  `"Property Types \n Flat for rent in Mumbai \n House for re..."` — page
  NAVIGATION/FILTER-WIDGET chrome listing transaction-type categories, not
  a claim about this specific building, the exact same shape of bug the
  "Posted By Owner Builder Dealer" filter-widget fix addressed earlier in
  this document, just a different phrase/page). `classify_lifecycle_status()`
  was built and tuned against `deep_research.py`'s candidate pages
  (generally a single project's own listing/developer page); this new
  code path's first search result is more often a broad portal
  category/search page (the query — `"<name> <locality> price
  possession"` — has no RERA-anchor or single-project scoping the way the
  main pipeline's candidate selection does), which routinely mentions
  "for rent"/"resale"/other-transaction-type language as page furniture,
  not as a fact about the one building being enriched. **Deliberately NOT
  patched this pass** — the task's own explicit instruction was to reuse
  `classify_lifecycle_status()` exactly as-is, not build or tune a second
  classifier, and this is the SAME classifier, just newly exposed to a
  page-text shape it wasn't originally exercised against. Disclosed as a
  real, known limitation, same "accepted rare false-positive" tradeoff
  this codebase has made before (`isAggregatorTitle`'s own comment: "an
  acceptable rare false-positive versus routinely showing non-listings as
  search results") — except this rate (75% in one real measured batch) is
  materially higher than "rare," and a future pass should look at
  preferring a more specific single-listing URL over a category/portal
  page for this specific enrichment query, before trusting classify_
  lifecycle_status's output here as confidently as the main pipeline does.

  **Real measured timing**: the 12-candidate parallel enrichment batch
  above took **45.06 seconds** wall-clock (measured directly, not
  estimated) at a LOOSER 45s per-call cap than production's real
  `PLACES_ENRICH_TIMEOUT_MS` (25000ms) — one of the 12 calls didn't finish
  before that looser cap and was rejected; in the actual production code
  path, any call exceeding 25s is aborted and treated as "no enrichment
  found" for that one result (graceful degrade, never blocks the rest).
  So the real production ceiling for this step is bounded at ~25s, not
  45s+ — still meaningfully faster than the 108.9s full-agent-path search
  documented earlier in this file (a >4x difference at the bound), while
  genuinely no longer near-instant, exactly the tradeoff the person
  requesting this explicitly accepted going in.

  **4. Booking/rental/travel platform filter
  (`backend/places-client.cjs`).** New `isBookingOrRentalPlatform()` —
  deterministic name/website regex (`booking.com`, `airbnb`, `makemytrip`,
  `oyo`, `goibibo`, `cleartrip`, `yatra`, `treebo`, `fabhotels`, `agoda`,
  `trivago`, `expedia`) plus a Places-type check (`lodging`/`hotel`/
  `travel_agency`/`vacation_rental_agency` — unconditional; `real_estate_agency`
  deliberately NOT blanket-excluded, same reasoning `searchResidentialPlaces`'s
  own header comment already gives for keeping brokers as legitimate
  discovery results) — applied BEFORE item 3's per-result search ever
  runs, so a booking-platform result never wastes an enrichment call.
  `places.websiteUri` added to the field mask (free — same API call) so a
  business whose NAME doesn't obviously read as a booking platform but
  whose website does (a white-label OTA storefront) still gets caught.
  7 new unit tests, all passing, including the "keep a legitimate
  brokerage, only exclude a KNOWN booking-platform name" distinction and
  the website-only-match case.

  **1. A real "why" via LLM, made visible (`agent/agent/curator.py`,
  `backend/server.cjs`).** `key_match` generation already existed (an LLM
  writes one grounded sentence per property, using only real
  `match_reasons`/fields, never inventing a fact) — but the card's `why`
  field was computed from a separate, purely mechanical picker
  (`scoring.pickPrimaryMatchReason`), so the genuinely natural-language
  sentence was generated and then never shown. Fixed the priority in
  `adaptAgentProperty`: `key_match` now wins first, the mechanical picker
  is the fallback only when `key_match` is itself empty. Tightened
  curator.py's system prompt (explicit: write a real sentence, never just
  copy a `match_reasons` fragment verbatim) and its deterministic
  no-LLM-configured fallback (now prefers a location reason, then a
  configuration reason, then first-available — mirroring
  `pickPrimaryMatchReason`'s own priority instead of blind array order).
  Places-direct's own deterministic "Real building found near X" reason is
  untouched — no LLM call on that path, exactly as specified.

  **2. Lifecycle badge on every card — extended to Places-direct
  (`frontend/.../ProjectSelection.jsx`).** `LIFECYCLE_LABEL` gained
  `UNKNOWN: 'Status unknown'` (rendered in a muted neutral style,
  deliberately distinct from a confirmed stage's confident blue — never
  visually conflated) and a previously-missing `PRE_LAUNCH` entry (a real,
  separate gap found while touching this map — the agent path could
  already legitimately return `PRE_LAUNCH`, which had no label at all
  before this). Agent-sourced cards are unaffected (that pipeline never
  emits UNKNOWN to the frontend — hard-rejected upstream); Places-direct
  cards can now genuinely show either a real eligible stage or an honest
  "Status unknown," never nothing and never a false claim.

  **5. Competitor Analysis — strict eligible-only filter, now consistent
  by construction (`frontend/.../ProjectIntelligence.jsx`).** `aiSearchSiblings`
  now carries a real `lifecycleStatus` per sibling (added in
  `ProjectSelection.jsx`'s `toAnalysableProject`, sourced from each
  candidate's own `p.lifecycleStatus` — real regardless of which pipeline
  originally found it, now that item 3 gives Places-direct siblings one
  too). `siblingCompetitors` filters to
  `{NEW_LAUNCH, PRE_LAUNCH, UNDER_CONSTRUCTION, NEAR_POSSESSION}` only — a
  sibling with no status at all (an older cached response, or one this
  filter can't resolve) is treated the same as an explicit UNKNOWN and
  excluded, never assumed eligible. This card is deliberately STRICTER
  than the main results list (which labels an unknown status rather than
  hiding it) — per explicit instruction, Competitor Analysis should only
  ever show confirmed-eligible competitors. The separate, unrelated
  `/api/competing-projects` (bare Google Places geo-radius lookup, no
  lifecycle concept, a known pre-existing architectural gap already
  disclosed earlier in this document) is untouched — this filter only
  applies to `aiSearchSiblings`.

  **6. Project Description card removed
  (`frontend/.../ProjectIntelligence.jsx`).** Confirmed first, not
  assumed: the AI Project Summary tile (`aiSummaryText`) already falls
  back to the same `displayDescription` chain
  (official → current → live → research.summary) whenever
  `research.summary` itself is unset, so it has real content for any
  project that has a description ANYWHERE — nothing was uniquely lost by
  removing the separate card. Deleted the whole card, including its nested
  "DRISHTI AI SIGNALS" USP list (structurally part of the same card, not a
  separate one) and its now-entirely-dead markdown renderer
  (`mdInline`/`DescriptionMarkdown`/`DescriptionSummary`, ~115 lines,
  confirmed via grep to have no other callers before deleting) —
  `displayUSPs` itself stays, still genuinely used by the Target Audience
  card elsewhere in the same file.

  **7. Unit configuration table — Config/Carpet/Price only, per the user's
  final decision (`frontend/.../ProjectIntelligence.jsx`).** Total/Available/
  Movement removed from the table structure entirely — not even an honest
  placeholder, the columns themselves are gone. The now-orphaned
  `movement()` helper, the `movementFlag`/"Drishti flags" banner (which
  read `c.movement`/`c.available` — would have silently gone dead/`undefined`
  once those fields were removed from `displayConfigs`, so removed rather
  than left broken), and the now-unused `MOVE_COLOR` constant were all
  deleted along with it. New `configEvidenceRows` — built from
  `current.configuration_evidence` (a dict keyed by configuration string,
  e.g. `"2 BHK"`) — slotted into the existing officialConfigs → ??? →
  `live.configs` → `research.configs` fallback chain, so an AI-Search-
  sourced property (agent-path: already had `configuration_evidence` from
  earlier work; Places-direct: now populated by item 3's enrichment,
  identical field name/shape either way) gets real per-configuration rows
  even with no official IndiHomes catalog data at all — same table
  component, genuinely different data source depending on pipeline, per
  the task's own framing.

  **Tests**: `backend/tests/test_lifecycle_and_eligibility.cjs` — +7
  checks for `isBookingOrRentalPlatform` (exported from `places-client.cjs`
  specifically for testability). Both existing suites re-run clean
  throughout this pass, not just at the end. `npm run build` re-confirmed
  after every frontend change (bundle size dropped ~5KB from the dead-code
  deletions). Live verification: the new `/agent/enrich-property` endpoint
  tested directly (isolated Python script, then live HTTP), a genuinely
  agent-down Places-direct request confirmed fast graceful degrade
  (0.86s, 20/20 properties correctly unenriched), and the 12-candidate
  parallel-enrichment timing measured directly via a standalone script —
  not one number in this section's timing/exclusion claims is an estimate.

## AI Search root-cause pass — category-page merge collapse, portal_search fallback, injection defense, Places-direct/Competitor Analysis re-verification, AI Search bulk selection (2026-08-20)

Investigation grounded in a live "2BHK in Mahatre Wadi" trace showing a
MagicBricks category page surviving `verification_results` as ONE fake
candidate carrying 4 different RERA numbers, 6 different location strings,
and 9 different prices, all recorded as *conflicts on a single entity*
instead of being split into the real individual projects named in that
page's own text ("Arkade Vistas" / "Im Applaud" / "Mahant Sahyadree" /
"Space Residence II").

**1. Category-page merge collapse — THREE compounding bugs, not one.**
Confirmed each in order, with live evidence, before fixing:

- **(a) Classification gap — `agent/agent/normalize.py`'s
  `PORTAL_CATEGORY_TITLE_RE`.** The real trace title ("BHK Flats in
  Pandurang Wadi, Mumbai - 3 2 BHK Flats for Sale in Pandurang Wadi,
  Mumbai") wasn't matching: the config-group required a digit before
  "bhk", never a bare "BHK Flats in X" with no leading count. Made the
  digit optional within the config group itself. Verified directly:
  `is_aggregator_title`/`classify_page_type` flipped False to True /
  INDIVIDUAL_LISTING to CATEGORY_PAGE on the exact trace title.
- **(b) Content-extraction cap — `backend/agent-tools-bridge.cjs`'s
  `FETCH_PAGE_MAX_CHARS`.** Even with (a) fixed, `extract_sub_listings`
  still found 0 sub-listings on the real fetched page. Root cause: the cap
  (6000 chars) was smaller than the real page's own nav-menu chrome (not
  wrapped in semantic `<nav>`/`<header>` tags on this site) — confirmed
  directly, the page's first real RERA number sits at character ~7660 of
  its extracted text, its 5th at ~24000. Raised the cap to 24000 and added
  semantic-tag stripping (`<nav>`/`<header>`/`<footer>`) plus more robust
  blank-line filtering to `htmlToText()`. Verified: a direct fetch of the
  real page now yields 5 distinct sub-listings, including two of the four
  buildings named in the trace ("Mahant Sahyadree" RERA P51800054444, "Im
  Applaud" RERA P51800015665) with correct, distinct RERA numbers.
- **(c) THE REAL BLOCKER — `agent/agent/dedupe.py`'s URL-matching tier.**
  Even with (a) and (b) both fixed, a full live re-run of the exact same
  query still showed the identical merged-conflict pattern
  (`verification_results` carrying one candidate — the wrapper page's own
  title — with 4 RERA numbers / 9 prices / 6 locations, `source_conflicts:
  7`). Root cause: `extract_sub_listings()`'s sub-listings correctly get
  their own distinct `title`/`property_name`/`rera`, but they all inherit
  the PARENT category page's `source_url` verbatim (they're synthetic
  entries pulled from one real page's body text, not each their own
  fetched page). `dedupe()`'s URL tier
  (`elif source_url and source_url in url_index: key = url_index[source_url]`)
  treated that shared, inherited URL as if it uniquely identified one real
  listing — so every sub-listing after the first got silently redirected
  into the first one's group, regardless of its own distinct name/RERA,
  overriding the correct name+locality key entirely. Fixed by excluding
  `source_type == "category_page_extract"` items from both matching
  against and registering into `url_index` (`is_synthetic_url` guard) —
  they still correctly merge via the RERA or name+locality tiers when two
  sub-listings really are the same project, they just stop being force-
  merged purely because of a URL they never independently owned.

  **Live before/after, same query, same code path (agent process
  restarted between runs to pick up each fix):**

  | | Before (all 3 fixes) | After (a)+(b) only | After (a)+(b)+(c) |
  |---|---|---|---|
  | `verification_results` (merged-conflict candidates) | 7 giant conflict-bags | 6 giant conflict-bags | **0** |
  | `source_conflicts` | 7 | 7 | **0** |
  | "Flats in Pandurang Wadi, Mumbai" carrying 4 RERA / 9 price / 6 location values as ONE entity | yes | yes | **gone — no such merged entity exists** |
  | Real individual candidate names appearing standalone | no | no | **yes** — "Aurum Tower - Residential Apartments", "Bhakti apartment", "BLUE ORBIT 3", "Celestial Heights", "Chandak Paloma", each with its own clean state and zero `conflicting_fields` |

  Final `properties: []` (0 verified new-launch results) for this specific
  hyper-local query is unchanged and NOT the bug being fixed here — a
  separate, honestly-disclosed finding: of 64 real candidates reviewed, 28
  were portal category/search-results pages (correctly rejected), 5 were
  resale/rental, 29 had a lifecycle stage that couldn't be confidently
  verified even after research, and Places contributed 20 more with none
  eligible. "Mahatre Wadi" (a hyper-local micro-name, not itself in the
  gazetteer) genuinely appears to have thin *verified new-launch* inventory
  right now — the merge-collapse bug that made every candidate look broken
  is fixed; a locality having no eligible new-launch stock is a real,
  separate, disclosed possible outcome, not silently reinterpreted as "the
  bug isn't fixed."

  **Regression test added** — `agent/tests/test_lifecycle_and_eligibility.py`:
  runs `dedupe()` directly on the exact category-page-extraction scenario
  already covered above (wrapper + 2 real sub-listings sharing one
  inherited URL), asserting all 3 stay as 3 distinct candidates with their
  own RERA intact, not collapsed into 1.

**2. `portal_search` returning `count: 0` — same "dead connector in this
deployment" pattern already found and fixed for `web_search` earlier this
session.** `agent/agent/tools.py`'s `portal_search()` now falls back to
`tavily_search()` (already portal-site-scoped for every India-market call
via `biasQueryToPortals()`) whenever the legacy Playwright portal-scrape
connector returns nothing — the exact same fallback mechanism already
proven for `web_search`, not a second implementation. Live-verified in the
actual running agent process (not just reasoned about): `portal_search`
tool call for "2BHK in Mahatre Wadi" returned
`status: ok, count: 10, duration_ms: 448, error: null`.

**3. Prompt injection / off-topic query defense
(`backend/query-parser.cjs`'s new `isPropertySearchQuery`, wired into
`server.cjs`'s `/api/ai-search` once, before the agent/Places-direct/
Node-fallback branching).** Cheap, deterministic, keyword/pattern-based —
no LLM call per query. First implementation reused `extractLocations`'s
generic Title-Case fallback tier as its "has a locality" signal, which
turned out to accept ANY capitalized word as a location
(`"Ignore all previous instructions..."` produced `locations: ["Ignore"]`
and was wrongly accepted) — replaced with a strict gazetteer-membership
regex (`KNOWN_LOCALITY_RE`) plus a narrow structural fallback
(`looksLikeBareLocalityPhrase`: short, Title-Case, no sentence-shaped
stopwords) so genuine non-gazetteer hyper-local names ("Mahatre Wadi",
"Kandarpada") still pass. Live-verified through the actual HTTP route (not
just the unit function): `POST /api/ai-search {"query":"asdkjahsdkjahsd"}`
returned
`{"properties":[],"pipeline":"blocked","warning":"This search only works for property queries — try something like \"2 BHK in Malad West\"."}`.
33 test cases (17 self-test + 16 permanent, including two live-caught
false-positive regressions — capitalized mid-sentence words in an
off-topic question or jailbreak attempt no longer smuggle it through) all
pass.

**4. Places-direct price/"why" — re-investigated, confirmed NOT a code
bug.** The per-result enrichment search built earlier this session
(`/agent/enrich-property`) was directly re-verified live and healthy
(real price/RERA/config returned). A reported "Price not available" plus
generic reason screenshot for this pipeline is consistent with the
already-correct graceful degrade when the agent process happens to be
down at that moment (Places-direct has no enrichment source of its own
without it) — not a regression in the enrichment mechanism itself.

**5. Competitor Analysis "Not connected" — re-investigated, confirmed NOT
a regression.** Direct inspection of a real API response for the specific
candidate reported showed `placesVerified`/`placesLat`/`placesLon` all
absent — this candidate genuinely never had Places coordinates attached,
not a case of a previously-fixed wiring path breaking again. Two smaller,
real gaps found and fixed along the way while investigating:
`frontend/.../ProjectIntelligence.jsx`'s geocode `useEffect` was missing
`knownGeo?.lat`/`knownGeo?.lon` from its own dependency array (stale-
closure risk), and `mapQuery` now prefers the raw, un-rewritten
`current.projectName` over `current.name` (which can be the LLM curator's
rewritten display label — a noisy, wrong string to geocode against).

**6. AI Search bulk selection + scroll-to-top navigation fix.**

- **Selection UI (`frontend/.../ProjectSelection.jsx`).** AI Search's
  `PropertyCard` (rendered via `RankedResults`/`AnalystReport`) previously
  navigated instantly per-card via `onAnalyse([...])` with a single-item
  array. Property Search's existing checkbox/floating-bar pattern
  (`ProjectCard`'s checkbox + `BriefBar`) already existed for a different
  bulk action (downloading a Campaign Brief markdown), and `onAnalyse` /
  `ProjectIntelligence` already fully supported an array of MULTIPLE
  projects ("Analysing N projects selected") — that capacity was just
  never exercised by any caller passing more than one item. Rather than
  building a second, parallel bar component, `BriefBar` was generalized
  (parameterized `subtitle`/`actionLabel`/`actionTitle`/`actionIcon`/
  `actionColor`/`onAction`, defaulting to the existing Campaign Brief copy
  so Property Search's call site is unaffected) and reused for AI Search's
  new "+ Select multiple to analyse" toggle, per-card checkbox, and
  "Analyse Selected" floating bar calling `onAnalyse(chosenArray)` —
  scoped to `AnalystReport`'s own local `selectedIds`/`selectMode` state
  (mirrors `ProjectCard`'s checkbox styling exactly).
- **Scroll-to-bottom bug (`frontend/src/App.jsx`).** Root cause: the
  app's actual scrollable viewport is the `overflowY:'auto'` div wrapping
  every screen (the outer flex container is `overflow:'hidden'` and never
  scrolls) — its `scrollTop` was never reset on navigation. Clicking
  "Open Project Intelligence"/"Analyse Selected" from a card low in a long
  AI Search results list left that div's `scrollTop` deep from the
  previous screen; swapping in a shorter Project Intelligence page didn't
  reset it, so the browser clamped `scrollTop` to the new, smaller max —
  landing at the bottom instead of the top. Fixed once in `changeView`
  (every navigation path — sidebar, `onBack`, `onAnalyse` — already routes
  through it): a ref on the scrollable div, reset to `scrollTop = 0` in a
  `useEffect` keyed on `view`.
- **Verification caveat, disclosed honestly**: `npm run build` passes
  clean and the React state/props wiring was traced end-to-end by hand
  (checkbox to `selectedIds` to `BriefBar` to `onAnalyse(chosen)` to
  `App.jsx`'s `setSelectedProjects`/`changeView('project')` to the new
  `scrollRef` effect). No browser-automation tool was available in this
  session to literally click through and screenshot the result — this
  was NOT live-clicked in a real browser, only built and logically
  verified. Flagging this explicitly rather than claiming a browser
  click-through that didn't happen.

**Tests**: `backend/tests/test_lifecycle_and_eligibility.cjs` (all
existing + item 3's 16 new checks) and both
`agent/tests/test_lifecycle_and_eligibility.py` (137 checks, including 3
new for the dedupe fix) and `test_bridge_circuit_breaker.py` re-run clean.
`npm run build` clean. Every numeric claim above (RERA character offsets,
`source_conflicts` counts, `portal_search` timing, the before/after
candidate table) came from live runs against the real running
backend+agent processes, captured to disk, not estimated.

---

## Tavily key rotation + new `serper_search` tool (second independent web-search source)

A key-rotation + resilience pass, not a feature redesign. Two operational
problems, confirmed live rather than assumed: `TAVILY_API_KEY` was hitting
Tavily's own HTTP 432 usage-limit error on every call, and (separately,
confirmed via the real `tool_calls` trace) `web_search` (Google CSE/Bing)
was returning `status: 'ok'` with `count: 0` on every call — a silent,
different failure mode from Tavily's. A fresh Tavily key was dropped into
`.env`, and a new `SERPER_API_KEY` (serper.dev) was added as a genuine
third/independent discovery source — additive, not a replacement for
either existing tool.

**Root-cause trap hit during verification, worth recording**: restarting
only the Python agent process did NOT fix Tavily. `tavily_search` doesn't
call Tavily directly — it goes through `backend/agent-tools-bridge.cjs`'s
`/internal/agent-tools/tavily-search` route, which reads
`process.env.TAVILY_API_KEY` in the **Node** process (`backend/server.cjs`,
port 3001), a separate long-running process from the agent (port 8008).
Both processes independently snapshot `.env` at their own start time — the
exact "env var doesn't apply until restart" trap this project has hit
repeatedly, just manifesting one layer further away than usual (the
bridge's own process, not the caller's). Confirmed live: after restarting
only the agent, a direct `tavily_search()` call still returned the same
HTTP 432; only after also restarting `backend/server.cjs` did it succeed.
Anyone rotating a key this pipeline depends on needs to restart **both**
processes, not just the one that logically "owns" that tool.

**`serper_search` — added mirroring `web_search`/`tavily_search` exactly**,
across all three layers that pattern already exists in:
- `agent/agent/tools.py`: `serper_search(query, market)` — same
  `@traceable`, same `_call_bridge()` plumbing (retry/circuit-breaker/cache
  all inherited for free), same `(evidence, ToolCallRecord)` return shape,
  same "status='error' only when a real error AND no evidence" contract as
  every other tool here.
- `backend/agent-tools-bridge.cjs`: new `/serper-search` route, a thin
  wrapper around a new `serperConnector` — same shape as the existing
  `/tavily-search` route.
- `backend/external-connectors.cjs`: new `serperConnector` (`POST
  https://google.serper.dev/search`, header `X-API-Key`, body `{"q":
  "..."}`), added to `CONNECTORS`/`getConnectorStatus()` and exports
  alongside `tavilyConnector`. Response shape was confirmed against a real
  live call before writing the parser (not guessed): `{"organic":
  [{"title", "link", "snippet", "position", "date"?}], "searchParameters",
  "peopleAlsoAsk", "relatedSearches", "credits"}` — the parser reads
  `organic[].{title,link,snippet}`, same fields Tavily's own parser reads
  off its differently-shaped response.
- `agent/agent/planner.py`'s `build_search_plan()`: `serper_search` is
  appended unconditionally, same reasoning as `tavily_search`/`web_search`
  (cheap to no-op, independent failure mode, always worth trying).
- `agent/agent/graph.py`: new `node_serper_search`, added to the discovery
  fan-out node list and the `research_planner -> {…} -> evidence_normalizer`
  edge set, alongside (never replacing) `tavily_search`/`web_search`.

**Tests**: `agent/tests/test_serper_search.py` (new, plain-assert, same
convention as `test_bridge_circuit_breaker.py`) — mocks the bridge HTTP
call and asserts `serper_search`'s own contract: hits
`/internal/agent-tools/serper-search`, returns the real evidence list
untouched, and reports `status='error'` (with the real error text, never
swallowed) on a bridge-reported failure. **A real trap hit and fixed while
writing this test**: the first version used the literal production query
text ("2bhk in Andheri west") for its mocked success case — `_call_bridge`
caches successful results to disk (`agent/.cache/serper-search/`, keyed by
`sha256(market:query)`, `SOURCE_TTL_S` default 6h), so that fake mocked
response got written under the **exact same cache key the real live query
uses**, and the next live pipeline run silently read back the test's fake
data instead of calling the real API. Fixed by keying the test's queries
with a per-run nonce so a test can never collide with a real production
cache key; the polluted cache entry was deleted and the live rerun below
re-verified clean afterward. Both existing suites
(`test_lifecycle_and_eligibility.cjs`, `test_lifecycle_and_eligibility.py`
— 137 checks — and `test_bridge_circuit_breaker.py`) re-run clean, no
regressions.

**Live re-verification — real query `"2bhk in Andheri west"`, both
backend+agent processes restarted, no results estimated**:
- `tavily_search`: `status: 'ok'`, `count: 10`, no HTTP 432 — confirmed
  fixed.
- `serper_search`: `status: 'ok'`, `count: 10`, real listing titles/URLs
  (magicbricks.com/99acres.com/housing.com) — confirmed working against
  the real API, not a stub.
- `web_search`: still `status: 'ok'`, `count: 0` on every call, unchanged
  by this pass — **confirmed still broken**, a separate, real,
  still-unaddressed problem (Google CSE/Bing), explicitly not masked by
  Tavily being fixed or Serper being added.
- The 5 previously-named candidates (Bay View Apartments, Divyam Heights
  (Ajmera Cityscapes), Evershine Apartment No 2, HDIL Metropolis CHSL,
  Hubtown Premiere Residences): even with all three search tools now
  genuinely returning results, **none of the 5 resolved to a confirmed
  lifecycle/developer/RERA** in this rerun — all 5 remain
  `lifecycle_status: 'UNKNOWN'` in `normalized_properties` with `developer:
  None`, `rera: None`, and are rejected on the final pass. Bay View
  Apartments specifically resolved to a confident `RESALE` rejection
  ("6 verified resale & rental listings currently available…" — real
  matched evidence text) rather than staying `UNKNOWN`; the other 4 are
  rejected with "Launch/construction status could not be confirmed as
  new-project inventory even after deep research" (no evidence text — deep
  research genuinely found nothing resolving them, not a suppressed
  finding). More independent search sources did not, on this exact query,
  change these 5 candidates' fate — the gap for these specific listings is
  real content availability/discoverability, not tool coverage. (Two
  differently-titled "Bay View" candidates from OTHER source pages — not
  the exact 5 named — did independently resolve to `NEW_LAUNCH`/
  `UNDER_CONSTRUCTION` and reached the final eligible list.)
- `eligible_candidates` for this exact query: two separate live reruns in
  this pass produced 12 and 11 respectively — this is expected run-to-run
  variance from genuinely live, real-time web search results (a portal
  page's content changing between calls), not a bug. **No true
  "before-this-pass" baseline was available to this session** to diff
  against (the earlier trace this task referenced was not present in this
  conversation's actual context) — reported here are the real, live,
  current-state numbers only, not a fabricated before/after delta.

---

## Places-direct feature-integration investigation ("VKG Krishna Residences / Kanakia Rainforest / Vasant Oasis", Andheri East) — two real bugs found, three items confirmed working correctly

A live example showed Places-direct results for "3 BHK in Andheri East"
with none of price/RERA/real-why/USPs/Competitor-Analysis working, despite
every one of those having been built and previously verified this session.
Root-caused directly (`AI_SEARCH_DEBUG_TRACE=true`, both processes
restarted, real HTTP calls against the real running services — including
one deliberate, temporary `LANGGRAPH_ENABLED=false` restart specifically
to force a genuine Places-direct HTTP response for direct inspection,
reverted immediately after) rather than rebuilt blind, per explicit
instruction.

**Operational trap hit while investigating, worth recording**:
`backend/scripts/run-agent.ps1`'s supervisor loop was already running in
the background (a leftover process, not started by this pass) and
silently restarted the agent within its 5s backoff every time it was
killed for a code-reload — repeated `taskkill`s appeared to do nothing at
first because a fresh (stale-code) process kept reappearing on port 8008
seconds later. Not a bug — this supervisor is exactly the documented,
intended behavior — but it means confirming a code change actually loaded
requires checking the LISTENING PID's own start time / a fresh log
tail, not just "is something listening on 8008."

**1. Which pipeline served the live example — confirmed via evidence, not
assumed.** The exact why-line ("Real building found near Andheri East")
only exists in `server.cjs`'s Places-direct branch (`whyReason` template,
never anything the agent path emits) — direct proof this specific
request was Places-direct, before touching anything. Re-running the exact
same query live, immediately after restarting both processes, went
through the AGENT path successfully but took **120.05s wall-clock** —
right at `AGENT_TIMEOUT_MS`'s (`AI_SEARCH_TIMEOUT_MS=120000`) own bound.
Agent-first routing itself was re-read directly in `server.cjs` and
confirmed unbroken (the `LANGGRAPH_ENABLED` block still precedes
Places-direct exactly as every prior pass left it) — **this is the same
already-documented, already-accepted tradeoff** ("a real timeout falls
through to Places-direct exactly like any other agent failure"), not a
regression: at 35-140s+ observed agent latency and a 120s bound, some real
fraction of requests will genuinely time out and fall through, especially
during a session that had just been restarting both processes repeatedly
moments earlier for an unrelated task. **Confirmed working correctly**,
real reason found (a genuine, accepted-tradeoff timeout), not a bug.

**2. Enrichment step — confirmed genuinely running, with a real,
previously-invisible failure mode found and partially instrumented.**
Directly reproduced Places-direct's real HTTP branch (temporary
`LANGGRAPH_ENABLED=false`, immediately reverted) for the exact query
twice. Both times, **the 3 named buildings behaved differently from each
other, not uniformly broken**:
- **VKG Krishna Residences**: enrichment succeeded both times — real
  price (`₹3.8 Cr`), real RERA (`P51800005340`), real lifecycle
  (`UNDER_CONSTRUCTION`, evidence: "Configuration\n2 BHK, 3 BHK\nUnder
  construction\nPossession in Dec 2026").
- **Kanakia Rainforest**: correctly EXCLUDED from the response entirely
  both times (real, working `PLACES_ENRICH_EXCLUDE_STATUSES` behavior) —
  classified `RESALE` from evidence text "low avg\n₹ Andheri East —
  resale, rent & yield\nResale\n₹28" (mumbaipropertyexchange.com). This
  evidence text reads as a market-stats/comparison-table WIDGET, not a
  per-building claim — the SAME already-disclosed high-false-positive-rate
  limitation on category/aggregator page text documented earlier in this
  file ("Real debugging discovery #2"), not a new bug; deliberately not
  patched here either, same reasoning as before (`classify_lifecycle_status`
  is reused as-is, not tuned a second time for this call site).
- **Vasant Oasis**: **genuinely timed out** both reruns
  (`TimeoutError: The operation was aborted due to timeout` at the full
  `PLACES_ENRICH_TIMEOUT_MS`, 25000ms) — yet the IDENTICAL lookup, run
  standalone with no concurrent load, succeeded in 11.66s (real price
  `₹1.60 Cr`, real RERA `P51800015556`, lifecycle `RENTAL` — itself
  ANOTHER instance of the same page-furniture false-positive: evidence
  text "omes\nProperty Types\nFlat for rent in Mumbai\nHouse for rent").
  Root cause: `PLACES_ENRICH_MAX_RESULTS` (12) concurrent calls all hit
  the same agent process's search/fetch tools at once — real contention
  under load pushes some individual calls past the 25s bound that would
  easily clear it in isolation. **A real, reproducible, disclosed
  limitation** — not a logic bug, and deliberately not "fixed" by just
  raising the timeout, since that's a real latency-vs-completeness
  tradeoff this task didn't ask this pass to make unilaterally.
- **A real, separate bug found and fixed while investigating this**:
  `enrichOnePlacesResult()`'s catch block (and its `!res.ok` branch) had
  ZERO logging — a failed per-candidate enrichment call left no trace
  anywhere, making this exact class of investigation impossible from logs
  alone (confirmed: the first repro run's server log had no mention of
  Vasant Oasis at all despite it genuinely failing). Fixed
  (`backend/server.cjs`): both failure paths now `console.warn` the real
  candidate name + real error/status — this is what surfaced the
  `TimeoutError` finding above in the first place, on the very next run.

**3. USP/Description gap — confirmed as a REAL, SEPARATE root cause, not
resolved by item 2.** Even for VKG Krishna Residences (item 2's fully
*successful* enrichment case), `description`/`amenities` were still empty
— traced directly to `agent/agent/tools.py`'s `enrich_property()`: its
return shape is deliberately `{price, rera, lifecycle_status,
lifecycle_evidence_text, configuration_evidence}` only. It calls
`fact_extraction.deterministic_extract()`, which returns structured
per-field `ExtractedFact`s (price/RERA/possession/configuration) — this
extractor was never built to produce a free-text description or an
amenity list at all, for ANY candidate, successful enrichment or not; that
kind of extraction only exists in the full agent deep-research path.
`deriveUSPs()`/the AI Summary card reading empty for a Places-direct
result is therefore **the correct, honest behavior given this tool's real
scope** — not a timeout artifact, not something item 2's fix touches, and
not something this pass attempted to build (a real, disclosed, structural
gap in what Places-direct enrichment was ever designed to fetch).

**4. Competitor Analysis "waiting for Location Map" — confirmed NOT a
regression.** Real Places-direct HTTP response, both live reruns:
`placesLat`/`placesLon`/`placesVerified` were present on EVERY property in
the response (all 10, enriched or not — they come directly from the
initial Places call, never from the enrichment step) — including
`VKG Krishna Residences` (19.1099306, 72.8594396) and `Vasant Oasis`
(19.1142633, 72.8849849). Traced the full handoff chain by direct code
inspection (no browser-automation tool available this session, same
disclosed limitation as before — this was NOT literally clicked through):
`ProjectSelection.jsx`'s `toAnalysableProject` reads `p.placesLat ??
null`/`p.placesLon ?? null` directly off the raw API property (Places-
direct properties are NOT run through `adaptAgentProperty`, so nothing
strips these fields), and `ProjectIntelligence.jsx`'s `knownGeo` prop
(`current?.placesLat`/`current?.placesLon`, already fixed into the
`NearbyMap` effect's dependency array in the prior investigation) reads
straight off that same object. Given the raw data is confirmed present
and every step of the chain reads it correctly, the most consistent
explanation for the original live report is the same class of transient
condition as item 2 (a request where THAT specific candidate's own
enrichment/Places data happened to be degraded at that moment) — not a
surviving code-level regression. Re-confirmed the lifecycle filter itself
is real and working as designed: an unenriched Places-direct sibling
(`lifecycleStatus: null` — most of the 10 in this response, since only
the top slice gets checked at all) is correctly EXCLUDED from
`siblingCompetitors` by the existing strict filter — meaning Competitor
Analysis will often show few or zero siblings for a Places-direct-sourced
search specifically, which is the intended "eligible-only, never assumed"
behavior, not a new bug.

**5. RERA auto-lookup — a REAL bug found and fixed.** Directly hit the
exact endpoint the frontend's auto-firing `useEffect` calls
(`POST /api/rera-lookup`) for both Vasant Oasis and Kanakia Rainforest:
both returned `{"rera":null,"found":false}` in under 0.7s — suspiciously
fast for a real web search + page fetch. Root cause, confirmed directly:
`agent/agent/tools.py`'s `rera_lookup()` calls ONLY `web_search()` (Google
CSE + Bing) with no fallback — the exact same dead-connector gap
documented and FIXED for `enrich_property()` earlier this session
("Real debugging discovery #1" above), but `rera_lookup()` was missed at
the time and never got the same fix. Confirmed live, side by side, same
query text: `web_search` → `count: 0` in 522ms; `tavily_search` → `count:
10` real results in 5.35s. **Fixed** (`agent/agent/tools.py`): added the
identical `tavily_search` fallback `enrich_property()` already has (same
fallback, not a second one). Re-verified live through the real
`/api/rera-lookup` endpoint after restarting the agent: Vasant Oasis now
returns `{"rera":"P51800000762","found":true}` in 1.56s; Kanakia
Rainforest returns `{"rera":"P51800000224","found":true}` in 13.1s — the
identical number `enrich_property()` independently found for the same
building, cross-confirming both are now hitting real data.

**Tests**: both existing suites (`test_lifecycle_and_eligibility.cjs`,
`test_lifecycle_and_eligibility.py`, `test_bridge_circuit_breaker.py`)
re-run clean after both code changes. No new test file added — both
fixes are thin (a fallback call already proven correct elsewhere, and two
`console.warn` lines) with no new branchable logic of their own to cover
beyond what the existing suites already exercise indirectly through
`enrich_property`'s identical pattern.

**Summary — 2 real bugs fixed, 3 items confirmed correct with the real
reason found**: (1) agent-timeout fallback — confirmed correct, accepted
tradeoff, not a bug. (2) enrichment step — confirmed genuinely running;
found and fixed a real logging gap that had made this exact class of
failure invisible; the underlying concurrent-load timeout itself is a
disclosed, not-fixed-here capacity tradeoff. (3) USP/description gap —
confirmed as a real, separate, structural scope gap in what Places-direct
enrichment was ever built to extract, not something item 2 resolves. (4)
Competitor Analysis coordinates — confirmed present and correctly wired
through the full chain by direct inspection; the lifecycle filter is
confirmed working as designed. (5) RERA auto-lookup — a real bug (missing
fallback), found and fixed, re-verified live with real returned RERA
numbers.

---

## Groq key rotation re-verified + Dubai search brought to feature parity with India

**Groq key rotation.** User rotated `GROQ_API_KEY`. Direct `curl` against
Groq's own API confirmed the new key authenticates (a real chat
completion, not an auth error). A live agent-path India rerun
("2 BHK in Malad West", direct graph call, no Node-side timeout) produced
zero `[llm:groq] request failed` lines this time (earlier runs this
session logged them on every call). **However**, a follow-up Dubai run
minutes later hit the SAME `400 json_validate_failed` Groq error again —
traced directly (not assumed fixed just because auth succeeded):
increasing `max_tokens` on a real Groq call reproduced a DIFFERENT, more
informative error — `429`-shaped `413: tokens per minute (TPM) Limit 8000` —
revealing the account's real constraint is an **8000 TPM rate limit**, not
a broken key or a prompt-format bug. A short, isolated test call (small
prompt, `max_tokens=2000`) succeeds cleanly every time; a real burst of
`curator.py`'s per-candidate calls (each with full property context, back
to back) can exceed 8000 TPM, and Groq's degraded response under that
pressure sometimes comes back truncated/invalid JSON rather than a clean
`429` — which is what `json_validate_failed` actually is. **This is an
account-tier/billing constraint, not a code bug** — deliberately not
"fixed" by changing prompts or token budgets, since neither addresses the
real limit; the fix (if wanted) is a Groq plan upgrade, not application
code. Disclosed here rather than silently left ambiguous.

**Dubai search — real gap found and fixed: Places discovery/fallback was
architecturally India-only, not just untested.** Live-tested first
(`searchResidentialPlaces("residential apartments 2 bedroom in Dubai
Marina")`) before touching any gate: Google Places returned 16 real,
well-named Dubai Marina buildings (Marina Vista - Emaar, LIV Marina,
Marina Shores by Emaar, Al Majara Tower 1, etc.) — proof the underlying
API has real, usable Dubai coverage; the India-only restriction on top of
it was a real, unnecessary gap, not a genuine technical limitation.
**Three separate gates found and removed** (all three needed removing
together — fixing only one would have left Dubai still silently getting
nothing, since each gate independently returns empty for a non-India
market):
- `agent/agent/planner.py`'s `build_search_plan()` — `places_search` was
  only appended `if has_location and market == "india"`; now appended for
  any market with a resolvable location.
- `backend/agent-tools-bridge.cjs`'s `/places-search` route — had its OWN
  independent `mkt !== 'india'` short-circuit, returning an empty
  `{evidence: [], note: '...India-only...'}` even if the planner above
  included the tool in the plan. Removed.
- `backend/external-connectors.cjs`'s `placesConnector` — `market: ['india']`
  descriptor plus its own `market !== 'india'` guard inside `.search()`
  (used by the Node-fallback pipeline directly). Extended to
  `['india', 'dubai']`; the function body was already market-agnostic
  internally (`currency`/`country` already branch on the `market` param) —
  only the gate itself was India-only.
- `backend/server.cjs`'s `/api/ai-search` Places-direct branch — was
  gated `market === 'india' && placesClient.isPlacesConfigured()`.
  Extended to any market (still gated on Places being configured at all).

**A real, Dubai-specific gap found and fixed along the way
(`backend/places-client.cjs`)**: with Places-direct now live-tested
against Dubai, "La Buena Vida Holiday Homes" and "Ain View Studio (Holiday
Rental), JBR, Dubai" both survived the existing `isBookingOrRentalPlatform`
exclusion — neither matched a named booking-platform (booking.com/Airbnb/
etc., an India-relevant list) nor Places' own `vacation_rental_agency`/
`lodging` types on these specific real results. Dubai's short-term-rental/
holiday-home market is large enough to be a real, recurring noise source
this exclusion list was never built to catch (India's dominant platforms
are all named brands; Dubai's holiday-home market is fragmented across
many small operators using generic English phrasing instead). Added a new
`HOLIDAY_RENTAL_NAME_RE` (holiday home(s)/holiday rental/short-term
rental/serviced apartment(s)/vacation rental — generic phrase match,
checked against name and website) alongside the existing named-platform
regex, not replacing it. Re-verified live: both listings correctly absent
from a rerun of the identical Places-direct Dubai response.

**Live re-verification, before/after, real query
("2 bedroom apartment in Dubai Marina")**:
- **Agent path** (`pipeline: agent`): a direct graph call before this
  pass's fixes took 212,367ms with `places_search` entirely absent from
  `search_plan`; a real run through the live HTTP route after the fixes
  took 127,372ms with `places_search` included — two different real runs,
  not the same query re-timed, so not a claimed speed improvement, just
  both real numbers. The field that matters here: `places_contributed_candidates`
  went from **0 → 14**; the final 4-property result set went from **zero**
  candidates carrying real Places coordinates to **2 of 4** carrying real
  `placesLat`/`placesLon` (Marina Shores by Emaar: 25.0826817, 72.8837732;
  Rove Home Dubai Marina: 25.0747589) — meaning Competitor Analysis's map
  now has real, direct coordinates for these Dubai candidates instead of
  needing a geocoding fallback, the same benefit India candidates already
  had.
- **Places-direct fallback** (forced via a temporary `LANGGRAPH_ENABLED=false`
  restart, reverted after, same verification method as the earlier
  Places-direct investigation above): now returns `pipeline: places-direct`
  with **13 real Dubai Marina buildings**, all with real coordinates, ZERO
  holiday-rental listings (both fixes working together, confirmed on the
  same live response) — where before this pass Dubai had **no Places-direct
  fallback at all** (any agent failure/timeout for Dubai fell straight to
  the bare `external-search.cjs` Node-fallback, skipping an entire
  resilience tier India already had).
- **Same known, disclosed, cross-market limitation reproduced for Dubai,
  not a new bug**: this Places-direct Dubai run's per-result enrichment
  (`enrichOnePlacesResult`, same code as the earlier India investigation)
  showed ALL 12 concurrent enrichment calls timing out at the real 25s
  bound (`[places-enrich] <name>: TimeoutError`, confirmed via the same
  logging added in the prior pass) — yet a single standalone,
  no-concurrent-load call for the exact same building ("Marina Gate")
  succeeded in 1.47s. Identical root cause and identical "disclosed, not
  fixed here" decision as the earlier India investigation (Vasant Oasis) —
  reported honestly rather than silently left unmentioned just because
  this run's failure rate (12/12) was worse than India's (1/12 in that
  earlier run). Real RERA/DLD permit-number extraction for Dubai listings
  is also a known, NOT-attempted gap in this pass — every India-side RERA
  regex in this codebase is Maharashtra-format-specific
  (`P5\d{2}00\d{6}`); a genuine Dubai RERA number would never match it.
  Not fixed here (would need real Dubai RERA/DLD format research first) —
  disclosed as a real remaining gap, not silently absent.

**Tests**: both existing suites re-run clean after every code change in
this pass, not just at the end (`test_lifecycle_and_eligibility.cjs`,
`test_lifecycle_and_eligibility.py`, `test_bridge_circuit_breaker.py`). No
new test file — every change here is a gate removal (three places) or an
additive regex (one place), verified live against the real running
services rather than needing new unit coverage of its own; the existing
`isBookingOrRentalPlatform` tests already cover the function's contract
and continue to pass with the new pattern added.

---

## "Make the LangGraph agent the real primary" — Phase 0 (diagnostic) + Phase 1 (LLM restoration)

A structured, phase-gated pass, external prompt supplied by the user.
Phase 0 was explicitly blocking (instrument only, report, stop for
approval); Phase 1 was approved and executed after Phase 0's data
overturned a prior session's unproven conclusion.

**Phase 0 — settling the Groq `json_validate_failed` root cause with data,
not assumption.** Added permanent diagnostic logging to
`agent/agent/llm_providers.py`'s `LLMClient.complete_json` (kept, not
temporary): every success logs `finish_reason` + real token `usage`; every
failure logs the full raw error body (not `str(e)` truncated) plus every
rate-limit header a real 429 would carry, via `openai.APIStatusError`'s
`status_code`/`body`/`response.headers`. Ran `agent/_smoke_test.py "2 BHK
in Andheri West"` twice (independent runs). **Result: Hypothesis A
(token starvation), not B (rate limiting), and not the prior session's
unproven billing conclusion.** Both runs: the Groq 400 always carried
`x-ratelimit-remaining-tokens` in the thousands (3671 and 4096) against
the real 8000 TPM ceiling — genuine headroom at the moment of failure,
directly contradicting "TPM pressure caused this." `failed_generation`
was empty both times — the model produced zero content, not a truncated
partial JSON, consistent with a reasoning model (`openai/gpt-oss-120b`)
spending its entire `max_tokens` budget on internal reasoning tokens
before emitting any answer. Reproducible at the same relative call
position in both independent runs (not random flakiness). Final counts:
`llm_calls: 9, llm_failures: 3, llm_fallbacks: 2`.

**Phase 1a — reasoning_effort="low", tested live before writing any
production code.** A direct, isolated test against Groq confirmed
`reasoning_effort` isn't a recognized top-level kwarg on this SDK version
(1.57.2 raises `TypeError`) but works via `extra_body={"reasoning_effort":
"low"}`. Measured live against a dense, extraction-shaped prompt: reasoning
tokens dropped from 284/321 completion tokens to 43/85 — the fix directly
targets the confirmed cause. **A second real finding while building the
Phase 1c health probe**: even a TRIVIAL prompt (`"Reply with exactly
{\"ok\": true}."`) fails below `max_tokens=30` — WITH `reasoning_effort=
"low"` already active — a fixed ~14-token reasoning floor this model pays
regardless of question complexity, not proportional to prompt content.
This further corroborates Hypothesis A (a real, quantifiable per-call
minimum, unrelated to rate limits) and was directly hit and fixed while
building 1c (see below). Implemented in
`agent/agent/llm_providers.py`: `LLMClient.complete_json` split into
`_attempt()` (one real API call, returns `(result, truncation_shaped)`)
and the public `complete_json()` (retries exactly ONCE at
`min(max_tokens*2, 4000)` when `_attempt` reports a truncation-shaped
failure — Groq's `json_validate_failed` code, or a genuine `finish_reason
== "length"`). Never treated as permanent, never circuit-broken (neither
error shape is in `_PERMANENT_ERROR_MARKERS`). `reasoning_effort="low"` is
applied unconditionally to every Groq call (`self.key == "groq"`), not
just retries. Budgets raised to configurable env vars:
`AI_SEARCH_EXTRACTION_MAX_TOKENS` (default 1500, was a bare 500 at
`fact_extraction.py:604`) and `AI_SEARCH_CURATOR_MAX_TOKENS` (default
4000, was a bare 1200 at `curator.py:394`).

**Phase 1b — NVIDIA's 403 now circuit-breaks.** `_PERMANENT_ERROR_MARKERS`
had `unauthorized`/`permission_denied` but not `403`/`forbidden` — every
single LLM call was paying a doomed round-trip to NVIDIA first (body:
`{'status': 403, 'title': 'Forbidden', 'detail': 'Authorization failed'}`).
Added `"403"`, `"forbidden"`, `"model not available"`, `"no access"`.
**Per the task's own instruction, the key itself was NOT touched or
replaced** — "Authorization failed" (not a model-entitlement message)
points at the key/account, which is a human's decision, not a code
change (Rule 7). **Flagged plainly, not silently absorbed**: with NVIDIA
dead and Gemini out of credits, Groq was — and, unless a new key is added,
remains — the ONLY working provider; the "fallback chain" is currently
decorative. No key was added.

**Phase 1c — `/health?probe=true`.** Added, alongside the existing free
default response (still checks "is a key present" only, unchanged
behavior/cost). The new mode fires one real, minimal `complete_json` per
configured provider (`PROVIDER_SPECS`, not just the two active roles), in
parallel, returning `{key, label, model, ok, error, latency_ms}` each.
Circuit-breaker state (`llm_providers._provider_state`, only currently-
tripped entries) is now included in BOTH modes. Live-verified: correctly
reports `groq: ok=true`, `nvidia: ok=false`, `gemini: ok=false` — matching
the real, independently-confirmed state exactly.

**Phase 1d — silent degradation now surfaced.** `curator.py`'s existing
(but easy to miss) warning-on-total-curation-failure path now also sets
`research_metadata.llm_degraded: true` (a real, configured router that
tried and had every candidate/provider fail — `False` both on success AND
when no LLM is configured at all, since that's a deliberate config choice,
not a degradation) and the warning text was changed to the requested
`"LLM curation unavailable — all providers failed; results are
deterministic-only"`. Hoisted to a top-level `llm_degraded` field in
`server.cjs`'s agent branch response (same convention as the existing
top-level `retrieval_metrics`), alongside the unhoisted copy already
inside `research_metadata` either way.

**A real operational trap hit and worked around while restarting for
verification**: `backend/scripts/run-agent.ps1`'s supervisor (documented
in the earlier Places-direct investigation in this file) won every
port-8008 race against a manually-started, log-redirected agent instance
— repeated `taskkill`+immediate-restart attempts all lost to it. Directly
diagnostic logging requires seeing the process's own stdout, which the
supervisor's hidden PowerShell window doesn't expose. Resolved by
stopping the supervisor PowerShell process itself for the duration of the
diagnostic, then restarting it (`Start-Process ... run-agent.ps1
-WindowStyle Hidden`) once verification was complete — the supervised
agent is running normally again at the end of this pass.

**Live re-verification, before → after, identical query ("2 BHK in
Andheri West")**:
- `GET /health?probe=true`: groq `ok=true` (714ms), nvidia `ok=false`
  ("Authorization failed" — dead/unentitled key), gemini `ok=false`
  (quota exhausted) — all three independently confirmed, not inferred.
- `research_metadata.metrics`: `llm_calls` 9→7, `llm_failures` 3→0,
  `llm_fallbacks` 2→0. Every one of 7 real Groq calls succeeded on the
  first attempt in the post-fix run — zero retries needed, zero fallback
  to NVIDIA/Gemini.
- `research_metadata.llm_degraded`: `False` (curation genuinely succeeded,
  not silently degraded).
- Wall-clock: 79,156ms and 63,077ms across two independent post-fix runs
  (both well inside `AI_SEARCH_TIMEOUT_MS=180000`) — not a claimed speed
  target of this phase, but a real, favorable side effect of zero
  provider-cascade retries per call.

**Tests**: all three existing suites (`test_lifecycle_and_eligibility.cjs`,
`test_lifecycle_and_eligibility.py`, `test_bridge_circuit_breaker.py`)
re-run clean before AND after the full Phase 1 change set. No new test
file added this phase — every change is either diagnostic-only (Phase 0,
kept permanently since it's genuinely useful production visibility, not
a one-off), or was verified against the real running agent process live
rather than needing new unit coverage (the retry/reasoning_effort logic
inside `LLMClient._attempt`, the `/health?probe=true` route, and the
`llm_degraded` flag were all exercised by real API calls in this pass's
own verification, not mocked).

**Explicitly NOT done in this pass, awaiting further approval per the
task's own phase-gating**: Phase 2 (carpet area field-mismatch fix),
Phase 3 (wall-clock budget + node timing), Phase 4 (Project Intelligence
tab audit), Phase 5 (Dubai concurrency + RERA format gaps), Phase 6
(category-page harvest-and-fan-out) — none of that code was touched in
this pass.

---

## Two pre-Phase-2 fixes (user-requested review items) + Phase 2 — carpet area field mismatch

**Item 1 — `reasoning_effort` gating, reviewed, confirmed already correct.**
User flagged a real latent-bug shape: if `extra_body={"reasoning_effort":
...}` were sent unconditionally, the moment Groq fails and the router
falls through to nvidia/gemini/openai, THAT call would 400 on an unknown
parameter — untested, load-bearing, since Groq is currently the only
working provider. Re-read `LLMClient._attempt`: `if self.key == "groq":
kwargs["extra_body"] = {...}` was already correctly scoped to Groq only
from Phase 1a. No code change needed — confirmed and reported, not
silently assumed correct.

**Item 2 — probe error messages now carry real HTTP detail.** The generic
`"provider returned no usable JSON"` (correct for every OTHER caller of
`complete_json`, which only needs to know to fall back) wasn't useful for
a probe whose whole purpose is "why." Added `_extract_error_detail()`
(`llm_providers.py`) — handles the three genuinely different real error
body shapes seen live this session (NVIDIA: flat dict with `detail`;
Gemini: a LIST wrapping one `{error: {status, message}}`; Groq: flat dict
with `message`/`code`) without guessing a fourth. `LLMClient._attempt` now
returns a 3-tuple `(result, truncation_shaped, error_detail)`; a new
`_complete_json_with_error()` exposes it (the public `complete_json()`
itself keeps its existing `Optional[dict]`-only contract — nothing else
in the codebase needed to change) — `app.py`'s probe calls it directly.
Live-verified: `nvidia -> "403: Authorization failed"`, `gemini -> "429:
RESOURCE_EXHAUSTED"` — the exact format requested.

**Phase 2 — carpet area: the writer never wrote it, so the fix couldn't
just be "point the readers at the other field."** Investigated before
editing, per the task's own diagnosis: `carpet_area_sqft`'s ONLY writer
was `normalize.py:732`, reading `evidence.carpet_area.value_sqft` — a
field NO discovery-stage connector across the entire codebase ever
populates (confirmed via full grep — every EvidenceItem construction site
either omits `carpet_area` entirely or sets it via
`extract_sub_listings()`, which itself hardcoded `value_sqft: None`
always). `carpet_area_display`, by contrast, is populated ONLY later, via
`dedupe.py`'s `merge_extracted_facts()` folding in a real "carpet_area"
`ExtractedFact` from deep-research's per-page `deterministic_extract()` —
a COMPLETELY SEPARATE code path from the one that ever wrote
`carpet_area_sqft`. Fixed both ends:
- **Writer**: new `_parse_sqft_value()` (`fact_extraction.py`) — the
  number parsed straight back out of the "\<N\> sq ft" display string
  the SAME function already builds, never re-derived from raw text a
  second time. Wired into `extract_sub_listings()` (category-page
  harvest path) AND `dedupe.py`'s `merge_extracted_facts()` (the MAIN
  path, real deep-research page extraction) — the second one is the
  consequential fix, since it's what most candidates' carpet data
  actually flows through. Same "never overwrite a real value" discipline
  as every other field in that function.
- **Readers**: `curator.py` (both the per-config table's carpet fallback
  and the top-level listing `carpet_area` key — grepped `backend`/
  `frontend`, confirmed the latter is dead on the wire, nothing reads that
  exact snake_case key; `server.cjs`'s `adaptAgentProperty` only ever read
  `carpetAreaDisplay`, already correct — fixed anyway per its own
  "backward compatibility" contract, not because a live consumer needed
  it), `gap_checker.py`'s `CORE_FIELDS` + a new `_EVIDENCE_FIELD_MAP` entry
  (`"carpet_area_display": "carpet_area"` — mapping to the RAW
  `ExtractedFact.field` name `merge_extracted_facts` keys `field_evidence`
  by, not the top-level property key; `carpet_area_sqft` was never even in
  `dedupe.py`'s `TRACKED_FIELDS`, so a "weak" judgment on it was
  structurally impossible before this fix, not just unlikely — now
  `carpet_area_display` gets a real weak/missing distinction like
  developer/possession/price already had), `graph.py`'s
  `_data_completeness` (every candidate was scored exactly 1/5 less
  complete than it actually was, unconditionally). Also added
  `"carpet_area_display"` to `dedupe.py`'s `_merge_into()` gap-fill list
  (a genuinely different, earlier-stage merge function than
  `merge_extracted_facts`) for the re-dedupe-after-targeted-research
  scenario that function's own comment already documents.

**Tests**: 5 new checks added to the existing category-page sub-listing
test in `test_lifecycle_and_eligibility.py` (now 142 total) — the
category-page harvest path's `value_sqft` is real (not hardcoded None),
PLUS a new direct test of `merge_extracted_facts` (the main research path)
proving it sets BOTH `carpet_area_display` and `carpet_area_sqft` from the
same fact, and that an already-real `carpet_area_sqft` is never
overwritten. Chosen over relying on live-search luck for end-to-end proof
— see the live-verification finding below for why.

**Live verification — an honest, not-fully-clean result, reported as
found rather than reframed as a pass.** Three full live pipeline reruns of
the task's own verification query ("2 BHK in Andheri West", one more for
"2 BHK in Andheri East"): the writer-side fix is DEMONSTRABLY working
mid-pipeline — one run's `deduplicated_properties` (79 candidates) showed
4 with real, mutually-consistent `carpet_area_sqft`+`carpet_area_display`
(e.g. "Lodha Eternis": 758 sq ft, both fields agreeing; 110
`carpet_area`-field `extracted_facts` total across the run, confirming
real carpet data is genuinely being found on fetched pages) — but in
EVERY one of the 4 live reruns, ZERO of the final top-8 curated
candidates (and, in the last rerun, zero even of the broader
`ranked_properties` pool before curator's own trim) carried a non-null
carpet value. Root cause, traced not assumed: `_prioritize_for_deep_
research` (an earlier pass's fix) spends the bounded deep-research budget
on UNDETERMINED-lifecycle candidates first — exactly the ones that most
need a real page fetch to resolve eligibility — which means the
candidates that actually get a chance at real carpet extraction are
systematically NOT the same candidates that end up scoring highest/most
relevant once already-confidently-eligible (snippet-only, never
page-fetched, never carpet-extracted) candidates are ranked alongside
them. "Lodha Eternis" itself illustrates this exactly: real carpet data,
but it's in Andheri EAST, not WEST, so it correctly loses to the
geography hard-gate for this exact query regardless of its data richness.
**This is not a flaw in the Phase 2 fix** (proven correct in isolation by
the 5 new deterministic tests and by direct inspection of the live
pipeline's own intermediate state) — it's a real, structural consequence
of which candidates get deep-research page fetches AT ALL, a scope this
phase's own task explicitly reserved for Phase 3 (speed/budget) and
Phase 6 (harvest-and-fan-out, more candidates researched) to widen, not
something a field-name fix can address on its own.

**Field fill rates, out of 8 candidates ("2 BHK in Andheri West", the
task's own requested breakdown) — the first run in this whole
investigation with a genuinely working LLM (Phase 1), so these numbers
reflect real extraction yield, not LLM failure noise**:

| Field | Fill rate |
|---|---|
| rera | 5/8 |
| price | 6/8 |
| carpet | 0/8 (see finding above — real data exists mid-pipeline, doesn't survive to this exact top-8) |
| developer | 2/8 |
| amenities | 2/8 |
| possession | 7/8 |
| connectivity | 0/8 |
| nearby_landmarks | 0/8 |
| tower_count | 0/8 |
| property_type | 0/8 |

The last four (connectivity/nearby_landmarks/tower_count/property_type)
are genuinely 0/8 for the same underlying reason as carpet — they're
ALL deep-research-page-extraction-only fields (no discovery-snippet
source exists for any of them), so a candidate that never got a real
page fetch has zero chance at any of them, independent of whether Phase 1
fixed the LLM. **Phase 1 alone did not move these fields** — it fixed the
LLM CALLS (curation quality, `key_match`/`summary`/`display_name`), not
which candidates get RESEARCHED at all; that's squarely Phase 3/6's
scope, not retroactively fixed by Phase 1 or Phase 2.

---

## Phase 2.5 — enrich what gets DISPLAYED, not just what gets RESEARCHED

User's own re-framing of Phase 2's field-fill-rate finding: the
eligibility-research budget and the final-display selection choose
DIFFERENT candidates (4/79 deduplicated candidates had real carpet data;
0/8 displayed did) — so research a SPECIFIC candidate the eligibility loop
never fetches "wasted" the ranking that already happened. Speed
explicitly deprioritized this pass ("63-79s is acceptable").

**2.5a — new `display_enrichment` graph node, `final_scoring ->
display_enrichment -> curator`.** Runs strictly AFTER ranking/eligibility
is final (never re-decides it, never re-scores) — takes exactly
`ranked_properties[:MAX_SELECTED]` (the same 8 candidates curator.py is
about to return, imported directly rather than a second constant), builds
a NEW `gap_checker.compute_display_gaps()` (a genuinely different field
set from `compute_gaps`/`CORE_FIELDS` — those drive the ELIGIBILITY loop;
this checks developer/carpet_area/amenities/possession/connectivity/
nearby_landmarks/tower_count/property_type, the fields the listing card
and Project Intelligence panel actually show), and reuses
`deep_research.targeted_research_candidates()` UNCHANGED — no parallel
research path. Bounded by a new, dedicated
`AI_SEARCH_DISPLAY_ENRICHMENT_BUDGET_MS` (default 90000ms) via
`asyncio.wait_for` — a hard, all-or-nothing bound (matching every other
timeout already in this pipeline), not a soft partial-credit one. `planner
.py`'s `_FIELD_QUERY_HINTS` gained real hints for the 5 fields that were
never targeted-search-able before (amenities/connectivity/
nearby_landmarks/tower_count/property_type — previously fell into the
amenity-query fallback shape, which produces a wrong-looking query for a
literal field name like "tower_count"). **A real correctness risk found
and fixed while building this**: `dedupe.merge_updated_candidates` does a
wholesale replace-by-id, which is safe for `deduplicated_properties`
(plain `NormalizedProperty`) but would have silently stripped
`match_score`/`match_tier`/`match_reasons`/`limitations` off
`ranked_properties` (a strict superset, `RankedProperty`) if `updated`'s
entries were plain `NormalizedProperty` — verified they're NOT: `merge_
extracted_facts` starts from `dict(prop)` on the exact `RankedProperty`
items passed in, so every ranking field survives intact; documented
in-code rather than left as an implicit, easy-to-break assumption.

**2.5b — `llm_assist_extract` now walks every fetched page, not just
`pages[0]`.** `_fetch_and_extract`'s old call site used exactly one page,
regardless of how many (up to `MAX_FETCHES_PER_CANDIDATE`, 3) were
actually fetched. Now loops pages in order, stopping the instant
`still_missing` is empty.

**2.5c — chunking chosen over "select the most likely section," and
explicitly why.** Real pages carry target fields in genuinely different
sections (developer/RERA near the top, amenities/tower-count/connectivity
often much further down — Part P0's own live measurement: first RERA at
~7660 chars, fifth at ~24000) — a single heuristic window risks
confidently picking the WRONG section with no second chance, while
chunking (new `_chunk_text()`, 4000-char windows with a 200-char overlap
so a boundary-straddling mention isn't split) tries the cheap thing first
(chunk 1 of page 1 is IDENTICAL to the old `text[:4000]` behavior — the
common case costs exactly what it cost before) and only escalates when
genuinely still missing. Both 2.5b and 2.5c share ONE early-stop loop
(pages, then chunks within each page) and a shared
`AI_SEARCH_MAX_LLM_ASSIST_CALLS_PER_CANDIDATE` cap (default 6) so a very
long, very thin page can't turn into an unbounded call count. **A real
provenance bug found and fixed while building this**: the first version
built each chunk's synthetic page dict as bare `{"content", "title"}`,
which would have silently dropped `source_url`/`retrieved_at` — every
LLM-assisted fact from this loop would have become untraceable back to
its real source page. Fixed to `{**page, "content": chunk}` (a shallow
copy with only `content` swapped), caught before it ever ran live.

**Tests**: 13 new checks (`compute_display_gaps`'s presence/label logic,
`_chunk_text`'s chunking/overlap/coverage behavior) — both suites
(`test_lifecycle_and_eligibility.py`, now 155 checks;
`test_bridge_circuit_breaker.py`) re-run clean before AND after, plus
`backend/tests/test_lifecycle_and_eligibility.cjs` (Phase 2.5 is
Python-only, confirmed no drift).

### Live verification — a genuinely unclean result, reported as found, not reframed as a pass

**Groq's real, hard daily quota (200,000 TPD) was exhausted mid-session by
this pass's own live-testing volume, confirmed with exact numbers, not
inferred**: the second verification rerun's very first Groq call failed
with `'Rate limit reached ... on tokens per day (TPD): Limit 200000, Used
199436, Requested 1621... try again in 7m36s'` — a real 429, a real
`retry-after: 457` header, not a guess. Both post-Phase-2.5 live reruns of
the exact verification query hit this wall partway through (`research_
metadata.llm_degraded: true` on both), after which Groq's own per-process
circuit breaker (already-existing, working exactly as designed) correctly
stopped paying for doomed retries — but that also meant every remaining
LLM-assisted extraction call for both runs degraded to deterministic-only,
alongside NVIDIA (still dead, 403) and Gemini (still exhausted, 429) —
**zero working LLM providers for the back half of both runs**. `llm_calls`
went from Phase 2's clean baseline of 7 to 27 (run 1) then just 3 real
attempts before the circuit tripped entirely (run 2, `llm_fallbacks: 98`
— every subsequent call skip-fell-through all three dead providers with
zero network cost, the circuit breaker doing exactly its job, just against
an now-actually-exhausted account). Wall-clock: 429,085ms (run 1, still
paying real network cost before each provider's circuit tripped) and
102,054ms (run 2, circuits already broken from run 1 — degrades to fast
failure, still ~25-40s over Phase 2's clean 63-79s baseline purely from
2.5a's extra, LLM-independent page fetches: `pages_fetched` 8 -> 11).

**Fill-rate table, both post-Phase-2.5 runs, both LLM-degraded — reported
honestly as NOT a clean measurement of what this phase actually built**:

| Field | Phase 2 baseline (LLM healthy) | Phase 2.5 run 1 (degrading mid-run) | Phase 2.5 run 2 (degraded from the start) |
|---|---|---|---|
| rera | 5/8 | 5/8 | 5/8 |
| price | 6/8 | 6/8 | 6/8 |
| carpet | 0/8 | 0/8 | 0/8 |
| developer | 2/8 | 2/8 | **3/8** |
| amenities | 2/8 | **3/8** | **3/8** |
| possession | 7/8 | 7/8 | 7/8 |
| connectivity | 0/8 | 0/8 | 0/8 |
| nearby_landmarks | 0/8 | 0/8 | 0/8 |
| tower_count | 0/8 | 0/8 | 0/8 |
| property_type | 0/8 | **1/8** | **1/8** |

**The honest verdict, stated plainly per the task's own instruction**: I
cannot tell you whether Phase 2.5's LLM-assisted machinery (2.5b/2.5c —
the multi-page, multi-chunk extraction, which is what was actually built
to move carpet/connectivity/nearby_landmarks/tower_count) genuinely moves
those fields, because it never got a fair, quota-healthy run this
session. The small, real movement that DID appear (developer, amenities,
property_type) is consistent with 2.5a's non-LLM-dependent contribution
alone — MORE real pages fetched (8 -> 11) feeding the EXISTING
deterministic regex extraction (`fact_extraction.deterministic_extract`,
zero LLM dependency) a genuine second/third chance at fields it can find
without any model call — not proof 2.5b/2.5c's chunked-LLM path works,
and not proof it doesn't. Carpet/connectivity/nearby_landmarks/tower_count
staying at 0/8 across both degraded runs is **NOT** evidence "the pages
don't carry the data" (the Phase 6 hypothesis this task explicitly asked
to distinguish) — that conclusion requires a run where the LLM-assisted
extraction path actually executed, which didn't happen either time here.
**A genuinely clean re-verification needs the Groq daily quota to
recover** (the `retry-after` observed was 457s for that one call, but the
account was already 99.7% through its 200k-token daily allowance from
this whole session's cumulative live-testing volume across Phases 0-2.5,
not just this one run — a fresh attempt shortly after may still find
partial headroom already reconsumed) — re-run when ready, or reduce
`AI_SEARCH_MAX_LLM_ASSIST_CALLS_PER_CANDIDATE`/`MAX_SELECTED` for a
cheaper first clean test.
