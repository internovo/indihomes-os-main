# Lead events / AI Activity / Meta qualification — what was built here

Unlike the `indihomes-os-restructured` (no `_1`) folder on the Desktop —
which has an empty `backend/` and was where this feature was first,
mistakenly, built — **this is the real, complete, live app**, and
`server.cjs` here has been wired directly. Nothing in this file is a
"how to integrate this later" guide; it's a record of what changed and
how it was validated before being written to your actual files.

## New files

| File | What it does |
|---|---|
| `lead-journey.cjs` | The WhatsApp/voice checkpoint ladders — `template_sent → delivered/failed → resent → lead_replied → no_reply → followup_sent → requirements_shared → options_shared → detail_shared → advisor_requested → opted_out → tagging_sent` for WhatsApp; `call_attempted → call_no_answer/call_busy/call_failed/call_connected → call_disposition` for voice. |
| `qualification.cjs` | `classify(status, subStatus)` — maps this app's *existing* `STATUS_OPTIONS` (Qualified/Site Visit Scheduled/Site Visit Completed/Negotiation/Won → qualified; Lost → disqualified) to a qualified/disqualified/unknown value, plus the human-lock rule that stops an auto-classifier (a future Sarvam disposition reader) from overwriting a human's decision. |
| `lead-events.cjs` | Express router: `POST /api/lead-events` (generic checkpoint ingest, called by Indihomes-chatbot-V1 and Phase 2), `POST /api/sarvam-webhook` (voice call outcomes), `GET /api/leads/:id/journey`, `GET /api/leads/:id/ai-activity`, and `dispatchQualificationToMeta()` (used by `server.cjs`). |

## Changes to existing files

- **`db.cjs`** — new `lead_events` table (append-only, `lead_id` nullable
  for orphan events, `idempotency_key` UNIQUE for safe webhook retries);
  new `leads` columns (`sub_status`, `qualification`,
  `qualification_source`, `qualification_locked`, `qualified_at`) added
  via the same additive `ensureColumn()` migration pattern already used
  for every other column this table has gained over time — safe against
  the real, populated `data.sqlite` this app already has. New functions:
  `insertLeadEvent`, `listLeadEventsForLead`, `adoptOrphanEvents`,
  `getAiActivity`, `updateLeadQualification`, `findLeadByPhone`.
  `intakeLead()` now calls `adoptOrphanEvents()` on every intake (best-effort,
  wrapped in try/catch — can never break a real lead intake).
- **`meta-capi.cjs`** — added `EVENT_NAME_FOR_QUALIFICATION`,
  `buildQualificationEvent()`, `sendQualificationEvent()`. Existing
  `EVENT_NAME_FOR_STATUS`/`buildEvent()`/`sendEvent()` (CRM-push events)
  untouched.
- **`server.cjs`** — three real, live changes:
  1. `const leadEvents = require('./lead-events.cjs')` + `app.use(leadEvents)`
     right after the existing `agent-tools-bridge` mount.
  2. `PATCH /api/leads/:id` now routes `status`/`sub_status` through
     `db.updateLeadQualification()` instead of the generic field-update
     loop (so the human-lock rule can't be bypassed), and fires
     `leadEvents.dispatchQualificationToMeta()` fire-and-forget right
     after a qualification change is written.
  3. `runMetaCapiSync()` (the existing hourly sweep) now also walks every
     Meta-sourced lead's `qualification` field as a cold-path safety net,
     using the same idempotent `dispatchQualificationToMeta()`.
  4. `GET /api/leads/sync-status` (the Lead Capture status strip's data
     source) now reports a `leadEvents` block: `configured` (always true
     once mounted) and `sarvamWebhookConfigured`.

## Frontend

`frontend/src/components/screens/LeadCapture.jsx` — added:
- **AI Activity card** — WhatsApp bot / AI voice agent mascot circles
  (green WhatsApp icon, navy phone icon) each with a tick/cross/none
  badge, fetched from `GET /api/leads/:id/ai-activity`. Directly below,
  the horizontally-scrollable **status/sub-status strip** — clicking a
  sub-status chip PATCHes `{status, sub_status}` together, which is what
  drives the qualified/disqualified Meta CAPI dispatch server-side. A
  small badge shows "✓ Qualified for Meta" / "✕ Disqualified for Meta"
  once `lead.qualification` is set, with the human/auto source in a tooltip.
- **Lead Journey card** — a vertical, two-tab (WhatsApp/Voice) checkpoint
  tracker reading `GET /api/leads/:id/journey`. Reached checkpoints are
  colored and timestamped; checkpoints with a meaningful payload (which
  properties were shown, a voice call's disposition) get a small `(i)`
  button that toggles the raw payload inline — **click, not hover**, so
  it behaves the same on touch devices as desktop.

Both cards sit between the existing "Requirements" and "Activity" cards
in the lead detail view. This file's own imports/exports and every other
existing card were left untouched.

## Testing performed

Every backend module here (`lead-journey.cjs`, `qualification.cjs`,
`db.cjs`'s extensions, `meta-capi.cjs`'s extensions, `lead-events.cjs`)
was written and fully exercised in a sandbox — a real (throwaway) SQLite
file via `node:sqlite`, a real Express server, real HTTP requests — before
being copied here verbatim. Confirmed there: orphan-event insert →
idempotent dedup on retry → automatic adoption on `intakeLead()`; the
human-lock correctly refusing an auto qualification write after a human
has set one; `template_sent → delivered → failed` all correctly reflected
in `GET .../ai-activity`; `buildQualificationEvent()`'s dedup-safe
`event_id` shape. The frontend additions were validated with `esbuild`
against the real sibling `ui`/`shared` components before being written.

**What was NOT tested — and can't be, from where this was built:**
actually booting *this* `server.cjs` with all 18 of its real
dependencies (Playwright, Redis, the live IndiHomes API client, etc.)
and confirming it starts cleanly with the new `require`/mount/route
changes. The individual pieces are proven correct in isolation; the full
integration into this specific, large, already-running file has not
been executed. **Before trusting this in production:**

1. Back up `backend/data.sqlite` (real data lives there).
2. Restart the server (`npm run server` or however you normally run it)
   and check the console for any startup error — in particular, confirm
   `require('./lead-events.cjs')` resolves cleanly.
3. Hit `GET /api/leads/sync-status` and confirm the new `leadEvents` key
   appears in the response.
4. Open a lead in the Lead Capture screen's detail view and confirm the
   new "AI Activity" and "Lead Journey" cards render (they'll show empty/
   "not connected" states until Indihomes-chatbot-V1 or Phase 2 actually
   start emitting events — see each of those repos' own `OS_EVENTS_URL`
   env var, currently unset/dry-run everywhere).
5. Try a PATCH on a test lead's status/sub_status and confirm
   `lead.qualification` comes back populated correctly.

## Known gap carried over from the other copy

Indihomes-chatbot-V1's and Phase 2's `os_events_client.py` /
`integrations/os_events_client.py` still point at `OS_EVENTS_URL=`
(unset) by default — nothing will actually flow into this pipeline until
that's set to this server's real URL and `OS_EVENTS_DRY_RUN=false` is
set in both of those repos' `.env` files.
