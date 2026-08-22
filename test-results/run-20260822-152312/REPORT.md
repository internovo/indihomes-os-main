# India AI Search — Test Report

**Run ID:** `run-20260822-152312`
**Window:** 2026-08-22 09:54:00 UTC → 10:53:52 UTC (59m52s). All 10 Tier-1 scenarios + T2-06 only, per instruction — T2-01 through T2-05 were explicitly skipped, not attempted.

---

## Provider breakdown (read this first)

The response body carries no per-search field naming which LLM actually served a request, and no live agent-terminal log file exists for this session (the agent process was already running before I attached — all files under `/tmp` predate this run by 5 days). The only observable signal is a `/health?probe=true` circuit-breaker snapshot taken immediately **before** and immediately **after** each search. That gives four possible states per search, not a name of "the model that answered":

| inferred state | count | meaning |
|---|---|---|
| `mixed_groq_then_fallback` | 6 | Groq breaker closed at search start, **open** by the end — this search's own token usage tripped the TPM limit mid-run. Early tool/LLM calls plausibly hit Groq; later ones did not. |
| `local_openrouter_fallback_throughout` | 4 | Groq breaker was **already open** at search start and still open at the end — this search never had a working path to Groq. |
| `groq_likely_throughout` | 1 | Groq breaker closed at both start and end — most consistent with Groq serving the whole search, but a trip-then-recovery inside the 134–167s window cannot be fully ruled out from two point samples. |

**Zero of the 11 searches run (10 Tier-1 + T2-06) ran on a confirmed, uninterrupted Groq path.** 10 of 11 definitely touched the OpenRouter/local Nemotron fallback for at least part of the run; T1-05 is the closest to a clean Groq run but is not provably one. **Every quality number below is therefore a number about a mixed Groq+Nemotron system in practice, not a clean read on `openai/gpt-oss-120b` alone** — the 75s pacing gap reduced *sticky* 300s breaker lockouts (no run was blocked at the abort-rule threshold) but did not prevent every single search from generating enough tokens to trip Groq's 8000 TPM limit partway through its own execution.

**Additional finding surfaced only before T2-06**: the fallback itself, `nvidia/nemotron-3-super-120b-a12b:free` via OpenRouter, hit its own **daily** free-tier cap mid-suite — `/health?probe=true` immediately before T2-06 returned `"local":{"ok":false,"error":"429: Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"}`. Groq itself was healthy at that moment (no breaker open). This means "Groq breaker open" no longer guarantees a working fallback path for any search run after this point in a longer suite — worth flagging since neither this suite's Step 0 pre-flight nor the mid-run breaker snapshots would have caught a scenario where *both* providers are simultaneously degraded.

Per-scenario detail (`groq_circuit_before`/`groq_circuit_after` raw snapshots) is in each `searches/T1-*.json`. T1-01 and T1-02's `provider_inference` fields were **backfilled** after the fact from real snapshots captured live earlier in this same session (not estimated) — provider tracking was added to the harness after the abort-rule change came mid-suite; ledger.jsonl lines for those two searches predate the field and don't carry it.

---

## Verdict

**Not shippable as-is, but the core eligibility/lifecycle machinery is holding.** The hard gates that matter most — lifecycle restriction (V3: 0/28 disallowed statuses reached the frontend), configuration atomicity (V6: 0 failures), price shape sanity (V8: 0 failures), and the RESALE/RENTAL/READY_TO_MOVE exclusion — passed cleanly across all 10 valid, agent-served searches, and T1-10 reproduced T1-01 exactly (3/3 identical projects, zero field drift) despite running on a different inferred provider mix. That determinism result is a genuinely good sign for a system this dependent on LLM curation.

Set against that: one search (T1-02, "2 BHK in Andheri West" — the scenario explicitly chosen as "the easiest possible case") returned **5 results with 5/5 failing the locality check** — `location` was populated with the project's own name instead of an actual place, and `city` was null on every result. A structural name-gate gap let an aggregator-page title ("Under Construction Projects by I STAY HOUSING PRIVATE LIMITED") straight into results twice (T1-01 and its determinism-repeat T1-10), at the lowest match tier but still user-facing. Two duplicate pairs (same RERA, two different display names) reached the frontend. And 40+ `fetch_page` calls across the run failed with "Unsupported content-type: application/json" (plus PDF variants in T2-06) — not one of the documented known-open defects, worth root-causing before shipping. None of these are fatal to the core promise (no resale/rental/ready-to-move leaked through), but "the easiest case is 100% locality-check failures" and "the deterministic-repeat case includes a category-page title as a result" are both things a home-buyer would notice.

**T2-06 ("ready to move 2 BHK in Mulund") passed cleanly**: 0 results, 73 candidates reviewed and honestly explained (39 aggregator pages, 6 resale/rental, 25 unconfirmed lifecycle), zero ready-to-move inventory leaked through. This is the harder, adversarial version of the lifecycle test — a query that explicitly asks for exactly what the product is supposed to refuse — and the hard eligibility gate held.

---

## Pre-flight

All Step 0 checks passed. Summary (see `validation.json.preflight` for the machine-readable copy):

1. **`LANGGRAPH_ENABLED`**: `true` (`.env:86`). PASS.
2. **Backend banner**: not raw-captured — the backend process was already running before this session attached, and no console/log file exists for it. Derived from source instead: `server.cjs:183-189` computes the banner as a pure function of `LANGGRAPH_ENABLED`/`AGENT_SERVICE_URL`, both confirmed, giving `AI Search pipeline: LangGraph agent PRIMARY (http://localhost:8008), Places-direct as fallback`. Flagged as inferred, not observed.
3. **Agent health** (`GET :8008/health?probe=true`), verbatim:
   ```json
   {"ok":true,"llm":{"reasoning_configured":true,"reasoning_providers":["Groq","Local/open-source model","Gemini (Google)"],"extraction_configured":true,"extraction_providers":["Groq","Local/open-source model","Gemini (Google)"],"probe":[{"key":"gemini","label":"Gemini (Google)","model":"gemini-3.6-flash","ok":false,"error":"429: RESOURCE_EXHAUSTED","latency_ms":2939},{"key":"groq","label":"Groq","model":"openai/gpt-oss-120b","ok":true,"error":null,"latency_ms":708},{"key":"local","label":"Local/open-source model","model":"nvidia/nemotron-3-super-120b-a12b:free","ok":true,"error":null,"latency_ms":1117}],"circuit_breaker":{},"langsmith":{"tracing_enabled":true,"api_key_configured":true,"project":"Property_Ai-search","endpoint":"https://api.smith.langchain.com"}}
   ```
   Gemini was already 429-exhausted before the suite even started (unrelated to Groq/OpenRouter — not part of the documented primary/fallback pair, noted for completeness).
4. **`GET :3001/internal/agent-tools/status`**: reachable via `x-internal-token` header. PASS.
5. **Stale-process check**: agent (pid 17808) started 2026-08-22 13:45:59 local; `agent/agent/graph.py` last modified 13:41:49 — agent is newer than the code. PASS.
6. **Test suites**: `test_search_harness.py` 151/151 passed (required `PYTHONIOENCODING=utf-8` — the default cp1252 console crashes printing a `₹` inside the test's own output; an environment variable for the run, not a code change); `test_lifecycle_and_eligibility.py` all passed; `test_bridge_circuit_breaker.py` all passed. PASS.
7. **Portal scraping permanently disabled**: verified by reading `backend/legacy-portal-connector.cjs` — line 301 `const PORTAL_SCRAPING_PERMANENTLY_DISABLED = true`, line 304 `if (PORTAL_SCRAPING_PERMANENTLY_DISABLED) return []` as the unconditional first line of `search()`. `.env`'s `LEGACY_PORTAL_SCRAPING_ENABLED=true` is inert for this connector. PASS.

---

## Scenario table

| id | query | pipeline | duration | results | checks pass/fail (excl. V10/V11) | PI coverage | provider (inferred) |
|---|---|---|---|---|---|---|---|
| T1-01 | 1 BHK in Marol | agent | 144.2s | 3 | 20 / 5 | 5/8 | mixed_groq_then_fallback |
| T1-02 | 2 BHK in Andheri West | agent | 166.8s | 5 | 31 / 5 | 6/8 | mixed_groq_then_fallback |
| T1-03 | 2 BHK in Chikuwadi | agent | 138.9s | 0 | 1 / 0 | — (no results) | mixed_groq_then_fallback |
| T1-04 | 1 BHK in Kandarpada under 1.5 Cr | agent | 144.7s | 1 | 10 / 0 | 7/8 | local_openrouter_fallback_throughout |
| T1-05 | 3 BHK in Malad West with gym and swimming pool | agent | 136.1s | 0 | 1 / 0 | — (no results) | groq_likely_throughout |
| T1-06 | 2 BHK in Vashi Navi Mumbai | agent | 145.0s | 5 | 39 / 2 | 7/8 | mixed_groq_then_fallback |
| T1-07 | 2 BHK in Thane West possession 2027 | agent | 134.7s | 3 | 20 / 0 | 6/8 | local_openrouter_fallback_throughout |
| T1-08 | 1 BHK in Borivali East | agent | 147.0s | 3 | 24 / 2 | 8/8 | mixed_groq_then_fallback |
| T1-09 | studio apartment in Powai | agent | 134.2s | 5 | 39 / 1 | 8/8 | local_openrouter_fallback_throughout |
| T1-10 | 1 BHK in Marol (repeat) | agent | 133.9s | 3 | 20 / 4 | 5/8 | local_openrouter_fallback_throughout |
| T2-06 | ready to move 2 BHK in Mulund | agent | 145.6s | 0 | 1 / 0 | — (no results) | mixed_groq_then_fallback |

**All 11 valid** (`pipeline: "agent"`, HTTP 200) — no INVALID (System A / Places-direct) rows in this run. Every search stayed comfortably under the 150s agent budget / 180s Node timeout (max observed: 166.8s response time for T1-02, which includes network + backend overhead beyond the agent's own internal 150s clock).

---

## Failures

**V2 — Locality match** (8 total failures)
- **T1-01 / T1-10** (identical, both runs): `"Under Construction Projects by I STAY HOUSING PRIVATE LIMITED"` — `location: "Under Construction Projects, STAY Housing Private, Limited"`, `city: null`. Neither field contains "Marol", "Mumbai", or any resolvable locality term.
- **T1-02, all 5/5 results**: `"Linkbay Residences"`, `"Spenta Anthea"`, `"Sunbeam Heights"`, `"Transcon Triumph"`, `"Western"` — every one has `location` set to its own project name (not a place) and `city: null`. The `sourceUrl`s (`99acres.com/new-2-bhk-projects-in-andheri-west-mumbai-...`, `99acres.com/3-bhk-projects-in-andheri-west-mumbai-andheri-dahisar-2-crores-to-3-crores-...`) strongly suggest these ARE Andheri West projects sourced from a 99acres category page via the `portal_search`→`tavily_search` fallback (see Provider/portal note below) — but the structured `location`/`city` fields that the frontend and this check both rely on were never populated for any of the 5.

**V4 — Project name is real** (0 failures per the automated gate — see "New findings," this is a gate gap, not a clean pass)

**V7 — Property type sanity** (4 failures, all in T1-01/T1-10, same 2 properties each run)
- `"I Stay Tower in Marol"` and `"Under Construction Projects by I STAY HOUSING PRIVATE LIMITED"`: `propertyType: "Villa"` returned for the query `"1 BHK in Marol"`.

**V9 — Coordinates** (5 failures)
- T1-01: `"I-Stay Tower, Andheri East"` (`placesLat`/`placesLon`: null, null) — carries `nearbyLandmarks`/`connectivity` claims with no backing coordinates.
- T1-01 dup: `"Under Construction Projects by I STAY HOUSING PRIVATE LIMITED"`.
- T1-06: `"Gami Avant - Vashi"`.
- T1-09: `"Isle Of Calm - Whispering Woods"`.
- T1-10: `"I-Stay Tower, Andheri East"` (same as T1-01).

**V12 — Duplicates** (2 pairs)
- T1-06: `"Gami Avant"` and `"Gami Avant - Vashi"` share RERA `P51700079740` — same project, two display names, both reached the frontend.
- T1-08: `"24K residence Hirani"` and `"24k Residences by Hirani Group"` share RERA `P51800047979` — same pair pattern.

**V1, V3, V5, V6, V8** — zero failures across all 11 valid searches, including T2-06 (0 results returned, so trivially no disallowed lifecycle status could leak — the meaningful signal there is the 0-result count itself plus the honest `summary` explanation, both covered under "Verdict" and "New findings" below).

---

## Field ledger totals (V11)

Aggregated across the top-ranked property of each of the 8 searches that returned results (T1-03 and T1-05 returned 0 properties, contributing nothing to this total):

| status | count |
|---|---|
| `filled` | 80 |
| `searched_not_found` | 40 |
| `never_researched` | 0 |

**Zero `never_researched`** across every top-ranked property in this run — every tracked field was at least attempted. The 40 `searched_not_found` entries are concentrated in the three Marol/Andheri/Thane searches with lower PI coverage (T1-01, T1-02, T1-07, T1-10 each show 7 `searched_not_found`) — consistent with `rera_compliance`/`location_score` being the panels most often empty in the V10 breakdown below.

**PI coverage (V10), panels empty by search:**
- T1-01, T1-10: `rera_compliance`, `location_score`, `location_map` (5/8)
- T1-02: `location_score`, `location_map` (6/8)
- T1-04: `competitors` (7/8)
- T1-06: `rera_compliance` (7/8)
- T1-07: `rera_compliance`, `usp` (6/8)
- T1-08, T1-09: full 8/8

---

## Determinism (T1-01 vs T1-10)

**Identical set: 3/3 intersection over union.** Both runs returned exactly `{"I Stay Tower in Marol", "I-Stay Tower, Andheri East", "Under Construction Projects by I STAY HOUSING PRIVATE LIMITED"}`. Zero field drift on `price`, `developer`, `rera`, `lifecycleStatus`, `config`, `match_score`, or `sourceUrl` for any of the 3 shared projects between the two runs.

This held despite the two runs having different inferred providers (T1-01: `mixed_groq_then_fallback`; T1-10: `local_openrouter_fallback_throughout`) — i.e., the ranking/curation output was stable even when at least one run leaned more heavily on the fallback model than the other. That is a positive signal for production stability, though it also means this one repeat pair cannot distinguish "the pipeline is deterministic" from "both the Groq and fallback models happen to agree on this particular query" — a genuinely harder query might not show the same stability.

**Cross-run ledger comparison**: not applicable. `test-results/ledger.jsonl` contained no prior runs before this suite started — this is the first recorded run.

---

## Known-defect reproduction

- **`[bridge] ConnectTimeout` storms / `[places-enrich] TimeoutError`** (documented as "just fixed"): **did not reproduce.** Zero `ConnectTimeout` or `[places-enrich] TimeoutError` strings across all `research_metadata.tool_calls` errors in all 10 searches. The `fetch_page` errors actually observed were: `HTTP 400`/`HTTP 417`/`HTTP 404`, `ReadTimeout`, `Unsupported content-type: application/json` (see New findings), and `No readable content found` — a different error surface than the pre-fix symptom.
- **"Price not available" for prices already found** (documented as "just fixed"): **did not reproduce.** Checked every property across all 10 searches for `price` null/empty where `field_evidence.price_display` had a real captured value — zero matches.
- **`tools.py` new `httpx.AsyncClient` per call (no keepalive reuse)**: **not observable this run.** This requires either connection-level tracing or agent process logs; neither was accessible (no live log file, no debug trace enabled — see below). Not claimed to reproduce or not reproduce.
- **`AGENT_SERVICE_URL=localhost` vs uvicorn binding `127.0.0.1`**: **not observable this run**, same reason as above.
- **Groq TPM exhaustion mid-run tripping the circuit breaker**: **reproduced repeatedly** — 5 of 10 searches (T1-01, T1-02, T1-03, T1-06, T1-08) show the breaker closed at start and open at end (`mixed_groq_then_fallback`), i.e., tripped by their own token usage. See the Provider breakdown section at top for full detail.

---

## New findings

1. **`candidate_name_reject_reason` does not reject aggregator-page-shaped titles of the form "`<Lifecycle phrase> Projects by <Developer Name>`".** Verified directly: `candidate_name_reject_reason("Under Construction Projects by I STAY HOUSING PRIVATE LIMITED")` returns `None` (accepted) when run against the actual installed gate function. This exact string reached the frontend in both T1-01 and T1-10, at the lowest match tier (`match_score: 8`, `match_tier: "TERTIARY"`) but still inside the returned results array, sourced from a magicbricks.com URL that is itself a category-listing page (`.../i-stay-housing-private-limited-under-construction-projects-pppsp`). Also structurally accepted by the same gate: the single word `"Western"` (T1-02) — passes because it's ≥3 alphabetic characters with no other structural red flag, though in context it reads as a truncated fragment of a longer name.
2. **`fetch_page` frequently fails with `"Unsupported content-type: application/json"`** — 40+ occurrences across 7 of 10 searches (T1-05: 9, T1-07: 10, T1-06: 6, T1-09: 8, others: 1-3 each). Not one of the four documented known-open defects. Pattern suggests the URL-selection step is frequently handing `fetch_page` a REST/API endpoint rather than an HTML page — worth checking which upstream tool (`tavily_search`, `serper_search`, `web_search`) is surfacing these URLs, since it's silently discarding that many candidate pages' worth of evidence on 70% of searches.
3. **T1-02 ("2 BHK in Andheri West", explicitly chosen in the test plan as "the easiest possible case") is the one Tier-1 scenario where 100% of returned properties fail the locality check.** All 5 results have `location` populated with the project's own name and `city: null`, even though the source URLs are clearly Andheri-West-scoped 99acres category pages. This looks structurally related to finding #2 and to `portal_search`'s documented fallback-to-`tavily_search` behavior (`agent/agent/tools.py:286-287`) — candidates surfaced this way may be skipping whatever step normally populates `location`/`city` from page content for other tool paths. Reported as an observed pattern, not a diagnosed root cause.
4. **`eligible_candidates` in `retrieval_metrics` doesn't always match the final returned count.** T1-05 reports `eligible_candidates: 2` in `retrieval_metrics` but returns 0 properties, with a `summary` field candidly explaining the empty result in terms of aggregator/resale/unknown counts that don't add up to the "2 eligible" figure being excluded. **Reproduced again in T2-06**: `eligible_candidates: 3`, 0 properties returned. Plausibly the "eligible" candidates are later dropped by a constraint applied after `retrieval_metrics` is computed (amenity match for T1-05; possibly the lifecycle-phrase query itself for T2-06) — consistent with the pipeline, but not confirmed from the response data alone. Flagged for awareness, not asserted as a bug, now seen in 2/11 searches.
5. **The OpenRouter free-tier fallback (`nvidia/nemotron-3-super-120b-a12b:free`) hit its own daily rate limit mid-suite**, independent of Groq's per-minute TPM limit. Observed directly in the `/health?probe=true` snapshot taken immediately before T2-06: `{"key":"local","ok":false,"error":"429: Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"}`, while Groq was simultaneously healthy (no breaker open) at that same moment. This is a real dual-provider-degradation scenario the suite's pacing/breaker-tracking approach cannot fully characterize from response data alone — it only tracks Groq's breaker, not OpenRouter's daily quota.
6. **`fetch_page`'s content-type rejection isn't limited to `application/json`** — T2-06 shows the same pattern with `application/pdf` (2 occurrences: `"Unsupported content-type: application/pdf"`), alongside 2 `HTTP 404`s and one `apify_search` timeout (`"The operation was aborted due to timeout"`). Reinforces finding #2 as a broader "non-HTML content reaching fetch_page" pattern, not a JSON-only quirk.
7. **`portal_search`'s reported result count is not really about the disabled 99acres/MagicBricks connector.** Confirmed by reading `agent/agent/tools.py:260-290`: the legacy connector correctly returns `[]` (per the Step 0.7 verification), but `portal_search` then falls back internally to `tavily_search` and reports *that* count under the `portal_search` label (T1-01 showed `portal_search` count: 10). This is pre-existing, documented, intentional behavior in the code comments — not a sign portal scraping was accidentally re-enabled — but worth naming explicitly since the task brief's "portal_search contributing zero results is expected" framing doesn't hold literally; it's the *underlying connector* that contributes zero, which is the actual intent.

---

## What I could not test and why

- **`agent_log_excerpt`** — required by the spec for every search, but genuinely not observable. The agent process (pid 17808) was started outside this session before I attached, no console output was captured to any file, and every `*.log` file under `/tmp` predates this run by 5 days (last write 2026-08-17). `AI_SEARCH_DEBUG_TRACE` is not set in `.env`, and I did not enable it — it is not one of the two pre-flight settings I was authorized to change. Every scenario JSON has `agent_log_excerpt: null` with this explanation inline.
- **`httpx.AsyncClient`/keepalive reuse and `AGENT_SERVICE_URL` localhost-vs-127.0.0.1 defects** — same root cause: no log access this session, so neither confirmed nor ruled out.
- **`summary` field for T1-01, T1-02, T1-03** — the harness didn't capture the full raw response body until after I inspected T1-03's empty result and found the gap (fixed before T1-04). Re-running those three to backfill would mean re-issuing real searches outside the recorded sequence and skewing both the pacing/rate-limit picture and the token budget, so I left them as `summary: null` rather than fabricate or re-fetch. All 7 other scenarios (T1-04 through T1-10) have the full raw response preserved, `summary` included.
- **Tier 2 (T2-01 through T2-05)** — not run. You explicitly directed running T2-06 only, then stopping; T2-01–T2-05 were skipped by instruction, not attempted or blocked.
