'use strict'

try { require('dotenv').config() } catch(_) {}

const express = require('express')
const cors    = require('cors')
const path    = require('path')

let chromium
try { chromium = require('playwright').chromium } catch(e) {
  console.error('[server] Playwright not found:', e.message)
}

let scoreProjects
try { scoreProjects = require(path.resolve(__dirname, '..', '..', 'indihomes', 'scorer.js')) } catch(_) {}

const db = require('./db.cjs')
const llm = require('./llm.cjs')
const azureSearch = require('./azure-search.cjs')
const leadIntake = require('./lead-intake.cjs')
const housingClient = require('./housing-client.cjs')
const metaClient = require('./meta-client.cjs')
const indihomesClient = require('./indihomes-client.cjs')
const indihomesLeadsClient = require('./indihomes-leads-client.cjs')
const metaCapi = require('./meta-capi.cjs')
const externalSearch = require('./external-search.cjs')
const queryParser = require('./query-parser.cjs')
const scoring = require('./scoring.cjs')
const agentToolsBridge = require('./agent-tools-bridge.cjs')
const redisCache = require('./redis-cache.cjs')
const leadEvents = require('./lead-events.cjs')
const qualification = require('./qualification.cjs')

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = { projects:[], lastRun:null, nextRun:null, status:'idle', step:'Waiting...', totalFound:0, sources:[], errors:[] }

// Ring buffer of recent Python scraper stderr lines — lets us debug what's
// happening on a deployed host without relying on the hosting provider's log UI/CLI.
const scraperLog = []
function logScraper(line) {
  scraperLog.push(`[${new Date().toISOString()}] ${line}`)
  if (scraperLog.length > 300) scraperLog.shift()
}

// Count how many projects in a list carry a real RERA — used to judge snapshot
// quality so a degraded scrape can't permanently replace a good baseline.
function reraCount(projects = []) {
  return projects.filter(p => p && (p.reraCode || p.rera)).length
}

// Restore the shipped baseline (seed/projects-seed.json) whenever the persisted
// snapshot is missing or degraded. This makes the deploy self-healing: on a fresh
// volume, or after a weak scrape overwrote the latest snapshot, the server boots
// back to the known-good 50-project / 38-RERA baseline instead of serving 26/1.
// Guarded so it never clobbers a genuinely richer live snapshot.
function loadSeedIfBetter(currentSnap) {
  try {
    const fs = require('fs')
    const seedPath = require('path').join(__dirname, 'seed', 'projects-seed.json')
    if (!fs.existsSync(seedPath)) return null
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'))
    const seedProjects = seed.projects || []
    if (!seedProjects.length) return null

    const cur = currentSnap?.projects || []
    // Consider the current snapshot "weak" if it has notably fewer projects or
    // far fewer RERA-verified entries than the seed baseline.
    const weak = cur.length < seedProjects.length * 0.6 || reraCount(cur) < reraCount(seedProjects) * 0.5
    if (cur.length && !weak) return null

    // Restore discovered RERA first so background enrichment doesn't redo it.
    for (const r of (seed.discoveredRera || [])) {
      try { db.saveDiscoveredRera(r.listingUrl, r) } catch(_) {}
    }
    db.saveProjectsSnapshot(seedProjects)
    console.log(`[db] Restored baseline seed: ${seedProjects.length} projects / ${reraCount(seedProjects)} RERA (previous snapshot: ${cur.length} projects / ${reraCount(cur)} RERA)`)
    return { projects: seedProjects, savedAt: Date.now() }
  } catch(e) {
    console.error('[db] Seed restore failed:', e.message)
    return null
  }
}

// Restore the bundled Project Intelligence cache from the seed. Intel is
// additive and keyed by project, so we restore any seeded intel the DB doesn't
// already have — this lets the hosted app (whose IP is WAF-blocked from live
// per-project scraping) still serve rich Project Intelligence for the projects
// that were scraped locally and published.
function loadSeedIntel() {
  try {
    const fs = require('fs')
    const seedPath = require('path').join(__dirname, 'seed', 'projects-seed.json')
    if (!fs.existsSync(seedPath)) return
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'))
    const intel = seed.intel || []
    if (!intel.length) return
    // Overwrite from the seed unconditionally — the published seed is the source
    // of truth for a host that can't scrape per-project intel itself. (A plain
    // "fill only what's missing" restore would leave earlier bad entries — e.g.
    // a wrong-project match published before validation existed — stuck forever.)
    let restored = 0
    for (const row of intel) {
      try {
        db.putIntel(row.cacheKey, { name: row.name, builder: row.builder, city: row.city }, row.data)
        restored++
      } catch(_) {}
    }
    if (restored) console.log(`[db] Restored ${restored} Project Intelligence entries from seed`)
  } catch(e) { console.error('[db] Seed intel restore failed:', e.message) }
}

// Seed from last SQLite snapshot so the UI has data immediately on restart,
// instead of waiting for the first live IndiHomes API call to complete.
// Only reuse the snapshot if it's IndiHomes-sourced — a pre-migration
// snapshot full of 99acres/MagicBricks/Google-Ads projects must never
// transiently appear in Filter Search again, not even for one boot cycle.
try {
  loadSeedIntel() // Project Intelligence cache restore — unrelated to Filter Search's source, unaffected by this change
  const snap = db.getLatestProjectsSnapshot()
  const isIndiHomesSourced = snap?.projects?.length && snap.projects.every(p => (p.sources || []).includes('indihomes-website'))
  if (isIndiHomesSourced) {
    cache.projects   = snap.projects
    cache.totalFound = snap.projects.length
    cache.lastRun    = new Date(snap.savedAt).toISOString()
    cache.status     = 'done'
    cache.step       = `Loaded ${snap.projects.length} IndiHomes projects from DB snapshot`
    console.log(`[db] Seeded ${snap.projects.length} IndiHomes projects from SQLite snapshot (saved ${cache.lastRun})`)
  } else if (snap?.projects?.length) {
    console.log(`[db] Ignoring pre-migration snapshot (${snap.projects.length} non-IndiHomes projects) — waiting for a live IndiHomes API fetch instead`)
  }
} catch(e) { console.error('[db] Snapshot seed failed:', e.message) }

// ── IndiHomes official catalog refresh (Filter Search's sole data source) ───
async function refreshIndiHomesCatalog() {
  if (!indihomesClient.isEnabled()) {
    cache.status = 'done'
    cache.step = 'IndiHomes Projects API disabled (INDIHOMES_PROJECTS_ENABLED=false)'
    return
  }
  cache.status = 'running'
  cache.step = 'Fetching official IndiHomes catalog...'
  try {
    const result = await indihomesClient.fetchCatalog({ limit: 100, maxPages: 3, sortBy: 'date' })
    cache.projects   = result.projects
    cache.totalFound = result.projects.length
    cache.sources    = ['IndiHomes Website']
    cache.lastRun    = new Date().toISOString()
    cache.nextRun    = new Date(Date.now() + indihomesClient.getConfig().ttlMs).toISOString()
    cache.status     = 'done'
    cache.step       = result.stale
      ? `Serving last-known IndiHomes catalog (${result.projects.length} projects) — live API unreachable`
      : `Done - ${result.projects.length} official IndiHomes projects`
    cache.errors = result.stale ? [{ source: 'indihomes-api', error: 'live fetch failed, served cached data' }] : []
    console.log(`[server] ${cache.step}`)
    if (result.projects.length) {
      try { db.saveProjectsSnapshot(result.projects) } catch (e) { console.error('[db] snapshot save failed:', e.message) }
    }
    syncAzureSearch()
  } catch (e) {
    cache.status = 'error'
    cache.step = `IndiHomes catalog fetch failed: ${e.message}`
    cache.errors = [{ source: 'indihomes-api', error: e.message }]
    cache.nextRun = new Date(Date.now() + 60000).toISOString()
    console.error('[server] IndiHomes catalog refresh failed:', e.message)
  }
}

// One-time, log-only summary of which integrations are active and why —
// never throws, so a missing key degrades a feature, not the whole server.
function validateEnv() {
  const lines = []
  lines.push(`IndiHomes Projects API: ${indihomesClient.isEnabled() ? `enabled (${indihomesClient.getConfig().baseUrl})` : 'DISABLED (INDIHOMES_PROJECTS_ENABLED=false)'}`)
  lines.push(`Azure AI Search: ${azureSearch.isConfigured() ? 'configured' : 'not configured (AZURE_SEARCH_ENDPOINT/AZURE_SEARCH_ADMIN_KEY missing)'}`)
  const extStatus = externalSearch.getStatus()
  const activeConnectors = extStatus.connectors.filter(c => c.configured).map(c => c.name)
  lines.push(`External Search (AI Search): ${extStatus.enabled ? 'enabled' : 'disabled (EXTERNAL_SEARCH_ENABLED=false)'}${activeConnectors.length ? `, connectors: ${activeConnectors.join(', ')}` : ', no connectors configured'}`)
  lines.push(`AI Search result cache (Redis): ${redisCache.isConfigured() ? 'configured' : 'not configured (REDIS_URL missing, or ioredis not installed — run npm install)'}`)
  lines.push(`LLM provider (Project Intelligence enrichment): ${llm.isConfigured() ? llm.providerName() : 'none configured'}`)
  // Key present != actually callable — confirmed live 2026-08-18: this
  // deployment's key returns HTTP 403 API_KEY_SERVICE_BLOCKED from Places
  // API (New) (google.maps.places.v1.Places.SearchText), which is a
  // Google Cloud Console "API restrictions" allowlist setting on the key
  // itself — NOT missing billing, NOT the API being disabled project-
  // wide, and NOT a request-format bug (reproduced the identical error
  // with an out-of-band request using the exact same body/headers this
  // code sends). Fix: Cloud Console -> Credentials -> this key -> "API
  // restrictions" -> add "Places API (New)" to the allowed list. This
  // line only reports whether a key STRING is present, not whether Google
  // will actually accept calls from it — see /api/competing-projects's
  // own error handling for the live, specific reason on each request.
  lines.push(`Competitor Analysis (Google Places): ${(process.env.GOOGLE_PLACES_API_KEY || process.env.VITE_GOOGLE_MAPS_KEY) ? 'configured (key present — NOT verified callable; last live probe returned 403 API_KEY_SERVICE_BLOCKED, a Cloud Console key-restriction setting)' : 'not configured (GOOGLE_PLACES_API_KEY missing)'}`)
  lines.push(`Location geocoding fallback (Google Geocoding): ${(process.env.GOOGLE_PLACES_API_KEY || process.env.VITE_GOOGLE_MAPS_KEY) ? 'configured (key present — same API-restriction caveat as Competitor Analysis above; both use the same key)' : 'not configured'}`)
  lines.push(`Housing.com leads: ${housingClient.isConfigured() ? 'configured' : 'not configured (HOUSING_API_KEY/HOUSING_USER_ID missing)'}`)
  lines.push(`Meta leads: ${metaClient.isConfigured() ? 'configured' : 'not configured (META_PAGE_ACCESS_TOKEN missing)'}`)
  lines.push(`Meta Conversions API: ${metaCapi.isConfigured() ? 'configured' : 'not configured (META_CAPI_ACCESS_TOKEN/META_DATASET_ID missing)'}`)
  console.log('\n[startup] Integration status:\n  ' + lines.join('\n  ') + '\n')
}
validateEnv()

// Project intelligence cache (keyed by "name::builder") — in-memory layer over SQLite
const intelCache = {}
const INTEL_TTL  = 24 * 60 * 60 * 1000 // 24 h (Apify runs cost money)

// Push the current cache into Azure AI Search whenever it changes — no-op
// until AZURE_SEARCH_ENDPOINT/AZURE_SEARCH_ADMIN_KEY are set. Fire-and-forget:
// a slow or failing Azure sync must never block serving /api/projects.
function syncAzureSearch() {
  if (!azureSearch.isConfigured()) return
  azureSearch.syncListings(cache.projects).catch(e => console.error('[azure-search] sync failed:', e.message))
}
if (azureSearch.isConfigured()) {
  azureSearch.ensureIndexes()
    .then(() => syncAzureSearch())
    .catch(e => console.error('[azure-search] index setup failed:', e.message))
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function clean(s='') { return String(s).replace(/\s+/g,' ').trim() }

function parsePrice(raw='') {
  const crR = raw.match(/[₹₹]?\s*(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*Cr/i)
  if (crR) return { min:Math.round(parseFloat(crR[1])*1e7), max:Math.round(parseFloat(crR[2])*1e7), display:`Rs.${crR[1]} Cr - Rs.${crR[2]} Cr` }
  const lR = raw.match(/[₹₹]?\s*(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*L/i)
  if (lR) return { min:Math.round(parseFloat(lR[1])*1e5), max:Math.round(parseFloat(lR[2])*1e5), display:`Rs.${lR[1]}L - Rs.${lR[2]}L` }
  const sCr = raw.match(/(?:from|at|starting|Rs\.?|[₹₹])\s*(\d+\.?\d*)\s*Cr/i)
  if (sCr) { const v=Math.round(parseFloat(sCr[1])*1e7); return { min:v, max:null, display:`From Rs.${sCr[1]} Cr` } }
  const sL = raw.match(/(?:from|at|starting|Rs\.?|[₹₹])\s*(\d+\.?\d*)\s*L/i)
  if (sL) { const v=Math.round(parseFloat(sL[1])*1e5); return { min:v, max:null, display:`From Rs.${sL[1]}L` } }
  return { min:null, max:null, display:null }
}

function parseBHK(raw='') {
  const types=[]
  const s = String(raw)
  // Handle "2 & 3 BHK" or "2, 3 & 4 BHK" — multiple numbers sharing one BHK suffix
  const shared = s.match(/(\d+(?:\s*[&,]\s*\d+)+)\s*BHK/gi)
  if (shared) {
    for (const chunk of shared) {
      for (const n of (chunk.match(/\d+/g)||[])) {
        const l=`${n} BHK`; if(!types.includes(l)) types.push(l)
      }
    }
  }
  // Individual "2 BHK", "3 BHK"
  for (const m of (s.match(/\d+\s*BHK/gi)||[])) {
    const l=`${m.match(/\d+/)[0]} BHK`; if(!types.includes(l)) types.push(l)
  }
  if (!types.length && /studio/i.test(s)) types.push('Studio')
  return types
}

function parsePossession(raw='') {
  const m=String(raw).match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{4})/i)
  if (m) return `${m[1].slice(0,3)} ${m[2]}`
  const y=String(raw).match(/20\d\d/); if(y) return y[0]
  if (/ready|immediate|now/i.test(raw)) return 'Ready to Move'
  return raw.trim()||null
}

// Used by the (still-active, Project-Intelligence-adjacent) local Python list
// scrapers below to backfill a developer name from a project's title when the
// scrape itself didn't capture one. Also duplicated in legacy-scrapers.cjs
// for the disconnected discovery pipeline — the two copies are independent
// on purpose, not meant to be kept in sync.
const KNOWN_DEVS = [
  'Lodha','Godrej','Prestige','Mahindra','Shapoorji','Piramal','Tata',
  'Oberoi','Hiranandani','Runwal','Kalpataru','Rustomjee','Wadhwa',
  'Raymond','Ajmera','Raheja','Kolte Patil','VTP Realty','Mantra',
  'Kohinoor','Marvel','Paranjape','Nyati','Adani Realty','Birla Estates',
  'Brigade','Sobha','L&T Realty','Rohan','Sunteck','Ruparel','Dosti',
  'DB Realty','Kumar','Naiknavare','Provident','Macrotech','Puravankara',
]

// ── LEGACY DISCOVERY SCRAPERS (disconnected) ─────────────────────────────────
// Filter Search now sources exclusively from the official IndiHomes API (see
// indihomes-client.cjs / refreshIndiHomesCatalog below). The old MahaRERA/
// 99acres/MagicBricks/Google-Ads discovery pipeline conflicts with that rule
// and is no longer wired into the boot loop or refresh interval. Kept in
// legacy-scrapers.cjs — required but never called — rather than deleted.
const legacyScrapers = require('./legacy-scrapers.cjs')({
  cache, db, chromium, scoreProjects, syncAzureSearch, enrichProjectsWithRera,
})
const { runScrapers } = legacyScrapers

// ── PROJECT INTELLIGENCE SCRAPER ──────────────────────────────────────────────

const INTEL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const https = require('https')
const http  = require('http')
const zlib  = require('zlib')

/**
 * Lightweight direct HTTP fetch — avoids Playwright bot detection.
 * Returns the raw HTML string of the page.
 */
function fetchHTML(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib    = parsed.protocol === 'https:' ? https : http
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent':      INTEL_UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'keep-alive',
        'Cache-Control':   'no-cache',
        'Referer':         `https://${parsed.hostname}/`,
      },
    }, (res) => {
      // Follow redirects (up to 3 hops)
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, url).toString()
          fetchHTML(next, timeoutMs).then(resolve).catch(reject)
        } catch(e) { reject(e) }
        res.resume()
        return
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase()
      let stream = res
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip())
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress())
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('HTTP timeout')) })
    req.on('error', reject)
  })
}

/**
 * Extract __NEXT_DATA__ JSON from raw HTML string.
 */
function extractNextData(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch(_) { return null }
}

/**
 * Search 99acres for a project by name+city and return the best matching project page URL.
 * Uses direct HTTP (no browser) — reliable.
 */
async function search99AcresDirect(name, builder, city) {
  const cityMap = { 'Mumbai':1, 'Thane':12, 'Pune':11, 'Navi Mumbai':36, 'Bengaluru':4, 'Bangalore':4 }
  const cityId  = cityMap[city] || 12
  const q       = encodeURIComponent(`${name} ${builder}`.trim())
  // 99acres autocomplete API — returns JSON with project suggestions
  const url = `https://www.99acres.com/api/v1/typeahead?q=${q}&city=${cityId}&intent=buy&type=PROJECT`
  try {
    const html = await fetchHTML(url, 10000)
    const data = JSON.parse(html)
    const suggs = data?.data?.suggestions || data?.suggestions || data?.result || []
    for (const s of suggs) {
      const projectUrl = s.url || s.detail_url || s.project_url || ''
      if (projectUrl && projectUrl.includes('99acres')) return projectUrl
      if (s.id || s.project_id) {
        return `https://www.99acres.com/${(s.slug||'project').replace(/^\/+/,'')}`
      }
    }
  } catch(e) {
    console.log('[intel] 99acres autocomplete failed:', e.message)
  }
  // Fallback: try a Google search result scrape (plain HTML)
  try {
    const q2   = encodeURIComponent(`"${name}" ${builder} ${city} site:99acres.com`)
    const html = await fetchHTML(`https://www.google.com/search?q=${q2}&num=3`, 10000)
    const links = [...html.matchAll(/href="(https:\/\/www\.99acres\.com\/[^"&?]+(?:project|pvid|rpid)[^"&?]*)"/g)]
    if (links.length) return links[0][1]
  } catch(e) {}
  return null
}

/**
 * Fetch and parse a 99acres project detail page via direct HTTP (NOT Playwright).
 * Returns the same shape as scrape99AcresProjectPage.
 */
async function fetch99AcresPage(url) {
  const html = await fetchHTML(url)
  const nd   = extractNextData(html)
  if (!nd) return null

  const pp = nd?.props?.pageProps
  const pd = pp?.projectData || pp?.data?.projectData || pp?.project || pp?.projectDetail || null
  if (!pd) return null

  const rawConfigs = pd.unit_type_config || pd.unitTypeConfig || pd.configurations || pd.bhk_config || []
  const configs = rawConfigs.map(c => ({
    type:      clean(c.unit_type || c.bhk || c.type || c.name || ''),
    carpet:    clean(String(c.carpet_area || c.carpetArea || c.size || '')),
    total:     c.total_units || c.totalUnits || c.total || null,
    available: c.available_units || c.availableUnits || c.available || null,
    price:     clean(c.price_range || c.priceRange || c.price || ''),
  })).filter(c => c.type)

  const amenList   = pd.amenities || pd.features || []
  const amenities  = amenList.map(a => clean(a.name || a.amenity_name || String(a))).filter(Boolean)
  const nearbyRaw  = pd.nearby_facilities || pd.nearbyFacilities || pd.nearby || []
  const infra      = nearbyRaw.slice(0,8).map(f => ({
    type: clean(f.facility_type || f.type || f.category || ''),
    name: clean(f.name || f.facility_name || ''),
    dist: clean(f.distance || f.dist || ''),
    icon: infraIcon(f.facility_type || f.type || f.category || ''),
  })).filter(f => f.name)

  return {
    description: clean(pd.project_description || pd.description || pd.about || ''),
    configs, amenities,
    rera:        clean(pd.rera_number || pd.reraNumber || pd.rera || ''),
    reraValidity:clean(pd.rera_valid_till || pd.reraValidTill || ''),
    possession:  parsePossession(clean(pd.possession_date || pd.possessionDate || pd.possession || '')),
    sold:        pd.sold_percentage || pd.soldPercentage || pd.percent_sold || null,
    units:       pd.total_units || pd.totalUnits || null,
    priceRange:  clean(pd.price_range || pd.priceRange || pd.min_price || ''),
    infra,
    _source: '99acres',
  }
}

/**
 * Fetch and parse a Housing.com project page via direct HTTP.
 */
async function fetchHousingPage(url) {
  const html = await fetchHTML(url)
  const nd   = extractNextData(html)
  if (!nd) return null

  const pp = nd?.props?.pageProps
  const pd = pp?.projectDetails || pp?.projectData || pp?.data?.project || null
  if (!pd) return null

  const rawConfigs = pd.configurations || pd.unitDetails || pd.bhk_configs || []
  return {
    description: clean(pd.description || pd.about || pd.project_description || ''),
    configs: rawConfigs.map(c => ({
      type:      clean(c.unit_type || c.bhk || c.type || ''),
      carpet:    clean(String(c.carpet_area || c.carpetArea || '')),
      total:     c.total_units || c.totalUnits || null,
      available: c.available_units || c.availableUnits || null,
      price:     clean(c.price_range || c.priceRange || ''),
    })).filter(c => c.type),
    amenities: (pd.amenities || pd.highlights || []).map(a => clean(a.name || String(a))).filter(Boolean),
    rera:        clean(pd.rera_number || pd.reraNumber || ''),
    reraValidity:clean(pd.rera_valid_till || pd.reraValidTill || ''),
    possession:  parsePossession(clean(pd.possession_date || pd.possessionDate || '')),
    sold:        pd.sold_percentage || pd.soldPercentage || null,
    units:       pd.total_units || pd.totalUnits || null,
    priceRange:  clean(pd.price_range || pd.priceRange || ''),
    infra:       (pd.nearby || pd.nearby_facilities || []).slice(0,6).map(f => ({
      type: clean(f.facility_type || f.type || ''),
      name: clean(f.name || ''),
      dist: clean(f.distance || ''),
      icon: infraIcon(f.facility_type || f.type || ''),
    })).filter(f => f.name),
    _source: 'housing.com',
  }
}

/**
 * Extract project info from a Google search results page (plain HTML).
 */
async function fetchGoogleSnippets(name, builder, city) {
  const q    = encodeURIComponent(`"${name}" ${builder} ${city} configurations price RERA possession`)
  const html = await fetchHTML(`https://www.google.com/search?q=${q}&num=5`, 12000)

  const reraM  = html.match(/P\d{11,14}/)
  const possM  = html.match(/(Q[1-4]\s*20\d\d|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*20\d\d)/i)
  const priceM = html.match(/(?:₹|Rs\.?)\s*(\d+\.?\d*)\s*(L|Cr)\s*[-–to]+\s*(?:₹|Rs\.?)?\s*(\d+\.?\d*)\s*(L|Cr)/i)

  // Find any 99acres / housing / magicbricks project URL in the results
  const portalLinks = [...html.matchAll(/href="(https?:\/\/(?:www\.99acres|housing|www\.magicbricks)\.com\/[^"&?]{10,})"/g)]
    .map(m => m[1]).filter(u => /project|pvid|rpid|residential/i.test(u))

  return {
    rera:        reraM?.[0] || '',
    possession:  possM?.[0] || '',
    priceRange:  priceM ? priceM[0] : '',
    amenities:   [],
    portalUrl:   portalLinks[0] || null,
    _source:     'google',
  }
}

/**
 * Scrape a 99acres project detail page.
 * Returns { description, configs[], amenities[], rera, reraValidity, possession, sold, units, priceRange, infra[] }
 */
async function scrape99AcresProjectPage(page) {
  // 1. Try __NEXT_DATA__ SSR JSON (most reliable)
  const nd = await page.evaluate(() => {
    try { return JSON.parse(document.getElementById('__NEXT_DATA__').textContent) } catch(_) { return null }
  })

  if (nd) {
    // Locate project data in 99acres SSR structure
    const pp = nd?.props?.pageProps
    const pd = pp?.projectData || pp?.data?.projectData || pp?.project || null

    if (pd) {
      // Unit configs
      const rawConfigs = pd.unit_type_config || pd.unitTypeConfig || pd.configurations || pd.bhk_config || []
      const configs = rawConfigs.map(c => ({
        type:      clean(c.unit_type || c.bhk || c.type || c.name || ''),
        carpet:    clean(String(c.carpet_area || c.carpetArea || c.size || '')),
        total:     c.total_units || c.totalUnits || c.total || null,
        available: c.available_units || c.availableUnits || c.available || null,
        price:     clean(c.price_range || c.priceRange || c.price || ''),
      })).filter(c => c.type)

      // Amenities
      const amenList = pd.amenities || pd.features || []
      const amenities = amenList.map(a => clean(a.name || a.amenity_name || String(a))).filter(Boolean)

      // Nearby infrastructure
      const nearbyRaw = pd.nearby_facilities || pd.nearbyFacilities || pd.nearby || []
      const infra = nearbyRaw.slice(0,8).map(f => ({
        type: clean(f.facility_type || f.type || f.category || ''),
        name: clean(f.name || f.facility_name || ''),
        dist: clean(f.distance || f.dist || ''),
        icon: infraIcon(f.facility_type || f.type || f.category || ''),
      })).filter(f => f.name)

      return {
        description: clean(pd.project_description || pd.description || pd.about || ''),
        configs,
        amenities,
        rera:        clean(pd.rera_number || pd.reraNumber || pd.rera || ''),
        reraValidity:clean(pd.rera_valid_till || pd.reraValidTill || ''),
        possession:  parsePossession(clean(pd.possession_date || pd.possessionDate || pd.possession || '')),
        sold:        pd.sold_percentage || pd.soldPercentage || pd.percent_sold || null,
        units:       pd.total_units || pd.totalUnits || null,
        priceRange:  clean(pd.price_range || pd.priceRange || pd.min_price || ''),
        infra,
      }
    }
  }

  // 2. DOM fallback for 99acres
  return await page.evaluate(() => {
    const t = sel => document.querySelector(sel)?.textContent?.trim() || ''
    const allT = sels => { for(const s of sels) { const r=t(s); if(r) return r } return '' }
    const configs = Array.from(document.querySelectorAll('[class*="unitType"], [class*="UnitType"], [class*="bhk-row"], [class*="configRow"]')).slice(0,6).map(el => ({
      type:      el.querySelector('[class*="type"], [class*="bhk"]')?.textContent?.trim() || '',
      carpet:    el.querySelector('[class*="carpet"], [class*="area"]')?.textContent?.trim() || '',
      total:     null, available: null,
      price:     el.querySelector('[class*="price"]')?.textContent?.trim() || '',
    })).filter(c => c.type)
    const amenities = Array.from(document.querySelectorAll('[class*="amenity"] [class*="name"], [class*="feature-name"], [class*="amenityName"]'))
      .map(a => a.textContent.trim()).filter(Boolean).slice(0,20)
    return {
      description: allT(['[class*="projectDesc"], [class*="project-description"], [class*="AboutProject"] p']),
      configs, amenities,
      rera:        allT(['[class*="reraNo"], [class*="rera-number"], [class*="reraNumber"]']),
      reraValidity:'', possession: '', sold: null, units: null, priceRange: '', infra: [],
    }
  })
}

/**
 * Scrape a MagicBricks project detail page.
 */
async function scrapeMBProjectPage(page) {
  const nd = await page.evaluate(() => {
    try { return JSON.parse(document.getElementById('__NEXT_DATA__').textContent) } catch(_) { return null }
  })
  if (nd) {
    const pd = nd?.props?.pageProps?.projectDetails || nd?.props?.pageProps?.data || null
    if (pd) {
      const rawConfigs = pd.unitDetails || pd.unit_details || pd.configurations || []
      return {
        description: clean(pd.description || pd.about || ''),
        configs: rawConfigs.map(c => ({
          type:      clean(c.unitType || c.bhk || ''),
          carpet:    clean(String(c.carpetArea || c.carpet_area || '')),
          total:     c.totalUnits || null,
          available: c.availableUnits || null,
          price:     clean(c.priceRange || c.price || ''),
        })).filter(c => c.type),
        amenities: (pd.amenities || []).map(a => clean(a.name || String(a))).filter(Boolean),
        rera:        clean(pd.reraNumber || pd.rera_number || ''),
        reraValidity:clean(pd.reraValidTill || ''),
        possession:  parsePossession(clean(pd.possessionDate || pd.possession || '')),
        sold:        pd.soldPercentage || null,
        units:       pd.totalUnits || null,
        priceRange:  clean(pd.priceRange || ''),
        infra:       [],
      }
    }
  }
  return { description:'', configs:[], amenities:[], rera:'', reraValidity:'', possession:'', sold:null, units:null, priceRange:'', infra:[] }
}

/**
 * Use Google to find the best project-detail page URL on 99acres or MagicBricks.
 * Falls back to 99acres project search if Google fails.
 */
async function findProjectPageUrl(page, name, builder, city) {
  // Try 1: Google site: search
  try {
    const q = `"${name}" ${builder || ''} ${city} site:99acres.com`
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}&num=5`, {
      waitUntil: 'domcontentloaded', timeout: 18000,
    })
    await sleep(1500)
    const url = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'))
      for (const a of links) {
        const h = a.href || ''
        // Must be a real 99acres URL, not a redirect, and contain project or rpid
        if (h.includes('99acres.com') && !h.includes('google.com') &&
            (h.includes('project') || h.includes('rpid') || h.includes('residential'))) {
          return h
        }
      }
      // Try Google redirect links
      const allLinks = Array.from(document.querySelectorAll('a[href^="/url?"]'))
      for (const a of allLinks) {
        const params = new URLSearchParams(a.href.split('?')[1])
        const dest = params.get('q') || ''
        if (dest.includes('99acres.com')) return dest
      }
      return null
    })
    if (url) { console.log('[intel] Google found URL:', url); return url }
  } catch(e) {
    console.log('[intel] Google search failed:', e.message)
  }

  // Try 2: 99acres internal search
  try {
    const slug = encodeURIComponent(name.toLowerCase().replace(/\s+/g,'-'))
    const searchUrl = `https://www.99acres.com/search/project?search_intent=buy&src=DESKTOP_MODULE&project_name=${encodeURIComponent(name)}&city=${encodeURIComponent(city)}`
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 18000 })
    await sleep(2000)
    const url2 = await page.evaluate(() => {
      const a = document.querySelector('a[href*="99acres.com"][href*="project"], a[href*="/project/"]')
      return a?.href || null
    })
    if (url2) { console.log('[intel] 99acres search found URL:', url2); return url2 }
  } catch(e) {
    console.log('[intel] 99acres search failed:', e.message)
  }

  return null
}

/**
 * Scrape top competing projects from 99acres search.
 */
async function scrapeCompetitors(page, city, configs, excludeName) {
  const citySlug = { 'Mumbai':'mumbai', 'Thane':'thane', 'Pune':'pune', 'Navi Mumbai':'navi-mumbai' }[city] || 'thane'
  // Use the new-projects search page (works better than BHK-specific pages)
  const url = `https://www.99acres.com/new-residential-projects-in-${citySlug}-ffid`
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await sleep(2500)
    const raw = await page.evaluate(() => {
      const selectors = [
        '[data-testid="srp-listing-card"]', '.projectCard', '.tupleNew',
        '[class*="ProjectCard"]', '[class*="project-card"]', '[class*="srpProjectCard"]',
      ]
      let cards = []
      for (const sel of selectors) {
        cards = document.querySelectorAll(sel)
        if (cards.length > 0) break
      }
      return Array.from(cards).slice(0, 8).map(card => {
        const t = (...sels) => { for(const s of sels) { const el=card.querySelector(s); if(el?.textContent?.trim()) return el.textContent.trim() } return '' }
        return {
          name:    t('[class*="projectName"]','[class*="propName"]','[class*="ProjectName"]','h2','h3'),
          builder: t('[class*="builderName"]','[class*="developer"]','[class*="Builder"]'),
          price:   t('[class*="priceRange"]','[class*="price"]','[class*="Price"]'),
          url:     card.querySelector('a')?.href || '',
        }
      }).filter(c => c.name && c.name.length > 3)
    })
    return raw
      .filter(c => c.name.toLowerCase().replace(/\s+/g,'') !== excludeName.toLowerCase().replace(/\s+/g,''))
      .slice(0, 4)
      .map(c => ({
        name:    clean(c.name),
        builder: clean(c.builder || ''),
        price:   clean(c.price || 'Price on request'),
        sold:    null,
        status:  'Active',
        url:     c.url || '',
      }))
  } catch(e) {
    console.log('[intel] competitors scrape failed:', e.message)
    return []
  }
}

/**
 * Extract USP tags from project data.
 */
function extractUSPs(data, name='') {
  const usps = new Set()
  const text = (data.description || '').toLowerCase() + ' ' + (data.amenities||[]).join(' ').toLowerCase()

  if (data.rera) usps.add('RERA Verified')
  if (/metro|tube|subway/i.test(text))          usps.add('Metro Connectivity')
  if (/oc received|occupancy certificate/i.test(text)) usps.add('OC Received')
  if (/township|integrated/i.test(text))        usps.add('Integrated Township')
  if (/garden|landscape/i.test(text))           usps.add('Landscaped Gardens')
  if (/club|clubhouse/i.test(text))             usps.add('Clubhouse')
  if (/pool|swimming/i.test(text))              usps.add('Swimming Pool')
  if (/gym|fitness/i.test(text))                usps.add('Fitness Centre')
  if (/vastu/i.test(text))                      usps.add('Vastu Compliant')
  if (/nri|nri-approved/i.test(text))           usps.add('NRI-Approved')
  if (/green|eco|certified|leed/i.test(text))   usps.add('Green Certified')
  if (/security|cctv|24.*hour/i.test(text))     usps.add('24/7 Security')
  if (/smart home|automation/i.test(text))      usps.add('Smart Home')
  if (/school|educat/i.test(text))              usps.add('School Nearby')
  if (/hospital|health/i.test(text))            usps.add('Hospital Nearby')
  if (/mall|shopping/i.test(text))              usps.add('Mall Access')
  if (/highway|express/i.test(text))            usps.add('Highway Access')
  if (/view|sea view|lake|hill/i.test(text))    usps.add('Scenic Views')

  // Always add from amenities list
  ;(data.amenities||[]).slice(0,4).forEach(a => { if (a && a.length < 30) usps.add(a) })

  return [...usps].slice(0, 10)
}

function infraIcon(type='') {
  const t = type.toLowerCase()
  if (t.includes('metro') || t.includes('rail') || t.includes('transit')) return '🚇'
  if (t.includes('mall') || t.includes('shop') || t.includes('market'))   return '🛍️'
  if (t.includes('hospital') || t.includes('health') || t.includes('clinic')) return '🏥'
  if (t.includes('school') || t.includes('college') || t.includes('univ'))   return '🎓'
  if (t.includes('airport'))  return '✈️'
  if (t.includes('highway') || t.includes('road') || t.includes('express')) return '🛣️'
  if (t.includes('park') || t.includes('garden')) return '🌳'
  if (t.includes('bank') || t.includes('atm'))    return '🏦'
  return '📍'
}

const googleTrends = require('google-trends-api')

/**
 * Real Google Trends search-interest data for a project — no API key, free.
 * Compares the last 7 days' average interest to the 7 days before that to
 * get a genuine WoW trend direction/percentage. Note: the underlying npm
 * package breaks when a `geo` filter is passed (tested — returns HTML, not
 * JSON), so this is worldwide search interest, not India-only.
 */
async function fetchSearchTrend(keyword) {
  const startTime = new Date(Date.now() - 30*24*60*60*1000)
  const raw = await googleTrends.interestOverTime({ keyword, startTime })
  const points = JSON.parse(raw)?.default?.timelineData || []
  if (points.length < 14) return null

  const values = points.map(p => p.value?.[0] ?? 0)
  const last7 = values.slice(-7)
  const prev7 = values.slice(-14, -7)
  const avg = arr => arr.reduce((a,b) => a+b, 0) / arr.length
  const lastAvg = avg(last7), prevAvg = avg(prev7)

  if (prevAvg === 0 && lastAvg === 0) return { direction: 'flat', pctChange: 0, label: 'No search interest recorded' }
  const pctChange = prevAvg === 0 ? 100 : Math.round(((lastAvg - prevAvg) / prevAvg) * 100)
  const direction = pctChange > 5 ? 'up' : pctChange < -5 ? 'down' : 'flat'
  return { direction, pctChange, label: `${pctChange > 0 ? '+' : ''}${pctChange}% search interest (7d vs prior 7d)` }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2-lat1) * Math.PI/180
  const dLon = (lon2-lon1) * Math.PI/180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

/**
 * Real nearby points of interest from OpenStreetMap's free Overpass API —
 * no key required. Queries a 5km radius around the project's real scraped
 * lat/long for airports, metro/rail, hospitals, schools, malls, banks.
 */
async function fetchNearbyInfra(lat, lon) {
  if (lat == null || lon == null) return []
  const radius = 5000 // meters
  const query = `
    [out:json][timeout:15];
    (
      node["aeroway"="aerodrome"](around:50000,${lat},${lon});
      node["railway"="station"](around:${radius},${lat},${lon});
      node["station"="subway"](around:${radius},${lat},${lon});
      node["amenity"="hospital"](around:${radius},${lat},${lon});
      node["amenity"="school"](around:${radius},${lat},${lon});
      node["shop"="mall"](around:${radius},${lat},${lon});
      node["amenity"="bank"](around:${radius},${lat},${lon});
    );
    out body 40;
  `.trim()

  try {
    const body = 'data=' + encodeURIComponent(query)
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'overpass-api.de',
        path: '/api/interpreter',
        method: 'POST',
        // Apache rejects this with 406 if no User-Agent is sent — confirmed via testing.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'IndiHomesOS/1.0' },
      }, (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch(e) { reject(e) } })
      })
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Overpass timeout')) })
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    const elements = (result.elements || []).filter(e => e.tags?.name)
    const typed = elements.map(e => {
      const tags = e.tags
      let type = 'Place'
      if (tags.aeroway === 'aerodrome') type = 'Airport'
      else if (tags.railway === 'station' || tags.station === 'subway') type = 'Metro/Rail'
      else if (tags.amenity === 'hospital') type = 'Hospital'
      else if (tags.amenity === 'school') type = 'School'
      else if (tags.shop === 'mall') type = 'Mall'
      else if (tags.amenity === 'bank') type = 'Bank'
      const dist = haversineKm(lat, lon, e.lat, e.lon)
      return { type, name: tags.name, dist, icon: infraIcon(type) }
    })

    // Closest of each category first, then fill remaining slots by distance
    const byType = {}
    for (const item of typed) {
      if (!byType[item.type] || item.dist < byType[item.type].dist) byType[item.type] = item
    }
    const picked = Object.values(byType)
    const rest = typed.filter(i => !picked.includes(i)).sort((a,b) => a.dist - b.dist)
    const combined = [...picked.sort((a,b)=>a.dist-b.dist), ...rest].slice(0, 8)

    return combined.map(i => ({
      type: i.type, name: i.name, icon: i.icon,
      dist: i.dist < 1 ? `${Math.round(i.dist*1000)} m` : `${i.dist.toFixed(1)} km`,
    }))
  } catch(e) {
    console.error('[infra] Overpass lookup failed:', e.message)
    return []
  }
}

/**
 * Scrape Housing.com project detail page.
 */
async function scrapeHousingComProject(page) {
  const nd = await page.evaluate(() => {
    try { return JSON.parse(document.getElementById('__NEXT_DATA__').textContent) } catch(_) { return null }
  })
  if (nd) {
    const pp = nd?.props?.pageProps
    const pd = pp?.projectDetails || pp?.projectData || pp?.data?.project || null
    if (pd) {
      const rawConfigs = pd.configurations || pd.unitDetails || pd.bhk_configs || []
      return {
        description:  clean(pd.description || pd.about || pd.project_description || ''),
        configs: rawConfigs.map(c => ({
          type:      clean(c.unit_type || c.bhk || c.type || ''),
          carpet:    clean(String(c.carpet_area || c.carpetArea || '')),
          total:     c.total_units || c.totalUnits || null,
          available: c.available_units || c.availableUnits || null,
          price:     clean(c.price_range || c.priceRange || ''),
        })).filter(c => c.type),
        amenities: (pd.amenities || pd.highlights || []).map(a => clean(a.name || String(a))).filter(Boolean),
        rera:        clean(pd.rera_number || pd.reraNumber || ''),
        reraValidity:clean(pd.rera_valid_till || pd.reraValidTill || ''),
        possession:  parsePossession(clean(pd.possession_date || pd.possessionDate || '')),
        sold:        pd.sold_percentage || pd.soldPercentage || null,
        units:       pd.total_units || pd.totalUnits || null,
        priceRange:  clean(pd.price_range || pd.priceRange || ''),
        infra:       (pd.nearby || pd.nearby_facilities || []).slice(0,6).map(f => ({
          type: clean(f.facility_type || f.type || ''),
          name: clean(f.name || ''),
          dist: clean(f.distance || ''),
          icon: infraIcon(f.facility_type || f.type || ''),
        })).filter(f => f.name),
        _source: 'housing.com',
      }
    }
  }
  // DOM fallback
  const dom = await page.evaluate(() => {
    const t = (...sels) => { for(const s of sels){ const el=document.querySelector(s); if(el?.textContent?.trim()) return el.textContent.trim() } return '' }
    return {
      description: t('[class*="description"]','[class*="about"]','[class*="About"]'),
      configs: [], amenities: [], rera: t('[class*="rera"]'), reraValidity: '',
      possession: t('[class*="possession"]'), sold:null, units:null, priceRange: t('[class*="price"]'), infra:[],
      _source: 'housing.com',
    }
  })
  return dom
}

/**
 * Try PropTiger for project data.
 */
async function scrapePropTiger(page, name, builder, city) {
  const q = `${name} ${builder} ${city}`
  const searchUrl = `https://www.proptiger.com/search?term=${encodeURIComponent(q)}&category=Residential`
  try {
    await page.goto(searchUrl, { waitUntil:'domcontentloaded', timeout:20000 })
    await sleep(2000)
    // Get first project link
    const link = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/new-projects/"], a[href*="/project/"]')
      return a?.href || null
    })
    if (!link) return null
    await page.goto(link, { waitUntil:'domcontentloaded', timeout:20000 })
    await sleep(2000)
    // PropTiger often has window.__INITIAL_STATE__
    const state = await page.evaluate(() => {
      try { return window.__INITIAL_STATE__ || window.__REDUX_STATE__ || null } catch(_) { return null }
    })
    if (state) {
      const pd = state?.project?.projectDetail || state?.projectDetail || null
      if (pd) {
        return {
          description: clean(pd.description || pd.about || ''),
          configs: (pd.unitTypeDetails || pd.unitDetails || []).map(c => ({
            type:      clean(c.unitType || c.bhk || ''),
            carpet:    clean(String(c.carpetArea || '')),
            total:     c.totalUnits || null,
            available: c.availableUnits || null,
            price:     clean(c.priceRange || ''),
          })).filter(c => c.type),
          amenities: (pd.amenities || []).map(a => clean(a.name || String(a))).filter(Boolean),
          rera:        clean(pd.reraNumber || ''),
          reraValidity:clean(pd.reraValidTill || ''),
          possession:  parsePossession(clean(pd.possessionDate || '')),
          sold:        pd.soldPercentage || null,
          units:       pd.totalUnits || null,
          priceRange:  clean(pd.priceRange || ''),
          infra:       [],
          _source: 'proptiger.com',
        }
      }
    }
    // DOM fallback for PropTiger
    return await page.evaluate(() => {
      const t = (...sels) => { for(const s of sels){ const el=document.querySelector(s); if(el?.textContent?.trim()) return el.textContent.trim() } return '' }
      return {
        description: t('[class*="project-description"]','[class*="overview"]'),
        configs: [], amenities:
          Array.from(document.querySelectorAll('[class*="amenity-name"],[class*="amenityName"]'))
            .map(a=>a.textContent.trim()).filter(Boolean).slice(0,15),
        rera: t('[class*="rera"]'), reraValidity:'', possession: t('[class*="possession"]'),
        sold:null, units:null, priceRange: t('[class*="price"]'), infra:[],
        _source: 'proptiger.com',
      }
    })
  } catch(e) {
    console.log('[intel] PropTiger failed:', e.message)
    return null
  }
}

/**
 * Extract project info from Google rich snippets / knowledge card.
 * Returns partial data — useful for filling gaps when portal pages fail.
 */
async function scrapeGoogleSnippets(page, name, builder, city) {
  try {
    const q = `"${name}" ${builder} ${city} configurations price possession RERA`
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}`, {
      waitUntil:'domcontentloaded', timeout:18000,
    })
    await sleep(1200)
    return await page.evaluate(() => {
      const allText = document.body.innerText || ''
      // Extract RERA number (MahaRERA format)
      const reraM = allText.match(/P\d{11,14}/)
      // Extract possession year
      const possM = allText.match(/(Q[1-4]\s*20\d\d|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s*20\d\d|20\d\d)/i)
      // Extract price range
      const priceM = allText.match(/(?:₹|Rs\.?)\s*(\d+\.?\d*)\s*(L|Cr)\s*[-–to]+\s*(?:₹|Rs\.?)?\s*(\d+\.?\d*)\s*(L|Cr)/i)
      // Extract amenities from snippet text
      const amenM = allText.match(/(?:gym|pool|clubhouse|garden|park|metro|security|parking|lift|power backup|cctv|playground|jogging|indoor games)/gi) || []
      // Extract description snippet
      const descEl = document.querySelector('[data-sncf="1"], .IsZvec, .VwiC3b')
      return {
        rera:        reraM?.[0] || '',
        possession:  possM?.[0] || '',
        priceRange:  priceM ? priceM[0] : '',
        amenities:   [...new Set(amenM.map(a=>a.charAt(0).toUpperCase()+a.slice(1).toLowerCase()))],
        description: descEl?.textContent?.trim()?.slice(0,400) || '',
        _source:     'google',
      }
    })
  } catch(e) {
    console.log('[intel] Google snippets failed:', e.message)
    return null
  }
}

/**
 * Find a project in the in-memory scrape cache by name + builder/city.
 * Returns the raw cached project object or null.
 */
function findInCache(name, builder, city) {
  if (!cache.projects.length) return null
  const nKey = name.toLowerCase().replace(/\W/g,'')
  // Exact name match first
  let match = cache.projects.find(p => p.name.toLowerCase().replace(/\W/g,'') === nKey)
  if (!match) {
    // Fuzzy: name contains or is contained
    match = cache.projects.find(p => {
      const pk = p.name.toLowerCase().replace(/\W/g,'')
      return pk.includes(nKey) || nKey.includes(pk)
    })
  }
  return match || null
}

/**
 * Build competitor list from the in-memory cache (same city, different project).
 * Falls back to scraping if cache is empty.
 */
function competitorsFromCache(name, city, bhkTypes) {
  if (!cache.projects.length) return []
  const nKey = name.toLowerCase().replace(/\W/g,'')
  return cache.projects
    .filter(p => {
      if (p.city !== city) return false
      if (p.name.toLowerCase().replace(/\W/g,'') === nKey) return false
      // At least one overlapping BHK type
      if (bhkTypes.length && Array.isArray(p.bhk)) {
        return p.bhk.some(b => bhkTypes.includes(b))
      }
      return true
    })
    .slice(0, 4)
    .map(p => ({
      name:    p.name,
      builder: p.developer || '',
      price:   p.price_display || 'Price on request',
      sold:    null,
      status:  'Active',
      url:     p.listing_url || '',
    }))
}

// ── APIFY INTEGRATION ─────────────────────────────────────────────────────────
const APIFY_TOKEN = process.env.APIFY_TOKEN || ''
const APIFY_ACTOR = 'inexhaustible_glass~99acres-scraper'
const INTEL_TTL_LONG = 24 * 60 * 60 * 1000 // 24 h — Apify runs cost money
// Each result costs ~$0.02 on this actor — keep lookups cheap. 15 listings is
// plenty to find the target project + a handful of real competitors.
const APIFY_MAX_RESULTS = parseInt(process.env.APIFY_MAX_RESULTS || '15', 10)

// Once Apify reports the account's monthly $ cap is exceeded, every further
// call fails the exact same way until the billing cycle resets — retrying
// per-request just adds latency and noise. Cache that state and skip the
// network round-trip until the cooldown passes.
let apifyQuotaExceededUntil = 0
const APIFY_QUOTA_COOLDOWN_MS = 60 * 60 * 1000 // re-check hourly, e.g. after a plan upgrade
function isApifyQuotaExceeded() { return Date.now() < apifyQuotaExceededUntil }
function markApifyQuotaExceeded() {
  apifyQuotaExceededUntil = Date.now() + APIFY_QUOTA_COOLDOWN_MS
  console.log(`[apify] Monthly usage cap hit — skipping further calls until ${new Date(apifyQuotaExceededUntil).toISOString()}`)
}

function apifyPost(path, body, timeoutMs = 330000) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const req = https.request({
      hostname: 'api.apify.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APIFY_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
        catch(e) { reject(new Error('Apify JSON parse error')) }
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Apify request timeout')) })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

function apifyGet(path, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.apify.com',
      path,
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch(e) { reject(e) }
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Apify GET timeout')) })
    req.on('error', reject)
    req.end()
  })
}

async function scrape99AcresViaApify(city, area, maxResults = 15) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not configured — add it to .env')
  if (isApifyQuotaExceeded()) throw new Error(`Apify monthly usage cap exceeded — retry after ${new Date(apifyQuotaExceededUntil).toISOString()} or upgrade the plan`)

  const input = {
    city,
    area: area || '',
    transaction: 'Buy',
    listingType: 'Projects',
    maxResults,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  }

  console.log(`[apify] Starting run: city=${city} area=${area} maxResults=${maxResults}`)

  // waitForFinish=300 makes the POST block up to 5 min until the run completes
  const { status, body } = await apifyPost(
    `/v2/acts/${APIFY_ACTOR}/runs?waitForFinish=300`,
    input,
  )

  if (status !== 200 && status !== 201) {
    if (body?.error?.type === 'platform-feature-disabled' || /hard limit/i.test(body?.error?.message || '')) {
      markApifyQuotaExceeded()
    }
    throw new Error(`Apify run failed: HTTP ${status} — ${JSON.stringify(body?.error || body)}`)
  }

  const run = body.data || body
  if (run.status !== 'SUCCEEDED') {
    throw new Error(`Apify run ${run.status}: ${run.statusMessage || ''}`)
  }

  const datasetId = run.defaultDatasetId
  console.log(`[apify] Run SUCCEEDED, dataset: ${datasetId}`)

  const items = await apifyGet(`/v2/datasets/${datasetId}/items?clean=true&format=json`)
  console.log(`[apify] Got ${Array.isArray(items) ? items.length : '?'} items`)
  return Array.isArray(items) ? items : []
}

function fuzzyMatch(a, b) {
  const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const ka = clean(a), kb = clean(b)
  if (!ka || !kb) return false
  return ka === kb || ka.includes(kb) || kb.includes(ka)
}

function parseApifyConfigs(item) {
  const configStr = (item.configurations || []).join(' ')
  const bhkTypes = parseBHK(configStr)
  if (!bhkTypes.length) return []

  const planPrice = (item.plans || []).map(p => p.budget?.trim()).filter(Boolean)[0] || item.price_raw || ''

  return bhkTypes.map(t => ({
    type:      t,
    carpet:    '',
    total:     null,
    available: null,
    price:     planPrice,
    movement:  null,
    _estimated: false,
  }))
}

function apifyItemToIntel(item, competitors) {
  const configs = parseApifyConfigs(item)
  return {
    name:         item.project_name || '',
    builder:      item.builder || '',
    city:         item.city || '',
    description:  item.description || '',
    configs,
    amenities:    [],
    rera:         item.rera_number || '',
    reraValidity: '',
    possession:   item.possession_date || item.possession_status || '',
    sold:         null,
    units:        null,
    priceRange:   item.price_raw || '',
    price:        item.price || '',
    infra:        [],
    usps:         item.usp || [],
    listingUrl:   item.url || '',
    imageUrl:     item.image || '',
    competitors,
    latitude:     item.latitude ?? null,
    longitude:    item.longitude ?? null,
    localityName: item.locality || '',
    _sources:     { primary: '99acres (Apify)' },
    _scraped:     true,
    _configsEstimated:   false,
    _amenitiesEstimated: true,
    _reraEstimated:      !item.rera_number,
    fetchedAt:    new Date().toISOString(),
  }
}

/**
 * Main project intelligence function — 100% Apify-scraped data, zero synthetic content.
 */
async function scrapeProjectIntelViaApify({ name, builder, city, listingUrl, reraCode, bhk, possession: inputPossession, sold: inputSold, units: inputUnits, priceDisplay: inputPrice }) {
  if (!APIFY_TOKEN) {
    return {
      name, builder, city,
      _scraped: false,
      _error: 'APIFY_TOKEN not set. Add it to .env and restart the server.',
    }
  }

  // Extract area/locality from name or use first word of city if compound (e.g. "Thane West")
  const cityParts = (city || '').split(' ')
  const baseCity  = cityParts[0] || city
  const areaHint  = cityParts.length > 1 ? city : ''  // "Thane West" → area="Thane West", city="Thane"

  try {
    const items = await scrape99AcresViaApify(baseCity, areaHint, APIFY_MAX_RESULTS)

    // Find the target project by fuzzy name + optional builder match
    const target = items.find(item =>
      fuzzyMatch(item.project_name, name) ||
      (builder && fuzzyMatch(item.builder, builder) && fuzzyMatch(item.project_name, name.split(' ').slice(0,2).join(' ')))
    )

    if (!target) {
      console.log(`[intel] Project "${name}" not found in ${items.length} Apify results`)
      // Return what we have from in-memory cache + input fields, no synthetic content
      const cached = findInCache(name, builder, city)
      if (cached) {
        return {
          name, builder, city,
          description: '',
          configs: [],
          amenities: [],
          rera: cached.reraCode || reraCode || '',
          reraValidity: '',
          possession: cached.possession || inputPossession || '',
          sold: inputSold || null,
          units: inputUnits || null,
          priceRange: cached.price_display || inputPrice || '',
          infra: [], usps: [],
          competitors: competitorsFromCache(name, city, parseBHK(bhk || cached.config || '')),
          _sources: { primary: 'indihomes-db' },
          _scraped: true,
          _configsEstimated: true,
          _amenitiesEstimated: true,
          _reraEstimated: !cached.reraCode,
          _notFoundOnPortal: true,
          fetchedAt: new Date().toISOString(),
        }
      }
      return { name, builder, city, _scraped: false, _error: 'Project not found on 99acres' }
    }

    // Build competitors from other items (same city, exclude target)
    const targetKey = (target.project_name || '').toLowerCase().replace(/\W/g, '')
    const competitors = items
      .filter(it => (it.project_name || '').toLowerCase().replace(/\W/g, '') !== targetKey)
      .slice(0, 5)
      .map(it => ({
        name:    it.project_name || '',
        builder: it.builder || '',
        price:   it.price || 'Price on request',
        sold:    null,
        status:  it.possession_status || 'Active',
        url:     it.url || '',
      }))

    console.log(`[intel] Found "${target.project_name}" + ${competitors.length} competitors via Apify`)
    const intel = apifyItemToIntel(target, competitors)
    if (intel.latitude != null && intel.longitude != null) {
      try { intel.infra = await fetchNearbyInfra(intel.latitude, intel.longitude) }
      catch(e) { console.error('[intel] infra lookup failed:', e.message) }
    }
    try { intel.searchTrend = await fetchSearchTrend(`${name} ${builder}`.trim()) }
    catch(e) { console.error('[intel] search trend lookup failed:', e.message) }
    return intel

  } catch(e) {
    console.error('[intel] Apify scrape failed:', e.message)
    return {
      name, builder, city,
      _scraped: false,
      _error: `Scrape failed: ${e.message}`,
    }
  }
}

// ── LOCAL PYTHON SCRAPER (free, no API quota) ──────────────────────────────────
// 99acres' WAF blocks headless Chrome and plain HTTP outright, but a real
// (non-headless, off-screen) Selenium window gets through — see scripts/scrape_99acres.py.
const { spawn } = require('child_process')
const PYTHON_BIN = process.env.PYTHON_BIN || 'python'
const PY_SCRAPER_PATH = path.join(__dirname, 'scripts', 'scrape_99acres.py')
const PY_SCRAPER_TIMEOUT = 90000

// undetected-chromedriver extracts its patched binary into a shared per-user
// cache directory on first launch; two Python processes racing to do that at
// once throw a Windows file-already-exists error. Serialize all spawns of
// either Python scraper through one queue so that can never happen.
let pyScraperQueue = Promise.resolve()
function queuePythonSpawn(fn) {
  const run = pyScraperQueue.then(fn, fn) // run even if the previous call rejected
  pyScraperQueue = run.catch(() => {})    // never let a rejection break the chain
  return run
}

function runPythonScraperImpl({ name, builder, city, listingUrl }) {
  return new Promise((resolve, reject) => {
    let py
    try {
      py = spawn(PYTHON_BIN, [PY_SCRAPER_PATH])
    } catch(e) { return reject(e) }

    let stdout = '', stderr = ''
    const timer = setTimeout(() => {
      try { py.kill() } catch(_) {}
      reject(new Error('Python scraper timed out'))
    }, PY_SCRAPER_TIMEOUT)

    py.stdout.on('data', d => { stdout += d })
    py.stderr.on('data', d => { stderr += d; const l = d.toString().trim(); console.log('[py]', l); logScraper('[py] ' + l) })
    py.on('error', e => { clearTimeout(timer); logScraper('[py] spawn error: ' + e.message); reject(e) })
    py.on('close', () => {
      clearTimeout(timer)
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop()
      if (!lastLine) return reject(new Error(`Python scraper produced no output. stderr: ${stderr.slice(-400)}`))
      try { resolve(JSON.parse(lastLine)) }
      catch(e) { reject(new Error(`Python scraper output not valid JSON: ${lastLine.slice(0,200)}`)) }
    })

    py.stdin.write(JSON.stringify({ name, builder, city, listingUrl }))
    py.stdin.end()
  })
}

function runPythonScraper(args) {
  return queuePythonSpawn(() => runPythonScraperImpl(args))
}

// ── BACKGROUND RERA ENRICHMENT ──────────────────────────────────────────────
// The list-discovery scraper (scrape99AcresLocalList) is intentionally fast
// and skips RERA/price/possession to keep Project Selection responsive. This
// fills those in afterward by visiting each project's *exact* listing URL —
// the same page scrape_99acres.py reads for Project Intelligence — so the
// RERA number shown is always pulled straight from that project's real page,
// never guessed or reused from a different project.
const enrichedListingUrls = new Set()
const ENRICH_BATCH_SIZE = 6

async function enrichProjectsWithRera() {
  const candidates = cache.projects.filter(p =>
    !p.reraCode && p.listingUrl &&
    (p.listingUrl.includes('99acres.com') || p.listingUrl.includes('magicbricks.com')) &&
    !enrichedListingUrls.has(p.listingUrl)
  ).slice(0, ENRICH_BATCH_SIZE)

  if (!candidates.length) return
  console.log(`[enrich] Filling in real RERA/price/possession for ${candidates.length} project(s) via their listing link`)

  for (const p of candidates) {
    enrichedListingUrls.add(p.listingUrl) // mark attempted either way — never retry-storm a project with no RERA on file
    const scraper = p.listingUrl.includes('magicbricks.com') ? runPythonMagicBricksScraper : runPythonScraper
    try {
      const result = await scraper({ name: p.name, builder: p.builder, city: p.city, listingUrl: p.listingUrl })
      if (result && result._scraped) {
        if (result.rera) {
          p.reraCode = result.rera; p.rera = true
          try {
            db.saveDiscoveredRera(p.listingUrl, { rera: result.rera, priceDisplay: result.priceRange, possession: result.possession })
          } catch(e) { console.error('[db] saveDiscoveredRera failed:', e.message) }
        }
        if (result.priceRange) p.budgetLabel = result.priceRange
        if (result.possession) p.possession = result.possession
        console.log(`[enrich] ${p.name}: rera=${result.rera || 'none found'}`)
      } else {
        console.log(`[enrich] ${p.name}: ${result?._error || 'no data'}`)
      }
    } catch(e) {
      console.error(`[enrich] ${p.name} failed:`, e.message)
    }
  }

  try { db.saveProjectsSnapshot(cache.projects) } catch(e) { console.error('[db] snapshot save failed:', e.message) }
}

const PY_LIST_SCRAPER_PATH = path.join(__dirname, 'scripts', 'scrape_99acres_list.py')
const PY_LIST_SCRAPER_TIMEOUT = 180000 // multiple cities, sequential page loads

function runPythonListScraperImpl(cities) {
  return new Promise((resolve, reject) => {
    let py
    try {
      py = spawn(PYTHON_BIN, [PY_LIST_SCRAPER_PATH])
    } catch(e) { return reject(e) }

    let stdout = '', stderr = ''
    const timer = setTimeout(() => {
      try { py.kill() } catch(_) {}
      reject(new Error('Python list scraper timed out'))
    }, PY_LIST_SCRAPER_TIMEOUT)

    py.stdout.on('data', d => { stdout += d })
    py.stderr.on('data', d => { stderr += d; const l = d.toString().trim(); console.log('[py-list]', l); logScraper('[py-list] ' + l) })
    py.on('error', e => { clearTimeout(timer); logScraper('[py-list] spawn error: ' + e.message); reject(e) })
    py.on('close', () => {
      clearTimeout(timer)
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop()
      if (!lastLine) return reject(new Error(`Python list scraper produced no output. stderr: ${stderr.slice(-400)}`))
      try { resolve(JSON.parse(lastLine)) }
      catch(e) { reject(new Error(`Python list scraper output not valid JSON: ${lastLine.slice(0,200)}`)) }
    })

    py.stdin.write(JSON.stringify({ cities }))
    py.stdin.end()
  })
}

function runPythonListScraper(cities) {
  return queuePythonSpawn(() => runPythonListScraperImpl(cities))
}

/**
 * Discover real, currently-listed 99acres projects across cities — used to
 * seed Project Selection with accurate, selectable project names + real
 * listing URLs. No price/RERA/configs here (kept fast); those are filled in
 * by scrapeProjectIntel() once a project is selected and opened.
 */
async function scrape99AcresLocalList(cities = ['Mumbai', 'Thane', 'Pune', 'Navi Mumbai']) {
  const items = await runPythonListScraper(cities)
  // Re-apply any RERA/price/possession discovered by a previous enrichment pass
  // (this run or an earlier server lifetime) — without this, every fresh
  // discovery scrape would wipe out enrichment work done so far.
  let known = new Map()
  try { known = db.getAllDiscoveredRera() } catch(e) { console.error('[db] getAllDiscoveredRera failed:', e.message) }

  return (items || []).map(it => {
    const dev = KNOWN_DEVS.find(d => it.name.toLowerCase().includes(d.toLowerCase()))
    const discovered = known.get(it.listingUrl)
    return {
      name: it.name,
      developer: dev || '',
      city: it.city,
      location: '',
      bhk: [],
      price_min: null, price_max: null,
      price_display: discovered?.price_display || null,
      possession: discovered?.possession || null,
      reraCode: discovered?.rera || null,
      units: null, sold_pct: null, amenities: [],
      listing_url: it.listingUrl,
      _source: '99acres-local',
    }
  })
}

// ── MAGICBRICKS (also free, also via local Python/Selenium) ────────────────
// Unlike 99acres, MagicBricks does NOT block this non-headless Selenium
// technique at all — confirmed via direct testing, loads full real content
// immediately. Same dispatcher pattern as the 99acres scraper above.
const PY_MB_SCRAPER_PATH = path.join(__dirname, 'scripts', 'scrape_magicbricks.py')
const PY_MB_LIST_SCRAPER_PATH = path.join(__dirname, 'scripts', 'scrape_magicbricks_list.py')

function runPythonMagicBricksScraperImpl({ name, builder, city, listingUrl }) {
  return new Promise((resolve, reject) => {
    let py
    try { py = spawn(PYTHON_BIN, [PY_MB_SCRAPER_PATH]) } catch(e) { return reject(e) }
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { try { py.kill() } catch(_) {}; reject(new Error('MagicBricks scraper timed out')) }, PY_SCRAPER_TIMEOUT)
    py.stdout.on('data', d => { stdout += d })
    py.stderr.on('data', d => { stderr += d; const l = d.toString().trim(); console.log('[py-mb]', l); logScraper('[py-mb] ' + l) })
    py.on('error', e => { clearTimeout(timer); logScraper('[py-mb] spawn error: ' + e.message); reject(e) })
    py.on('close', () => {
      clearTimeout(timer)
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop()
      if (!lastLine) return reject(new Error(`MagicBricks scraper produced no output. stderr: ${stderr.slice(-400)}`))
      try { resolve(JSON.parse(lastLine)) }
      catch(e) { reject(new Error(`MagicBricks scraper output not valid JSON: ${lastLine.slice(0,200)}`)) }
    })
    py.stdin.write(JSON.stringify({ name, builder, city, listingUrl }))
    py.stdin.end()
  })
}
function runPythonMagicBricksScraper(args) {
  return queuePythonSpawn(() => runPythonMagicBricksScraperImpl(args))
}

function runPythonMagicBricksListScraperImpl(cities) {
  return new Promise((resolve, reject) => {
    let py
    try { py = spawn(PYTHON_BIN, [PY_MB_LIST_SCRAPER_PATH]) } catch(e) { return reject(e) }
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { try { py.kill() } catch(_) {}; reject(new Error('MagicBricks list scraper timed out')) }, PY_LIST_SCRAPER_TIMEOUT)
    py.stdout.on('data', d => { stdout += d })
    py.stderr.on('data', d => { stderr += d; const l = d.toString().trim(); console.log('[py-mb-list]', l); logScraper('[py-mb-list] ' + l) })
    py.on('error', e => { clearTimeout(timer); logScraper('[py-mb-list] spawn error: ' + e.message); reject(e) })
    py.on('close', () => {
      clearTimeout(timer)
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop()
      if (!lastLine) return reject(new Error(`MagicBricks list scraper produced no output. stderr: ${stderr.slice(-400)}`))
      try { resolve(JSON.parse(lastLine)) }
      catch(e) { reject(new Error(`MagicBricks list scraper output not valid JSON: ${lastLine.slice(0,200)}`)) }
    })
    py.stdin.write(JSON.stringify({ cities }))
    py.stdin.end()
  })
}
function runPythonMagicBricksListScraper(cities) {
  return queuePythonSpawn(() => runPythonMagicBricksListScraperImpl(cities))
}

async function scrapeMagicBricksLocalList(cities = ['Mumbai', 'Thane', 'Pune', 'Navi Mumbai']) {
  const items = await runPythonMagicBricksListScraper(cities)
  let known = new Map()
  try { known = db.getAllDiscoveredRera() } catch(e) { console.error('[db] getAllDiscoveredRera failed:', e.message) }

  return (items || []).map(it => {
    const dev = KNOWN_DEVS.find(d => it.name.toLowerCase().includes(d.toLowerCase()))
    const discovered = known.get(it.listingUrl)
    return {
      name: it.name,
      developer: dev || '',
      city: it.city,
      location: '',
      bhk: [],
      price_min: null, price_max: null,
      price_display: discovered?.price_display || null,
      possession: discovered?.possession || null,
      reraCode: discovered?.rera || null,
      units: null, sold_pct: null, amenities: [],
      listing_url: it.listingUrl,
      _source: 'magicbricks-local',
    }
  })
}

// Significant tokens of a project name (drops generic real-estate filler) so we
// can tell whether a scraped result is actually the project we asked for.
const NAME_STOPWORDS = new Set(['the','and','new','project','projects','apartment','apartments',
  'residency','residences','residence','phase','wing','tower','towers','by','at','realty',
  'group','developers','builder','builders','pvt','ltd','properties','property','homes','city'])
function nameTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !NAME_STOPWORDS.has(w))
}
// True if the scraped project name plausibly matches the requested one. Guards
// against the scraper's loose name-search returning a *different* project
// (e.g. searching "Lodha Luxuria" and getting "Runwal One"). We'd rather show
// "not available" than confidently show the wrong project's data.
function nameMatches(requested, scraped) {
  const a = new Set(nameTokens(requested)), b = new Set(nameTokens(scraped))
  if (!a.size || !b.size) return true // not enough to judge — don't over-reject
  let overlap = 0; for (const w of a) if (b.has(w)) overlap++
  return overlap >= 1 && overlap / a.size >= 0.34
}

// Fill empty structured boxes (configs, USPs, units, possession…) from the
// scraped description prose using the LLM — only where the scraper didn't
// already provide the field, and only extractively (llm.structureListing never
// invents values). This is what turns a MagicBricks blurb into filled cards.
async function fillFromDescription(result) {
  if (!llm.isConfigured()) return result
  try {
    const s = await llm.structureListing(result)
    if (!s) return result
    if (s.summary) { result.descriptionRaw = result.description || result.descriptionRaw; result.description = s.summary }
    if (!(result.configs?.length) && Array.isArray(s.configs) && s.configs.length) result.configs = s.configs
    if (!(result.usps?.length) && Array.isArray(s.usps) && s.usps.length) result.usps = s.usps
    if (Array.isArray(s.amenities) && s.amenities.length) {
      const have = new Set((result.amenities || []).map(a => String(a).toLowerCase()))
      result.amenities = [...(result.amenities || []), ...s.amenities.filter(a => !have.has(String(a).toLowerCase()))]
    }
    if (result.units == null && s.total_units != null) result.units = s.total_units
    if (s.towers != null && result.towers == null) result.towers = s.towers
    if ((!result.possession || result.possession === 'TBD') && s.possession) result.possession = s.possession
    if (!result.priceRange && s.price_range) result.priceRange = s.price_range
    if (!result.rera && s.rera) result.rera = s.rera
    result._structured = true
  } catch(e) { console.error('[intel] structure-from-description failed:', e.message) }
  return result
}

async function enrichIntel(result, name, builder) {
  if (result.latitude != null && result.longitude != null) {
    try {
      result.infra = await fetchNearbyInfra(result.latitude, result.longitude)
      console.log(`[intel] nearby infra: ${result.infra.length} POIs found`)
    } catch(e) { console.error('[intel] infra lookup failed:', e.message) }
  }
  try { result.searchTrend = await fetchSearchTrend(`${name} ${builder}`.trim()) }
  catch(e) { console.error('[intel] search trend lookup failed:', e.message) }
  await fillFromDescription(result)
  return { ...result, fetchedAt: new Date().toISOString() }
}

/**
 * Project intelligence dispatcher — 100% real scraped data, zero synthetic content.
 * Routes by the listing link's site so the exact project page is used (an
 * ignored MagicBricks link + a 99acres name-search is how we ended up serving
 * the wrong project). Every hit is name-validated before it's trusted.
 */
async function scrapeProjectIntel(params) {
  const { name, builder, city, listingUrl } = params
  const isMB = !!(listingUrl && listingUrl.includes('magicbricks.com'))

  const attempts = []
  const run99 = async () => {
    console.log(`[intel] trying 99acres scraper: ${name}${listingUrl ? ' (known URL)' : ''}`)
    return runPythonScraper({ name, builder, city, listingUrl })
  }
  const runMB = async () => {
    console.log(`[intel] trying MagicBricks scraper: ${name}`)
    const mbUrl = isMB ? listingUrl : undefined
    return runPythonMagicBricksScraper({ name, builder, city, listingUrl: mbUrl })
  }
  // When the listing link is a MagicBricks page, scrape MagicBricks first with
  // that exact URL — no fuzzy name-search, so no wrong-project risk.
  attempts.push(...(isMB ? [['MagicBricks', runMB], ['99acres', run99]]
                         : [['99acres', run99], ['MagicBricks', runMB]]))

  for (const [src, fn] of attempts) {
    try {
      const r = await fn()
      if (r && r._scraped) {
        if (!nameMatches(name, r.name)) {
          console.log(`[intel] ${src} returned a DIFFERENT project ("${r.name}" for "${name}") — rejecting`)
          continue
        }
        console.log(`[intel] ${src} hit: ${name} (rera:${r.rera || 'none'}, competitors:${r.competitors?.length||0})`)
        return enrichIntel(r, name, builder)
      }
      console.log(`[intel] ${src} miss: ${r?._error || 'unknown'}`)
    } catch(e) {
      console.error(`[intel] ${src} failed:`, e.message)
    }
  }

  if (APIFY_TOKEN && !isApifyQuotaExceeded()) {
    console.log('[intel] falling back to Apify')
    return scrapeProjectIntelViaApify(params)
  }

  if (APIFY_TOKEN && isApifyQuotaExceeded()) {
    return {
      name, builder, city, _scraped: false,
      _error: `This project isn't in our cached dataset yet, and live scraping is temporarily unavailable: neither 99acres nor MagicBricks had a match, and the Apify fallback has hit its monthly usage cap (resets on your Apify account's next monthly billing cycle — check console.apify.com/billing for the exact date, or upgrade the plan). Try a project that's already cached in the meantime.`,
    }
  }

  return { name, builder, city, _scraped: false, _error: 'Could not scrape this project — neither 99acres nor MagicBricks had a match, and no Apify fallback is configured.' }
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express()
const ALLOWED_ORIGINS = [
  'http://localhost:5174', 'http://localhost:5173', 'http://127.0.0.1:5174',
  ...((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)),
]
app.use(cors({ origin: ALLOWED_ORIGINS }))
// Default express.json() cap is 100kb — IndiHomes project objects carry
// media/floorUrls/youtubeUrls/amenities/description arrays that push
// Filter Search's /api/filter-rank payload (up to ~150 full project objects)
// well past that on a broad, unfiltered browse. Raised rather than trimmed
// client-side — simpler and the richer objects are genuinely needed for
// scoring.cjs's completeness check (media length, description length, etc).
app.use(express.json({ limit: '5mb' }))
// Internal tool bridge for the Python ai-search-agent (LangGraph) service —
// see agent-tools-bridge.cjs's header for why this exists as a separate,
// token-gated router rather than mixing agent-only routes into the public
// API surface below.
app.use('/internal/agent-tools', agentToolsBridge)
app.use(leadEvents)
app.get('/', (_req,res) => res.json({ ok:true, service:'IndiHomes API', endpoints:['/api/projects','/api/status','/api/project-intel (POST)'] }))
// Filter Search's sole data source: the official IndiHomes API. No-param
// calls (the polling frontend today) return the background-refreshed cache
// object, preserving current UI behavior. Query params (area/flatType/
// budgetMin/budgetMax/possessionDate/page/limit/sortBy) trigger a live,
// server-side filtered/paginated/sorted call straight to IndiHomes — the
// backend-ready path for a future Filter Search UI that doesn't rely on
// client-side filtering of the bulk cache.
app.get('/api/projects', async (req, res) => {
  const { area, flatType, budgetMin, budgetMax, possessionDate, page, limit, sortBy } = req.query
  const hasLiveParams = area || flatType || budgetMin || budgetMax || possessionDate || page || sortBy
  if (!hasLiveParams) return res.json(cache)
  try {
    // Passed straight through, UNCONVERTED, to IndiHomes' live API — it wants
    // budgetMin/budgetMax in raw rupees (not this app's Lakhs convention) and
    // flatType as "2BHK" (no space, not "2 BHK") — see the contract comment
    // on indihomes-client.cjs's buildListParams(). Nothing in the current
    // frontend calls this route with these query params (Filter Search always
    // hits GET /api/projects bare, served from `cache` above), so this is
    // dormant today; a future caller must convert before sending.
    const result = await indihomesClient.fetchProjects({
      area, flatType,
      budgetMin: budgetMin != null ? Number(budgetMin) : undefined,
      budgetMax: budgetMax != null ? Number(budgetMax) : undefined,
      possessionDate, page: page != null ? Number(page) : undefined,
      limit: limit != null ? Number(limit) : undefined, sortBy,
    })
    res.json(result)
  } catch (e) {
    console.error('[api/projects] live fetch failed:', e.message)
    res.status(502).json({ success: false, error: `IndiHomes API is unavailable and no cached data matches these filters: ${e.message}`, projects: [] })
  }
})

// Project Intelligence "own data first" lookup — official IndiHomes detail
// by numeric id or internal project code.
app.get('/api/projects/:idOrCode', async (req, res) => {
  const key = req.params.idOrCode
  try {
    const project = /^\d+$/.test(key) ? await indihomesClient.fetchProjectById(key) : await indihomesClient.fetchProjectByName(key)
    res.json({ success: true, project })
  } catch (e) {
    console.error('[api/projects/:idOrCode] error:', e.message)
    res.status(404).json({ success: false, error: e.message })
  }
})

// Azure AI Search-backed suggest + faceted search (report Sections 2.2/2.3/6).
// Both return { configured:false } until AZURE_SEARCH_ENDPOINT/AZURE_SEARCH_ADMIN_KEY
// are set — the frontend falls back to its existing local suggestions/filtering
// in that case, so the app behaves identically today and upgrades automatically
// once credentials are supplied and a scrape/sync has run.
app.get('/api/search-suggest', async (req, res) => {
  try { res.json(await azureSearch.suggest(req.query.q || '')) }
  catch (e) { console.error('[search-suggest] error:', e.message); res.status(500).json({ configured: true, error: e.message, results: [] }) }
})
app.post('/api/search-listings', async (req, res) => {
  try {
    const { q, locations, budget, configs, possession } = req.body || {}
    res.json(await azureSearch.searchListings(q, { locations, budget, configs, possession }))
  } catch (e) { console.error('[search-listings] error:', e.message); res.status(500).json({ configured: true, error: e.message }) }
})
app.get('/api/status',   (_req,res) => res.json({ status:cache.status, step:cache.step, lastRun:cache.lastRun, nextRun:cache.nextRun }))
app.get('/api/debug/scraper-log', (_req,res) => res.json({ lines: scraperLog }))
app.get('/api/debug/connectivity', async (_req, res) => {
  try {
    const result = await queuePythonSpawn(() => new Promise((resolve, reject) => {
      const py = spawn(PYTHON_BIN, [path.join(__dirname, 'scripts', 'debug_connectivity.py')])
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { try { py.kill() } catch(_) {}; reject(new Error('timeout')) }, 90000)
      py.stdout.on('data', d => { stdout += d })
      py.stderr.on('data', d => { stderr += d; console.log('[debug]', d.toString().trim()) })
      py.on('error', e => { clearTimeout(timer); reject(e) })
      py.on('close', () => {
        clearTimeout(timer)
        try { resolve({ result: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()), stderr }) }
        catch(e) { resolve({ result: null, stdout, stderr }) }
      })
    }))
    res.json(result)
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})
// Manual refresh of the official IndiHomes catalog (Filter Search's data
// source). Named /api/scrape for frontend/back-compat; no scraping happens
// here anymore — see the legacy-scrapers.cjs comment for why.
app.post('/api/scrape', (_req, res) => {
  if (!indihomesClient.isEnabled()) {
    return res.status(409).json({ ok: false, error: 'IndiHomes Projects API is disabled (INDIHOMES_PROJECTS_ENABLED=false).' })
  }
  refreshIndiHomesCatalog().catch(console.error)
  res.json({ ok: true })
})

// Project Intelligence — scrape detailed data for a single project
app.post('/api/project-intel', async (req, res) => {
  const { name, builder, city, listingUrl, reraCode, bhk,
          possession, sold, units, priceDisplay } = req.body || {}
  if (!name) return res.status(400).json({ error:'name required' })

  const cacheKey = `${name}::${builder||''}`.toLowerCase().replace(/\W/g,'')

  // L1: in-memory (fastest, cleared on restart)
  const cached = intelCache[cacheKey]
  if (cached && Date.now() - cached.ts < INTEL_TTL) {
    console.log(`[intel] memory cache hit: ${cacheKey}`)
    return res.json({ ...cached.data, _fromCache:true })
  }

  // L2: SQLite (survives restarts — avoids re-paying for an Apify run)
  const dbHit = db.getIntel(cacheKey)
  if (dbHit && Date.now() - dbHit.fetchedAt < INTEL_TTL) {
    console.log(`[intel] db cache hit: ${cacheKey}`)
    intelCache[cacheKey] = { data: dbHit.data, ts: dbHit.fetchedAt }
    return res.json({ ...dbHit.data, _fromCache:true, _fromDb:true })
  }

  console.log(`[intel] scraping: ${name} / ${builder} / ${city}`)
  try {
    const data = await scrapeProjectIntel({ name, builder, city, listingUrl, reraCode, bhk,
                                            possession, sold, units, priceDisplay })
    // Only cache real successes — caching a failure (e.g. a transient Apify
    // quota/network blip) would otherwise lock that project into returning
    // the same error for the full TTL even after the underlying issue clears.
    if (data._scraped && !data._error) {
      intelCache[cacheKey] = { data, ts: Date.now() }
      try { db.saveIntel(cacheKey, { name, builder, city }, data) }
      catch(e) { console.error('[db] saveIntel failed:', e.message) }
    }
    res.json(data)
  } catch(e) {
    console.error('[intel] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── AI PROPERTY INTELLIGENCE AGENT ────────────────────────────────────────────

// Drives AI Search's "external sources not configured yet" banner and its
// connector-health breakdown. Nothing here is about an LLM key — AI Search
// never calls Claude — this reflects whether Azure AI Search + at least one
// external connector is actually wired up, broken down per connector so the
// UI can say exactly what's missing instead of one opaque "not configured".
app.get('/api/ai-status', (_req, res) => {
  const status = externalSearch.getStatus()
  const byId = id => status.connectors.find(c => c.id === id)
  const tavily = byId('tavily')
  const google = byId('google-cse')
  const bing = byId('bing-search')
  const apify = byId('apify-actor')
  const legacyPortal = byId('legacy-portal-scraper')
  const dubaiConnectors = status.connectors.filter(c => c.market.includes('dubai') && c.configured)
  const anyConfigured = status.connectors.some(c => c.configured)
  // The connectors the UI should always show a status chip for, regardless
  // of which one is actually configured — so the AI Search screen can say
  // "Tavily ✓ · Google ✓ · Bing ✗ · Apify ✗" instead of just an opaque
  // enabled/disabled flag. Tavily is listed first (AI-native web research,
  // strongly recommended); Bing is the quickest fallback if Google Custom
  // Search 403s (a single API key, no actor/agreement setup like Apify).
  const connectorsList = [
    { id: 'tavily', name: 'Tavily AI Search', configured: !!tavily?.configured, recommended: !tavily?.configured },
    { id: 'google-cse', name: 'Google Custom Search', configured: !!google?.configured },
    { id: 'bing-search', name: 'Bing Web Search', configured: !!bing?.configured },
    { id: 'apify-actor', name: 'Apify Actor', configured: !!apify?.configured },
    { id: 'legacy-portal-scraper', name: '99acres / MagicBricks (direct)', configured: !!legacyPortal?.configured },
  ]
  res.json({
    enabled: status.enabled && status.azureConfigured && anyConfigured,
    azure: { configured: status.azureConfigured },
    externalSearch: { enabled: status.enabled },
    connectors: {
      tavily: { configured: !!tavily?.configured },
      googleCustomSearch: { configured: !!google?.configured },
      bingSearch: { configured: !!bing?.configured },
      apifyActor: { configured: !!apify?.configured },
      legacyPortalScraper: { configured: !!legacyPortal?.configured },
    },
    connectorsList,
    recommendation: !tavily?.configured
      ? 'Tavily is the strongly-recommended primary web research connector — set TAVILY_API_KEY and TAVILY_SEARCH_ENABLED=true. Bing Web Search is a good fallback if Google Custom Search 403s.'
      : (!bing?.configured && !apify?.configured
        ? 'Bing Web Search is a quick fallback if Google Custom Search fails or is unavailable — set BING_SEARCH_API_KEY. Apify is an alternative if you have an actor configured.'
        : null),
    dubai: { available: dubaiConnectors.length > 0, connectorNames: dubaiConnectors.map(c => c.name) },
    all: status.connectors,
  })
})

// Soft-match our real scraped projects against extracted filters, so we hand the
// ranking model a focused (but not over-pruned) candidate set. Nothing is hard-
// excluded on budget/possession — the LLM decides stretch vs excluded.
function candidatesForFilters(f) {
  const locs = (f.location || []).map(s => String(s).toLowerCase()).filter(Boolean)
  const cfg  = (f.configuration || '').match(/\d+/)?.[0]
  let list = cache.projects
  if (locs.length) {
    const hit = list.filter(p => {
      const hay = `${p.city} ${p.location} ${p.name}`.toLowerCase()
      return locs.some(l => hay.includes(l))
    })
    if (hit.length >= 3) list = hit // only narrow by location if it yields enough
  }
  if (cfg) {
    const c = list.filter(p => (p.config || '').includes(cfg))
    if (c.length >= 3) list = c
  }
  return list.slice(0, 40)
}

// Turn extracted filters into a web-search query for project discovery.
// Deterministic check: is a project's possession date already in the past
// (i.e. it's a completed/delivered project, not an active under-construction
// listing)? Parses common formats: "Dec 2024", "October 2026", "Q4 2025",
// a bare year, or phrases like "ready to move"/"completed"/"possession given".
// Compared against the real current date so search results don't quietly show
// stale, already-delivered inventory as if it were a fresh match.
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*'
function possessionStatus(text) {
  if (!text) return { status: 'unknown' }
  const t = String(text).toLowerCase().trim()
  const now = new Date()

  if (/ready to move|possession given|completed|delivered|already possession/.test(t)) {
    return { status: 'delivered', note: 'Ready to move / possession already given' }
  }

  const monthYear = t.match(new RegExp(`${MONTH_RE}\\.?\\s+(\\d{4})`))
  if (monthYear) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    const mIdx = months.findIndex(m => monthYear[1].startsWith(m))
    const year = parseInt(monthYear[2], 10)
    const target = new Date(year, mIdx + 1, 0) // end of that month
    return target < now
      ? { status: 'delivered', note: `Possession was ${monthYear[0]} — already passed` }
      : { status: 'upcoming', note: `Possession ${monthYear[0]}` }
  }

  const quarterYear = t.match(/q([1-4])\s*[\/\-]?\s*(\d{4})/)
  if (quarterYear) {
    const year = parseInt(quarterYear[2], 10)
    const target = new Date(year, parseInt(quarterYear[1], 10) * 3, 0)
    return target < now
      ? { status: 'delivered', note: `Possession was ${quarterYear[0].toUpperCase()} — already passed` }
      : { status: 'upcoming', note: `Possession ${quarterYear[0].toUpperCase()}` }
  }

  const bareYear = t.match(/\b(20\d{2})\b/)
  if (bareYear) {
    const year = parseInt(bareYear[1], 10)
    if (year < now.getFullYear()) return { status: 'delivered', note: `Possession year ${year} has passed` }
    if (year > now.getFullYear()) return { status: 'upcoming', note: `Possession ${year}` }
    return { status: 'upcoming', note: `Possession within ${year}` }
  }

  return { status: 'unknown' }
}

// AI Search — external (non-IndiHomes) properties only, via Azure AI Search
// (external-search.cjs), never Claude. Short-lived cache of the query context
// so "load more" can keep paging through the same Azure query.
const searchReportCache = new Map()
function cacheSearchContext(query, filters, market) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  searchReportCache.set(id, { query, filters, market, skip: 0, ts: Date.now() })
  for (const [k, v] of searchReportCache) if (Date.now() - v.ts > 10 * 60 * 1000) searchReportCache.delete(k)
  return id
}

// ── AI Search Agent (LangGraph) delegation ──────────────────────────────────
// LANGGRAPH_ENABLED=true routes AI Search through the Python agent service
// (ai-search-agent/, a real multi-node research pipeline — see its README)
// instead of the single-pass external-search.cjs path below. Feature-
// flagged and fully backward compatible: the flag defaults unset/false, in
// which case this route behaves EXACTLY as it did before this file was
// touched, byte-for-byte — and even with the flag on, any agent failure
// (service down, timeout, bad response) falls straight through to that
// same existing path rather than erroring the request. This is what Part
// 28 ("production safety... fail gracefully") means in practice: a broken
// or not-yet-started agent service can never make AI Search worse than it
// already was.
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://localhost:8008'
const AGENT_TIMEOUT_MS = parseInt(process.env.AI_SEARCH_TIMEOUT_MS, 10) || 45000

async function queryAgent(query, market) {
  const res = await fetch(`${AGENT_SERVICE_URL}/agent/ai-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, market }),
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Agent service HTTP ${res.status}`)
  return res.json()
}

// Adapts the agent's richer property shape onto the SAME field names the
// existing frontend (RankedResults/toAnalysableProject in
// ProjectSelection.jsx) already reads (match_score/why/sources/etc), so
// nothing downstream needs to change to keep working — the new fields
// (match_tier/match_reasons/key_match/limitations/project_intelligence) are
// additive, read by the new card UI, ignored by anything that doesn't know
// about them yet.
function adaptAgentProperty(p) {
  return {
    id: p.id,
    // display_name is the LLM curator's cleaned-up presentational label
    // (only set when the curator actually ran and judged the raw title to
    // be generic portal SEO text, not a real project name) — preferred
    // when present; name (the real, original scraped title) is always kept
    // too, never overwritten, so nothing is lost even when display_name is
    // absent (no LLM configured) or imperfect.
    name: p.display_name || p.name, rawName: p.name, developer: p.developer, location: p.location,
    // Missing before: NearbyMap's fallback geocode query is [locality, city]
    // — without a real city here, a small locality Nominatim can't resolve
    // on its own (e.g. "Daulat Nagar") had zero geographic context left to
    // fall back on, which is why the Location Map/Nearby Infrastructure/
    // Location Quality Score/Competing Projects cards all failed together
    // for a perfectly real, existing address. Sourced from the agent's own
    // gazetteer-based city resolution (see normalize.py's derive_city()).
    city: p.city || null,
    config: Array.isArray(p.configuration) ? p.configuration.join(' & ') : p.configuration,
    price: p.price, possession: p.possession,
    rera: p.rera, rera_verified: null,
    sourceName: p.sources?.[0]?.name || null, sourceUrl: p.sources?.[0]?.url || null,
    sources: p.sources || [],
    match_score: p.match_score, why: (p.match_reasons || []).join(' · ') || p.key_match || '',
    match_tier: p.match_tier, match_reasons: p.match_reasons, key_match: p.key_match,
    limitations: p.limitations, project_intelligence: p.project_intelligence,
    // ── Deep-research pipeline additions — additive only, every field
    // above is untouched. Populated once the agent's deep_research/
    // fact_extraction pass has actually fetched+read a page for this
    // candidate; null/[] (never fabricated) when it hasn't. See
    // curator.py's final_response.properties for exactly what each of
    // these maps from.
    propertyType: p.propertyType || null,
    carpetArea: p.carpetAreaDisplay || null, builtUpArea: p.builtUpArea || null,
    pricePerSqFt: p.pricePerSqFt || null, projectStatus: p.projectStatus || null,
    totalFloors: p.totalFloors || null, towerCount: p.towerCount || null,
    connectivity: p.connectivity || null, nearbyLandmarks: p.nearbyLandmarks || [],
    amenities: p.amenities || [], deck: p.deck || null, description: p.description || null,
    warnings: p.warnings || [], evidence: p.evidence || [], dataQuality: p.dataQuality || null,
    // ── Candidate-handoff fields (Part P1.3/P1.7) — additive. Carries the
    // raw structured evidence Project Intelligence needs to render THIS
    // exact candidate without re-deriving or re-searching anything:
    // per-field provenance/conflicts, per-configuration facts (never a
    // 1 BHK price under a 2 BHK row), and per-feature scope evidence
    // (unit vs project-level deck/balcony/parking). title/projectName are
    // stable aliases for the candidate's own name — used as the display
    // title regardless of which pipeline (LangGraph vs the legacy
    // external-search.cjs path) produced this result.
    title: p.title || p.display_name || p.name, projectName: p.projectName || p.name,
    field_evidence: p.field_evidence || {}, configuration_evidence: p.configuration_evidence || {},
    featureEvidence: p.featureEvidence || [], sourceType: p.sourceType || 'external',
    // Deterministic lifecycle classification (Part 2/20-22) — passed
    // through untouched from curator.py's final_response.properties.
    lifecycleStatus: p.lifecycleStatus || null, lifecycleEvidence: p.lifecycleEvidence || null,
  }
}

app.post('/api/ai-search', async (req, res) => {
  const { query } = req.body || {}
  const market = req.body?.market === 'dubai' ? 'dubai' : 'india'
  if (!query) return res.status(400).json({ error: 'query required' })

  if (process.env.LANGGRAPH_ENABLED === 'true') {
    try {
      const agentResult = await queryAgent(query, market)
      const properties = (agentResult.properties || []).map(adaptAgentProperty)
      const reportId = cacheSearchContext(query, {}, market)
      const ctx = searchReportCache.get(reportId)
      ctx.skip = properties.length

      try { db.logSearch({ mode: 'ai-search-agent', query, filters: null, resultCount: properties.length }) }
      catch (e) { console.error('[ai-search] history log failed:', e.message) }

      return res.json({
        filters: {}, reportId, market, configured: true, enabled: true,
        properties, sources: [], warning: null,
        summary: agentResult.summary, citations: agentResult.citations,
        research_metadata: agentResult.research_metadata,
        // Dev-only debug trace (Part 27) — present only when the AGENT
        // process itself has AI_SEARCH_DEBUG_TRACE=true set (curator.py's
        // own gate); undefined/omitted here otherwise, so a production
        // deployment that never sets that env var on the agent service
        // never has this key in the response at all.
        debug_trace: agentResult.debug_trace,
        _agent: true,
      })
    } catch (e) {
      console.error('[ai-search] agent service unavailable, falling back to external-search.cjs:', e.message)
      // Deliberately no error surfaced to the client here — fall through to
      // the existing path below exactly as if LANGGRAPH_ENABLED were unset.
    }
  }

  try {
    const filters = queryParser.parseExternalQuery(query, market)
    // Explicit location chips from the AI Search UI's LocationCombobox (same
    // component/gazetteer Property Search uses) — more reliable than only
    // re-parsing a location out of the free-text query, since a locality
    // picked from the combobox is already gazetteer-resolved (e.g. "Gawamin"
    // arrives already meaning Vasai-Virar). Merged with, not replacing,
    // whatever extractLocations() found in the query text itself.
    const explicitLocations = Array.isArray(req.body?.filters?.locations) ? req.body.filters.locations.filter(Boolean) : []
    if (explicitLocations.length) {
      filters.locations = [...new Set([...explicitLocations, ...(filters.locations || [])])]
    }
    const result = await externalSearch.queryExternal(query, filters, market, { skip: 0, top: 20 })
    const reportId = cacheSearchContext(query, filters, market)
    const ctx = searchReportCache.get(reportId)
    ctx.skip = result.properties.length

    try { db.logSearch({ mode: 'ai-search', query, filters, resultCount: result.properties.length }) }
    catch (e) { console.error('[ai-search] history log failed:', e.message) }

    res.json({
      filters, reportId, market,
      configured: result.configured, enabled: result.enabled,
      properties: result.properties,
      sources: [],
      warning: result.message || null,
      // Per-connector pass/fail detail (which source failed, its raw error)
      // stays server-log-only (console.warn in external-search.cjs) — never
      // forwarded to the client. `warning` above is already sanitized to a
      // generic sentence for the "everything failed" case.
      // Dev-only debug trace (Part 27) — present only when THIS server
      // process has AI_SEARCH_DEBUG_TRACE=true set; undefined otherwise.
      debug_trace: result.debug_trace,
    })
  } catch (e) {
    console.error('[ai-search] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// "Load more" — pages further into the same Azure external-index query.
app.post('/api/ai-search-more', async (req, res) => {
  const { reportId, excludeNames } = req.body || {}
  const ctx = reportId && searchReportCache.get(reportId)
  if (!ctx) return res.status(404).json({ error: 'This search has expired — please search again.' })
  try {
    const result = await externalSearch.queryExternal(ctx.query, ctx.filters, ctx.market, { skip: ctx.skip, top: 20 })
    const excludeLower = new Set((excludeNames || []).map(n => String(n).toLowerCase()))
    const fresh = result.properties.filter(p => !excludeLower.has(String(p.name || '').toLowerCase()))
    ctx.skip += result.properties.length
    ctx.ts = Date.now()

    try { db.logSearch({ mode: 'ai-search', query: `${ctx.query} (load more)`, filters: ctx.filters, resultCount: fresh.length }) }
    catch (e) { console.error('[ai-search-more] history log failed:', e.message) }

    res.json({ properties: fresh, sources: [], warning: result.message || null })
  } catch (e) {
    console.error('[ai-search-more] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Filter Search runs entirely client-side over the cached /api/projects list —
// this lets the frontend record what filters were applied so that activity
// still shows up in the shared search history alongside AI Search queries.
app.post('/api/log-filter-search', (req, res) => {
  const { filters, resultCount } = req.body || {}
  try {
    db.logSearch({ mode: 'filter-search', query: null, filters, resultCount })
    res.json({ ok: true })
  } catch (e) {
    console.error('[log-filter-search] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Deterministic, explainable scoring (brief rule 5) — no Claude/LLM anywhere
// in Filter Search (brief rule 3 bans it from property searching entirely).
// Response shape kept identical to the old Claude-ranked version so the
// frontend needs no changes: primary/secondary/stretch/excluded buckets with
// a score + one-line "why" per project.
app.post('/api/filter-rank', (req, res) => {
  const { filters, candidates } = req.body || {}
  if (!Array.isArray(candidates) || !candidates.length) return res.status(400).json({ error: 'candidates required' })
  try {
    const canonicalFilters = scoring.filtersFromBuckets(filters || {})
    const buckets = { primary_matches: [], secondary_matches: [], stretch_matches: [], excluded_projects: [] }
    for (const c of candidates.slice(0, 40)) {
      const { score, reasons } = scoring.scoreIndiHomesProject(c, canonicalFilters)
      const entry = { name: c.name, match_score: score, why: reasons.join(' · ') || 'No filters applied' }
      if (score >= 80) buckets.primary_matches.push(entry)
      else if (score >= 60) buckets.secondary_matches.push(entry)
      else if (score >= 40) buckets.stretch_matches.push(entry)
      // Keep the real score here too (was previously dropped, forcing the
      // frontend to display a hardcoded 0 for every excluded project
      // regardless of how close it actually came) — a 35-point near-miss
      // and a genuine 0 look identical without it.
      else buckets.excluded_projects.push({ name: c.name, match_score: score, why: entry.why, reason: entry.why })
    }
    res.json({ executive_summary: '', ...buckets })
  } catch (e) {
    console.error('[filter-rank] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// "NL search is not a different search engine — it's a translation step in
// front of the same one." Deterministic regex extraction (query-parser.cjs)
// instead of Claude, per rule 3 — points the output at Filter Search's own
// controls, so "2 BHK in Thane under 1.5cr" fills in Location/Budget/
// Configuration/Possession and the existing local filtering + Azure facets
// take it from there.
app.post('/api/nl-filters', (req, res) => {
  const { query } = req.body || {}
  if (!query || !query.trim()) return res.status(400).json({ error: 'query required' })
  try {
    const f = queryParser.parseNLQuery(query)
    const cr = f.budget_max_cr
    const budget = cr == null ? 'All' : cr <= 0.75 ? 'Under 75L' : cr <= 1.5 ? '75L–1.5Cr' : 'Above 1.5Cr'
    const configMatch = (f.configuration || '').match(/(\d)\s*BHK/i)
    const yr = parseInt((f.possession || '').match(/20\d\d/)?.[0])
    const possession = /ready/i.test(f.possession || '') ? 'All' // "ready to move" has no direct bucket; leave unfiltered rather than guess wrong
      : yr ? (yr <= 2026 ? 'By 2026' : yr <= 2027 ? 'By 2027' : '2028+') : 'All'
    res.json({
      locations: Array.isArray(f.location) ? f.location : [],
      budget,
      configs: configMatch ? [`${configMatch[1]} BHK`] : [],
      possession,
      amenities: Array.isArray(f.amenities) ? f.amenities : [],
    })
  } catch (e) {
    console.error('[nl-filters] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Shared search history — every AI Search and Filter Search anyone has run,
// persisted in the same SQLite volume as everything else so it survives
// reloads and redeploys, not just the current browser tab's session.
app.get('/api/search-history', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100))
  try {
    res.json({ history: db.listSearchHistory(limit) })
  } catch (e) {
    console.error('[search-history] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Lead Capturing (timeline row 7) — universal intake + identification ────────
// One endpoint for every source (Meta, website, Housing.com, 99acres,
// MagicBricks, referral, walk-in): normalize the source's payload shape,
// identify the real person by phone number, and merge into one canonical
// lead rather than creating a duplicate per channel they came in through.

// projectCode is required by the official createLead endpoint but nothing
// upstream (Meta/Housing/manual entry) carries an IndiHomes project code
// directly — resolve it best-effort from the project NAME against the live
// Filter Search catalog. Omitted (not guessed) when there's no match.
function resolveProjectCode(projectName) {
  if (!projectName) return null
  const hit = cache.projects.find(p => (p.name || '').toLowerCase() === String(projectName).toLowerCase())
  return hit?.code || null
}

// Pushes a lead to the official IndiHomes CRM (createLead) — the ONLY write
// path to IndiHomes' own system of record; never Cosmos, never any other
// external DB. No-ops silently when INDIHOMES_LEAD_PUSH_ENABLED isn't 'true'.
// Skips leads already pushed successfully (crm_status==='success') so a
// re-touch (hourly poll re-fetching the same lead, a duplicate webhook
// delivery) doesn't re-push — but a previously FAILED push is retried
// automatically the next time that lead is touched by any source, which is
// the "keep the lead locally and mark it unsynced" retry behavior.
async function maybePushLeadToCrm(lead, normalized = {}) {
  if (!indihomesLeadsClient.isEnabled()) return
  if (lead.crm_status === 'success') return
  try {
    await indihomesLeadsClient.createLead({
      name: lead.name, phone: lead.phone, email: lead.email,
      configuration: lead.configuration, projectCode: resolveProjectCode(lead.project),
      budget: lead.budget, location: lead.location, notes: lead.notes || normalized.notes,
      targetPossessionDate: normalized.targetPossessionDate, userType: normalized.userType,
      source: lead.primary_source,
    })
    db.recordCrmPush(lead.id, { status: 'success' })
    console.log(`[crm-push] lead ${lead.id} (${lead.phone}) pushed to IndiHomes CRM`)
  } catch (e) {
    console.error(`[crm-push] lead ${lead.id} failed:`, e.message)
    try { db.recordCrmPush(lead.id, { status: 'failed', error: e.message }) } catch (_) {}
  }
}

app.post('/api/leads', async (req, res) => {
  const { source, leadData } = req.body || {}
  if (!source || !leadData) return res.status(400).json({ error: 'source and leadData required' })
  try {
    const projectCatalog = cache.projects.map(p => p.name).filter(Boolean)
    const normalized = leadIntake.normalizeLead(source, leadData, projectCatalog)
    if (!normalized.phone) return res.status(422).json({ error: 'Could not identify a valid phone number in leadData — phone is the dedup key and is required.' })
    const { lead, isDuplicate } = db.intakeLead({ ...normalized, rawPayload: leadData })
    await maybePushLeadToCrm(lead, normalized)
    res.json({ lead: db.getLeadById(lead.id) || lead, isDuplicate, matchedProject: normalized.project || null })
  } catch (e) {
    console.error('[leads intake] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Generic website-form intake — accepts the form's fields directly (not
// wrapped in {source,leadData}) so a plain HTML/JS contact form on the
// IndiHomes website can POST straight to this without any client-side
// reshaping. Always source:'website', labeled "IndiHomes Website" in the UI.
app.post('/api/leads/intake/website', async (req, res) => {
  const payload = req.body || {}
  if (!Object.keys(payload).length) return res.status(400).json({ error: 'request body required' })
  try {
    const projectCatalog = cache.projects.map(p => p.name).filter(Boolean)
    const normalized = leadIntake.normalizeLead('website', payload, projectCatalog)
    if (!normalized.phone) return res.status(422).json({ error: 'Could not identify a valid phone number — phone is the dedup key and is required.' })
    const { lead, isDuplicate } = db.intakeLead({ ...normalized, rawPayload: payload })
    await maybePushLeadToCrm(lead, normalized)
    res.json({ lead: db.getLeadById(lead.id) || lead, isDuplicate, matchedProject: normalized.project || null })
  } catch (e) {
    console.error('[leads/intake/website] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/leads', (req, res) => {
  const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit, 10) || 200))
  try {
    res.json({ leads: db.listLeads(limit) })
  } catch (e) {
    console.error('[leads list] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/leads/:id', (req, res) => {
  try {
    db.deleteLead(parseInt(req.params.id, 10))
    res.json({ ok: true })
  } catch (e) {
    console.error('[lead delete] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/leads/:id/touches', (req, res) => {
  try {
    res.json({ touches: db.getLeadTouches(parseInt(req.params.id, 10)) })
  } catch (e) {
    console.error('[lead touches] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Lead detail view — inline field edits, audited. Restricted server-side to
// EDITABLE_LEAD_FIELDS regardless of what the request body sends (name,
// phone, created_at, crm_status can never be changed through this route —
// phone is the dedup key, crm_status is CRM-push-driven, not a manual field).
//
// status/sub_status go through the qualification-aware path
// (db.updateLeadQualification), not the generic per-field loop below - see
// qualification.cjs and db.cjs's updateLeadQualification docstring for why
// a blind UPDATE would bypass the human-lock rule. Every other field still
// goes through db.updateLeadFields exactly as before.
app.patch('/api/leads/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  const fields = { ...(req.body || {}) }
  const rejected = Object.keys(fields).filter(k => !db.EDITABLE_LEAD_FIELDS.includes(k))

  const hasQualificationFields = 'status' in fields || 'sub_status' in fields
  let qualResult = null
  if (hasQualificationFields) {
    const existing = db.getLeadById(id)
    if (!existing) return res.status(404).json({ error: 'Lead not found' })
    const nextStatus = 'status' in fields ? fields.status : existing.status
    // A status-only change (e.g. the header StatusEditor, which never sends
    // sub_status) must not silently carry forward a sub_status that belonged
    // to the OLD status and isn't valid for the new one (e.g. "Ringing" —
    // valid under "Contacted" — surviving a change to "Qualified", where
    // it isn't one of the real options). qualification.cjs's
    // isValidSubStatus() already existed for exactly this check but was
    // never actually called anywhere — wired in here rather than left
    // dead. An EXPLICIT sub_status in this same request (e.g. the Sub
    // Status dropdown, which always sends status+sub_status together)
    // from the SAME status's own taxonomy is trusted as-is — it can only
    // ever be a value the UI itself offered for that exact status.
    const nextSubStatus = ('sub_status' in fields)
      ? fields.sub_status
      : (qualification.isValidSubStatus(nextStatus, existing.sub_status) ? existing.sub_status : null)
    qualResult = db.updateLeadQualification(id, {
      status: nextStatus,
      subStatus: nextSubStatus,
      source: 'human', // this route is always a human editing in the UI
    })
    delete fields.status
    delete fields.sub_status
    if (!qualResult.applied) {
      // Should not happen from this route (source is always 'human', which
      // is never refused by the lock) — defensive only.
      return res.status(409).json({ error: qualResult.reason, lead: qualResult.lead })
    }
  }

  try {
    const result = db.updateLeadFields(id, fields)
    if (!result && !qualResult) return res.status(404).json({ error: 'Lead not found' })
    const lead = result ? result.lead : qualResult.lead
    const changed = [...(qualResult ? qualResult.changed : []), ...(result ? result.changed : [])]

    // Hot-path Meta CAPI dispatch — fire-and-forget, best-effort, never
    // blocks the response. The hourly runMetaCapiSync() sweep (see below)
    // is the cold-path safety net if this fails or the process restarts
    // mid-flight.
    if (qualResult && qualResult.applied && changed.includes('qualification')) {
      leadEvents.dispatchQualificationToMeta(lead).catch(e =>
        console.error('[server] hot-path Meta CAPI qualification dispatch failed:', e.message))
    }

    res.json({ lead, changed, rejected })
  } catch (e) {
    console.error('[lead update] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/leads/:id/edits', (req, res) => {
  try {
    res.json({ edits: db.getLeadEdits(parseInt(req.params.id, 10)) })
  } catch (e) {
    console.error('[lead edits] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Follow-up notes — logged through the same append-only lead_edits table as
// the field-edit audit trail (field='follow_up'), not a new table: a
// follow-up is conceptually just another dated entry in the same activity
// history, and lead_edits already has exactly that shape (old_value/
// new_value/edited_at, already rendered by the Activity feed). No leads
// column is touched or overwritten — a follow-up is purely additive, unlike
// EditableField's overwrite-in-place edits.
app.post('/api/leads/:id/follow-up', (req, res) => {
  const id = parseInt(req.params.id, 10)
  const note = String(req.body?.note || '').trim()
  if (!note) return res.status(400).json({ error: 'note required' })
  try {
    const lead = db.getLeadById(id)
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    db.logLeadEdit(id, 'follow_up', null, note, null)
    res.json({ ok: true, edits: db.getLeadEdits(id) })
  } catch (e) {
    console.error('[lead follow-up] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// WhatsApp Bot / AI Calling Agent conversation drill-down — STUBS. Neither
// data source exists yet: no external database or API for WhatsApp/call
// transcripts is wired into this app today (both are separate sidebar
// modules with no lead-level pipeline into this table — same gap the
// whatsapp_summary/call_summary columns already document). Returns an
// honest "not connected" shape rather than an error or fabricated data, so
// the frontend's empty state renders cleanly.
//
// TODO(whatsapp-conversation): once a real WhatsApp Business API / bot
// transcript store exists, this should return
// { connected: true, messages: [{ direction: 'in'|'out', text, at }] }
// ordered oldest-first, sourced by whatever keys a WhatsApp conversation to
// this lead (phone number is the obvious join key, same as everywhere else
// in this app's lead-identification model).
app.get('/api/leads/:id/whatsapp-conversation', (req, res) => {
  res.json({ connected: false, messages: [] })
})

// TODO(call-transcript): once a real AI Calling Agent transcript/recording
// store exists, this should return
// { connected: true, transcript: [{ speaker: 'agent'|'lead', text, at }], recordingUrl }
// sourced by phone number, same as the WhatsApp stub above.
app.get('/api/leads/:id/call-transcript', (req, res) => {
  res.json({ connected: false, transcript: null })
})

// Wraps a source's sync function so every attempt — manual or hourly poll,
// success or failure — is recorded to sync_runs. This is what powers Lead
// Capture's "connected / last success / last failure" status strip, which
// today only finds out sync health transiently, on click.
async function runTrackedSync(source, fn) {
  try {
    const summary = await fn()
    try { db.recordSyncRun(source, { status: 'success', fetched: summary.fetched, created: summary.created, duplicates: summary.duplicates }) }
    catch (e) { console.error('[sync-status] record failed:', e.message) }
    return summary
  } catch (e) {
    try { db.recordSyncRun(source, { status: 'failure', error: e.message }) }
    catch (_) {}
    throw e
  }
}

// Pull-sync from Housing.com's builder-leads API and run every fetched lead
// through the same normalize -> dedup intake as manual POSTs. Called manually
// (POST with optional {startDate, endDate}) and by the hourly poll below.
async function syncHousingLeads(startDate, endDate) {
  const raw = await housingClient.getLeads({
    startDate: startDate || new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: endDate || new Date(),
  })
  const projectCatalog = cache.projects.map(p => p.name).filter(Boolean)
  const summary = { fetched: raw.length, created: 0, duplicates: 0, skipped: 0 }
  for (const item of raw) {
    const normalized = leadIntake.normalizeLead('housing', item, projectCatalog)
    if (!normalized.phone) { summary.skipped++; continue }
    const { lead, isDuplicate } = db.intakeLead({ ...normalized, rawPayload: item })
    isDuplicate ? summary.duplicates++ : summary.created++
    await maybePushLeadToCrm(lead, normalized)
  }
  return summary
}

app.post('/api/leads/sync-housing', async (req, res) => {
  if (!housingClient.isConfigured()) return res.status(503).json({ error: 'HOUSING_API_KEY / HOUSING_USER_ID not set on the server' })
  try {
    const { startDate, endDate } = req.body || {}
    res.json(await runTrackedSync('housing', () => syncHousingLeads(startDate, endDate)))
  } catch (e) {
    console.error('[sync-housing] error:', e.message, e.details || '')
    res.status(502).json({ error: e.message, details: e.details || null })
  }
})

// Hourly background poll — Housing's API is pull-only (no webhook), so this
// is what makes leads flow in without anyone pressing a button. 24h lookback
// per pass; dedup makes re-fetching the same lead across passes harmless.
if (housingClient.isConfigured()) {
  setInterval(() => {
    runTrackedSync('housing', () => syncHousingLeads()).then(s => {
      if (s.created) console.log(`[sync-housing] hourly poll: ${s.created} new, ${s.duplicates} duplicate, ${s.skipped} skipped`)
    }).catch(e => console.error('[sync-housing] hourly poll failed:', e.message))
  }, 60 * 60 * 1000)
}

// Pull-sync from Meta's Graph API — backfills whatever's already sitting in
// each lead form (the webhook below only ever sees leads from the moment
// it's subscribed onward). Each form IS one project (see meta-client.cjs
// comment), so the form's own name feeds normalizeMeta as the project.
async function syncMetaLeads(sinceDate) {
  // sinceDate='2020-01-01' is the UI's "fetch everything" sentinel — pass 0
  // so listLeadsForForm skips the Graph API time filter entirely.
  const isFullBackfill = !sinceDate || sinceDate <= '2020-01-02'
  const sinceEpoch = isFullBackfill
    ? 0
    : Math.floor(new Date(sinceDate).getTime() / 1000)
  const forms = await metaClient.listForms()
  const projectCatalog = cache.projects.map(p => p.name).filter(Boolean)
  const summary = { formsChecked: forms.length, fetched: 0, created: 0, duplicates: 0, skipped: 0 }
  for (const form of forms) {
    let leads
    try { leads = await metaClient.listLeadsForForm(form.id, sinceEpoch) }
    catch (e) { console.error(`[sync-meta] form ${form.name} failed:`, e.message); continue }
    summary.fetched += leads.length
    // Form names carry noise ("Lead Gen", locality suffixes, "-copy") around
    // the actual project — try matching the real catalog first, and only
    // fall back to the raw (stripped) form name if nothing matches.
    const strippedFormName = form.name.replace(/\b(lead\s*gen|eoi|new|new\s*\d*|-?copy)\b/gi, '').replace(/\s+/g, ' ').trim()
    const formProject = leadIntake.matchProjectFromText(form.name, projectCatalog) || strippedFormName
    for (const item of leads) {
      // form_id isn't in the Graph API's per-lead field list (implicit from
      // this /{form_id}/leads call) — injected here so normalizeMeta can
      // still record it; ad_id/campaign_id DO come through on `item` itself
      // (added to meta-client.cjs's leads fields query).
      const normalized = leadIntake.normalizeLead('meta', { ...item, _formName: formProject, _formId: form.id }, projectCatalog)
      if (!normalized.phone) { summary.skipped++; continue }
      const { lead, isDuplicate } = db.intakeLead({ ...normalized, rawPayload: item })
      isDuplicate ? summary.duplicates++ : summary.created++
      await maybePushLeadToCrm(lead, normalized)
    }
  }
  return summary
}

app.post('/api/leads/sync-meta', async (req, res) => {
  if (!metaClient.isConfigured()) return res.status(503).json({ error: 'META_PAGE_ACCESS_TOKEN not set on the server' })
  try {
    const { sinceDate } = req.body || {}
    res.json(await runTrackedSync('meta', () => syncMetaLeads(sinceDate)))
  } catch (e) {
    console.error('[sync-meta] error:', e.message, e.details || '')
    res.status(502).json({ error: e.message, details: e.details || null })
  }
})

// Hourly background poll, same pattern as Housing — belt-and-suspenders
// alongside the webhook in case a subscription lapses or a lead lands before
// the webhook is turned on in the Meta App Dashboard.
if (metaClient.isConfigured() && process.env.META_PAGE_ID) {
  setInterval(() => {
    runTrackedSync('meta', () => syncMetaLeads()).then(s => {
      if (s.created) console.log(`[sync-meta] hourly poll: ${s.created} new, ${s.duplicates} duplicate, ${s.skipped} skipped across ${s.formsChecked} forms`)
    }).catch(e => console.error('[sync-meta] hourly poll failed:', e.message))
  }, 60 * 60 * 1000)
}

// ── Meta Conversions API reporting — backend-only job, no UI ────────────────
// For every Meta-sourced lead with a RESOLVED crm_status (success or failed
// — 'not_pushed' means no decision has been made yet, nothing to report),
// reports that real outcome to Meta via CAPI. Idempotent: a crm_status value
// already reported successfully is never re-sent (db.hasSuccessfulCapiSend),
// but a genuine transition (e.g. a failed push later retried and succeeding)
// sends a fresh event — that's real new information. One lead failing here
// never stops the batch (each is independently try/caught and logged).
async function runMetaCapiSync() {
  if (!metaCapi.isConfigured()) throw new Error('META_CAPI_ACCESS_TOKEN / META_DATASET_ID not set')
  const metaLeads = db.listLeads(5000).filter(l => l.primary_source === 'meta')
  const summary = { checked: metaLeads.length, sent: 0, failed: 0, skipped: 0 }
  for (const lead of metaLeads) {
    if (lead.crm_status !== 'success' && lead.crm_status !== 'failed') { summary.skipped++; continue }
    if (db.hasSuccessfulCapiSend(lead.id, lead.crm_status)) { summary.skipped++; continue }
    try {
      const metaLeadgenId = db.getMetaLeadgenId(lead.id)
      const result = await metaCapi.sendEvent(lead, { metaLeadgenId })
      if (result.skipped) { summary.skipped++; continue }
      db.recordMetaCapiSend(lead.id, {
        eventId: result.eventId, crmStatus: lead.crm_status,
        status: result.ok ? 'success' : 'failed',
        httpStatus: result.httpStatus, responseBody: result.responseBody,
      })
      result.ok ? summary.sent++ : summary.failed++
      if (!result.ok) console.error(`[meta-capi] lead ${lead.id} send failed:`, result.error)
    } catch (e) {
      summary.failed++
      console.error(`[meta-capi] lead ${lead.id} error:`, e.message)
      try { db.recordMetaCapiSend(lead.id, { eventId: String(lead.id), crmStatus: lead.crm_status, status: 'failed', httpStatus: null, responseBody: e.message }) } catch (_) {}
    }
  }
  // Cold-path safety net for qualification events — the hot-path dispatch
  // in PATCH /api/leads/:id fires on every human write, but this catches
  // anything that failed, or happened while the process was down.
  // dispatchQualificationToMeta already scopes to primary_source==='meta'
  // and is idempotent (db.hasSuccessfulCapiSend), so re-running this sweep
  // is always safe.
  for (const lead of metaLeads) {
    if (lead.qualification === 'unknown') continue
    try {
      const result = await leadEvents.dispatchQualificationToMeta(lead)
      if (!result.skipped) result.ok ? summary.sent++ : summary.failed++
    } catch (e) {
      console.error(`[meta-capi] qualification sync for lead ${lead.id} error:`, e.message)
    }
  }
  return summary
}

// Manual/scheduled trigger — no UI button exists for this on purpose (per
// spec); call it directly (curl / a cron hitting this endpoint) or rely on
// the hourly interval below.
app.post('/api/leads/sync-meta-capi', async (req, res) => {
  if (!metaCapi.isConfigured()) return res.status(503).json({ error: 'META_CAPI_ACCESS_TOKEN / META_DATASET_ID not set on the server' })
  try {
    res.json(await runMetaCapiSync())
  } catch (e) {
    console.error('[sync-meta-capi] error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

if (metaCapi.isConfigured()) {
  setInterval(() => {
    runMetaCapiSync().then(s => {
      if (s.sent) console.log(`[meta-capi] hourly run: ${s.sent} sent, ${s.failed} failed, ${s.skipped} skipped/up-to-date`)
    }).catch(e => console.error('[meta-capi] hourly run failed:', e.message))
  }, 60 * 60 * 1000)
}

// Everything the Lead Capture screen needs to show connection/health status
// per source, plus recent sync history — replaces the current "only find out
// on click" pattern with an always-visible status strip.
app.get('/api/leads/sync-status', (_req, res) => {
  try {
    res.json({
      housing: {
        configured: housingClient.isConfigured(),
        missingEnv: housingClient.isConfigured() ? [] : ['HOUSING_API_KEY', 'HOUSING_USER_ID'].filter(k => !process.env[k]),
        ...db.getSyncStatus('housing'),
      },
      meta: {
        configured: metaClient.isConfigured(),
        missingEnv: metaClient.isConfigured() ? [] : ['META_PAGE_ACCESS_TOKEN'].filter(k => !process.env[k]),
        ...db.getSyncStatus('meta'),
      },
      website: {
        configured: true,
        description: 'IndiHomes website leads land automatically via POST /api/leads/intake/website (or POST /api/leads with source="website") — no credentials needed.',
      },
      // Official IndiHomes CRM push (createLead) — separate from the three
      // sources above, which are about leads coming IN. This is about leads
      // going OUT to IndiHomes' own system of record.
      crm: (() => {
        const cfg = indihomesLeadsClient.getConfig()
        const summary = db.getCrmPushSummary()
        return {
          enabled: cfg.enabled,
          description: cfg.enabled
            ? 'Pushing new leads to the official IndiHomes CRM (createLead).'
            : 'CRM push is disabled — leads stay in the local inbox only. Set INDIHOMES_LEAD_PUSH_ENABLED=true to enable.',
          counts: summary.counts,
          lastPush: summary.lastPush,
        }
      })(),
      // Lead-events pipeline (AI Activity tick + Lead Journey tracker on the
      // Lead Capture detail view) — see backend/LEAD_EVENTS_INTEGRATION.md.
      // This router has no external config of its own (it's inbound-only),
      // so "configured" is always true once mounted; sarvamWebhookConfigured
      // reflects whether the OPTIONAL signature check on the voice webhook
      // is set up.
      leadEvents: {
        configured: true,
        sarvamWebhookConfigured: !!process.env.SARVAM_WEBHOOK_SHARED_SECRET,
        description: 'POST /api/lead-events (WhatsApp checkpoints) and POST /api/sarvam-webhook (voice) feed the AI Activity tick and Lead Journey tracker.',
      },
    })
  } catch (e) {
    console.error('[leads/sync-status] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Meta Lead Ads webhook — GET is Meta's one-time subscription verification
// handshake (echo hub.challenge back when the verify token matches); POST
// delivers leadgen events carrying only a leadgen_id, which is exchanged for
// the full lead via the Graph API and fed through the same intake pipeline.
app.get('/api/meta-webhook', (req, res) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || ''
  if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken) {
    return res.send(req.query['hub.challenge'])
  }
  res.sendStatus(403)
})

app.post('/api/meta-webhook', async (req, res) => {
  // Ack immediately — Meta retries (and eventually disables) webhooks that
  // respond slowly; the Graph fetch + intake happen after the response.
  res.sendStatus(200)
  try {
    const leadgenIds = []
    for (const entry of (req.body?.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field === 'leadgen' && change.value?.leadgen_id) leadgenIds.push(change.value.leadgen_id)
      }
    }
    if (!leadgenIds.length) return
    const projectCatalog = cache.projects.map(p => p.name).filter(Boolean)
    for (const id of leadgenIds) {
      try {
        const metaLead = await metaClient.getLead(id)
        const normalized = leadIntake.normalizeLead('meta', { ...metaLead, leadgen_id: id }, projectCatalog)
        if (!normalized.phone) { console.warn(`[meta-webhook] lead ${id} has no valid phone — skipped`); continue }
        const { lead, isDuplicate } = db.intakeLead({ ...normalized, rawPayload: metaLead })
        console.log(`[meta-webhook] lead ${id} ingested (${isDuplicate ? 'duplicate' : 'new'})`)
        await maybePushLeadToCrm(lead, normalized)
      } catch (e) {
        console.error(`[meta-webhook] failed to fetch/ingest lead ${id}:`, e.message)
      }
    }
  } catch (e) {
    console.error('[meta-webhook] handler error:', e.message)
  }
})

// AI Search no longer generates a Claude-authored long-form report — external
// results are a structured list (source URL/name/freshness/confidence per the
// brief), not a synthesized essay. Kept as a route (410, not 404-on-unknown-
// path) so an old cached frontend build gets a clear, explicit reason.
app.post('/api/ai-search-report', (_req, res) => {
  res.status(410).json({ error: 'Full analyst report is not available for external market results.' })
})

// Conversational search ("Option C") was a second live Claude-search path
// (llm.rankProjects + llm.discoverProjectsFromWeb) never wired into any
// frontend screen. Rule 3 bans Claude from property search outright, so
// rather than leave an unused-but-reachable Claude-search route live, it's
// closed here — use Filter Search or AI Search directly instead.
app.post('/api/ai-chat', (_req, res) => {
  res.status(501).json({ error: 'Conversational search has been retired. Use Filter Search (official IndiHomes inventory) or AI Search (external listings) directly.' })
})

// Fill the gaps in scraped intel with live-web research facts. Scraped data
// (exact listing page) wins where present; research fills everything else.
function mergeResearchIntoIntel(intel = {}, r) {
  if (!r) return intel
  const out = { ...intel }
  if (!out.rera && r.rera) out.rera = r.rera
  if (!(out.configs?.length) && r.configs?.length) out.configs = r.configs
  if (!(out.amenities?.length) && r.amenities?.length) out.amenities = r.amenities
  if (!out.description && r.summary) out.description = r.summary
  if ((!out.possession || out.possession === 'TBD') && r.possession) out.possession = r.possession
  if (!out.priceRange && r.price_range) out.priceRange = r.price_range
  if (!out.location && r.location) out.location = r.location
  if (!out.connectivity && r.connectivity) out.connectivity = r.connectivity
  if (!out.nearby && r.nearby) out.nearby = r.nearby
  if (!(out.usps?.length) && r.usps?.length) out.usps = r.usps
  if (!(out.pros?.length) && r.pros?.length) out.pros = r.pros
  if (!(out.cons?.length) && r.cons?.length) out.cons = r.cons
  if (r._allSources?.length) out._webSources = r._allSources.map(s => s.url)
  return out
}

// Project Detail Page — AI due-diligence analysis, grounded in scraped intel
// MERGED with live web research. If neither has real data yet, the web research
// runs right here, in realtime, before the analysis — so due-diligence never
// claims "no data" while the web has it.
const aiAnalyzeCache = {}
app.post('/api/ai-analyze', async (req, res) => {
  const { name, builder, city, refresh } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  if (!llm.isConfigured()) return res.status(503).json({ error: 'AI analysis is not configured yet. Set ANTHROPIC_API_KEY on the server.' })
  const key = `${name}::${builder || ''}`.toLowerCase().replace(/\W/g, '')
  if (refresh) delete aiAnalyzeCache[key]
  if (aiAnalyzeCache[key]) return res.json({ ...aiAnalyzeCache[key], _fromCache: true })
  try {
    const project = cache.projects.find(p => p.name.toLowerCase() === String(name).toLowerCase())
      || { name, builder, city, config: req.body.config, budgetLabel: req.body.priceDisplay, possession: req.body.possession, reraCode: req.body.reraCode, amenities: [], location: '' }
    const intelData = db.getIntel(key)?.data || {}
    let research = researchCache[key] || null

    // No usable data anywhere? Do the web research NOW so the report is real.
    const thin = !(intelData.description || intelData.configs?.length || intelData.amenities?.length || intelData.rera)
    if (!research && thin && webSearchEnabled()) {
      try {
        research = await llm.researchFromWeb({ name, builder, city })
        if (research) researchCache[key] = { ...research, _provider: llm.providerName(), fetchedAt: new Date().toISOString() }
      } catch (e) { console.error('[ai-analyze] inline research failed:', e.message) }
    }

    const merged = mergeResearchIntoIntel(intelData, research)
    const analysis = await llm.dueDiligence(project, merged)
    if (!analysis) return res.status(502).json({ error: 'AI returned no parseable analysis.' })
    const payload = { ...analysis, _provider: llm.providerName(), _usedWebResearch: !!research, fetchedAt: new Date().toISOString() }
    aiAnalyzeCache[key] = payload
    res.json(payload)
  } catch (e) {
    console.error('[ai-analyze] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Surepass RERA Advanced (rera-v2) — authoritative government verification ──
// This is a real check against the RERA registry (via Surepass), not scraped
// or LLM-inferred data. Endpoint confirmed live against the sandbox: POST
// /api/v1/rera/rera-v2 with {state_name, registration_type, registration_number}.
function surepassEnabled() { return !!process.env.SUREPASS_API_TOKEN }
const SUREPASS_BASE = process.env.SUREPASS_BASE_URL || 'https://sandbox.surepass.app'

async function verifyReraWithSurepass(registrationNumber, stateName = 'maharashtra', registrationType = 'project') {
  if (!surepassEnabled()) throw new Error('SUREPASS_API_TOKEN not configured')
  const res = await fetch(`${SUREPASS_BASE}/api/v1/rera/rera-v2`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.SUREPASS_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state_name: stateName, registration_type: registrationType, registration_number: registrationNumber }),
  })
  const d = await res.json().catch(() => null)
  if (!d) throw new Error(`Surepass ${res.status}: unparseable response`)
  const detail = d.data?.details?.[0]
  return {
    verified: !!d.success && !!detail,
    registration_number: registrationNumber,
    project_name: detail?.project_name || null,
    promoter_name: detail?.promoter_name || detail?.proprietor_name || null,
    district: detail?.district || null,
    address: detail?.project_address || detail?.address || null,
    registration_date: detail?.registration_date || null,
    approved_date: detail?.approved_date || null,
    expiry_date: detail?.expiry_date || detail?.extended_expiry_date || null,
    completion_date: detail?.completion_date || null,
    certificate_url: detail?.certificate_url || null,
    _raw_message: d.message,
  }
}

// Live web search now runs through Claude's own native search tool
// (llm.webSearchComplete) instead of a separate provider — "enabled" just
// means the Anthropic provider is configured.
function webSearchEnabled() { return llm.webSearchAvailable() }

// Official MahaRERA PROJECT registration format: P + "5" + 2-digit district
// authority code + literal "00" + 6-digit sequence (e.g. P51800012345 — the
// district codes 517/518/519/520/521... map to specific Maharashtra RERA
// regional offices). This is the PROJECT registration prefix specifically —
// "A"-prefixed numbers are a different scheme entirely (real-estate AGENT
// registrations, not projects) and were being accepted before by mistake.
// Other states run their own RERA authority with a DIFFERENT number format
// entirely (Karnataka, Tamil Nadu, etc. don't follow this pattern at all) —
// this app only structurally validates the Maharashtra format since that's
// the one we can actually verify; a plausible-but-unverified string from
// another state's project is still accepted, just capped at a lower
// confidence tier rather than being force-fit into the Maharashtra shape.
const RERA_NUMBER_RE = /\bP5\d{2}00\d{6}\b/g
// Some listing sites format the number with delimiters ("MAHA/RERA/P51800012345",
// "P-518-00-012345") or lowercase it — normalize before validating/storing so
// a formatting quirk doesn't cause a real, valid number to be rejected, and
// so what we display/verify is always the clean canonical form.
const normalizeReraCandidate = (s) => String(s || '').replace(/[\s/_-]/g, '').toUpperCase().replace(/^.*?(P5\d{2}00\d{6}).*$/, '$1')
const isValidReraNumber = (s) => /^P5\d{2}00\d{6}$/.test(normalizeReraCandidate(s))
// A loose sanity check for non-Maharashtra RERA strings: has both letters
// and digits, a plausible length, isn't an obvious non-answer like "N/A".
// Never trusted at high confidence — only lets a real-looking other-state
// number through as an "unconfirmed lead" instead of discarding it outright.
const isPlausibleReraString = (s) => {
  const t = String(s || '').trim()
  if (t.length < 6 || t.length > 40) return false
  if (!/[0-9]/.test(t) || !/[A-Za-z]/.test(t)) return false
  if (/^(NA|N\/?A|UNKNOWN|NONE|NULL)$/i.test(t)) return false
  return /^[A-Za-z0-9/\-]+$/.test(t)
}

// Every RERA-registered project has a real number — when the first pass
// doesn't surface it, the miss is usually the query, not the data. Claude
// runs its own search for a dedicated RERA-focused question instead of
// betting everything on the original broad query having found it.
async function findReraViaTargetedSearch(name, builder, city) {
  if (!name || !llm.webSearchAvailable()) return null
  try {
    const { text, sources } = await llm.webSearchComplete({
      system: `You are a real-estate research analyst with live web search. Find the RERA registration number for the project "${name}"${builder ? ` by ${builder}` : ''}${city ? ` in ${city}` : ''}. Search the web specifically for this. Report exactly what you find — the format depends on the state's RERA authority, don't force it into any particular shape. If you genuinely cannot find one after searching, say so.

Return JSON: {"rera": "the number if found, else null", "source_url": "the URL you found it on, else null"}`,
      user: 'Find the RERA number now.',
      json: true, maxTokens: 500,
    })
    const parsed = parseJSONSafe(text)
    if (!parsed?.rera) return null
    const source = sources.find(s => s.url === parsed.source_url) || sources[0] || { url: parsed.source_url, title: parsed.source_url }
    return { rera: parsed.rera, source }
  } catch (e) {
    console.error('[findReraViaTargetedSearch] failed:', e.message)
    return null
  }
}
function parseJSONSafe(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch (_) {}
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  try { return JSON.parse(cleaned) } catch (_) {}
  const start = cleaned.search(/[[{]/), end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
  if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)) } catch (_) {} }
  return null
}

// A short cache of project (name+builder) -> resolved RERA, so re-running a
// search for the same project within a session doesn't re-pay the full
// multi-query search cost.
const reraResolutionCache = new Map()
const OFFICIAL_RERA_HOSTS = ['maharera.mahaonline.gov.in', 'maharera.gov.in']

// Single shared pipeline for resolving a project's RERA number, used
// identically by /api/ai-search and /api/ai-research (Project Intelligence)
// so the two never disagree about the same project. Never returns a bare,
// unsourced LLM guess — every result here has a real citation URL behind
// it, with a confidence score:
//   100 = matched our own already-scraped/enriched dataset
//    95 = found on an official MahaRERA domain
//    60 = valid Maharashtra-format number, found with a real source
//    50 = plausible other-state RERA string, found with a real source —
//         format not independently verifiable, treated as an honest lead
async function resolveProjectRera({ name, builder, city, llmRera, sources = [] }) {
  const cacheKey = `${name}::${builder || ''}`.toLowerCase().trim().replace(/\W/g, '')
  if (cacheKey && reraResolutionCache.has(cacheKey)) return reraResolutionCache.get(cacheKey)

  const result = await (async () => {
    // Step 1: Claude's own extraction from its live search — trust it only
    // if it came with at least one real source citation for this project.
    if (llmRera && sources.length) {
      const src = sources[0]
      const isOfficial = OFFICIAL_RERA_HOSTS.some(h => (src.url || '').includes(h))
      if (isValidReraNumber(llmRera)) {
        return { rera: normalizeReraCandidate(llmRera), confidence: isOfficial ? 95 : 60, source: src }
      }
      if (isPlausibleReraString(llmRera)) {
        return { rera: String(llmRera).trim(), confidence: isOfficial ? 90 : 50, source: src }
      }
    }
    // Step 2: our own already-scraped/enriched dataset — highest confidence,
    // since it's our own verified/curated data, not a fresh web guess.
    const nameLower = String(name || '').toLowerCase().trim()
    if (nameLower) {
      const match = cache.projects.find(cp => {
        const cpName = String(cp.name || '').toLowerCase().trim()
        return cpName && (cpName === nameLower || cpName.includes(nameLower) || nameLower.includes(cpName))
      })
      if (match?.reraCode && isValidReraNumber(match.reraCode)) {
        return { rera: normalizeReraCandidate(match.reraCode), confidence: 100, source: { title: 'IndiHomes dataset', url: match.listingUrl || null } }
      }
    }
    // Step 3: a dedicated, RERA-focused search — Claude often finds it here
    // even when the broad discovery search didn't surface it.
    const found = await findReraViaTargetedSearch(name, builder, city)
    if (found) {
      const isOfficial = OFFICIAL_RERA_HOSTS.some(h => (found.source.url || '').includes(h))
      if (isValidReraNumber(found.rera)) {
        return { rera: normalizeReraCandidate(found.rera), confidence: isOfficial ? 95 : 60, source: found.source }
      }
      if (isPlausibleReraString(found.rera)) {
        return { rera: String(found.rera).trim(), confidence: isOfficial ? 90 : 50, source: found.source }
      }
    }
    return null
  })()

  if (cacheKey) reraResolutionCache.set(cacheKey, result)
  return result
}

app.get('/api/research-status', (_req, res) => {
  res.json({ enabled: webSearchEnabled() && llm.isConfigured(), search: webSearchEnabled(), llm: llm.isConfigured() })
})

// Live location search across ALL of India — localities, streets, metro/
// railway stations, landmarks, villages/towns/cities — via OpenStreetMap
// Nominatim (free, no key). Google Places Autocomplete would give a more
// polished, categorized version of this same experience, but Places API
// (New) / Geocoding / legacy Places Autocomplete are all disabled on the
// current Google Cloud project (confirmed via direct API probes — all
// return SERVICE_DISABLED / REQUEST_DENIED). This is the no-signup fallback
// so location search works today; swap in Places Autocomplete once enabled.
//
// Previously this hard-restricted every query to a Maharashtra bounding box
// (`bounded=1&viewbox=...` + appending ", Maharashtra" to the query text) —
// searching a real place in another state (e.g. "Kandigai, Chennai") either
// found nothing or got force-matched to something inside that Maharashtra
// box, which is exactly the kind of wrong-location hallucination that then
// propagates into Nearby Infrastructure showing the WRONG state's places.
// Scoped only by countrycodes=in now (all of India); Maharashtra/Mumbai
// results are still ranked first as a SOFT preference (our primary market),
// never as a hard filter that excludes everywhere else.
const OSM_TYPE_LABELS = {
  station: 'Railway/Metro Station', stop: 'Transit Stop', halt: 'Railway Halt',
  suburb: 'Locality', neighbourhood: 'Locality', quarter: 'Locality', town: 'Town',
  village: 'Village', city: 'City', administrative: 'Area', residential: 'Residential Area',
  road: 'Street', living_street: 'Street', pedestrian: 'Street', primary: 'Road', secondary: 'Road',
  attraction: 'Landmark', museum: 'Landmark', monument: 'Landmark', viewpoint: 'Landmark',
  place_of_worship: 'Landmark', park: 'Landmark', mall: 'Landmark', commercial: 'Commercial Area',
}
const locationSearchCache = new Map() // small in-memory cache — Nominatim asks callers not to hammer repeat queries

// Google Geocoding fallback — tried ONLY when Nominatim returns zero results.
// Nominatim's index is thin for small, real pockets/colonies ("Daulat
// Nagar") and almost never has anything for a brand-new/under-construction
// building name; Google's index is dramatically larger for exactly this
// case (it indexes real-estate portal pages, so a project name + locality
// often resolves even when OSM has nothing). Uses the same key as
// Competitor Analysis (GOOGLE_PLACES_API_KEY, falling back to
// VITE_GOOGLE_MAPS_KEY) rather than requiring a third separate key — the
// Geocoding API and Places API (New) are billed/enabled together on a
// Google Cloud project in the normal case. Currently a documented no-op in
// this deployment (see the comment above this function): Geocoding/Places
// are disabled on the configured GCP project until someone enables them in
// the Cloud Console — see requirements.md for exact steps. Degrades
// silently on any error/empty result, exactly like every other optional
// integration in this app.
const GOOGLE_GEOCODE_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.VITE_GOOGLE_MAPS_KEY || ''
function googleGeocodeConfigured() { return !!GOOGLE_GEOCODE_KEY }
async function geocodeWithGoogle(q, market = 'india') {
  if (!GOOGLE_GEOCODE_KEY) return []
  const region = market === 'dubai' ? 'ae' : 'in'
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=${region}&key=${GOOGLE_GEOCODE_KEY}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`Google Geocoding ${res.status}`)
  const body = await res.json()
  if (body.status !== 'OK') {
    // ZERO_RESULTS is a normal, honest empty — anything else (REQUEST_DENIED,
    // SERVICE_DISABLED, OVER_QUERY_LIMIT) is a real configuration problem
    // worth surfacing in the server log, not silently swallowed forever.
    if (body.status !== 'ZERO_RESULTS') console.warn(`[location-search] Google Geocoding: ${body.status}${body.error_message ? ' - ' + body.error_message : ''}`)
    return []
  }
  return (body.results || []).map(r => {
    const comp = (type) => r.address_components?.find(c => c.types.includes(type))?.long_name || ''
    const name = comp('sublocality_level_1') || comp('sublocality') || comp('neighborhood') || comp('locality') || (r.formatted_address || '').split(',')[0]
    const area = comp('locality') || comp('administrative_area_level_2') || ''
    return {
      name, type: 'Place (Google)', area, state: comp('administrative_area_level_1'),
      display: r.formatted_address, lat: String(r.geometry.location.lat), lon: String(r.geometry.location.lng),
    }
  }).filter(x => x.name)
}

async function searchIndiaLocations(q, market = 'india') {
  const key = `${market}::${q.toLowerCase().trim()}`
  const hit = locationSearchCache.get(key)
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.data
  const countryCode = market === 'dubai' ? 'ae' : 'in'
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
    `&format=json&limit=10&addressdetails=1&countrycodes=${countryCode}`
  const res = await fetch(url, { headers: { 'User-Agent': 'IndiHomesOS/1.0 (contact: tech@internovo.in)' } })
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)
  const raw = await res.json()
  const seen = new Set()
  // Relevance ranking bias only (never excludes results outside it) — real
  // estate search here is heaviest in Mumbai/Thane/Pune, so a same-named
  // locality there should outrank a same-named village elsewhere, but a
  // genuine Chennai/Bengaluru/Delhi/etc. result must still come through.
  // For the Dubai market this bias just doesn't apply (no metro-belt weighting).
  const METRO_BBOX = { minLat: 18.2, maxLat: 19.6, minLon: 72.6, maxLon: 74.3 } // MMR + Pune belt
  const TYPE_RANK = { 'Railway/Metro Station': 0, Locality: 1, City: 1, Town: 2, 'Transit Stop': 2, 'Residential Area': 2, Street: 3, Landmark: 3, 'Commercial Area': 3, Area: 4, Village: 5 }
  const data = raw.map(r => {
    const addr = r.address || {}
    const area = addr.suburb || addr.neighbourhood || addr.city_district || addr.town || addr.city || addr.state_district || ''
    const name = addr.suburb || addr.neighbourhood || addr.road || addr.village || addr.town || (r.display_name || '').split(',')[0]
    const type = OSM_TYPE_LABELS[r.type] || OSM_TYPE_LABELS[r.class] || 'Place'
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon)
    const inMetro = market === 'india' && lat >= METRO_BBOX.minLat && lat <= METRO_BBOX.maxLat && lon >= METRO_BBOX.minLon && lon <= METRO_BBOX.maxLon
    return { name, type, area, state: addr.state || '', display: r.display_name, lat: r.lat, lon: r.lon, _rank: (inMetro ? 0 : 10) + (TYPE_RANK[type] ?? 6) }
  }).filter(x => { const k = `${x.name}|${x.area}`.toLowerCase(); if (seen.has(k) || !x.name) return false; seen.add(k); return true })
  data.sort((a, b) => a._rank - b._rank)
  for (const d of data) delete d._rank
  locationSearchCache.set(key, { data, ts: Date.now() })
  return data
}

app.get('/api/location-search', async (req, res) => {
  const q = (req.query.q || '').trim()
  const market = req.query.market === 'dubai' ? 'dubai' : 'india'
  if (q.length < 3) return res.json({ results: [] })
  try {
    let results = await searchIndiaLocations(q, market)
    // Google Geocoding fallback — only when OSM/Nominatim found genuinely
    // nothing AND a key is configured; never runs when Nominatim already
    // has an answer (keeps Google API usage/cost minimal, only spent on the
    // exact cases OSM can't cover).
    if (!results.length && googleGeocodeConfigured()) {
      try { results = await geocodeWithGoogle(q, market) }
      catch (e) { console.warn('[location-search] Google Geocoding fallback failed:', e.message) }
    }
    res.json({ results })
  } catch (e) {
    console.error('[location-search] error:', e.message)
    res.status(500).json({ error: e.message, results: [] })
  }
})

// Real nearby infrastructure — schools, hospitals, malls, train/metro
// stations, and tourist attractions actually located around the project's
// coordinates, via OpenStreetMap's Overpass API (free, no key). This is
// genuine geographic data, not Claude's guess from prose in a listing page —
// every distance here is computed from real coordinates.
const OVERPASS_CATEGORIES = [
  { tag: 'amenity=school',        type: 'School',                icon: '🏫' },
  { tag: 'amenity=college',       type: 'College',                icon: '🎓' },
  { tag: 'amenity=university',    type: 'University',             icon: '🎓' },
  { tag: 'amenity=hospital',      type: 'Hospital',                icon: '🏥' },
  { tag: 'amenity=pharmacy',      type: 'Pharmacy',                icon: '💊' },
  { tag: 'shop=mall',             type: 'Mall',                     icon: '🛍️' },
  { tag: 'shop=supermarket',      type: 'Supermarket',              icon: '🛒' },
  { tag: 'amenity=cinema',        type: 'Cinema',                    icon: '🎬' },
  { tag: 'amenity=bank',          type: 'Bank',                       icon: '🏦' },
  { tag: 'leisure=park',          type: 'Park',                        icon: '🌳' },
  { tag: 'railway=station',       type: 'Railway/Metro Station',        icon: '🚉' },
  { tag: 'amenity=bus_station',   type: 'Bus Station',                   icon: '🚌' },
  { tag: 'tourism=attraction',    type: 'Tourist Attraction',             icon: '📍' },
]
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}
const nearbyPlacesCache = new Map()
app.get('/api/nearby-places', async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat/lon required' })
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`
  const cached = nearbyPlacesCache.get(key)
  if (cached && Date.now() - cached.ts < 24 * 60 * 60 * 1000) return res.json({ places: cached.places })
  try {
    const byTag = (el) => {
      for (const c of OVERPASS_CATEGORIES) {
        const [k, v] = c.tag.split('=')
        if (el.tags?.[k] === v) return c
      }
      return null
    }
    const runQueryOnce = async (radius) => {
      const clauses = OVERPASS_CATEGORIES.map(c => `node[${c.tag.replace('=', '="')}"](around:${radius},${lat},${lon});`).join('\n')
      const query = `[out:json][timeout:20];(${clauses});out center 80;`
      // Overpass's Apache content-negotiation 406s requests with Node's default
      // fetch User-Agent/Accept headers — explicit values fix it (verified: a
      // curl request with identical body succeeds, undici's defaults don't).
      const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', accept: '*/*', 'user-agent': 'IndiHomesOS/1.0 (contact: tech@internovo.in)' },
        body: query,
      })
      if (!resp.ok) throw new Error(`Overpass ${resp.status}`)
      const data = await resp.json()
      return (data.elements || [])
        .map(el => {
          const cat = byTag(el)
          if (!cat || !el.tags?.name) return null
          const dist = haversineKm(lat, lon, el.lat, el.lon)
          return { name: el.tags.name, type: cat.type, icon: cat.icon, lat: el.lat, lon: el.lon, distKm: Math.round(dist * 10) / 10 }
        })
        .filter(Boolean)
        .sort((a, b) => a.distKm - b.distKm)
    }
    // The shared public Overpass instance occasionally 504s under its own
    // load (observed directly: an identical request that fails once often
    // succeeds seconds later with no change on our end) — one short-delayed
    // retry turns a transient timeout into a real result instead of
    // silently handing back an empty list.
    const runQuery = async (radius) => {
      try { return await runQueryOnce(radius) }
      catch (e) {
        if (!/^Overpass 5\d\d$/.test(e.message)) throw e
        await new Promise(r => setTimeout(r, 1500))
        return runQueryOnce(radius)
      }
    }
    // Sparse/suburban areas can come back thin at a tight radius — widen the
    // search progressively rather than settling for a handful of results.
    let places = await runQuery(2500)
    if (places.length < 8) {
      const wider = await runQuery(5000).catch(() => [])
      const seen = new Set(places.map(p => p.name))
      places = [...places, ...wider.filter(p => !seen.has(p.name))].sort((a, b) => a.distKm - b.distKm)
    }
    places = places.slice(0, 20)
    nearbyPlacesCache.set(key, { places, ts: Date.now() })
    res.json({ places })
  } catch (e) {
    console.error('[nearby-places] error:', e.message)
    res.status(500).json({ error: e.message, places: [] })
  }
})

// ── Competitor Analysis — real Google Places nearby-search ──────────────────
// Replaces the old Claude-web-research-only path (permanently "Not found" in
// this deployment — no Anthropic key, per requirements.md). Queries Google
// Places API (New) Text Search, biased to a radius around the project's own
// real coordinates (the same lat/lon NearbyMap already resolves via
// /api/location-search — reused, never re-geocoded), for other residential
// developments nearby. Real, sourced results only — name, distance, and a
// real Google Maps link — same "never fabricate" standard as Nearby
// Infrastructure's OpenStreetMap data. No results / no key configured both
// return an honest empty state, never a guessed competitor.
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.VITE_GOOGLE_MAPS_KEY || ''
function competitorSearchConfigured() { return !!GOOGLE_PLACES_KEY }
const competitorsCache = new Map()

// Google Places (New) place `types` that are never a residential project,
// even when the text query biases toward one — a shop, restaurant, school,
// hospital, or office can still show up in a "residential apartment
// project" text search purely on proximity/text overlap. Deterministic
// post-filter (Part 16's explicit exclude list), not an LLM judgment call.
const NON_RESIDENTIAL_PLACE_TYPES = new Set([
  'school', 'primary_school', 'secondary_school', 'university',
  'hospital', 'doctor', 'dentist', 'pharmacy',
  'restaurant', 'cafe', 'bar', 'meal_takeaway', 'meal_delivery',
  'store', 'shopping_mall', 'supermarket', 'clothing_store', 'furniture_store',
  'office', 'corporate_office', 'real_estate_agency',
  'bank', 'atm', 'gym', 'beauty_salon', 'car_repair', 'car_dealer',
  'lodging', 'hotel', 'tourist_attraction', 'place_of_worship',
])

app.get('/api/competing-projects', async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat/lon required' })
  if (!competitorSearchConfigured()) return res.json({ configured: false, competitors: [] })
  const excludeName = String(req.query.excludeName || '').trim().toLowerCase()
  // Configurable radius (Part 15), defaulting to the same 3km the spec
  // calls out — clamped to a sane range so a bad/huge query param can't
  // turn this into an unbounded, expensive Places search.
  const radiusKmRaw = parseFloat(req.query.radiusKm)
  const radiusKm = Number.isFinite(radiusKmRaw) ? Math.max(0.5, Math.min(radiusKmRaw, 15)) : 3
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}:${radiusKm}`
  const cached = competitorsCache.get(key)
  if (cached && Date.now() - cached.ts < 24 * 60 * 60 * 1000) {
    return res.json({ configured: true, competitors: cached.competitors.filter(c => c.name.toLowerCase() !== excludeName) })
  }
  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.types',
      },
      body: JSON.stringify({
        textQuery: 'residential apartment project',
        locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: radiusKm * 1000 } },
        maxResultCount: 20,
      }),
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '')
      // Google's error body carries the ACTUAL actionable reason in
      // details[].reason (e.g. API_KEY_SERVICE_BLOCKED — the key's own
      // "API restrictions" allowlist in Cloud Console doesn't include
      // Places API (New); API_KEY_API_NOT_ENABLED — the API itself isn't
      // enabled on the project; SERVICE_DISABLED — same, different
      // phrasing) — surfacing it directly here rather than the truncated
      // top-level message alone turns "PERMISSION_DENIED" (which fires
      // for at least 3 genuinely different root causes) into an actual
      // diagnosis. Confirmed live 2026-08-18: this project's key returns
      // API_KEY_SERVICE_BLOCKED specifically — a Google Cloud Console
      // "API restrictions" setting, not a billing or API-enablement
      // issue; the request format itself is already correct (verified by
      // reproducing the identical error with an out-of-band request using
      // the exact same body/headers).
      let reason = null
      try {
        const parsed = JSON.parse(bodyText)
        reason = parsed?.error?.details?.find(d => d.reason)?.reason || null
      } catch (_) { /* non-JSON error body — fall through with reason=null */ }
      throw new Error(`Google Places ${resp.status}${reason ? ` (${reason})` : ''}: ${bodyText.slice(0, 300)}`)
    }
    const data = await resp.json()
    const competitors = (data.places || [])
      .filter(p => p.displayName?.text && p.location)
      // Exclude anything Google itself typed as non-residential (Part 16) —
      // real signal from the API's own classification, not a guess.
      .filter(p => !(p.types || []).some(t => NON_RESIDENTIAL_PLACE_TYPES.has(t)))
      .map(p => ({
        name: p.displayName.text,
        address: p.formattedAddress || null,
        distanceKm: Math.round(haversineKm(lat, lon, p.location.latitude, p.location.longitude) * 10) / 10,
        mapsUrl: p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      }))
      .filter(c => c.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
      .slice(0, 8)
    competitorsCache.set(key, { competitors, ts: Date.now() })
    res.json({ configured: true, radiusKm, competitors: competitors.filter(c => c.name.toLowerCase() !== excludeName) })
  } catch (e) {
    console.error('[competing-projects] error:', e.message)
    res.status(500).json({ configured: true, error: e.message, competitors: [] })
  }
})

app.get('/api/rera-status', (_req, res) => {
  res.json({ enabled: surepassEnabled(), provider: surepassEnabled() ? 'surepass' : 'none' })
})

// Authoritative RERA verification (government registry via Surepass) — for a
// single number, callable directly by the UI (e.g. a "Verify RERA" button).
app.post('/api/rera-verify', async (req, res) => {
  const { registrationNumber, stateName, registrationType } = req.body || {}
  if (!registrationNumber) return res.status(400).json({ error: 'registrationNumber required' })
  if (!surepassEnabled()) return res.status(503).json({ error: 'RERA verification not configured. Set SUREPASS_API_TOKEN on the server.' })
  try {
    const result = await verifyReraWithSurepass(registrationNumber, stateName || 'maharashtra', registrationType || 'project')
    res.json(result)
  } catch (e) {
    console.error('[rera-verify] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// DYNAMIC per-project research — searches the live web and fills every box from
// the sources found, citing them. No storage (light in-memory de-dupe only).
const researchCache = {}
// "Own data first, external validation second" (brief rule 6): when this
// project came from Filter Search (has a projectCode), fetch its official
// IndiHomes detail regardless of whether an LLM is configured — that data is
// real and shouldn't be gated behind an unrelated Claude/Groq/Gemini key.
// Claude web research (when available) layers on top as supporting evidence,
// same as before.
app.post('/api/ai-research', async (req, res) => {
  const { name, builder, city, projectCode, market } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  const key = `${name}::${builder || ''}`.toLowerCase().replace(/\W/g, '')
  if (researchCache[key] && !req.body.refresh) return res.json({ ...researchCache[key], _cached: true })

  let official = null
  if (mkt === 'india' && projectCode) {
    try { official = await indihomesClient.fetchProjectByName(projectCode) }
    catch (e) { console.warn('[ai-research] official IndiHomes lookup failed:', e.message) }
  }

  const canWebResearch = webSearchEnabled() && llm.isConfigured()
  if (!canWebResearch) {
    if (official) {
      const payload = { official, _provider: null, fetchedAt: new Date().toISOString(), _note: 'Showing official IndiHomes data only — live web research needs ANTHROPIC_API_KEY.' }
      researchCache[key] = payload
      return res.json(payload)
    }
    return res.status(503).json({ error: 'Live research needs ANTHROPIC_API_KEY configured on the server.' })
  }

  try {
    const data = await llm.researchFromWeb({ name, builder, city, market: mkt })
    if (!data) return res.status(502).json({ error: 'Could not structure the research results.' })
    if (!data._allSources?.length && !official) return res.json({ _empty: true, sources: [], _note: 'No web results found for this project.' })

    if (mkt === 'india') {
      // Same shared RERA pipeline resolveProjectRera used to feed /api/ai-search
      // — Project Intelligence must never disagree with itself about the same
      // project's RERA number. Doesn't call Surepass automatically — "Verify on
      // MahaRERA" in the UI does that authoritative check on demand — so a
      // sub-90 number is still returned (never malformed/unsourced) with its
      // confidence attached, rather than hidden before the user can verify it.
      const resolved = await resolveProjectRera({
        name, builder, city, llmRera: data.rera, sources: data._allSources,
      }).catch(() => null)
      data.rera = resolved?.rera || null
      data.rera_confidence = resolved?.confidence || 0
    }
    // Dubai has no verification API integrated — data.rera stays whatever
    // researchFromWeb found (sourced or null), never claimed "verified".

    const payload = { ...data, official, _provider: llm.providerName(), fetchedAt: new Date().toISOString() }
    researchCache[key] = payload
    res.json(payload)
  } catch (e) {
    console.error('[ai-research] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Re-run the description->structured-fields pass over already-cached intel, so
// projects scraped before this feature (or whose boxes are empty) get filled
// without a fresh Selenium scrape. Idempotent; safe to run repeatedly.
app.post('/api/reenrich-intel', async (_req, res) => {
  if (!llm.isConfigured()) return res.status(503).json({ error: 'No LLM configured.' })
  const rows = db.listIntel()
  let updated = 0, skipped = 0
  for (const row of rows) {
    const hit = db.getIntel(row.cache_key)
    if (!hit?.data) { skipped++; continue }
    const d = hit.data
    if (d._structured || (d.configs?.length && d.usps?.length)) { skipped++; continue }
    try {
      await fillFromDescription(d)
      db.saveIntel(row.cache_key, { name: d.name, builder: d.builder, city: d.city }, d)
      updated++
    } catch(e) { console.error('[reenrich]', row.cache_key, e.message); skipped++ }
  }
  res.json({ total: rows.length, updated, skipped })
})

// DISABLE_AUTO_SCRAPE (kept for back-compat) now gates the IndiHomes catalog
// auto-refresh loop, not scraping — set it true to serve only the seeded/
// snapshot data and refresh manually via POST /api/scrape.
const AUTO_SCRAPE = process.env.DISABLE_AUTO_SCRAPE !== 'true'

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`\nIndiHomes API -> http://localhost:${PORT}`)
  if (AUTO_SCRAPE) {
    console.log('Fetching official IndiHomes catalog...\n')
    refreshIndiHomesCatalog().catch(console.error)
  } else {
    console.log('DISABLE_AUTO_SCRAPE=true — serving seeded DB snapshot only. POST /api/scrape to trigger manually.\n')
  }
})

if (AUTO_SCRAPE) {
  const refreshMs = Math.max(60000, indihomesClient.getConfig().ttlMs)
  setInterval(() => { console.log('[server] Auto-refresh (IndiHomes catalog)'); refreshIndiHomesCatalog().catch(console.error) }, refreshMs)
}
