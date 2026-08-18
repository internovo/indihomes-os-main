'use strict'

// Client for IndiHomes' own official property API — the sole data source for
// Filter Search (brief rule 1). The frontend never calls this API directly;
// everything here is server-side, normalized into a stable internal shape,
// cached, and fallback-safe if the upstream API is down.
//
// Base URL: https://api.indihomes.co.in/api/v1  (read endpoints, no auth)
//   GET /fetchPaginatedFilteredProjectList  — list + filters
//   GET /fetchProject?id={id}               — single project by id
//   GET /fetchProjectByName?projectName=... — single project by internal code

const scoring = require('./scoring.cjs')

const BASE_URL = (process.env.INDIHOMES_API_BASE_URL || 'https://api.indihomes.co.in/api/v1').replace(/\/$/, '')
const TTL_MS = parseInt(process.env.INDIHOMES_PROJECTS_CACHE_TTL_MS, 10) || 300000
const TIMEOUT_MS = parseInt(process.env.INDIHOMES_PROJECTS_TIMEOUT_MS, 10) || 10000

function isEnabled() { return process.env.INDIHOMES_PROJECTS_ENABLED !== 'false' }
function getConfig() { return { baseUrl: BASE_URL, enabled: isEnabled(), ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS } }

// ── Cache: fresh (TTL) + never-expiring "last good" fallback per cache key ──
const cache = new Map()      // key -> { data, ts }
const lastGood = new Map()   // key -> { data, ts }  (updated only on success, kept forever)

async function cachedCall(key, fn) {
  const fresh = cache.get(key)
  if (fresh && Date.now() - fresh.ts < TTL_MS) return { ...fresh.data, fromCache: true, stale: false }
  try {
    const data = await fn()
    cache.set(key, { data, ts: Date.now() })
    lastGood.set(key, { data, ts: Date.now() })
    return { ...data, fromCache: false, stale: false }
  } catch (e) {
    const good = lastGood.get(key)
    if (good) {
      console.warn(`[indihomes-client] live call failed (${e.message}), serving last-good cache for ${key}`)
      return { ...good.data, fromCache: true, stale: true, _staleReason: e.message }
    }
    throw e
  }
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v))
  }
  const url = `${BASE_URL}${path}${qs.toString() ? `?${qs}` : ''}`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (_) { throw new Error(`IndiHomes API returned non-JSON response (${res.status})`) }
  if (!res.ok) throw new Error(`IndiHomes API ${res.status}: ${body?.message || text.slice(0, 200)}`)
  return body
}

// ── Normalization helpers (per the documented data rules) ──────────────────
function toArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]) }

function normalizeMediaList(list) {
  return toArray(list).map(m => {
    if (typeof m === 'string') return { url: m, tag: null }
    if (m && typeof m === 'object') return { url: m.url || '', tag: m.tag || null }
    return null
  }).filter(m => m && m.url)
}

function normalizeLocation(loc) {
  if (!loc) return { label: '', value: '' }
  if (typeof loc === 'string') return { label: loc, value: loc }
  return { label: loc.label || loc.value || '', value: loc.value || loc.label || '' }
}

function castCarpet(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// IMPORTANT: `carpetSize` means two DIFFERENT shapes depending on where it
// appears in a live response (confirmed directly against fetchProjectByName
// for INV_MW_441 / "Chaitanya Ethics Orovia") — this was the actual reason
// the Inventory table kept showing "Not published" even after this function
// was added: it was being applied to the per-item field, which isn't this
// shape at all.
//   - raw.carpetSize            -> OBJECT { min, max, unit } — a PROJECT-WIDE
//     summary range across every unit type combined (e.g. 619-1222 sq ft
//     spanning both 2BHK and 3BHK). Not what a per-row Inventory table wants.
//   - raw.flatInventory[i].carpetSize -> a plain NUMBER (e.g. 867) — that
//     SPECIFIC unit variant's carpet area. This is what resolveFlatCarpet()
//     below reads per row; formatCarpetSize() here only ever applies to the
//     project-level object shape.
function formatCarpetSize(carpetSize) {
  if (!carpetSize || typeof carpetSize !== 'object') return null
  const min = castCarpet(carpetSize.min)
  const max = castCarpet(carpetSize.max)
  if (min == null && max == null) return null
  if (min != null && max != null && min !== max) return `${min} - ${max} sq ft`
  return `${min ?? max} sq ft`
}

// Per-unit-row price ("₹2.51 Cr", no "From " prefix — that's only for the
// project-wide starting price). flatInventory[i].price is a raw rupee number.
function formatPrice(rupees) {
  if (rupees == null || !Number.isFinite(rupees) || rupees <= 0) return null
  if (rupees >= 1e7) return `₹${(rupees / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (rupees >= 1e5) return `₹${Math.round(rupees / 1e5)} L`
  return `₹${rupees.toLocaleString('en-IN')}`
}

function formatBudgetLabel(minRupees) {
  if (minRupees == null || !Number.isFinite(minRupees) || minRupees <= 0) return 'Price on request'
  if (minRupees >= 1e7) return `From ₹${(minRupees / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (minRupees >= 1e5) return `From ₹${Math.round(minRupees / 1e5)} L`
  return `From ₹${minRupees.toLocaleString('en-IN')}`
}

// "1.5 Cr", "85L", "₹1.2 Cr - ₹1.5 Cr" -> rupees, in case startingPrice ever
// arrives as a formatted string instead of a number.
function parsePriceString(raw = '') {
  const s = String(raw)
  const range = s.match(/(\d+\.?\d*)\s*Cr.*?(\d+\.?\d*)\s*Cr/i)
  if (range) return Math.round(parseFloat(range[1]) * 1e7)
  const cr = s.match(/(\d+\.?\d*)\s*Cr/i)
  if (cr) return Math.round(parseFloat(cr[1]) * 1e7)
  const l = s.match(/(\d+\.?\d*)\s*L\b/i)
  if (l) return Math.round(parseFloat(l[1]) * 1e5)
  const n = Number(s.replace(/[^\d.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizePossessionDate(raw) {
  if (!raw) return null
  const s = String(raw)
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7)
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7)
}

function formatPossessionDisplay(possessionDateNorm, projectStatus) {
  if (possessionDateNorm) {
    const [y, m] = possessionDateNorm.split('-')
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const mi = parseInt(m, 10) - 1
    if (mi >= 0 && mi < 12) return `${months[mi]} ${y}`
  }
  if (projectStatus) return String(projectStatus)
  return 'TBD'
}

// Extractive-only fallback for the ~1-in-150 project whose flatInventory
// array comes back empty from the API but whose description prose spells
// out the same numbers directly, e.g. (real text, "Chaitanya Ethics
// Orovia" — which DOES have flatInventory too, so this path isn't exercised
// for it today, but is the confirmed real shape this pattern matches):
//   "**2 BHK Deck Residences** * Carpet Area: Approx. **619–720 sq. ft.**
//    * Starting Price: **₹1.79 Cr++**"
// Only ever parses numbers already present in the text — never estimates or
// invents a value. Each match is tagged `_extracted: true` so the UI can
// label it "Extracted from description" rather than implying it's the same
// structured per-unit data flatInventory normally provides (no total/
// available counts are ever recoverable this way, so those stay null).
function extractUnitMixFromDescription(description) {
  const text = String(description || '')
  if (!text) return []
  const re = /(\d)\s*BHK[\s\S]{0,60}?Carpet\s*Area:?\s*Approx\.?\s*\**\s*([\d,]+)\s*(?:to|[-–])\s*([\d,]+)\s*sq\.?\s*ft\.?\**[\s\S]{0,120}?Starting\s*Price:?\s*\**\s*₹\s*([\d.]+)\s*(Cr|Crore|L|Lakh)\b/gi
  const out = []
  let m
  while ((m = re.exec(text)) !== null) {
    const carpetMin = parseInt(m[2].replace(/,/g, ''), 10)
    const carpetMax = parseInt(m[3].replace(/,/g, ''), 10)
    const priceVal = parseFloat(m[4])
    const isCr = /^cr/i.test(m[5])
    const priceRupees = Number.isFinite(priceVal) ? Math.round(priceVal * (isCr ? 1e7 : 1e5)) : null
    if (!Number.isFinite(carpetMin) && !Number.isFinite(carpetMax) && priceRupees == null) continue
    out.push({
      type: `${m[1]} BHK`,
      carpet: Number.isFinite(carpetMin) ? (carpetMin === carpetMax ? `${carpetMin} sq ft` : `${carpetMin} - ${carpetMax} sq ft`) : null,
      total: null, available: null,
      priceDisplay: formatPrice(priceRupees),
      _extracted: true,
    })
  }
  return out
}

function normalizeConfig(raw) {
  // Confirmed shape from a live API response: raw.flatConfiguration is a
  // clean top-level string array (e.g. ["2BHK","3BHK","Jodi"], no space
  // before "BHK") — separate from flatInventory (which carries carpet/price
  // per unit type, not always a clean config label). Preferred when present;
  // flatInventory is only the fallback for a response shape that omits it.
  const fromTopLevel = toArray(raw?.flatConfiguration)
    .map(c => clean(String(c)).replace(/^(\d)\s*BHK$/i, '$1 BHK').replace(/^(\d)BHK$/i, '$1 BHK'))
    .filter(Boolean)
  if (fromTopLevel.length) return [...new Set(fromTopLevel)].join(' & ')

  const types = []
  for (const item of toArray(raw?.flatInventory)) {
    let t = clean(item?.flatType || item?.type || item?.unitType || item?.configuration || '')
    if (!t) continue
    t = t.replace(/^(\d)\s*BHK$/i, '$1 BHK').replace(/^(\d)BHK$/i, '$1 BHK')
    if (!types.includes(t)) types.push(t)
  }
  return types.join(' & ')
}

function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim() }

// Description-only variant: the live API's `description` field arrives as
// REAL markdown — "# Heading\n\nParagraph\n\n### Subheading\n\n* bullet\n*
// bullet" (confirmed directly against a live fetchProjectByName response).
// clean() above is correct for single-line fields (name/location/etc.) but
// WRONG here — `\s+` matches newlines too, so it was flattening a perfectly
// structured multi-paragraph description into one line, which is what made
// the frontend render it as a single giant bold/heading block (the frontend
// then tried to reconstruct structure with regex heuristics against already-
// destroyed text, which is inherently lossy — fixing it at the source
// instead). Only collapses horizontal whitespace and 3+ blank lines; real
// paragraph/heading/bullet line breaks are preserved.
function cleanDescription(s = '') {
  return String(s)
    .replace(/\r\n/g, '\n')
    .split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Title-cases a fallback city derived from location.value (which arrives
// lowercase, e.g. "goregaon west") — display polish only, never applied to
// a real raw.city value if the API provides one.
function titleCase(s = '') { return String(s).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()) }

const RANK_COLORS = { Primary: '#2E9E4F', Secondary: '#F7941D', Tertiary: '#8B8BD6', 'Low Match': '#9CA3AF' }

// Raw IndiHomes project -> stable internal shape. Superset of the shape the
// existing frontend (ProjectCard etc.) already reads, plus Dubai-ready fields
// (market/country/currency/community/possessionDate/verificationId) so a
// future non-India market never needs a reshape, only new normalizer logic.
function normalizeProject(raw = {}, { market = 'india' } = {}) {
  const location = normalizeLocation(raw.location)
  const media = normalizeMediaList(raw.media_urls)
  const youtubeUrls = normalizeMediaList(raw.youtube_urls)
  const possessionDate = normalizePossessionDate(raw.possessionStartDate)
  // Confirmed against a live response: f.carpetSize on a flatInventory ITEM
  // is a plain NUMBER (that unit variant's carpet area), not the {min,max}
  // object formatCarpetSize() handles — that object shape only appears at
  // raw.carpetSize (project-wide). castCarpet() first (the correct, common
  // case); formatCarpetSize()/legacy field names stay as a fallback for any
  // response shape that differs.
  const rawFlatInventory = toArray(raw.flatInventory)
  let flatInventory = rawFlatInventory.map(f => {
    const scalarCarpet = castCarpet(f?.carpetSize)
    return {
      type: clean(f?.flatType || f?.type || f?.unitType || ''),
      carpet: scalarCarpet != null ? `${scalarCarpet} sq ft`
        : formatCarpetSize(f?.carpetSize)
        || (castCarpet(f?.carpetArea ?? f?.carpet_area ?? f?.carpet) != null ? `${castCarpet(f?.carpetArea ?? f?.carpet_area ?? f?.carpet)} sq ft` : null),
      total: f?.totalUnits ?? f?.total_units ?? null,
      available: f?.availableUnits ?? f?.available_units ?? null,
      // flatInventory[].price is sometimes 0 per the documented data rules —
      // formatPrice() already returns null for a non-positive number, so a
      // real 0 correctly falls through to "—" rather than showing "₹0".
      priceDisplay: formatPrice(f?.price),
    }
  })
  // Extractive fallback — only when the API gave us nothing structured at
  // all AND the description prose happens to spell the same numbers out.
  if (!flatInventory.length) {
    flatInventory = extractUnitMixFromDescription(raw.description || raw.projectDescription || '')
  }

  let startingPriceRupees = null
  // Confirmed shape from a live API response: startingPrice is an OBJECT,
  // { value: 218, unit: "Lakh" } — not a number or a formatted string. This
  // is the actual reason every project showed "Price on request": neither
  // the `typeof === 'number'` branch nor parsePriceString (which stringifies
  // an object to "[object Object]" and matches nothing) ever handled it.
  const sp = raw.startingPrice
  if (sp && typeof sp === 'object' && sp.value != null) {
    const unit = String(sp.unit || '').toLowerCase()
    const n = Number(sp.value)
    if (Number.isFinite(n) && n > 0) {
      startingPriceRupees = unit.startsWith('cr') ? Math.round(n * 1e7) : Math.round(n * 1e5) // default/only other observed unit: "Lakh"
    }
  } else if (typeof sp === 'number') {
    startingPriceRupees = sp > 0 ? sp : null
  } else if (sp) {
    startingPriceRupees = parsePriceString(sp)
  }

  const budgetMin = startingPriceRupees != null ? Math.round(startingPriceRupees / 1e5) : null // Lakhs, matches existing UI convention
  const code = raw.projectName || null
  const id = raw.id ?? code ?? null
  const name = clean(raw.displayName || raw.projectName || 'Unknown Project')

  const project = {
    id, code, name,
    builder: clean(raw.developerName || 'IndiHomes Developer'),
    developerName: raw.developerName || null,
    city: raw.city || (location.value ? titleCase(location.value) : null),
    location: location.label,
    nearbyLocality: raw.nearbyLocality || null,
    config: normalizeConfig(raw),
    budgetMin, budgetMax: budgetMin, // IndiHomes exposes a starting price, not a range
    budgetLabel: formatBudgetLabel(startingPriceRupees),
    possessionStartDate: raw.possessionStartDate || null,
    possessionDate,
    possession: formatPossessionDisplay(possessionDate, raw.projectStatus),
    projectStatus: raw.projectStatus || null,
    reraCode: raw.reraNo || null,
    rera: !!raw.reraNo,
    brochureUrl: raw.brochure_url || null,
    floorUrls: normalizeMediaList(raw.floor_urls),
    media, youtubeUrls,
    flatInventory,
    listingUrl: raw.listingUrl || raw.url || null,
    // No raw latitude/longitude field exists anywhere in this API's schema
    // (confirmed against a live fetchProjectByName — full key list has no
    // lat/lng/geo/coordinates field of any kind). googleMapLink is the
    // closest thing: an official Google Maps link for the project, more
    // reliable than a text-search fallback when present, but a short.ly-
    // style URL (maps.app.goo.gl/...) that doesn't itself carry parseable
    // coordinates without a redirect-following HTTP call — not resolved
    // here, just passed through for the frontend to link to directly.
    googleMapLink: raw.googleMapLink || null,
    amenities: toArray(raw.amenities).map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean),
    description: cleanDescription(raw.description || raw.projectDescription || ''),
    // Market-readiness fields — India-only values today, shaped so a future
    // Dubai official feed slots in without touching this normalizer's callers.
    market, country: market === 'dubai' ? 'UAE' : 'India',
    currency: market === 'dubai' ? 'AED' : 'INR',
    community: raw.community || null,
    verificationId: raw.reraNo || null,
    sources: ['indihomes-website'],
    adSrc: 'indihomes-website',
    sourceLabel: 'IndiHomes Website',
  }
  return project
}

function attachScore(project, filters) {
  const { score, label, reasons } = scoring.scoreIndiHomesProject(project, filters || {})
  return {
    ...project,
    score, match: score,
    rank: label.toUpperCase(),
    rankColor: RANK_COLORS[label] || '#8B8BD6',
    matchReasons: reasons,
  }
}

// ── Public list/detail fetchers ─────────────────────────────────────────────
// CONTRACT (per Indihomes_API_Integration_Brief.docx — confirmed against a
// live call): fetchPaginatedFilteredProjectList takes budgetMin/budgetMax in
// RAW RUPEES, not Lakhs — the API divides by 100000 server-side, so passing a
// Lakhs value (e.g. 75 meaning ₹75L) is silently read as ₹75 and returns
// nothing/wrong results. flatType must be the no-space form ("2BHK"), not the
// "2 BHK" convention used everywhere else in this app's internal shapes
// (project.config, the frontend's Configuration filter, scoring.cjs). This
// function does NOT convert either value — callers are responsible for
// passing rupees + no-space BHK strings already. Currently nothing calls this
// live-query path from the frontend (Filter Search always calls GET
// /api/projects with no query params, which serves the client-side-filtered
// bulk cache instead — see server.cjs's `hasLiveParams` gate), so this isn't
// an active bug. If a future Filter Search UI is wired to call GET
// /api/projects?area=&flatType=&budgetMin=&budgetMax=... directly (server.cjs
// forwards those query params straight into this function unconverted),
// whoever wires it up MUST convert Lakhs->rupees (`* 1e5`) and "2 BHK"->
// "2BHK" (strip the space) at the call site before it reaches here.
function buildListParams({ area, flatType, budgetMin, budgetMax, possessionDate, limit, page, sortBy } = {}) {
  const params = {}
  if (area) params.area = area
  if (flatType) params.flatType = flatType
  if (budgetMin != null) params.budgetMin = budgetMin
  if (budgetMax != null) params.budgetMax = budgetMax
  if (possessionDate) params.possessionDate = possessionDate
  params.limit = limit || 50
  params.page = page || 1
  if (sortBy) params.sortBy = sortBy
  return params
}

async function fetchProjects(rawParams = {}) {
  if (!isEnabled()) throw new Error('IndiHomes Projects API is disabled (INDIHOMES_PROJECTS_ENABLED=false)')
  const params = buildListParams(rawParams)
  const key = `list:${JSON.stringify(params)}`
  const result = await cachedCall(key, async () => {
    const body = await apiGet('/fetchPaginatedFilteredProjectList', params)
    if (body?.success === false) throw new Error(body?.message || 'IndiHomes API request failed')
    return {
      success: true,
      totalItems: body?.totalItems ?? (body?.projects || []).length,
      currentPage: body?.currentPage ?? params.page,
      totalPages: body?.totalPages ?? 1,
      rawProjects: body?.projects || [],
    }
  })
  const filters = scoring.filtersFromParams(rawParams)
  const projects = (result.rawProjects || []).map(raw => attachScore(
    { ...normalizeProject(raw, { market: 'india' }), fromCache: result.fromCache, stale: result.stale },
    filters,
  ))
  return {
    success: true, market: 'india',
    totalItems: result.totalItems, currentPage: result.currentPage, totalPages: result.totalPages,
    projects, fromCache: !!result.fromCache, stale: !!result.stale,
  }
}

// Catalog crawl for the background refresh loop that feeds cache.projects —
// a few pages at a generous page size, not the full remote inventory; this
// mirrors "preserve current UI behavior" (small dataset, all client-filtered)
// rather than forcing Filter Search onto true server pagination today.
async function fetchCatalog({ limit = 100, maxPages = 3, sortBy = 'date' } = {}) {
  const first = await fetchProjects({ limit, page: 1, sortBy })
  let all = first.projects
  const pages = Math.min(first.totalPages || 1, maxPages)
  for (let p = 2; p <= pages; p++) {
    try {
      const next = await fetchProjects({ limit, page: p, sortBy })
      all = all.concat(next.projects)
    } catch (e) { console.warn(`[indihomes-client] catalog page ${p} failed:`, e.message); break }
  }
  return { ...first, projects: all, totalItems: first.totalItems ?? all.length }
}

async function fetchProjectById(id) {
  if (!isEnabled()) throw new Error('IndiHomes Projects API is disabled (INDIHOMES_PROJECTS_ENABLED=false)')
  const key = `id:${id}`
  const result = await cachedCall(key, async () => {
    const body = await apiGet('/fetchProject', { id })
    const raw = body?.project || body?.data || (body?.success === false ? null : body)
    if (!raw) throw new Error(body?.message || 'Project not found')
    return { raw }
  })
  return attachScore({ ...normalizeProject(result.raw, { market: 'india' }), fromCache: result.fromCache, stale: result.stale }, {})
}

async function fetchProjectByName(projectName) {
  if (!isEnabled()) throw new Error('IndiHomes Projects API is disabled (INDIHOMES_PROJECTS_ENABLED=false)')
  const key = `name:${projectName}`
  const result = await cachedCall(key, async () => {
    const body = await apiGet('/fetchProjectByName', { projectName })
    const raw = body?.project || body?.data || (body?.success === false ? null : body)
    if (!raw) throw new Error(body?.message || 'Project not found')
    return { raw }
  })
  return attachScore({ ...normalizeProject(result.raw, { market: 'india' }), fromCache: result.fromCache, stale: result.stale }, {})
}

module.exports = {
  isEnabled, getConfig,
  fetchProjects, fetchCatalog, fetchProjectById, fetchProjectByName,
  normalizeProject, attachScore,
}
