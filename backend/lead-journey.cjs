'use strict'

// The canonical checkpoint ladders for the Lead Capture vertical tracker.
//
// WHY A SEPARATE FILE FROM lead-events.cjs: this is pure, static data — no
// DB access, no Express — so it can be required by lead-events.cjs (to
// build the /api/leads/:id/journey response) AND by anything else that
// ever needs to reason about "what stage can a lead be at" without pulling
// in the whole router. Keeping the LADDER separate from the EVENTS that
// walk it is the same "ladder vs data" split documented in this task's
// design conversation — one ordered list of possible checkpoints, joined
// against whatever lead_events rows actually exist for a lead, rather than
// a different hand-built tracker shape per channel/outcome.
//
// Each entry:
//   key    — must match a lead_events.checkpoint value exactly (see
//            lead-events.cjs's CHECKPOINTS set, which is generated FROM
//            these two ladders so the two can never drift apart).
//   label  — shown in the tracker UI.
//   info   — true if this checkpoint's lead_events.payload is worth
//            showing behind an (i) icon (e.g. which properties were
//            shown) — most checkpoints have no interesting payload and
//            don't get one.
//   terminal — true if reaching this checkpoint ends the ladder for this
//            lead in this conversation instance (e.g. 'no_reply' either
//            gets resolved by a follow-up or the lead goes cold) — used
//            only for a subtle "this branch, not that one" UI hint, never
//            to hide real events.

const WHATSAPP_LADDER = [
  { key: 'template_sent', label: 'WATI template sent', info: false },
  { key: 'delivered', label: 'Delivered to phone', info: false },
  { key: 'failed', label: 'Delivery failed', info: true, terminal: true },
  { key: 'resent', label: 'Resent (10 AM retry)', info: false },
  { key: 'lead_replied', label: 'Lead replied', info: false },
  { key: 'no_reply', label: 'No reply', info: false, terminal: true },
  { key: 'followup_sent', label: 'Follow-up sent', info: false },
  { key: 'requirements_shared', label: 'Requirements shared', info: true },
  { key: 'options_shared', label: 'Options shared', info: true },
  { key: 'detail_shared', label: 'Property details shared', info: true },
  { key: 'advisor_requested', label: 'Talk to an advisor', info: false },
  { key: 'opted_out', label: 'Opted out', info: false, terminal: true },
  { key: 'tagging_sent', label: 'Tagging sent to CRM', info: true },
]

// Voice has its own ladder rather than reusing WhatsApp's — a phone call
// has no "template" concept and its checkpoints come from Sarvam's call
// lifecycle (see backend/sarvam-webhook wiring notes in
// LEAD_EVENTS_INTEGRATION.md), not from conversation stages.
const VOICE_LADDER = [
  { key: 'call_attempted', label: 'Call attempted', info: false },
  { key: 'call_no_answer', label: 'No answer', info: false, terminal: true },
  { key: 'call_busy', label: 'Line busy', info: false, terminal: true },
  { key: 'call_failed', label: 'Call failed', info: true, terminal: true },
  { key: 'call_connected', label: 'Call connected', info: true },
  { key: 'call_disposition', label: 'Outcome recorded', info: true },
]

const LADDERS = { whatsapp: WHATSAPP_LADDER, voice: VOICE_LADDER }

// Every checkpoint key that is allowed to be inserted into lead_events, by
// channel. lead-events.cjs's ingest endpoint checks incoming checkpoints
// against this — an unrecognised checkpoint is logged and rejected rather
// than silently accepted, so a typo or a future emitter change that drifts
// from this file's vocabulary is caught immediately (as a 4xx + a log
// line) instead of silently building a tracker row nothing ever renders.
const VALID_CHECKPOINTS = {
  whatsapp: new Set(WHATSAPP_LADDER.map(s => s.key)),
  voice: new Set(VOICE_LADDER.map(s => s.key)),
}

function isValidCheckpoint(channel, checkpoint) {
  const set = VALID_CHECKPOINTS[channel]
  return !!set && set.has(checkpoint)
}

module.exports = { WHATSAPP_LADDER, VOICE_LADDER, LADDERS, VALID_CHECKPOINTS, isValidCheckpoint }
