'use strict'

// Orchestrates AI Search (external/non-IndiHomes properties): connectors ->
// normalize -> Azure AI Search external index -> query. No Claude anywhere
// in this file — that's the whole point of this rework (brief rule 3).

const azureSearch = require('./azure-search.cjs')
const { CONNECTORS, getConnectorStatus } = require('./external-connectors.cjs')
const scoring = require('./scoring.cjs')
const queryParser = require('./query-parser.cjs')

function isEnabled() { return process.env.EXTERNAL_SEARCH_ENABLED === 'true' }
// Dev-only debug trace (Part 27) — same server-side-only gate as the Python
// agent's curator.py (AI_SEARCH_DEBUG_TRACE=true). Never a client-supplied
// flag, so a production deployment that never sets this env var never
// computes or sends rejection reasons over the wire at all.
function isDebugTraceEnabled() { return process.env.AI_SEARCH_DEBUG_TRACE === 'true' }

let externalIndexEnsured = false
async function ensureOnce() {
  if (externalIndexEnsured || !azureSearch.isConfigured()) return
  await azureSearch.ensureExternalIndex()
  externalIndexEnsured = true
}

function getStatus() {
  return {
    enabled: isEnabled(),
    azureConfigured: azureSearch.isConfigured(),
    connectors: getConnectorStatus(),
  }
}

// Runs every configured connector for this market, merges + dedupes by
// sourceUrl, and pushes the result into the Azure external index. Never
// throws — a single connector failing (rate limit, bad key, network) must
// not take AI Search down — but the failure is now returned to the caller
// (not just logged) so queryExternal can surface it instead of quietly
// serving an empty result.
async function refreshExternalIndex(query, filters, market, connectors) {
  const list = connectors || CONNECTORS.filter(c => c.market.includes(market) && c.isConfigured())
  if (!list.length) return { merged: [], connectorErrors: [] }
  const settled = await Promise.allSettled(list.map(c => c.search(query, filters, market)))
  const merged = []
  const seen = new Set()
  const connectorErrors = []
  settled.forEach((r, i) => {
    const connector = list[i]
    if (r.status === 'rejected') {
      const message = r.reason?.message || 'Unknown error'
      console.warn(`[external-search] connector ${connector.id} failed:`, message)
      connectorErrors.push({ id: connector.id, name: connector.name, message, status: r.reason?.status || null })
      return
    }
    // Diagnostic: a connector can resolve successfully with zero items (bad
    // query shape, no matching results, empty dataset) and that's silent
    // everywhere else — this is the only place that distinguishes "failed"
    // from "ran fine but found nothing", which matters when the UI shows no
    // cards and no error either.
    console.log(`[external-search] connector ${connector.id} returned ${(r.value || []).length} item(s)`)
    for (const item of (r.value || [])) {
      const key = item.sourceUrl || `${item.sourceName}:${item.name}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  })
  if (merged.length) {
    await ensureOnce()
    await azureSearch.syncExternalListings(merged).catch(e => console.error('[external-search] sync failed:', e.message))
  }
  return { merged, connectorErrors }
}

// Turns a connector failure list into one clear, actionable sentence for the
// UI. Only fires when EVERY connector that was actually tried failed — a
// partial failure (e.g. Google down, Bing still returning results) doesn't
// need an alarming banner, connectorErrors alone covers that case.
// Deliberately GENERIC — never names a connector or repeats its error text.
// A salesperson using AI Search has no action to take on "Google Custom
// Search: 403: this project does not have access to Custom Search JSON
// API"; that's an operator/deployment concern. The real per-connector
// detail is still fully available server-side (console.warn in
// refreshExternalIndex, and the `connectorErrors` array this function's
// caller keeps internally) for whoever configures this deployment — it's
// just never forwarded into user-facing copy or the HTTP response.
function buildConnectorFailureMessage(connectorErrors, triedCount) {
  if (!connectorErrors.length || connectorErrors.length < triedCount) return null
  return 'No external listings available right now — the connected source(s) didn\'t return results for this search. Try a different search or check back later.'
}

// RERA number extraction — purely extractive (regex against real listing
// text), never fabricated. External listings previously hardcoded rera:
// null unconditionally ("external listings are never IndiHomes-verified"),
// which conflated "not verified against the government registry" with "no
// RERA number visible at all" — a portal listing's own title/snippet
// frequently states its RERA number directly, and that's real, useful,
// extractable information even though it hasn't been cross-checked with
// MahaRERA the way an IndiHomes-catalog project's has (see `rera_verified`,
// still null here — that distinction is preserved, just not conflated with
// "no code visible on the listing text").
// Maharashtra RERA codes are commonly P/PR/PM/PA + ~9-13 digits (examples
// seen live in this app: P51800079751, PM1180002502869, PR1180002601346) —
// deliberately loose enough to catch the real variants, anchored on word
// boundaries so it doesn't match inside an unrelated longer number string.
const RERA_PATTERN = /\b(P[A-Z]{0,2}\d{9,13})\b/i
function extractReraFromText(...texts) {
  for (const t of texts) {
    const m = RERA_PATTERN.exec(String(t || ''))
    if (m) return m[1].toUpperCase()
  }
  return null
}

// ── Sub-listing extraction from rejected category/search-results pages ────
// Mirrors agent/agent/fact_extraction.py's extract_sub_listings exactly
// (same reasoning, same RERA-anchored discipline — see that function's own
// comment for the full writeup). A page correctly rejected as a category
// page by isAggregatorTitle() can still name real, individually-identifiable
// projects in its own body text, each with genuine RERA/price/carpet-area
// facts. Confirmed live: "...Jadeite Kaveri... P51800079530 is the RERA
// number of the project Jadeite Kaveri...". Deterministic-only, no LLM —
// a sub-listing is only ever created when a real, shape-validated RERA
// number anchors it; no RERA match nearby means no sub-listing.
const RERA_GLOBAL_PATTERN = /\b(P[A-Z]{0,2}\d{9,13})\b/gi
const RERA_OF_PROJECT_RE = /is\s+the\s+rera\s+number\s+of\s+the\s+project\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?=[.,;:\n]|\s+(?:with|located|is|has|offers)\b|$)/i
const TITLE_CASE_PHRASE_RE = /\b(?:[A-Z][a-z0-9]+(?:\s+|-)){1,4}[A-Z][a-z0-9]+\b/g
// Same fixed word list as normalize.py's GENERIC_FILLER_WORDS — "the same
// word means the same thing" across both pipelines.
const GENERIC_FILLER_WORDS = new Set([
  'bhk', 'flat', 'flats', 'apartment', 'apartments', 'property', 'properties',
  'house', 'houses', 'for', 'sale', 'rent', 'in', 'near', 'below', 'resale',
  'bedroom', 'luxury', 'budget', 'cr', 'crore', 'l', 'lakh', 'lakhs', 'and', 'the',
])
function isGenericPhrase(phrase) {
  const words = (String(phrase || '').match(/[A-Za-z]+/g) || [])
  return !words.length || words.every(w => GENERIC_FILLER_WORDS.has(w.toLowerCase()))
}
function nearestProjectName(text, reraStart, reraEnd) {
  const window = text.slice(Math.max(0, reraStart - 40), Math.min(text.length, reraEnd + 160))
  const explicit = RERA_OF_PROJECT_RE.exec(window)
  if (explicit) {
    const name = clean(explicit[1])
    if (name && !isGenericPhrase(name)) return name
  }
  const before = text.slice(Math.max(0, reraStart - 150), reraStart)
  const beforeMatches = [...before.matchAll(TITLE_CASE_PHRASE_RE)].map(m => m[0]).filter(p => !isGenericPhrase(p))
  if (beforeMatches.length) return clean(beforeMatches[beforeMatches.length - 1])
  const after = text.slice(reraEnd, Math.min(text.length, reraEnd + 150))
  const afterMatches = [...after.matchAll(TITLE_CASE_PHRASE_RE)].map(m => m[0]).filter(p => !isGenericPhrase(p))
  if (afterMatches.length) return clean(afterMatches[0])
  return null
}
// Bounds fact extraction to sentences that actually mention THIS project's
// own name — a fixed character radius alone bleeds a NEIGHBORING project's
// price/area/possession into this one when several are described close
// together in the same category-page paragraph (confirmed during
// development, same bug the Python mirror was fixed for).
function sentencesMentioningName(text, name, reraStart, reraEnd, radius = 400) {
  const window = text.slice(Math.max(0, reraStart - radius), Math.min(text.length, reraEnd + radius))
  const sentences = window.split(/(?<=[.!?])\s+/)
  const nameLower = name.toLowerCase()
  const kept = sentences.filter(s => s.toLowerCase().includes(nameLower))
  return kept.length ? kept.join(' ') : window
}
// Deliberately minimal field set: this pipeline's OWN downstream .map()
// step (below) already re-derives RERA (extractReraFromText), carpet
// area/floors/connectivity (extractPropertyFacts), and lifecycle
// (scoring.classifyLifecycleStatus) straight from `doc.name` + `doc.
// description` for EVERY candidate — a sub-listing only needs to look
// like a normal discovered `doc` (a real name + a real, sentence-scoped
// description containing its own RERA/price/possession text) for all of
// that existing machinery to apply identically, with no duplicate
// extraction logic here. `budgetMax` is the one field read straight off
// the object rather than re-parsed from text downstream, so it's set
// explicitly via the same extractor query-parser.cjs already uses.
function extractSubListings(doc) {
  const text = `${doc.name || ''} ${doc.description || ''}`.trim()
  if (!text) return []
  const subItems = []
  const seenRera = new Set()
  const seenNames = new Set()
  let m
  RERA_GLOBAL_PATTERN.lastIndex = 0
  while ((m = RERA_GLOBAL_PATTERN.exec(text))) {
    const rera = m[1].toUpperCase()
    if (seenRera.has(rera)) continue
    const name = nearestProjectName(text, m.index, m.index + m[0].length)
    if (!name || seenNames.has(name.toLowerCase())) continue
    seenRera.add(rera)
    seenNames.add(name.toLowerCase())
    const factWindow = sentencesMentioningName(text, name, m.index, m.index + m[0].length)
    const currency = doc.currency === 'AED' ? 'AED' : 'INR'
    subItems.push({
      name, description: factWindow.trim(),
      sourceName: doc.sourceName, sourceUrl: doc.sourceUrl, sourceQuality: doc.sourceQuality,
      location: doc.location, community: doc.community, city: doc.city, market: doc.market, currency: doc.currency,
      budgetMax: queryParser.extractBudgetMax(factWindow, currency),
      possessionDate: queryParser.extractPossession(factWindow) || null,
      lastSeenAt: doc.lastSeenAt,
      // Provenance (Part 2, follow-up spec) — mirrors Python's
      // source_type: "category_page_extract" so this can be told apart
      // from a page fetched/scraped directly for this specific project.
      _fromCategoryPageExtract: true,
    })
  }
  return subItems
}

// ── Canonical candidate ID (Part P1.2) — this pipeline (the legacy
// connector path) never assigned an `id` at all, unlike the LangGraph
// agent path (agent/dedupe.py's deterministic dedup key), which left
// ProjectSelection.jsx's toAnalysableProject() with only an array-index +
// Date.now() identity for a result from this path — the exact "identity
// must not depend on array position" gap Part P1.2 flags. Same priority
// order as dedupe.py: RERA (authoritative) -> normalized name+location ->
// source URL, so a candidate's identity is deterministic/reproducible
// across requests, never a runtime index.
// Portal titles for the SAME project routinely differ only by which page of
// that portal they came from — a price page, an FAQ page, a brochure page —
// e.g. "Arkade Eden Malad West: Price, Photos & Floor Plans" vs "Arkade
// Eden FAQs - Malad West, Mumbai". Confirmed live (2026-08-17 verification
// run): distinct portal pages for the same project landed as separate,
// undeduplicated candidates because the raw name string (including this
// furniture) was what got compared. Stripping these known portal-furniture
// words before building the identity key (never touching the name actually
// displayed to the user) collapses them onto the same core. Mirrors
// agent/dedupe.py's _core_name_key exactly. Conservative and explicit — a
// fixed word list, not a fuzzy/similarity match, so it can't accidentally
// merge two genuinely different projects that happen to share a real name
// fragment.
const PORTAL_NOISE_RE = /\bprice(\s*sheet|\s*list)?\b|\bphotos?\b|\bfloor\s*plans?\b|\bfaqs?\b|\bbrochure\b|\bpros\s*(&|and)?\s*cons\b|\breviews?\b|\boverview\b|\bgallery\b|\bamenities\b|\bvideo\s*tour\b|\bmap\b/gi
function coreNameKey(name) { return clean(String(name || '').replace(PORTAL_NOISE_RE, '')) }

function buildCanonicalCandidateId({ rera, name, location, sourceUrl }) {
  if (rera) return `rera:${String(rera).toUpperCase()}`
  // Each field is sanitized to bare [a-z0-9] INDEPENDENTLY before joining —
  // the previous version built "${name}::${location}" first and ran one
  // shared regex pass that special-cased `:` to survive the strip, which
  // meant a literal colon anywhere in the ORIGINAL name/location text (not
  // just the intentional "::" separator inserted here) leaked into the key.
  // Confirmed live: "Arkade Eden Malad West: Price..." (colon before the
  // noise word) and "Arkade Eden Malad West - Brochure..." (dash, not
  // colon, in the same spot) produced two DIFFERENT keys after noise-
  // stripping even though they're the same project — the stray colon from
  // the first title's own punctuation was the actual cause, not the noise
  // words. Sanitizing per-field first makes the join symbol the only colon
  // that can ever appear, matching agent/dedupe.py's _key()/_core_name_key
  // behavior (which strips ALL non-alphanumeric chars) exactly.
  const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const nameKey = sanitize(coreNameKey(name || ''))
  const locKey = sanitize(clean(location || ''))
  const key = `${nameKey}::${locKey}`
  if (nameKey || locKey) return `nameloc:${key}`
  if (sourceUrl) return `url:${Buffer.from(sourceUrl).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)}`
  // Deliberately NOT Math.random() (Part 8's explicit rule) — a candidate
  // with no name/location/URL at all has essentially nothing to identify it
  // by, but the id must still be reproducible for the SAME degenerate input
  // across requests/re-renders, not a fresh random string every time. A
  // short hash of whatever raw fields exist (even if empty) is deterministic
  // and stable; genuinely distinct degenerate candidates naturally still
  // collide with each other here, which is fine — there's nothing real to
  // tell them apart by in the first place.
  const crypto = require('crypto')
  const digest = crypto.createHash('sha1').update(`${name || ''}|${location || ''}|${sourceUrl || ''}`).digest('hex').slice(0, 16)
  return `anon:${digest}`
}

// ── Additional structured-fact extraction from a listing's own title/snippet
// text — purely extractive (regex against real text already fetched for
// this result), never a second web request and never an LLM call, per
// Part 17's cost rule ("prefer extraction over LLM enrichment"). Each field
// stays null when the pattern isn't found rather than guessed — same
// "never fabricate" convention as extractReraFromText above.
function extractAreaFacts(text) {
  const t = String(text || '')
  let carpetArea = null, builtUpArea = null
  // Scan every "<number> sq ft" mention and bucket it by the word (carpet /
  // built-up / super built-up) appearing within a ~20-char window on EITHER
  // side of it — real listings write both "650 sq ft carpet" (label after
  // the number) and "carpet area: 650 sq ft" (label before) — so
  // "650 sq ft carpet, 820 sq ft built-up" AND "carpet 650 sq ft, built-up
  // 820 sq ft" both correctly yield both figures, not just the first match.
  const re = /(\d{3,5})\s*sq\.?\s*\.?\s*ft\.?/gi
  let m
  while ((m = re.exec(t))) {
    const windowStart = Math.max(0, m.index - 20)
    const windowEnd = Math.min(t.length, m.index + m[0].length + 20)
    const around = t.slice(windowStart, windowEnd).toLowerCase()
    const label = `${m[1]} sq ft`
    if (/carpet/.test(around) && !carpetArea) carpetArea = label
    else if (/(built[\s-]?up|super\s*built)/.test(around) && !builtUpArea) builtUpArea = label
    else if (!carpetArea) carpetArea = label
  }
  return { carpetArea, builtUpArea }
}

function extractTotalFloors(text) {
  const t = String(text || '')
  const gPlus = t.match(/\bG\s*\+\s*(\d{1,3})\b/i)
  if (gPlus) return `G+${gPlus[1]}`
  const floors = t.match(/(\d{1,3})\s*floors?\b/i)
  if (floors) return `${floors[1]} floors`
  const towers = t.match(/(\d{1,2})\s*towers?\b/i)
  if (towers) return `${towers[1]} towers`
  return null
}

// Connectivity — only captured when the snippet actually names a transit
// landmark AND a distance/time, never a bare mention of "metro" with no
// real measurement attached (that would be closer to a guess than a fact).
const CONNECTIVITY_RE = /((?:metro|railway|rail(?:way)?\s*station|station|airport|highway|expressway)[^.]{0,45}?\d+(?:\.\d+)?\s*(?:km|kms|kilometers?|min|mins|minutes))/i
function extractConnectivity(text) {
  const m = CONNECTIVITY_RE.exec(String(text || ''))
  return m ? clean(m[1]) : null
}

function extractPropertyFacts(text) {
  const { carpetArea, builtUpArea } = extractAreaFacts(text)
  return {
    carpetArea, builtUpArea,
    totalFloors: extractTotalFloors(text),
    connectivity: extractConnectivity(text),
  }
}
function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim() }

// A purely structural "how much did we actually learn about this listing"
// signal — counts real, non-fabricated fields present on the normalized
// result. Never a proxy for match quality (that's `confidence`); this is
// about completeness of the underlying facts, per Part 10.
function computeDataQuality(fields) {
  const present = ['developer', 'price', 'possession', 'rera', 'carpetArea', 'builtUpArea', 'connectivity']
    .filter(k => fields[k] != null && fields[k] !== '').length
    + (fields.amenities?.length ? 1 : 0)
  if (present >= 5) return 'high'
  if (present >= 2) return 'medium'
  return 'low'
}

// ── Cross-source dedup/merge — two connectors (e.g. Google CSE and Tavily,
// or a generic web result and the direct 99acres/MagicBricks scrape) can
// both surface the SAME real project under two different URLs. The
// sourceUrl-keyed dedup in refreshExternalIndex already collapses an exact
// repeated URL; this collapses the same PROJECT across different URLs/
// sources by exact normalized-name match — deliberately conservative (exact
// match only, no fuzzy distance) so two genuinely different projects with
// similar names are never merged into one. Missing fields on the kept
// result are backfilled from a duplicate that has them (never overwritten
// once real), and every contributing source is preserved in `sources` —
// see Part 11 ("Sources: MagicBricks + Developer Website").
// Part 6 fix — this key used to be name-only (no location component, no
// portal-furniture stripping), which had TWO real bugs: (1) the same
// portal-page-title noise buildCanonicalCandidateId already had to strip
// (see its own comment) blocked an exact-name merge here too, since this
// is a SEPARATE key-building function, not a shared one; (2) dropping
// location entirely meant two DIFFERENT real projects that happen to
// share an identical name in two different cities/localities would have
// silently merged into one. Now mirrors buildCanonicalCandidateId's own
// name+location key exactly.
function normalizedNameKey(name, location) {
  const nameKey = coreNameKey(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const locKey = clean(location || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return `${nameKey}::${locKey}`
}

// Part 6 fuzzy tier — mirrors agent/dedupe.py's _fuzzy_match exactly (see
// its own comment for the full reasoning): only reached when the exact
// name+location key above misses, and only merges when MULTIPLE
// independent signals agree — name-token overlap alone is never enough,
// since two genuinely different projects routinely share a generic word
// ("Heights", "Residency", "Garden", a compass direction). No lat/lon
// proximity signal is available at this pipeline stage either (same
// disclosed limitation as the Python side).
const GENERIC_PROJECT_WORDS = new Set([
  'heights', 'residency', 'enclave', 'residences', 'towers', 'tower',
  'apartments', 'apartment', 'homes', 'home', 'gardens', 'garden',
  'greens', 'green', 'park', 'phase', 'west', 'east', 'north', 'south',
  'project', 'residential', 'properties', 'property',
])
function nameTokens(name) {
  const stripped = coreNameKey(name).toLowerCase()
  const words = (stripped.match(/[a-z0-9]+/g) || [])
  return new Set(words.filter(w => !GENERIC_PROJECT_WORDS.has(w)))
}
function fuzzyMatch(a, b) {
  const ta = nameTokens(a.name), tb = nameTokens(b.name)
  if (!ta.size || !tb.size) return false
  const inter = [...ta].filter(t => tb.has(t)).length
  const union = new Set([...ta, ...tb]).size
  if (inter / union < 0.5) return false
  const devA = clean(a.developer || '').toLowerCase(), devB = clean(b.developer || '').toLowerCase()
  const sameDeveloper = !!devA && !!devB && devA === devB
  const locA = clean(a.location || '').toLowerCase(), locB = clean(b.location || '').toLowerCase()
  const sameLocality = !!locA && !!locB && (locA === locB || locA.includes(locB) || locB.includes(locA))
  return sameDeveloper || sameLocality
}

function mergeDuplicateProperties(list) {
  const groups = new Map()
  const singles = []
  for (const p of list) {
    const exactKey = normalizedNameKey(p.name, p.location)
    if (!exactKey.replace(/[^a-z0-9]/g, '')) { singles.push(p); continue }
    let key = exactKey
    if (!groups.has(key)) {
      // Fuzzy tier — only tried once the exact key above misses. Small
      // per-search candidate counts make an O(existing groups) scan per
      // candidate cheap; correctness over cleverness here.
      for (const [existingKey, existingGroup] of groups) {
        if (fuzzyMatch(existingGroup[0], p)) { key = existingKey; break }
      }
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }
  const merged = [...singles]
  for (const group of groups.values()) {
    if (group.length === 1) { merged.push(group[0]); continue }
    group.sort((a, b) => (b.match_score || 0) - (a.match_score || 0) || String(a.id || '').localeCompare(String(b.id || '')))
    const best = { ...group[0] }
    const seenSrc = new Set()
    const allSources = []
    for (const g of group) {
      for (const s of (g.sources || [])) {
        const sk = s.url || s.name
        if (sk && !seenSrc.has(sk)) { seenSrc.add(sk); allSources.push(s) }
      }
      for (const f of ['developer', 'location', 'config', 'price', 'possession', 'rera', 'description', 'carpetArea', 'builtUpArea', 'totalFloors', 'connectivity', 'propertyType']) {
        if ((best[f] == null || best[f] === '') && g[f] != null && g[f] !== '') best[f] = g[f]
      }
      if (Array.isArray(g.amenities) && g.amenities.length > (best.amenities?.length || 0)) best.amenities = g.amenities
    }
    best.sources = allSources
    if (allSources.length > 1) best.sourceName = allSources.map(s => s.name).filter(Boolean).join(' + ')
    merged.push(best)
  }
  // Deterministic ranking (Part 8/11): match_score first, then a stable
  // id-based tie-breaker — without it, two candidates tied on score keep
  // whatever order the connectors' Promise.allSettled fan-out (refreshExternalIndex
  // above) happened to resolve in, which can differ run-to-run for the
  // SAME query and SAME underlying data. Mirrors agent/agent/scoring.py's
  // score_all() tie-breaker exactly, so both search pipelines are
  // consistent about this.
  return merged.sort((a, b) => (b.match_score || 0) - (a.match_score || 0) || String(a.id || '').localeCompare(String(b.id || '')))
}

async function queryExternal(query, filters = {}, market = 'india', { skip = 0, top = 20 } = {}) {
  if (!isEnabled()) {
    return { configured: false, enabled: false, market, properties: [], total: 0, message: 'External Search is not enabled. Set EXTERNAL_SEARCH_ENABLED=true on the server once at least one source connector is configured.' }
  }
  if (!azureSearch.isConfigured()) {
    return { configured: false, enabled: true, market, properties: [], total: 0, message: 'Azure AI Search is not configured. Set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_ADMIN_KEY on the server.' }
  }
  const activeConnectors = CONNECTORS.filter(c => c.market.includes(market) && c.isConfigured())
  if (!activeConnectors.length) {
    return { configured: true, enabled: true, market, properties: [], total: 0, message: `No external source connectors are configured yet for the ${market === 'dubai' ? 'Dubai' : 'India'} market (e.g. Google Custom Search, Bing Web Search, or an Apify actor). Add credentials to enable live external results.` }
  }

  const refreshResult = await refreshExternalIndex(query, filters, market, activeConnectors)
    .catch(e => {
      console.error('[external-search] refresh failed:', e.message)
      return { merged: [], connectorErrors: [{ id: 'unknown', name: 'External search', message: e.message, status: null }] }
    })
  const connectorErrors = refreshResult.connectorErrors || []
  await ensureOnce()

  const azureFilters = { market, locations: filters.locations, currency: market === 'dubai' ? 'AED' : 'INR' }
  const result = await azureSearch.searchExternal(query, azureFilters, { skip, top })
  const rejectedForDebug = []
  // Whole-phrase location terms (Part 1) — the query's own free-text
  // location mentions PLUS whatever explicit filter chips the frontend
  // sent, deduped. Both are already real, extractive signals (never
  // guessed) — extractLocations mirrors agent/query_understanding.py's
  // extract_locations exactly.
  const locationTerms = [...new Set([...(filters.locations || []), ...queryParser.extractLocations(query)])].filter(t => t && t.length >= 3)
  // Part 2 (follow-up spec) — a page whose OWN title correctly reads as a
  // category/search-results page can still have real, individually-named
  // projects sitting in its own description text, each anchored by a
  // genuine RERA number — confirmed live. Expand FIRST (mirrors agent/
  // agent/normalize.py's normalize_all exactly): the wrapper page still
  // goes on to fail the aggregator check below and gets rejected as
  // always; each extracted sub-listing is a normal-shaped `doc` that
  // flows through the SAME filter/lifecycle/geography/scoring pipeline as
  // any other discovered candidate, never a second path.
  const expandedResults = (result.results || []).flatMap(doc => [doc, ...(scoring.isAggregatorTitle(doc.name) ? extractSubListings(doc) : [])])
  // Part 4 — structured, non-string-matched counts (incremented at the
  // exact point each disqualifier fires, never inferred later from a
  // rejection reason STRING, which would silently break if that wording
  // changes) so a zero/thin result set's root cause is answerable: no
  // eligible projects vs. sources returned only category pages vs.
  // resale/rental vs. lifecycle unverified vs. an upstream source
  // failure (cross-reference connectorErrors for that last case).
  // `total` counts the EXPANDED pool (post category-page-extraction) —
  // matches agent/agent/curator.py's _retrieval_metrics, which counts
  // deduplicated_properties (also post-expansion), not the raw pre-
  // extraction retrieval count.
  const retrievalCounts = { total: expandedResults.length, aggregator: 0, resale: 0, rental: 0, unknown: 0 }
  const rawProperties = expandedResults
    // Guide/category/aggregator pages ("Complete Guide: How to Buy...",
    // "14+ Flats for Sale in Liberty Garden") are excluded outright here,
    // not just down-ranked — the previous behavior (a -20% quality penalty
    // inside scoreExternalProject) still let them appear in the results list
    // at a lower position, which read as "guides mixed in with listings" to
    // anyone scrolling past the first couple of results. A real listing
    // whose title happens to trip this pattern is an acceptable rare
    // false-positive versus routinely showing non-listings as search results.
    .filter(doc => {
      if (scoring.isAggregatorTitle(doc.name)) {
        retrievalCounts.aggregator++
        if (isDebugTraceEnabled()) rejectedForDebug.push({ name: doc.name, reason: 'Reads like a portal category/search-results page, not an individual project listing' })
        return false
      }
      return true
    })
    // Follow-up spec — confirmed live: a search connector returned a
    // candidate sourced from an unrelated domain (a German butcher shop's
    // site) indexed with keyword-stuffed text mentioning the searched
    // locality/possession year, but whose actual content is shopping/
    // e-commerce spam, not a real-estate listing at all — passed the
    // aggregator check (title doesn't read as a category page) untouched.
    .filter(doc => {
      const unrelated = scoring.looksLikeUnrelatedCommerce(`${doc.name || ''} ${doc.description || ''}`)
      if (unrelated) {
        if (isDebugTraceEnabled()) rejectedForDebug.push({ name: doc.name, reason: 'Reads like unrelated shopping/e-commerce content, not a real-estate listing', evidence: unrelated })
        return false
      }
      return true
    })
    // Hard lifecycle/transaction-type eligibility gate (Part 1-3) — a
    // resale/rental listing can be perfectly well-formed (a real title,
    // price, BHK, description) and still sail through the aggregator check
    // above untouched, because it LOOKS like an individual listing page.
    // This is the second, independent gate: even a well-formed individual
    // listing is rejected outright (never merely down-ranked) if it isn't
    // an eligible new-project lifecycle stage. Deterministic, no LLM.
    .filter(doc => {
      const { status, evidence } = scoring.classifyLifecycleStatus(doc)
      doc._lifecycleStatus = status // stashed for the .map() below, avoids re-classifying
      doc._lifecycleEvidence = evidence
      if (!scoring.ALLOWED_LIFECYCLE_STATUSES.has(status)) {
        if (status === 'RESALE') retrievalCounts.resale++
        else if (status === 'RENTAL') retrievalCounts.rental++
        else retrievalCounts.unknown++ // READY_TO_MOVE + UNKNOWN — neither is an eligible new-project stage
        if (isDebugTraceEnabled()) {
          const reason = {
            RESALE: 'Resale listing — not new-project inventory',
            RENTAL: 'Rental listing — not for sale',
            READY_TO_MOVE: 'Ready-to-move / completed inventory — outside the active new-project search policy',
            UNKNOWN: 'Lifecycle stage could not be confidently determined',
          }[status] || `Lifecycle status '${status}' not eligible for Project Search`
          rejectedForDebug.push({ name: doc.name, reason })
        }
        return false
      }
      return true
    })
    // Part 1 — geography/locality relevance gate. Confirmed live (2026-08-17):
    // a Mumbai search for "Liberty Garden" surfaced a Las Vegas, NV
    // home-builder listing ("Liberty at Mayfield") purely because its name
    // contains the single word "Liberty" — location was only ever a SCORING
    // dimension (scoreExternalProject's soft cap-at-55 rule), never a hard
    // gate, so nothing stopped a coincidental word match from reaching final
    // results when nothing better survived the lifecycle filter above.
    // Deliberately WHOLE-PHRASE matching (never split into individual
    // words) — "Liberty" alone must not satisfy "Liberty Garden". Skipped
    // entirely when the query has no resolvable location at all (nothing to
    // check against). Mirrors agent/graph.py's _matches_searched_location.
    .filter(doc => {
      if (!locationTerms.length) return true
      const text = `${doc.name || ''} ${doc.location || ''} ${doc.community || ''} ${doc.city || ''} ${doc.description || ''}`.toLowerCase()
      if (locationTerms.some(t => text.includes(t.toLowerCase()))) return true
      if (isDebugTraceEnabled()) rejectedForDebug.push({ name: doc.name, reason: 'Does not appear to be located in the searched area — no match to the searched locality/city found in this candidate\'s own text' })
      return false
    })
    .map(doc => {
      // Weighted against the ACTUAL parsed query filters (budget/location/
      // config/possession), not just source quality/freshness — three
      // differently-matching listings no longer land on the same flat
      // score. `filters` here is this function's own parsed-query argument,
      // already in scope.
      const { confidence, freshnessLabel, reasons } = scoring.scoreExternalProject(doc, filters)
      const extractedRera = extractReraFromText(doc.name, doc.description)
      // Extracted straight from this same result's own text — no extra web
      // request, no LLM call (see extractPropertyFacts' header comment).
      const facts = extractPropertyFacts(`${doc.name} ${doc.description || ''}`)
      // Amenity match reasoning — query-parser already extracts requested
      // amenities (filters.amenities, e.g. "deck") but scoring.cjs never
      // scored against them; folded in here as a reason-only signal (not a
      // score dimension) so "Matches: 2 BHK · Liberty Garden · deck" is
      // possible without changing the underlying confidence weighting.
      const matchedAmenities = (filters.amenities || []).filter(a => (doc.amenities || []).some(x => String(x).toLowerCase().includes(String(a).toLowerCase())))
      const allReasons = matchedAmenities.length ? [...reasons, `${matchedAmenities.join(', ')} available`] : reasons
      const propertyResult = {
        id: buildCanonicalCandidateId({ rera: extractedRera, name: doc.name, location: doc.location || doc.community || doc.city, sourceUrl: doc.sourceUrl }),
        name: doc.name, developer: doc.developer, location: doc.location || doc.community || doc.city,
        config: doc.configuration, bedrooms: doc.bedrooms,
        propertyType: doc.propertyType || null,
        price: doc.budgetMax ? `${doc.currency === 'AED' ? 'AED ' : '₹'}${doc.budgetMax.toLocaleString('en-IN')}` : null,
        possession: doc.handoverDate || doc.possessionDate || null,
        market: doc.market, currency: doc.currency, community: doc.community, city: doc.city,
        // Extracted from the listing's own title/snippet text when present
        // (see extractReraFromText above) — real, but not cross-checked
        // against MahaRERA/DLD the way an IndiHomes-catalog project's RERA
        // is. rera_verified stays null (never fabricated as "verified").
        rera: extractedRera, rera_verified: null,
        carpetArea: facts.carpetArea, builtUpArea: facts.builtUpArea,
        totalFloors: facts.totalFloors, connectivity: facts.connectivity,
        amenities: doc.amenities || [],
        description: doc.description || null,
        sourceName: doc.sourceName, sourceUrl: doc.sourceUrl, lastSeenAt: doc.lastSeenAt,
        sourceQuality: doc.sourceQuality, sources: doc.sourceUrl ? [{ url: doc.sourceUrl, name: doc.sourceName }] : [],
        confidence, freshnessLabel,
        match_score: confidence,
        why: allReasons.length ? `${allReasons.join(' · ')} · ${freshnessLabel}` : `${confidence}% source confidence · ${freshnessLabel}`,
        matchReason: allReasons.join(' · ') || null,
        // "External market listing" — distinguishes this from an official
        // IndiHomes-catalog project everywhere the frontend needs to (see
        // ProjectSelection.jsx's toAnalysableProject: code stays null here).
        listingType: 'external',
        // Deterministic lifecycle classification (Part 2/22) — already
        // hard-filtered to an eligible stage by the time it reaches here
        // (see the .filter() above); surfaced so the UI can label it and
        // quote the real evidence text, never fabricated.
        lifecycleStatus: doc._lifecycleStatus,
        lifecycleEvidence: doc._lifecycleEvidence,
      }
      propertyResult.dataQuality = computeDataQuality(propertyResult)
      return propertyResult
    })
  // Cross-source merge BEFORE the final sort/rank — see
  // mergeDuplicateProperties' header comment. Rank badges (PRIMARY/
  // SECONDARY/TERTIARY in the UI) are assigned purely by array position, so
  // this must resolve to one row per real project before that ranking is
  // meaningful, not whatever order Azure's text-relevance ranking (or two
  // connectors both finding the same project) happened to return.
  let properties = mergeDuplicateProperties(rawProperties)
  // "Fewer, richer, more relevant" (Part 15) — drop results so low-confidence
  // they're barely related to the query, but only when doing so still
  // leaves something to show; a thin result set is still better than an
  // empty one when literally everything scored low (e.g. a very sparse
  // market with no strong matches).
  const filteredByFloor = properties.filter(p => p.match_score >= 15)
  if (filteredByFloor.length) properties = filteredByFloor
  // Never silently swallow a connector failure — when every connector that
  // ran this query failed, say exactly why (and what to configure instead)
  // rather than handing back an empty result with no explanation.
  // Part 25 (test query 5) — a rental-intent query naturally lands on an
  // empty result (RENTAL-classified candidates are hard-rejected above
  // regardless of intent); say so plainly instead of leaving it unexplained.
  let message = buildConnectorFailureMessage(connectorErrors, activeConnectors.length)
  if (!message && !properties.length && /\brent(al)?\b|\bto\s+let\b|\blease\b|\bpaying\s*guest\b|\bpg\b/i.test(query)) {
    message = 'This search is for new residential projects for sale (under-construction, near-possession, or new-launch) — rental listings are not shown here. Try Property Search or a rental-specific listing site instead.'
  } else if (!message && !properties.length && retrievalCounts.total > 0) {
    // Part 17 — a genuinely empty (but correctly filtered) result set must
    // say WHY, not just "no results": distinguishes "nothing exists" from
    // "everything found was disqualified", using the SAME real counts
    // retrievalCounts above tracks. Only the summary sentence is always
    // shown; the full per-candidate breakdown stays debug-only below.
    const bits = []
    if (retrievalCounts.aggregator) bits.push(`${retrievalCounts.aggregator} were portal category/search-results pages, not individual projects`)
    const rr = retrievalCounts.resale + retrievalCounts.rental
    if (rr) bits.push(`${rr} were resale/rental listings`)
    if (retrievalCounts.unknown) bits.push(`${retrievalCounts.unknown} had a lifecycle stage that couldn't be confidently verified`)
    const breakdown = bits.length > 1 ? `${bits.slice(0, -1).join(', ')}, and ${bits[bits.length - 1]}` : (bits[0] || 'None matched the active new-project search policy')
    message = `No verified new residential projects found. ${retrievalCounts.total} candidate${retrievalCounts.total !== 1 ? 's' : ''} were reviewed. ${breakdown}.`
  }
  const response = { configured: true, enabled: true, market, properties, total: result.total, facets: result.facets, connectorErrors, message }
  // Dev-only debug trace (Part 27) — same server-side-only gate as the
  // Python agent's curator.py. OFF by default; never sent to a production
  // user unless AI_SEARCH_DEBUG_TRACE=true is set on the server itself.
  if (isDebugTraceEnabled()) {
    response.debug_trace = {
      query, normalized_requirements: filters,
      candidates_retrieved: (result.results || []).length,
      candidates_rejected: rejectedForDebug,
      candidates_qualified: properties.length,
      final_order: properties.map(p => p.id),
      retrieval_metrics: {
        total_candidates: retrievalCounts.total,
        individual_project_candidates: retrievalCounts.total - retrievalCounts.aggregator,
        aggregator_pages: retrievalCounts.aggregator,
        resale_candidates: retrievalCounts.resale,
        rental_candidates: retrievalCounts.rental,
        unknown_candidates: retrievalCounts.unknown,
        eligible_candidates: properties.length,
        rejected_candidates: rejectedForDebug.length,
      },
    }
  }
  return response
}

module.exports = { isEnabled, getStatus, queryExternal, refreshExternalIndex, buildCanonicalCandidateId, mergeDuplicateProperties, extractSubListings }
