'use strict'
// Plain assert-based tests for the Node fallback search pipeline's
// deterministic lifecycle/eligibility logic — no test framework is
// installed in this repo today, so this follows the same "runnable script"
// convention as agent/tests/test_lifecycle_and_eligibility.py. Run:
//   node backend/tests/test_lifecycle_and_eligibility.cjs
// Exits non-zero on any failure.

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

// ── classifyLifecycleStatus ──────────────────────────────────────────────
check('resale title -> RESALE',
  scoring.classifyLifecycleStatus({ name: 'Resale 2 BHK Flat in Borivali West', description: 'Owner posted, contact for resale price' }).status === 'RESALE')

check('rental title -> RENTAL',
  scoring.classifyLifecycleStatus({ name: '2 BHK for Rent in Malad West', description: 'Rental ₹35,000/month' }).status === 'RENTAL')

check('under-construction description -> UNDER_CONSTRUCTION',
  scoring.classifyLifecycleStatus({ name: 'Arkade Nucleus', description: 'Under construction, possession by December 2027' }).status === 'UNDER_CONSTRUCTION')

check('near-possession description -> NEAR_POSSESSION',
  scoring.classifyLifecycleStatus({ name: 'Sheth Vasant Oasis Phase 2', description: 'Near possession, handover expected shortly' }).status === 'NEAR_POSSESSION')

check('new-launch title -> NEW_LAUNCH',
  scoring.classifyLifecycleStatus({ name: 'New launch: Godrej Horizon', description: 'Newly launched residential project' }).status === 'NEW_LAUNCH')

// ── PRE_LAUNCH — split out of NEW_LAUNCH_RE, its own distinct status ────
check('pre-launch phrase -> PRE_LAUNCH, not NEW_LAUNCH',
  scoring.classifyLifecycleStatus({ name: 'Rustomjee Skyline', description: 'Pre-launch offer — register your interest now for early access' }).status === 'PRE_LAUNCH')
check("'coming soon'/'launching soon' -> PRE_LAUNCH",
  scoring.classifyLifecycleStatus({ name: 'Coming Soon: Lodha Elite', description: 'Launching soon in Thane West' }).status === 'PRE_LAUNCH')
check('PRE_LAUNCH is in the allowed set (new-project inventory, not disqualified)',
  scoring.ALLOWED_LIFECYCLE_STATUSES.has('PRE_LAUNCH'))

// ── Precedence — an explicit "Ready to Move" claim must win outright over
// a weaker/generic "under construction" mention found elsewhere on the
// same page.
check('explicit READY_TO_MOVE wins outright over a weaker UNDER_CONSTRUCTION mention on the same page',
  scoring.classifyLifecycleStatus({
    name: 'Kalpataru Radiance Phase 1 — Ready to Move',
    description: 'Phase 1 is ready to move with immediate possession. Phase 2 is still under construction.',
  }).status === 'READY_TO_MOVE')

// ── NEAR_POSSESSION month-precision fallback (~6 months of today) ───────
function monthsFromNow(n) {
  const d = new Date(); d.setUTCMonth(d.getUTCMonth() + n)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
check('possession date ~3 months out, no phrase marker -> NEAR_POSSESSION (month precision)',
  scoring.classifyLifecycleStatus({ name: 'Plain listing, no phrase markers', description: '', possession: monthsFromNow(3) }).status === 'NEAR_POSSESSION')
check('possession date ~18 months out, no phrase marker -> UNDER_CONSTRUCTION (month precision)',
  scoring.classifyLifecycleStatus({ name: 'Plain listing, no phrase markers', description: '', possession: monthsFromNow(18) }).status === 'UNDER_CONSTRUCTION')

check('no signal at all -> UNKNOWN',
  scoring.classifyLifecycleStatus({ name: 'Some Random Listing', description: 'Nice apartment with good amenities' }).status === 'UNKNOWN')

// Regression: live-caught on "1BHK in kandarpada Dahisar West with gym
// nearby" — a genuine developer-marketing Instagram caption ("New Project
// by Pastonji Bliss Tower located near kandarpada metro station...") never
// used "launch"/"pre-launch"/"upcoming project". Mirrors
// agent/agent/normalize.py's regression test.
check('"New Project by <Name>" developer caption -> NEW_LAUNCH, not UNKNOWN',
  scoring.classifyLifecycleStatus({
    name: 'Dahisar West New Project by Pastonji Bliss Tower located ...',
    description: 'New Project by Pastonji Bliss Tower located near kandarpada metro station. from only 73 lakhs plus taxes.',
  }).status === 'NEW_LAUNCH')
check('bare "new project" (no "by") does NOT trigger NEW_LAUNCH on its own',
  scoring.classifyLifecycleStatus({ name: 'Some Building', description: 'Check out this new project nearby, prices starting soon' }).status !== 'NEW_LAUNCH')

// Regression: bare "lease" must not misclassify a genuine new-launch project
// built on government leasehold land ("lease deed" is a land-tenure term,
// not a rental-transaction signal) as RENTAL.
check('leasehold land-tenure new-launch project -> NOT RENTAL',
  scoring.classifyLifecycleStatus({ name: 'Godrej Horizon', description: 'New launch on a 99-year lease deed from MHADA, under construction' }).status !== 'RENTAL')
check('genuine lease-based rental listing -> still RENTAL',
  scoring.classifyLifecycleStatus({ name: '2 BHK available on lease', description: 'Lease: ₹25,000/month, immediate move-in' }).status === 'RENTAL')

// Regression: a real live false-positive — a portal's "Posted By" FILTER
// WIDGET (facet options "Owner / Builder / Dealer", not a claim about the
// specific listing) matched \bby\s+owner\b because \s+ spans newlines.
check('portal "Posted By" filter-widget chrome (newline-separated) -> NOT RESALE',
  scoring.classifyLifecycleStatus({ name: 'Arkade Malad West', description: 'Posted By \n Owner Builder Dealer \n \n clear all filters' }).status !== 'RESALE')
check('genuine same-line "by owner" mention -> still RESALE',
  scoring.classifyLifecycleStatus({ name: '2 BHK Flat', description: 'For sale by owner, no brokers please' }).status === 'RESALE')

// Regression: live-caught on "1BHK in kandarpada Dahisar West with gym
// nearby" — a real NoBroker resale listing ("Age of Building: >10 years",
// "Ownership Type: Self Owned") never used the word "resale" anywhere on
// the page, so it matched none of the existing RESALE_RE patterns and fell
// through to the possession-year fallback, which misread its resale
// "Possession" field (date the buyer takes possession from the seller once
// the resale deal closes) as a new project's construction-completion date
// and returned NEAR_POSSESSION — an eligible status — for a 10+-year-old
// resale flat. Mirrors agent/agent/normalize.py's regression test.
check('NoBroker "Ownership Type: Self Owned" listing -> RESALE, not NEAR_POSSESSION via possession-year fallback',
  scoring.classifyLifecycleStatus({
    name: 'LEGEND 4 Dahisar West - Without Brokerage Unfurnished 1 BHK Flat for Sale in LEGEND 4, Mumbai for Rs. 12,000,000 | NoBroker',
    description: 'Age of Building ##### >10 years ##### Ownership Type ##### Self Owned ##### Maintenance Charges',
  }).status === 'RESALE')

// Follow-up: unrelated shopping/e-commerce content rejection — real live
// false positive (a candidate sourced from a German butcher shop's site,
// indexed with keyword-stuffed real-estate text). Text is the real
// description this candidate actually had, verbatim.
const spamDescription = 'Jun 11, 2026 — Bhk In Charkop Dhaval. Price Item no : US$ 41 Pay in 4 interest-free payments of $10.25 . null Enjoy 20% off shipping US$ . vihar US$ 28.2-47'
check('unrelated e-commerce spam text is detected', scoring.looksLikeUnrelatedCommerce(spamDescription) !== null)
check('a genuine real-estate listing is NEVER flagged as unrelated commerce', scoring.looksLikeUnrelatedCommerce('Dem Icon Charkop is one of the well-known under-construction projects in Charkop, Kandivali West, priced from Rs 65 Lakhs.') === null)

check('UNKNOWN not in allowed set', !scoring.ALLOWED_LIFECYCLE_STATUSES.has('UNKNOWN'))
check('RESALE not in allowed set', !scoring.ALLOWED_LIFECYCLE_STATUSES.has('RESALE'))
check('RENTAL not in allowed set', !scoring.ALLOWED_LIFECYCLE_STATUSES.has('RENTAL'))
check('READY_TO_MOVE not in allowed set (per default Project Search policy)', !scoring.ALLOWED_LIFECYCLE_STATUSES.has('READY_TO_MOVE'))
check('UNDER_CONSTRUCTION IS in allowed set', scoring.ALLOWED_LIFECYCLE_STATUSES.has('UNDER_CONSTRUCTION'))
check('NEAR_POSSESSION IS in allowed set', scoring.ALLOWED_LIFECYCLE_STATUSES.has('NEAR_POSSESSION'))
check('NEW_LAUNCH IS in allowed set', scoring.ALLOWED_LIFECYCLE_STATUSES.has('NEW_LAUNCH'))

const thisYear = new Date().getFullYear()
check('far-future possession year fallback -> UNDER_CONSTRUCTION',
  scoring.classifyLifecycleStatus({ name: 'Kalpataru Vivant', description: 'A residential tower in Thane.', possessionDate: `${thisYear + 3}-01-01` }).status === 'UNDER_CONSTRUCTION')

// ── isAggregatorTitle still works (unaffected by the new classifier) ────
check('category-page title still rejected by isAggregatorTitle', scoring.isAggregatorTitle('14+ Flats for Sale in Liberty Garden'))
check('a real project name is not flagged as an aggregator title', !scoring.isAggregatorTitle('Arkade Nucleus'))

// Regression: live-caught on "2BHK in Borivali East" — real 99acres.com
// titles, verbatim. isAggregatorTitle()'s "Projects in X" check was still
// ANCHORED at the start of the title (only caught "New Projects in X"
// opening the string); a LIFECYCLE-STATUS phrase prefix ("New Launch"/
// "Under Construction") defeated it, exactly like a "Page 3 -" prefix once
// defeated the equivalent Python-side check before PROJECTS_IN_PLACE_RE was
// added there (unanchored, already correct — this side had never received
// that fix). Both scored PRIMARY/SECONDARY as real listings before this fix.
check('"New Launch Projects in Borivali East, Mumbai" -> category page (lifecycle-phrase-prefixed "Projects in")',
  scoring.isAggregatorTitle('New Launch Projects in Borivali East, Mumbai'))
check('"Under Construction Projects in Borivali East, Mumbai" -> category page (lifecycle-phrase-prefixed "Projects in")',
  scoring.isAggregatorTitle('Under Construction Projects in Borivali East, Mumbai'))
check('the whole lifecycle-phrase family is covered generically, not just these two exact titles',
  ['Ready to Move Projects in Borivali East, Mumbai', 'Upcoming Projects in Borivali East, Mumbai', 'Ongoing Projects in Borivali East, Mumbai']
    .every(t => scoring.isAggregatorTitle(t)))

// ── deterministic scoring/ranking still works ────────────────────────────
const s1 = scoring.scoreExternalProject({ name: 'X', location: 'Malad West' }, { locations: ['Malad West'] })
const s2 = scoring.scoreExternalProject({ name: 'Y', location: 'Pune' }, { locations: ['Malad West'] })
check('exact locality scores higher than a location miss', s1.confidence > s2.confidence)

// Regression: live-caught on "2BHK in Borivali East" — two 3 BHK listings
// (own match reasons literally say "3 BHK does not match your 2 BHK
// request") still scored 58% confidence and were labeled PRIMARY/SECONDARY,
// because (a) scoreExternalProject never capped a configuration mismatch
// the way it already caps a location mismatch, and (b) this pipeline never
// set a real match_tier at all, so ProjectSelection.jsx's PropertyCard fell
// back to pure ARRAY-POSITION labeling (first result = "PRIMARY", second =
// "SECONDARY") regardless of score — the actual mechanism behind two
// identically-scored results getting different tier badges.
const configFilters = { locations: ['Borivali East'], configuration: '2 BHK', bedrooms: 2 }
const wrongConfigItem1 = { name: 'New Launch Projects in Borivali East, Mumbai', location: 'Borivali East', city: 'Mumbai', configuration: '3 BHK', bedrooms: 3, budgetMax: 30700000, sourceQuality: 'medium' }
const wrongConfigItem2 = { name: 'Under Construction Projects in Borivali East, Mumbai', location: 'Borivali East', city: 'Mumbai', configuration: '3 BHK', bedrooms: 3, budgetMax: 19500000, sourceQuality: 'medium' }
const r1 = scoring.scoreExternalProject(wrongConfigItem1, configFilters)
const r2 = scoring.scoreExternalProject(wrongConfigItem2, configFilters)
check('explicit 3BHK-vs-2BHK mismatch caps confidence at 55 (TERTIARY-max, matching the location-mismatch cap)', r1.confidence <= 55 && r2.confidence <= 55)
check('...and both get a real, score-derived TERTIARY tier, never PRIMARY/SECONDARY', r1.tier === 'TERTIARY' && r2.tier === 'TERTIARY')
check('a genuine 2BHK exact match is NOT capped by this rule', scoring.scoreExternalProject({ name: 'Arkade Nucleus Borivali East', location: 'Borivali East', city: 'Mumbai', configuration: '2 BHK', bedrooms: 2, budgetMax: 15000000, sourceQuality: 'high', lastSeenAt: new Date().toISOString() }, configFilters).confidence > 55)
check('a REAL (non-category-page) project with a confirmed wrong configuration is ALSO capped — this is a scoring fix independent of the category-page fix above',
  scoring.scoreExternalProject({ name: 'Sheth Beaumonde Borivali East', location: 'Borivali East', city: 'Mumbai', configuration: '3 BHK', bedrooms: 3, budgetMax: 30700000, sourceQuality: 'high', lastSeenAt: new Date().toISOString() }, configFilters).tier === 'TERTIARY')
check('match_tier is a real, score-derived field on every Node-fallback result now — never left unset', typeof r1.tier === 'string' && r1.tier.length > 0)

// ── buildCanonicalCandidateId: deterministic, and portal-noise-tolerant ──
const idA = externalSearch.buildCanonicalCandidateId({ name: 'Arkade Eden Malad West: Price, Photos & Floor Plans', location: 'Malad West' })
const idB = externalSearch.buildCanonicalCandidateId({ name: 'Arkade Eden Malad West - Brochure, Pros&Cons, PriceSheet', location: 'Malad West' })
check('portal price/brochure page-title noise no longer blocks dedup identity match', idA === idB)
const idC1 = externalSearch.buildCanonicalCandidateId({})
const idC2 = externalSearch.buildCanonicalCandidateId({})
check('degenerate candidate (no rera/name/location/url) still gets a DETERMINISTIC id, not Math.random()', idC1 === idC2)

// ── mergeDuplicateProperties: Part 6 fuzzy entity resolution ────────────
const sameProject = externalSearch.mergeDuplicateProperties([
  { name: 'Arkade Malad West', location: 'Malad West', developer: 'Arkade Group', match_score: 80, sources: [] },
  { name: 'Arkade Liberty Garden Malad', location: 'Liberty Garden, Malad West', developer: 'Arkade Group', match_score: 75, sources: [] },
])
check('same developer + overlapping distinctive name tokens + contained locality -> merged as ONE project', sameProject.length === 1)

const genericWordOnly = externalSearch.mergeDuplicateProperties([
  { name: 'Sunshine Heights', location: 'Malad West', developer: 'Kalpataru', match_score: 80, sources: [] },
  { name: 'Green Heights', location: 'Malad West', developer: 'Godrej', match_score: 75, sources: [] },
])
check('two DIFFERENT projects sharing only a generic word ("Heights") and locality are NOT merged', genericWordOnly.length === 2)

const noisyTitleSameProject = externalSearch.mergeDuplicateProperties([
  { name: 'Arkade Eden Malad West: Price, Photos & Floor Plans', location: 'Malad West', developer: 'Arkade Group', match_score: 80, sources: [] },
  { name: 'Arkade Eden Malad West - Brochure, Pros&Cons, PriceSheet', location: 'Malad West', developer: 'Arkade Group', match_score: 75, sources: [] },
])
check('portal page-title noise no longer blocks the exact merge tier in mergeDuplicateProperties', noisyTitleSameProject.length === 1)

// ── extractSubListings: sub-listing extraction from rejected category pages ──
// Mirrors agent/agent/fact_extraction.py's extract_sub_listings — same
// real live pattern ("...Jadeite Kaveri... P51800079530 is the RERA
// number of the project Jadeite Kaveri...").
const categoryPageDoc = {
  name: 'New Projects in Charkop, Kandivali West: 33+ Upcoming Projects',
  description: 'Jadeite Kaveri is a premium 1 BHK project priced at Rs.75 Lakhs with possession by Dec 2027. P51800079530 is the RERA number of the project Jadeite Kaveri. Ruparel Optima is under construction, offering 1 BHK flats at 650 sq ft carpet area. P51800081234 is the RERA number of the project Ruparel Optima.',
  sourceName: '99acres', sourceUrl: 'https://99acres.com/charkop-projects', location: 'Charkop, Kandivali West', currency: 'INR',
}
const subListings = externalSearch.extractSubListings(categoryPageDoc)
check('sub-listing extraction finds both real, RERA-anchored projects', subListings.length === 2)
check('extracted names are correct', subListings.some(s => s.name === 'Jadeite Kaveri') && subListings.some(s => s.name === 'Ruparel Optima'))
const jadeiteSub = subListings.find(s => s.name === 'Jadeite Kaveri')
const ruparelSub = subListings.find(s => s.name === 'Ruparel Optima')
check('facts do NOT bleed across adjacent projects — Jadeite gets its own real price (Rs.75L -> 7500000)', jadeiteSub.budgetMax === 7500000)
check('facts do NOT bleed across adjacent projects — Ruparel has NO price (never mentioned for it)', ruparelSub.budgetMax === null)
check('sub-listing names are correctly NOT flagged as aggregator pages themselves', !scoring.isAggregatorTitle(jadeiteSub.name) && !scoring.isAggregatorTitle(ruparelSub.name))
check('the wrapper page itself is STILL correctly flagged as an aggregator (rejected as before)', scoring.isAggregatorTitle(categoryPageDoc.name))
check('sub-listing source_url points back to the real page it came from', jadeiteSub.sourceUrl === categoryPageDoc.sourceUrl)

const noReraCategoryPage = { name: 'Flats for Sale in Malad West', description: 'Many builders offer great flats here with modern amenities and good connectivity.' }
check('a category page with NO real RERA-anchored project mention extracts nothing (never guessed)', externalSearch.extractSubListings(noReraCategoryPage).length === 0)

// ── Places-augmented pipeline (Part 1/2/38) ──────────────────────────────
// looksLikeInvalidName() — real live examples from this investigation, not
// synthetic ones. "Security Alert" is the real candidate name live-observed
// for query "2bhk in borivali east" (traced to a 99acres page that most
// plausibly served a bot-detection/interstitial page instead of its real
// listing content).
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
// still gets its existing scoring, unaffected by this pass's additions.
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
