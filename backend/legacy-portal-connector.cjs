'use strict'

// AI-Search-only portal connector — India, 99acres + MagicBricks, via a real
// (non-headless-detected) Playwright browse of each portal's public
// new-projects listing pages. Adapted from legacy-scrapers.cjs's
// scrape99AcresSSR/scrapeMagicBricksSSR, but deliberately NOT sharing that
// file's factory (which writes into server.cjs's live `cache`/`db`) — this
// module is completely standalone so it can never be wired back into Filter
// Search's official-IndiHomes-only inventory, per STATUS.md's explicit
// "disconnect + repurpose, don't rewire into cache.projects" note.
//
// Implements the same connector interface as external-connectors.cjs:
//   { id, name, market: ['india'], isConfigured(): bool,
//     search(query, filters, market): Promise<ExternalProject[]> }
//
// Known, documented risk (unlike Google/Bing/Apify): this actually scrapes
// the portals, which previously got Railway's datacenter IP WAF-blocked by
// both sites. Works from a residential IP (local dev); may not work once
// this app is redeployed to a hosted server without a residential proxy —
// same limitation STATUS.md already recorded for the old Filter Search
// scraper. Off by default; opt in via LEGACY_PORTAL_SCRAPING_ENABLED=true.

const { extractLocations, extractConfiguration, extractBudgetMax, extractPossession } = require('./query-parser.cjs')

let chromium = null
try { chromium = require('playwright').chromium } catch (_) { /* Playwright not installed — connector stays unconfigured */ }

function isConfigured() {
  return process.env.LEGACY_PORTAL_SCRAPING_ENABLED === 'true' && !!chromium
}

function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim() }

function parsePrice(raw = '') {
  const crR = raw.match(/[₹₹]?\s*(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*Cr/i)
  if (crR) return { min: Math.round(parseFloat(crR[1]) * 1e7), max: Math.round(parseFloat(crR[2]) * 1e7), display: `Rs.${crR[1]} Cr - Rs.${crR[2]} Cr` }
  const lR = raw.match(/[₹₹]?\s*(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*L/i)
  if (lR) return { min: Math.round(parseFloat(lR[1]) * 1e5), max: Math.round(parseFloat(lR[2]) * 1e5), display: `Rs.${lR[1]}L - Rs.${lR[2]}L` }
  const sCr = raw.match(/(?:from|at|starting|Rs\.?|[₹₹])\s*(\d+\.?\d*)\s*Cr/i)
  if (sCr) { const v = Math.round(parseFloat(sCr[1]) * 1e7); return { min: v, max: null, display: `From Rs.${sCr[1]} Cr` } }
  const sL = raw.match(/(?:from|at|starting|Rs\.?|[₹₹])\s*(\d+\.?\d*)\s*L/i)
  if (sL) { const v = Math.round(parseFloat(sL[1]) * 1e5); return { min: v, max: null, display: `From Rs.${sL[1]}L` } }
  return { min: null, max: null, display: null }
}

function parseBHK(raw = '') {
  const types = []
  const s = String(raw)
  const shared = s.match(/(\d+(?:\s*[&,]\s*\d+)+)\s*BHK/gi)
  if (shared) {
    for (const chunk of shared) {
      for (const n of (chunk.match(/\d+/g) || [])) {
        const l = `${n} BHK`; if (!types.includes(l)) types.push(l)
      }
    }
  }
  for (const m of (s.match(/\d+\s*BHK/gi) || [])) {
    const l = `${m.match(/\d+/)[0]} BHK`; if (!types.includes(l)) types.push(l)
  }
  if (!types.length && /studio/i.test(s)) types.push('Studio')
  return types
}

function parsePossession(raw = '') {
  const m = String(raw).match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{4})/i)
  if (m) return `${m[1].slice(0, 3)} ${m[2]}`
  const y = String(raw).match(/20\d\d/); if (y) return y[0]
  if (/ready|immediate|now/i.test(raw)) return 'Ready to Move'
  return raw.trim() || null
}

// Same four-city coverage as the old Filter Search scraper and the frontend's
// LOCATION_GROUPS — deliberately not universal. If a query's location can't
// be resolved to one of these, this connector contributes nothing for it
// (safer/cheaper than guessing a city and scraping the wrong one).
const CITY_URLS_99ACRES = {
  Mumbai: 'https://www.99acres.com/new-projects-in-mumbai-ffid',
  Thane: 'https://www.99acres.com/new-projects-in-thane-ffid',
  Pune: 'https://www.99acres.com/new-projects-in-pune-ffid',
  'Navi Mumbai': 'https://www.99acres.com/new-projects-in-navi-mumbai-ffid',
}
const CITY_URLS_MAGICBRICKS = {
  Mumbai: 'https://www.magicbricks.com/new-projects/new-residential-projects-in-mumbai',
  Thane: 'https://www.magicbricks.com/new-projects/new-residential-projects-in-thane',
  Pune: 'https://www.magicbricks.com/new-projects/new-residential-projects-in-pune',
  'Navi Mumbai': 'https://www.magicbricks.com/new-projects/new-residential-projects-in-navi-mumbai',
}

// Locality -> city bucket, so "Malad" or "Liberty Garden" in a query resolves
// to the right city page instead of only working when someone types "Mumbai"
// outright. Deliberately a subset (the localities the frontend already
// curates for Filter Search's LocationCombobox) — an unresolved locality
// means this connector contributes nothing for that query rather than
// guessing which city to scrape.
// Shared MMR gazetteer (mmr-gazetteer.json — same file the frontend's
// LocationCombobox, scoring.cjs, and azure-search.cjs's suggester/synonym
// map all use) drives locality resolution here too, so "Gawamin" resolves to
// Vasai-Virar consistently everywhere, not just in Filter Search. Falls back
// to this connector's own hand-curated four-city list first since that's
// what CITY_URLS_* actually has scrape targets for — a resolved city with no
// URL (e.g. Vasai-Virar) still means "this connector contributes nothing for
// that query", same documented fail-safe behavior as before, never a crash.
const GAZETTEER = require('../shared/mmr-gazetteer.json')
const LOCALITY_TO_CITY = {}
const MUMBAI_LOCALITIES = ['andheri', 'bandra', 'borivali', 'kandivali', 'malad', 'goregaon', 'jogeshwari',
  'mulund', 'powai', 'chembur', 'ghatkopar', 'dadar', 'worli', 'lower parel', 'wadala', 'mahalaxmi', 'juhu',
  'vikhroli', 'bhandup', 'kurla', 'santacruz', 'vile parle', 'kanjurmarg', 'parel', 'byculla', 'dahisar',
  'oshiwara', 'lokhandwala', 'versova', 'khar', 'sion', 'matunga', 'mahim', 'liberty garden', 'bkc']
const THANE_LOCALITIES = ['majiwada', 'kolshet', 'ghodbunder road', 'kalwa', 'mumbra', 'balkum', 'manpada',
  'hiranandani estate', 'dombivli', 'kalyan']
const NAVI_MUMBAI_LOCALITIES = ['vashi', 'nerul', 'belapur', 'kharghar', 'airoli', 'ghansoli', 'kopar khairane', 'ulwe', 'taloja']
const PUNE_LOCALITIES = ['hinjewadi', 'wakad', 'baner', 'kharadi', 'hadapsar', 'kothrud', 'aundh', 'wagholi',
  'undri', 'balewadi', 'viman nagar', 'pimpri', 'chinchwad']
for (const l of MUMBAI_LOCALITIES) LOCALITY_TO_CITY[l] = 'Mumbai'
for (const l of THANE_LOCALITIES) LOCALITY_TO_CITY[l] = 'Thane'
for (const l of NAVI_MUMBAI_LOCALITIES) LOCALITY_TO_CITY[l] = 'Navi Mumbai'
for (const l of PUNE_LOCALITIES) LOCALITY_TO_CITY[l] = 'Pune'
// Gazetteer suburb/city buckets (adds Vasai-Virar, Mira-Bhayandar, and every
// East/West suburb name not already in the hand-curated lists above).
for (const [city, locs] of Object.entries(GAZETTEER.cities || {})) {
  for (const l of locs) if (!LOCALITY_TO_CITY[l.toLowerCase()]) LOCALITY_TO_CITY[l.toLowerCase()] = city
}
// Gazetteer micro-locality aliases (Gawamin -> Vasai-Virar, Kandarpada -> Mumbai, ...).
// An entry is a LIST when the same locality name exists in more than one
// place (Samata Nagar is in both Kandivali East and Thane). First wins here,
// matching gazetteer.py's "primary answer" — this map is city-lookup only.
for (const entry of Object.values(GAZETTEER.aliases || {})) {
  for (const alias of (Array.isArray(entry) ? entry : [entry])) {
    if (!alias || !alias.canonical) continue
    const k = alias.canonical.toLowerCase()
    if (!LOCALITY_TO_CITY[k]) LOCALITY_TO_CITY[k] = alias.city
  }
}
const KNOWN_CITIES = new Set(['Mumbai', 'Thane', 'Pune', 'Navi Mumbai', 'Vasai-Virar', 'Mira-Bhayandar'])

function resolveCities(locations = []) {
  const cities = new Set()
  for (const loc of locations) {
    const l = String(loc).trim()
    const lLower = l.toLowerCase()
    if (KNOWN_CITIES.has(l)) { cities.add(l); continue }
    if (LOCALITY_TO_CITY[lLower]) { cities.add(LOCALITY_TO_CITY[lLower]); continue }
    // Partial match — "liberty garden" query token vs "malad" not literal,
    // but a locality string might appear as a substring either direction
    // (e.g. "malad west" query vs "malad" map key).
    for (const [key, city] of Object.entries(LOCALITY_TO_CITY)) {
      if (lLower.includes(key) || key.includes(lLower)) { cities.add(city); break }
    }
  }
  return [...cities].slice(0, 2) // cap cost — at most 2 cities scraped per query
}

// ── Per-source, per-city cache — a real (non-headless-detected) browser
// launch + page load costs real seconds; without this, every AI Search query
// for the same city within the TTL window re-scrapes from scratch. ──────────
const CACHE_TTL_MS = 20 * 60 * 1000
const scrapeCache = new Map() // key: `${source}:${city}` -> { items, ts }

function cacheGet(key) {
  const hit = scrapeCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CACHE_TTL_MS) { scrapeCache.delete(key); return null }
  return hit.items
}
function cacheSet(key, items) { scrapeCache.set(key, { items, ts: Date.now() }) }

async function scrapeCityPage(browser, url, city, source) {
  const _ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' })
  const page = await _ctx.newPage()
  await page.route('**/*.{png,jpg,gif,woff,woff2,mp4,svg}', r => r.abort())
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(3500)
    const data = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__')
        if (el) return { source: 'next', data: JSON.parse(el.textContent) }
      } catch (_) {}
      for (const k of ['__INITIAL_STATE__', '__STATE__', '__REDUX_STATE__', '__PRELOADED_STATE__', 'SERVER_PRELOADED_STATE_']) {
        try { if (window[k]) return { source: k, data: window[k] } } catch (_) {}
      }
      const cards = document.querySelectorAll('[class*="projectCard"],[class*="ProjectCard"],[class*="searchTuple"],[class*="tupleNew"],.mb-srp__card,[class*="SrpCard"]')
      return {
        source: 'dom', cards: cards.length,
        items: [...cards].map(c => ({
          name: c.querySelector('[class*="name"],[class*="Name"],[class*="title"],[class*="Title"],h2,h3')?.textContent?.trim() || '',
          developer: c.querySelector('[class*="developer"],[class*="Developer"],[class*="builder"],[class*="promoter"]')?.textContent?.trim() || '',
          location: c.querySelector('[class*="location"],[class*="Location"],[class*="locality"]')?.textContent?.trim() || '',
          price: c.querySelector('[class*="price"],[class*="Price"],[class*="amount"]')?.textContent?.trim() || '',
          bhk: c.querySelector('[class*="bhk"],[class*="BHK"],[class*="config"],[class*="bedroom"]')?.textContent?.trim() || '',
          possession: c.querySelector('[class*="possession"],[class*="Possession"]')?.textContent?.trim() || '',
          link: c.querySelector('a[href*="project"],a[href*="new-project"],a[href*="/property"]')?.href || c.querySelector('a')?.href || '',
        })).filter(p => p.name && p.name.length > 2),
      }
    })
    const found = []
    const walk = (obj, depth = 0) => {
      if (depth > 10 || !obj || typeof obj !== 'object') return
      if (Array.isArray(obj) && obj[0]) {
        const s = obj[0]
        if (s.projectName || s.ProjectName || s.name || s.project_name || s.projectTitle || s.ProjectTitle) {
          for (const item of obj) {
            const name = clean(item.projectName || item.ProjectName || item.name || item.project_name || item.projectTitle || item.ProjectTitle || item.title || '')
            if (name.length < 3) continue
            const price = parsePrice(String(item.priceRange || item.price || item.minPrice || ''))
            found.push({
              name, developer: clean(item.developerName || item.developer || item.builderName || 'Unknown Developer'),
              location: clean(item.locality || item.location || city),
              city, bhk: parseBHK(item.bhkConfig || item.bhkRange || item.bhk || item.bedrooms || ''),
              price_min: price.min, price_max: price.max, price_display: price.display || 'Price on request',
              possession: parsePossession(item.possessionDate || item.possession || ''),
              rera: !!(item.rera || item.reraNo || item.reraNumber || item.reraId || item.reraRegistered),
              reraCode: item.reraNo || item.reraNumber || item.reraId || null,
              listing_url: item.url ? (String(item.url).startsWith('http') ? item.url : `https://${source === '99acres' ? 'www.99acres.com' : 'www.magicbricks.com'}${item.url}`) : null,
            })
          }
          return
        }
      }
      for (const v of Object.values(obj)) walk(v, depth + 1)
    }
    if (data?.source && data.source !== 'dom') walk(data.data)
    else if (data?.source === 'dom' && data.items?.length) {
      for (const r of data.items) {
        const price = parsePrice(r.price)
        found.push({
          name: clean(r.name), developer: clean(r.developer) || 'Unknown Developer',
          location: clean(r.location) || city, city, bhk: parseBHK(r.bhk),
          price_min: price.min, price_max: price.max, price_display: price.display || 'Price on request',
          possession: parsePossession(r.possession), rera: false,
          listing_url: r.link?.startsWith('http') ? r.link : null,
        })
      }
    }
    // Diagnostic: distinguish "page loaded but nothing matched our parsing"
    // (data.source tells us which path fired, found.length tells us if it
    // actually extracted anything) from a silent 0 that gives no clue why.
    console.log(`[legacy-portal-connector] ${source} ${city}: SSR source=${data?.source || 'none'}${data?.cards != null ? ` domCards=${data.cards}` : ''} -> ${found.length} parsed`)
    return found
  } finally {
    await page.close().catch(() => {})
  }
}

async function getCityListings(browser, city) {
  const out = []
  for (const [source, urls] of [['99acres', CITY_URLS_99ACRES], ['magicbricks', CITY_URLS_MAGICBRICKS]]) {
    const key = `${source}:${city}`
    const cached = cacheGet(key)
    if (cached) { out.push(...cached.map(i => ({ ...i, _source: source }))); continue }
    if (!urls[city]) continue
    try {
      const items = await scrapeCityPage(browser, urls[city], city, source)
      cacheSet(key, items)
      out.push(...items.map(i => ({ ...i, _source: source })))
      console.log(`[legacy-portal-connector] ${source} ${city}: ${items.length} listings`)
    } catch (e) {
      console.warn(`[legacy-portal-connector] ${source} ${city} failed:`, e.message)
    }
  }
  return out
}

function toExternalProject(item, market) {
  return {
    id: item.listing_url || `${item._source}:${item.name}`,
    market, country: 'India', currency: 'INR',
    city: item.city || null, location: item.location || null, community: null,
    name: item.name, developer: item.developer || null,
    configuration: item.bhk?.length ? item.bhk.join(' & ') : null,
    bedrooms: item.bhk?.[0] ? parseInt(item.bhk[0], 10) || null : null,
    budgetMin: item.price_min ?? null, budgetMax: item.price_max ?? item.price_min ?? null,
    possessionDate: null, handoverDate: item.possession || null,
    propertyType: null,
    sourceName: item._source === '99acres' ? '99acres' : 'MagicBricks',
    sourceUrl: item.listing_url || null,
    lastSeenAt: new Date().toISOString(),
    sourceQuality: 'high', // direct portal scrape, not a generic web-search snippet
    description: '', amenities: [],
    rera: !!item.rera, reraCode: item.reraCode || null,
  }
}

// ── PORTAL SCRAPING IS PERMANENTLY OFF ──────────────────────────────────────
// Product decision, recorded here rather than only in an env var: this app
// does not scrape 99acres or MagicBricks.
//
// The reason is not that reading a public page is inherently wrong — it is
// that THIS code did it by deliberately defeating the portals' bot
// detection. scrapeCityPage's own comment says so outright: headless "got 0
// results here — 99acres' WAF blocks headless outright", so the launch was
// changed to a real, visible, off-screen window specifically to get through
// "undetected". Reading a page a site serves you is one conversation;
// detecting that you have been blocked and changing method so you stop
// being blocked is a different one.
//
// Enforced HERE, in code, not by LEGACY_PORTAL_SCRAPING_ENABLED. An env var
// is a setting someone flips back on in six months without knowing why it
// was off; a hard return is a decision. That flag now buys page RENDERING
// for non-portal sites (see fetchRenderedPage) and nothing else.
//
// What replaces it: licensed sources the harness already uses — Tavily and
// Serper (search APIs, reading THEIR index), Google Places (paid API), and
// JSON-LD structured data published by developers' own sites, which exists
// precisely to be machine-read. Expect fewer candidates; that is the trade,
// and it was made knowingly.
const PORTAL_SCRAPING_PERMANENTLY_DISABLED = true

async function search(query, filters = {}, market = 'india') {
  if (PORTAL_SCRAPING_PERMANENTLY_DISABLED) return []
  if (market !== 'india' || !isConfigured()) return []

  const locations = filters.locations?.length ? filters.locations : extractLocations(query)
  const cities = resolveCities(locations)
  if (!cities.length) return [] // can't resolve a covered city — contribute nothing rather than guess

  const configuration = filters.configuration || extractConfiguration(query)
  const configTokens = configuration ? configuration.split(/&|,/).map(s => s.trim()).filter(Boolean) : []
  const budgetMax = filters.budgetMax ?? extractBudgetMax(query, 'INR')
  const locTokens = locations.map(l => String(l).toLowerCase())

  let browser
  try {
    // headless:true is what got both getting 0 results here — 99acres' WAF
    // (and, per scripts/chrome_utils.py's own comment, Chrome generally)
    // blocks headless outright; the working Python scrapers use a real,
    // non-headless, OFF-SCREEN window (--window-position far off canvas) to
    // get through undetected while never actually appearing on screen.
    // Windows-only positioning, same guard chrome_utils.py uses, since this
    // flag can hang Chrome under Xvfb on Linux hosts.
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    if (process.platform === 'win32') launchArgs.push('--window-position=-3000,-3000')
    browser = await chromium.launch({ headless: false, args: launchArgs })
    const all = []
    for (const city of cities) all.push(...await getCityListings(browser, city))

    // Query-aware filtering — this is what makes it a "search" connector
    // rather than a bulk city dump: narrow by locality text, then softly by
    // configuration/budget (never hard-exclude on missing data, same
    // "explainable degrade" pattern the rest of the app uses).
    let filtered = all
    if (locTokens.length) {
      const hit = filtered.filter(p => {
        const hay = `${p.location} ${p.name}`.toLowerCase()
        return locTokens.some(l => hay.includes(l))
      })
      if (hit.length) filtered = hit // only narrow if it actually yields something
    }
    if (configTokens.length) {
      filtered = filtered.filter(p => !p.bhk?.length || p.bhk.some(b => configTokens.some(c => b.toLowerCase() === c.toLowerCase())))
    }
    if (budgetMax != null) {
      filtered = filtered.filter(p => p.price_min == null || p.price_min <= budgetMax * 1.15) // 15% headroom, soft filter
    }

    const seen = new Set()
    const deduped = filtered.filter(p => {
      const k = `${p._source}:${p.name}`.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k); return true
    })

    return deduped.slice(0, 20).map(p => toExternalProject(p, market))
  } catch (e) {
    console.error('[legacy-portal-connector] search failed:', e.message)
    return []
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

// ── Generic single-URL rendered fetch ───────────────────────────────────────
// Used by agent-tools-bridge.cjs's /fetch-page route as the "JavaScript-heavy
// page" escalation path. A developer's own site (Lodha, Godrej, Kanakia)
// often renders its price table and configuration list client-side, so a
// plain HTTP GET returns an empty shell. Reading it in a browser is exactly
// what those sites intend — it is the same content they publish as JSON-LD
// for machines.
//
// THREE THINGS CHANGED HERE, and they are one fix, not three:
//
// 1. headless: true. The old comment said headless was needed because it
//    "actually gets through 99acres/MagicBricks' WAF". That was the WAF
//    circumvention, and the portals are no longer fetched at all, so the
//    reason is gone. A headless browser is also several times cheaper.
// 2. ONE reused browser, a fresh context per call. The old code called
//    chromium.launch() per request — a brand-new GUI Chromium every time,
//    no pool, no cap. deep_research drives this 12 wide, so a live run put
//    12 headful Chromiums on the machine at once. That is what produced the
//    `[bridge] ConnectTimeout` x12 storm: not a slow upstream, but a host
//    too starved to complete a loopback TCP handshake in 3 seconds.
// 3. A render budget UNDER the caller's timeout, and a concurrency cap.
//    The old path budgeted 20s + 2.5s = 22.5s against Python's 15s bridge
//    timeout, so a render could never finish in time. Python gave up, Express
//    does not abort a handler on client disconnect, the Chromium kept
//    running, and the next request launched another. They accumulated for
//    the whole run.
//
// A blocklist stays as a backstop: even with the flag on, the two portals
// are never rendered. Nothing should be able to reintroduce that by editing
// a URL list somewhere else.
const RENDER_BLOCKED_HOSTS = [/(^|\.)99acres\.com$/i, /(^|\.)magicbricks\.com$/i]
// Below /fetch-page's own 15s bridge timeout on the Python side, so a render
// that is going to be abandoned is abandoned HERE, releasing the page.
const RENDER_NAV_TIMEOUT_MS = Number(process.env.RENDER_NAV_TIMEOUT_MS || 9000)
const RENDER_SETTLE_MS = Number(process.env.RENDER_SETTLE_MS || 1200)
const RENDER_MAX_CONCURRENT = Number(process.env.RENDER_MAX_CONCURRENT || 3)

let _sharedBrowser = null
let _browserStarting = null
let _inFlight = 0
const _waiters = []

async function _getBrowser() {
  if (_sharedBrowser && _sharedBrowser.isConnected()) return _sharedBrowser
  if (_browserStarting) return _browserStarting
  _browserStarting = chromium
    .launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
    .then(b => {
      _sharedBrowser = b
      // If Chromium dies (crash, OOM, someone kills it), drop the handle so
      // the next call launches a fresh one instead of throwing forever.
      b.on('disconnected', () => { _sharedBrowser = null })
      _browserStarting = null
      return b
    })
    .catch(e => { _browserStarting = null; throw e })
  return _browserStarting
}

function _acquire() {
  if (_inFlight < RENDER_MAX_CONCURRENT) { _inFlight++; return Promise.resolve() }
  return new Promise(resolve => _waiters.push(resolve))
}

function _release() {
  const next = _waiters.shift()
  if (next) next()
  else _inFlight = Math.max(0, _inFlight - 1)
}

async function closeRenderer() {
  const b = _sharedBrowser
  _sharedBrowser = null
  if (b) await b.close().catch(() => {})
}

async function fetchRenderedPage(url) {
  if (!isConfigured()) throw new Error('Browser rendering not configured (LEGACY_PORTAL_SCRAPING_ENABLED, or Playwright Chromium not installed).')
  let host = ''
  try { host = new URL(url).hostname } catch (_) { throw new Error(`Not a fetchable URL: ${url}`) }
  if (RENDER_BLOCKED_HOSTS.some(re => re.test(host))) {
    throw new Error(`Rendering is not performed for ${host} — portal scraping is permanently disabled in this app.`)
  }

  await _acquire()
  let ctx
  try {
    const browser = await _getBrowser()
    ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,woff,woff2,mp4,svg}', r => r.abort())
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_NAV_TIMEOUT_MS })
    await page.waitForTimeout(RENDER_SETTLE_MS)
    return await page.evaluate(() => ({
      title: document.title || '',
      text: (document.body?.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 8000),
      html: document.documentElement.outerHTML.slice(0, 250000),
    }))
  } finally {
    // Close the CONTEXT, never the shared browser — closing the browser here
    // is what made this per-call in the first place.
    if (ctx) await ctx.close().catch(() => {})
    _release()
  }
}

module.exports = {
  id: 'legacy-portal-scraper',
  // Renamed: this module no longer contributes portal listings at all
  // (search() returns [] unconditionally). What it still provides is generic
  // page rendering for JS-heavy developer sites, with the two portals
  // blocklisted. The old name appeared in operator-facing connector lists
  // and would have kept claiming a capability that has been removed.
  name: 'Page renderer (developer sites)',
  market: ['india'],
  isConfigured,
  search,
  fetchRenderedPage,
  closeRenderer,
  PORTAL_SCRAPING_PERMANENTLY_DISABLED,
}
