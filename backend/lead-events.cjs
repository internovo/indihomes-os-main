'use strict'

// Router for the lead-events pipeline: ingest, the Sarvam voice adapter,
// and the read-side projections (journey tracker, AI-activity ticks) the
// Lead Capture frontend renders. See this task's design conversation for
// the full architecture - short version: chatbot-V1 and Phase 2 push
// checkpoint events here over HTTP; Sarvam posts its own native post-call
// webhook shape to a separate endpoint; everything lands in ONE
// lead_events table (db.cjs); the frontend never sees raw events, only
// the two projections built from them.
//
// ORPHAN EVENTS: an event can legitimately arrive for a phone with no
// leads row yet (a customer messages the WhatsApp bot before any form
// intake has run for them, or Sarvam calls someone who was never
// otherwise captured). Rather than reject these, they're stored with
// lead_id=NULL and adopted automatically the moment db.intakeLead() next
// resolves that phone (see db.cjs's adoptOrphanEvents, called from inside
// intakeLead()). Losing a lead's earliest checkpoints because they arrived
// a few seconds before the CRM record did would be a worse failure mode
// than a temporarily-orphaned row.

const express = require('express')

const db = require('./db.cjs')
const leadIntake = require('./lead-intake.cjs')
const leadJourney = require('./lead-journey.cjs')

const router = express.Router()

// ── Shared-secret auth ───────────────────────────────────────────
// Two SEPARATE secrets, checked on two SEPARATE endpoints - not shared,
// because the two callers are different trust relationships: OS_EVENTS_
// SHARED_SECRET is a value we mint ourselves and hand to our own bot repos
// (Indihomes-chatbot-V1 / Indiihomes-chatbot-phase2's os_events_client.py),
// so we control both ends and can require an exact match. SARVAM_WEBHOOK_
// SHARED_SECRET is a header check against Sarvam's webhook - Sarvam's real
// signing behavior was never confirmed (see the module docstring on the
// /api/sarvam-webhook route below, "Trap 6") - this is a best-effort layer
// until that's verified, not a real signature check.
//
// Both are OPT-IN: if the corresponding env var is unset, the check is
// skipped entirely (logged ONCE at boot, not per-request, so a
// not-yet-configured deployment isn't spammed) - see this task's earlier
// design conversation for why an ingest endpoint with no auth at all was
// an accepted gap during initial build, and why it's closed here before
// this router is ever reachable from the public internet.
const OS_EVENTS_SHARED_SECRET = (process.env.OS_EVENTS_SHARED_SECRET || '').trim()
const SARVAM_WEBHOOK_SHARED_SECRET = (process.env.SARVAM_WEBHOOK_SHARED_SECRET || '').trim()

if (!OS_EVENTS_SHARED_SECRET) {
  console.warn('[lead-events] WARNING: OS_EVENTS_SHARED_SECRET is not set - POST /api/lead-events will accept requests from anyone who can reach it. Set this before exposing this server to the public internet.')
}
if (!SARVAM_WEBHOOK_SHARED_SECRET) {
  console.warn('[lead-events] WARNING: SARVAM_WEBHOOK_SHARED_SECRET is not set - POST /api/sarvam-webhook will accept requests from anyone who can reach it.')
}

// Constant-time-ish comparison isn't attempted here (needs matching-length
// buffers, adds complexity) - a plain string compare is an accepted gap for
// a shared secret that isn't a session token / doesn't gate money movement;
// revisit if that changes.
function checkSecret(req, res, expected, headerName) {
  if (!expected) return true // not configured - already warned once at boot, allow through
  const provided = String(req.get(headerName) || '')
  if (provided && provided === expected) return true
  console.error(`[lead-events] rejected: missing or incorrect ${headerName} header`)
  res.status(401).json({ ok: false, reason: 'unauthorized' })
  return false
}

// ── Shared phone normalization ──────────────────────────────────────────────
// THE fix for what this task's design conversation flagged as "Trap 1":
// chatbot-V1 and Phase 2 send phone numbers in whatever format WATI gave
// them (typically "91XXXXXXXXXX", no leading +) - NOT this app's bare-
// 10-digit canonical form. Every event MUST go through the exact same
// normalizePhone() the rest of this app already trusts for lead dedup
// (lead-intake.cjs), so a WhatsApp checkpoint and a form intake for the
// same real person always resolve to the same phone key. An event whose
// phone can't be normalized is REJECTED (4xx) and logged loudly, rather
// than silently stored under a garbage key nothing will ever match - a
// tracker row that can never join to a lead is worse than no row at all.
function normalizeIncomingPhone(raw) {
  return leadIntake.normalizePhone(raw)
}

// ── POST /api/lead-events — the generic ingest endpoint ────────────────────
// Body: { phone, channel: 'whatsapp'|'voice', checkpoint, payload?,
//         source_ref?, idempotency_key?, occurred_at? }
// Called by chatbot-V1's os_events_client.py and Phase 2's
// integrations/os_events_client.py - both fire-and-forget, best-effort,
// never let a failure here affect what they return to WATI. Always
// responds 200 with { ok: true|false, ... } - never a 500 for an
// operational problem the caller can't do anything about (an unrecognized
// checkpoint, a bad phone) - those are CALLER bugs, surfaced as ok:false
// + a reason string plus a loud server-side log line, not a crash on
// either side.
router.post('/api/lead-events', (req, res) => {
  if (!checkSecret(req, res, OS_EVENTS_SHARED_SECRET, 'X-OS-Events-Secret')) return
  const body = req.body || {}
  const channel = String(body.channel || '').trim()
  const checkpoint = String(body.checkpoint || '').trim()
  const rawPhone = body.phone

  if (channel !== 'whatsapp' && channel !== 'voice') {
    console.error(`[lead-events] rejected: unknown channel ${JSON.stringify(channel)} (checkpoint=${checkpoint})`)
    return res.json({ ok: false, reason: 'unknown_channel' })
  }

  const phone = normalizeIncomingPhone(rawPhone)
  if (!phone) {
    console.error(`[lead-events] rejected: unrecognized phone ${JSON.stringify(rawPhone)} (channel=${channel} checkpoint=${checkpoint})`)
    return res.json({ ok: false, reason: 'unrecognized_phone' })
  }

  if (!leadJourney.isValidCheckpoint(channel, checkpoint)) {
    // Deliberately rejected, not silently accepted - an emitter drifting
    // from lead-journey.cjs's vocabulary (a typo, a renamed checkpoint on
    // one side not mirrored here) must be caught immediately as a visible
    // 'ok:false' + log line, not accepted into a lead_events row the
    // tracker will never render (since journey.cjs only ever projects
    // checkpoints IT knows about) - see this task's design conversation.
    console.error(`[lead-events] rejected: checkpoint ${JSON.stringify(checkpoint)} is not valid for channel ${channel}`)
    return res.json({ ok: false, reason: 'invalid_checkpoint' })
  }

  const lead = db.findLeadByPhone(phone)
  const idempotencyKey = body.idempotency_key
    ? String(body.idempotency_key)
    // Fallback key if the caller didn't supply one - still collapses an
    // exact retry (same phone+checkpoint+occurred_at) into one row, just
    // without protection against a caller re-sending the SAME logical
    // event with a fresh timestamp (callers should always send their own
    // idempotency_key - see os_events_client.py in both bot repos).
    : `${phone}:${channel}:${checkpoint}:${body.occurred_at || ''}`

  let occurredAt = Date.now()
  if (body.occurred_at) {
    const parsed = new Date(body.occurred_at).getTime()
    if (!Number.isNaN(parsed)) occurredAt = parsed
  }

  try {
    const result = db.insertLeadEvent({
      leadId: lead ? lead.id : null,
      phone, channel, checkpoint,
      payload: body.payload || null,
      sourceRef: body.source_ref || null,
      idempotencyKey,
      occurredAt,
    })
    if (result.deduped) {
      return res.json({ ok: true, deduped: true })
    }
    return res.json({ ok: true, lead_id: lead ? lead.id : null, orphan: !lead })
  } catch (e) {
    console.error('[lead-events] insertLeadEvent failed:', e.message)
    return res.json({ ok: false, reason: 'insert_failed' })
  }
})

// ── Sarvam checkpoint vocabulary ────────────────────────────────────────────
// Maps Sarvam's own `status` values (see the Instant Outbound webhook
// payload docs - confirmed 'connected'|'no_answer'|'busy'|'failed') onto
// this app's voice ladder (lead-journey.cjs). A value Sarvam sends that
// isn't in this map is logged and dropped rather than guessed at - this
// mapping was NOT validated against a live Sarvam account (no account was
// available while building this) - see LEAD_EVENTS_INTEGRATION.md's "Trap
// 6" note before trusting this in production.
const SARVAM_STATUS_TO_CHECKPOINT = {
  connected: 'call_connected',
  no_answer: 'call_no_answer',
  busy: 'call_busy',
  failed: 'call_failed',
}

// ── POST /api/sarvam-webhook — Sarvam's native post-call webhook ───────────
// Body shape per Sarvam's Instant Outbound webhook payload docs:
//   { attempt_id, status, channel_info, duration, interaction_id,
//     failure_reason, final_agent_variables, webhook_config, interaction_transcript }
// `webhook_config.metadata.phone` is how this correlates back to a real
// lead - set that metadata when TRIGGERING the outbound call (see
// LEAD_EVENTS_INTEGRATION.md for the exact call-creation snippet); without
// it, this webhook has no phone to key off and the event is stored as a
// fully unaddressable orphan (phone will be empty string, which
// normalizeIncomingPhone rejects - see below).
//
// SIGNING / RETRY - UNVERIFIED, FLAGGED EXPLICITLY (see this task's design
// conversation, "Trap 6"): whether Sarvam signs this payload or retries on
// a non-200 was not confirmed against a live account while building this.
// SARVAM_WEBHOOK_SHARED_SECRET below is an OPTIONAL, best-effort header
// check (X-Sarvam-Signature or similar) - if the env var is unset, this
// check is skipped entirely and a warning is logged once at boot (see
// server.cjs wiring), NOT on every request. Do not treat this as a real
// security boundary until Sarvam's actual signing behavior is confirmed.
router.post('/api/sarvam-webhook', (req, res) => {
  if (!checkSecret(req, res, SARVAM_WEBHOOK_SHARED_SECRET, 'X-Sarvam-Signature')) return
  const body = req.body || {}
  const attemptId = String(body.attempt_id || '')
  const status = String(body.status || '')
  const phoneRaw = body.webhook_config?.metadata?.phone

  const checkpoint = SARVAM_STATUS_TO_CHECKPOINT[status]
  if (!checkpoint) {
    console.error(`[sarvam-webhook] rejected: unrecognized status ${JSON.stringify(status)} (attempt_id=${attemptId}) - see SARVAM_STATUS_TO_CHECKPOINT in lead-events.cjs`)
    return res.json({ ok: false, reason: 'unrecognized_status' })
  }

  const phone = normalizeIncomingPhone(phoneRaw)
  if (!phone) {
    console.error(`[sarvam-webhook] rejected: no usable phone in webhook_config.metadata.phone (attempt_id=${attemptId}) - was it set when the call was created?`)
    return res.json({ ok: false, reason: 'no_phone_metadata' })
  }

  const lead = db.findLeadByPhone(phone)
  const payload = {
    duration: body.duration ?? null,
    failure_reason: body.failure_reason ?? null,
    // final_agent_variables carries whatever the Sarvam agent extracted
    // during the call - e.g. a `disposition` field, if that variable is
    // configured on the agent side. Stored verbatim so the (i) icon on
    // the tracker can show it, and so a future auto-classifier has raw
    // material to read without needing a second Sarvam API call.
    final_agent_variables: body.final_agent_variables ?? null,
    interaction_id: body.interaction_id ?? null,
    channel_provider: body.channel_info?.channel_provider ?? null,
  }

  try {
    const result = db.insertLeadEvent({
      leadId: lead ? lead.id : null,
      phone, channel: 'voice', checkpoint,
      payload,
      sourceRef: attemptId || null,
      idempotencyKey: attemptId ? `sarvam:${attemptId}` : null,
      occurredAt: Date.now(),
    })

    // A connected call additionally logs 'call_attempted' if that
    // checkpoint isn't already on record - Sarvam's webhook only fires
    // ONCE, after the attempt completes, so there's no separate
    // "call started" event to key off; this backfills the ladder's first
    // rung so the tracker doesn't show a gap between "nothing" and
    // "connected".
    if (checkpoint === 'call_connected' || checkpoint === 'call_no_answer' || checkpoint === 'call_busy' || checkpoint === 'call_failed') {
      try {
        db.insertLeadEvent({
          leadId: lead ? lead.id : null,
          phone, channel: 'voice', checkpoint: 'call_attempted',
          payload: null, sourceRef: attemptId || null,
          idempotencyKey: attemptId ? `sarvam:${attemptId}:attempted` : null,
          occurredAt: Date.now() - Math.round((body.duration || 0) * 1000),
        })
      } catch (e) {
        console.error('[sarvam-webhook] backfilling call_attempted failed:', e.message)
      }
    }

    return res.json({ ok: true, deduped: !!result.deduped, lead_id: lead ? lead.id : null, orphan: !lead })
  } catch (e) {
    console.error('[sarvam-webhook] insertLeadEvent failed:', e.message)
    return res.json({ ok: false, reason: 'insert_failed' })
  }
})

// ── GET /api/leads/:id/journey — the vertical tracker ───────────────────────
// Returns the ladder (from lead-journey.cjs) joined against this lead's
// real events, per channel - the frontend renders this directly, it never
// re-derives ladder logic client-side (see this task's design
// conversation for why the ladder/events split matters).
router.get('/api/leads/:id/journey', (req, res) => {
  const leadId = parseInt(req.params.id, 10)
  try {
    const events = db.listLeadEventsForLead(leadId)
    const byChannel = (channel) => {
      const channelEvents = events.filter(e => e.channel === channel)
      const ladder = leadJourney.LADDERS[channel].map(step => {
        const match = channelEvents.find(e => e.checkpoint === step.key)
        return {
          key: step.key,
          label: step.label,
          info: step.info,
          reached: !!match,
          occurredAt: match ? match.occurred_at : null,
          payload: (step.info && match) ? match.payload : null,
        }
      })
      return ladder
    }
    res.json({ whatsapp: byChannel('whatsapp'), voice: byChannel('voice') })
  } catch (e) {
    console.error('[lead-events] /journey error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/leads/:id/ai-activity — the tick mascots ───────────────────────
router.get('/api/leads/:id/ai-activity', (req, res) => {
  const leadId = parseInt(req.params.id, 10)
  try {
    res.json(db.getAiActivity(leadId))
  } catch (e) {
    console.error('[lead-events] /ai-activity error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Meta CAPI qualification dispatch (used by server.cjs's PATCH route) ────
// Exported as a plain function, not a route - server.cjs's PATCH
// /api/leads/:id handler calls this directly, hot-path, right after a
// qualification write succeeds (see this task's design conversation,
// "two-lane delivery"). Kept here rather than duplicated inline in
// server.cjs since lead-events.cjs already owns the qualification.cjs +
// meta-capi.cjs wiring for the read side.
//
// SCOPE: only fires for primary_source === 'meta' - see meta-capi.cjs's
// sendQualificationEvent docstring ("Trap 5") for why. Never throws -
// logs and swallows, exactly like every other best-effort side effect in
// this codebase (crm push, lead routing, etc).
async function dispatchQualificationToMeta(lead) {
  if (!lead || lead.primary_source !== 'meta') return { skipped: true, reason: 'not_meta_lead' }
  const metaCapi = require('./meta-capi.cjs')
  if (!metaCapi.isConfigured()) return { skipped: true, reason: 'not_configured' }
  if (db.hasSuccessfulCapiSend(lead.id, `qual:${lead.qualification}:${lead.qualified_at}`)) {
    return { skipped: true, reason: 'already_sent' }
  }
  try {
    const result = await metaCapi.sendQualificationEvent(lead)
    if (result.skipped) return result
    db.recordMetaCapiSend(lead.id, {
      eventId: result.eventId,
      // Reuses meta_capi_log's crm_status column to also store
      // qualification-event dedup state, prefixed 'qual:' so it can never
      // collide with a real crm_status value ('success'/'failed') -
      // avoids a schema migration for a second log table that would
      // otherwise be byte-for-byte identical to this one.
      crmStatus: `qual:${lead.qualification}:${lead.qualified_at}`,
      status: result.ok ? 'success' : 'failed',
      httpStatus: result.httpStatus,
      responseBody: result.responseBody,
    })
    if (!result.ok) console.error(`[lead-events] Meta CAPI qualification send failed for lead ${lead.id}:`, result.error)
    return result
  } catch (e) {
    console.error(`[lead-events] Meta CAPI qualification send threw for lead ${lead.id}:`, e.message)
    return { skipped: false, ok: false, error: e.message }
  }
}

module.exports = router
module.exports.dispatchQualificationToMeta = dispatchQualificationToMeta
