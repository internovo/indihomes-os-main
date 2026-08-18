'use strict'

// AI Search's external (non-IndiHomes) property connectors — the adapter
// interface the brief asks for, so real partner APIs can be dropped in later
// without touching external-search.cjs or server.cjs.
//
// Every connector implements:
//   { id, name, market: ['india'|'dubai', ...], isConfigured(): bool,
//     search(query, filters): Promise<ExternalProject[]> }
//
// ExternalProject fields map 1:1 onto the Azure `external-projects` index
// schema: id, market, country, city, location, community, name, developer,
// configuration, bedrooms, budgetMin, budgetMax, currency, possessionDate,
// handoverDate, propertyType, sourceName, sourceUrl, lastSeenAt,
// sourceQuality, description, amenities.
//
// Nothing here scrapes a property portal directly. Google/Bing are official
// search APIs; Apify (when an actor id is configured) is the isolation layer
// for any actual scraping — the brief requires scraping (if used at all) be
// isolated behind a connector and respect robots.txt/ToS, which is exactly
// what delegating to an Apify actor run gives us without us writing a scraper.

const { parseNLQuery, extractBudgetMax, extractConfiguration, extractPossession, extractAmenities } = require('./query-parser.cjs')
const legacyPortalConnector = require('./legacy-portal-connector.cjs')

function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim() }

// Conservative developer-name extraction from a listing's own title/snippet
// text — purely extractive (regex against real text), never guessed. Only
// fires on an explicit "by <Name>" or "Developer: <Name>" mention; a common
// non-developer word right after "by" (Owner/Agent/Broker — e.g. "Flats by
// Owner") is excluded so this doesn't mislabel a resale/owner-posted listing
// as having a real developer.
const NOT_A_DEVELOPER = new Set(['owner', 'agent', 'broker', 'appointment', 'invite', 'request'])
function extractDeveloperGuess(text) {
  const t = String(text || '')
  const byMatch = t.match(/\bby\s+([A-Z][A-Za-z&.\-]+(?:\s+[A-Z][A-Za-z&.\-]+){0,3})/)
  if (byMatch) {
    const name = clean(byMatch[1])
    if (!NOT_A_DEVELOPER.has(name.split(/\s+/)[0].toLowerCase()) && name.length <= 60) return name
  }
  const labelMatch = t.match(/\bDeveloper[:\-]\s*([A-Za-z0-9&.\-\s]{3,50})/i)
  if (labelMatch) return clean(labelMatch[1])
  return null
}

// Property type — only set from an explicit keyword in the listing's own
// text (never defaulted to "Apartment" just because a BHK config is
// present, since that would be a guess, not an extracted fact).
const PROPERTY_TYPE_TERMS = [
  ['villa', 'Villa'], ['penthouse', 'Penthouse'], ['row house', 'Row House'],
  ['bungalow', 'Bungalow'], ['plot', 'Plot'], ['studio', 'Studio Apartment'],
  ['duplex', 'Duplex'],
]
function extractPropertyType(text) {
  const t = String(text || '').toLowerCase()
  for (const [term, label] of PROPERTY_TYPE_TERMS) if (t.includes(term)) return label
  return null
}

// Real-estate portals per market, used to bias generic web-search connectors
// (Google CSE, Apify's Google-search actor) toward pages that are actually
// listings rather than news/blogs/builder-marketing pages that happen to rank
// for the same terms. Neither connector has a native "real estate only"
// mode — this is the cheapest lever available without a dedicated portal API.
const PORTAL_SITES = {
  india: ['99acres.com', 'magicbricks.com', 'housing.com'],
  dubai: ['bayut.com', 'propertyfinder.ae', 'dubizzle.com'],
}
function biasQueryToPortals(query, market) {
  const sites = PORTAL_SITES[market] || PORTAL_SITES.india
  return `${query} (${sites.map(s => `site:${s}`).join(' OR ')})`
}

// Attaches connectorId/status/detail onto the thrown Error so callers
// (external-search.cjs) can build a specific, actionable message instead of
// a bare "Google CSE 403" — e.g. surfacing the real Google API error body
// ("This project does not have the access to Custom Search JSON API").
async function connectorError(id, res) {
  let detail = ''
  try {
    const body = await res.json()
    detail = body?.error?.message || body?.message || ''
  } catch (_) { /* body wasn't JSON — status code is all we have */ }
  const err = new Error(detail ? `${res.status}: ${detail}` : `HTTP ${res.status}`)
  err.connectorId = id
  err.status = res.status
  return err
}

function baseExternalProject({ name, sourceUrl, sourceName, description, market, currency, sourceQuality = 'medium' }) {
  const text = `${name} ${description || ''}`
  return {
    id: sourceUrl || `${sourceName}:${name}`,
    market, country: market === 'dubai' ? 'UAE' : 'India', currency,
    city: null, location: null, community: null,
    name: clean(name), developer: extractDeveloperGuess(text),
    configuration: extractConfiguration(text) || null,
    bedrooms: (() => { const m = text.match(/(\d+)\s*(?:BHK|bed(?:room)?s?)/i); return m ? parseInt(m[1], 10) : null })(),
    budgetMin: null, budgetMax: extractBudgetMax(text, currency),
    possessionDate: null, handoverDate: extractPossession(text) || null,
    propertyType: extractPropertyType(text),
    sourceName, sourceUrl, lastSeenAt: new Date().toISOString(), sourceQuality,
    description: clean(description || ''), amenities: extractAmenities(text),
  }
}

// ── Google Programmable Search (official API — not scraping) ───────────────
const googleCseConnector = {
  id: 'google-cse', name: 'Google Programmable Search',
  market: ['india', 'dubai'],
  isConfigured() { return !!(process.env.GOOGLE_CUSTOM_SEARCH_API_KEY && process.env.GOOGLE_CUSTOM_SEARCH_CX) },
  async search(query, filters = {}, market = 'india') {
    if (!this.isConfigured()) return []
    const key = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY
    const cx = process.env.GOOGLE_CUSTOM_SEARCH_CX
    const q = encodeURIComponent(biasQueryToPortals(query, market))
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}&num=10`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw await connectorError('google-cse', res)
    const body = await res.json()
    const currency = market === 'dubai' ? 'AED' : 'INR'
    return (body.items || []).map(it => baseExternalProject({
      name: it.title, sourceUrl: it.link, sourceName: it.displayLink || 'Google Search',
      description: it.snippet, market, currency,
    }))
  },
}

// ── Bing Web Search API (official API — not scraping) ──────────────────────
const bingConnector = {
  id: 'bing-search', name: 'Bing Web Search',
  market: ['india', 'dubai'],
  isConfigured() { return !!process.env.BING_SEARCH_API_KEY },
  async search(query, filters = {}, market = 'india') {
    if (!this.isConfigured()) return []
    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(biasQueryToPortals(query, market))}&count=10`
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': process.env.BING_SEARCH_API_KEY },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw await connectorError('bing-search', res)
    const body = await res.json()
    const currency = market === 'dubai' ? 'AED' : 'INR'
    return (body.webPages?.value || []).map(it => baseExternalProject({
      name: it.name, sourceUrl: it.url, sourceName: (() => { try { return new URL(it.url).hostname } catch { return 'Bing Search' } })(),
      description: it.snippet, market, currency,
    }))
  },
}

// ── Apify actor (isolation layer for any real scraping) ────────────────────
// Requires BOTH a token and an actor id — we don't ship a default actor, so
// this stays unconfigured (and inert) until the operator points it at one
// they've verified is ToS-compliant for the target site.
const apifyConnector = {
  id: 'apify-actor', name: 'Apify Actor',
  market: ['india', 'dubai'],
  isConfigured() {
    return process.env.EXTERNAL_SCRAPING_ENABLED === 'true'
      && !!process.env.APIFY_TOKEN
      && !!process.env.APIFY_EXTERNAL_ACTOR_ID
  },
  async search(query, filters = {}, market = 'india') {
    if (!this.isConfigured()) return []
    const actorId = process.env.APIFY_EXTERNAL_ACTOR_ID
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`
    // apify/google-search-scraper's real input schema (confirmed against the
    // Actor's own Input tab): `queries` is a newline-separated STRING, not an
    // array — sending an array is what produced "Field input.queries is
    // required" (the actor's validator rejects the wrong type as absent).
    // There is also no `resultsPerPage` field on this actor; result count is
    // controlled by `maxPagesPerQuery` (~10 organic results per page), so
    // APIFY_MAX_RESULTS is converted into a page count here instead of being
    // sent as a literal field the actor doesn't recognise.
    const maxResults = Number(process.env.APIFY_MAX_RESULTS) || 15
    const maxPagesPerQuery = Math.max(1, Math.ceil(maxResults / 10))
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: biasQueryToPortals(query, market),
        maxPagesPerQuery,
        countryCode: market === 'dubai' ? 'ae' : 'in',
        languageCode: 'en',
      }),
      signal: AbortSignal.timeout(parseInt(process.env.APIFY_TIMEOUT_MS, 10) || 60000),
    })
    if (!res.ok) throw await connectorError('apify-actor', res)
    const items = await res.json()
    const currency = market === 'dubai' ? 'AED' : 'INR'
    // Output shape (per Actor docs): one dataset item PER QUERY PAGE, not per
    // listing — the actual results live nested under organicResults[] (and
    // paidResults[]). Flattening these was missing before; without it every
    // "listing" would have been the search-page wrapper object itself
    // (yielding `name: 'Untitled listing'` for everything, since fields like
    // `title`/`url` don't exist at the top level).
    const rows = (Array.isArray(items) ? items : []).flatMap(page => [
      ...(page.organicResults || []),
      ...(page.paidResults || []),
    ])
    return rows
      .filter(r => r.title && r.url)
      .slice(0, maxResults)
      .map(r => baseExternalProject({
        name: r.title,
        sourceUrl: r.url,
        sourceName: (() => { try { return new URL(r.url).hostname.replace('www.', '') } catch { return `Apify (${actorId})` } })(),
        description: r.description || '',
        market, currency,
      }))
  },
}

// ── Tavily (AI-native web search — official REST API) ──────────────────────
// A "primary" tool alongside Google CSE/Bing rather than a scraper: Tavily
// runs its own retrieval + relevance ranking over the live web and returns
// already-extracted page content, which is what makes it noticeably better
// than a bare search-snippet API at surfacing builder/developer pages and
// project-specific detail pages. Its own LLM-generated `answer` field is
// deliberately never requested (`include_answer: false`) — this app's
// accuracy pipeline (ai-search-agent/agent/normalize.py + scoring.py) is the
// only thing allowed to turn search results into property facts; an AI
// search engine's own summary is exactly the kind of ungrounded text the
// brief's "never let an LLM invent a fact" rule is about.
const tavilyConnector = {
  id: 'tavily', name: 'Tavily AI Search',
  market: ['india', 'dubai'],
  isConfigured() { return process.env.TAVILY_SEARCH_ENABLED === 'true' && !!process.env.TAVILY_API_KEY },
  async search(query, filters = {}, market = 'india') {
    if (!this.isConfigured()) return []
    const depth = filters.depth === 'advanced' ? 'advanced' : (process.env.TAVILY_SEARCH_DEPTH === 'advanced' ? 'advanced' : 'basic')
    const maxResults = Number(process.env.TAVILY_MAX_RESULTS) || 10
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: biasQueryToPortals(query, market),
        search_depth: depth,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(parseInt(process.env.TAVILY_TIMEOUT_MS, 10) || 15000),
    })
    if (!res.ok) throw await connectorError('tavily', res)
    const body = await res.json()
    const currency = market === 'dubai' ? 'AED' : 'INR'
    return (body.results || [])
      .filter(r => r.title && r.url)
      .slice(0, maxResults)
      .map(r => baseExternalProject({
        name: r.title, sourceUrl: r.url,
        sourceName: (() => { try { return new URL(r.url).hostname.replace('www.', '') } catch { return 'Tavily' } })(),
        description: r.content || '', market, currency,
        sourceQuality: typeof r.score === 'number' && r.score >= 0.6 ? 'high' : 'medium',
      }))
  },
}

// ── Stub descriptors — documented adapter shape for future partner APIs.
// Always unconfigured; exist so the registry/status UI can show "not
// connected yet" per source instead of pretending these don't exist.
function stub(id, name, market, note) {
  return { id, name, market, note, isConfigured: () => false, async search() { return [] } }
}
const stubConnectors = [
  stub('99acres', '99acres', ['india'], 'Needs a 99acres partner/API agreement — no public listing API today.'),
  stub('magicbricks', 'MagicBricks', ['india'], 'Needs a MagicBricks partner/API agreement — no public listing API today.'),
  stub('google-ads-landing', 'Google Ads Landing Pages', ['india', 'dubai'], 'Needs an internal feed of tracked landing-page URLs to index — not a search API.'),
  stub('bayut', 'Bayut', ['dubai'], 'Needs a Bayut partner/API agreement — no public listing API today.'),
  stub('property-finder', 'Property Finder', ['dubai'], 'Needs a Property Finder partner/API agreement — no public listing API today.'),
  stub('developer-sites', 'Developer Websites', ['india', 'dubai'], 'Needs a per-developer feed/sitemap list to index.'),
]

const CONNECTORS = [tavilyConnector, googleCseConnector, bingConnector, apifyConnector, legacyPortalConnector, ...stubConnectors]

function getConnectorStatus() {
  return CONNECTORS.map(c => ({ id: c.id, name: c.name, market: c.market, configured: c.isConfigured(), note: c.note || null }))
}

module.exports = { CONNECTORS, getConnectorStatus, tavilyConnector, googleCseConnector, bingConnector, apifyConnector, legacyPortalConnector }
