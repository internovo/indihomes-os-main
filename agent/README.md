# IndiHomes AI Search Agent

A LangGraph research pipeline that replaces AI Search's old single-pass
"query the connectors, score, return" flow with a real staged pipeline:
understand the query → decide what to research → search multiple real
sources in parallel → normalize and deduplicate the evidence → score
deterministically → optionally have an LLM curate/summarize (never invent)
→ return a strict structured result. **No Anthropic/Claude dependency
anywhere in this service.**

## Why a separate Python service

The existing backend (`server.cjs`) is Node/CommonJS end to end. LangGraph
is a Python-first library; forcing an equivalent state-machine into Node
would mean either a much thinner, hand-rolled orchestration layer or a
heavy new Node dependency graph for comparatively little benefit. Per this
project's own instruction ("use Python for the LangGraph layer if that's
cleaner... expose it through a small HTTP service rather than mixing
orchestration logic into unrelated backend code"), this is a standalone
FastAPI service Node calls into — nothing about the existing backend was
rewritten to accommodate it. `server.cjs` gained exactly two things: a
feature flag (`LANGGRAPH_ENABLED`) on the existing `/api/ai-search` route,
and a new internal tool-bridge router (`agent-tools-bridge.cjs`) that
exposes the connectors this service already had (Google CSE, Bing, Apify,
the 99acres/MagicBricks scraper, the IndiHomes catalog lookup) as callable
HTTP tools — none of those connectors were touched or reimplemented.

```
Node (server.cjs)
  │ feature-flagged: LANGGRAPH_ENABLED=true
  ▼
POST /agent/ai-search  ──────────────►  Python FastAPI (this service)
  ▲                                          │
  │ adapted response                         ▼
  │                                    LangGraph StateGraph
  │                                          │
  │                          ┌───────────────┴───────────────┐
  │                          ▼                                ▼
  │                 /internal/agent-tools/*          LLM providers
  │                 (Node, token-gated)               (Grok / Gemini /
  │                          │                         OpenAI-compat /
  │                          ▼                         local — optional)
  │              existing connectors:
  │              tavily, google-cse, bing, apify,
  │              legacy-portal-connector
  │              (99acres/MagicBricks),
  │              indihomes-client (official)
  └──────────────────────────────────────────────────────────────────┘
```

## Graph

```
START

  → query_understanding      (deterministic regex parse — mirrors query-parser.cjs)
  → location_resolution      (shared mmr-gazetteer.json)
  → research_planner         (decides which tools are worth calling)
  → {tavily_search, web_search, apify_search, portal_search, developer_search}   (parallel fan-out;
       each is a no-op if the planner didn't include it)
  → evidence_normalizer      (price/BHK/possession/name normalization)
  → deduplicator             (merges same-project evidence, PRESERVES conflicts)
  → candidate_verifier       (flags cross-source conflicts as warnings)
  → candidate_scorer         (deterministic PRIMARY/SECONDARY/TERTIARY)
  → research_gap_checker     (conditional)
       ├─ needs_more_research → targeted_research → candidate_verifier (loop, bounded)
       └─ sufficient → curator
  → curator                  (LLM synthesis of ALREADY-SCORED evidence, or a
                               deterministic summary if no LLM is configured)
  → structured_output
  → END
```

Implementation: `agent/graph.py`. The search nodes are static graph
edges that no-op when their tool isn't in `search_plan` — this keeps the
actual graph shape matching the diagram above rather than routing around
missing nodes, while still skipping tools the planner decided weren't worth
calling for this particular query.

## State schema

`agent/state.py`'s `ResearchState` (a `TypedDict`) — see that file for the
authoritative field list. Fields written by more than one parallel branch
(`raw_evidence`, `tool_calls`, `warnings`, `errors`) use LangGraph's
`Annotated[..., operator.add]` reducer so concurrent branch updates
concatenate instead of one silently overwriting another. Deliberately does
**not** store raw HTML or screenshots — tools return already-extracted
`EvidenceItem` dicts; a short `raw_text` excerpt (never a full page) is the
most anything keeps of a source's original content.

## Tools (`agent/tools.py`)

Every tool is a thin async HTTP client calling `agent-tools-bridge.cjs` on
the Node server (`/internal/agent-tools/*`, gated by `AGENT_INTERNAL_TOKEN`):

| Tool | Node bridge route | Wraps |
|---|---|---|
| `tavily_search` | `/tavily-search` | Tavily AI web search — the primary research tool (Part 29); `depth='basic'` on the first pass, `depth='advanced'` during targeted per-candidate research |
| `web_search` | `/web-search` | Google Programmable Search + Bing Web Search |
| `developer_search` | `/developer-search` | Same, biased toward builder/developer sites |
| `portal_search` | `/portal-search` | `legacy-portal-connector.cjs` (99acres + MagicBricks) |
| `apify_search` | `/apify-search` | Apify actor (Google-search-scraper) |
| `lifecycle_variant_search` | `/tavily-search` | Same Tavily search as `tavily_search`, but the query is rewritten with lifecycle language ("... under construction OR new launch OR near possession") appended — surfaces individual project/builder pages the plain user query alone tends to miss in favor of generic portal browse pages. Gated on the query having a resolvable location (same reasoning as `portal_search`). |
| `official_lookup` | `/official-lookup` | `indihomes-client.cjs`'s own-catalog lookup |

`tavily_search`, `web_search`, and `apify_search` are all tried in parallel
on every query (each independently no-ops when unconfigured) — Tavily
complements rather than replaces the others, since it's an AI-native search
API that returns already-extracted page content instead of a bare snippet,
which in practice surfaces builder/developer pages and project-specific
detail pages more reliably than snippet-only search. Its own AI-generated
`answer` field is never requested (`include_answer=false`) — only raw
search results feed this app's fact-extraction pipeline, so an LLM never
gets to hand the graph an ungrounded summary as if it were evidence.

Each call is cached (`agent/cache.py`) and always returns a `ToolCallRecord`
(status/count/duration/error) even on failure — a failed tool degrades the
plan, it never raises out of the graph.

## Bridge reliability

Every tool call goes through `tools._call_bridge()`, which owns a single,
process-wide (not per-request) circuit-breaker: once the bridge is
confirmed unreachable, every other tool call — in the same fan-out AND any
request that starts within `AGENT_BRIDGE_UNAVAILABLE_TTL_MS` (default
30s) — fails instantly instead of each independently retrying the same
dead dependency.

**The circuit only trips on a genuine connection failure**
(`httpx.ConnectError`/`ConnectTimeout` — the bridge process itself never
answered the TCP handshake), never on a `ReadTimeout` (the bridge DID
accept the connection and was actively working, just not fast enough for
one caller's own timeout budget). This distinction was added after a
confirmed live incident: `apify_search`'s real latency (Node's own
`APIFY_TIMEOUT_MS`, 60s default — a genuinely synchronous Apify
`run-sync-get-dataset-items` call) is structurally longer than the shared
`AGENT_BRIDGE_TIMEOUT_MS` (15s default) every other, much-faster tool
uses. Every `apify_search` call was therefore *guaranteed* to `ReadTimeout`
even though the bridge and Apify were both working exactly as designed —
and because the OLD code treated any timeout the same as a dead bridge, one
slow-but-legitimate `apify_search` call poisoned the shared circuit for the
next 30 seconds, during which ~10 completely unrelated, otherwise-healthy
`fetch_page`/`web_search`/`tavily_search` calls in a single targeted-research
pass all failed instantly with `bridge_unavailable` — wasting the entire
verification budget for candidates that had nothing to do with Apify being
slow. Fixed two ways:

1. `apify_search` now uses its own dedicated, generous timeout
   (`AGENT_BRIDGE_APIFY_TIMEOUT_MS`, default 70s — comfortably longer than
   Node's own 60s default) via `_call_bridge`'s `timeout_s` override, with
   zero retries (`max_retries=0` — retrying a slow-but-legitimate call with
   the same budget doesn't make Apify faster, it just doubles the wait).
2. `_call_bridge` catches `httpx.ReadTimeout` in its own branch, separate
   from `ConnectError`/`ConnectTimeout` — it fails that ONE call cleanly
   and returns, without ever calling `_mark_bridge_unavailable()`.

**Real, mocked-network regression tests** (not just a config/TTL check) live
in `agent/tests/test_bridge_circuit_breaker.py` — a fake `httpx.AsyncClient`
tracks a real call counter, proving a short-circuited second call attempts
genuinely zero network I/O, and that a `ReadTimeout` on one call never
poisons an unrelated call made right after it. Run directly:

```
.venv\Scripts\python.exe tests\test_bridge_circuit_breaker.py
```

**Deep-research fetches were also sequential, not parallel** — a separate,
compounding latency issue found while fixing the above. Raising
`AI_SEARCH_MAX_CANDIDATES_FOR_DEEP_RESEARCH` (see below) from 3 to 5 to
give more candidates a real verification chance directly multiplied a
loop that fetched each candidate's up-to-`AI_SEARCH_MAX_FETCHES_PER_
CANDIDATE` source URLs one at a time, and `targeted_research_candidates`'s
per-query `web_search` + `tavily_search` pair was likewise sequential —
together enough to push a real request past the whole-pipeline timeout and
fall all the way back to the Node pipeline (the opposite of the intended
fix). Both loops now use `asyncio.gather()` — the calls within each loop
have no dependency on each other's result, so there was never a
correctness reason for them to run one after another.

## Evidence normalization, deduplication, scoring

- `agent/normalize.py` — canonical price (INR int, never mixed
  rupee/lakh/crore internally), BHK naming, possession year, project-name
  cleanup, and **aggregator/category-page detection**: a title like "14+
  Apartments for Sale in Liberty Garden" is recognized as a portal search-
  results page (nothing distinctive left once locality names and generic
  real-estate words are stripped from it) rather than an individual
  listing, and **rejected outright** (`graph._apply_hard_eligibility_
  filter`), never merely down-ranked — a real production search once
  surfaced results that were entirely category pages with zero actual
  listings, all shown to the user, back when this only capped the score.
  Also owns `classify_lifecycle_status()` (RESALE/RENTAL/UNDER_
  CONSTRUCTION/NEAR_POSSESSION/NEW_LAUNCH/READY_TO_MOVE/UNKNOWN — see the
  eligibility gate below) and `looks_like_unrelated_commerce()` — a narrow,
  high-precision check for candidates sourced from an unrelated domain
  whose actual content is shopping/e-commerce spam that happened to get
  indexed with keyword-stuffed real-estate text (confirmed live: a
  candidate sourced from a German butcher shop's website, matched purely
  on scraped locality/possession-year keywords, rejected by this check).
- `agent/dedupe.py` — matches by RERA number (authoritative) → normalized
  name+locality → exact source URL → a **fuzzy tier** (distinctive
  name-token overlap ≥50% after stripping portal furniture AND generic
  project words like "Heights"/"Garden"/a compass direction, AND at least
  one of {same developer, same/contained locality} — name similarity alone
  is never sufficient, since two genuinely different projects routinely
  share a generic word). Merging **never overwrites a conflicting value**
  — every observed value per tracked field (price/configuration/
  possession/rera/location/developer) is kept in `field_evidence`, each
  with its own source/URL/timestamp. The brief's own example ("99acres
  ₹1.71 Cr, MagicBricks ₹1.75 Cr — preserve both, don't pick one") is
  exactly what this produces; `candidate_verifier` turns any such
  disagreement into a visible warning. `normalize_all()` also runs
  `fact_extraction.extract_sub_listings()` on any evidence item that
  classifies as a category/search-results page — real, individually-named
  projects (each anchored by a genuine RERA number) sitting inside that
  page's own body text are pulled out as their own candidates rather than
  thrown away with the correctly-rejected wrapper page.
- `agent/scoring.py` — a Python port of `scoring.cjs`'s just-recalibrated
  graduated scoring (exact/sibling-nearby/no location match, whitespace-
  insensitive configuration matching, small possession-close partial
  credit, the "wrong area caps below SECONDARY" rule), plus an
  `evidence_quality` dimension (source corroboration + freshness + RERA
  presence) standing in for `scoring.cjs`'s IndiHomes-catalog
  `completeness` score. Same weights, same 80/60/40 PRIMARY/SECONDARY/
  TERTIARY thresholds as the rest of the app.

## Hard eligibility gate (`graph._apply_hard_eligibility_filter`)

The single choke point every candidate passes through, twice: once right
after scoring (`final=False`), once after deep research (`final=True`).
Category pages, resale, rental, and unrelated-commerce spam are rejected
**unconditionally on both passes** — confident signals that more research
wouldn't change. `UNKNOWN`/`READY_TO_MOVE` lifecycle and "no identifiable
project name" are **deferred on the first pass** (kept, not accepted-as-
eligible) so `deep_research` gets a genuine chance to resolve them from the
real fetched page — `reclassify_lifecycle_from_enriched_evidence` and
`fact_extraction`'s direct page-content classification both feed this —
before the final pass makes the real accept/reject call. A
**geography/locality relevance gate** (`_matches_searched_location`) is
also final-pass-only: a candidate's own text must contain the query's
location term(s) or resolved city as a **whole phrase** (never a single
matched word) or it's rejected — added after a live false positive where a
Las Vegas, NV home-builder listing reached final results for a Mumbai
search purely because its name contained the word "Liberty".

`deep_research`'s fixed candidate budget
(`AI_SEARCH_MAX_CANDIDATES_FOR_DEEP_RESEARCH`, default 5) is spent on
candidates with an **undetermined** eligibility status first
(`_prioritize_for_deep_research`) — an already-eligible candidate competing
for the same limited research slots as one whose UNKNOWN status could
still flip either way is the wrong priority, confirmed as the real
mechanism behind a live false negative where a genuine project reached
zero results because it fell just outside an unprioritized top-N cut.

## LLM providers (`agent/llm_providers.py`)

Grok (xAI) and Gemini, both via their OpenAI-compatible chat-completions
endpoints through the one `openai` Python package — no per-provider SDKs,
no Anthropic anywhere. `LLMRouter(role)` builds a primary→fallback chain
per role (`reasoning`/`extraction`/`fallback`, env-configurable via
`MODEL_REASONING`/`MODEL_EXTRACTION`/`MODEL_FALLBACK`) and tries each
candidate in order; if none are configured (or all fail), the caller
degrades to a deterministic path — verified live in this deployment both
ways: with zero keys set, and with a configured-but-currently-broken
Gemini key (stale model name / exhausted prepaid credits, both real,
specific errors from Google's API, not a code defect) — both correctly
produced a complete, real, deterministic result rather than an error.

The curator (`agent/curator.py`) is the **only** place an LLM output can
reach the response, and even there it may only pick which already-scored
candidates to feature and write summary/explanation text grounded in their
already-computed `match_reasons` — it cannot add or change a fact.

## Caching (`agent/cache.py`)

File-based, three TTL tiers (`ai-search-agent/.cache/<namespace>/`):

| Tier | Default TTL | Why |
|---|---|---|
| Full curated response, per normalized query | 10 min | "What's on the market" changes; a refined search shouldn't see a stale list for long. |
| Raw per-tool evidence, per (tool, query) | 6 hours | Stops every request from re-scraping/re-searching the same thing within a working day. |
| Assembled `project_intelligence`, per property | 24 hours | Most expensive to assemble (multiple tool calls); changes the least. |

## API contract

`POST /agent/ai-search {"query": str, "market": "india"|"dubai"}` →
`{query, summary, properties[], citations[], research_metadata}` — see
`agent/curator.py`'s `final_response` construction for the exact shape, and
`server.cjs`'s `adaptAgentProperty()` for how it's mapped onto the existing
`/api/ai-search` response the frontend already reads (additive fields only
— `match_tier`/`match_reasons`/`key_match`/`limitations`/
`project_intelligence`, layered on top of the fields that already existed).

## Running it

```
cd ai-search-agent
.venv\Scripts\python app.py          # Windows
# .venv/bin/python app.py             # macOS/Linux
```

Listens on `127.0.0.1:${AGENT_PORT:-8008}`. `GET /health` reports which LLM
providers are actually configured/reachable right now.

## Tests

`_smoke_test.py` runs one query through the full compiled graph end to end
and prints every stage's output (parsed requirements, resolved locations,
search plan, tool call results, evidence counts, ranked properties, final
response) — the fastest way to see the whole pipeline work on a real query
without going through Node/the browser:

```
.venv\Scripts\python _smoke_test.py "2 BHK in Borivali East under 1.5 Cr"
```

Two plain-assert regression suites (no pytest dependency — same "runnable
script" convention) — both exit non-zero on any failure:

```
.venv\Scripts\python.exe tests\test_lifecycle_and_eligibility.py   # 90+ checks: lifecycle classification, the hard eligibility
                                                                     # gate (incl. the geography gate + unrelated-commerce check),
                                                                     # dedup (exact + fuzzy tiers + sub-listing extraction), exact
                                                                     # project-name extraction, deep-research prioritization,
                                                                     # retrieval_metrics + the empty-result explanation
.venv\Scripts\python.exe tests\test_bridge_circuit_breaker.py      # 13 checks: real mocked-network verification of the bridge
                                                                     # circuit breaker (a call counter proves a short-circuited
                                                                     # call attempts zero network I/O; proves a ReadTimeout never
                                                                     # poisons an unrelated tool call)
```

Mirrored on the Node fallback path (`backend/external-search.cjs`/
`scoring.cjs`) in `backend/tests/test_lifecycle_and_eligibility.cjs` — run
with `node backend/tests/test_lifecycle_and_eligibility.cjs` from the repo
root.
