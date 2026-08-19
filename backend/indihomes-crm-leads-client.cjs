'use strict'

// IndiHomes CRM READ client (Section 8) — genuinely new capability. Every
// existing IndiHomes integration in this codebase only ever PUSHES data
// (indihomes-leads-client.cjs's createLead, indihomes-client.cjs's project
// catalog fetch is a read but of PROJECTS not leads). Nothing before this
// file ever read leads BACK from IndiHomes' own CRM — "Meta Ad Leads" was
// instead pulled directly from Facebook's Graph API (meta-client.cjs),
// entirely bypassing IndiHomes' system of record. This client wires up the
// four endpoints the brief names, all relative to INDIHOMES_API_BASE_URL
// (same env var indihomes-leads-client.cjs already uses — never a second,
// hardcoded base URL).
//
// Two of the four endpoints (get-new-leads, meta-leads/get-lead-history)
// are NOT under /api/v1 in the brief's own literal paths, while the other
// two explicitly ARE (/api/v1/get-paginated-leads, /api/v1/get-lead-src) —
// so this derives a bare ROOT_URL (strips a trailing /api/v1 if the env
// var's default already includes it, matching indihomes-leads-client.cjs's
// own default) and builds each endpoint's exact path from that, rather than
// assuming they all share one prefix.

const RAW_BASE = (process.env.INDIHOMES_API_BASE_URL || 'https://api.indihomes.co.in/api/v1').replace(/\/$/, '')
const ROOT_URL = RAW_BASE.replace(/\/api\/v1$/, '')
const TIMEOUT_MS = parseInt(process.env.INDIHOMES_CRM_READ_TIMEOUT_MS, 10) || 15000

// Auth for these specific lead-read endpoints — UNCONFIRMED whether they even
// require one (indihomes-client.cjs's project-catalog endpoints are
// explicitly documented "no auth", but that's public listing data; these are
// customer PII, a different sensitivity class, and a live 500 "Server error
// fetching leads" is consistent with a missing-auth requirement). Wired in
// now, inert until a real value is set, so no further code change is needed
// once the correct header name/value is confirmed — just set the env var(s).
// Tries a Bearer token first (most common for an internal API), falls back
// to a plain API-key header if that's what's actually required instead.
const API_KEY = process.env.INDIHOMES_CRM_API_KEY || ''
const API_KEY_HEADER = process.env.INDIHOMES_CRM_API_KEY_HEADER || 'Authorization'
function authHeaders() {
  if (!API_KEY) return {}
  if (API_KEY_HEADER.toLowerCase() === 'authorization' && !API_KEY.toLowerCase().startsWith('bearer ')) {
    return { Authorization: `Bearer ${API_KEY}` }
  }
  return { [API_KEY_HEADER]: API_KEY }
}

async function getJson(url) {
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) { /* fall through to raw-text error below */ }
  if (!res.ok) throw new Error(json?.message || json?.error || `IndiHomes CRM ${res.status}: ${text.slice(0, 200)}`)
  return json
}

// GET /get-new-leads — leads not yet pulled into this app.
async function getNewLeads() {
  return getJson(`${ROOT_URL}/get-new-leads`)
}

// GET /meta-leads/get-lead-history/:number — full conversation/touch history
// for one lead by phone number.
async function getLeadHistory(number) {
  const n = String(number || '').replace(/\D/g, '')
  if (!n) throw new Error('a phone number is required')
  return getJson(`${ROOT_URL}/meta-leads/get-lead-history/${encodeURIComponent(n)}`)
}

// GET /api/v1/get-paginated-leads — the bulk listing endpoint, paginated.
//
// CONFIRMED live: the bare /get-paginated-leads path (no /api/v1/ prefix)
// returns a genuine 404 "Cannot GET" HTML page — no route exists there at
// all. This /api/v1/-prefixed path (the ORIGINAL spec, reverted back to
// after briefly trying the bare version) returns a real 500 with a
// structured JSON error body ("Server error fetching leads") instead —
// proof this route DOES exist and has real server-side logic that ran and
// threw, which a 404 could never produce. The earlier informal
// clarification showing this endpoint without the /api/v1/ prefix was
// shorthand, not the literal path. The 500 itself is a separate, still-
// unresolved problem (likely auth or a missing/wrong parameter) — see
// authHeaders() below.
async function getPaginatedLeads({ page = 1, limit = 100 } = {}) {
  return getJson(`${ROOT_URL}/api/v1/get-paginated-leads?page=${page}&limit=${limit}`)
}

// POST /api/v1/meta-leads/sync — a Meta-SPECIFIC sync trigger, distinct
// from the generic get-paginated-leads listing above. Takes an ISO date
// range ({since, until}) and (per its name) triggers/returns Meta leads for
// that window specifically — likely the actual intended way to pull Meta
// leads from this CRM, rather than fetching every lead of every source via
// get-paginated-leads and filtering client-side. Response shape isn't
// documented; handled defensively below (checks a few plausible array keys,
// falls back to treating the whole body as the leads array if it's already
// one).
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) { /* fall through to raw-text error below */ }
  if (!res.ok) throw new Error(json?.message || json?.error || `IndiHomes CRM ${res.status}: ${text.slice(0, 200)}`)
  return json
}
function defaultSyncWindow() {
  const until = new Date()
  const since = new Date(until.getTime() - 30 * 86400000) // last 30 days by default
  return { since: since.toISOString(), until: until.toISOString() }
}
async function syncMetaLeads({ since, until } = {}) {
  const window = (since && until) ? { since, until } : defaultSyncWindow()
  const body = await postJson(`${ROOT_URL}/api/v1/meta-leads/sync`, window)
  // Defensive extraction — same "try plausible keys, don't assume" pattern
  // used throughout this file for an undocumented response shape.
  if (Array.isArray(body)) return body
  return body?.leads || body?.data || body?.synced || []
}

// GET /api/v1/get-lead-src — the CRM's own lead-source directory. Real
// campaign-level source strings (e.g. "Ethics Orovia EOI Malad W Video v1
// 1308") per the brief's own explicit example — NOT a simple "Meta"/
// "Housing"/"Website" enum. This endpoint is what actually tells us which
// channel/platform a given source string belongs to; filtering by a
// hardcoded "contains Meta" string match on the source text itself would
// misclassify campaign names that don't literally contain the word "Meta".
async function getLeadSources() {
  return getJson(`${ROOT_URL}/api/v1/get-lead-src`)
}

// isMetaSource — SIMPLIFIED per explicit instruction: a lead with a real
// phone number but NO project name is identified as a Meta lead. (Earlier
// version also required configuration to be absent; narrowed to project-
// name-only per direct instruction.)
function isMetaSource(lead) {
  if (!lead) return false
  const phone = lead.phone || lead.mobile || lead.contact_number || lead.number
  if (!phone) return false
  const project = lead.project || lead.project_name || lead.projectName
  return !project
}

function isConfigured() { return true } // same base URL as the rest of the IndiHomes integration — no separate flag

module.exports = { isConfigured, getNewLeads, getLeadHistory, getPaginatedLeads, syncMetaLeads, getLeadSources, isMetaSource }
