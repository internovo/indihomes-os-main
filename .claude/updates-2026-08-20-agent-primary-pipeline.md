# 2026-08-20 — agent is now the PRIMARY AI Search pipeline

Full detail (root cause, exact diffs, live verification) lives in
`structure.md`'s "The agent is now the PRIMARY /api/ai-search path, not
Places-direct" section — this file is a short index into that.

A deliberate architecture change, explicitly NOT a performance
optimization: accepted that most searches now take real time (35-140+
seconds observed live) instead of Places-direct's near-instant answers.

## 1. Reordered the three `/api/ai-search` branches

`backend/server.cjs`: was Places-direct → agent → Node fallback, now
agent → Places-direct → Node fallback. Pure reorder — no internal logic
changed in any of the three blocks, only their sequence (plus updating
each block's own comments to stop claiming to be "tried first" when only
one of them still is).

## 2. Timeout/fall-through — checked, no bug, value unchanged

`AI_SEARCH_TIMEOUT_MS` (120000ms) was NOT changed — confirmed the
fall-through already works correctly: a timeout throws inside the same
try/catch as any other agent failure, so it falls through identically.
Live-verified twice: two full requests each took ~120s and correctly
returned `pipeline: 'places-direct'` with real results, never a broken
request. Separately confirmed the agent itself isn't hung when this
happens — the same query, given more time directly against the agent,
completed in 194.5s with a genuine (not bugged) zero-candidate result.

## 3. Frontend loading state — genuinely inadequate, fixed

The 5-stage cycling message burned through all stages in ~4.4s (1100ms
each) then froze on "Ranking matching properties…" for the remaining
30-190+ seconds of a real wait — misleading and looked stuck. Fixed:
interval slowed to 4500ms, stages now LOOP instead of freezing, and a new
real elapsed-seconds counter was added (with a "can take up to 2 minutes"
note appearing past 10s) as the clearest "still working" signal.

## 4. Pipeline label copy — confirmed correct, no change needed

"via full research" is small, muted, plain text with no "rare case"
styling — reads exactly as well as the new common case as it did as a
rare one.

## Live verification highlights

- Real successful agent run: `pipeline: 'agent'`, 108.9s wall-clock time,
  3 real UNDER_CONSTRUCTION properties, real why/price/RERA fields.
- **LangSmith confirmed via its own REST API** (not just config
  presence): queried `Property_Ai-search`'s root runs directly and got
  back 4 real `LangGraph` traces matching every query run this pass, with
  timestamps matching observed wall-clock durations to the second.
- Fallback re-tested with the agent genuinely fully stopped (a leftover
  supervisor process from an earlier pass was found still running and
  quietly keeping the agent alive during the first fallback-test attempt
  — a testing-hygiene mistake caught mid-verification, not a code bug):
  failed over in 0.81 seconds once the agent was actually confirmed dead.
- Both test suites re-run clean, unchanged (a pure reorder needed no test
  content changes, and none were made).
