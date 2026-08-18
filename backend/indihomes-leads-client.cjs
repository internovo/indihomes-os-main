'use strict'

// Official IndiHomes CRM lead push — POST /api/v1/createLead. This is the
// ONLY way a lead captured in IndiHomes OS reaches IndiHomes' own system of
// record; nothing here writes to Cosmos or any other external database
// directly, and nothing calls this API unless INDIHOMES_LEAD_PUSH_ENABLED
// is explicitly 'true'.

const BASE_URL = (process.env.INDIHOMES_API_BASE_URL || 'https://api.indihomes.co.in/api/v1').replace(/\/$/, '')
const TIMEOUT_MS = parseInt(process.env.INDIHOMES_LEAD_PUSH_TIMEOUT_MS, 10) || 10000

function isEnabled() { return process.env.INDIHOMES_LEAD_PUSH_ENABLED === 'true' }
function getConfig() { return { enabled: isEnabled(), baseUrl: BASE_URL, timeoutMs: TIMEOUT_MS } }

// Internal source key -> the lead_source value the brief's examples use.
const LEAD_SOURCE_LABEL = {
  manual: 'IndiHomes OS',
  website: 'Website',
  meta: 'Meta',
  housing: 'Housing.com',
}
function mapLeadSource(source) { return LEAD_SOURCE_LABEL[source] || 'IndiHomes OS' }

function clean(v) {
  const s = (v ?? '').toString().trim()
  return s ? s : undefined // undefined keys are dropped by JSON.stringify — never send empty-string noise
}

// `lead` is a local `leads` row (or an equivalent shape) plus whatever
// transient fields (targetPossessionDate/userType/notes) the caller has on
// hand from the original intake that aren't persisted as their own columns.
async function createLead(lead) {
  if (!isEnabled()) throw new Error('INDIHOMES_LEAD_PUSH_ENABLED is not true — CRM push is disabled')
  if (!lead?.phone) throw new Error('phone is required to push a lead to IndiHomes CRM')

  const body = {
    name: clean(lead.name),
    phone: clean(lead.phone),
    email: clean(lead.email),
    flat_config: clean(lead.configuration),
    projectCode: clean(lead.projectCode),
    targetPossessionDate: clean(lead.targetPossessionDate),
    budget: clean(lead.budget),
    preferred_location: clean(lead.location),
    notes: clean(lead.notes),
    lead_source: mapLeadSource(lead.source),
    user_type: clean(lead.userType) || 'buyer',
  }

  const res = await fetch(`${BASE_URL}/createLead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) { /* non-JSON error body — fall through to raw text below */ }
  if (!res.ok || json?.success === false) {
    throw new Error(json?.message || `IndiHomes createLead ${res.status}: ${text.slice(0, 200)}`)
  }
  return json
}

module.exports = { isEnabled, getConfig, createLead }
