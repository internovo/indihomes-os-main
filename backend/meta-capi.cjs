'use strict'

// Meta Conversions API (CAPI) — server-to-server reporting of what happened
// to a Meta-sourced lead after it landed in our system, so Meta's ad
// delivery/optimization can react to real outcomes instead of just "a form
// was submitted".
//
// IMPORTANT — event naming reflects REAL data, not an assumed one: this
// codebase's only actual "CRM status" is `leads.crm_status`
// (not_pushed / success / failed — whether the push to IndiHomes' own
// createLead API succeeded), NOT a lead-qualification/interest signal. No
// "interested/not interested" or "qualified/disqualified" concept exists
// anywhere in this codebase today (confirmed: leads.status is a separate,
// currently-unedited field defaulting to 'New' for every lead). Event names
// below say exactly what they mean — CRM push outcome — rather than
// borrowing qualification language the underlying data doesn't support.
// If a real qualification signal is added later, wire IT in here instead of
// relearning this file's shape.

const crypto = require('crypto')

const GRAPH_VERSION = 'v21.0'
const CAPI_ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN || ''
const DATASET_ID = process.env.META_DATASET_ID || ''
const TEST_EVENT_CODE = process.env.META_CAPI_TEST_EVENT_CODE || ''

function isConfigured() { return !!(CAPI_ACCESS_TOKEN && DATASET_ID) }

// The only two crm_status values worth reporting — 'not_pushed' means no
// decision has been made yet (push disabled, or not attempted), which isn't
// an outcome to tell Meta about.
const EVENT_NAME_FOR_STATUS = {
  success: 'Lead_CRM_Push_Success',
  failed: 'Lead_CRM_Push_Failed',
}

// Qualification events (added alongside CRM-push events above, NOT
// replacing them - these report a DIFFERENT fact: whether the lead itself
// turned out to be a real buyer, not whether our CRM push succeeded). See
// this task's design conversation for the full "status -> classify() ->
// Meta CAPI" writeup. 'unknown' is deliberately absent from this map -
// there is nothing true to tell Meta yet, so no event is ever built for it.
const EVENT_NAME_FOR_QUALIFICATION = {
  qualified: 'Lead_Qualified',
  disqualified: 'Lead_Disqualified',
}

function normalizePhoneForHash(phone) {
  let digits = String(phone || '').replace(/\D/g, '')
  if (digits.length === 10) digits = `91${digits}` // this app's bare-10-digit convention -> E.164 country code, no leading '+'
  return digits
}

function hashPhone(phone) {
  const normalized = normalizePhoneForHash(phone)
  if (!normalized) return null
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

// Builds the CAPI event payload for one lead at its current crm_status.
// Returns null when crm_status isn't a reportable state (see above) or the
// lead has no phone to hash (user_data.ph is the only match key we have).
function buildEvent(lead, { metaLeadgenId } = {}) {
  const eventName = EVENT_NAME_FOR_STATUS[lead.crm_status]
  if (!eventName) return null
  const ph = hashPhone(lead.phone)
  if (!ph) return null
  return {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: String(lead.id), // internal lead id — Meta-side dedup key
    action_source: 'system_generated',
    user_data: { ph: [ph] },
    ...(metaLeadgenId ? { lead_id: metaLeadgenId } : {}),
  }
}

async function sendEvent(lead, { metaLeadgenId } = {}) {
  if (!isConfigured()) throw new Error('META_CAPI_ACCESS_TOKEN / META_DATASET_ID not set')
  const event = buildEvent(lead, { metaLeadgenId })
  if (!event) return { skipped: true, reason: !EVENT_NAME_FOR_STATUS[lead.crm_status] ? 'crm_status not reportable' : 'no phone to hash' }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(DATASET_ID)}/events`
  const body = {
    data: [event],
    access_token: CAPI_ACCESS_TOKEN,
    ...(TEST_EVENT_CODE ? { test_event_code: TEST_EVENT_CODE } : {}),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) { /* non-JSON error body */ }
  return {
    skipped: false,
    ok: res.ok,
    httpStatus: res.status,
    eventId: event.event_id,
    responseBody: text,
    error: !res.ok ? (json?.error?.message || `Meta CAPI ${res.status}`) : null,
  }
}

// Builds the CAPI event payload for one lead's CURRENT qualification value.
// Returns null when qualification isn't a reportable state ('unknown') or
// the lead has no phone to hash.
//
// event_id INCLUDES the qualification value and qualified_at timestamp,
// NOT just the lead id (contrast with buildEvent() above, which uses a
// bare lead.id since crm_status is push-outcome and effectively fires
// once). Qualification can genuinely transition back and forth
// (Qualified -> Disqualified -> Qualified, e.g. a lead goes cold then a
// different unit opens up) and Meta dedups on (event_name, event_id) - a
// bare lead.id would make every transition AFTER the first one silently
// vanish as a "duplicate" of an event Meta already saw. This was caught
// and fixed during design, before it ever shipped - see this task's
// design conversation for the full trap writeup.
function buildQualificationEvent(lead) {
  const eventName = EVENT_NAME_FOR_QUALIFICATION[lead.qualification]
  if (!eventName) return null
  const ph = hashPhone(lead.phone)
  if (!ph) return null
  return {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: `${lead.id}:${lead.qualification}:${lead.qualified_at || 0}`,
    action_source: 'system_generated',
    user_data: { ph: [ph] },
  }
}

// Sends one lead's qualification outcome to Meta CAPI. Deliberately NOT
// gated on lead.primary_source === 'meta' inside this function itself -
// that filter is the CALLER's job (see server.cjs's qualification sweep
// and the hot-path dispatch in the PATCH /api/leads/:id handler), matching
// the SAME population restriction runMetaCapiSync() already applies for
// CRM-push events in server.cjs. Reporting a non-Meta lead's qualification
// to Meta CAPI has no ad-optimization value (Meta can't attribute it back
// to an ad it served) and was deliberately scoped out - see this task's
// design conversation, "Trap 5", for why this mirrors the existing filter
// rather than reporting every lead regardless of source.
async function sendQualificationEvent(lead) {
  if (!isConfigured()) throw new Error('META_CAPI_ACCESS_TOKEN / META_DATASET_ID not set')
  const event = buildQualificationEvent(lead)
  if (!event) return { skipped: true, reason: !EVENT_NAME_FOR_QUALIFICATION[lead.qualification] ? 'qualification not reportable' : 'no phone to hash' }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(DATASET_ID)}/events`
  const body = {
    data: [event],
    access_token: CAPI_ACCESS_TOKEN,
    ...(TEST_EVENT_CODE ? { test_event_code: TEST_EVENT_CODE } : {}),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) { /* non-JSON error body */ }
  return {
    skipped: false,
    ok: res.ok,
    httpStatus: res.status,
    eventId: event.event_id,
    responseBody: text,
    error: !res.ok ? (json?.error?.message || `Meta CAPI ${res.status}`) : null,
  }
}

module.exports = {
  isConfigured, hashPhone, buildEvent, sendEvent, EVENT_NAME_FOR_STATUS,
  buildQualificationEvent, sendQualificationEvent, EVENT_NAME_FOR_QUALIFICATION,
}
