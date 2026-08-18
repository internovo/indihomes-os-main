# IndiHomes Platform — Project Status & Next Steps
_Last updated: 2026-08-14_

This document tracks **what was proposed**, **what has been delivered**, and **what remains** to continue the project. For per-release detail see [VERSION.md](./VERSION.md).

---

## -13. 2026-08-14 (Tavily + card cleanup) — Tavily wired in as a first-class AI Search research connector; AI Search property cards rebuilt to match Property Search's visual language; staged research-progress copy replaces a flat spinner

### What this is

Two independent changes against the LangGraph agent built earlier the same
day (entry "-11"): a new search connector, and a presentation cleanup of
the result cards that connector's evidence renders into. Everything the
brief asked for around matching precision, deduplication/conflict
preservation, the single-marker map, and evidence-based Target Audience was
already correct in the existing code (verified by reading `scoring.py`,
`dedupe.py`, and `ProjectIntelligence.jsx`'s `NearbyMap`/Target Audience
sections directly) — this entry does not re-touch any of that.

### Tavily — new connector, not a new architecture

Follows the exact existing connector → bridge → tool pattern end to end, so
it degrades identically to every other connector when unset and required
zero changes to the graph's overall shape:

- **`external-connectors.cjs`**: new `tavilyConnector` (REST POST to
  `https://api.tavily.com/search`, `include_answer: false` always — its own
  AI-generated answer is never used as a fact source, only raw results feed
  this app's own extraction/verification pipeline). Registered in
  `CONNECTORS`, so it's automatically picked up by BOTH the legacy
  `external-search.cjs` path and the new agent path with no separate wiring.
- **`agent-tools-bridge.cjs`**: new `POST /internal/agent-tools/tavily-search`.
- **`ai-search-agent/agent/tools.py`**: new `tavily_search(query, market, depth)`.
- **`ai-search-agent/agent/planner.py`**: `tavily_search` added to the
  always-attempted base plan, alongside `web_search`/`apify_search` — tried
  in parallel, not gated behind a heuristic, since it has an independent
  failure mode from Google/Bing/Apify.
- **`ai-search-agent/agent/graph.py`**: new `node_tavily_search` in the same
  fan-out set; `node_targeted_research` (the existing per-candidate
  second-stage step) additionally fires Tavily at `depth='advanced'` per
  top candidate, next to its existing `developer_search`/`web_search`
  calls — first-pass discovery stays cheap (`basic`), targeted research
  spends the extra depth only where it's already decided a candidate is
  worth digging into.
- No new `ResearchState` fields — Tavily evidence flows through the same
  generic `raw_evidence`/`EvidenceItem` shape every other tool already
  uses; avoids duplicating state for what is, to the rest of the pipeline,
  just another evidence source.
- `.env.example`, `requirements.md` (new env-var rows, a Tavily setup
  section, and a "Recommended AI Search setup, by tier" block), and
  `ai-search-agent/README.md` (graph diagram, tool table) all updated.
  `server.cjs`'s `/api/ai-status` connector list and startup log both now
  surface Tavily's configured/not-configured state.
- **Fully optional, same as every other connector**: `TAVILY_SEARCH_ENABLED`
  defaults `false` in `.env.example`; unset, the bridge route returns
  `{evidence: [], note: '...'}` rather than erroring, exactly like the
  Google/Bing/Apify routes already did before this change.

### AI Search property cards — rebuilt to match Property Search, not a distinct "research report" style

`ProjectSelection.jsx`'s `PropertyCard` (AI Search's result card) previously
showed a "Why: ..." reasoning box, an amber "Limitations: ..." callout, a
"via 99acres.com" source line, and raw 🔗 source links + a 📄 RERA
certificate link — a materially different visual language from Property
Search's own `ProjectCard` sitting one tab over. Rebuilt to mirror it
exactly: thumbnail, #N index, name + tier badge + a real RERA `FieldBadge`
when present, one meta line (developer · location · config · price ·
possession), a single subtle source badge (reusing the existing
`SourceBadge` component via a new `normalizedSourceKey()` helper — no "via
X" prose), and the score column relabeled "MATCH %". `key_match`/
`limitations`/`sources` remain on the underlying data object exactly as
before (`toAnalysableProject`, `_agentIntel` — Project Intelligence's own
resolution chain is completely unchanged) — only the list card's visible
surface changed, per the "sources stay available internally, not deleted"
instruction.

### Emoji → lucide-react icons, staged loading copy

Scoped to AI Search's own UI (`PropertyCard`, `AnalystReport`'s banner,
`FilterChips`, `SearchHistoryPanel`) and `ProjectIntelligence.jsx`'s
`NearbyMap` overlay text — not an app-wide sweep; the rest of Project
Intelligence already received a full design-system pass the same day
(entry "-12"), and Property Search's own `ProjectCard` had no emoji to
begin with. `lucide-react` was already a dependency (the existing Search/
Loader2 submit button) — no new package added.

The flat "Searching external market listings…" spinner is replaced with a
client-side timer cycling through five labels naming the graph's real
phases (`Understanding your requirements → Searching property listings →
Comparing available properties → Verifying property details → Ranking
matching properties`) plus a five-dot progress indicator — the request
itself is still a single request/response call (not a stream), so this is
real-phase-named copy advancing on a timer, not a live progress feed, and
never exposes actual chain-of-thought.

### Verified

`npm run build` clean. Confirmed via code reading (not assumed) that
`scoring.py`'s graduated location/config/possession/budget/amenity scoring
with wrong-location/aggregator-page caps, `dedupe.py`'s conflict-preserving
merge, `NearbyMap`'s single-project-marker rendering, and Target Audience's
evidence-based fit scoring were all already correct before this change —
none were modified. `server.cjs` boots correctly with `TAVILY_API_KEY`/
`TAVILY_SEARCH_ENABLED` unset (no-ops, matches every other optional
connector's behavior).

### Known limitation

No live Tavily API key was available in this environment to verify a real
(non-empty) response end-to-end — the connector/bridge/tool chain was
verified by code review and by confirming the "not configured" no-op path
returns cleanly at every layer (connector `isConfigured()` → bridge route →
Python tool → graph node), matching the exact pattern every other optional
connector in this codebase already uses and is already verified to degrade
correctly through.

---

## -12. 2026-08-14 (design-system pass) — Shared UI primitives extracted to `src/components/ui/`, applied across Project Intelligence / Project Selection / Lead Capture; internal ticket IDs removed from the rendered UI; sidebar gained a real logomark

Pure UI/visual pass — no data fetching, API calls, business logic, or component prop contracts changed (confirmed via `npm run build` and `test-indihomes.ps1` both passing unchanged throughout).

### New shared components — `src/components/ui/`

Nine files, extracted from what had become three near-duplicate local implementations (Project Intelligence and Lead Capture had each independently built their own `FieldBadge`/`EmptyState`/`Card` with slightly different colors, sizes, and copy):

- **`tokens.js`** — the color/spacing/font scale every other file now reads from instead of re-typing hex codes. No new hues — every color here already existed somewhere in the app; this only removes drift between near-duplicate shades of the same intended color (three different "muted grey" shades — `#8A8896`/`#B8B6C0`/ad hoc italics — collapsed to two deliberate roles).
- **`FieldBadge.jsx`** — the one verified/AI-derived/unverified badge component, fixed color mapping, used identically by Project Intelligence, Project Selection (RERA badges), and available to any future screen.
- **`EmptyState.jsx`** — exports `EmptyState` (block/card-level, unchanged from before) and the new `EmptyValue` (inline, single muted span — replaces bare `—`, `Not published`, `Not yet fetched`, `No sold% found`, and three different grey shades with one consistent treatment; a genuine zero-value like "0 found nearby" is explicitly NOT routed through this, since it's a real value, not an empty state).
- **`SectionCard.jsx`** — the bordered-card-with-a-label-header shape now used by every card in Project Intelligence and Lead Capture. Header layout is fixed (title + badge left, action button right — previously "Hand off to Campaign" sat top-right while "↺ Regenerate" sat bottom-right of a different card; now both live top-right, consistently). Accepts an optional `debugId` (e.g. `"PI-FR-08"`) that only renders — as a small monospace tag visually separated from the title — when the page is opened with `?debug=1`; never rendered otherwise.
- **`debug.js`** — `isDebugMode()`, the single `?debug=1` check every debug-gated element reads.
- **`ProtectedField.jsx`** — the Lock-icon (read-only/protected) field, now with a real tooltip ("Protected field — captured at intake") via a wrapping `title` span (an SVG `title` prop alone doesn't reliably tooltip cross-browser). Also exports a plain `Field` (no icon at all, for genuinely-neither-locked-nor-editable values like a lead's Source).
- **`EditableField.jsx`** — the Pencil-icon (editable) field, generalized to take an `onSave(value)` async callback instead of hardcoding Lead Capture's specific PATCH endpoint, so it's reusable by any future screen with an inline-editable field.
- **`StatusPill.jsx`** — the generic colored pill Lead Capture's table Status column and its detail-view status dropdown both now render through, so they're pixel-identical (they already shared one color map from an earlier pass; this extracts the rendering too).
- **`Logomark.jsx`** — see below.

`src/components/shared/StatCard.jsx` (pre-existing, already used correctly everywhere including Command Center's KPI row) was left in place rather than relocated — moving it would only have been import churn with no behavior change — but its trend caption is now always exactly one line (`white-space:nowrap` + ellipsis, was unconstrained and could wrap to a different number of lines per card depending on caption length, which is what actually made the IndiHomes Score/AI Match/Inventory Risk/Demand Trend row look ragged — all four cards already used this one shared component, they just didn't enforce consistent caption height).

### Project Intelligence

- Removed the internal ticket ID (`PI-FR-01` through `PI-FR-13`) from every rendered section header (`Project Description · PI-FR-08` → `Project Description`, etc.) — 10 occurrences, confirmed via `?debug=1` toggle that they still render (as a separated monospace tag) for QA and are absent by default.
- Every card converted from a local, ad hoc header `<div>` to the shared `SectionCard` — "↺ Regenerate" moved from bottom-right to top-right (matching "Hand off to Campaign"'s existing position); Sales Velocity's badge moved from a manual conditional into `SectionCard`'s `badge` prop.
- Inventory & Unit Configurations table: every "Not published" cell (three different shades of muted/italic text across Total/Available/Movement columns) now renders through `EmptyValue` — one consistent look. The "Movement: hover for what ▲/▼ mean..." tooltip text now has a visible dotted underline (`cursor:help`) instead of reading as static text with a hidden tooltip.
- Location Map's Locality/Location Quality Score/Search Trend rows: three different empty-state phrasings (`—`, `"Not connected — map hasn't located..."`, `"Not available"`) unified through `EmptyValue`.
- RERA Details: "Not found on listing" and the Source row's bare `—` now render through `EmptyValue`.
- Hero card: the "— No score yet" pill was previously always styled in the success-green background regardless of whether a score existed (misleading — looked like a positive indicator for an absence); now conditionally styled muted-grey when there's genuinely no score.
- Found and fixed a real latent bug while doing this: an old local `EmptyState` function definition still existed in this file even though a new one was being imported under the same name — an unresolved naming collision that would have been a hard build failure (`Identifier 'EmptyState' has already been declared`) the moment both were in scope; caught and removed before it ever reached a build.

### Lead Capture

- `LockedField`/`Field`/`EditableField` (three local components, `Lock`/`Pencil` icons with no tooltip) replaced with the shared `ProtectedField`/`Field`/`EditableField` — same visual result, now with a real tooltip on every lock icon, and the save logic generalized to a `saveField(field)` callback factory instead of being duplicated inside the old local `EditableField`.
- CRM Status's Lock+badge block, previously a one-off manual `<div>`, now uses `ProtectedField` with the CRM badge passed as its `value` (a ReactNode, not just a string — `ProtectedField` already supported this without changes).
- Status pill (both the detail-view dropdown and the table's Status column) now renders through the shared `StatusPill` — pixel-identical between the two, same color per status as the existing 9-status map (`New`/`Contacted`/`Qualified`/`Follow-up`/`Site Visit Scheduled`/`Site Visit Completed`/`Negotiation`/`Won`/`Lost`, each with its own accessible color, already built in an earlier pass — this pass only consolidated the *rendering*, the color-per-status requirement was already met).
- `CrmBadge`'s "not synced yet" state and three more bare `—`/ad hoc-grey dashes (table's Lead name, Project, Requirement columns) replaced with `EmptyValue`.
- Local `Card`/`SectionCard` (near-identical to Project Intelligence's, differed only in an extra `boxShadow`) replaced with the shared `SectionCard` — standardized on the shadow-less flat style already used everywhere else in the app.

### Project Selection

- RERA badges (`RERA {code}` / `RERA ✓`, previously hand-styled green spans) now render through `FieldBadge` — pixel-identical to Project Intelligence's RERA-adjacent badges.
- A few remaining bare `—` dashes in the Search History panel (query/filter summary text) routed through `EmptyValue`.
- PRIMARY/SECONDARY/TERTIARY rank badges and portal-source tags (99acres/MagicBricks/IndiHomes Website) were deliberately left as their own distinct systems — they're a different meaning (match tier / source provenance, not verification status) from `FieldBadge`, and already used consistent colors before this pass.

### Sidebar — real logomark

`Logomark.jsx` — a small SVG house/roof glyph (white on a rounded navy square) with a violet dot accent (the same violet used everywhere for "AI-derived" — no new colors), placed next to the "IndiHomes OS" wordmark. Pure SVG, scales cleanly to an icon-only size; navigation structure/labels untouched, no collapse feature added (this pass is visual-only, per instruction).

### TopBar

Audited — no internal IDs, ad hoc badges, or inconsistent empty-states found. No changes made.

### Remaining 15 screens (Command Center, Campaign Recommendations, Creative Studio, Campaign Deployment, Lead Scoring, Junk Detection, AI Calling Agent, WhatsApp Agent, AI Workforce, Caller Dashboard, Sales CRM, Builder Collaboration, AI Analytics, AI Recommendations, User Management)

Audited via a repo-wide grep sweep for every anti-pattern signature named in the brief (`FR-\d+`-style ticket IDs, bare `—`/ad hoc empty-state phrases, hand-styled verified/AI-derived/unverified badges, non-`StatCard` KPI rows) — genuinely zero additional instances found outside the three files above. Command Center's KPI row already uses the shared `StatCard` (and so already benefits from this pass's single-line-caption fix with no changes needed there). These screens are simpler/static-demo-data screens that don't currently exhibit the specific problems described — extending the design system to them is now straightforward (the primitives exist in `src/components/ui/`) whenever they grow real, data-driven content, but no busywork edits were made to files with nothing to fix.

### Verified

`npm run build`: clean, 1844 modules, 372.83 kB / 106.58 kB gzip (was 374.17 kB / 106.02 kB gzip before this pass — net negative/flat, since this removed more duplicated component code than it added). `test-indihomes.ps1 -SkipBuild`: all PASS except the pre-existing, already-documented Meta-sync WARN. Browser-verified (Playwright): Project Intelligence full page (no `PI-FR-` text visible; confirmed reappearing under `?debug=1`; badge/score/card alignment all clean), Lead Capture table + detail view (lock/pencil icons with tooltips, status pill color-matched between table and dropdown, all "Not available" cells consistent), Sidebar logomark rendering correctly at the current fixed width. Zero console errors beyond the pre-existing, already-documented Google Places 403 (unrelated).

### Files changed/added

New: `src/components/ui/tokens.js`, `FieldBadge.jsx`, `EmptyState.jsx`, `SectionCard.jsx`, `debug.js`, `ProtectedField.jsx`, `EditableField.jsx`, `StatusPill.jsx`, `Logomark.jsx`.
Modified: `src/components/screens/ProjectIntelligence.jsx`, `src/components/screens/LeadCapture.jsx`, `src/components/screens/ProjectSelection.jsx`, `src/components/layout/Sidebar.jsx`, `src/components/shared/StatCard.jsx`.
Audited, no changes needed: `src/components/layout/TopBar.jsx`, all 15 other screens in `src/components/screens/`.

---

## -11. 2026-08-14 (major architecture) — AI Search rebuilt as a real LangGraph research agent (`ai-search-agent/`), feature-flagged behind the existing pipeline; property research cards replace the old ranked-list UI; Project Intelligence populates directly from agent evidence

### What this is

AI Search's single-pass "query connectors → score → return" flow now has a genuine alternative: a Python FastAPI service (`ai-search-agent/`) running an actual LangGraph `StateGraph` — query understanding → location resolution (same shared gazetteer) → research planning → parallel multi-tool search → evidence normalization → deduplication (conflicting values across sources are **preserved**, never silently overwritten) → deterministic scoring → an *optional* LLM curator pass → structured output. **No Anthropic/Claude dependency anywhere in it** — Grok (xAI) and Gemini only, both via their OpenAI-compatible endpoints through one `openai` Python client, no separate SDKs. Full architecture, graph diagram, and per-node detail in `ai-search-agent/README.md`; full env var reference and setup steps in `requirements.md`'s new "AI Search Agent (LangGraph)" section.

**Fully additive and backward compatible.** `LANGGRAPH_ENABLED` (unset by default) is the only thing that changes `/api/ai-search`'s behavior; with it on, any agent failure (service down, timeout, bad response) falls straight through to the exact same external-search.cjs path this repo already had — confirmed live, this can only make a result better or identical, never worse or absent.

### Why Python, why a separate service

The existing backend is Node/CommonJS end to end; LangGraph is Python-first. Forcing an equivalent state machine into Node would mean either a much thinner hand-rolled orchestrator or a heavy new Node dependency tree for real loss of the actual LangGraph primitives (typed state with reducers, conditional routing, a compiled graph). Per the explicit instruction to keep this as "existing Node backend → AI Search Agent service → LangGraph... rather than mixing orchestration logic into unrelated backend code," this is a standalone FastAPI service Node calls into (`agent-tools-bridge.cjs` + a feature flag on the existing route) — nothing about the existing backend was rewritten.

### The tools call the SAME connectors, not new ones

`agent-tools-bridge.cjs` (new, token-gated, `/internal/agent-tools/*`) is a set of thin wrapper routes around the connectors this repo already had — `external-connectors.cjs`'s Google CSE / Bing / Apify, `legacy-portal-connector.cjs`'s 99acres+MagicBricks scraper, `indihomes-client.cjs`'s official catalog lookup. Zero scraping/search logic was reimplemented in Python; the agent's tools (`agent/tools.py`) are async HTTP clients calling these bridge routes.

### Two real, confirmed bugs found and fixed *during this build* (not pre-existing — introduced and caught within this same pass)

1. **A locality that only appeared in a listing's marketing description (not its title) was being credited as an exact location match.** `normalize_location()`'s fallback (used when a search-snippet evidence item has no structured location field) originally extracted location terms from title *and* description together — a "2 BHK Flats in Andheri East" listing whose description happened to namedrop "Borivali East" as unrelated marketing copy was scoring a false "Exact location match: Borivali East." Fixed by restricting this fallback to the title only (`agent/normalize.py`).
2. **The location scorer treated a query's resolved CITY as a valid "exact match" candidate even for non-alias localities** — meaning any Mumbai listing would "exactly match" any Mumbai locality query, since `resolve_location('Borivali East')` correctly reports `city: 'Mumbai'` and that was being folded into the exact-match candidate set unconditionally. Fixed to only include city/parent as candidates when the query term is genuinely a micro-alias (mirrors `scoring.cjs`'s `expandLocationTerm`, which only expands city/parent for `MICRO_ALIASES` keys, never for a first-class locality already in the gazetteer's own city list) — `agent/scoring.py`.

Both confirmed fixed via a live before/after diff against real evidence (see "Verified" below).

### A third, pre-existing failure mode ported over and fixed here too

Real evidence from web search regularly includes portal **category/aggregator pages** ("14+ Apartments for Sale in Liberty Garden") rather than individual listings — the exact same problem `scoring.cjs` already had to solve for the old AI Search path (documented there: "an 18-result Daulat Nagar search landed every single result on an identical 89%... a generic aggregator page ties with an actual listing"). Ported the fix: `is_aggregator_title()` in `agent/normalize.py` detects a title with nothing distinctive left over once known gazetteer locality names and generic real-estate filler words are stripped from it, and `agent/scoring.py` caps such results at TERTIARY regardless of keyword overlap — confirmed live: three near-identical "N+ Flats in Liberty Garden" category pages correctly dropped from 93/PRIMARY to 55/TERTIARY, while genuine per-unit listings (title names a real project/builder, e.g. "Sheth Irene") stayed at 80+/PRIMARY.

### Also fixed in the existing Node parser (`query-parser.cjs`), for consistency with the new Python port

While porting `query-parser.cjs`'s deterministic extraction rules to Python (`agent/query_understanding.py` — same regexes, same tiers, kept in sync deliberately per this codebase's established cross-runtime pattern), found and fixed two real gaps in **both** the Node original and the Python port:
- **A compound location like "Liberty Garden Malad West" (no preposition) collapsed into one unresolvable string** instead of two recognized gazetteer terms. Fixed with a new gazetteer-scan tier (`gazetteerScanLocations()`/`_gazetteer_scan_locations()`) that scans the raw query text for every known gazetteer term as a literal, longest-match-first, whole-word phrase — now correctly extracts `["Liberty Garden", "Malad West"]`.
- **Amenity extraction was reading a locality name as an amenity request** — "Liberty **Garden**" registered "garden" as a requested amenity purely because the word "garden" is both a real amenity term and part of a real locality name. Fixed by masking already-extracted locations out of the text before amenity extraction runs (`maskLocations()`/`_mask_locations()`).
- Also added `deck`/`private deck` to the shared amenity vocabulary (the brief's own example query needed it) and added `amenities` to `parseNLQuery`'s/`parseExternalQuery`'s output shape.

Regression-tested against the full existing smoke suite after these Node-side changes — all still PASS.

### API contract — additive, not replaced

`/api/ai-search`'s response gained `summary`, `citations`, `research_metadata`, and each property gained `match_tier` (real, score-derived — not positional), `match_reasons`, `key_match`, `limitations`, `project_intelligence`, `id` — layered on top of every field that already existed (`match_score`, `sources`, `sourceName`, etc.), so nothing that already read the old shape needed to change. See `server.cjs`'s `adaptAgentProperty()`.

### Frontend — real research cards, not a ranked list

`ProjectSelection.jsx`'s `RankedResults`/`PropertyCard` (rewritten) now render: match score + real tier badge, price/config/carpet-area/location/possession/developer line, a "Why" reason line, a distinct amber "Limitations" callout when the agent found a real gap, source links, and an "Open Project Intelligence →" button — plus an optional research-summary banner above the card list when the agent produced one. A leftover, unrelated bug fixed in the same pass: the tier badge on **every** AI Search result card had been reading array **position** (`RANK_BY_POSITION[i]`), not the actual score — meaning a 55-scoring result at position 0 would show "PRIMARY" while a 90-scoring result at position 3 showed further down the fixed label list. Now uses the real `match_tier` whenever the agent (or any future scorer) supplies one, falling back to the old positional labels only for the untouched legacy path.

### Project Intelligence — populated directly from agent evidence, not re-researched

Part 16's explicit requirement: clicking a researched property must **not** trigger a separate, likely-dead search. `toAnalysableProject()` now carries the agent's `project_intelligence` payload through as `_agentIntel`; `ProjectIntelligence.jsx`'s reset-on-project-change effect checks for it and, when present, sets it directly as the `research` state — the **exact same shape** `research` already had (this screen's entire official/live/research resolution chain, USP/Target-Audience/RERA/description display logic, is completely unchanged) — and skips the `/api/ai-research` call entirely (which, for a non-agent project, still exists exactly as before: real for its official-IndiHomes-data path, permanently inert for its Claude-web-research branch, per `requirements.md`'s existing documented reasoning). Confirmed live: opening a card populated Project Description, Inventory (config + price), the AI Match/IndiHomes Score KPIs, and Target Audience recommendations immediately, with an honest "No USPs found for this project" where the real evidence genuinely had none — never fabricated.

**Nearby Infrastructure and the map are completely untouched** — the agent's payload deliberately never sets a `nearby` field, so the existing OSM/Overpass/Leaflet pipeline remains the sole source for that card, exactly as required.

### Dead code removed (confirmed, not assumed)

`llm.discoverProjectsFromWeb` and `llm.analystReport` (the old Claude-conversational-search pair) removed from `llm.cjs` — confirmed via grep against `server.cjs` that neither had any caller anywhere (the old `/api/ai-chat` route that used to reach them was already retired to a 501 stub in an earlier pass, and said so in its own comment). `researchFromWeb`/`dueDiligence`/`isConfigured` etc. were **not** touched — still legitimately used by `/api/ai-analyze` and `/api/ai-research`'s official-IndiHomes-data path.

### Verified

- **All 5 required test queries**, run live end-to-end through the real Node→Python HTTP path against real evidence (Apify's Google-search actor; Google CSE 403s in this deployment per `requirements.md`'s already-documented issue, Bing unconfigured, portal-scraper's narrow "new projects" scope legitimately returned 0 for these specific micro-localities — all expected, all logged, all gracefully absorbed):
  - `"2 BHK with deck on Liberty Garden Malad West"` — 4 genuine listings correctly PRIMARY (80), 2 category pages correctly capped TERTIARY (55).
  - `"2 BHK in Borivali East under ₹1.5 Cr"` — 8 exact-locality, in-budget, right-BHK listings all PRIMARY (94); Andheri East / Kandivali East results correctly fell to TERTIARY (no false location credit, the bug described above).
  - `"3 BHK near Goregaon West with possession by 2027"` — 5 PRIMARY (94), a still-under-construction listing correctly SECONDARY (74).
  - `"2 BHK in Liberty Garden"` — micro-locality alias resolution confirmed (`Liberty Garden → parent Malad West, city Mumbai, is_micro_alias: true`), 6 PRIMARY (92).
  - `"2 BHK in Borivali West with gym and swimming pool"` — amenity extraction confirmed (`['gym', 'swimming pool']`, no false "Borivali" pollution), 5 PRIMARY (93) with amenities explicitly confirmed in `match_reasons`.
- **Browser-verified** (Playwright): AI Search tab renders the new card UI with a research-summary banner, correct badges/scores/limitations/source links; clicking "Open Project Intelligence" populates the screen from real evidence with the correct AI Match/IndiHomes Score/description/inventory/Target Audience, honest empty states where evidence was genuinely absent; zero console errors beyond the pre-existing, already-documented Google Places 403 (unrelated); **zero requests to any `anthropic.com` host** across the whole flow (explicitly checked).
- **Graceful degradation, exercised for real, twice**: with zero LLM keys reachable, and separately against this deployment's actually-configured-but-currently-broken `GEMINI_API_KEY` (a real Google API error — `models/gemini-2.0-flash is no longer available` / `prepayment credits are depleted`, confirmed via direct provider calls, not a code defect) — both correctly fell back to a complete, real, deterministic result rather than an error or a fabricated response.
- `npm run build`: clean, 1835 modules, 374.17 kB / 106.02 kB gzip. `test-indihomes.ps1 -SkipBuild`: all PASS except the pre-existing, already-documented Meta-sync WARN.
- Property Search, location autocomplete, micro-location resolution, the map/geocoding pipeline, Lead Capture — all confirmed unchanged (nothing in this pass touched their code paths).

### Known limitations (carried into `requirements.md` in full)

- **Google Custom Search 403s in this deployment** (pre-existing, already documented before this pass) — the agent's `web_search`/`developer_search` tools correctly try it and fall back to Apify without erroring, but it's not actually contributing evidence here until the Custom Search JSON API is enabled on the right Google Cloud project.
- **The 99acres/MagicBricks direct scraper** (`portal_search`) only covers Mumbai/Thane/Pune/Navi Mumbai, only that portal's *new-projects* pages (a narrower scope than general resale/rental listings), and has not been validated from a non-residential IP — all pre-existing, unchanged limitations of `legacy-portal-connector.cjs`, now documented in the agent's own setup docs too.
- **`/api/ai-search-more` (pagination)** does not currently route "load more" through the agent — it falls back to the legacy connector path for that specific action. The agent's curator already returns up to 8 selected properties per search (a reasonable first page); deeper agent-driven pagination is a reasonable follow-up, not implemented in this pass.
- **No live LLM-curated summary was observed in this session** (the configured Gemini key's model is stale / its account's prepaid credits are exhausted — both external account-state issues, not code defects) — the deterministic curator path is what every result in this pass actually used and is what's verified above; the LLM path is real, wired, and will activate automatically the moment a working key/model is available (verified the failure handling itself works correctly, twice, as noted above).

---

## -10. 2026-08-14 (precision + production pass) — Ranking precision fixed at its actual root cause (a mislabeled badge, a parser gap, and binary scoring), Lead Details gained Status editing + Follow-up notes, Project Intelligence description overflow fixed

### Part 1 — Property Search ranking precision

**The real, confirmed root causes** (three independent bugs, all fixed):

1. **The PRIMARY/SECONDARY/TERTIARY badge on every card was reading `project.rank` — a static, scrape-time heuristic tag — instead of the live per-search score.** This is almost certainly what the report actually saw: a card scoring 96 (an excellent live match) could show a "SECONDARY" badge simply because its unrelated static tag said so, while a 75-scoring card showed "PRIMARY" for the same reason — completely disconnected from the real match quality directly beside it. Confirmed live before the fix (screenshot showed exactly this inversion) and fixed by deriving the badge from the same live score already computed for display (`rankLabelOf()`, mirrors `scoring.cjs`'s 80/60/40 thresholds) — `ProjectSelection.jsx`.
2. **`query-parser.cjs`'s location extraction silently dropped directional suffixes typed in lowercase.** "Borivali east 1bhk possession by 2027" extracted location as just `"Borivali"` (the Title-Case-only regex tier only saw the capitalized first word) — losing "East" entirely, so Borivali East and Borivali West projects were scored identically. Fixed with a new case-insensitive directional-suffix tier (`(word) (east|west|north|south)`, a generic grammatical pattern — not a hardcoded place list) plus Title Case normalization applied to every extraction tier's output.
3. **`scoreLocation`/`scoreConfig` were purely binary** (full marks or zero, no middle ground), which is what actually produced the reported "many results land on the same SECONDARY score" — an exact match and a barely-related one that both happened to satisfy config/possession landed in the same score band. Rebuilt as graduated:
   - **Location**: exact/gazetteer-accepted-alias match = full marks; a generic "sibling" locality (same umbrella name, different direction — "Borivali West" against a "Borivali East" search, detected via a direction-suffix strip, not a hardcoded pair) = ~35% credit; unrelated area = 0, and **capped below SECONDARY entirely** when the user explicitly asked for a location and got zero relation to it — "do not mark a project Primary merely because it's geographically nearby" is now enforced by the scoring, not just documentation.
   - **Configuration**: now whitespace-normalized before comparing (`"1BHK"` vs `"1 BHK"`) — real project data is inconsistent about this, and the mismatch was silently zeroing out genuinely-matching projects' config score, a second contributor to the same-score clustering.
   - **Possession**: kept its existing full/partial/none structure but recalibrated so "possession slightly outside the window" alone can no longer push an otherwise-exact match above the PRIMARY threshold (was landing at 80–88, now 78) — matches the spec's own SECONDARY example precisely.
   - **New: Amenities.** Added `extractAmenities()` (generic keyword vocabulary — gym, pool, clubhouse, etc.) and `scoreAmenities()`. Honest about current data reality: Filter Search's bulk project list (`cache.projects`) does not carry populated `amenities` data today (confirmed: 0 of 153 cached projects have it — only Project Intelligence's per-project deep-scrape does) — so amenity matching is correctly treated as "not applicable" per project when that project has no amenity data on file, never fabricated or silently scored 0 for everyone. It activates for real the moment any project's amenities are actually populated.
   - **Weights rebalanced**: Location 30 / Configuration 25 / Possession 20 / Budget 15 / Completeness 10 / Amenity 10 (was Budget 30 / Location 25 / Config 20 / Possession 15) — explicit query criteria now outweigh budget-range fit and data-completeness, per the brief's "explicit requirements over generic ranking signals" instruction.
4. **`ProjectSelection.jsx`'s `filtered()` hard-excluded on configuration/possession mismatch**, meaning a near-miss project (right area, wrong BHK, or possession a year late) never reached scoring to be shown as a lower-tier result — it just vanished, which is why "nearby/partial" results as described in the spec's SECONDARY/TERTIARY examples couldn't previously appear at all. Location and budget remain hard filters (real affordability/geography bounds); configuration and possession are now soft signals scoring.cjs's already-existing partial-credit logic differentiates. The location hard filter itself was also broadened to admit sibling localities (same fix as #3) so they have something to be scored into instead of being excluded outright.
5. **`server.cjs`'s `/api/filter-rank` was dropping the real score for excluded (score &lt; 40) projects**, hardcoding a `0` on the frontend regardless of whether the actual score was 35 or 2 — fixed to carry the real `match_score` through in both places.
6. **Reason strings rewritten** to state the actual signal precisely (`"Exact location match: Borivali East"` / `"Possession Jun 2028 is outside your preferred 2027 window (close)"`) instead of the previous vaguer `"Location matches X"`.

**Verified against the real cached catalog** (not synthetic data) for `filters:{locations:['Borivali East'], configs:['1 BHK'], possession:'By 2027'}`, 47 real Borivali-area candidates, 40 scored (backend cap): **13 distinct scores**, correctly tiered — 4 genuine exact matches at 96/PRIMARY, exact-location-but-late-possession and exact-location-wrong-config both landing at 68–75/SECONDARY, sibling-locality-with-partial-match at 42–52/TERTIARY, multi-fail candidates correctly excluded (&lt;40) with their real score preserved. Confirmed live in the browser for all three required queries (see Part 9).

### Part 2 — Search button

`LocationCombobox`'s submit button (used by both Property Search and AI Search) now renders `lucide-react`'s `Search`/`Loader2` icons instead of a 🔍 emoji, with a real hover state (background darkens), a loading state (spinning `Loader2` + "Searching…", `cursor:wait`), and a disabled state (`cursor:not-allowed`, muted grey) — no new animation beyond the spinner itself, which only appears during genuine async work.

### Part 3 — Project Description overflow

**Root cause**: `Card` (the shared card component used by every section on this page) had no `min-width:0` — CSS Grid's default `min-width:auto` sizes a grid item to its content's *min-content* width (the longest unbreakable token), so a long unbroken run of text in the description could silently force its 1fr grid column wider than intended, pushing the card past its column. Fixed with `minWidth:0; maxWidth:100%; boxSizing:border-box` on `Card` (safe — no `overflow:hidden` added, since some cards host popovers that need to render outside their own box) plus `overflowWrap:break-word` / `wordBreak:break-word` on the description's paragraph/heading/list-item styles. The existing ~150px height clamp (no "Read More" toggle, never had one) is unchanged.

### Part 4 — Project Intelligence spacing/USP/Nearby Infrastructure/Target Audience

Re-audited against the prior session's fixes: the `alignItems:'start'` grid-stretch fix, USP Extraction's compactness, Nearby Infrastructure's category-gated reveal (category chips only until one is clicked — confirmed still correct, no default-expanded list), and Target Audience's HIGH→MEDIUM→LOW ordering (`sortByFit()`/`FIT_ORDER`) were all already in place and correct from the previous pass — no regressions found, no changes needed.

### Part 4 (Lead Capture) — Status editing

`leads.status` was previously **write-only-at-creation** — always `'New'`, no code path anywhere ever updated it, and the frontend's `STATUS_COLOR` map (5 aspirational values) had no editing UI wired to it at all. Added `status` to `db.cjs`'s `EDITABLE_LEAD_FIELDS` allowlist — it now goes through the *exact same* generic `PATCH /api/leads/:id` → `updateLeadFields()` → `logLeadEdit()` path as every other editable field, so it gets the same audit trail, the same "skip if unchanged" guard, for free, with **no new/duplicate status mechanism**. New `StatusEditor` component (click the header pill → dropdown of 9 stages: New, Contacted, Qualified, Follow-up, Site Visit Scheduled, Site Visit Completed, Negotiation, Won, Lost — `leads.status` is unconstrained free text, no DB enum, so this is a UI vocabulary choice, not a schema change; a lead carrying an older value like "Visited" displays with a neutral fallback color until updated). Saves immediately, appears in the header pill and the Activity feed (`"Status changed to Qualified from New"`) without a page reload. `crm_status` (CRM-push outcome) remains completely separate and locked, exactly as before — confirmed via `runMetaCapiSync()` that CAPI is keyed only off `crm_status` transitions, never `status`.

### Part 5 (Lead Capture) — Follow-up notes

New `POST /api/leads/:id/follow-up` endpoint, logging into the **same append-only `lead_edits` table** the Activity feed already reads (`field:'follow_up'`) — not a new table, since a follow-up is conceptually just another dated activity entry and that table already has exactly the right shape. `FollowUpButton` + `FollowUpComposer` in the Activity section: click → textarea + Cancel/Save Follow-up → posts, refreshes the feed, shows the note with a timestamp and a distinct orange dot/box in the timeline immediately.

### Part 6 — View Details button

Restyled to a real secondary-action button (`ExternalLink` icon, consistent border/padding/typography with the new Follow-up/Status controls, real hover state) instead of the previous plain-text/borderless treatment.

### Part 8 — Nothing removed

Natural-language search, location autocomplete, micro-location/gazetteer resolution, search history, project selection, campaign brief flow, USP extraction, Target Audience, Location Map, Nearby Infrastructure, RERA details, Meta/Housing.com/Website lead ingestion, lead editing, and Meta CAPI logic are all untouched in behavior — confirmed live (see Part 9).

### Part 9 — Testing

`npm run build`: clean, 1835 modules, 373.18 kB / 105.81 kB gzip. `test-indihomes.ps1 -SkipBuild`: all PASS except the pre-existing, already-documented Meta-sync WARN (credentials not configured in this environment, unrelated). Live in the browser:
- **"Borivali east 1bhk possession by 2027"** — 4 genuine exact matches correctly PRIMARY (96, "Exact location match... within your requested window"), exact-location-but-late-possession correctly SECONDARY (75, "outside your preferred 2027 window"), badge and score now visibly agree on every card.
- **"2BHK in Borivali West with gym and swimming pool"** — location+configuration correctly drive PRIMARY ranking (97/95); amenities parse correctly (`['gym','swimming pool']`) and are honestly excluded from scoring per-project where no amenity data exists (documented data-quality limitation below), not faked.
- **"Liberty Garden"** — micro-location dropdown still resolves to `Liberty Garden, Malad West · LOCALITY` live-while-typing; running the search correctly treats the gazetteer-resolved parent as an **exact** match (not merely "nearby") for every real Malad West project, consistent with "a very close/explicitly accepted locality match" counting toward PRIMARY.
- Lead Capture: status changed New → Qualified, persisted, appeared in the header pill and Activity feed immediately; follow-up note added, persisted, appeared in the Activity feed with a timestamp; confirmed via code review that Housing.com/Website leads are structurally excluded from `runMetaCapiSync()` (filters `primary_source === 'meta'`), and that neither `status` edits nor follow-up notes touch `crm_status` — so neither can trigger a CAPI event, trivial or otherwise.
- Project Intelligence: description now fully confined to its card with no overflow; badge/score agreement confirmed here too (PRIMARY + 97% together, not contradicting).

### Part 10 — Report

1. **Files changed**: `scoring.cjs`, `query-parser.cjs`, `server.cjs`, `db.cjs`, `src/components/screens/ProjectSelection.jsx`, `src/components/screens/ProjectIntelligence.jsx`, `src/components/screens/LeadCapture.jsx`.
2. **Exact ranking/scoring changes**: see Part 1 above — badge-source bug, parser directional-suffix gap, binary→graduated location/config scoring, soft-filtered config/possession, rebalanced weights, amenity dimension added.
3. **How PRIMARY/SECONDARY/TERTIARY are now determined**: `scoring.cjs`'s weighted score against the *actual* parsed query (80/60/40 thresholds, unchanged), now genuinely differentiated per-project instead of clustering; the UI badge is now sourced from that same live score rather than a static per-project tag.
4. **AI Match calculation**: unchanged formula (weighted sum of applicable dimensions ÷ applicable+completeness, ×100), now meaningfully differentiated because the inputs (location/config credit) are graduated instead of binary — no artificial remapping into fixed bands, per the brief's explicit instruction.
5. **Highest-weighted criteria**: Location (30) > Configuration (25) > Possession (20) > Budget (15) ≈ Completeness (10) ≈ Amenity (10).
6. **Example evaluation** ("Borivali East 1 BHK possession by 2027", real data): see Part 1's verification paragraph.
7. **Project Intelligence UI fixes**: description overflow (Part 3); spacing/USP/Nearby Infrastructure/Target Audience re-confirmed already correct from the prior pass (Part 4).
8. **Lead status editing**: Part 4 (Lead Capture) above.
9. **Follow-up implementation**: Part 5 above.
10. **View Details improvement**: Part 6 above.
11. **Build result**: clean, see Part 9.
12. **Test results**: see Part 9.
13. **Remaining limitations / data-quality notes**: (a) Amenity scoring is fully wired but inert for Filter Search's bulk catalog today, since that endpoint's project objects don't carry populated `amenities` — it activates automatically once that field is populated for a given project, and already works today for anything that does carry it. (b) A lead created before this pass with an older status value ("Visited"/"Junk", from the previous unused 5-value vocabulary) displays with a neutral fallback color until manually updated via the new `StatusEditor` — expected, not a bug, since `leads.status` has no DB-level enum.

---

## -9. 2026-08-13 (bugfix) — Property Search's location autocomplete restored (regression from the earlier "single NL input" pass), shared with AI Search's implementation

**Root cause**: the prior "collapse Property Search to one natural-language input" pass replaced its `LocationCombobox` (chip picker + live autocomplete dropdown) with a **plain `<input>`** — reasonable-looking at the time (matched the requested `[box] [Search]` mock literally) but it silently dropped every bit of the autocomplete/suggestion UX, since a bare `<input>` has none. AI Search, one tab over, was never touched and kept its `LocationCombobox` (with `onSubmit`) the whole time — so it remained the working reference implementation this fix reuses.

### Fix

Property Search's input is now the **exact same `LocationCombobox` component** AI Search already uses (not a rebuilt or parallel one) — same `usePlacesAutocomplete`/`useSuggesterAutocomplete` hooks, same `LOCATION_INDEX` (built from `LOCATION_GROUPS` + the MMR/Pune gazetteer's aliases + `STATION_INDEX`), same `buildSearchSuggestions()` instant-match logic, same keyboard handling (↓/↑/Enter/Escape), same dropdown rendering (name, parent city, right-aligned type badge, hover/highlighted row). Zero new gazetteer, zero new autocomplete logic, zero second parser.

- **New `propertyLocations` chip state** replaces the old plain-text `nlSearchQuery` state. `runPropertySearch()` merges any picked chips into the query text before sending to `/api/nl-filters` — identical merge shape to `runAiSearch`'s existing `aiLocations` merge (skips a location already mentioned in the typed text, synthesizes a minimal query when there's a chip but no other typed words). `/api/nl-filters` → `query-parser.cjs` → `scoring.cjs`/`filtered` all remain completely unmodified; only how the location gets *into* that pipeline changed (typed prose, a clicked suggestion, or both).
- **`LocationCombobox` gained one small additive prop**, `submitLabel` — when set, its built-in submit button renders as a labeled `"🔍 Search"` button instead of the icon-only square AI Search uses; AI Search doesn't pass it, so its own rendering is byte-for-byte unchanged.
- **Clearing** now bumps a `propertySearchResetKey` that remounts the combobox (resets its internal typed text) alongside resetting `propertyLocations`/`locations`/`budget`/`configs`/`possession` — avoids adding any new "controlled text" plumbing to a component that was deliberately uncontrolled.
- **Suggestion ranking tightened**: `buildSearchSuggestions`'s sort now ranks exact match > starts-with > contains (previously only a binary starts-with/doesn't split) — "Goregaon" typing "gore" now reliably outranks a longer, merely-contains-that-substring name.

### Verified this pass — all 10 requested test cases, live in the browser

- **A/B/C/D** — typing `"Bor"`, `"Gor"`, `"Goregaon E"`, `"Liberty"` each showed real, correctly-categorized suggestions while typing (no Search click needed): confirmed live screenshots show `Borivali, Mumbai LOCALITY` + `Borivali, Mumbai TRAIN STATION` + `Borivali East/West LOCALITY` + real matching `PROJECT` rows for "Bor"; `Goregaon East, Mumbai LOCALITY` ranked first (highlighted) for "Goregaon E".
- **E** — bare micro-location `"Liberty Garden"` (no preposition) still resolves via the existing bare-short-query fallback in `query-parser.cjs`'s `extractLocations` (untouched) and returns real ranked results, not an "unrecognized" state.
- **F/G** — `"2 BHK in Borivali East"` and `"2 BHK in Borivali East under ₹1.5 Cr"` still run the full existing NL pipeline: confirmed live — 9 matching projects ranked, real PRIMARY/SECONDARY tiers, real reasons ("Budget fits your ₹75L–150L range · Location matches Borivali East · 2 BHK available"). A full sentence typed as one string doesn't itself trigger a location dropdown (the reused suggestion matcher checks whether a location name *contains* the typed text, and a whole sentence isn't a substring of any location name) — this is identical, unchanged behavior on AI Search's side of the same shared component, not a gap introduced here.
- **H** — Arrow Down then Enter selects the highlighted suggestion, which becomes a chip in the box.
- **I** — Escape closes the dropdown (confirmed dropdown present before, absent after).
- **J** — Clicking the location box's own "🔍 Search" button with no suggestion ever selected still runs the full NL search (confirmed live with `"3 BHK ready possession in Malad"` → 14 matching projects ranked, plus the existing "Also consider nearby: Goregaon, Kandivali, Borivali, Jogeshwari" adjacency suggestions still firing).

`npm run build` clean. `test-indihomes.ps1 -SkipBuild`: all PASS except the pre-existing, documented Meta-sync WARN (unrelated).

### Report, as requested

1. **Which component handles AI Search autocomplete** — `LocationCombobox` (`ProjectSelection.jsx`), backed by `usePlacesAutocomplete`/`useSuggesterAutocomplete` + `buildSearchSuggestions()`/`LOCATION_INDEX`.
2. **What was reused/shared with Property Search** — the entire component, unmodified except one new optional `submitLabel` prop; same gazetteer, same suggestion ranking, same keyboard handling, same dropdown markup.
3. **How micro-location matching works** — `LOCATION_INDEX` includes every `mmr-gazetteer.json` alias (`Object.values(MICRO_ALIASES).map(...)`) alongside curated localities/stations; a bare short query with no preposition falls through to `query-parser.cjs`'s `extractLocations`' third-tier fallback; `scoring.cjs`'s `expandLocationTerm`/`resolveLocationTerms` then expand an alias to its parent suburb + region when actually matching against project data.
4. **How NL parsing remains intact** — `/api/nl-filters` (`query-parser.cjs`'s `parseNLQuery`) is untouched; `runPropertySearch` only changed *what string* gets sent to it (now possibly chip-augmented), never *how* it's parsed.
5. **Files changed** — `src/components/screens/ProjectSelection.jsx` only.
6. **Build/test results** — `npm run build` clean; `test-indihomes.ps1` all PASS bar the documented Meta WARN.
7. **Browser results** — all 10 cases (A–J) confirmed live, screenshots taken for A, C, G, J.

---

## -8. 2026-08-13 (visual-only pass) — Lead Detail View restyled to match the app's design language; `lucide-react` added

Pure visual pass on the Lead Capture full-screen detail view — no data model, lock rules, audit-trail logic, or WhatsApp/Calling not-connected-state logic changed. The view had regressed to a flat list of grey-caption labels and thin `<hr>`-style rules with no card grouping; restyled to match the white-card / colored-left-accent / navy-emphasis language already used in `ProjectIntelligence.jsx` and the Lead Capture table itself.

### What changed

1. **Top chrome restored.** The detail view was a `position:fixed; inset:0` overlay that covered the Sidebar and TopBar entirely. Converted to an in-flow view rendered inside `LeadCapture`'s own return (replacing the table, not overlaying the whole viewport) — Sidebar + TopBar (search box, bell, avatar, theme toggle) now stay exactly like every other screen. The breadcrumb gains the lead's name (`IndiHomes OS / Lead Capture / Usha Sahni`) via a new, generic `breadcrumbExtra` mechanism: `App.jsx` holds the state and clears it on every navigation, `TopBar.jsx` renders it as an optional extra segment, `LeadCapture` calls `onBreadcrumbExtra` when opening/closing a lead — the same "screen-specific prop passed down conditionally" pattern `App.jsx` already used for `onAnalyse`/`selectedProjects`, not a new mechanism.
2. **Header given real weight.** Circular navy initials avatar (e.g. "US"), 26px bold navy name, and the status pill now uses the exact same `STATUS_COLOR` map the Lead Capture table already colors its Status column with (was a flat grey regardless of status before).
3. **Every section is now a real card** — new local `Card`/`SectionCard` components (white, rounded, 4px colored left-accent border per section — navy/green/purple/orange — subtle shadow, real padding), replacing the previous small-uppercase-label-plus-`<hr>` treatment. 16–24px gaps between cards; each section's fields sit in a consistent grid (label above value, equal column widths).
4. **`(locked)` text replaced with a lock icon.** New `lucide-react` dependency (`npm install lucide-react` — confirmed it was **not** already present in this project despite the request assuming so; added as a small, standard, MIT-licensed icon library). `Lock` (11px, muted grey) now sits next to the Name/Phone/Created/CRM Status labels; locked values render with no edit affordance at all.
5. **Edit affordance replaced.** The old `✎` unicode/chevron-reading marker is now a real `Pencil` icon, 60% opacity by default, full opacity + navy on hover — shown on "Not captured" empty values too, so it's clear they're fillable.
6. **Follow-up Timeline + Edit History merged into one `ActivityFeed`.** Previously two differently-styled lists (green-dot-bold-lead-in vs bold-field-name-inline-prose, no dot) stacked on top of each other. Now one chronologically-sorted, day-grouped feed with a single consistent row shape (dot + bold lead-in + muted detail/time) — dot color is the only thing distinguishing event kind (green = new touch, grey = duplicate touch, purple = field edit).
7. **Conversations cards redesigned as real (if empty) features.** `MessageCircle`/`Phone` icons + a plain "Not connected — no activity recorded for this lead yet." line (matching Project Intelligence's icon+reason `EmptyState` convention, no more italic prose) replacing the flat grey box; "▾ View Details" underlined text link replaced with an actual bordered button — muted grey when nothing exists yet, filled navy once a real summary is present — still fully clickable either way so the honest empty state is never hidden behind a truly disabled control.
8. **Typography pass applied everywhere**: labels 11px/uppercase/muted-grey/letter-spaced; values 14px/navy-near-black/medium-weight — applied consistently via shared `fieldLabelStyle`/`fieldValueStyle` constants instead of ad hoc per-field styles.

### Verified this pass

`npm install lucide-react` succeeded (confirmed `Lock`/`Pencil`/`MessageCircle`/`Phone` all exist as named exports before using them). `npm run build` clean (1835 modules now vs 57 before — tree-shaken icon imports only added ~5KB to the gzipped bundle). `test-indihomes.ps1 -SkipBuild`: all PASS except the pre-existing, documented Meta-sync WARN (unrelated to this pass). Browser-driven (Playwright), zero console/page errors: Sidebar and TopBar search box confirmed still visible with a lead open; breadcrumb shows `/ Usha Sahni` and clears back to just `/ Lead Capture` after "← Back to leads"; zero literal `(locked)` text anywhere; all four section cards present with distinct accent colors; unified Activity feed showed a real edit (purple dot) and a real touch (green dot) correctly interleaved and sorted; "View Details" is a real `<button>` and clicking it still reveals the honest "isn't connected yet" state; inline edit → save → new Activity feed entry confirmed still working end-to-end.

---

## -7. 2026-08-13 (production UI/UX + NL search pass) — Property Search collapsed to one NL input, real IndiHomes Score/AI Match distinction, Project Intelligence blank-space root-cause fix, Lead Capture production polish, Meta CAPI reviewed (no bugs)

Ten-part pass. Inspected `STATUS.md`/`requirements.md`/current code before changing anything, per instruction. All changes reuse existing logic — no parallel search implementation, no new scoring system, no fabricated data anywhere.

### 1–2. Property Search — single natural-language input

Removed the Budget/Configuration/Possession dropdowns and the "Select all" button entirely. The Location box + Search button from the previous pass is now the **only** input, reusing `/api/nl-filters` (already existed, already wraps `query-parser.cjs`'s `parseNLQuery` into the exact `{locations,budget,configs,possession}` bucket shape the filtering/scoring code already consumed) — no second parser was written. `runPropertySearch()` POSTs the typed text there and sets the same `locations/budget/configs/possession` state the dropdowns used to set directly, so `filtered`, the gazetteer expansion (`resolveLocationTerms`), `runFilterRank`'s `/api/filter-rank` scoring, and `compareRanked`'s tier sort are all **completely unmodified** — only how those buckets get populated changed.

One real gap found and fixed in the parser itself (not a new parser — one line in the existing `extractPossession`): "3 BHK **ready possession** in Goregaon" (an example this task explicitly required) didn't match the existing `ready to move|immediate possession|move-in ready` regex — added `|ready possession` as a fourth alternative. Verified all required examples directly against `query-parser.cjs`: `"2 BHK in Borivali East"`, `"3BHK under 2 Cr in Malad West"` (no-space BHK), `"2 BHK in Liberty Garden"`, `"3 BHK ready possession in Goregaon"`, `"2 BHK under 1.5 Cr possession before 2027"`, and bare micro-location-only queries `"Liberty Garden"` / `"Gawamin"` (both hit the existing bare-short-query fallback tier, gazetteer expansion happens downstream exactly as before) — all extract correctly.

Rank labels (PRIMARY/SECONDARY/TERTIARY) already only rendered behind `hasActiveFilter` from the previous pass — reused as-is; an NL search that extracts nothing at all now shows an inline note ("Couldn't identify a location, BHK, budget, or possession...") instead of silently doing nothing. Result count text now reads "N projects available" pre-search vs "N matching projects ranked" post-search — previously said "ranked" unconditionally even on a bare unfiltered browse.

Dead code removed: `Field`, `MultiSelect` components, `locationOptions`, `MAHARASHTRA_LOCATIONS`, `allFilteredSelected`, and the Azure facet-count fetch effect (`configCounts`/`budgetCounts`/`possessionCounts`) — all only existed to feed the now-removed dropdowns.

### 3. Project Intelligence — IndiHomes Score vs AI Match, made genuinely distinct

**Real bug found**: `indihomes-client.cjs`'s `attachScore()` sets `match: score` verbatim — every official-IndiHomes-catalog project's "AI Match" was always the exact same number as its "IndiHomes Score," just under a different label (confirmed live: a project analysed without an active search showed "70/100" and "70%" side by side). No real per-search match value was ever plumbed from Property Search into Project Intelligence at all — `handleAnalyse` only ever forwarded the raw cached project object.

Fixed by attaching the **real** existing per-search score: `handleAnalyse` now reads `filterAnalysis[project.name]?.match_score` (already computed by `/api/filter-rank` for the cards on screen) onto each analysed project as `matchScore`; AI Search's `toAnalysableProject` does the same with its own real `match_score`. Project Intelligence's "AI Match" now reads `current.matchScore` exclusively — shows the real number when one exists, an honest "Not calculated — open from a search result to see a match score" when it doesn't (never falls back to IndiHomes Score). Verified live: a project opened directly (no search) shows AI Match "—"; the same project opened after `"2 BHK in Malad West"` shows a real, different 96% next to an 80/100 IndiHomes Score. Both KPI cards' vague fixed trend text ("Top 5% portfolio", "Excellent fit" — shown regardless of the actual number) replaced with a real tier word derived from the actual score (`scoreTierLabel()`, same 80/60/40 boundaries `scoring.cjs`/Property Search ranking already use) plus a `title` tooltip clarifying the two are different calculations. `StatCard` (shared component, used by 3 other screens) gained an optional, backward-compatible `title` prop for this.

### 4 + 8. Project Intelligence — root cause of the blank-space problem, general compact pass

**Root cause**: all 4 two-column card rows used `display:'grid', gridTemplateColumns:'1fr 1fr'` with no `alignItems` — CSS Grid's default (`stretch`) forces every card in a row to match its tallest sibling. USP Extraction (a handful of chips) was being stretched to match Target Audience's much longer list; Nearby Infrastructure (category chips only, pre-selection) was stretched to match the Location Map's ~500px height. Fixed with one property per row: `alignItems:'start'` — confirmed via direct DOM measurement that the Nearby Infrastructure card itself was already only 88px tall; the "blank space" was grid-cell padding, not card content. This single fix resolved the reported blank-space complaint in Inventory, USP, and Nearby Infrastructure simultaneously, with no negative margins anywhere.

### 5. Project Intelligence — Description source badge removed from UI only

Removed the `SourceTag`/`FieldBadge` next to "Project Description" — frontend rendering only. `official?.description`/`displayDescription`'s official-first resolution logic is untouched; provenance is still visible on every other card (RERA, Inventory, Nearby Infrastructure, Competitor Analysis all keep their badges).

### 6. USP Extraction — compact

Resolved as a direct consequence of the grid-stretch fix (#4) — verified live the card now sizes to header + chips + footer only, no separate change needed. Chip `cursor:'pointer'` styling exists with no click handler wired (pre-existing, not something to "preserve" since it was never implemented) — left as-is per instruction not to add new functionality.

### 7. Nearby Infrastructure — visual polish

Split the combined `"Hospital · 0.5 km"` type+distance string (baked into one field, `item.dist` was consequently always undefined for real OSM data) into separate `type`/`dist` fields so distance renders as its own right-aligned badge — genuine icon + name + distance row layout, per spec. Tightened row padding 10px→7px, icon 18px→15px, dropped the redundant category sub-label under each name (redundant once already filtered to that category via the active chip). Category chips/active-state/empty-state logic reused unchanged from the previous pass.

### 9. Lead Capture — production polish

**Table**: condensed 10 columns → 7 (Lead = name+phone stacked; Requirement = configuration · budget · location joined on one line) — same real data, fewer competing columns, matching how a real CRM list view groups secondary fields. Added a small color-coded source dot (`SOURCE_COLOR`) instead of a third pill column, per the "avoid unnecessary pills everywhere" instruction. Header row tightened, hover state simplified, wrapped in a horizontal-scroll container for narrow viewports.

**Detail view**: reorganized into the four requested named sections (`Section` component, shared header style) — **Lead Overview** (name/phone/source/created — locked — plus CRM status, moved up from its own footer), **Requirements** (project/configuration/budget/location/possession date/amenities/notes, all still inline-editable via the existing `EditableField`/`PATCH /api/leads/:id`), **Activity** (follow-up timeline + edit history, unchanged), **Conversations** (WhatsApp Bot / AI Calling Agent, unchanged honest "not connected" stubs + View Details drill-down). All existing backend behavior — editable-field allowlist enforced server-side, audit trail, locked fields, CRM badge — verified still working live (inline edit → save → audit trail entry appeared immediately).

### 10. Meta CAPI — reviewed, no code changes (no bug found)

Full review against `meta-capi.cjs`, `server.cjs`'s `runMetaCapiSync`/`POST /api/leads/sync-meta-capi`/hourly interval, and `db.cjs`'s `meta_capi_log` table:

1. **Fully implemented?** Yes — event building, SHA-256 phone hashing (E.164-normalized, handles both bare-10-digit Indian numbers and already-country-coded numbers correctly), Graph API POST, retry-safe logging, manual endpoint, hourly interval are all real and wired end-to-end.
2. **Configured in this environment?** No — confirmed via the server's own startup log (`Meta Conversions API: not configured`) and a live `.env` read: `META_CAPI_ACCESS_TOKEN`, `META_DATASET_ID`, `META_CAPI_TEST_EVENT_CODE` are all empty.
3. **Missing env vars?** `META_CAPI_ACCESS_TOKEN` and `META_DATASET_ID` (both required — `isConfigured()` needs both). `META_CAPI_TEST_EVENT_CODE` is optional (testing only). Exact setup steps already in `requirements.md`.
4. **Events currently sent?** None — `isConfigured()` gates both the manual endpoint (503s, confirmed live) and the hourly interval (never even registers `setInterval` when unconfigured).
5. **What would trigger them?** A Meta-sourced lead's `crm_status` resolving to `success` or `failed` (i.e., `INDIHOMES_LEAD_PUSH_ENABLED=true` and a push attempt actually running) — `not_pushed` is deliberately excluded as "no decision made yet."
6. **Duplicate prevention?** `db.hasSuccessfulCapiSend(leadId, crmStatus)` — a `crm_status` value already reported successfully is never resent; a genuine transition (e.g. failed→success on retry) sends a fresh event, which is correct behavior, not a duplicate.
7. **Steps to test in Events Manager**: set `META_CAPI_ACCESS_TOKEN`/`META_DATASET_ID` per `requirements.md`'s step-by-step, add `META_CAPI_TEST_EVENT_CODE` from the dataset's Test Events tab, get at least one Meta-sourced lead to a resolved `crm_status` (needs `INDIHOMES_LEAD_PUSH_ENABLED=true` + a working `META_PAGE_ACCESS_TOKEN`), run `POST /api/leads/sync-meta-capi`, confirm the event appears in Events Manager's Test Events tab, then remove the test event code to go live.
8. **Bugs/risks found?** None. Noted in passing (unrelated to CAPI, found via a live UI screenshot during this pass): this environment's `META_PAGE_ACCESS_TOKEN`/`META_ACCESS_TOKEN` **is** set but currently invalid — the Lead Capture status strip shows a real live error, `Meta Graph 400: The access token could not be decrypted`. That's a credential-rotation issue for whoever manages this environment's `.env`, not a code bug — flagging here since it blocks Meta lead sync (and therefore CAPI, downstream) independent of the CAPI credentials themselves.

**No live Meta CAPI test was run or claimed** — credentials are absent, so nothing was sent to Meta.

### Verified this pass

`npm run build` passes (7 incremental runs, one per major change, all clean). `node --check` on `query-parser.cjs`. `test-indihomes.ps1 -SkipBuild`: all PASS except the pre-existing, documented Meta sync WARN. Browser-driven (Playwright) verification, zero console/page errors throughout: Property Search (all dropdowns/Select-all gone, single input, no rank labels pre-search, real ranked results + "Search understood" chips post-search for `"2 BHK in Borivali East"` and bare `"Liberty Garden"`); Project Intelligence (real distinct IndiHomes Score 80/100 vs AI Match 96% on the same project, description card with no source badge, USP card compact, Nearby Infrastructure category-gated with clean icon+name+distance rows, Target Audience sorted High→High→High→High→High→Medium→Low live); Lead Capture (CRM push chip gone, condensed table, four-section detail view, inline edit + audit trail still fully functional).

---

## -6. 2026-08-13 (follow-up) — Meta lead ingestion + Conversions API reporting; Lead Capture detail view rebuilt as full-screen with inline edit + audit trail

Two-part follow-up. **Read this before touching Meta sync or "CRM status" anywhere in this app** — it corrects a real, likely-intuitive-but-wrong assumption.

### Investigation finding, before any code was written (per explicit instruction to report back first)

The prompt assumed a "CRM status" concept meaning interested/not-interested/qualified/disqualified. That doesn't exist anywhere in this codebase. What actually exists:
- **`leads.crm_status`** (`not_pushed` / `success` / `failed`) — literally just whether the push to IndiHomes' own `createLead` API succeeded. This is what the Lead Capture table's "CRM" column (`CrmBadge`) has always shown. **Confirmed with the user this is the intended source of truth** for both this pass's CAPI job and the locked detail-view field — used as-is, not translated into invented qualification language.
- **`leads.status`** (`New`/`Contacted`/`Visited`/`Junk`/`Negotiation`) — a different field under a different column ("Status", not "CRM"), closer in spirit to a pipeline stage but has no edit UI and was 100% `New` across all 49 real leads at investigation time (never set by anything).
- **A real, separate bug was found and fixed as a prerequisite**: `indihomes-leads-client.cjs`'s `createLead()` had its actual `fetch()` call commented out while the code right after still referenced the resulting (undefined) `res` — every push attempt was silently throwing `ReferenceError: res is not defined`, so `crm_status` could never reach `'success'` even with `INDIHOMES_LEAD_PUSH_ENABLED=true`. **Confirmed with the user and fixed** — restored the real fetch call. Still fully gated behind `INDIHOMES_LEAD_PUSH_ENABLED`, so no behavior change for any deployment where that's unset.

### Part 1 — Meta lead ingestion + Conversions API

- **Auth fix**: `meta-client.cjs` now reads `META_PAGE_ACCESS_TOKEN` (new, explicit name — a **Page** token; a user token here is exactly what produces Graph API's `(#10) User has insufficient privileges on the page`), falling back to the old `META_ACCESS_TOKEN` name for back-compat. Documented in `.env.example`/`requirements.md` with the required scopes (`leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `ads_management`) and exact step-by-step token-generation instructions.
- **Meta leads never require a `project` field** — already true before this pass (`resolveProjectCode()` was already null-safe, `normalizeMeta()` already falls back to the ad form's own name); confirmed nothing crashes on a Meta lead with no matched project. Meta leads are now additionally identified by `ad_id`/`campaign_id`/`form_id` — new columns on `leads` (additive `ensureColumn` migration), extracted in `lead-intake.cjs`'s `normalizeMeta()`, fetched via `meta-client.cjs` (added `ad_id`/`campaign_id` to the Graph API fields list; `form_id` is injected by `syncMetaLeads` since it's implicit from the `/{form_id}/leads` endpoint, not part of the per-lead payload). Reuses the exact same intake pipeline (`db.intakeLead`) and dedup/merge logic Housing.com already uses — no parallel system. A "Meta Ad" filter chip appears automatically in the existing source-filter UI once Meta leads exist (`bySource` is already computed from real data, no hardcoded tab was needed).
- **New `meta-capi.cjs`** — Conversions API client. Event names are honest about what the data actually means: `Lead_CRM_Push_Success` / `Lead_CRM_Push_Failed` (not an invented "Qualified_Lead"), fired only for leads whose `crm_status` has actually resolved (`not_pushed` is skipped — no decision made yet). `event_id` = internal lead id, `user_data.ph` = sha256 of the phone (E.164-normalized, no leading `+`), `lead_id` = the real Meta leadgen id (reused from `lead_touches.source_lead_id`, not stored a second time). POSTs to `https://graph.facebook.com/v21.0/{META_DATASET_ID}/events`, supports `META_CAPI_TEST_EVENT_CODE`.
- **Retry-safe logging** — new `meta_capi_log` table (db.cjs): a `crm_status` value already reported successfully for a lead is never re-sent (`hasSuccessfulCapiSend`), but a genuine transition (e.g. a failed push later retried and succeeding) sends a fresh event. Backend-only, no UI: `POST /api/leads/sync-meta-capi` (manual/cron trigger) plus an hourly interval, both gated behind `metaCapi.isConfigured()`.
- Verified live: server boots clean with the new `Meta Conversions API: not configured` startup log line (honest — no `META_CAPI_ACCESS_TOKEN`/`META_DATASET_ID` in this environment); `POST /api/leads/sync-meta-capi` correctly 503s with a clear message when unconfigured.

### Part 2 — Lead Capture detail view: full-screen, editable, audited, with conversation drill-down

- Replaced the centered popup modal (from an earlier pass) with `LeadDetailView` — a genuine full-viewport overlay (`position:fixed; inset:0`, covers the sidebar too, "← Back" instead of a corner ×), not a dialog.
- **Editable fields**: project, configuration, budget, location, email, possession date (new `leads.possession_date` column — didn't exist before), amenities (new `leads.amenities` column — didn't exist before), notes. Each is click-to-edit (`EditableField`) via a new `PATCH /api/leads/:id`, which enforces the editable set server-side via `db.EDITABLE_LEAD_FIELDS` regardless of what a request sends (verified live: a PATCH including `name` alongside a real field returns `changed:["budget"], rejected:["name"]` — locked fields can't be edited even by a direct API call, not just hidden in the UI).
- **Locked, never editable**: name, phone, first-captured timestamp, and CRM status (`crm_status` — shown honestly labeled "CRM status (locked)", using `CrmBadge`, the exact same source of truth as the table's CRM column, per the investigation above).
- **Edit audit trail** — new append-only `lead_edits` table (same shape convention as `lead_touches`): one row per field actually changed (a PATCH that sends a value equal to the current one logs nothing — not a real edit), with old/new value + timestamp. No logged-in-user system exists in this app yet (checked before assuming one) — `edited_by` stays null, timestamp-only, exactly as the prompt allowed. Rendered as "Budget changed from ₹85 L – ₹2.37 Cr to ₹1.8–2.2 Cr · 13 Aug 2026, 3:41pm" style entries.
- **"View Details" under WhatsApp Bot / AI Calling Agent summaries** — two new backend stubs, `GET /api/leads/:id/whatsapp-conversation` and `GET /api/leads/:id/call-transcript`, since neither conversation data source exists yet (confirmed: no external DB/API wired in anywhere). Both return an honest `{connected:false, ...}` shape with a `TODO(...)` comment in the code describing the real shape to return once a real source exists (phone-number-keyed, matching this app's existing lead-identification model) — no fabricated sample conversation data. The frontend's `ConversationPanel` shows "Conversation history isn't connected yet." for this state, matching the existing WhatsApp/Call summary cards' own "Not connected" convention.
- Verified live (Playwright, zero console/page errors both runs): full-screen view opens on row click (not a centered dialog), locked Name/CRM-status fields render correctly, an inline edit (Location → "Test Edited Locality XYZ") saves and appears in the Edit History section immediately, both View Details buttons expand to the honest not-connected empty state.

### Also fixed as a byproduct

`indihomes-leads-client.cjs`'s `createLead()` — see the investigation finding above. This is the one change in this pass that affects a currently-live code path (if `INDIHOMES_LEAD_PUSH_ENABLED=true` is ever set), so flagging it prominently here rather than burying it in Part 1.

### Verified this pass

`npm run build` passes. Every touched `.cjs` file passes `node --check`. Cold server restart (`npm run server`) boots clean with two new honest startup log lines (`Meta Conversions API: not configured`). Live endpoint checks: `PATCH /api/leads/:id` enforces the editable-field allowlist server-side, `GET /api/leads/:id/edits` returns real audit history, both conversation stubs return the honest not-connected shape, `POST /api/leads/sync-meta-capi` 503s cleanly when unconfigured. Browser-driven (Playwright) full click-through of the new detail view with zero console errors.

### What still needs real credentials to fully exercise this pass

- **`META_PAGE_ACCESS_TOKEN`** (correct scopes) — to confirm the actual Meta lead pull works end-to-end against a live Page and produces leads without a project field breaking anything (structurally verified via code + null-safety checks; not yet run against a live Meta account with a working token in this environment).
- **`META_CAPI_ACCESS_TOKEN`** + **`META_DATASET_ID`** — to send a real test event via `META_CAPI_TEST_EVENT_CODE` and confirm it appears in Events Manager, per the original test plan's explicit ask. Not yet run live in this environment (neither var is set).

See `requirements.md` for exact, minimal step-by-step setup for both.

---

## -5. 2026-08-13 — Property Search rename + MMR gazetteer expansion, AI Search location picker, tier-first ranking, Project Intelligence (description clamp / categorized infra / reworked Location Quality Score / real Competitor Analysis), Lead Capture detail modal

Large batch covering six areas (A–F below), worked one fully before moving to the next per instruction. Nothing here touches `ANTHROPIC_API_KEY` (still intentionally unused) or reconnects the dead 99acres/MagicBricks scraper to Filter Search's official-only cache. Verified live: server restarted cold (`npm run server`, which now auto-frees port 3001 via the pre-existing `scripts/free-port.mjs` preserver hook), `npm run build` passes, and a Playwright-driven click-through of all four changed screens showed zero console/page errors.

### A. Filter Search → renamed "Property Search"; NL box removed; MMR gazetteer expanded

- Removed the `nlQuery`/`runNlFilters` "Or describe it in one line…" input + "Fill filters" button entirely from `ProjectSelection.jsx` (the four structured fields — Location/Budget/Configuration/Possession — are untouched). `/api/nl-filters` stays on the server, just unused now; not deleted since nothing else depends on removing it.
- Renamed the tab label "⚙ Filter Search" → "⚙ Property Search" and every user-facing copy that named it (AI Search's "see Filter Search for official IndiHomes projects" banner, the search-history panel description). Internal code comments/dev docs still say "Filter Search" — that's the mechanism's established name in this codebase's history, not user-facing text, so left alone.
- New `mmr-gazetteer.json` (repo root) — a shared MMR + Pune micro-locality gazetteer, consumed by both the frontend (via a native JSON import) and every relevant backend `.cjs` file (via `require`), so all four surfaces agree on the same locations:
  - `cities`: suburb/region-level names, unioned into `ProjectSelection.jsx`'s existing `LOCATION_GROUPS` (never replacing it — regression-safe by construction) and adding two brand-new region buckets that didn't exist before at all: **Vasai-Virar** and **Mira-Bhayandar**.
  - `aliases`: ~90 smaller pockets (Kandarpada, Mandpeshwar, Eksar, Devipada under Borivali West; Gawamin, Bhuigaon under Vasai West; etc.) that resolve to a parent suburb + region even with zero backing listings — a `resolveLocationTerms()`/`expandLocationTerm()` helper (duplicated per-file, matching this codebase's existing small-independent-copies convention) expands a typed alias into itself + canonical + parent + city before every location match.
  - Wired into: `LocationCombobox`'s instant suggestion list (`LOCATION_INDEX`), `scoring.cjs`'s `scoreLocation`/`scoreExternalLocation`, `azure-search.cjs`'s `SYNONYM_MAP` (alias equivalence groups, e.g. `gawamin, vasai west, vasai, vasai-virar`, added to both the listings **and** external index's `city`/`location`/`community` fields, which didn't carry a synonym map before this pass) plus the suggester sync (alias rows injected directly, since Azure's `/docs/suggest` endpoint doesn't apply synonym-map expansion — confirmed via Azure's own docs, not assumed), and `legacy-portal-connector.cjs`'s `resolveCities()`.
- Verified live: `GET /api/search-suggest?q=gawamin` → `{"name":"Gawamin","type":"LOCALITY","area":"Vasai West","count":0}` (recognized, honest zero — not "location not understood"). Regression-checked Malad/Goregaon/Andheri all still resolve with real non-zero counts (`Malad West: 25`, `Goregaon West: 34`, `Goregaon East: 7`) and real project matches.

### B. AI Search — structured location picker added alongside the freeform box

- Added the same `LocationCombobox` (reused component, same gazetteer) above AI Search's query bar. Picking a chip is passed as an explicit `filters.locations` array to `POST /api/ai-search` (the reliable path — `external-connectors.cjs`'s `search(query, filters, market)` signature already accepted `filters`) and is also folded into the query text sent to connectors that only ever look at raw text (Google CSE, Bing) — skips a location already typed, so it never doubles up.
- `server.cjs`'s `/api/ai-search` now merges `req.body.filters.locations` into the query-parsed locations before calling `queryExternal`.
- Freeform box stays for budget/config/possession/NL extras — relabeled "Add keywords…" now that location has its own control.
- Verified live: `POST /api/ai-search {query:"properties in Gawamin", filters:{locations:["Gawamin"]}}` → `filters.locations:["Gawamin"]` echoed back correctly, 0 properties, no scary warning (real connectors ran, found nothing — honest empty state).

### C. Ranking — tier sorts before score everywhere

- Grepped every `.sort()` site touching rank/tier/score across both frontend and backend. Found the real bug: **Filter Search's card list had no sort at all** — `filtered.map()` rendered cards in raw API order, each card independently showing its own PRIMARY/SECONDARY/TERTIARY badge with no relationship to on-screen position. Added `compareRanked()` (tier-first via the exact same 80/60/40 thresholds `server.cjs`'s `/api/filter-rank` already buckets by, score second within a tier) and a `sortedFiltered` array used only for display order (the underlying `filtered` array is untouched everywhere else — selection, `/api/filter-rank`'s payload, history logging).
- AI Search's `RankedResults` was audited too: its PRIMARY/SECONDARY/TERTIARY badge is deliberately position-only (a prior, documented decision — a score-threshold approach let two results both show PRIMARY), and the array feeding it is already sorted by score (`external-search.cjs`), so tier and order were already self-consistent there — no bug, no change needed, confirmed by reading rather than assumed.

### D. Project Intelligence

1. **Description clamp** — new `ExpandableBlock` wrapper (CSS `max-height`/`overflow` clamp, not string truncation, so markdown never breaks mid-element) caps the description to ~175px (~7-8 lines) with a "▼ Read more"/"▲ Show less" toggle. Measures real `scrollHeight` after render so short descriptions get no button at all. Verified live against Chaitanya Ethics Orovia's real (long) description: toggle appears, expands/collapses correctly, zero console errors.
2. **Categorized Nearby Infrastructure** — grouped the real Overpass categories `server.cjs`'s `OVERPASS_CATEGORIES` already classifies (School/College/University → Schools; Hospital/Pharmacy → Hospitals; Mall/Supermarket → Shopping; Park → Parks; Railway-Metro/Bus Station → Transit; Bank → Banking; Cinema/Tourist Attraction → Entertainment) into multi-select toggle chips, each showing a real count, defaulting to all-combined until one is toggled. Deliberately did **not** invent a "Gym" bucket (mentioned in the request but not a category this data actually classifies) — used only categories confirmed present in the real feed.
3. **Location Quality Score reworked** — was `categories.size * 10 + proximity buckets`, which hit 100/"Excellent" with as few as 5 categories present at any distance (the reported live symptom). Now: per-category score = sum of linear distance-decay weight (1 at 0km → 0 at the 5km search radius) for its closest 3 places, capped at 2.4/category; final score normalized against an 8-category realistic-excellent target; tier bar raised (Excellent now needs 80+, was 75+). Fully deterministic, no LLM.
4. **Competitor Analysis replaced** — was 100% dependent on Claude web research (permanently "Not found" — no `ANTHROPIC_API_KEY` in this deployment, per this file's existing "known limitation" section). New `GET /api/competing-projects` (server.cjs) calls Google Places API (New) Text Search, biased to a 3km circle around the project's own real coordinates — reused from `NearbyMap`'s existing geocoding (`onGeo` callback added, no re-geocoding), never fabricated. Shows real name/distance/Google Maps link, labeled "Verified · Google Places" the same way Nearby Infrastructure labels its OSM data. New env var: `GOOGLE_PLACES_API_KEY` (see requirements.md — falls back to `VITE_GOOGLE_MAPS_KEY` if unset). Honest "Not connected" state when the key is missing; honest "No competing projects found within 3km" when the search genuinely finds nothing.

### E. Lead Capture — clickable lead detail modal

- Every lead row is now clickable (generic, works for any `primary_source`) → opens `LeadDetailModal`: Customer Info (name/phone/location/created-at/source/project — all already-captured fields, no new ones invented), Requirement (configuration/budget — real fields; possession date/amenities honestly labeled "not captured by this lead's intake source today" since `db.cjs`'s `leads` table genuinely has no column for either, confirmed by reading `lead-intake.cjs`'s normalizers before assuming), a Follow-up Timeline built from the real `lead_touches` table (already existed, exposed via the already-existing but previously-unused `GET /api/leads/:id/touches` — grouped by day with relative times, not a flat raw-timestamp list), and WhatsApp Bot / AI Calling Agent summary cards.
- `db.cjs` migration (additive `ensureColumn`, safe on an existing DB): `leads.whatsapp_summary`, `whatsapp_summary_at`, `call_summary`, `call_summary_at` — confirmed no such column/table existed before this pass. No pipeline populates them yet (WhatsApp Agent / AI Calling Agent are still separate sidebar modules with no lead-level data flow into this table) — the modal shows an honest "Not connected — no activity recorded for this lead yet" rather than a fabricated summary, per this app's existing never-fabricate convention. "Transfer to Loan CRM"/"Fetch History" style buttons were explicitly left out (no matching real endpoint); the existing `INDIHOMES_LEAD_PUSH_ENABLED` CRM-push status is surfaced in the modal instead, since that's the one real outbound integration this app has.
- Verified live: clicking a real lead row opens the modal with real data, Follow-up Timeline renders real touch history, zero console errors.

### F. Production-readiness

- `npm run build` passes. Every touched `.cjs` file passes `node --check`. Cold server restart (`npm run server`, port auto-freed) boots clean — `[startup] Integration status:` now also logs `Competitor Analysis (Google Places): not configured` (honest, since no key is set in this environment yet).
- Playwright click-through: Property Search (tab renamed, NL box gone, Gawamin resolves + selects), AI Search (location combobox + keyword box both present and functional), Project Intelligence (Read more/Show less, categorized Nearby Infrastructure, Location Quality Score, Competitor Analysis card all render), Lead Capture (row click → modal with Follow-up Timeline) — zero console/page errors across all four.
- No hardcoded fallback numbers introduced anywhere in this batch — every new empty state (Competitor Analysis unconfigured/empty, WhatsApp/Call summary not connected, possession/amenities not captured) is an honest message, not a guessed value.

---

## -4. 2026-08-12 (follow-up) — Filter Search score visibility, real AI Search match scoring (this time confirmed live), lowercase-query fix, Leaflet map display; Dubai auto-switch verified already working

Four reported issues plus one added-mid-task request ("add a display of the map"). Did not touch Meta/lead-capture code, per instruction. All verified live against the running server + browser, not read-for-plausibility.

### 1. Filter Search — score/match hidden until a filter is actually applied

`ProjectCard` now takes a `hasActiveFilter` prop (single shared `hasActiveFilter` const in `ProjectSelection.jsx`, replacing three separate inline recomputations of the same `locations.length > 0 || budget !== 'All' || configs.length > 0 || possession !== 'All'` check). With no filter active, the score column shows a plain "—  NO FILTER YET" instead of `scoring.cjs`'s completeness-only baseline score — everything else (cards, images, RERA badges, rank pills) stays exactly as before. Also hardened `configs`'s local filter-array check to lowercase both sides (was case-sensitive, though never a live bug since both sides are always the same fixed-case "N BHK" strings from this app's own MultiSelect + `normalizeConfig` — see item 4).

Verified: fresh page load shows "— NO FILTER YET" on all 153 cards; applying a "Malad" location filter immediately shows real scores (70/80/70…) with "Drishti AI is scoring these matches against your filters…".

### 2. AI Search match % — actually fixed and verified this time

The previous session's report claimed this fix (weighted budget/location/config/possession scoring) had already landed, and the code was indeed already present and wired correctly — but re-testing the exact reported query shape (`"properties in Daulat Nagar"`, a location-only query with no BHK/budget) reproduced the flat-score symptom anyway: **every result tied at 89%.** Root cause: when a query specifies only ONE filter dimension (location — the most common real AI Search phrasing), budget/config/possession are correctly excluded as "not applicable" (same explainable-degrade rule `scoreIndiHomesProject` already uses), which left location as the *only* scored dimension — so a generic aggregator page ("Daulat Nagar, Mumbai: Map, Property Rates, Projects") tied with an actual listing ("1 BHK Flats for Rent in Daulat Nagar") purely because both mention the locality.

Fixed by widening `scoreExternalQualityPts()` (the ~10% tie-breaker bucket) to also reward real data-completeness/listing-specificity signals that are **not gated on what the query asked for**: `+10%` for a published configuration, `+10%` for a published price, `-20%` for a name matching aggregator-page patterns (`map`, `property rates`, `photos & video`, `video tour`, `: overview`). These now also push their own `reasons` entries, so the "Why" line is genuinely per-result instead of a static template.

Verified live with the exact Daulat Nagar query: 18 results now spread from 94% (real listing, config+price published) down to 83% (aggregator pages, correctly penalized) and 20% (a Siddharth Nagar/Goregaon result — genuine location mismatch), with reasons like *"Configuration published (1 BHK) · Price published"* vs. *"Reads like a general info/aggregator page, not a specific listing"* varying per result. Also re-verified the earlier Goregaon West example still differentiates correctly (93%/47%) — this change is additive, doesn't regress the location/config/budget/possession scoring already in place.

### 3. Dubai auto-switch — verified already working, not reproducible

Checked `DUBAI_TERMS`, the effect wiring, and whether `runAiSearch` uses live query text vs. stale state — all correct on inspection. Rather than trust that, tested live with the exact reported repro (market toggle on India, search `"2 bed apartment in Dubai Marina under AED 2M"`): the actual POST body sent to `/api/ai-search` was `{"query":"...","market":"dubai"}` (captured via network inspection, not just UI text), the "Switched to Dubai / UAE" note appeared, and the response came back with 20 real AED-denominated Dubai Marina listings at high match scores (98%, 74%, 73%). **This is not currently broken** — either it was already fixed by the time this session started, or the original report was against a stale build. No code change made; flagging this rather than "fixing" something that isn't reproducible.

### 4. Case-sensitivity audit — one real bug found and fixed, everything else confirmed already correct

Audited every comparison point named in the request:
- `ProjectSelection.jsx`'s client-side `filtered` hay-string check — confirmed already lowercasing both sides (location); config comparison hardened defensively (see item 1), though not a live bug.
- `scoring.cjs`'s `scoreLocation`/`scoreConfig` (Filter Search) and the new `scoreExternalLocation`/`scoreExternalPossession` (AI Search) — confirmed already lowercasing both sides of every comparison.
- `azure-search.cjs` — confirmed no field (`city`/`location`/`nearbyLocality`/`community`/`configuration`) has a custom analyzer override, so `search.ismatch()` full-text queries use Azure's default standard analyzer (case-insensitive by design). The one filter using exact-match `search.in()` (`config/any(...)` in `buildODataFilter`) IS case-sensitive by Azure's own semantics, but both sides always carry this app's own fixed-case `"N BHK"` strings (from `normalizeConfig` and the frontend's fixed MultiSelect options) — confirmed consistent, not a live bug, documented as a latent risk if that invariant ever changes.
- `legacy-portal-connector.cjs`'s `locTokens`/`configTokens` matching — confirmed already lowercasing both sides at comparison time.
- `indihomes-client.cjs`'s `normalizeConfig` — tested directly: `"2bhk"`, `"2BHK"`, `"2 Bhk"`, `"2  bhk"` all normalize to the identical `"2 BHK"` and correctly dedupe via the `Set`.
- **`query-parser.cjs`'s `extractLocations` — the one real bug.** Tested directly: `extractLocations('malad')` (bare lowercase, no preposition) returned `[]`, while `extractLocations('Malad')`/`extractLocations('MALAD')` correctly returned the location. Root cause: the fallback path only matches `[A-Z][a-zA-Z]+` word runs (Title/ALL-CAPS), and the stopword check compared against `BHK_STOPWORDS`'s Title-Case entries directly (case-sensitive `Set.has()`, so it silently failed to filter stopwords typed in lowercase too). Fixed: added a lowercase companion stopword set (`isStopword()` helper, used everywhere `BHK_STOPWORDS` was checked) and a third fallback tier — a short (≤4 words), punctuation-free, digit-free bare query with no preposition and no Title Case at all is now treated as the location itself, deliberately narrow so it can't false-positive against a real multi-clause sentence. The phrase-based primary path (`"in/at/near/around X"`) was already fully case-insensitive and needed no change.

Verified: `extractLocations('malad')`, `('Malad')`, `('MALAD')`, and `('malad west')` all now resolve correctly; a normal lowercase sentence (`"i need a nice house near the market..."`) still extracts via the existing phrase-based path without hitting the new bare-query fallback.

### Also implemented: real map display in Project Intelligence (not in the original 4 items)

The "Open in Google Maps" *link* was already fine (a plain external URL, works regardless of any API key), but the *embedded* map was silently broken — it called the Google Maps JS SDK, which fails without `VITE_GOOGLE_MAPS_KEY` (unset in this deployment) and rendered only an error message ("Google Maps failed to load…"). Notably, `NearbyMap`'s own code comment had claimed *"real, interactive OpenStreetMap (Leaflet, no API key/billing)"* the whole time — the implementation never actually matched that comment.

Replaced the Google Maps JS calls with real Leaflet + OpenStreetMap tiles, loaded from a CDN (`unpkg.com/leaflet@1.9.4`, script-injected the same way the old Google Maps loader worked — no new npm dependency). Genuinely no API key or billing required. Project marker (navy, or orange when using the approximate-location fallback) plus every real Nearby Infrastructure pin now render on an actual interactive map with popups, zoom, and pan. Removed the now-fully-unused `loadGoogleMapsScript`/`_gmapsLoadPromise` from `ProjectSelection.jsx` (its only other caller, Places Autocomplete, already calls the Places REST API directly and never used the Maps JS SDK).

Verified live: Ethics Orovia's Location Map card now shows real OpenStreetMap tiles of Malad West with a marker at the project location and pins for every real nearby hospital/bank/school from the Nearby Infrastructure list, confirmed via the `.leaflet-tile-pane` DOM element and a full screenshot — no console/page errors.

### Verified this pass

`npm run build` passes. `test-indihomes.ps1 -SkipBuild` passes (one transient Dubai-endpoint timeout on first run, clean PASS on immediate retry — the same known network-latency variance documented in the previous entry, not a regression). Browser-driven (Playwright) verification for all five changes above, including actual network-request-body inspection for item 3 rather than just UI text.

---

## -3. 2026-08-12 (deep pass) — Project Intelligence data-quality fixes (description rendering, unit mix, geocoding, audience targeting), Project Intelligence UI polish, `requirements.md`, AI Search de-diagnosed for end users + real match scoring

Large follow-up pass covering 10 numbered items. All verified live (server restarted, browser-driven checks against the real running app with Playwright, not just read-for-plausibility) against `Chaitanya Ethics Orovia` (`INV_MW_441`) and a live `2 BHK apartment in Goregaon West` AI Search query. Every code change below is deterministic — no LLM call was added or required by anything in this pass.

### 0. Verified the description-markdown fix — found and fixed a real remaining bug

The previously-applied fix (`DescriptionMarkdown` inserting line breaks before inline `###`/`*` markers) was necessary but had two real defects, confirmed by testing against Ethics Orovia's actual live description text:

1. **Root cause was upstream, not in the frontend at all.** The raw IndiHomes API response has *perfectly structured* real markdown (`"# Heading\n\nParagraph\n\n### Subheading\n\n* bullet\n* bullet"` — confirmed via a direct `fetchProjectByName` call). `indihomes-client.cjs`'s `clean()` (`.replace(/\s+/g, ' ')`) was collapsing all whitespace *including real newlines* into single spaces before the description ever reached the frontend — that's what actually flattened it into one giant blob. Fixed with a new `cleanDescription()` that only collapses horizontal whitespace and 3+ blank lines, preserving real paragraph/heading/bullet breaks. The frontend's regex-based reconstruction is now a fallback for other text sources (e.g. Claude research prose) rather than the primary fix.
2. **The frontend fallback regex itself had a self-overlap bug**, only visible now that real newlines exist and headers get their own line: `[^\n]` matches *any* non-newline character — including `#` itself. On `"\n\n### Configuration & Pricing"`, the old regex could start its match AT the first `#` (matching it as the "preceding non-newline char"), then match the remaining `"## "` as the header group — splitting `"### Heading"` into a stray lone `"#"` on its own line followed by `"## Heading"`. Caught live via a real screenshot of Ethics Orovia. Fixed by switching to lookbehind (`(?<![\n#])(#{1,3}\s)`, `(?<![\n*])\*(?!\*)(\s+)(?=[A-Z*])`), which can never match inside or immediately after a marker run. Also fixes a related defect where the old regex could split the *closing* half of a `**bold**` pair into a bogus bullet, and where bullets starting immediately with `**bold**` (no plain lead-in text) failed to separate from the previous bullet.

Verified: Ethics Orovia's description now renders as a clean H1, three real paragraphs with correct bold spans, a proper `### Configuration & Pricing` H3, and correctly separated bullets under both `2 BHK` and `3 BHK Deck Residences` subheadings — no stray `#`/`*` characters anywhere.

### 1. Unit mix table — root cause found, fixed, plus an extractive fallback

`flatInventory[i].carpetSize` on a live response is a **plain number** (e.g. `867`) — a *different* shape from the project-level `raw.carpetSize` `{min,max}` object the earlier fix targeted. The earlier fix's `formatCarpetSize()` only handles the object shape, so it silently returned `null` for every per-unit row, and none of the guessed fallback field names (`carpetArea`/`carpet_area`/`carpet`) exist either — that's why every row showed "Not published" even after that fix landed. Also fixed `priceDisplay` (was a raw rupee integer like `25143000`, now formatted as `₹2.51 Cr` via a new `formatPrice()`).

Added the requested extractive fallback (`extractUnitMixFromDescription()` in `indihomes-client.cjs`): when `flatInventory` is genuinely empty *and* the description prose matches the `"<N> BHK ... Carpet Area: Approx. X–Y sq. ft. ... Starting Price: ₹Z Cr"` pattern, regex-parses real numbers out of it — never estimates. Tagged `_extracted: true`; `ProjectIntelligence.jsx` shows a distinct "✎ Extracted from description" badge instead of the "IndiHomes Website" badge when this path fires, so it's never confused with structured API data. Checked all 153 projects: exactly 1 (`Rivali Park Stargaze`) has empty `flatInventory`, and its description doesn't match the extractive pattern either — so it correctly still shows "No unit configuration data found" rather than fabricating something. `total`/`available` genuinely aren't in this API's `flatInventory` shape for any project — "Not published" there is honest, not a bug.

Verified: Ethics Orovia's Inventory table now shows all 6 real unit-variant rows (three 2BHK, three 3BHK) with real carpet sizes (619–1222 sq ft) and real formatted prices (₹1.8 Cr – ₹3.54 Cr).

### 2. Location Map / Nearby Infrastructure / Location Quality Score / Competing Projects

Confirmed via a live raw API fetch: **this API has no lat/lng field anywhere in its schema** (full key list checked) — only `googleMapLink`, a `maps.app.goo.gl` short link that doesn't itself carry parseable coordinates without a redirect-following HTTP call (not resolved; just passed through as `official.googleMapLink` and preferred over a constructed text-search URL for the "Open in Google Maps" link when present).

Implemented the geocode-retry fallback: `NearbyMap` now tries the full `"<Project Name>, <Locality>, <City>"` query first, and — only when that resolves to zero results — retries with **locality+city only** (no project name). An `approx` flag distinguishes the two so the map never presents a locality-level pin as the precise building (orange marker + a visible "📍 Approximate location — exact tower not mapped" banner when it falls back). Also added a pulsing loading skeleton so the brief loading flash can't be misread as "nothing here."

**Correction to the task's stated premise**, found during verification: the task described all of Location Map, Nearby Infrastructure, Location Quality Score, *and* "Competing Projects" as depending on the same `realNearbyPlaces` state. That's true for the first three (all genuinely fixed together by the geocode retry — verified together in one screenshot: Location Quality Score now reads "100/100 · Excellent (5 amenity types nearby)" and Nearby Infrastructure lists real hospitals/banks/schools with distances). **"Competing Projects" is not related to the map at all** — `displayCompetitors` is sourced purely from `research?.competitors` (Claude web research), independent of geocoding. Left as-is functionally (not something OpenStreetMap data can answer — "competing real estate project" isn't an Overpass-queryable category); see item 6 for why it's empty in this deployment specifically.

### 3. Target Audience — real, mutually-exclusive fit scoring

`deriveAudience()` reworked to gate fit on **real project signals**: budget tier (`budgetMin`/`budgetMax`, in Lakhs — three tiers: affordable `<₹75L`, mid `₹75L–1.5Cr`, premium `>₹1.5Cr`) drives First-Time Homebuyers vs. HNI/Luxury (now genuinely anti-correlated, not independently hardcoded), and configuration mix (1/2 BHK vs 3/4 BHK, parsed from `config`) drives Young Professionals vs. Upgrade Buyers. NRI Investors, Retirees, and IT Professionals keep description/amenity-keyword signals (that's genuinely what varies them) but no longer default to a flat "High". Added a `Low` fit tier (previously only High/Medium existed) with its own color. Fully deterministic — no LLM call, per this app's no-fabricated-scores rule; only the input signals got richer.

Verified live: Ethics Orovia (₹1.79Cr+ starting price → premium tier) now shows **First-Time Homebuyers: Low** ("Starting price above ₹1.5Cr — priced well past typical first-time-buyer range") and **HNI/Luxury: High** ("premium price point for this micro-market") — the exact correctness issue called out (a ₹2.66Cr 3BHK config no longer double-counted as both budget-friendly and premium) is fixed, confirmed via a real screenshot showing both fits simultaneously.

### 4 & 10. Project Intelligence UI polish

- New `EmptyState` component (icon + reason + optional detail) — replaces ad hoc italic-grey text across Inventory, Sales Velocity, Nearby Infrastructure, Competitor Analysis, USP Extraction, and Project Description.
- Location Map card: pulsing loading skeleton (see item 2).
- Inventory table: Total/Available/Price columns right-aligned; the Movement footer's explanatory paragraph collapsed into a `title` tooltip instead of permanent small print.
- Hero card: USP tags capped to top 3 with a "+N more below" cue instead of near-duplicating the full USP Extraction card's list with different styling.
- Removed the hardcoded `||91`/`||96` KPI fallback numbers (hero score/match, `StatCard`s) — a genuine data gap now shows `—` / "Not yet scored" instead of a fake-looking 91/96. (In practice this fallback was dead for any real project — `scoring.cjs` always attaches a real score — but it was misleading for the demo-default projects.)
- Rewrote the "AI enrichment not configured" banner to state precisely what's empty (Competitor Analysis: fully empty, no fallback exists for it; Nearby Infrastructure: real OSM data still works, only its AI-sourced supplementary list is missing) rather than implying only vague "supplementary research" is affected — see item 6.
- Checked Filter-Search-vs-AI-Search rank-pill visual alignment (item 9's third bullet): already identical styling (same colors, same pill shape) in both `ProjectCard` and `RankedResults` — no change needed, confirmed by direct comparison rather than assumed.

### 5 & 6. `requirements.md` (new, repo root)

Documents every external credential the app can use — what breaks/degrades without it, where to get it, exact `.env` variable names — structured as Required / Known limitation / Strongly recommended / AI Search connectors / Azure AI Search / Lead Capture, plus a variable-to-section reference table. Points readers at `server.cjs`'s `[startup] Integration status:` log block (generated by `validateEnv()`) for live current-state, rather than hardcoding a snapshot that goes stale.

Per item 6: **`ANTHROPIC_API_KEY` is not recommended anywhere in it.** Replaced with a "Known limitation" section explaining that Competitor Analysis / Nearby Infrastructure's AI fallback / Pros-Cons / Connectivity need a live-web-search-capable provider, that only Anthropic qualifies in this codebase (`llm.webSearchAvailable()`), and that Anthropic is intentionally not used here — explicitly instructing not to "fix" this by enabling Claude. `ProjectIntelligence.jsx`'s banner and Competitor Analysis's empty state now match this framing exactly (see item 4). Confirmed Pros/Cons and Connectivity aren't actually rendered as their own cards in the current UI (only Competitor Analysis and Nearby Infrastructure's supplementary list are real, currently-affected surfaces) — the requirements doc still documents the full data-shape limitation as asked, since those fields exist in the `research` schema even though no card renders them today.

### 7. AI Search — connector diagnostics removed from end-user UI

- Removed the "Connectors: ● Google · ○ Bing · ● Apify" chip row entirely (`externalStatus.connectorsList` mapping).
- Removed the `ConnectorErrors` red "Connector failures" box (per-connector raw error messages, e.g. "Google Programmable Search: 403: ...").
- The pre-search amber banner now fires *only* for the genuine zero-connectors-configured case, with no per-connector ✓/✗ breakdown.
- Went further than the explicit removal list, applying the same "never render diagnostic detail to the browser" principle to the **post-search** warning too: `external-search.cjs`'s `buildConnectorFailureMessage()` previously returned browser-facing text like *"Google Custom Search is configured but the Google project does not have access to Custom Search JSON API"* — this named a specific connector's specific failure, which is exactly the class of detail item 7 says a salesperson can't act on. Now returns one generic sentence ("No external listings available right now — try a different search or check back later.") when every tried connector failed; the real per-connector detail stays `console.warn`-only (unchanged) and is no longer included in the `/api/ai-search`/`/api/ai-search-more` JSON responses at all.

### 8. AI Search match % — real, weighted scoring instead of flat quality/freshness

`scoring.cjs`'s `scoreExternalProject()` rewritten to weight against the actual parsed query filters (`query-parser.cjs`'s `parseExternalQuery` output — locations/configuration/bedrooms/budgetMax/possession), the same 30/25/20/15 weight shape `scoreIndiHomesProject()` already uses for Filter Search, with source quality/freshness folded into the remaining 10% as a tie-breaker rather than the whole score. `external-search.cjs` now passes the real `filters` through and sorts `properties` by the computed score (previously Azure's raw text-relevance order — rank badges PRIMARY/SECONDARY/TERTIARY are assigned by array position, so this was required for them to mean anything). `why` now shows real match reasons ("Location matches Goregaon West · 2 BHK matches · Seen today") instead of "55% source confidence · Seen today" for every result.

Verified live with the exact reported symptom's query shape: an 18-result `"2 BHK apartment in Goregaon West"` search now shows 93% for every result that genuinely matches both location and config (correct — they're equally good matches on the criteria actually specified), and drops to 47% with reason "Location does not match your search" for two results whose location text didn't contain "Goregaon West" — real differentiation where real signal exists, not an artificial forced spread.

### 9. Project Selection UI polish

- Rechecked visual balance after the chip row/error box removal — spacing between the market toggle and search input was already tight (10px), no further change needed.
- `RankedResults` cards: rank pill + name now stand alone in the title row; source/confidence/freshness/"already delivered" consolidated into one compact meta line below (was 3 separate colored pills competing with the rank badge).
- Filter-Search-vs-AI-Search badge styling: confirmed already aligned (item 4/10).

### Verified this pass

`npm run build` passes. `test-indihomes.ps1 -SkipBuild` passes clean (all PASS, one WARN on Meta sync which is expected/documented). Browser-driven (Playwright) verification against the live running app: description rendering (item 0), unit mix table with real carpet/price (item 1), Nearby Infrastructure + Location Quality Score populated together (item 2), Target Audience mutual-exclusivity (item 3), Competitor Analysis's precise empty-state copy (items 4/6), AI Search tab with zero connector diagnostics (item 7), and real varied match scores with honest match reasons (item 8) — all confirmed via actual screenshots and API responses against `Chaitanya Ethics Orovia` and a live Goregaon West AI Search query, not read-for-plausibility.

---

## -2. 2026-08-12 (follow-up) — Verified 3 direct fixes (real prices, Azure key encoding, non-headless portal connector); 99acres/MagicBricks connector still returns 0 (diagnosed, not blind-patched); documented the live-query rupees/no-space-BHK contract

Three fixes landed directly in the repo (not through this session) plus one new file; asked to verify each against a running server and handle one remaining open item. All verified live against the actual IndiHomes API / Azure / real portal pages, not just read for plausibility.

### 1. ✅ Verified — real ₹ prices, `flatConfiguration` read (`indihomes-client.cjs`)

`normalizeProject()` now correctly reads `startingPrice` as `{ value, unit }` (was previously only handling a plain number or formatted string — every project silently fell through to "Price on request" because an object stringifies to `"[object Object]"`, which `parsePriceString` matches nothing on). `normalizeConfig()` now prefers the top-level `raw.flatConfiguration` array over `flatInventory`.

Restarted the server, triggered a live re-scrape (`POST /api/scrape`), fetched `/api/projects`:
```
38 Avenue By Artha Lifespaces => budgetLabel: "From ₹2.18 Cr", config: "2 BHK & 3 BHK & Jodi"
One Vara                     => budgetLabel: "From ₹1.94 Cr", config: "2 BHK & 3 BHK"
```
**0 of 153 projects** show "Price on request" post-fix (down from effectively all of them). `flatConfiguration`'s "Jodi" entry now surfaces in `config`, which `flatInventory` alone never carried.

### 2. ✅ Verified — Azure document key encoding (`azure-search.cjs`)

`syncExternalListings()` now base64url-encodes `id` via `safeKey()` before writing to the `external-projects` index (Azure keys reject `/`, `:`, `.` — raw source URLs used as keys were failing silently before this). Confirmed: `grep -i "invalid document key" server.log` → no matches after a full AI Search run; server log shows `[azure-search] Synced 15 external listings` and `/api/ai-search` actually returns rendered `properties` (13–16 depending on the run) with real `sourceUrl`/`sourceName` fields, where before this fix the sync silently no-opped and AI Search would have shown nothing despite a "successful" connector run.

### 3. ⚠️ Verified partially — non-headless portal connector (`legacy-portal-connector.cjs`, new)

New connector (registered in `external-connectors.cjs`'s `CONNECTORS` list, gated behind `LEGACY_PORTAL_SCRAPING_ENABLED=true`, now documented in `.env.example`). Switched Chromium launch to `headless:false` + off-screen positioning (`--window-position=-3000,-3000`, Windows-only) since headless is what 99acres' WAF blocks (per `chrome_utils.py`'s own prior finding), and added a per-city/source SSR-diagnostic log line.

Ran it live for Mumbai (covers the AI-Search-tested localities): the log showed
```
[legacy-portal-connector] 99acres Mumbai: SSR source=dom domCards=0 -> 0 parsed
[legacy-portal-connector] magicbricks Mumbai: SSR source=dom domCards=0 -> 0 parsed
```
Per the instruction not to guess at new selectors blind, I captured the actual page state directly (Playwright, same off-screen-headed launch, screenshots) instead of iterating on CSS blindly. **Neither site is blocking or WAF-detecting the connector** — both return HTTP 200 with real content:
- **99acres**: renders a full real project list (RERA badges, prices, USPs — e.g. "Jindal Air", "Immensa by Kalpataru", "Runwal Raaya" all visible in the screenshot) under `<div id="app">`, a client-rendered SPA with **no `__NEXT_DATA__`** and DOM content that visibly differs between loads (a second probe couldn't find text present in the first screenshot moments earlier) — the page also carries a hidden `<input id="npsrpClickstreamObject">` with a JSON blob of result `entity_tuples` (numeric project ids only, no name/price/etc., so not a drop-in replacement for card scraping on its own). The connector's current selectors (`[class*="projectCard"]`, `.mb-srp__card`, etc.) simply don't match this page's actual markup — this is a stale-selector problem on a highly dynamic SPA, not a block.
- **MagicBricks**: the hardcoded per-city URL (`/new-projects/new-residential-projects-in-mumbai`) doesn't resolve to a Mumbai-scoped page at all — it 200s into a **generic "New & Popular Projects" landing page defaulted to Gurgaon** (title: "Real Estate Projects in Gurgaon | MagicBricks"). This is a stale/wrong URL, not a selector problem.

**Not fixed** — deliberately, per the "report back rather than guess" instruction, and because the 99acres page's inter-load DOM variability means selectors written against one snapshot may not hold on the next; this needs either a maintained-portal-scraper library's approach or a slower, more careful selector-hardening pass with multiple samples, not a one-shot patch. The connector fails safe today (returns `[]`, logs the diagnostic, never breaks AI Search — confirmed: AI Search still returned 13–16 properties from Apify + surfaced Google's 403 correctly with this connector active and returning 0). Screenshots from this diagnostic were not committed (scratch-only); re-run `legacy-portal-connector.cjs`'s own `console.log` line (already in the file) to reproduce.

### 4. Documented — live-query rupees/no-space-BHK contract (not wired in, confirmed)

Confirmed the frontend never calls `GET /api/projects` with `area`/`flatType`/`budgetMin`/`budgetMax` — `ProjectSelection.jsx` always calls it bare, so `server.cjs`'s `hasLiveParams` gate is always false today and this path is dormant, not an active bug. Added contract comments at both ends (`indihomes-client.cjs`'s `buildListParams`, `server.cjs`'s `/api/projects` live-query block) spelling out that `fetchPaginatedFilteredProjectList` wants **raw rupees** (not this app's internal Lakhs convention — the API divides by 100000 server-side) and **`"2BHK"` with no space** (not the `"2 BHK"` convention used everywhere else, including `scoring.cjs` and the frontend's Configuration filter) — so a future integrator wiring server-side pagination into Filter Search converts at the call site instead of silently sending the wrong units/format straight through.

### Also observed (pre-existing, not a regression)

The smoke test's Dubai AI Search check intermittently reports a timeout (`test-indihomes.ps1`'s `Invoke-Json` uses a fixed 30s `TimeoutSec`) — this environment's real network round-trip to Google's Custom Search API varies 11s–35s+ run to run (confirmed by direct `curl` timing), and now runs alongside Apify + the legacy portal connector in the same `Promise.allSettled`. A same-input re-run passed cleanly (`AI Search Dubai endpoint PASS 16 properties`). Not something this pass changed — worth raising `test-indihomes.ps1`'s timeout if it becomes a recurring flake in CI.

### Verified this pass

`npm run build` passes. `test-indihomes.ps1 -SkipBuild` passes (one transient Dubai-endpoint timeout on a re-run, explained above and not reproducible on retry). Live server checks: real prices (item 1), no Azure key errors + properties rendering (item 2), portal-connector diagnostic captured (item 3), live-query path confirmed dormant (item 4).

---

## -1. 2026-08-12 — AI Search connector errors surfaced, Bing/Apify fallback UI, Campaign Brief generation, Project Intelligence: Sales Velocity / RERA trust / Location quality

Follow-up triggered by a real production symptom: Google Custom Search was configured (key + cx set) but the underlying Google Cloud project doesn't have the Custom Search JSON API enabled, so every call 403'd — and AI Search was silently showing an empty result with no explanation. Fixed that, plus built out the two features called for in the latest status/requirements image (Campaign Brief generation, deeper Project Intelligence) that hadn't shipped yet.

### 1. AI Search no longer swallows connector failures

- **`external-connectors.cjs`**: each connector (`google-cse`, `bing-search`, `apify-actor`) now attaches the real API error body to its thrown Error (`err.status`, `err.connectorId`) instead of a bare `Google CSE 403`. Google's actual message ("This project does not have the access to Custom Search JSON API.") now reaches the UI verbatim.
- **`external-search.cjs`**: `refreshExternalIndex()` now returns `{ merged, connectorErrors }` instead of just an array — every rejected connector promise is captured (`id`, `name`, `message`, `status`), not just `console.warn`'d. `queryExternal()` builds a `message` via `buildConnectorFailureMessage()` **only when every connector that was actually tried failed** (so Bing/Apify still working means no alarming banner, just the per-connector error list) — and special-cases a Google 403 into the exact sentence the brief asked for: *"Google Custom Search is configured but the Google project does not have access to Custom Search JSON API. Configure Bing Search or Apify."*
- **`server.cjs`**: `/api/ai-search` and `/api/ai-search-more` now return `connectorErrors: [...]` alongside the existing `warning` string.
- **`ProjectSelection.jsx`**: new `ConnectorErrors` component renders the per-connector failure list under the AI Search results (with a "configure Bing/Apify" suggestion when Google is the one that failed and neither fallback is configured yet), plus a persistent "Connectors: ● Google Custom Search · ○ Bing Web Search · recommended · ● Apify Actor" chip row always visible on the AI Search tab (not just inside the old "nothing configured" banner).

### 2. `/api/ai-status` — explicit Bing/Apify visibility

Added `connectorsList` (uniform `{id, name, configured, recommended}` array for Google/Bing/Apify) and a `recommendation` string ("Bing Web Search is the quickest fallback… set `BING_SEARCH_API_KEY`") surfaced whenever neither Bing nor Apify is configured yet. The existing `connectors.{googleCustomSearch,bingSearch,apifyActor}` shape is unchanged for back-compat.

### 3. Dubai / Filter Search split — verified, not changed

Re-confirmed `GET /api/projects` (Filter Search) has no `market` parameter at all — it's IndiHomes' own catalog only, unconditionally. Dubai only exists as a market toggle inside the AI Search tab (`POST /api/ai-search {market:'dubai'}`). No code change was needed here; this was already correct from the 2026-08-11 pass.

### 4. Campaign Brief generation (`ProjectSelection.jsx`)

New "📋 Generate Campaign Brief" button next to "Analyse Selected" in the floating selection bar (Filter Search, when ≥1 project is checked). `buildCampaignBriefMarkdown()` is pure, deterministic string generation off the project objects already on screen — **no LLM call** — producing one Markdown section per project: location, configuration, budget, possession, score, match reason (from `matchReasons`/`why`), RERA status, source, and a rule-based "recommended campaign angle" (`campaignAngle()` — possession urgency / RERA trust / premium vs. affordability / family vs. first-time-buyer targeting, combined per project). Downloads as `campaign-brief-YYYY-MM-DD.md` via a Blob URL.

### 5. Project Intelligence — Sales Velocity, RERA trust score, Location quality score, official-first USPs

All in `ProjectIntelligence.jsx`, all deterministic (no LLM required):
- **Sales Velocity** (`PI-FR-12`, new card): shows pace/sold%/units/unsold **only** when real sold%+unit counts exist; otherwise an explicit "Not connected" state — never a fabricated pace.
- **RERA trust score** (`reraTrustScore()`): three tiers exactly per the brief — Surepass-verified → "Verified Trust", official IndiHomes RERA present → "High Trust", found via secondary source only → "Needs Verification", missing → "Low Trust". Shown as a badge in the RERA Details card.
- **Location quality score** (`locationQualityScore()`): derived from the real OpenStreetMap Overpass nearby-places feed already powering the map (category diversity + proximity buckets, 0–100 + tier). Shows "Not connected" when the map hasn't geocoded the project yet, never a guess.
- **USP extraction, official-first**: `deriveUSPs()` (mirrors the server's `extractUSPs()` keyword pass) now runs against the **official IndiHomes description/amenities first** — previously USPs only ever came from Claude's research or the (permanently-null) `intel` object, silently skipping official data entirely. Buyer persona (`deriveAudience`) was already fed from official-first `displayDescription`/`displayAmenities`, so no change needed there.
- Unit mix (`PI-FR-02`) was already sourced from `official.flatInventory` — verified working, untouched.
- AI/LLM enrichment (`researchEnabled`/Claude) remains optional exactly as before — none of the above require it.

### Verified this pass

`npm run build` passes. `test-indihomes.ps1 -SkipBuild` passes (Filter Search source rule, AI Search no-Claude requirement, Dubai-via-AI-Search-only). Browser-driven check (Playwright) against the running dev app: AI Search shows the exact Google 403 message and connector chips; Filter Search's floating bar downloads a working `.md` campaign brief with all required fields; Project Intelligence renders Sales Velocity ("Not connected"), RERA trust ("High Trust"), Location Quality Score ("Not connected" — no Google Maps key in this env), and official-first USPs, with zero console/page errors.

Also discovered live during this pass: `.env` picked up real `APIFY_TOKEN`/`APIFY_EXTERNAL_ACTOR_ID`/`EXTERNAL_SCRAPING_ENABLED=true` credentials, so Apify is now a second configured connector alongside Google — confirms the "only alarm when *every* tried connector fails" logic behaves correctly (Google's 403 shows in the per-connector error list, but the top-line "everything is broken" message correctly stays silent since Apify is standing in as a working fallback).

---

## 0. 2026-08-11 — Official-API Filter Search, Azure-backed AI Search, own-data-first Project Intelligence, Lead Capture sync health

Manager decision required a hard source-of-truth split the app didn't have before. Summary for future sessions — **read this before touching search, Project Intelligence, or Lead Capture code.**

### New source-of-truth model

| Surface | Data source | Notes |
|---|---|---|
| **Filter Search** (`GET /api/projects`) | IndiHomes' own official API (`fetchPaginatedFilteredProjectList`) via `indihomes-client.cjs` | The **only** data source now. Every card carries `sources:['indihomes-website']` / `adSrc:'indihomes-website'`, badged "IndiHomes Website" in the UI. Cached in-memory + SQLite snapshot, TTL-refreshed (`INDIHOMES_PROJECTS_CACHE_TTL_MS`), falls back to last-good cache if the live API is down, and to a clear server error if there's no cache at all. |
| **Filter Search scoring** | Deterministic, rule-based (`scoring.cjs: scoreIndiHomesProject`) | Budget 30 / Location 25 / Config 20 / Possession 15 / Completeness 10, with a plain-English "why". No LLM anywhere in this path — `/api/nl-filters` and `/api/filter-rank` were both rewired off Claude onto `query-parser.cjs` (deterministic regex extraction) and `scoring.cjs`. |
| **AI Search** (`POST /api/ai-search*`) | Azure AI Search `external-projects` index, populated by `external-search.cjs` + `external-connectors.cjs` | External (non-IndiHomes) listings only, India **and Dubai**. Never calls Claude. Connectors are real APIs (Google Programmable Search, Bing Web Search, an Apify-actor slot) gated by `EXTERNAL_SEARCH_ENABLED` — **all unconfigured today**, so AI Search currently returns a clear "no external sources configured" message rather than results. The old Claude-web-search AI Search (`llm.discoverProjectsFromWeb`/`llm.analystReport`) is gone; `/api/ai-search-report` now returns 410 and `/api/ai-chat` returns 501 (it was a second live Claude-search path, unused by any screen — closed outright per the "no Claude for search" rule). |
| **Project Intelligence** (`POST /api/ai-research`) | Official IndiHomes detail (`fetchProjectByName`) first when the project has a `projectCode` (i.e. came from Filter Search), Claude web research second as supporting evidence | Response now carries `official: {...}` alongside the existing Claude fields. `ProjectIntelligence.jsx` prefers `official.*` (badge "IndiHomes Website", green) over Claude's `research.*` (badge "AI-derived", purple) for description/configs/amenities/RERA/possession. **Works even with no Claude/LLM key configured** — official data alone is enough for a 200 response now, it used to hard-503. Dubai projects (`market:'dubai'`) show a "DLD Registration" label instead of the MahaRERA verify flow (no DLD verification API integrated yet — display only). |
| **Lead Capture** | Local SQLite, unchanged | **No CRM/`createLead` push in this pass** — explicitly descoped by the user; leads stay local-only, same as before. New: `GET /api/leads/sync-status` (connected/disconnected + last success/failure/error/count per source), a `sync_runs` history table, a touch-level dedup guard (repeated `(lead_id, source, source_lead_id)` touches from overlapping hourly polls no longer pile up), and a manual "Add Lead" form in the UI (`source:'manual'`, labeled "IndiHomes OS"). |

### Env vars — what to add to your local `.env`

`.env.example` has the full annotated list. Everything below is optional/degrades gracefully — the app boots and Filter Search works with **zero new env vars**, since `indihomes-client.cjs` defaults `INDIHOMES_API_BASE_URL` to the real API even if unset.

```
INDIHOMES_API_BASE_URL=https://api.indihomes.co.in/api/v1   # default already correct
INDIHOMES_PROJECTS_ENABLED=true
INDIHOMES_PROJECTS_CACHE_TTL_MS=300000
INDIHOMES_PROJECTS_TIMEOUT_MS=10000

AZURE_SEARCH_EXTERNAL_INDEX=external-projects
EXTERNAL_SEARCH_ENABLED=false        # flip to true once >=1 connector below is set
EXTERNAL_SCRAPING_ENABLED=false      # only relevant to the Apify connector
BING_SEARCH_API_KEY=
GOOGLE_CUSTOM_SEARCH_API_KEY=
GOOGLE_CUSTOM_SEARCH_CX=
APIFY_EXTERNAL_ACTOR_ID=             # needs APIFY_TOKEN too, and EXTERNAL_SCRAPING_ENABLED=true
```

`AZURE_SEARCH_ENDPOINT`/`AZURE_SEARCH_ADMIN_KEY` already existed — set `AZURE_SEARCH_ADMIN_KEY` (endpoint is already set in this environment's `.env`) to let the external index actually get created/synced.

### What still needs real credentials/partner access

- **AI Search connectors** — none configured. Cheapest path to a working demo: a Google Programmable Search Engine (`GOOGLE_CUSTOM_SEARCH_API_KEY`/`_CX`) scoped to 99acres/MagicBricks/Bayut/Property Finder. Real partner APIs for 99acres/MagicBricks/Bayut/Property Finder don't exist yet (stub connectors in `external-connectors.cjs` document what's needed).
- **Azure AI Search admin key** — endpoint is set, admin key isn't. Nothing Azure-related runs until it is.
- **`ANTHROPIC_API_KEY`** — still unset (only `GROQ_API_KEY`/`GEMINI_API_KEY` are). Project Intelligence's Claude web-research layer needs it specifically (`llm.webSearchAvailable()` checks `PROVIDER === 'anthropic'`); Groq/Gemini don't have live web search. Official-data-first means Project Intelligence still works without it now, just without the supplementary web research.
- **Meta** — `META_ACCESS_TOKEN`/`META_PAGE_ID` unset.
- Housing.com is already configured in this environment.

### Codebase notes for future sessions

- **`legacy-scrapers.cjs`** (new) holds the old MahaRERA/99acres/MagicBricks/Google-Ads discovery pipeline — required by `server.cjs` but never called. It's what used to populate Filter Search before this change; it conflicts with the new "official IndiHomes only" rule, so it's disconnected, not deleted. Don't wire it back into `cache.projects`.
- **`POST /api/project-intel`** and its ~1400-line Playwright/Python/Apify scraping pipeline (still in `server.cjs`) were **already dead code before this change** — confirmed `ProjectIntelligence.jsx` never called it (hardcoded `intel = null` with a comment saying Drishti AI/`/api/ai-research` was the only source). Left exactly as-is; out of scope.
- Azure index `listings` was renamed to `indihomes-projects` in `azure-search.cjs` (inert today, no admin key set — takes effect once one is added).
- `GET /api/projects` still returns the polled `cache` object for no-param calls (same shape the frontend has always consumed) — this preserves current Filter Search UI behavior. It *also* now accepts `area/flatType/budgetMin/budgetMax/possessionDate/page/limit/sortBy` query params for a live, paginated, server-side-filtered call straight to the IndiHomes API — built for a future Filter Search UI that doesn't rely on client-side filtering of the bulk cache, not wired into the current frontend yet.
- New files: `indihomes-client.cjs`, `scoring.cjs`, `query-parser.cjs`, `external-search.cjs`, `external-connectors.cjs`, `legacy-scrapers.cjs`.

---

## 0.1. 2026-08-11 (follow-up) — Official CRM lead push, website intake endpoint, connector-health surfacing, Anthropic-optional Project Intelligence

Direct follow-up to §0 above — closes the gaps called out after that pass: no CRM push, no dedicated website-intake route, AI Search's "not configured" message wasn't specific enough, and Project Intelligence still nominally depended on Claude in a couple of places.

### The four-way split, restated (read this, not the code comments, when unsure which surface owns what)

| Surface | What it is |
|---|---|
| **Filter Search** | Official IndiHomes properties only (`/api/projects`) |
| **AI Search** | External (non-IndiHomes) market properties only, India + Dubai, Azure-backed, zero Claude |
| **Project Intelligence** | Official IndiHomes data first, Claude enrichment second (optional) |
| **Lead Capture** | Local inbox (always works) plus optional push to the official IndiHomes CRM |

### 1. Official CRM lead push (`indihomes-leads-client.cjs`, new)

`POST https://api.indihomes.co.in/api/v1/createLead` is now wired up — the **only** path that reaches IndiHomes' own system of record; nothing writes to Cosmos or any other external DB directly. Off by default (`INDIHOMES_LEAD_PUSH_ENABLED=false`).

When enabled: every new (first-touch) lead from manual entry, the website, Meta, and Housing.com is pushed right after local SQLite intake (`maybePushLeadToCrm()` in `server.cjs`, called from `POST /api/leads`, `POST /api/leads/intake/website`, `syncHousingLeads`, `syncMetaLeads`, and the Meta webhook handler). `projectCode` is resolved best-effort by matching the lead's free-text project name against the live Filter Search catalog (`resolveProjectCode()`) — omitted, never guessed, if there's no match.

- Failure handling: a failed push leaves the lead in the local inbox, sets `leads.crm_status='failed'` + `crm_error`, and is **retried automatically** the next time that lead is touched by any source (no separate retry job needed — the same `crm_status !== 'success'` check that skips already-synced leads doubles as the retry gate).
- History: `crm_push_log` table (per-lead, last 20 attempts kept) + `leads.crm_status`/`crm_synced_at`/`crm_error` columns (added via an additive `PRAGMA table_info` migration in `db.cjs` — safe to run on an existing DB).
- Status surfaced in `GET /api/leads/sync-status` under a `crm` key (counts by status + most recent push) and in the Lead Capture UI: a page-level "IndiHomes CRM push" status chip, plus a per-lead **CRM** column (✓ Synced / ✗ Failed / — not pushed) in the table.

### 2. Website lead intake — dedicated endpoint

`POST /api/leads/intake/website` — accepts a generic website form payload directly (not wrapped in `{source, leadData}`), normalizes through the existing `leadIntake.normalizeLead('website', ...)` path, dedupes by phone same as every other source, and pushes to CRM if enabled. `source:'website'`, labeled "IndiHomes Website" in the UI. The original `POST /api/leads` with `{source:'website', leadData:{...}}` still works too — this is an additional, more convenient entry point, not a replacement.

`lead-intake.cjs`'s `normalizeWebsite()` (used by `website` and the `manual` fallback) now also picks `notes`/`targetPossessionDate`/`userType` when present, since `createLead`'s body wants them — `notes` is persisted as a new `leads.notes` column; `targetPossessionDate`/`userType` are transient (used at push time only, not stored as their own columns) since no UI currently captures them.

### 3. AI Search connector-health status — `/api/ai-status` extended

Was `{enabled, provider}` (a leftover from when this checked an LLM key). Now:

```json
{ "enabled": bool, "azure": {"configured": bool}, "externalSearch": {"enabled": bool},
  "connectors": {"googleCustomSearch": {"configured": bool}, "bingSearch": {"configured": bool}, "apifyActor": {"configured": bool}},
  "dubai": {"available": bool, "connectorNames": [...]}, "all": [...] }
```

`ProjectSelection.jsx`'s AI Search tab reads this and shows an upfront (non-error, amber-but-informational) banner: *"No external search connector is configured yet. Configure Azure Search plus Google Custom Search, Bing Search, or Apify actor to enable external India/Dubai results."* — plus a compact ✓/✗ line per piece (Azure, Google CSE, Bing, Apify, Dubai-capable) so it's obvious exactly what's missing, not just that something is. This never blocks the tab or throws — search still runs and returns a graceful empty result with the same reasoning.

### 4. Project Intelligence — Anthropic reduced to optional enrichment, screen never blocks

`researchEnabled` (from `/api/research-status`, i.e. "is Claude configured") used to be the *only* trigger for `/api/ai-research` — meaning on a Groq/Gemini-only deployment (this environment's actual state), the auto-research effect never fired at all, and official IndiHomes data silently never appeared even though `/api/ai-research` itself already supported an official-only response (§0). Fixed: the auto-trigger now fires when `researchEnabled || current.code` (i.e. Claude is available, OR this project has an official IndiHomes project code worth fetching on its own). Verified live: description/inventory/RERA now populate from the official IndiHomes Website record with a green "IndiHomes Website" badge with zero LLM keys configured.

Added a page-level (not per-field) info banner when Claude isn't configured: *"AI enrichment not configured — showing official IndiHomes project facts only. Set `ANTHROPIC_API_KEY` on the server to add supplementary Claude web research."* The rest of the screen (hero card, KPIs, all data boxes) was already structurally never gated behind Claude being configured — this was a real trigger-condition bug, not a rendering-blocked-screen bug.

### Env vars added this pass

```
INDIHOMES_LEAD_PUSH_ENABLED=false
INDIHOMES_LEAD_PUSH_TIMEOUT_MS=10000
```

Plus expanded comments on the Meta Lead Ads block (`.env.example`) explaining what a working Meta setup actually needs: a Meta App with the Lead Ads product added, a long-lived Page Access Token for the page the forms live on, and (optional — the hourly poll works without it) a Webhooks subscription to that page's `leadgen` field.

---

## 1. Live Deployment (current)

| Layer | Platform | URL | State |
|---|---|---|---|
| Frontend | Vercel | https://indihomes-platform.vercel.app | ✅ Live, Git-connected (auto-deploy on push) |
| Backend API | Railway | https://indihomes-api-production.up.railway.app | ✅ Online, deployment `b5ebd75d` |
| Source repo | GitHub | https://github.com/pragadeeshwaran7/Indihomes | ✅ `main` |

**Backend config verified:** volume `/data` mounted, `DB_PATH=/data/data.sqlite`, `DISABLE_AUTO_SCRAPE=true`, `ALLOWED_ORIGINS` → Vercel, `APIFY_TOKEN` set.

---

## 2. What Was Proposed vs. What Was Done

| # | Proposed / Requested | Status | Notes |
|---|---|---|---|
| 1 | Remove all AI/synthetic content, show only real scraped data | ✅ Done | `syntheticIntel()` deleted; honest "not available" states everywhere |
| 2 | Field-level badges: real vs AI-derived vs unavailable | ✅ Done | `FieldBadge` (verified / ai / unverified) |
| 3 | Real, unique, authentic RERA numbers from listings | ✅ Done | Scraped from 99acres & MagicBricks; fake fallback removed |
| 4 | Proper scraping pipeline (Python/Selenium, not just Apify) | ✅ Done | `undetected-chromedriver`, non-headless off-screen Chrome to bypass WAF |
| 5 | Second source beyond 99acres | ✅ Done (code) | MagicBricks scraper + city discovery built and working locally |
| 6 | Persistent DB so it doesn't re-scrape every time | ✅ Done | SQLite (`node:sqlite`), 3 tables, 24h TTL, on Railway volume |
| 7 | Project Selection → Project Intelligence carry-over | ✅ Done | Selected projects flow into the Intelligence view |
| 8 | Fix dead buttons (Export brief, Onboard, Verify RERA, QR) | ✅ Done | All wired to real actions |
| 9 | Fix HTML-polluted descriptions | ✅ Done | `clean_html()` in both scrapers |
| 10 | Demand Trend (real source) | ✅ Done | Google Trends (`google-trends-api`) |
| 11 | Nearby Infrastructure + map | ✅ Done | OpenStreetMap Overpass API + Google Maps iframe |
| 12 | Honest Total/Available unit display | ✅ Done | "Not published" (99acres hides per-config counts) |
| 13 | Deploy frontend (Vercel) + backend (Railway) | ✅ Done | Both live |
| 14 | Move to standalone `Indihomes` GitHub repo | ✅ Done | Pushed; Vercel Git-connected |
| 15 | Version tracking document | ✅ Done | `VERSION.md` maintained each release |
| 16 | MahaRERA scraping | ⛔ Deprioritized | Search form won't filter via automation (anti-bot / cascading state) |
| 17 | Housing.com scraping | ⛔ Deprioritized | Not built; you chose "ship MagicBricks, stop there" |
| 18 | Live scraping from the hosted backend | ⚠️ Blocked | Railway datacenter IP is blocked by 99acres & MagicBricks |

---

## 3. Known Issues / Open Items (priority order)

### 🔴 P1 — Production data has degraded (26 projects / 1 RERA)
Production currently serves **26 projects with only 1 RERA**, down from the seeded **50 projects / 38 RERA**.
Likely cause: a weak scrape snapshot became the "latest" row in the volume DB before `DISABLE_AUTO_SCRAPE=true` was fully in effect.
**Fix:** re-seed by scraping locally (residential IP works), then upload a fresh `data.sqlite` to the Railway volume (`railway ssh` / volume upload), or add a "restore best snapshot" step that picks the highest-quality historical snapshot row.

### 🟠 P2 — Railway ↔ GitHub source not yet connected (browser step)
Vercel auto-deploys on push; Railway still deploys manually (`railway up`). Connecting the repo needs the Railway GitHub App OAuth grant, which only you can do in the dashboard.
**Fix:** Railway dashboard → `indihomes-api` service → Settings → Source → Connect Repo → `pragadeeshwaran7/Indihomes`, branch `main`.

### 🟡 P3 — Hosted backend can't scrape live (IP block)
Both 99acres and MagicBricks return decoy/"Access Denied" pages from Railway's datacenter IP. Confirmed via `/api/debug/connectivity`.
**Fix options:** (a) residential proxy (BrightData / IPRoyal / Smartproxy) wired into `chrome_utils.py`; or (b) keep the current model — scrape locally, upload `data.sqlite` periodically.

### 🟡 P4 — Apify quota exhausted (resets ~2026-07-02)
Third-fallback scraper is quota-limited. After reset it can cover projects neither 99acres nor MagicBricks find locally.

---

## 4. What You Should Do Next (recommended order)

1. **Connect Railway to GitHub** (P2) — 1-minute dashboard step; then backend auto-deploys like the frontend.
2. **Re-seed production data** (P1) — run the local scrapers to rebuild a strong `data.sqlite` (50+ projects, RERA-rich), then upload it to the Railway `/data` volume. This restores the demo to full quality.
3. **Decide on live scraping** (P3):
   - If you want the hosted server to scrape on its own → sign up for a residential proxy; I'll wire it into `chrome_utils.py` and the scrapers.
   - If periodic manual re-seed is acceptable → we can add a small script/scheduled task to push a fresh DB weekly.
4. **(Optional) Re-enable Apify fallback** after 2026-07-02 quota reset.
5. **(Optional) Build Housing.com / MahaRERA** if you later want more sources — both are currently parked.

---

## 5. Tech Stack Summary

- **Frontend:** React 18 + Vite 5 (Vercel)
- **Backend:** Node.js 22 + Express 4, CommonJS (Railway, Docker)
- **DB:** SQLite via `node:sqlite` (on Railway persistent volume)
- **Scraping:** Python 3 + Selenium + `undetected-chromedriver` + Xvfb
- **Free data APIs:** OpenStreetMap Overpass, Google Trends
- **Paid/limited:** Apify (fallback)
- **AI/LLM:** DRISHTI "AI Signals" are template-based (labeled as AI); no live LLM call in the current release. Dev assistant: Claude (Anthropic).
