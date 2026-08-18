'use strict'

// Deterministic, explainable scoring — no LLM involved anywhere in this file.
// Filter Search must be able to say exactly why a project scored what it did
// (brief requirement), which an LLM-graded score structurally can't guarantee.
//
// Weights: Location 30, Configuration 25, Possession 20, Budget 15,
// Data completeness/source freshness 10.
// Labels: Primary 80-100, Secondary 60-79, Tertiary/Stretch 40-59, Low <40.
//
// Rebalanced (was Budget 30/Location 25/Config 20/Possession 15/
// Completeness 10) so a project's explicit location/BHK/possession match —
// the criteria a buyer actually stated — outweighs budget fit, which is a
// range check rather than a precision signal, and outweighs completeness/
// freshness, which isn't something the user asked about at all.
//
// A filter dimension the user didn't specify is excluded from both the
// earned and the applicable points, rather than auto-awarded full marks —
// otherwise every project in an unfiltered browse would "match" 100%
// on dimensions nobody asked about, which isn't explainable, it's noise.

const WEIGHTS = { location: 30, config: 25, possession: 20, budget: 15, completeness: 10, amenity: 10 }

// Shared MMR micro-locality gazetteer (also consumed by the frontend's
// LocationCombobox, azure-search.cjs's suggester synonyms, and
// legacy-portal-connector.cjs's resolveCities()) — resolves a small pocket
// (e.g. "Gawamin") to its parent suburb + region ("Vasai West"/"Vasai-Virar")
// so a filter term with real coverage still matches even when the project
// data only ever names the parent, never the pocket.
const GAZETTEER = require('../shared/mmr-gazetteer.json')
const MICRO_ALIASES = GAZETTEER.aliases || {}
function expandLocationTerm(term) {
  const key = String(term).trim().toLowerCase()
  const alias = MICRO_ALIASES[key]
  if (!alias) return [key]
  return [...new Set([key, alias.canonical.toLowerCase(), alias.parent.toLowerCase(), alias.city.toLowerCase()])]
}
// Strips a trailing directional qualifier ("Borivali East" -> "borivali") so
// two localities that share an umbrella name but differ only by direction
// can be recognized as siblings/neighbors — a generic string transform, not
// a hardcoded list of place names, so it works for any locality in the
// gazetteer (or outside it) without maintenance.
function baseLocality(term) {
  return String(term).trim().toLowerCase().replace(/\s+(east|west|north|south)\.?$/i, '').trim()
}

function labelFor(score) {
  if (score >= 80) return 'Primary'
  if (score >= 60) return 'Secondary'
  if (score >= 40) return 'Tertiary'
  return 'Low Match'
}

// ── Canonical filter shape builders ─────────────────────────────────────────
// Filter Search's UI sends bucketed values (existing convention); /api/projects'
// query-passthrough path sends raw IndiHomes-style params. Both convert to the
// same canonical shape scoreIndiHomesProject() consumes.
function filtersFromBuckets({ locations, budget, configs, possession, amenities } = {}) {
  const out = { locations: (locations || []).filter(Boolean), configs: (configs || []).filter(Boolean), amenities: (amenities || []).filter(Boolean) }
  if (budget === 'Under 75L') { out.budgetMinL = 0; out.budgetMaxL = 75 }
  else if (budget === '75L–1.5Cr' || budget === '75L-1.5Cr') { out.budgetMinL = 75; out.budgetMaxL = 150 }
  else if (budget === 'Above 1.5Cr') { out.budgetMinL = 150; out.budgetMaxL = null }
  const now = new Date().getFullYear()
  if (possession === 'By 2026') out.possessionYearMax = 2026
  else if (possession === 'By 2027') out.possessionYearMax = 2027
  else if (possession === '2028+') out.possessionYearMin = 2028
  return out
}

function filtersFromParams({ area, flatType, budgetMin, budgetMax, possessionDate } = {}) {
  const out = {}
  if (area) out.locations = [String(area)]
  if (flatType) out.configs = [String(flatType).replace(/^(\d)BHK$/i, '$1 BHK')]
  if (budgetMin != null) out.budgetMinL = Math.round(Number(budgetMin) / 1e5)
  if (budgetMax != null) out.budgetMaxL = Math.round(Number(budgetMax) / 1e5)
  if (possessionDate) {
    const y = parseInt(String(possessionDate).slice(0, 4), 10)
    if (Number.isFinite(y)) out.possessionYearMax = y
  }
  return out
}

// ── Scoring ──────────────────────────────────────────────────────────────────
function scoreBudget(project, filters, reasons) {
  if (filters.budgetMinL == null && filters.budgetMaxL == null) return null
  const pMin = project.budgetMin, pMax = project.budgetMax ?? project.budgetMin
  if (pMin == null && pMax == null) { reasons.push('Budget: price not published'); return 0 }
  const fMin = filters.budgetMinL ?? 0
  const fMax = filters.budgetMaxL ?? Infinity
  const lo = Math.max(pMin ?? pMax, fMin)
  const hi = Math.min(pMax ?? pMin, fMax)
  if (hi >= lo) {
    reasons.push(`Budget fits your ₹${fMin}L–${filters.budgetMaxL ?? '∞'}L range`)
    return WEIGHTS.budget
  }
  // Partial credit for being close (within 20% of the nearer edge)
  const gap = lo - hi
  const span = (pMax ?? pMin) - (pMin ?? pMax) || 1
  const closeness = Math.max(0, 1 - gap / Math.max(span, fMax === Infinity ? gap * 2 : fMax - fMin, 1))
  const pts = Math.round(WEIGHTS.budget * closeness * 0.5)
  reasons.push(pts > 0 ? `Budget slightly outside range (off by ~₹${gap}L)` : 'Budget outside your range')
  return pts
}

// Graduated, not binary: an exact locality match earns full marks; a
// "sibling" locality (same umbrella area, different direction — e.g.
// searched "Borivali East", project is in "Borivali West") earns partial
// credit, since it's genuinely nearby but not what was asked for; anything
// else earns zero. This is what actually lets PRIMARY/SECONDARY/TERTIARY
// separate for a location-anchored search — previously any non-exact
// location scored a flat 0, which (combined with full config/possession
// credit) clustered every "nearby but not exact" project at the same
// SECONDARY-range score regardless of how close it really was.
// Calibrated so an otherwise-perfect sibling-locality match still lands in
// SECONDARY (60-79), never PRIMARY — "explicitly accepted" gazetteer
// equivalents (a micro-alias whose parent IS the requested locality) go
// through the exact-match branch above and are unaffected by this; this
// credit is only for a genuinely different, merely-adjacent locality
// ("Do not mark a project Primary merely because it is geographically
// nearby").
const NEARBY_LOCATION_CREDIT = 0.35
function scoreLocation(project, filters, reasons) {
  if (!filters.locations?.length) return null
  const hay = `${project.location || ''} ${project.city || ''} ${project.nearbyLocality || ''} ${project.name || ''}`.toLowerCase()
  const exactHit = filters.locations.find(l => expandLocationTerm(l).some(t => hay.includes(t)))
  if (exactHit) { reasons.push(`Exact location match: ${exactHit}`); return WEIGHTS.location }
  const nearbyHit = filters.locations.find(l => {
    const base = baseLocality(l)
    return base && base !== l.trim().toLowerCase() && base.length > 2 && hay.includes(base)
  })
  if (nearbyHit) {
    const pts = Math.round(WEIGHTS.location * NEARBY_LOCATION_CREDIT)
    reasons.push(`Nearby locality (${nearbyHit} area) — not the exact requested locality`)
    return pts
  }
  reasons.push('Location does not match your selected area(s)')
  return 0
}

function scoreConfig(project, filters, reasons) {
  if (!filters.configs?.length) return null
  // Whitespace-insensitive compare — real project data is inconsistent
  // about "1 BHK" vs "1BHK" spacing; without normalizing, a project that
  // genuinely has the requested configuration scores 0 here purely on
  // formatting, dragging an otherwise-exact match down to SECONDARY.
  const norm = s => String(s).toLowerCase().replace(/\s+/g, '')
  const hay = norm(project.config || '')
  const hit = filters.configs.find(c => hay.includes(norm(c)))
  if (hit) { reasons.push(`${hit} available`); return WEIGHTS.config }
  reasons.push('Requested configuration not listed')
  return 0
}

// Filter Search's bulk project list (cache.projects, from the official
// IndiHomes catalog listing endpoint) does not currently carry populated
// amenities data — only a per-project deep-scrape (Project Intelligence)
// does. Rather than fabricate a match or silently score every project 0
// (which wouldn't differentiate anything, just quietly fail), a project
// with no amenities data on file is treated as "not applicable" for this
// one project — same honest-degrade rule as every other missing-data case
// in this file — while a project that DOES carry real amenities data (once
// this list is enriched, or for any other data source that includes it)
// gets scored for real.
function scoreAmenities(project, filters, reasons) {
  if (!filters.amenities?.length) return null
  const list = Array.isArray(project.amenities) ? project.amenities : []
  if (!list.length) return null
  const hay = list.join(' ').toLowerCase()
  const matched = filters.amenities.filter(a => hay.includes(String(a).toLowerCase()))
  if (!matched.length) { reasons.push('Requested amenities not listed'); return 0 }
  const pts = Math.round(WEIGHTS.amenity * (matched.length / filters.amenities.length))
  reasons.push(`${matched.join(', ')} available`)
  return pts
}

function possessionYearOf(project) {
  if (project.possessionDate) {
    const y = parseInt(String(project.possessionDate).slice(0, 4), 10)
    if (Number.isFinite(y)) return y
  }
  if (/ready/i.test(project.possession || '')) return new Date().getFullYear()
  const m = String(project.possession || '').match(/20\d\d/)
  return m ? parseInt(m[0], 10) : null
}

function scorePossession(project, filters, reasons) {
  if (filters.possessionYearMax == null && filters.possessionYearMin == null) return null
  const py = possessionYearOf(project)
  const label = project.possession || py
  if (py == null) { reasons.push('Possession date not published'); return 0 }
  if (filters.possessionYearMax != null && py <= filters.possessionYearMax) {
    reasons.push(`Possession ${label} is within your requested window`)
    return WEIGHTS.possession
  }
  if (filters.possessionYearMin != null && py >= filters.possessionYearMin) {
    reasons.push(`Possession ${label} is within your requested window`)
    return WEIGHTS.possession
  }
  const target = filters.possessionYearMax ?? filters.possessionYearMin
  const diff = Math.abs(py - target)
  if (diff <= 1) {
    // Small, not half — a project that is otherwise a perfect (location +
    // config) match but genuinely misses the stated possession window
    // should read as SECONDARY, not PRIMARY (spec: "possession slightly
    // outside the requested range" is explicitly a SECONDARY example, not a
    // PRIMARY one).
    reasons.push(`Possession ${label} is outside your preferred ${target} window (close)`)
    return Math.round(WEIGHTS.possession * 0.05)
  }
  reasons.push(`Possession ${label} is well outside your requested window`)
  return 0
}

function scoreCompleteness(project, reasons) {
  const fields = [
    project.reraCode, (project.media || []).length, (project.description || '').length > 20,
    project.brochureUrl, project.developerName, project.possessionDate,
  ]
  const present = fields.filter(Boolean).length
  let pts = Math.round(WEIGHTS.completeness * (present / fields.length))
  if (project.fromCache === true || project.stale === true) pts = Math.round(pts * 0.6)
  if (pts >= WEIGHTS.completeness * 0.8) reasons.push('Listing data is complete and current')
  else if (project.stale) reasons.push('Showing last-known data (live refresh unavailable)')
  return pts
}

function scoreIndiHomesProject(project, rawFilters = {}) {
  const filters = ('budget' in rawFilters || 'possession' in rawFilters) && !('budgetMinL' in rawFilters)
    ? filtersFromBuckets(rawFilters)
    : rawFilters
  const reasons = []
  const parts = [
    scoreBudget(project, filters, reasons),
    scoreLocation(project, filters, reasons),
    scoreConfig(project, filters, reasons),
    scorePossession(project, filters, reasons),
    scoreAmenities(project, filters, reasons),
  ]
  const partWeights = [WEIGHTS.budget, WEIGHTS.location, WEIGHTS.config, WEIGHTS.possession, WEIGHTS.amenity]
  const applicable = parts.reduce((s, p, i) => s + (p == null ? 0 : partWeights[i]), 0)
  const earned = parts.reduce((s, p) => s + (p || 0), 0)
  const completenessReasons = []
  const completenessPts = scoreCompleteness(project, completenessReasons)

  let score
  if (applicable === 0) {
    // Nothing specified — this is a plain browse, not a filtered search.
    // Score reflects data quality only, not a fabricated 100% match.
    score = Math.round((completenessPts / WEIGHTS.completeness) * 100)
  } else {
    score = Math.round(((earned + completenessPts) / (applicable + WEIGHTS.completeness)) * 100)
  }
  // Location was explicitly requested (a "core requirement") but the
  // project isn't even in a neighboring/sibling locality — cap the overall
  // score below SECONDARY regardless of how well budget/config/possession
  // otherwise line up. A project in a genuinely unrelated area is a
  // TERTIARY fallback at best, never a strong match, no matter what else
  // it gets right.
  const [, locationPts] = parts
  if (filters.locations?.length && locationPts === 0) score = Math.min(score, 55)
  score = Math.max(0, Math.min(100, score))

  return { score, label: labelFor(score), reasons: [...reasons, ...completenessReasons] }
}

// ── External (AI Search) scoring — was quality/freshness ONLY, which meant
// every Apify result carrying the same 'medium' sourceQuality + "seen today"
// freshness landed on an identical 55%, regardless of whether it actually
// matched the query (three totally different listings all showing 55% was
// the reported symptom). Reworked to weight against the ACTUAL parsed query
// filters (query-parser.cjs's parseExternalQuery output — locations/
// configuration/bedrooms/budgetMax/possession), the same 30/25/20/15 shape
// scoreIndiHomesProject already uses for Filter Search, with source quality/
// freshness folded into the remaining 10% as a tie-breaker rather than the
// whole score. A filter dimension the query didn't specify is excluded from
// both earned and applicable points (same "explainable degrade" pattern as
// scoreIndiHomesProject) rather than auto-awarded full marks.
const EXTERNAL_WEIGHTS = { location: 30, config: 25, possession: 20, budget: 15, quality: 10 }

function scoreExternalBudget(item, filters, reasons) {
  if (filters.budgetMax == null) return null
  const itemMax = item.budgetMax ?? item.budgetMin
  if (itemMax == null) { reasons.push('Price not published'); return 0 }
  if (itemMax <= filters.budgetMax) { reasons.push('Within your budget'); return EXTERNAL_WEIGHTS.budget }
  const overPct = (itemMax - filters.budgetMax) / filters.budgetMax
  if (overPct <= 0.15) { reasons.push('Slightly above your budget'); return Math.round(EXTERNAL_WEIGHTS.budget * 0.5) }
  reasons.push('Above your budget')
  return 0
}

// Same exact/nearby-sibling graduation as scoreLocation above, applied to
// external (AI Search) listings — see that function's comment for why a
// binary match/no-match previously clustered every non-exact result at the
// same score.
function scoreExternalLocation(item, filters, reasons) {
  if (!filters.locations?.length) return null
  const hay = `${item.city || ''} ${item.location || ''} ${item.community || ''} ${item.name || ''}`.toLowerCase()
  const exactHit = filters.locations.find(l => expandLocationTerm(l).some(t => hay.includes(t)))
  if (exactHit) { reasons.push(`Exact location match: ${exactHit}`); return EXTERNAL_WEIGHTS.location }
  const nearbyHit = filters.locations.find(l => {
    const base = baseLocality(l)
    return base && base !== l.trim().toLowerCase() && base.length > 2 && hay.includes(base)
  })
  if (nearbyHit) {
    reasons.push(`Nearby locality (${nearbyHit} area) — not the exact requested locality`)
    return Math.round(EXTERNAL_WEIGHTS.location * NEARBY_LOCATION_CREDIT)
  }
  reasons.push('Location does not match your search')
  return 0
}

function bhkOf(configuration, bedrooms) {
  if (bedrooms != null) return bedrooms
  const m = String(configuration || '').match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

function scoreExternalConfig(item, filters, reasons) {
  const wantBhk = bhkOf(filters.configuration, filters.bedrooms)
  if (wantBhk == null) return null
  const itemBhk = bhkOf(item.configuration, item.bedrooms)
  if (itemBhk == null) { reasons.push('Configuration not published'); return 0 }
  if (itemBhk === wantBhk) { reasons.push(`${wantBhk} BHK matches`); return EXTERNAL_WEIGHTS.config }
  reasons.push(`${itemBhk} BHK does not match your ${wantBhk} BHK request`)
  return 0
}

function scoreExternalPossession(item, filters, reasons) {
  if (!filters.possession) return null
  const want = String(filters.possession).toLowerCase()
  const itemPossession = String(item.handoverDate || item.possessionDate || '').toLowerCase()
  if (!itemPossession) { reasons.push('Possession not published'); return 0 }
  if (/ready/.test(want) && /ready/.test(itemPossession)) { reasons.push('Ready to move, as requested'); return EXTERNAL_WEIGHTS.possession }
  const wantYear = want.match(/20\d\d/)?.[0]
  const itemYear = itemPossession.match(/20\d\d/)?.[0]
  if (wantYear && itemYear) {
    if (itemYear === wantYear) { reasons.push(`Possession ${itemYear} matches`); return EXTERNAL_WEIGHTS.possession }
    if (Math.abs(parseInt(itemYear, 10) - parseInt(wantYear, 10)) <= 1) { reasons.push('Possession close to your requested window, not an exact match'); return Math.round(EXTERNAL_WEIGHTS.possession * 0.15) }
  }
  reasons.push('Possession does not match your requested window')
  return 0
}

function freshnessLabelOf(item) {
  if (!item.lastSeenAt) return 'Unknown freshness'
  const ageDays = Math.round((Date.now() - new Date(item.lastSeenAt).getTime()) / 86400000)
  if (ageDays <= 1) return 'Seen today'
  if (ageDays <= 7) return `Seen ${ageDays}d ago`
  if (ageDays <= 30) return `Seen ${Math.round(ageDays / 7)}w ago`
  return `Seen ${Math.round(ageDays / 30)}mo ago`
}

// Locality/city names from the shared gazetteer — used below to catch a
// second, common aggregator-title shape: a bare "Locality, Sub-locality,
// City" string with no project name at all (e.g. "Daulat Nagar, Borivali
// East, Mumbai"). Real project listings name a building/developer; a title
// that is ENTIRELY known place names, comma-separated, is a locality landing
// page, not a specific property.
const KNOWN_PLACE_NAMES = new Set(['mumbai', 'thane', 'pune', 'navi mumbai'])
for (const city of Object.keys(GAZETTEER.cities || {})) KNOWN_PLACE_NAMES.add(city.toLowerCase())
for (const localities of Object.values(GAZETTEER.cities || {})) for (const l of localities) KNOWN_PLACE_NAMES.add(String(l).toLowerCase())
for (const alias of Object.values(GAZETTEER.aliases || {})) {
  KNOWN_PLACE_NAMES.add(String(alias.canonical).toLowerCase())
  KNOWN_PLACE_NAMES.add(String(alias.parent).toLowerCase())
  KNOWN_PLACE_NAMES.add(String(alias.city).toLowerCase())
}
function isBareLocalityTitle(name) {
  const segs = String(name || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (segs.length < 2 || segs.length > 4) return false
  return segs.every(s => KNOWN_PLACE_NAMES.has(s))
}

// Whether a listing is a generic guide/category/aggregator page rather than
// an actual property listing ("Complete Guide: How to Buy 2 BHK Flat in
// Malad West 2025?", "N+ Flats for Sale in X", "X: Map, Property Rates,
// Projects") — previously only down-ranked via a quality-score penalty
// (scoreExternalQualityPts's -20%), which still let these show up in results
// at a lower position. Callers that want them removed outright (not merely
// ranked lower) should filter on this directly.
//
// Broadened after a real production sample (a Daulat Nagar/Borivali East
// search) showed the original pattern missed the most common real-world
// shapes portals actually use: "BHK Flats in X, Y", "Flats for Rent in X",
// "Resale Flats in X – 16+ Properties", and bare locality-name titles with
// no project name at all — none of which matched the original narrow regex.
// Live bug, reproduced 2026-08-17: "Buy 1 BHK in Borivali | New Projects &
// Properties in Borivali" — a common portal SEO title shape ("Buy <BHK> in
// <Place>" then a "|"/"-" separator then a "New Projects & Properties in
// <Place>" boilerplate suffix). The anchored regex below only ever looks at
// the START of the title, so a "Buy 1 BHK in Borivali" prefix hides the
// real category-page giveaway that follows. Narrow and specific (not a
// broadened version of the anchored regex, which risks false-positiving on
// a real listing's own title) — matches only this exact recurring phrase,
// unanchored, mirroring agent/agent/normalize.py's PORTAL_SEO_SUFFIX_RE.
const PORTAL_SEO_SUFFIX_RE = /new\s+projects?\s*(&|and)\s*propert(y|ies)\s+in\s+[A-Z]/i
// "Projects in <Place>" ANYWHERE in the title — mirrors
// agent/agent/normalize.py's PROJECTS_IN_PLACE_RE exactly. This side never
// received that fix when it originally landed on the Python side (the
// anchored regex below only ever looks at the START of the title, same
// class of gap the "Page 3 -" fix addressed there). Live-caught on "2BHK in
// Borivali East": "New Launch Projects in Borivali East, Mumbai" and "Under
// Construction Projects in Borivali East, Mumbai" (both from 99acres.com)
// scored PRIMARY/SECONDARY through this fallback pipeline because the
// anchored check requires "new projects?" etc. to open the title — "New
// Launch"/"Under Construction" as the actual opening phrase defeated it,
// exactly like "Page 3 -" once defeated the Python side's anchored check.
// Deliberately unanchored and generic (doesn't care what lifecycle-status
// phrase, if any, precedes "Projects in") so it covers the whole family
// ("Ready to Move Projects in...", "Upcoming Projects in...", "Ongoing
// Projects in...") without needing a new pattern per phrase.
const PROJECTS_IN_PLACE_RE = /\bprojects?\s+in\s+[A-Z]/i
// "Page N - ..." prefix — mirrors agent/agent/normalize.py's
// PAGINATION_PREFIX_RE/PAGINATION_URL_RE exactly. This was the ONE fix from
// the Python P0 pass explicitly, deliberately left unmirrored here (per
// structure.md's "Wiring fix" section: "the correct fix was routing the
// browser to the already-fixed pipeline, not duplicating the fix into the
// fallback path too" — the assumption being the agent would always be the
// one serving real requests). Confirmed live this stayed a real, exploitable
// gap: a request that silently fell back to this Node pipeline (agent
// unreachable/timed out — this has now happened multiple times in this same
// session) let "Page 7 — 2 BHK Flats in Malad West, Mumbai" (99acres.com)
// score PRIMARY 97% and render as a real project. Relying on "the agent is
// always up" is not a safe assumption to keep this gap open on.
const PAGINATION_PREFIX_RE = /^\s*page\s+\d+\b/i

function isAggregatorTitle(name) {
  const n = String(name || '').trim()
  if (!n) return true
  if (isBareLocalityTitle(n)) return true
  if (PAGINATION_PREFIX_RE.test(n)) return true
  return (
    /\bmap\b|property rates|photos\s*&?\s*video|video tour|: overview|complete guide|how to buy|buying guide|\bguide\b/i.test(n) ||
    // Portal category/search-results-page title patterns: "BHK Flats in X",
    // "Flats for Rent/Sale in X", "Resale Flats in X", "New Projects in X",
    // "Property/Properties in X" — these are locality landing pages, not a
    // named building. A real project's own title doesn't open this way.
    // Live-caught gap (2026-08-19): "372+ 1 BHK Flats in Kandivali West,
    // Mumbai" wasn't matching — the old `(bhk\s+)?` only ever expected the
    // bare word "bhk" right after an optional leading COUNT, never a
    // CONFIGURATION (its own number, e.g. "1 BHK"/"2 & 3 BHK") appearing
    // between the count and the real-estate noun, which is exactly how a
    // portal's own "<count>+ <config> Flats/Apartments in <Place>" SEO
    // title is actually phrased. Mirrors agent/agent/normalize.py's
    // PORTAL_CATEGORY_TITLE_RE fix exactly.
    /^\s*(\d+\+?\s*)?(\d+(?:\s*[&,]\s*\d+)*\s*(?:bhk|bed(?:room)?s?)\s*)?(flats?|apartments?|propert(y|ies)|resale(\s+flats?)?|new\s+projects?)\b.{0,50}\b(in|for\s+sale|for\s+rent|near)\b/i.test(n) ||
    // Trailing "N+ Properties/Flats/Apartments" count — with or without a
    // following preposition (e.g. "...Borivali East – 16+ Properties").
    /\d+\+?\s*(propert(y|ies)|flats?|apartments?)\s*$/i.test(n) ||
    PORTAL_SEO_SUFFIX_RE.test(n) ||
    PROJECTS_IN_PLACE_RE.test(n)
  )
}

// Real-world AI Search queries are frequently location-only ("properties in
// Daulat Nagar" — no BHK/budget mentioned at all). When that happens, budget/
// config/possession are correctly excluded as "not applicable" (same
// explainable-degrade rule as scoreIndiHomesProject), which means location
// is the ONLY scored dimension — and a generic aggregator page ("Daulat
// Nagar, Mumbai: Map, Property Rates, Projects") ties with an actual listing
// ("1 BHK Flats for Rent in Daulat Nagar") purely because both mention the
// locality by name. Confirmed live: an 18-result Daulat Nagar search landed
// every single result on an identical 89%. These completeness/specificity
// signals are NOT gated on whether the query asked for that dimension
// (unlike the four scoreExternal* functions above) — they reward a result
// for actually BEING a specific, real listing, which is relevant regardless
// of what the user typed. Real signals only (config/price presence, name
// pattern) — never fabricated.
function scoreExternalQualityPts(item, reasons) {
  const qualityBase = { high: 80, medium: 55, low: 30 }[item.sourceQuality] ?? 45
  let pct = qualityBase / 100
  if (item.lastSeenAt) {
    const ageDays = (Date.now() - new Date(item.lastSeenAt).getTime()) / 86400000
    if (ageDays > 90) pct -= 0.25
    else if (ageDays > 30) pct -= 0.10
  } else {
    pct -= 0.15
  }
  if (item.configuration) { pct += 0.10; reasons.push(`Configuration published (${item.configuration})`) }
  if (item.budgetMax != null || item.budgetMin != null) { pct += 0.10; reasons.push('Price published') }
  const name = String(item.name || '').toLowerCase()
  if (/\bmap\b|property rates|photos\s*&?\s*video|video tour|: overview/i.test(name)) {
    pct -= 0.20
    reasons.push('Reads like a general info/aggregator page, not a specific listing')
  }
  return Math.round(EXTERNAL_WEIGHTS.quality * Math.max(0, Math.min(1, pct)))
}

function scoreExternalProject(item = {}, filters = {}) {
  const reasons = []
  const parts = [
    scoreExternalBudget(item, filters, reasons),
    scoreExternalLocation(item, filters, reasons),
    scoreExternalConfig(item, filters, reasons),
    scoreExternalPossession(item, filters, reasons),
  ]
  const weightsArr = [EXTERNAL_WEIGHTS.budget, EXTERNAL_WEIGHTS.location, EXTERNAL_WEIGHTS.config, EXTERNAL_WEIGHTS.possession]
  const applicable = parts.reduce((s, p, i) => s + (p == null ? 0 : weightsArr[i]), 0)
  const earned = parts.reduce((s, p) => s + (p || 0), 0)
  const qualityPts = scoreExternalQualityPts(item, reasons)

  let confidence
  if (applicable === 0) {
    // No filters to match against (a bare/blank query) — confidence reflects
    // source quality/freshness only, same graceful-degrade pattern as
    // scoreIndiHomesProject's unfiltered-browse case.
    confidence = Math.round((qualityPts / EXTERNAL_WEIGHTS.quality) * 100)
  } else {
    confidence = Math.round(((earned + qualityPts) / (applicable + EXTERNAL_WEIGHTS.quality)) * 100)
  }
  // Same "wrong area caps below Secondary" rule as scoreIndiHomesProject.
  const [, extLocationPts, extConfigPts] = parts
  if (filters.locations?.length && extLocationPts === 0) confidence = Math.min(confidence, 55)
  // Configuration cap — live-caught on "2BHK in Borivali East": two 3 BHK
  // "New Launch"/"Under Construction" listings (both explicitly saying "3
  // BHK does not match your 2 BHK request" in their own reasons) still
  // scored 58% and were labeled PRIMARY/SECONDARY — an exact location match
  // alone was enough to compensate for an explicitly wrong BHK count. A
  // configuration the user explicitly asked for is exactly the same kind of
  // "core requirement" the location cap above already protects (same 55
  // ceiling — TERTIARY at best, never Primary/Secondary — deliberately not
  // a full exclusion: the project is still real and in the right place, so
  // it's shown, just never overstated as a strong match). Applies whenever
  // configuration was requested and didn't score, same as the location
  // cap's own "any non-match, known or unknown, gets capped" rule — not
  // just an explicit mismatch, since "we don't know if it matches" is no
  // more a strong match than "we know it doesn't."
  if (filters.configuration || filters.bedrooms != null) {
    if (bhkOf(filters.configuration, filters.bedrooms) != null && extConfigPts === 0) confidence = Math.min(confidence, 55)
  }
  confidence = Math.max(0, Math.min(100, confidence))
  // Real, score-derived tier — mirrors agent/agent/scoring.py's score_property
  // exactly (same 80/60 PRIMARY/SECONDARY/TERTIARY thresholds, same
  // uppercase labels). Previously left unset on this (Node fallback) path
  // entirely, which meant ProjectSelection.jsx's PropertyCard fell back to
  // pure ARRAY-POSITION labeling (`p.match_tier || rankOf(i).label`) — the
  // actual mechanism behind "PRIMARY (58%)" and "SECONDARY (58%)" showing
  // the identical score under different badges: position, not score,
  // decided the label. Setting a real tier here means that positional
  // fallback is never reached for this pipeline's results again, for any
  // query, not just this one.
  const tier = confidence >= 80 ? 'PRIMARY' : confidence >= 60 ? 'SECONDARY' : 'TERTIARY'

  return { confidence, tier, freshnessLabel: freshnessLabelOf(item), reasons }
}

// ── Lifecycle / transaction-type classifier (Node fallback path) ───────────
// Mirrors agent/agent/normalize.py's classify_lifecycle_status() — same
// regex families, same 7-value enum, same "resale/rental checked first and
// win outright" priority, same "no signal at all -> UNKNOWN, never guessed"
// rule. This is a DIFFERENT check from isAggregatorTitle() above:
// isAggregatorTitle asks "is this even an individual listing page, or a
// portal category/search-results page" — a resale flat's own listing page
// is shaped exactly like a real project listing (title + price + BHK +
// description) and passes that check untouched. This is the missing second
// gate. Deterministic, regex-only, no LLM — queryExternal() below rejects
// anything outside ALLOWED_LIFECYCLE_STATUSES outright, never merely
// down-ranks it.
// `by\s+owner` (spanning newlines) used to false-positive on portal
// FILTER-WIDGET chrome ("Posted By [newline] Owner Builder Dealer
// [newline] clear") — a facet list, not a claim about this specific
// listing. `[ \t]+` (no newline) still catches a genuine same-line
// mention while refusing to match across separate UI elements.
// The final `ownership\s*type...self[\s-]?owned` alternative mirrors
// agent/agent/normalize.py's RESALE_RE fix exactly — live-caught on
// "1BHK in kandarpada Dahisar West with gym nearby": a NoBroker listing
// ("Age of Building: >10 years", "Ownership Type: Self Owned") never used
// the word "resale" anywhere on the page, so it fell through to the
// possession-year fallback and got misclassified NEAR_POSSESSION (that
// listing's "Possession" field means "date the buyer takes possession from
// the seller once this resale deal closes", not a new project's
// construction-completion date).
const RESALE_RE = /\bresale\b|\bpre[\s-]?owned\b|\bsecond\s*sale\b|\bsecond[\s-]?hand\b|\bowner\s*(posted|listed|seller)?\b.{0,15}\b(sale|sell)\b|\bby[ \t]+owner\b|\bdirect\s+from\s+owner\b|\bindividual\s+owner\b|\bused\s+(flat|apartment|property)\b|\bownership\s*type\b[^a-zA-Z]{0,20}self[\s-]?owned\b/i
// `lease` alone is NOT a rental signal in Indian real estate — many genuine
// new-launch/under-construction projects sit on government leasehold land
// and their own listings say so ("99-year lease deed from MHADA/MMRDA").
// The negative lookahead excludes that common false-positive while still
// catching an actual rental-lease offer ("available on lease", "lease:
// ₹25,000/month"). Mirrors agent/agent/normalize.py's RENTAL_RE exactly.
const RENTAL_RE = /\bfor\s+rent\b|\brental\b|\bto\s+let\b|\blease\b(?!\s*deed)|\brent(?:al)?\s*\/\s*month\b|\b(rent|lease)\s*:\s*₹|\bpg\b|\bpaying\s*guest\b|\bmonthly\s+rent\b/i
// Follow-up spec — mirrors agent/agent/normalize.py's UNRELATED_COMMERCE_RE
// exactly (see its own comment for the full "German butcher shop domain"
// live-confirmed false-positive writeup). Deterministic, narrow,
// high-precision shopping/e-commerce signals only.
const UNRELATED_COMMERCE_RE = /\bpay\s+in\s+4\b|\binterest[\s-]?free\s+payments?\b|\badd\s+to\s+cart\b|\bfree\s+shipping\b|\bshipping\s+charges?\b|\bitem\s+no\.?\s*:?\s*\d|\bin\s+stock\b|\bout\s+of\s+stock\b|\bUS\$\s*\d/i
function looksLikeUnrelatedCommerce(text) {
  const m = UNRELATED_COMMERCE_RE.exec(String(text || ''))
  if (!m) return null
  return String(text).slice(Math.max(0, m.index - 25), Math.min(text.length, m.index + m[0].length + 25)).trim()
}

// Part 2 of the Places-augmented pipeline — a candidate's name-VALIDITY
// check, used as the actual gate for a garbage extraction like the live
// "Security Alert" case (traced to a 99acres page that most plausibly
// served a bot-detection/interstitial page instead of its real listing
// content — refetching the identical URL moments later returned entirely
// different, legitimate content, confirming the page is non-deterministic
// per-request under repeated automated access). Deliberately a PATTERN
// FAMILY (portal UI chrome / interstitial / generic-action phrasing), not
// a hardcoded blocklist of "Security Alert" alone — that would be overfit
// to one bad example and miss the next differently-worded interstitial.
// Only used as a gate when Places verification did NOT resolve the name
// (see placesVerify in external-connectors.cjs) — a real project simply
// absent from Places must never be rejected on Places-absence alone.
const INVALID_NAME_RE = /^(security|fraud|scam|safety)\s+(alert|warning|notice)$|\b(click here|view details?|read more|learn more|sign[\s-]?in|log[\s-]?in|log[\s-]?out|register now|book\s+now|enquire\s+now|contact\s+us|about\s+us|terms\s+(and|&)\s+conditions|privacy\s+policy|cookie\s+policy|page\s+not\s+found|access\s+denied|please\s+wait|loading|coming\s+soon|under\s+maintenance|verify\s+you.?re\s+human|are\s+you\s+a\s+robot|session\s+expired)\b/i
// A bare social-platform name ("Instagram", "Facebook", ...) as the ENTIRE
// extracted name — mirrors agent/agent/normalize.py's
// SOCIAL_PLATFORM_BARE_NAME_RE fix exactly. Live-caught: an Instagram-
// sourced candidate had its NAME come out as the literal string
// "Instagram" (Instagram serves a generic og:title="Instagram" for
// logged-out/scraper embed requests instead of the real caption text).
// Matched as the WHOLE string, not a substring.
const SOCIAL_PLATFORM_BARE_NAME_RE = /^(instagram|facebook|twitter|x|pinterest|threads|youtube|tiktok|linkedin|snapchat)$/i
function looksLikeInvalidName(name) {
  const n = String(name || '').trim()
  if (!n) return true
  if (INVALID_NAME_RE.test(n)) return true
  if (SOCIAL_PLATFORM_BARE_NAME_RE.test(n)) return true
  // Structural fallback: a very short (<=2 word) name built ENTIRELY from
  // generic, non-proper-noun UI/status words doesn't read as a real
  // project name at all — a real project's name always has SOMETHING
  // distinctive ("Rivali Park", "Chandak Greenairy"); this catches short
  // generic labels the specific-phrase family above doesn't happen to
  // name. Deliberately a small, narrow list (not a real dictionary check)
  // — same discipline as this codebase's other regex-family heuristics.
  const GENERIC_NAME_WORDS = new Set(['alert', 'notice', 'warning', 'error', 'info', 'details', 'update', 'news', 'status', 'message', 'popup', 'modal', 'banner', 'ad', 'ads', 'advertisement'])
  const words = n.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length <= 2 && words.every(w => GENERIC_NAME_WORDS.has(w))) return true
  return false
}
const UNDER_CONSTRUCTION_RE = /\bunder[\s-]?construction\b|\bwork\s+in\s+progress\b|\bconstruction\s+(is\s+)?ongoing\b/i
// `new\s+project\s+by` mirrors agent/agent/normalize.py's NEW_LAUNCH_RE fix
// exactly — live-caught on "1BHK in kandarpada Dahisar West with gym
// nearby": a genuine developer-marketing Instagram caption ("New Project by
// Pastonji Bliss Tower located near kandarpada metro station...") never
// says "launch"/"pre-launch"/etc. explicitly. Deliberately excludes a bare
// "new project" (too generic). "pre-launch" moved OUT of this pattern into
// its own PRE_LAUNCH_RE below (mirrors normalize.py's split exactly) — a
// project still taking registrations of interest is meaningfully earlier
// than one that has actually launched.
const NEW_LAUNCH_RE = /\bnew\s*launch\b|\bnewly\s+launched\b|\bjust\s+launched\b|\bupcoming\s+project\b|\bnew\s+project\s+by\b/i
const PRE_LAUNCH_RE = /\bpre[\s-]?launch\b|\bcoming\s+soon\b|\bregister\s+your\s+interest\b|\blaunching\s+soon\b/i
const NEAR_POSSESSION_RE = /\bnear\s+possession\b|\bpossession\s+(soon|shortly|imminent)\b|\bready\s+(for|by)\s+possession\b/i
const READY_TO_MOVE_RE = /\bready[\s-]?to[\s-]?move\b|\bready\s+possession\b|\bimmediate\s+possession\b|\bpossession\s+available\b|\bfully\s+occupied\b|\boccupancy\s+certificate\b/i

function possessionYearFromText(text) {
  const m = String(text || '').match(/20\d\d/)
  return m ? parseInt(m[0], 10) : null
}

const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
// Mirrors agent/agent/normalize.py's _parse_possession_month_year exactly —
// when the possession text carries MONTH precision, the NEAR_POSSESSION
// fallback below can use a genuine ~6-month window instead of only ever
// comparing whole years. Returns null (never a guess) when unparseable.
function parsePossessionMonthYear(text) {
  const m = String(text || '').trim().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})/i)
  if (!m) return null
  const month = MONTH_NUM[m[1].toLowerCase().slice(0, 3)]
  if (!month) return null
  return new Date(Date.UTC(parseInt(m[2], 10), month - 1, 1))
}

// Returns { status, evidence }. status is one of UNDER_CONSTRUCTION |
// NEAR_POSSESSION | NEW_LAUNCH | PRE_LAUNCH | READY_TO_MOVE | RESALE |
// RENTAL | UNKNOWN.
//
// Precedence mirrors agent/agent/normalize.py's classify_lifecycle_status
// exactly: RESALE/RENTAL always win outright, then READY_TO_MOVE is
// checked BEFORE NEW_LAUNCH/PRE_LAUNCH/UNDER_CONSTRUCTION/NEAR_POSSESSION —
// an explicit "Ready to Move"/"Immediate Possession" claim is the
// strongest, most specific completion signal a listing can make, and must
// win outright over a weaker/generic "under construction" mention found
// elsewhere on the same page (e.g. a multi-phase project's page that also
// mentions an earlier phase still under construction).
function classifyLifecycleStatus(item = {}) {
  const text = `${item.name || ''} ${item.description || ''}`.trim()
  if (!text) return { status: 'UNKNOWN', evidence: null }
  const snippet = (m) => text.slice(Math.max(0, m.index - 25), Math.min(text.length, m.index + m[0].length + 25)).trim()

  let m = RESALE_RE.exec(text)
  if (m) return { status: 'RESALE', evidence: snippet(m) }
  m = RENTAL_RE.exec(text)
  if (m) return { status: 'RENTAL', evidence: snippet(m) }
  m = READY_TO_MOVE_RE.exec(text)
  if (m) return { status: 'READY_TO_MOVE', evidence: snippet(m) }
  m = NEW_LAUNCH_RE.exec(text)
  if (m) return { status: 'NEW_LAUNCH', evidence: snippet(m) }
  m = PRE_LAUNCH_RE.exec(text)
  if (m) return { status: 'PRE_LAUNCH', evidence: snippet(m) }
  m = UNDER_CONSTRUCTION_RE.exec(text)
  if (m) return { status: 'UNDER_CONSTRUCTION', evidence: snippet(m) }
  m = NEAR_POSSESSION_RE.exec(text)
  if (m) return { status: 'NEAR_POSSESSION', evidence: snippet(m) }

  // No phrase-level marker — fall back to a real extracted possession date.
  const possessionText = item.handoverDate || item.possessionDate || item.possession || ''
  const parsedMonth = parsePossessionMonthYear(possessionText)
  if (parsedMonth) {
    const now = new Date()
    const monthsOut = (parsedMonth.getUTCFullYear() - now.getFullYear()) * 12 + (parsedMonth.getUTCMonth() - now.getMonth())
    if (monthsOut < 0) return { status: 'READY_TO_MOVE', evidence: `Possession date ${possessionText} extracted from listing (already past)` }
    if (monthsOut <= 6) return { status: 'NEAR_POSSESSION', evidence: `Possession date ${possessionText} extracted from listing (within 6 months)` }
    return { status: 'UNDER_CONSTRUCTION', evidence: `Possession date ${possessionText} extracted from listing` }
  }
  // Year-only bucketing (far future = still building, this/next year =
  // near possession, past/current = ready) — same three-way split as the
  // Python side.
  const py = possessionYearFromText(possessionText)
  if (py != null) {
    const thisYear = new Date().getFullYear()
    if (py > thisYear + 1) return { status: 'UNDER_CONSTRUCTION', evidence: `Possession year ${py} extracted from listing` }
    if (py === thisYear || py === thisYear + 1) return { status: 'NEAR_POSSESSION', evidence: `Possession year ${py} extracted from listing` }
    return { status: 'READY_TO_MOVE', evidence: `Possession year ${py} extracted from listing` }
  }
  return { status: 'UNKNOWN', evidence: null }
}

// Default AI Property Search policy — only these are eligible new-project
// inventory. Same set as agent/agent/normalize.py's ALLOWED_LIFECYCLE_STATUSES.
// PRE_LAUNCH is included — a project still taking registrations of
// interest before formal launch is new-project inventory, not a
// disqualifying stage.
const ALLOWED_LIFECYCLE_STATUSES = new Set(['UNDER_CONSTRUCTION', 'NEAR_POSSESSION', 'NEW_LAUNCH', 'PRE_LAUNCH'])

module.exports = { scoreIndiHomesProject, scoreExternalProject, filtersFromBuckets, filtersFromParams, labelFor, isAggregatorTitle, classifyLifecycleStatus, ALLOWED_LIFECYCLE_STATUSES, looksLikeUnrelatedCommerce, looksLikeInvalidName }
