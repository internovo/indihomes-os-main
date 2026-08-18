'use strict'

// Lead qualification: the taxonomy, the ONE rule that turns a
// status/sub-status pair into qualified/disqualified/unknown, and the
// human-lock discipline that keeps an eventual auto-classifier (voice
// agent disposition) from silently overwriting a person's decision.
//
// See indihomes-os claude.md / structure.md for the full design writeup.
// The short version: every writer of status/sub_status (today: a human in
// the Lead Capture UI; later: an auto-classifier reading Sarvam's
// final_agent_variables.disposition) must go through setQualification()
// below, never write leads.qualification directly — that is what
// guarantees "qualified" means the same thing regardless of who set it.

// sub_status taxonomy, keyed by the EXISTING status vocabulary this app
// already ships (see frontend/src/components/screens/LeadCapture.jsx's
// STATUS_OPTIONS / STATUS_COLOR — 'New', 'Contacted', 'Qualified',
// 'Follow-up', 'Site Visit Scheduled', 'Site Visit Completed',
// 'Negotiation', 'Won', 'Lost'). sub_status itself is a genuinely NEW
// field (no existing data to preserve there), but `status` must stay
// exactly this vocabulary — a caught-before-shipping bug during this
// task's frontend wiring used an invented parallel vocabulary
// ('Engaged'/'Disqualified'/'Site Visit') that would have silently
// diverged from the StatusEditor dropdown every lead already uses.
const TAXONOMY = {
  New: [],
  Contacted: ['Ringing', 'Not reachable', 'Call back later'],
  Qualified: ['Budget match', 'Site visit interested', 'Ready to buy'],
  'Follow-up': ['Awaiting reply', 'Scheduled callback'],
  'Site Visit Scheduled': ['Confirmed', 'Rescheduled'],
  'Site Visit Completed': ['Positive', 'Needs follow-up'],
  Negotiation: ['Price discussion', 'Documentation'],
  Won: ['Booked', 'Agreement signed'],
  Lost: [
    'Out of budget', 'Wrong location', 'Just browsing',
    'Broker/agent', 'Wrong number', 'Not interested',
  ],
}

// classify() is the ONLY place "qualified" is decided. Every caller
// (PATCH /api/leads/:id today, a future Sarvam-disposition auto-writer
// later) must go through this — see this file's header for why two
// separate implementations of "what counts as qualified" is exactly the
// failure mode this function exists to prevent.
//
// Mapping rationale: 'Qualified' and everything past it in the funnel
// (a real site visit booked, in negotiation, or actually won) all
// represent a genuine, engaged buyer — reportable to Meta as qualified.
// 'Lost' is the one existing status that means "this lead is not going
// to convert" — reportable as disqualified. Everything earlier ('New',
// 'Contacted', 'Follow-up') is still undecided — 'unknown', nothing
// reported to Meta yet.
function classify(status, subStatus) {
  if (['Qualified', 'Site Visit Scheduled', 'Site Visit Completed', 'Negotiation', 'Won'].includes(status)) return 'qualified'
  if (status === 'Lost') return 'disqualified'
  return 'unknown'
}

// True if `subStatus` is a real sub-status of `status` per TAXONOMY, or if
// subStatus is empty (a status with no sub-status chosen yet is valid —
// the UI just shows the status pill alone). Guards against corrupt data
// (a sub-status left over from a previous status, or a typo) reaching the
// database at all, since classify() only inspects `status` directly and a
// mismatched sub_status would otherwise persist silently. Called from
// server.cjs's PATCH /api/leads/:id handler before the write, not from
// classify() itself (classify() must stay a total function with no
// validation branch, or a bad sub_status could make it throw where every
// caller assumes it never does).
function isValidSubStatus(status, subStatus) {
  if (!subStatus) return true
  const allowed = TAXONOMY[status]
  return Array.isArray(allowed) && allowed.includes(subStatus)
}

// Builds the fields to persist for one qualification write. Does NOT
// touch the database itself (db.cjs owns all SQL) — this is pure decision
// logic so it can be unit-tested without a DB, and so server.cjs's PATCH
// handler and any future auto-classifier both call the exact same
// decision path.
//
// existingLead must carry qualification_locked (0/1) and
// qualification_source ('human'/'auto') as already stored on the row.
//
// THE LOCK RULE (the "robust system" this task's design conversation asked
// for): an auto-write (source='auto') is silently REFUSED once
// qualification_locked=1 — a human has already made a call on this lead
// and an auto-classifier must never reverse it. A human write
// (source='human') always wins and sets the lock going forward, since a
// person acting in the UI is always allowed to correct or confirm the
// lead's state. This is the single choke point that prevents the
// "voice agent silently re-qualifies a lead a human already disqualified"
// trap named during design — every write goes through here, not through
// a bespoke check at each call site.
function buildQualificationUpdate(existingLead, { status, subStatus, source = 'human' }) {
  if (source === 'auto' && existingLead && Number(existingLead.qualification_locked) === 1) {
    return {
      applied: false,
      reason: 'locked_by_human',
      fields: null,
    }
  }
  const qualification = classify(status, subStatus)
  return {
    applied: true,
    reason: null,
    fields: {
      status,
      sub_status: subStatus || null,
      qualification,
      qualification_source: source,
      // A human write always (re-)locks the field, even if it was already
      // locked — re-locking is a no-op in practice but keeps the rule
      // "human writes always set the lock" true unconditionally, rather
      // than "true only the first time", which would be a subtler rule to
      // reason about later.
      qualification_locked: source === 'human' ? 1 : (existingLead ? existingLead.qualification_locked : 0),
      qualified_at: qualification === 'unknown' ? (existingLead ? existingLead.qualified_at : null) : Date.now(),
    },
  }
}

module.exports = { TAXONOMY, classify, isValidSubStatus, buildQualificationUpdate }
