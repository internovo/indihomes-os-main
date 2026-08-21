'use strict'

// Internal HTTP bridge for the Python ai-search-agent (LangGraph) service.
// Every route here is a THIN wrapper around the EXISTING, already-reviewed
// connectors in external-connectors.cjs / legacy-portal-connector.cjs /
// indihomes-client.cjs — nothing here re-implements search or scraping
// logic. This is the "treat portal connectors as modular tools" boundary:
// the agent calls these routes as its tools; the actual Google/Bing/Apify/
// 99acres/MagicBricks/IndiHomes code lives exactly where it already did.
//
// Not exposed to the public frontend — mounted under /internal/agent-tools
// and gated by a shared token (AGENT_INTERNAL_TOKEN) so it's not just an
// unauthenticated internal surface sitting on the same port as the public
// API, even though this deployment only ever calls it from localhost.

const express = require('express')
const { tavilyConnector, serperConnector, googleCseConnector, bingConnector, apifyConnector, legacyPortalConnector, placesConnector, placesVerify, getConnectorStatus } = require('./external-connectors.cjs')
const indihomesClient = require('./indihomes-client.cjs')

const router = express.Router()

const INTERNAL_TOKEN = process.env.AGENT_INTERNAL_TOKEN || 'dev-local-agent-token'
router.use((req, res, next) => {
  const token = req.get('X-Internal-Token')
  if (token !== INTERNAL_TOKEN) return res.status(401).json({ error: 'Missing/invalid internal token' })
  next()
})

// What's actually callable right now — lets the Python planner decide which
// tools are worth invoking instead of blindly calling everything and eating
// a guaranteed "not configured" no-op for tools that can't run.
router.get('/status', (_req, res) => {
  res.json({ connectors: getConnectorStatus() })
})

function toEvidence(item, { toolId, sourceType }) {
  return {
    source: item.sourceName || toolId,
    source_url: item.sourceUrl || null,
    source_type: sourceType,
    title: item.name || null,
    property_name: item.name || null,
    developer: item.developer || null,
    location: item.location || item.community || item.city || null,
    configuration: item.configuration ? String(item.configuration).split(/&|,/).map(s => s.trim()).filter(Boolean) : [],
    price: {
      min_inr: item.budgetMin ?? null,
      max_inr: item.budgetMax ?? null,
      display: item.budgetMax ? `${item.currency === 'AED' ? 'AED ' : '₹'}${Number(item.budgetMax).toLocaleString('en-IN')}` : null,
    },
    carpet_area: { value_sqft: null, display: null },
    possession: item.handoverDate || item.possessionDate || null,
    // Never a non-numeric placeholder here — dedupe.py uses this value as a
    // RERA-based merge key across ALL properties in a search. A prior
    // version set this to the literal string 'Present (number not
    // extracted)' whenever a connector only knew RERA was present without
    // the actual number — which meant ANY TWO UNRELATED properties that
    // both hit that fallback shared the identical "RERA number" and got
    // merged into ONE entity by dedupe.py, silently carrying one's
    // description/evidence onto the other (confirmed live: a Daulat Nagar
    // search result inherited an unrelated Goregaon West project's full
    // description this way). Only a real extracted code participates in
    // matching now; "RERA present but number unknown" is simply null here
    // — not useful evidence for identity-matching, and not worth the
    // cross-contamination risk of pretending it is.
    rera: item.reraCode || null,
    amenities: item.amenities || [],
    description: item.description || null,
    raw_text: (item.description || '').slice(0, 400) || null,
    captured_at: item.lastSeenAt || new Date().toISOString(),
    confidence: item.sourceQuality === 'high' ? 'high' : item.sourceQuality === 'low' ? 'low' : 'medium',
    // Real Places-provided fields (Part 1/38) — undefined (never a fake 0/
    // null placeholder that JSON would still serialize) for every connector
    // except placesConnector, which is the only one that actually has them.
    ...(item.lat != null && item.lon != null ? { lat: item.lat, lon: item.lon } : {}),
    ...(item.placeId ? { place_id: item.placeId } : {}),
    ...(item.formattedAddress ? { formatted_address: item.formattedAddress } : {}),
  }
}

// ── Web search — Google Programmable Search + Bing, whichever is configured
// (both are official search APIs, not scraping). Mirrors external-search.cjs's
// own "run whatever's configured, merge, never fail hard on one connector's
// error" pattern.
router.post('/web-search', async (req, res) => {
  const { query, market } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  const runners = [
    { id: 'google-cse', connector: googleCseConnector, sourceType: 'web' },
    { id: 'bing-search', connector: bingConnector, sourceType: 'web' },
  ].filter(r => r.connector.isConfigured())
  if (!runners.length) return res.json({ evidence: [], tried: [], note: 'No web search connector configured (GOOGLE_CUSTOM_SEARCH_API_KEY/CX or BING_SEARCH_API_KEY).' })
  const results = await Promise.allSettled(runners.map(r => r.connector.search(query, {}, mkt)))
  const evidence = []
  const errors = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') evidence.push(...r.value.map(item => toEvidence(item, { toolId: runners[i].id, sourceType: 'web' })))
    else errors.push({ tool: runners[i].id, message: r.reason?.message || 'unknown error' })
  })
  res.json({ evidence, tried: runners.map(r => r.id), errors })
})

// ── Tavily — AI-native web search (Part 29's "primary" research tool). A
// distinct connector from Google/Bing above, so it's tried in parallel with
// them rather than only as a fallback; `depth` ('basic'|'advanced') is set
// by the caller (the graph's first-pass search uses 'basic', targeted
// per-candidate research uses 'advanced' — see graph.py).
router.post('/tavily-search', async (req, res) => {
  const { query, market, depth } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  if (!tavilyConnector.isConfigured()) {
    return res.json({ evidence: [], tried: [], note: 'Tavily not configured (TAVILY_API_KEY/TAVILY_SEARCH_ENABLED).' })
  }
  try {
    const items = await tavilyConnector.search(query, { depth }, mkt)
    res.json({ evidence: items.map(item => toEvidence(item, { toolId: 'tavily', sourceType: 'web' })), tried: ['tavily'] })
  } catch (e) {
    res.status(502).json({ error: e.message, evidence: [], tried: ['tavily'] })
  }
})

// ── Serper (google.serper.dev) — a second, independent Google-results
// search API, run alongside Tavily (never as its replacement) so a single
// provider's outage doesn't take down discovery.
router.post('/serper-search', async (req, res) => {
  const { query, market } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  if (!serperConnector.isConfigured()) {
    return res.json({ evidence: [], tried: [], note: 'Serper not configured (SERPER_API_KEY).' })
  }
  try {
    const items = await serperConnector.search(query, {}, mkt)
    res.json({ evidence: items.map(item => toEvidence(item, { toolId: 'serper', sourceType: 'web' })), tried: ['serper'] })
  } catch (e) {
    res.status(502).json({ error: e.message, evidence: [], tried: ['serper'] })
  }
})

// ── Developer/project website search — same web-search connectors, biased
// toward official/builder pages via a query hint (no separate connector
// exists for this yet, per requirements.md's connector inventory).
router.post('/developer-search', async (req, res) => {
  const { query, market } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  const biased = `${query} official site developer builder`
  const runners = [googleCseConnector, bingConnector].filter(c => c.isConfigured())
  if (!runners.length) return res.json({ evidence: [], tried: [], note: 'No web search connector configured.' })
  const results = await Promise.allSettled(runners.map(c => c.search(biased, {}, mkt)))
  const evidence = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') evidence.push(...r.value.map(item => toEvidence(item, { toolId: runners[i].id, sourceType: 'developer' })))
  })
  res.json({ evidence, tried: runners.map(c => c.id) })
})

// ── 99acres + MagicBricks (direct portal browse). The underlying connector
// scrapes both portals together per city in one pass (shared browser
// session/cache) — exposed as one route, but each returned item is still
// individually tagged 99acres/MagicBricks via sourceName, so the agent's
// evidence is correctly attributed per portal even though the network call
// is combined. Known limitation (documented, not hidden): this connector is
// off by default (LEGACY_PORTAL_SCRAPING_ENABLED) and only reliable from a
// residential IP — see legacy-portal-connector.cjs's header comment.
router.post('/portal-search', async (req, res) => {
  const { query, market, locations, configuration, budgetMax } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  if (!legacyPortalConnector.isConfigured()) {
    return res.json({ evidence: [], tried: [], note: 'Portal scraping not configured (LEGACY_PORTAL_SCRAPING_ENABLED, or Playwright Chromium not installed).' })
  }
  try {
    const items = await legacyPortalConnector.search(query, { locations, configuration, budgetMax }, mkt)
    const evidence = items.map(item => toEvidence(item, { toolId: item.sourceName === '99acres' ? '99acres' : 'magicbricks', sourceType: 'portal' }))
    res.json({ evidence, tried: ['99acres', 'magicbricks'] })
  } catch (e) {
    res.status(502).json({ error: e.message, evidence: [], tried: ['99acres', 'magicbricks'] })
  }
})

// ── Apify actor (isolation layer for any deeper scraping run) ─────────────
router.post('/apify-search', async (req, res) => {
  const { query, market } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  if (!apifyConnector.isConfigured()) {
    return res.json({ evidence: [], tried: [], note: 'Apify not configured (EXTERNAL_SCRAPING_ENABLED/APIFY_TOKEN/APIFY_EXTERNAL_ACTOR_ID).' })
  }
  try {
    const items = await apifyConnector.search(query, {}, mkt)
    res.json({ evidence: items.map(item => toEvidence(item, { toolId: 'apify-actor', sourceType: 'web' })), tried: ['apify-actor'] })
  } catch (e) {
    res.status(502).json({ error: e.message, evidence: [], tried: ['apify-actor'] })
  }
})

// ── places_search — Google Places (New)-based candidate discovery (Part 1
// of the Places-augmented pipeline). Thin wrapper around placesConnector in
// external-connectors.cjs — same shared places-client.cjs endpoint/auth
// /api/competing-projects already uses successfully. Extended to Dubai
// after live verification (16 real, well-named Dubai Marina buildings for
// a real query) — strongest for ready-to-move/completed buildings (Places'
// own real coverage gap for pre-launch/early-construction inventory, true
// in either market) — this route never claims otherwise; graph.py's
// discovery fan-out treats an empty result here the same as any other
// connector finding nothing.
router.post('/places-search', async (req, res) => {
  const { query, market, locations, configuration } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const mkt = market === 'dubai' ? 'dubai' : 'india'
  if (!placesConnector.isConfigured()) {
    return res.json({ evidence: [], tried: [], note: 'Google Places not configured (GOOGLE_PLACES_API_KEY).' })
  }
  try {
    const items = await placesConnector.search(query, { locations, configuration }, mkt)
    res.json({ evidence: items.map(item => toEvidence(item, { toolId: 'google-places', sourceType: 'web' })), tried: ['google-places'] })
  } catch (e) {
    res.status(502).json({ error: e.message, evidence: [], tried: ['google-places'] })
  }
})

// ── places_verify — Part 2's per-candidate name-verification lookup.
// Returns { found: false } (never an error) when Places simply doesn't
// have this building yet — that's an expected, common outcome for a
// genuine pre-launch project, not a failure. Only a real network/API
// failure returns a non-200.
router.post('/places-verify', async (req, res) => {
  const { name, locality, city } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  if (!placesConnector.isConfigured()) return res.json({ found: false, note: 'Google Places not configured.' })
  try {
    const match = await placesVerify(name, locality, city)
    res.json({ found: !!match, place: match || null })
  } catch (e) {
    res.status(502).json({ error: e.message, found: false })
  }
})

// ── fetch_page — the deep-research capability (AI Search agent Part 4/5).
// Reuses the exact same infra every other route here does: a plain Node
// `fetch()` for the common case (works fine for server-rendered pages,
// including the __NEXT_DATA__-style SSR content legacy-portal-connector.cjs
// already reads for portal city pages), escalating to
// legacyPortalConnector.fetchRenderedPage — the SAME Playwright launch that
// connector already uses, not a second scraping framework — only when the
// plain fetch came back too thin to be useful (a JS-only SPA shell) AND
// portal/browser scraping is actually configured. No HTML parser dependency
// added — title/meta/JSON-LD/body-text extraction below is plain regex,
// same "lightweight, dependency-free extraction" style as external-
// search.cjs's own fact regexes.
const FETCH_PAGE_TIMEOUT_MS = parseInt(process.env.AGENT_FETCH_PAGE_TIMEOUT_MS, 10) || 12000
// Real live bug (Mahatre Wadi trace, this pass): 6000 was tight enough that
// a real portal category page's own nav/header block (confirmed live on an
// actual MagicBricks page — NOT wrapped in semantic <nav>/<header> tags on
// this site, so the strip below doesn't remove it — ~7000 real characters
// of genuine menu text: "Buy Popular Choices / Ready to Move / Budget
// Homes / ... / Sell For Owner / +91 9870 260 930 / Login / Home
// Interiors...") pushed the page's own real listing content (RERA numbers,
// building names, prices) past the cap entirely — confirmed directly: the
// real page's first RERA number sits at character ~7660 of its extracted
// text, its 5th at ~24000. Raised to 24000, verified against this exact
// real page to comfortably include all of them. Free to raise — the two
// LLM-facing consumers of this text (classify_lifecycle_status,
// llm_assist_extract) already self-limit to their own 4000-char budget
// regardless of how much is passed in, so this only benefits the free,
// regex-only deterministic extractors (deterministic_extract,
// extract_sub_listings), never LLM token cost.
const FETCH_PAGE_MAX_CHARS = parseInt(process.env.AGENT_FETCH_PAGE_MAX_CHARS, 10) || 24000
const FETCH_PAGE_CACHE_TTL_MS = 20 * 60 * 1000
const fetchPageCache = new Map() // normalized URL -> { data, ts }

function normalizeUrlKey(url) {
  try { const u = new URL(url); u.hash = ''; return u.toString() } catch { return String(url) }
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&ndash;/g, '-').replace(/&mdash;/g, '-').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}
function cleanWs(s = '') { return String(s).replace(/\s+/g, ' ').trim() }

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? decodeHtmlEntities(cleanWs(m[1])) : null
}
function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
  return m ? decodeHtmlEntities(cleanWs(m[1])) : null
}
// JSON-LD (schema.org) — the closest thing to structured facts a generic
// page can offer without a browser render; a real-estate listing page that
// carries schema.org/Product or /Residence markup hands us clean fields
// (price, name, address) with no text-parsing guesswork at all.
function extractJsonLd(html) {
  const blocks = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) && blocks.length < 5) {
    try { blocks.push(JSON.parse(m[1].trim())) } catch (_) { /* malformed JSON-LD on this page — skip it, never guess its shape */ }
  }
  return blocks
}
// Real live bug (Mahatre Wadi trace, this pass): a real portal category
// page's <nav>/<header> (site-wide menu — "Buy Popular Choices / Ready to
// Move / Budget Homes / New Projects / Property Types / Flats in Mumbai /
// House for sale in Mumbai / ...") appears EARLY in the DOM, so it was
// consuming a large chunk of FETCH_PAGE_MAX_CHARS's fixed budget before the
// page's own real listing content (further down, inside the actual body)
// ever got a chance to be included — confirmed live: a real MagicBricks
// category page's extracted text was menu chrome from end to end, zero
// RERA numbers anywhere in it, even though the real page (verified by
// fetching it directly) genuinely lists several real projects with real
// RERA numbers further down. This silently degraded extraction quality
// for EVERY fetch_page call, not just aggregator pages — any listing page
// with a large nav/header block lost real content to the same crowding.
// Stripped here, before the char cap, same "boilerplate never counts
// against the budget" principle as the existing script/style/comment strip.
function htmlToText(html) {
  const s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const decoded = decodeHtmlEntities(s).replace(/[ \t]+/g, ' ')
  // Drop every blank/whitespace-only LINE outright, not just collapse
  // consecutive newlines — a page's boilerplate markup (filter widgets,
  // menu items each in their own block-level tag) turns into hundreds of
  // near-empty single-character lines once tags are stripped; the old
  // `\n[ \t]*\n+ -> \n` collapse didn't reliably catch all of them,
  // letting them silently eat into FETCH_PAGE_MAX_CHARS's fixed budget
  // before any real content appeared.
  return decoded.split('\n').map(l => l.trim()).filter(Boolean).join('\n')
}

async function fetchPageHttp(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    redirect: 'follow', signal: AbortSignal.timeout(FETCH_PAGE_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') || ''
  if (contentType && !contentType.includes('html')) throw new Error(`Unsupported content-type: ${contentType}`)
  return res.text()
}

async function fetchPage(url) {
  const key = normalizeUrlKey(url)
  const cached = fetchPageCache.get(key)
  if (cached && Date.now() - cached.ts < FETCH_PAGE_CACHE_TTL_MS) return { ...cached.data, cached: true }

  let html = null
  let httpError = null
  let retrievedVia = 'http'
  try {
    html = await fetchPageHttp(url)
  } catch (e) {
    httpError = e.message
  }

  let text = html ? htmlToText(html) : ''
  // A successful HTTP fetch that yields almost no readable text usually
  // means the page is a client-rendered SPA shell (React/Next hydration
  // with no meaningful server-rendered content) — the same signal
  // legacy-portal-connector.cjs's own SSR-vs-DOM fallback already keys off
  // for portal city pages. Escalate to a real browser render only when
  // that's actually configured — never silently fail, and never launch a
  // browser for every plain page (cost/perf, Part 17/44).
  if ((!html || text.length < 200) && legacyPortalConnector.isConfigured()) {
    try {
      const rendered = await legacyPortalConnector.fetchRenderedPage(url)
      if (rendered?.text && rendered.text.length > text.length) {
        text = rendered.text
        html = rendered.html || html
        retrievedVia = 'browser'
      }
    } catch (e) {
      if (!html) httpError = httpError || e.message // browser was the only chance and it also failed
    }
  }

  const result = {
    url,
    title: html ? extractTitle(html) : null,
    content: text ? text.slice(0, FETCH_PAGE_MAX_CHARS) : null,
    metadata: { description: html ? extractMetaDescription(html) : null, retrievedVia },
    structured_data: html ? extractJsonLd(html) : [],
    retrieved_at: new Date().toISOString(),
    status: text ? 'success' : 'error',
    error: text ? null : (httpError || 'No readable content found'),
  }
  if (result.status === 'success') fetchPageCache.set(key, { data: result, ts: Date.now() })
  return result
}

router.post('/fetch-page', async (req, res) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ error: 'url required' })
  let parsed
  try {
    parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported')
  } catch (e) {
    return res.status(400).json({ error: `Invalid URL: ${e.message}` })
  }
  try {
    res.json(await fetchPage(url))
  } catch (e) {
    res.status(502).json({
      url, status: 'error', error: e.message, title: null, content: null,
      metadata: {}, structured_data: [], retrieved_at: new Date().toISOString(),
    })
  }
})

// ── Official IndiHomes catalog cross-reference — "does IndiHomes already
// carry this project" is a genuinely authoritative signal the agent should
// weigh, not re-derive from a web snippet.
router.post('/official-lookup', async (req, res) => {
  const { name } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  try {
    const project = await indihomesClient.fetchProjectByName(name)
    res.json({ found: !!project, project: project || null })
  } catch (e) {
    res.json({ found: false, project: null, note: e.message })
  }
})

module.exports = router
