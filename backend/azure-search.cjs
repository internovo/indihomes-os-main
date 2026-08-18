'use strict'

// Azure AI Search integration — implements the report's recommendations:
// a small "suggester" index (localities/builders/cities, resolves text to an
// ID) plus a "listings" index (full inventory, filterable + faceted). Every
// function here is a no-op / returns { configured:false } when the two env
// vars below aren't set, so the rest of the app runs exactly as before until
// real Azure credentials are supplied — nothing here is on the hot path.
//
// Credentials needed (Azure Portal → your Search resource → Keys):
//   AZURE_SEARCH_ENDPOINT   e.g. https://indihomes.search.windows.net
//   AZURE_SEARCH_ADMIN_KEY  admin key (server-side only, never sent to the browser)

const ENDPOINT   = (process.env.AZURE_SEARCH_ENDPOINT || '').replace(/\/$/, '')
const ADMIN_KEY  = process.env.AZURE_SEARCH_ADMIN_KEY || ''
const API_VERSION = '2023-11-01'

// Renamed from the old generic 'listings' — this index now holds ONLY
// IndiHomes' own official inventory (Filter Search's source of truth), so
// its name says so. Azure's ensureIndexes() below handles the rename safely
// (falls back to delete+recreate if a differently-shaped 'listings' index
// already exists from before this change).
const LISTINGS_INDEX  = 'indihomes-projects'
const SUGGESTER_INDEX = 'suggester'
const SYNONYM_MAP     = 're-synonyms'
const EXTERNAL_INDEX  = process.env.AZURE_SEARCH_EXTERNAL_INDEX || 'external-projects'

function isConfigured() { return !!(ENDPOINT && ADMIN_KEY) }
function externalSearchEnabled() { return process.env.EXTERNAL_SEARCH_ENABLED === 'true' }

// Azure document keys only allow letters, digits, underscore, dash, equals —
// connector ids are frequently raw URLs (https://www.99acres.com/2-bhk...),
// which fail that check outright. Base64url-encode (URL-safe, no padding)
// so any string becomes a valid key while staying deterministic (the same
// source URL always maps to the same doc, so mergeOrUpload still dedupes
// correctly run over run) — same technique already used for suggester ids
// below, just centralized so every index uses it consistently.
function safeKey(raw) {
  return Buffer.from(String(raw)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function azFetch(path, opts = {}) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'api-key': ADMIN_KEY, ...(opts.headers || {}) },
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`Azure Search ${res.status}: ${body?.error?.message || text}`)
  return body
}

// ── Index schemas ────────────────────────────────────────────────────────────
// Listings: the full inventory — filterable + facetable on everything a user
// might narrow by, so facet counts (Section 2.3 of the report — "the pattern
// most worth copying") are essentially free to compute.
const listingsSchema = {
  name: LISTINGS_INDEX,
  fields: [
    { name: 'id',          type: 'Edm.String',  key: true },
    { name: 'name',        type: 'Edm.String',  searchable: true, synonymMaps: [SYNONYM_MAP] },
    { name: 'builder',     type: 'Edm.String',  searchable: true, filterable: true, facetable: true },
    { name: 'city',        type: 'Edm.String',  searchable: true, filterable: true, facetable: true },
    { name: 'location',    type: 'Edm.String',  searchable: true, filterable: true, facetable: true, synonymMaps: [SYNONYM_MAP] },
    // Separate from 'location' — IndiHomes' own API returns this as its own
    // field (e.g. "Near Liberty Garden, Road No 3"), often a landmark phrase
    // rather than the official locality name. Searchable + part of the OData
    // location filter below so a landmark search finds the project even when
    // 'location' itself only says the broader area ("Malad West").
    { name: 'nearbyLocality', type: 'Edm.String', searchable: true, filterable: true },
    // Collection, not a plain string: "2 BHK & 3 BHK" is split into
    // ["2 BHK","3 BHK"] at index time, so a facet/filter on a single BHK
    // value works ("3 BHK (0)" — Section 2.3's whole point).
    // searchable + synonymMaps here (not just filterable/facetable) — this is
    // the field that actually holds "2 BHK", so this is where the synonym
    // map ("two bedroom" -> "2 BHK") needs to live for full-text search to
    // find it at all. It was on name/location only at first, which are
    // project/locality names and never contain a BHK count — a synonym map
    // on fields that never say the term is a no-op. Caught this live.
    { name: 'config',      type: 'Collection(Edm.String)', searchable: true, filterable: true, facetable: true, synonymMaps: [SYNONYM_MAP] },
    { name: 'budgetMin',   type: 'Edm.Int32',   filterable: true, sortable: true },
    { name: 'budgetMax',   type: 'Edm.Int32',   filterable: true, sortable: true },
    { name: 'possession',  type: 'Edm.String',  filterable: true, facetable: true },
    // Parsed year (e.g. "Ready To Move"/"2027"/"TBD" -> 2026/2027/null) so
    // possession can be range-faceted and filtered numerically like budget,
    // instead of string-matching an inconsistent free-text field.
    { name: 'possessionYear', type: 'Edm.Int32', filterable: true, facetable: true, sortable: true },
    { name: 'rera',        type: 'Edm.Boolean', filterable: true, facetable: true },
    { name: 'reraCode',    type: 'Edm.String' },
    { name: 'score',       type: 'Edm.Int32',   sortable: true },
    { name: 'listingUrl',  type: 'Edm.String' },
  ],
  suggesters: [{ name: 'listings-sg', searchMode: 'analyzingInfixMatching', sourceFields: ['name', 'location', 'builder'] }],
  // Azure's built-in semantic ranker (re-ranks the top results by actual
  // relevance to a natural-language query, not just keyword match) — the
  // closest thing to the report diagram's "semantic search" that doesn't
  // require standing up Pinecone + an embeddings pipeline. Needs "Semantic
  // ranker" turned on for the search service in the Azure Portal (free tier:
  // 1,000 queries/month at no cost) — a one-time portal toggle, not a key.
  semantic: {
    configurations: [{
      name: 'listings-semantic',
      prioritizedFields: {
        titleField: { fieldName: 'name' },
        prioritizedContentFields: [{ fieldName: 'location' }, { fieldName: 'builder' }],
        prioritizedKeywordsFields: [{ fieldName: 'city' }],
      },
    }],
  },
}

// Suggester: localities/projects/builders — thousands of rows, refreshed
// alongside the listings sync (derived from the same dataset), resolves text
// to an entity instantly (Section 2.2 — "why it feels instant").
const suggesterSchema = {
  name: SUGGESTER_INDEX,
  fields: [
    { name: 'id',     type: 'Edm.String', key: true },
    { name: 'name',   type: 'Edm.String', searchable: true },
    { name: 'type',   type: 'Edm.String', filterable: true, facetable: true }, // LOCALITY | CITY | BUILDER | PROJECT
    { name: 'area',   type: 'Edm.String' },
    { name: 'weight',  type: 'Edm.Int32', sortable: true }, // listing count backing this entity — ranks suggestions by real inventory, not alphabetically
  ],
  suggesters: [{ name: 'suggester-sg', searchMode: 'analyzingInfixMatching', sourceFields: ['name'] }],
}

// Common Indian real-estate synonyms — "2BHK"/"2 BR"/"two bedroom" and the
// abbreviations every listing site uses interchangeably (report Section 6.1).
// Solr synonym format: comma-separated terms on one line are equivalent.
//
// Also carries the shared MMR gazetteer's micro-locality aliases (mmr-
// gazetteer.json — same file the frontend's LocationCombobox and scoring.cjs
// use) as equivalence groups, e.g. "gawamin, vasai west, vasai, vasai-virar"
// — so a full-text search field with this synonym map attached (name/
// location/config on the listings index; city/location/community on the
// external index) treats "Gawamin" and "Vasai" as the same term in both
// directions, surfacing Vasai-tagged listings for a Gawamin query even
// though no document literally contains the word "Gawamin".
const GAZETTEER = require('../shared/mmr-gazetteer.json')
const LOCALITY_SYNONYM_RULES = Object.entries(GAZETTEER.aliases || {}).map(([key, a]) =>
  [...new Set([key, a.canonical.toLowerCase(), a.parent.toLowerCase(), a.city.toLowerCase()])].join(', ')
)
const SYNONYM_RULES = [
  '1 BHK, 1BHK, 1 BR, one bedroom, single bedroom',
  '2 BHK, 2BHK, 2 BR, two bedroom',
  '3 BHK, 3BHK, 3 BR, three bedroom',
  '4 BHK, 4BHK, 4 BR, four bedroom',
  'Rd, Road',
  'Nr, Near',
  'Twp, Township',
  'Apt, Apartment, Flat',
  ...LOCALITY_SYNONYM_RULES,
].join('\n')

// External (AI Search) index — non-IndiHomes properties only, kept fully
// separate from the IndiHomes-projects index per the brief's "must not be
// mixed with Filter Search official inventory" requirement. Field list is
// exactly what the brief specifies.
const externalSchema = {
  name: EXTERNAL_INDEX,
  fields: [
    { name: 'id',             type: 'Edm.String',  key: true },
    { name: 'market',         type: 'Edm.String',  filterable: true, facetable: true },
    { name: 'country',        type: 'Edm.String',  filterable: true, facetable: true },
    { name: 'city',           type: 'Edm.String',  searchable: true, filterable: true, facetable: true, synonymMaps: [SYNONYM_MAP] },
    { name: 'location',       type: 'Edm.String',  searchable: true, filterable: true, facetable: true, synonymMaps: [SYNONYM_MAP] },
    { name: 'community',      type: 'Edm.String',  searchable: true, filterable: true, facetable: true, synonymMaps: [SYNONYM_MAP] },
    { name: 'name',           type: 'Edm.String',  searchable: true },
    { name: 'developer',      type: 'Edm.String',  searchable: true, filterable: true, facetable: true },
    { name: 'configuration',  type: 'Edm.String',  searchable: true, filterable: true, facetable: true },
    { name: 'bedrooms',       type: 'Edm.Int32',   filterable: true, facetable: true },
    { name: 'budgetMin',      type: 'Edm.Int64',   filterable: true, sortable: true },
    { name: 'budgetMax',      type: 'Edm.Int64',   filterable: true, sortable: true },
    { name: 'currency',       type: 'Edm.String',  filterable: true, facetable: true },
    { name: 'possessionDate', type: 'Edm.String',  filterable: true },
    { name: 'handoverDate',   type: 'Edm.String',  filterable: true },
    { name: 'propertyType',   type: 'Edm.String',  filterable: true, facetable: true },
    { name: 'sourceName',     type: 'Edm.String',  filterable: true, facetable: true },
    { name: 'sourceUrl',      type: 'Edm.String' },
    { name: 'lastSeenAt',     type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
    { name: 'sourceQuality',  type: 'Edm.String',  filterable: true, facetable: true },
    { name: 'description',    type: 'Edm.String',  searchable: true },
    { name: 'amenities',      type: 'Collection(Edm.String)', searchable: true, filterable: true, facetable: true },
    { name: 'score',          type: 'Edm.Int32',   sortable: true },
  ],
  suggesters: [{ name: 'external-sg', searchMode: 'analyzingInfixMatching', sourceFields: ['name', 'location', 'community'] }],
}

async function ensureExternalIndex() {
  if (!isConfigured()) return { configured: false }
  try {
    await azFetch(`/indexes/${EXTERNAL_INDEX}?api-version=${API_VERSION}`, { method: 'PUT', body: JSON.stringify(externalSchema) })
  } catch (e) {
    console.warn(`[azure-search] ${EXTERNAL_INDEX} schema changed shape, recreating index:`, e.message)
    await azFetch(`/indexes/${EXTERNAL_INDEX}?api-version=${API_VERSION}`, { method: 'DELETE' }).catch(() => {})
    await azFetch(`/indexes?api-version=${API_VERSION}`, { method: 'POST', body: JSON.stringify(externalSchema) })
  }
  console.log('[azure-search] External index ready:', EXTERNAL_INDEX)
  return { configured: true }
}

async function syncExternalListings(items) {
  if (!isConfigured() || !items?.length) return
  const docs = items.map(p => ({
    '@search.action': 'mergeOrUpload',
    id: safeKey(p.id), market: p.market || 'india', country: p.country || null,
    city: p.city || null, location: p.location || null, community: p.community || null,
    name: p.name, developer: p.developer || null, configuration: p.configuration || null,
    bedrooms: p.bedrooms ?? null, budgetMin: p.budgetMin ?? null, budgetMax: p.budgetMax ?? null,
    currency: p.currency || null, possessionDate: p.possessionDate || null, handoverDate: p.handoverDate || null,
    propertyType: p.propertyType || null, sourceName: p.sourceName || null, sourceUrl: p.sourceUrl || null,
    lastSeenAt: p.lastSeenAt || new Date().toISOString(), sourceQuality: p.sourceQuality || 'medium',
    description: p.description || '', amenities: p.amenities || [], score: p.score ?? 0,
  }))
  for (let i = 0; i < docs.length; i += 1000) {
    await azFetch(`/indexes/${EXTERNAL_INDEX}/docs/index?api-version=${API_VERSION}`, {
      method: 'POST', body: JSON.stringify({ value: docs.slice(i, i + 1000) }),
    })
  }
  console.log(`[azure-search] Synced ${docs.length} external listings`)
}

function buildExternalFilter({ market, locations, currency } = {}) {
  const clauses = []
  if (market) clauses.push(`market eq '${market.replace(/'/g, "''")}'`)
  if (currency) clauses.push(`currency eq '${currency.replace(/'/g, "''")}'`)
  if (locations?.length) {
    clauses.push('(' + locations.map(l => `search.ismatch('${String(l).replace(/'/g, "''")}', 'city,location,community,name')`).join(' or ') + ')')
  }
  return clauses.join(' and ') || null
}

async function searchExternal(q, filters = {}, { skip = 0, top = 20 } = {}) {
  if (!isConfigured()) return { configured: false, results: [], total: 0 }
  const filter = buildExternalFilter(filters)
  const body = await azFetch(`/indexes/${EXTERNAL_INDEX}/docs/search?api-version=${API_VERSION}`, {
    method: 'POST',
    body: JSON.stringify({
      search: q?.trim() || '*',
      ...(filter ? { filter } : {}),
      facets: ['sourceName,count:20', 'propertyType,count:20', 'community,count:20'],
      skip, top, count: true, queryType: 'full',
    }),
  })
  return {
    configured: true,
    total: body['@odata.count'] ?? (body.value || []).length,
    results: body.value || [],
    facets: body['@search.facets'] || {},
  }
}

async function ensureSynonymMap() {
  await azFetch(`/synonymmaps/${SYNONYM_MAP}?api-version=${API_VERSION}`, {
    method: 'PUT', body: JSON.stringify({ name: SYNONYM_MAP, format: 'solr', synonyms: SYNONYM_RULES }),
  })
}

async function ensureIndexes() {
  if (!isConfigured()) return { configured: false }
  await ensureSynonymMap() // must exist before an index can reference it
  for (const schema of [listingsSchema, suggesterSchema]) {
    try {
      await azFetch(`/indexes/${schema.name}?api-version=${API_VERSION}`, {
        method: 'PUT', body: JSON.stringify(schema),
      })
    } catch (e) {
      // Azure allows adding new fields via update, but not changing an
      // existing field's type/searchable/synonymMaps — those need the index
      // dropped and recreated. Docs repopulate on the very next sync, so
      // this is safe; it only fires when the schema itself changed shape.
      console.warn(`[azure-search] ${schema.name} schema changed shape, recreating index:`, e.message)
      await azFetch(`/indexes/${schema.name}?api-version=${API_VERSION}`, { method: 'DELETE' }).catch(() => {})
      await azFetch(`/indexes?api-version=${API_VERSION}`, { method: 'POST', body: JSON.stringify(schema) })
    }
  }
  console.log('[azure-search] Indexes ready:', LISTINGS_INDEX, SUGGESTER_INDEX)
  if (externalSearchEnabled()) await ensureExternalIndex().catch(e => console.error('[azure-search] external index setup failed:', e.message))
  return { configured: true }
}

// ── Ingestion — called whenever cache.projects refreshes ────────────────────
async function syncListings(projects) {
  if (!isConfigured() || !projects?.length) return
  const docs = projects.map(p => ({
    '@search.action': 'mergeOrUpload',
    id: String(p.id),
    name: p.name, builder: p.builder, city: p.city, location: p.location,
    nearbyLocality: p.nearbyLocality || null,
    config: String(p.config || '').split(/&|,/).map(s => s.trim()).filter(Boolean),
    budgetMin: p.budgetMin ?? null, budgetMax: p.budgetMax ?? null,
    possession: p.possession,
    // "Ready To Move" -> this year (buyable now); an explicit year string ->
    // that year; anything else (TBD, unparseable) -> null, excluded from the
    // possession facet/filter entirely rather than mis-bucketed.
    possessionYear: /ready/i.test(p.possession || '')
      ? new Date().getFullYear()
      : (parseInt((p.possession || '').match(/20\d\d/)?.[0]) || null),
    rera: !!p.rera, reraCode: p.reraCode || null,
    score: p.score ?? 0, listingUrl: p.listingUrl || null,
  }))
  // Azure caps batches at 1000 docs — chunk defensively even though we're well under that today.
  for (let i = 0; i < docs.length; i += 1000) {
    await azFetch(`/indexes/${LISTINGS_INDEX}/docs/index?api-version=${API_VERSION}`, {
      method: 'POST', body: JSON.stringify({ value: docs.slice(i, i + 1000) }),
    })
  }

  // Suggester rows are derived from the same sync — one entry per distinct
  // locality/city/builder/project, weighted by how many listings back it.
  const weight = new Map()
  const bump = (key, type, area) => {
    const k = `${type}::${key}`.toLowerCase()
    const cur = weight.get(k)
    if (cur) cur.count++
    else weight.set(k, { name: key, type, area: area || '', count: 1 })
  }
  for (const p of projects) {
    if (p.location) bump(p.location, 'LOCALITY', p.city)
    if (p.city) bump(p.city, 'CITY', '')
    if (p.builder && p.builder !== 'Unknown Developer') bump(p.builder, 'BUILDER', '')
    if (p.name) bump(p.name, 'PROJECT', p.location || p.city)
  }
  // Gazetteer micro-locality pockets (Kandarpada, Gawamin, ...) get their own
  // suggester row too, even with zero backing listings — Azure's /docs/suggest
  // endpoint doesn't apply synonym-map expansion (only /docs/search does), so
  // without an explicit row a locality with real gazetteer coverage but thin
  // inventory would never appear while typing. Inherits its parent suburb's
  // weight (if any) so it still ranks sensibly rather than always sorting last.
  for (const alias of Object.values(GAZETTEER.aliases || {})) {
    const key = `LOCALITY::${alias.canonical}`.toLowerCase()
    if (weight.has(key)) continue
    const parentWeight = weight.get(`LOCALITY::${alias.parent}`.toLowerCase())?.count || 0
    weight.set(key, { name: alias.canonical, type: 'LOCALITY', area: alias.parent, count: parentWeight })
  }
  const sugDocs = [...weight.values()].map(v => ({
    '@search.action': 'mergeOrUpload',
    id: Buffer.from(`${v.type}::${v.name}`.toLowerCase()).toString('base64').replace(/[^a-zA-Z0-9_-]/g, ''),
    name: v.name, type: v.type, area: v.area, weight: v.count,
  }))
  for (let i = 0; i < sugDocs.length; i += 1000) {
    await azFetch(`/indexes/${SUGGESTER_INDEX}/docs/index?api-version=${API_VERSION}`, {
      method: 'POST', body: JSON.stringify({ value: sugDocs.slice(i, i + 1000) }),
    })
  }
  suggestCache.clear() // counts just changed under it — stale entries would show wrong weights
  console.log(`[azure-search] Synced ${docs.length} listings, ${sugDocs.length} suggester entries`)
}

// ── Query-time ────────────────────────────────────────────────────────────────
// In-process prefix cache — the report's Section 4 point (search traffic is
// extremely top-heavy; cache the top few thousand prefixes) without standing
// up a real Redis instance this app has never had. A plain Map is exactly
// equivalent to Redis here since the API runs as a single Railway instance —
// it just doesn't survive a restart, which for a "same prefixes asked all
// day" cache doesn't matter.
const suggestCache = new Map()
const SUGGEST_CACHE_TTL = 5 * 60 * 1000
const SUGGEST_CACHE_MAX = 5000 // top few thousand prefixes, per the report — not unbounded

function cacheGet(key) {
  const hit = suggestCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.ts > SUGGEST_CACHE_TTL) { suggestCache.delete(key); return undefined }
  return hit.value
}
function cacheSet(key, value) {
  if (suggestCache.size >= SUGGEST_CACHE_MAX) suggestCache.delete(suggestCache.keys().next().value) // evict oldest
  suggestCache.set(key, { value, ts: Date.now() })
}

async function suggest(q) {
  if (!isConfigured() || !q || q.trim().length < 2) return { configured: isConfigured(), results: [] }
  const key = q.trim().toLowerCase()
  const cached = cacheGet(key)
  if (cached) return { configured: true, results: cached, cached: true }
  const body = await azFetch(`/indexes/${SUGGESTER_INDEX}/docs/suggest?api-version=${API_VERSION}`, {
    method: 'POST',
    // Azure's Suggest API returns only the matched text by default — select
    // is required to get the actual field values back, not just @search.text.
    body: JSON.stringify({ search: q.trim(), suggesterName: 'suggester-sg', top: 10, orderby: 'weight desc', select: 'name,type,area,weight' }),
  })
  const results = (body.value || []).map(v => ({ name: v.name, type: v.type, area: v.area, count: v.weight ?? 0 }))
  cacheSet(key, results)
  return { configured: true, results }
}

// filters: { locations: string[], budget: 'Under 75L'|'75L–1.5Cr'|'Above 1.5Cr'|'All', configs: string[], possession: string }
function buildODataFilter(filters = {}) {
  const clauses = []
  if (filters.locations?.length) {
    clauses.push('(' + filters.locations.map(l =>
      `(search.ismatch('${l.replace(/'/g, "''")}', 'city,location,nearbyLocality,name'))`
    ).join(' or ') + ')')
  }
  if (filters.budget === 'Under 75L')   clauses.push('budgetMax lt 75')
  if (filters.budget === '75L–1.5Cr')   clauses.push('budgetMax ge 75 and budgetMin le 150')
  if (filters.budget === 'Above 1.5Cr') clauses.push('budgetMax ge 150')
  if (filters.configs?.length) {
    const list = filters.configs.map(c => c.replace(/'/g, "''")).join(',')
    clauses.push(`config/any(c: search.in(c, '${list}', ','))`)
  }
  if (filters.possession === 'By 2026') clauses.push('possessionYear le 2026')
  if (filters.possession === 'By 2027') clauses.push('possessionYear le 2027')
  if (filters.possession === '2028+')   clauses.push('possessionYear ge 2028')
  return clauses.join(' and ') || null
}

// Azure returns range facets as ordered buckets by edge — [(-inf,e1), [e1,e2),
// [e2,e3), [e3,+inf)]. Re-bucket those into the UI's actual (cumulative
// "by <year>") option labels rather than making the frontend know Azure's
// range-facet response shape.
function bucketizeFacets(raw) {
  const budget = raw.budgetMax || []
  const yr = raw.possessionYear || []
  const c = (arr, i) => arr[i]?.count || 0
  return {
    budget: {
      'Under 75L':   c(budget, 0),
      '75L–1.5Cr':   c(budget, 1),
      'Above 1.5Cr': c(budget, 2),
    },
    possession: {
      'By 2026': c(yr, 0) + c(yr, 1),           // possessionYear <= 2026
      'By 2027': c(yr, 0) + c(yr, 1) + c(yr, 2), // possessionYear <= 2027
      '2028+':   c(yr, 3),                       // possessionYear >= 2028
    },
    config: Object.fromEntries((raw.config || []).map(f => [f.value, f.count])),
    city: Object.fromEntries((raw.city || []).map(f => [f.value, f.count])),
  }
}

async function searchListings(q, filters = {}) {
  if (!isConfigured()) return { configured: false }
  const filter = buildODataFilter(filters)
  const body = await azFetch(`/indexes/${LISTINGS_INDEX}/docs/search?api-version=${API_VERSION}`, {
    method: 'POST',
    body: JSON.stringify({
      search: q?.trim() || '*',
      ...(filter ? { filter } : {}),
      facets: [
        'config,count:20', 'city,count:50', 'builder,count:20',
        // Range facets so Budget/Possession get real counts per UI bucket,
        // not per raw string value — matches "Under 75L / 75L-1.5Cr / Above
        // 1.5Cr" and "By 2026 / By 2027 / 2028+" exactly.
        'budgetMax,values:75|150',
        `possessionYear,values:2026|2027|2028`,
      ],
      top: 100,
      queryType: 'full',
    }),
  })
  return {
    configured: true,
    results: (body.value || []).map(v => ({ id: v.id, name: v.name, score: v['@search.score'] })),
    facets: bucketizeFacets(body['@search.facets'] || {}),
  }
}

// Optional semantic re-ranking of free-text queries — separate from
// searchListings (which stays plain full-text so its facet counts are never
// at risk of an unsupported-feature error). Falls back to a normal search if
// "Semantic ranker" hasn't been turned on for the service in the Azure
// Portal yet, rather than erroring the whole request.
async function semanticSearch(q) {
  if (!isConfigured() || !q?.trim()) return { configured: isConfigured(), results: [] }
  try {
    const body = await azFetch(`/indexes/${LISTINGS_INDEX}/docs/search?api-version=${API_VERSION}`, {
      method: 'POST',
      body: JSON.stringify({
        search: q.trim(), queryType: 'semantic', semanticConfiguration: 'listings-semantic',
        top: 20, select: 'id,name',
      }),
    })
    return { configured: true, semantic: true, results: (body.value || []).map(v => ({ id: v.id, name: v.name, score: v['@search.rerankerScore'] ?? v['@search.score'] })) }
  } catch (e) {
    console.warn('[azure-search] semantic query failed, falling back to plain search:', e.message)
    return searchListings(q, {}).then(r => ({ ...r, semantic: false }))
  }
}

module.exports = {
  isConfigured, ensureIndexes, syncListings, suggest, searchListings, semanticSearch,
  externalSearchEnabled, ensureExternalIndex, syncExternalListings, searchExternal,
  LISTINGS_INDEX, EXTERNAL_INDEX,
}
