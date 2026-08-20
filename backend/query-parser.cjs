'use strict'

// Deterministic natural-language -> structured-filter extraction. Replaces
// llm.extractFilters (Claude) for both Filter Search's "Fill filters" quick-fill
// and AI Search's query parsing — rule 3 bans Claude from anything
// search-related, including this translation step, not just the results.
//
// This is regex/heuristic, not semantic NLP — it will miss things a language
// model would catch. That is an accepted trade-off of the "no Claude for
// search" rule, not an oversight.

const BHK_STOPWORDS = new Set([
  'Under', 'Near', 'Ready', 'Move', 'BHK', 'Cr', 'Crore', 'Lakh', 'Lakhs',
  'Budget', 'Possession', 'By', 'For', 'With', 'And', 'The', 'In', 'At',
  'Between', 'From', 'To', 'Flat', 'Flats', 'Apartment', 'Apartments',
  'Property', 'Properties', 'Project', 'Projects', 'Home', 'Homes',
])
// Case-insensitive companion — a query typed in lowercase ("2 bhk near
// malad") or ALL CAPS must be stopword-filtered exactly like Title Case
// input; comparing a lowercase word against BHK_STOPWORDS' Title-Case
// entries directly always misses (Set membership is case-sensitive).
const BHK_STOPWORDS_LOWER = new Set([...BHK_STOPWORDS].map(w => w.toLowerCase()))
const isStopword = (w) => BHK_STOPWORDS_LOWER.has(String(w).toLowerCase())

const GAZETTEER = require('../shared/mmr-gazetteer.json')

function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim() }
// Normalizes an extracted location to Title Case ("borivali east" ->
// "Borivali East") regardless of which tier/casing it was pulled from, so
// every downstream consumer (chips, gazetteer/LOCATION_INDEX lookups,
// scoring.cjs's hay matching) sees one consistent form. Matching everywhere
// is already case-insensitive, so this is purely a display/consistency
// normalization, not a behavior change.
function properCase(s) {
  return clean(s).split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

// "1.5 cr", "75 lakh", "1.2 crore", "under 1.5cr", "80L-1.2Cr" -> max in Crores
function extractBudgetMaxCr(text) {
  const t = text.toLowerCase()
  const crRange = t.match(/(\d+\.?\d*)\s*(?:l|lakh|lakhs)?\s*[-–to]+\s*(\d+\.?\d*)\s*cr/i)
  if (crRange) return parseFloat(crRange[2])
  const cr = t.match(/(\d+\.?\d*)\s*(?:cr|crore)/i)
  if (cr) return parseFloat(cr[1])
  const lakhRange = t.match(/(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*(?:l|lakh|lakhs)\b/i)
  if (lakhRange) return parseFloat(lakhRange[2]) / 100
  const lakh = t.match(/(\d+\.?\d*)\s*(?:l|lakh|lakhs)\b/i)
  if (lakh) return parseFloat(lakh[1]) / 100
  return null
}

// Generic currency-aware budget-max extractor for external (AI Search) queries —
// supports AED alongside ₹/Cr/Lakh since Dubai listings are AED-denominated.
function extractBudgetMax(text, currency = 'INR') {
  const t = text.toLowerCase()
  if (currency === 'AED') {
    const m = t.match(/(\d+\.?\d*)\s*(m|million|k|thousand)?\s*aed/i) || t.match(/aed\s*(\d+\.?\d*)\s*(m|million|k|thousand)?/i)
    if (m) {
      const n = parseFloat(m[1])
      const mult = /^m/i.test(m[2] || '') ? 1e6 : /^k/i.test(m[2] || '') ? 1e3 : 1
      return Math.round(n * mult)
    }
    return null
  }
  const cr = extractBudgetMaxCr(text)
  return cr != null ? Math.round(cr * 1e7) : null
}

function extractConfiguration(text) {
  const shared = text.match(/(\d+(?:\s*[&,]\s*\d+)+)\s*(?:BHK|bed(?:room)?s?)/i)
  if (shared) {
    const nums = (shared[1].match(/\d+/g) || [])
    return nums.map(n => `${n} BHK`).join(' & ')
  }
  const m = text.match(/(\d+)\s*(?:BHK|bed(?:room)?s?)/i)
  if (m) return `${m[1]} BHK`
  if (/\bstudio\b/i.test(text)) return 'Studio'
  return ''
}

function extractBedrooms(text) {
  const m = text.match(/(\d+)\s*(?:BHK|bed(?:room)?s?)/i)
  return m ? parseInt(m[1], 10) : null
}

// A generic vocabulary of amenity terms (not tied to any specific project/
// location), matched case-insensitively against the raw query text —
// "with gym and swimming pool" -> ['gym','swimming pool']. Kept intentionally
// small/literal (no synonym expansion) since scoring.cjs can only honestly
// match this against a project's own real amenities list, never invent one.
const AMENITY_TERMS = [
  'swimming pool', 'pool', 'gym', 'gymnasium', 'clubhouse', 'club house',
  'garden', 'jogging track', 'kids play area', "children's play area",
  'play area', 'security', 'power backup', 'lift', 'elevator', 'parking',
  'terrace', 'deck', 'private deck', 'yoga', 'amphitheatre', 'sports court',
  'tennis court', 'badminton court', 'indoor games', 'party hall',
  'banquet hall', 'senior citizen', 'jacuzzi', 'sauna', 'spa', 'library',
  'co-working',
  // "<landmark> view" amenity phrases (Part 1f, Dubai-market
  // disambiguation) — mirrors agent/agent/query_understanding.py exactly.
  'marina view', 'sea view', 'pool view', 'garden view', 'city view',
  'park view', 'golf view', 'lake view', 'canal view', 'skyline view',
]
function extractAmenities(text) {
  const t = String(text || '').toLowerCase()
  const found = AMENITY_TERMS.filter(a => t.includes(a))
  // Drop a shorter term that's wholly contained in a longer matched term
  // ("pool" inside "swimming pool") — both would otherwise match the same
  // mention and inflate the requested-amenity count scoring divides by.
  return found.filter(a => !found.some(b => b !== a && b.includes(a) && b.length > a.length))
}

// Part 1f — Dubai-market disambiguation: "marina view"/"sea view"/etc. as
// an AMENITY phrase ("properties with marina view") must never be misread
// as a LOCATION ("Marina View" — a real building/area name). Mirrors
// agent/agent/query_understanding.py's VIEW_AMENITY_RE exactly — see its
// comment for the full reasoning.
const VIEW_AMENITY_RE = /\b(?:with|having|offering|featuring|boasts?|overlooking)\s+(?:a\s+|an\s+)?(sea|marina|pool|garden|city|park|golf|lake|canal|skyline)\s+view\b/gi
function extractViewAmenities(text) {
  const out = []
  let m
  const re = new RegExp(VIEW_AMENITY_RE.source, 'gi')
  while ((m = re.exec(text))) out.push(`${m[1].toLowerCase()} view`)
  return out
}
function maskViewAmenityPhrases(text) {
  return String(text || '').replace(new RegExp(VIEW_AMENITY_RE.source, 'gi'), ' ')
}

function extractPossession(text) {
  const t = text.toLowerCase()
  if (/ready to move|immediate possession|move[-\s]?in ready|ready possession/.test(t)) return 'Ready to Move'
  const monthYear = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{4})/i)
  if (monthYear) return `${monthYear[1].slice(0, 3)} ${monthYear[2]}`
  const quarter = t.match(/q([1-4])\s*[\/\-]?\s*(\d{4})/)
  if (quarter) return `Q${quarter[1]} ${quarter[2]}`
  const byYear = t.match(/by\s+(20\d\d)/)
  if (byYear) return byYear[1]
  const year = t.match(/\b(20\d\d)\b/)
  if (year) return year[1]
  return ''
}

// Location: prefer "in/at/near X" phrasing (most common in conversational
// queries — already case-insensitive, the "in/at/near/around" match is
// itself /i and the extracted phrase isn't case-gated). Falls back to
// Capitalized-word runs that aren't stopwords for prose without that
// phrasing, then to a bare-short-query heuristic for a location typed alone
// with no preposition and no Title Case at all (e.g. "malad", "malad west"
// typed straight into the AI Search bar) — confirmed live: "malad" (all
// lowercase, no preposition) previously returned [] while "Malad"/"MALAD"
// worked, because the capitalized-word-run regex requires an initial
// uppercase letter and has no case-insensitive equivalent for prose. Kept
// deliberately narrow (short, punctuation-free, digit-free input only) so it
// can't false-positive against a real multi-clause sentence typed in
// lowercase.
// Every locality/alias name the shared gazetteer knows about, longest-first
// so "Malad West" is tried before the shorter "Malad", and a micro-alias
// like "Liberty Garden" is found as its own term rather than swallowed into
// a longer generic capture. Purely data-driven (reads mmr-gazetteer.json),
// not a hardcoded place list — computed once, not per call.
const KNOWN_GAZETTEER_TERMS = (() => {
  const terms = new Set()
  for (const locs of Object.values(GAZETTEER.cities || {})) for (const l of locs) terms.add(l)
  for (const alias of Object.values(GAZETTEER.aliases || {})) terms.add(alias.canonical)
  return [...terms].sort((a, b) => b.length - a.length)
})()

// Scans the raw query text for literal, known gazetteer terms as whole-word
// phrases (case-insensitive), longest match first, marking matched spans so
// a shorter term can't also match inside an already-claimed span (e.g.
// "Malad" inside an already-matched "Malad West"). This is what correctly
// splits "...on Liberty Garden Malad West" into TWO locations ("Liberty
// Garden" + "Malad West") instead of the directional-suffix tier below
// swallowing both into one unresolvable combined string — "Liberty Garden"
// is a real gazetteer alias, this tier is what actually finds it.
function gazetteerScanLocations(text) {
  const claimed = new Array(text.length).fill(false)
  const found = []
  for (const term of KNOWN_GAZETTEER_TERMS) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    let m
    while ((m = re.exec(text))) {
      const start = m.index, end = start + m[0].length
      if (claimed.slice(start, end).some(Boolean)) continue
      const beforeOk = start === 0 || !/[a-z0-9]/i.test(text[start - 1])
      const afterOk = end === text.length || !/[a-z0-9]/i.test(text[end])
      if (!beforeOk || !afterOk) continue
      for (let i = start; i < end; i++) claimed[i] = true
      found.push([start, term])
    }
  }
  found.sort((a, b) => a[0] - b[0])
  return found.map(([, term]) => term)
}

function extractLocations(text) {
  const gazetteerHits = gazetteerScanLocations(text)
  if (gazetteerHits.length) return [...new Set(gazetteerHits.map(properCase))].slice(0, 5)

  const found = []
  const phraseRe = /\b(?:in|at|near|around)\s+([A-Za-z][A-Za-z\s]{1,30}?)(?=\s+(?:under|for|with|by|possession|budget|bhk|ready|\d)|[,.]|$)/gi
  let m
  while ((m = phraseRe.exec(text))) {
    const loc = clean(m[1])
    if (loc && loc.length > 2 && !isStopword(loc)) found.push(loc)
  }
  // Directional-suffix locality ("Borivali east", "malad WEST" — one to
  // three words immediately followed by East/West/North/South, any casing).
  // Indian real-estate queries are routinely typed with only the first word
  // (or nothing) capitalized — "Borivali east 1bhk possession by 2027" — so
  // the Title-Case-only tier below would see just "Borivali" and silently
  // drop the directional qualifier, collapsing an exact-locality query into
  // a much broader one. A directional suffix is a generic grammatical
  // signal (not a specific place name), so this doesn't hardcode any
  // locations — it just recognizes the pattern generically.
  if (!found.length) {
    const dirRe = /\b((?:[A-Za-z]+\s+){0,2}[A-Za-z]+)\s+(east|west|north|south)\b/gi
    while ((m = dirRe.exec(text))) {
      const words = clean(m[1]).split(/\s+/)
      if (words.every(w => isStopword(w))) continue
      found.push(`${clean(m[1])} ${m[2]}`)
    }
  }
  if (!found.length) {
    const capRe = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/g
    while ((m = capRe.exec(text))) {
      const words = m[1].split(/\s+/)
      if (words.every(w => isStopword(w))) continue
      if (m[1].length > 2) found.push(m[1])
    }
  }
  if (!found.length) {
    const trimmed = text.trim()
    const words = trimmed ? trimmed.split(/\s+/) : []
    if (words.length >= 1 && words.length <= 4 && !/\d/.test(trimmed) && !/[.,!?]/.test(trimmed)) {
      const nonStop = words.filter(w => !isStopword(w) && w.length > 1)
      if (nonStop.length && nonStop.length === words.length) found.push(clean(nonStop.join(' ')))
    }
  }
  return [...new Set(found.map(properCase))].slice(0, 5)
}

// Matches llm.extractFilters' output shape exactly, so /api/nl-filters (and
// anything else reading this) doesn't need to change beyond swapping the call.
// Blanks out already-extracted location substrings before amenity
// extraction runs, so a locality name that happens to contain a generic
// amenity word ("Liberty GARDEN") is never misread as a request for that
// amenity. Longest-first so a shorter location name can't leave a fragment
// of a longer one behind.
function maskLocations(text, locations) {
  let masked = text
  for (const loc of [...locations].sort((a, b) => b.length - a.length)) {
    masked = masked.replace(new RegExp(loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
  }
  return masked
}

// Part 1f — mask out amenity-shaped "with/having/offering... <X> view"
// phrases BEFORE location extraction runs (see VIEW_AMENITY_RE above), then
// merge the real view-amenities found back into the amenities list. A bare
// "Marina View"/"near Dubai Marina" (no such amenity-context prefix) is
// untouched and still resolves as a location exactly as before.
function locationTextFor(text) {
  const viewAmenities = extractViewAmenities(text)
  return { source: viewAmenities.length ? maskViewAmenityPhrases(text) : text, viewAmenities }
}
function mergeViewAmenities(amenities, viewAmenities) {
  const lower = new Set(amenities.map(a => a.toLowerCase()))
  return [...amenities, ...viewAmenities.filter(a => !lower.has(a))]
}

function parseNLQuery(query) {
  const text = String(query || '')
  const { source, viewAmenities } = locationTextFor(text)
  const location = extractLocations(source)
  return {
    location,
    budget: '',
    budget_max_cr: extractBudgetMaxCr(text),
    configuration: extractConfiguration(text),
    possession: extractPossession(text),
    amenities: mergeViewAmenities(extractAmenities(maskLocations(text, location)), viewAmenities),
    builder: '',
    requirements: '',
  }
}

// Broader shape used by external (AI Search) query parsing — currency-aware.
function parseExternalQuery(query, market = 'india') {
  const text = String(query || '')
  const currency = market === 'dubai' ? 'AED' : 'INR'
  const { source, viewAmenities } = locationTextFor(text)
  const locations = extractLocations(source)
  return {
    locations,
    configuration: extractConfiguration(text),
    bedrooms: extractBedrooms(text),
    budgetMax: extractBudgetMax(text, currency),
    currency,
    possession: extractPossession(text),
    amenities: mergeViewAmenities(extractAmenities(maskLocations(text, locations)), viewAmenities),
  }
}

// ── AI Search query defense — a cheap, deterministic pre-check applied
// ONCE before any pipeline (agent/Places-direct/Node fallback) processes a
// query. A genuine property search always has at least one recognizable
// shape signal (a KNOWN locality, a configuration, a budget, a possession
// mention, or a generic real-estate noun) — no LLM call, no per-phrase
// injection blocklist (a losing, gameable game); an off-topic question or
// an instruction-injection attempt has no property-search shape at all,
// caught by the SAME positive check that accepts a genuine, if terse,
// real query like "Malad West" or "under 1.5 Cr".
//
// Deliberately does NOT reuse filters.locations from parseExternalQuery —
// confirmed live, that field's generic Title-Case fallback tier (built to
// catch a real but non-gazetteer locality, e.g. a Dubai neighborhood) is
// far too permissive for a SECURITY check: "What is the capital of
// France?" / "Ignore all previous instructions..." / "You are now DAN..."
// all extracted a bogus "location" ("France"/"Ignore"/"You"/"Dan") purely
// because those words happen to be capitalized. Uses a direct, STRICT
// membership check against the real gazetteer's own city/locality/alias
// names instead — a real signal, not "any capitalized word."
const KNOWN_LOCALITY_RE = (() => {
  const names = new Set()
  for (const city of Object.keys(GAZETTEER.cities || {})) names.add(city)
  for (const localities of Object.values(GAZETTEER.cities || {})) for (const l of localities) names.add(l)
  for (const alias of Object.values(GAZETTEER.aliases || {})) {
    if (alias.canonical) names.add(alias.canonical)
    if (alias.parent) names.add(alias.parent)
    if (alias.city) names.add(alias.city)
  }
  names.add('Dubai'); names.add('UAE')
  const escaped = [...names].filter(Boolean).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i')
})()
const GENERIC_REAL_ESTATE_NOUN_RE = /\b(flats?|apartments?|propert(?:y|ies)|projects?|villas?|plots?|houses?|homes?|residential|residences?|condos?|society|societies|complex|towers?|buildings?|real\s*estate|builder|developer)\b/i
// A bare, hyper-local locality name outside the (Mumbai-only) gazetteer's
// coverage — "Mahatre Wadi", "Kandarpada" — must still pass; the strict
// gazetteer check above alone rejects real micro-localities it simply
// doesn't list. Structural fallback: SHORT (<=5 words), every word Title-
// Case-or-ALL-CAPS with no lowercase function word anywhere, and no
// sentence-shaped stopword — a real English sentence (question, instruction,
// injection attempt) always has at least one of "is/the/of/you/ignore/tell/
// me/..." somewhere; a bare place name never does. Deliberately errs toward
// ACCEPTING an unfamiliar-but-plausible place name (worst case: an honest
// "no results found" from the pipelines, not a security issue) over
// rejecting a genuine hyper-local search.
const SENTENCE_SHAPE_STOPWORD_RE = /\b(is|are|was|were|the|of|what|who|when|where|why|how|you|your|yourself|please|now|ignore|forget|disregard|previous|instructions?|system|prompt|prompts|tell|me|explain|write|generate|translate|joke|story|recipe|poem|code|hack|jailbreak|act|pretend|roleplay|reveal|repeat|output|print)\b/i
function looksLikeBareLocalityPhrase(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 5) return false
  if (SENTENCE_SHAPE_STOPWORD_RE.test(text)) return false
  return words.every(w => /^[A-Z][a-zA-Z'-]*$/.test(w))
}
function isPropertySearchQuery(query, filters) {
  const text = String(query || '')
  if (filters?.configuration) return true
  if (filters?.bedrooms != null) return true
  if (filters?.budgetMax != null) return true
  if (filters?.possession) return true
  if (filters?.amenities?.length) return true
  if (KNOWN_LOCALITY_RE.test(text)) return true
  if (looksLikeBareLocalityPhrase(text)) return true
  return GENERIC_REAL_ESTATE_NOUN_RE.test(text)
}

module.exports = { parseNLQuery, parseExternalQuery, extractLocations, extractBudgetMaxCr, extractBudgetMax, extractConfiguration, extractPossession, extractAmenities, isPropertySearchQuery }
