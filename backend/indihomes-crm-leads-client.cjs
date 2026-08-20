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

const RAW_BASE = (process.env.INDIHOMES_API_BASE_URL || 'https://api.indihomes.co.in').replace(/\/$/, '')
const ROOT_URL = RAW_BASE.replace(/\/api\/v1$/, '')
const TIMEOUT_MS = parseInt(process.env.INDIHOMES_CRM_READ_TIMEOUT_MS, 10) || 15000
const PAGE_SIZE = 100
const PAGE_CONCURRENCY = parseInt(process.env.INDIHOMES_CRM_PAGE_CONCURRENCY, 10) || 6
const CACHE_TTL_MS = parseInt(process.env.INDIHOMES_CRM_READ_CACHE_TTL_MS, 10) || 45000
let leadsCache = null
let leadsCacheAt = 0
let refreshPromise = null
const pageCache = new Map()

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
  if (!res.ok) {
    const error = new Error(json?.message || json?.error || `IndiHomes CRM ${res.status}: ${text.slice(0, 200)}`)
    error.details = { endpoint: url.split('?')[0], page: Number(new URL(url).searchParams.get('page')) || undefined, status: res.status, upstreamError: json?.message || json?.error }
    throw error
  }
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
  return getJson(`${ROOT_URL}/api/v1/get-paginated-leads?page=${page}&limit=${limit}&budget=`)
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

// classifyLead — FINAL rule, from a diagram, single source of truth: a lead
// is a Housing.com lead if projectName is present/non-empty, otherwise it's
// a Meta lead. Nothing else (phone, configuration, webhook fields, a
// separate source directory) enters into it — this replaces every earlier
// attempt at this classification (get-lead-src cross-reference, Meta
// webhook-field presence, project+configuration absence) wholesale.
function classifyLead(lead) {
  const projectName = typeof lead?.projectName === 'string' ? lead.projectName.trim() : ''
  return projectName !== '' && projectName !== '-' ? 'housing' : 'meta'
}

// normalizePhone — strip everything but digits, keep the last 10. Collapses
// +91-prefixed, 0-prefixed, and bare 10-digit forms of the same Indian
// number to one dedup key.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  return digits.slice(-10)
}

function pick(obj, keys) {
  for (const k of keys) if (obj?.[k] != null && obj[k] !== '') return obj[k]
  return null
}

function normalizeLeads(leads) {
  const seenIds = new Set()
  return leads.filter(lead => {
    if (lead?.id == null) return true
    const id = String(lead.id)
    if (seenIds.has(id)) return false
    seenIds.add(id)
    return true
  }).map(lead => ({ ...lead, classification: classifyLead(lead) }))
}

async function fetchAllCrmLeads() {
  const allLeads = []
  const fetchPage = async page => {
    console.log(`[crm] fetching page ${page}`)
    const result = await getPaginatedLeads({ page, limit: PAGE_SIZE })
    if (!result?.success) {
      const error = new Error(result?.error || result?.message || 'Failed to fetch CRM leads')
      error.details = { endpoint: `${ROOT_URL}/api/v1/get-paginated-leads`, page, upstreamError: error.message }
      throw error
    }
    if (!Array.isArray(result.data)) {
      const error = new Error(`CRM page ${page} returned invalid lead data`)
      error.details = { endpoint: `${ROOT_URL}/api/v1/get-paginated-leads`, page, upstreamError: error.message }
      throw error
    }
    const parsedTotalPages = Number(result.totalPages)
    if (!Number.isInteger(parsedTotalPages) || parsedTotalPages < 1) {
      const error = new Error(`CRM page ${page} returned invalid totalPages`)
      error.details = { endpoint: `${ROOT_URL}/api/v1/get-paginated-leads`, page, upstreamError: error.message }
      throw error
    }
    return { data: result.data, totalPages: parsedTotalPages }
  }

  // Fetch page 1 first because it tells us how many pages exist. The
  // remaining pages are then fetched in bounded parallel waves.
  const firstPage = await fetchPage(1)
  allLeads.push(...firstPage.data)
  for (let start = 2; start <= firstPage.totalPages; start += PAGE_CONCURRENCY) {
    const pages = []
    for (let page = start; page < start + PAGE_CONCURRENCY && page <= firstPage.totalPages; page++) {
      pages.push(fetchPage(page))
    }
    const results = await Promise.all(pages)
    for (const result of results) allLeads.push(...result.data)
  }
  return normalizeLeads(allLeads)
}

async function getAllCrmLeads({ refresh = false } = {}) {
  if (!refresh && leadsCache && Date.now() - leadsCacheAt < CACHE_TTL_MS) return leadsCache
  if (refreshPromise) return refreshPromise
  refreshPromise = fetchAllCrmLeads().then(leads => {
    leadsCache = leads
    leadsCacheAt = Date.now()
    return leads
  }).finally(() => { refreshPromise = null })
  return refreshPromise
}

async function getCrmLeadPage({ page = 1, limit = 50, refresh = false } = {}) {
  const cacheKey = `${page}:${limit}`
  const cached = pageCache.get(cacheKey)
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  const result = await getPaginatedLeads({ page, limit })
  if (!result?.success) throw new Error(result?.error || result?.message || 'Failed to fetch CRM leads')
  if (!Array.isArray(result.data)) throw new Error(`CRM page ${page} returned invalid lead data`)
  const totalPages = Number(result.totalPages)
  if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error(`CRM page ${page} returned invalid totalPages`)
  const value = { leads: normalizeLeads(result.data), page, limit, total: Number(result.total) || result.data.length, totalPages }
  pageCache.set(cacheKey, { value, at: Date.now() })
  return value
}

function getCachedCrmSummary() {
  if (!leadsCache || Date.now() - leadsCacheAt >= CACHE_TTL_MS) return null
  return {
    total: leadsCache.length,
    housingTotal: leadsCache.filter(lead => lead.classification === 'housing').length,
    metaTotal: leadsCache.filter(lead => lead.classification === 'meta').length,
  }
}

function warmCrmCache() {
  if (!leadsCache || Date.now() - leadsCacheAt >= CACHE_TTL_MS) {
    getAllCrmLeads().catch(error => console.error('[crm] background summary failed:', error.message))
  }
}

async function getAllLeadsClassified(options = {}) {
  const leads = await getAllCrmLeads(options)
  return {
    all: leads,
    housing: leads.filter(lead => lead.classification === 'housing'),
    meta: leads.filter(lead => lead.classification === 'meta'),
  }
}

function isConfigured() { return true } // same base URL as the rest of the IndiHomes integration — no separate flag

module.exports = {
  isConfigured, getNewLeads, getLeadHistory, getPaginatedLeads, syncMetaLeads, getLeadSources,
  classifyLead, normalizePhone, getAllCrmLeads, getCrmLeadPage, getCachedCrmSummary, warmCrmCache, getAllLeadsClassified,
}
