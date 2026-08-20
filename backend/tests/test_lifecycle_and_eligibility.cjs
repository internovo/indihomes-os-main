'use strict'
// Plain assert-based tests for the Node fallback search pipeline
// (external-search.cjs/scoring.cjs) — no test framework is installed in
// this repo, so this follows the same "runnable script" convention as
// agent/tests/test_lifecycle_and_eligibility.py. Run:
//   node backend/tests/test_lifecycle_and_eligibility.cjs
// Exits non-zero on any failure.
//
// NOTE: this pipeline used to duplicate the Python agent's lifecycle/
// aggregator-page/geography classification (classifyLifecycleStatus,
// isAggregatorTitle, the geography hard-filter, the fuzzy dedup tier,
// extractSubListings). That logic was removed once the agent became
// reliably available (see scripts/run-agent.ps1's supervisor) and this
// path became a genuinely-last-resort, unclassified "show what a connector
// returned" fallback — see external-search.cjs's own header comment. Tests
// for that removed logic were deleted along with it; what remains here
// covers what's still real: spam/garbage-name filtering, deterministic
// scoring/ranking/ids, and exact-key dedup.

const assert = require('assert')
const scoring = require('../scoring.cjs')
const externalSearch = require('../external-search.cjs')
const { namesLooselyMatch } = require('../external-connectors.cjs')
const queryParser = require('../query-parser.cjs')

let failures = 0
function check(label, condition) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`) }
  else console.log(`ok:   ${label}`)
}

// ── looksLikeUnrelatedCommerce — real live false positive (a candidate
// sourced from a German butcher shop's site, indexed with keyword-stuffed
// real-estate text). Text is the real description this candidate actually
// had, verbatim.
const spamDescription = 'Jun 11, 2026 — Bhk In Charkop Dhaval. Price Item no : US$ 41 Pay in 4 interest-free payments of $10.25 . null Enjoy 20% off shipping US$ . vihar US$ 28.2-47'
check('unrelated e-commerce spam text is detected', scoring.looksLikeUnrelatedCommerce(spamDescription) !== null)
check('a genuine real-estate listing is NEVER flagged as unrelated commerce', scoring.looksLikeUnrelatedCommerce('Dem Icon Charkop is one of the well-known under-construction projects in Charkop, Kandivali West, priced from Rs 65 Lakhs.') === null)

// ── deterministic scoring/ranking ────────────────────────────────────────
const s1 = scoring.scoreExternalProject({ name: 'X', location: 'Malad West' }, { locations: ['Malad West'] })
const s2 = scoring.scoreExternalProject({ name: 'Y', location: 'Pune' }, { locations: ['Malad West'] })
check('exact locality scores higher than a location miss', s1.confidence > s2.confidence)

const configFilters = { locations: ['Borivali East'], configuration: '2 BHK', bedrooms: 2 }
const wrongConfigItem1 = { name: 'Sheth Beaumonde', location: 'Borivali East', city: 'Mumbai', configuration: '3 BHK', bedrooms: 3, budgetMax: 30700000, sourceQuality: 'medium' }
const r1 = scoring.scoreExternalProject(wrongConfigItem1, configFilters)
check('an explicit configuration mismatch caps confidence at 55 (TERTIARY-max, matching the location-mismatch cap)', r1.confidence <= 55)
check('...and gets a real, score-derived TERTIARY tier, never PRIMARY/SECONDARY', r1.tier === 'TERTIARY')
check('a genuine 2BHK exact match is NOT capped by this rule', scoring.scoreExternalProject({ name: 'Arkade Nucleus Borivali East', location: 'Borivali East', city: 'Mumbai', configuration: '2 BHK', bedrooms: 2, budgetMax: 15000000, sourceQuality: 'high', lastSeenAt: new Date().toISOString() }, configFilters).confidence > 55)
check('match_tier is a real, score-derived field on every Node-fallback result — never left unset', typeof r1.tier === 'string' && r1.tier.length > 0)

// ── buildCanonicalCandidateId: deterministic, and portal-noise-tolerant ──
const idA = externalSearch.buildCanonicalCandidateId({ name: 'Arkade Eden Malad West: Price, Photos & Floor Plans', location: 'Malad West' })
const idB = externalSearch.buildCanonicalCandidateId({ name: 'Arkade Eden Malad West - Brochure, Pros&Cons, PriceSheet', location: 'Malad West' })
check('portal price/brochure page-title noise no longer blocks dedup identity match', idA === idB)
const idC1 = externalSearch.buildCanonicalCandidateId({})
const idC2 = externalSearch.buildCanonicalCandidateId({})
check('degenerate candidate (no rera/name/location/url) still gets a DETERMINISTIC id, not Math.random()', idC1 === idC2)

// ── mergeDuplicateProperties: exact-key dedup only (the fuzzy tier was
// removed along with the rest of this pipeline's classification logic) ──
const noisyTitleSameProject = externalSearch.mergeDuplicateProperties([
  { name: 'Arkade Eden Malad West: Price, Photos & Floor Plans', location: 'Malad West', developer: 'Arkade Group', match_score: 80, sources: [] },
  { name: 'Arkade Eden Malad West - Brochure, Pros&Cons, PriceSheet', location: 'Malad West', developer: 'Arkade Group', match_score: 75, sources: [] },
])
check('portal page-title noise no longer blocks the exact-key merge', noisyTitleSameProject.length === 1)

const genericWordOnly = externalSearch.mergeDuplicateProperties([
  { name: 'Sunshine Heights', location: 'Malad West', developer: 'Kalpataru', match_score: 80, sources: [] },
  { name: 'Green Heights', location: 'Malad West', developer: 'Godrej', match_score: 75, sources: [] },
])
check('two different projects with different names are NOT merged', genericWordOnly.length === 2)

// ── Places-augmented pipeline (Part 1/2/38) — this stays: a name-shape
// sanity check, independent of any lifecycle classification.
check("live 'Security Alert' garbage extraction -> looks invalid", scoring.looksLikeInvalidName('Security Alert'))
check("real project 'Rivali Park' -> does NOT look invalid", !scoring.looksLikeInvalidName('Rivali Park'))
check("real project 'Pastonji Bliss Tower' -> does NOT look invalid", !scoring.looksLikeInvalidName('Pastonji Bliss Tower'))
check("generic UI chrome 'Click Here' -> looks invalid", scoring.looksLikeInvalidName('Click Here'))
check("generic UI chrome 'View Details' -> looks invalid", scoring.looksLikeInvalidName('View Details'))
check('empty name -> looks invalid', scoring.looksLikeInvalidName(''))

// namesLooselyMatch() — regression for a REAL false-positive live-caught
// during this same pass: an earlier token-overlap version of this function
// matched "Security Alert" against an unrelated security-guard COMPANY
// ("Alert Securitas | Security Guard Services in Mumbai") purely because
// both share the tokens "security" and "alert" as separate words — a live
// Places Text Search actually returned exactly this business for the query
// "Security Alert, Borivali East, Mumbai". Tightened to contiguous
// substring containment, which correctly rejects this case.
check("'Security Alert' vs the real unrelated security-guard company Places returned -> does NOT match",
  !namesLooselyMatch('Security Alert', 'Alert Securitas | Security Guard Services in Mumbai'))
check("'Rivali Park' vs Places' own 'RIVALI PARK' -> matches", namesLooselyMatch('Rivali Park', 'RIVALI PARK'))
check("'CCI Rivali Park Skyleap' vs a shorter Places entry 'Rivali Park' -> matches (containment either direction)",
  namesLooselyMatch('CCI Rivali Park Skyleap', 'Rivali Park'))
check("two unrelated short names -> does NOT match", !namesLooselyMatch('Blue Ridge', 'Green Valley'))

// scoreExternalProject's places_verified bonus and the config-mismatch cap
// (Part 32, prior pass) must coexist correctly — a Places-verified match
// still gets its existing scoring, unaffected.
check('scoreExternalProject accepts a placesVerified item without throwing (additive field, no scoring dependency yet on this path)',
  typeof scoring.scoreExternalProject({ name: 'Rivali Park', location: 'Borivali East', placesVerified: true }, { locations: ['Borivali East'] }).confidence === 'number')

// ── Part 1f — Dubai-market location/amenity disambiguation ──────────────
let p = queryParser.parseExternalQuery('Dubai', 'dubai')
check("'Dubai' -> location, no amenities", JSON.stringify(p.locations) === JSON.stringify(['Dubai']) && !p.amenities.length)
p = queryParser.parseExternalQuery('Dubai Marina', 'dubai')
check("'Dubai Marina' -> single location (the district), no amenities", JSON.stringify(p.locations) === JSON.stringify(['Dubai Marina']) && !p.amenities.length)
p = queryParser.parseExternalQuery('Marina View', 'dubai')
check("'Marina View' (standalone, no amenity-context prefix) -> its own distinct location, NOT conflated with 'Dubai Marina'", JSON.stringify(p.locations) === JSON.stringify(['Marina View']) && !p.amenities.length)
p = queryParser.parseExternalQuery('near Dubai Marina', 'dubai')
check("'near Dubai Marina' -> location, no amenities", JSON.stringify(p.locations) === JSON.stringify(['Dubai Marina']) && !p.amenities.length)
p = queryParser.parseExternalQuery('properties with marina view', 'dubai')
check("'properties with marina view' -> amenity, NOT misparsed as a location", !p.locations.length && JSON.stringify(p.amenities) === JSON.stringify(['marina view']))
p = queryParser.parseExternalQuery('2BR with Marina View', 'dubai')
check("capitalized 'with Marina View' still resolves as an amenity, not a location (case alone isn't the disambiguator)", !p.locations.length && JSON.stringify(p.amenities) === JSON.stringify(['marina view']))

console.log()
if (failures) {
  console.log(`${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('All checks passed.')
