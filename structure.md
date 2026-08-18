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
