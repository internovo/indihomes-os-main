'use strict'
// Shared Google Places (New) Text Search client — extracted from
// server.cjs's /api/competing-projects (Part 16/31) so the new Places-based
// discovery/verification connector (external-connectors.cjs, called both by
// the Node fallback pipeline directly and via agent-tools-bridge.cjs for the
// Python agent) reuses the EXACT SAME endpoint/auth/residential-type-filter
// rather than a second, drifting copy. Same key, same client, confirmed —
// GOOGLE_PLACES_API_KEY is read once, here, and everywhere else requires it
// from this module.

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.VITE_GOOGLE_MAPS_KEY || ''
function isPlacesConfigured() { return !!GOOGLE_PLACES_KEY }

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

// One shared POST places:searchText call. `lat`/`lon` are optional — Part 16
// (competing-projects) always has an already-known project location to
// search AROUND (locationBias circle); Part 1/2's new discovery/verification
// uses don't have that yet (discovery is finding candidates FROM SCRATCH;
// verification checks a name+locality that hasn't been geocoded) and rely on
// Places' own free-text place-name understanding in `textQuery` instead —
// omitting locationBias in that case, never fabricating coordinates to bias
// with.
async function searchPlacesText(textQuery, { lat, lon, radiusKm, maxResultCount = 20, timeoutMs = 10000 } = {}) {
  if (!isPlacesConfigured()) return { configured: false, places: [] }
  const body = { textQuery, maxResultCount }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: (radiusKm || 3) * 1000 } }
  }
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.types',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '')
    // See server.cjs's original /api/competing-projects comment (now here)
    // for why the details[].reason field matters more than the top-level
    // message — API_KEY_SERVICE_BLOCKED vs API_KEY_API_NOT_ENABLED vs
    // SERVICE_DISABLED are three genuinely different root causes that all
    // otherwise present as an identical top-level PERMISSION_DENIED.
    let reason = null
    try {
      const parsed = JSON.parse(bodyText)
      reason = parsed?.error?.details?.find(d => d.reason)?.reason || null
    } catch (_) { /* non-JSON error body */ }
    throw new Error(`Google Places ${resp.status}${reason ? ` (${reason})` : ''}: ${bodyText.slice(0, 300)}`)
  }
  const data = await resp.json()
  const places = (data.places || [])
    .filter(p => p.displayName?.text && p.location)
    .filter(p => !(p.types || []).some(t => NON_RESIDENTIAL_PLACE_TYPES.has(t)))
    .map(p => ({
      name: p.displayName.text,
      address: p.formattedAddress || null,
      lat: p.location.latitude,
      lon: p.location.longitude,
      placeId: p.id,
      mapsUrl: p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      types: p.types || [],
    }))
  return { configured: true, places }
}

module.exports = { NON_RESIDENTIAL_PLACE_TYPES, isPlacesConfigured, searchPlacesText, searchResidentialPlaces, isBookingOrRentalPlatform }

// searchResidentialPlaces — the AI Search discovery path (Section: "make AI
// Search work like a direct Maps search"). A SEPARATE function from
// searchPlacesText above, not a shared/parameterized variant of it,
// because the two have genuinely different requirements: searchPlacesText
// (Competitor Analysis) needs a STRICT residential-only filter around an
// ALREADY-KNOWN project's coordinates; this needs BROAD discovery FROM a
// text query alone (no known location yet), richer display fields
// (rating/review count/place type — confirmed missing from the existing
// field mask, and exactly what a real side-by-side manual Places search
// returns), and must NOT exclude real_estate_agency (a live reference
// example explicitly included brokers/agencies as legitimate, useful
// results for a buyer-facing search — excluding them would be over-
// filtering for this specific use case, even though Competitor Analysis
// correctly excludes them for ITS use case).
// Booking/rental/travel platforms explicitly excluded from Places-direct
// discovery (searchResidentialPlaces) — these are never a residential
// building for sale, even when Places' text-relevance surfaces them for a
// "residential apartment" query (a hotel/serviced-stay or a booking
// aggregator's own business listing can share enough text overlap to rank).
// Deterministic name/domain/type match, not a vague heuristic — extend
// BOOKING_PLATFORM_NAME_RE (name/website match) or BOOKING_PLACE_TYPES
// (Places' own type taxonomy) if a new platform shows up in results.
//   - Names/domains checked: booking.com, airbnb (.com/.in), makemytrip,
//     oyo (rooms), goibibo, cleartrip, yatra, treebo, fabhotels, agoda,
//     trivago, expedia — established booking/travel aggregators and
//     budget-stay chains, not residential developers/CHSs.
//   - Types checked: 'lodging'/'hotel'/'travel_agency'/'vacation_rental_agency'
//     are Google's own categories for stays/bookings — never a residential-
//     for-sale building, excluded unconditionally. 'real_estate_agency' is
//     deliberately NOT blanket-excluded here (a real brokerage is still a
//     legitimate discovery result for this text-search use case, same
//     reasoning as this function's own header comment) — only excluded
//     when its name/website ALSO matches a known booking platform above.
// Dubai-specific gap found live (Places-direct extended to Dubai, Part:
// "make Dubai search work like India"): "La Buena Vida Holiday Homes" and
// "Ain View Studio (Holiday Rental), JBR, Dubai" both surfaced in a real
// Dubai Marina search and matched none of the named-platform patterns
// above (they're not booking.com/Airbnb by name) nor BOOKING_PLACE_TYPES
// (their Places `types` didn't include vacation_rental_agency/lodging on
// this real result) — Dubai's holiday-home/serviced-stay market is large
// enough that a generic phrase match is worth it here, unlike India where
// the named-platform list above already covers the dominant players.
const BOOKING_PLATFORM_NAME_RE = /\bbooking\.com\b|\bairbnb(?:\.com|\.in)?\b|\bmakemytrip\b|\boyo(?:\s*rooms?)?\b|\bgoibibo\b|\bcleartrip\b|\byatra\b|\btreebo\b|\bfabhotels?\b|\bagoda\b|\btrivago\b|\bexpedia\b/i
const HOLIDAY_RENTAL_NAME_RE = /\bholiday\s*home(s)?\b|\bholiday\s*rental\b|\bshort[\s-]?term\s*rental\b|\bserviced\s*apartments?\b|\bvacation\s*rental\b/i
const BOOKING_PLACE_TYPES = new Set(['lodging', 'hotel', 'travel_agency', 'vacation_rental_agency'])
function isBookingOrRentalPlatform(p) {
  if ((p.types || []).some(t => BOOKING_PLACE_TYPES.has(t))) return true
  if (BOOKING_PLATFORM_NAME_RE.test(p.name || '')) return true
  if (HOLIDAY_RENTAL_NAME_RE.test(p.name || '')) return true
  if (p.website && (BOOKING_PLATFORM_NAME_RE.test(p.website) || HOLIDAY_RENTAL_NAME_RE.test(p.website))) return true
  return false
}

async function searchResidentialPlaces(textQuery, { maxResultCount = 20, timeoutMs = 10000 } = {}) {
  if (!isPlacesConfigured()) return { configured: false, places: [] }
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.types,places.primaryTypeDisplayName,places.rating,places.userRatingCount,places.websiteUri',
    },
    body: JSON.stringify({ textQuery, maxResultCount }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '')
    let reason = null
    try { reason = JSON.parse(bodyText)?.error?.details?.find(d => d.reason)?.reason || null } catch (_) {}
    throw new Error(`Google Places ${resp.status}${reason ? ` (${reason})` : ''}: ${bodyText.slice(0, 300)}`)
  }
  const data = await resp.json()
  const places = (data.places || [])
    .filter(p => p.displayName?.text && p.location)
    .map(p => ({
      name: p.displayName.text,
      address: p.formattedAddress || null,
      lat: p.location.latitude,
      lon: p.location.longitude,
      placeId: p.id,
      mapsUrl: p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      types: p.types || [],
      placeType: p.primaryTypeDisplayName?.text || (p.types || [])[0] || null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      website: p.websiteUri || null,
    }))
    // Item 4 — cheap, deterministic, no search needed, applied BEFORE any
    // per-result web search (server.cjs) gets a chance to spend time on a
    // result that was never a residential building in the first place.
    .filter(p => !isBookingOrRentalPlatform(p))
  return { configured: true, places }
}

// ── Nearby infrastructure (Location Score / Connectivity / Nearby Landmarks)
// The functions above all exist to find RESIDENTIAL PROJECTS, so they filter
// NON_RESIDENTIAL_PLACE_TYPES out. This one wants the opposite set: the
// stations, schools, hospitals and shops that make a location good or bad.
// Same key, same Places (New) API — deliberately a separate function rather
// than a flag on searchPlacesText(), because a boolean that inverts a
// function's core filter is how the residential search eventually starts
// returning hospitals.
//
// Why this exists: `connectivity` and `nearby_landmarks` measured 0/8 in
// every run, because an LLM was being asked to infer them from portal
// marketing prose. They are facts about a coordinate, and Places answers
// them directly, with real distances, on a key this deployment already holds.
//
// SCORED BY DISTANCE, NOT BY COUNT — this is the whole design, and it is the
// correction to a first cut that scored on "how many of X within 2 km".
// Measured live against a real Borivali East coordinate, that version
// returned 100/100 with every category saturated at the 12-result cap: in
// dense urban Mumbai there are always plenty of everything within 2 km, so a
// count-based score is a constant, not a discriminator. What actually
// separates two Mumbai addresses is HOW FAR the nearest station is, not
// whether one exists. Counts are still returned for context; they no longer
// drive the number.

// One entry per scored dimension. `types` are Places (New) includedTypes.
// `full_m` = distance at or below which this dimension scores its full
// weight; `zero_m` = distance at or beyond which it scores nothing; linear
// in between. `radius_m` is how far out we are willing to look at all.
//
// Type choices are deliberately narrow, from live output on a real
// coordinate: the first cut included `university` under education and got
// coaching classes ("Shree Classes", "Eagle IAS Academy") typed as
// universities; it included `pharmacy`/`doctor` under healthcare and scored a
// tower full marks off four neighbourhood chemists; and `grocery_store` under
// retail counted every kirana shop. Narrow types cost recall on paper and buy
// a number that means something.
const NEARBY_DIMENSIONS = {
  // Rail and metro get their OWN dimension, queried separately from buses.
  // Combined, the 12-result distance-ranked cap filled entirely with bus
  // stops within 350 m and Borivali's actual suburban railway station — the
  // single most valuable transit fact about this address — never appeared.
  rail_metro: {
    types: ['train_station', 'subway_station', 'light_rail_station'],
    weight: 30, full_m: 800, zero_m: 3000, radius_m: 4000,
  },
  bus: {
    types: ['bus_station', 'bus_stop'],
    weight: 10, full_m: 300, zero_m: 1200, radius_m: 1500,
  },
  education: {
    types: ['school', 'primary_school', 'secondary_school'],
    weight: 15, full_m: 800, zero_m: 2500, radius_m: 3000,
  },
  healthcare: {
    types: ['hospital'],
    weight: 15, full_m: 1000, zero_m: 3000, radius_m: 3500,
  },
  retail: {
    // department_store dropped after live output: it matched a saree shop
    // and an opticians, which then displaced the real mall as "nearest
    // retail". Indian high-street shops carry very loose Places types.
    types: ['supermarket', 'shopping_mall'],
    weight: 20, full_m: 1000, zero_m: 3000, radius_m: 3500,
  },
  green: {
    types: ['park'],
    weight: 10, full_m: 600, zero_m: 2000, radius_m: 2500,
  },
}

// What a buyer would recognise as a landmark. The first cut derived landmarks
// from "nearest of anything", which on a real coordinate produced eight
// pharmacies and clinics between 16 m and 42 m — accurate, and useless.
const LANDMARK_TYPES = [
  'shopping_mall', 'hospital', 'train_station', 'subway_station', 'park',
  'university', 'stadium', 'tourist_attraction', 'movie_theater', 'airport',
]

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

async function searchNearbyByTypes(lat, lon, includedTypes, { radiusM = 2000, maxResultCount = 10, timeoutMs = 10000 } = {}) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.types,places.primaryType,places.primaryTypeDisplayName',
    },
    body: JSON.stringify({
      includedTypes,
      maxResultCount,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: radiusM } },
      rankPreference: 'DISTANCE',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '')
    // Same reasoning as searchPlacesText above: details[].reason separates
    // API_KEY_SERVICE_BLOCKED / API_NOT_ENABLED / SERVICE_DISABLED, which all
    // present identically at the top level.
    let reason = null
    try { reason = JSON.parse(bodyText)?.error?.details?.find(d => d.reason)?.reason || null } catch (_) { /* non-JSON body */ }
    throw new Error(`Google Places Nearby ${resp.status}${reason ? ` (${reason})` : ''}: ${bodyText.slice(0, 300)}`)
  }
  const data = await resp.json()
  return (data.places || [])
    .filter(p => p.displayName?.text && p.location)
    // Google's own `types` array is noisy — a coaching class comes back
    // carrying both `university` and `police`, and a saree shop carries
    // `department_store`. Requiring the requested type to appear at all is a
    // weak check; it drops entries whose only link to the query was a stray
    // secondary type, but keeps ones where the match is incidental.
    .filter(p => (p.types || []).some(t => includedTypes.includes(t)))
    .map(p => ({
      name: p.displayName.text,
      kind: p.primaryTypeDisplayName?.text || p.primaryType || (p.types || [])[0] || null,
      lat: p.location.latitude,
      lon: p.location.longitude,
      distance_m: haversineMetres(lat, lon, p.location.latitude, p.location.longitude),
      placeId: p.id,
      // True when this is PRIMARILY the thing we asked for, rather than
      // something that merely carries the type as a secondary tag. Live
      // example: "Divya Prabhat & Saree Centre" carried `department_store`
      // and, being nearest, became the "nearest retail" ahead of an actual
      // shopping mall 30 m further on.
      primary_match: includedTypes.includes(p.primaryType),
    }))
    // Primary-type matches rank ahead of incidental ones, distance breaking
    // ties within each group. Incidental matches are KEPT rather than
    // filtered: Places sometimes gives a genuine school a primaryType of
    // point_of_interest, and dropping those would cost real coverage. This
    // only decides which one gets to be called "nearest".
    .sort((a, b) => (a.primary_match === b.primary_match)
      ? a.distance_m - b.distance_m
      : (a.primary_match ? -1 : 1))
}

// Linear decay from full_m to zero_m. Returns 0 when nothing was found at
// all — which is a real statement ("no hospital within 3.5 km"), not a
// missing value.
function dimensionPoints(nearestDistanceM, { weight, full_m, zero_m }) {
  if (nearestDistanceM == null) return 0
  if (nearestDistanceM <= full_m) return weight
  if (nearestDistanceM >= zero_m) return 0
  return Math.round(weight * ((zero_m - nearestDistanceM) / (zero_m - full_m)))
}

// Deterministic and explainable. Every dimension reports the nearest place by
// name, its distance, the thresholds used and the points earned — a bare
// 0-100 with no working shown is neither defensible to a buyer nor
// debuggable by us. The weights and thresholds are a stated editorial
// choice, not a derived truth; they live in NEARBY_DIMENSIONS so they can be
// argued with and changed in one place.
function computeLocationScore(byDimension) {
  const components = {}
  let total = 0
  for (const [name, spec] of Object.entries(NEARBY_DIMENSIONS)) {
    const places = byDimension[name] || []
    const nearest = places.length ? places[0] : null
    const points = dimensionPoints(nearest ? nearest.distance_m : null, spec)
    components[name] = {
      weight: spec.weight,
      points,
      nearest: nearest ? { name: nearest.name, distance_m: nearest.distance_m, kind: nearest.kind } : null,
      count_within_radius: places.length,
      full_marks_within_m: spec.full_m,
      zero_marks_beyond_m: spec.zero_m,
    }
    total += points
  }
  return { score: total, out_of: 100, components }
}

// Everything the Location Score, Connectivity and Nearby Infrastructure tabs
// need, from one coordinate. Never guesses: an unconfigured key or an empty
// dimension returns null/[] rather than a plausible-looking number.
async function nearbyInfrastructure(lat, lon, { radiusM = null, dimensions = null } = {}) {
  if (!isPlacesConfigured()) {
    return { configured: false, by_dimension: {}, connectivity: null, nearby_landmarks: [], location_score: null }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('nearbyInfrastructure requires finite lat/lon — never call it with a guessed coordinate')
  }
  const wanted = dimensions && dimensions.length
    ? Object.fromEntries(Object.entries(NEARBY_DIMENSIONS).filter(([k]) => dimensions.includes(k)))
    : NEARBY_DIMENSIONS

  const entries = await Promise.all(Object.entries(wanted).map(async ([name, spec]) => {
    try {
      return [name, await searchNearbyByTypes(lat, lon, spec.types, { radiusM: radiusM || spec.radius_m })]
    } catch (e) {
      // One dimension failing must not lose the others — reported as empty
      // with the reason logged, never as a silent zero that reads like
      // "there is no hospital here".
      console.warn(`[places-nearby] ${name} failed:`, e.message)
      return [name, []]
    }
  }))
  const byDimension = Object.fromEntries(entries)

  // Connectivity leads with rail/metro (the fact that actually differentiates
  // a Mumbai address) and only then mentions the nearest bus stop.
  const rail = byDimension.rail_metro || []
  const bus = byDimension.bus || []
  const connectivityParts = [
    ...rail.slice(0, 2).map(p => `${p.name} (${p.distance_m} m)`),
    ...bus.slice(0, 1).map(p => `${p.name} bus stop (${p.distance_m} m)`),
  ]
  const connectivity = connectivityParts.length ? connectivityParts.join('; ') : null

  let landmarks = []
  try {
    landmarks = (await searchNearbyByTypes(lat, lon, LANDMARK_TYPES, { radiusM: 3000, maxResultCount: 10 }))
      .slice(0, 6)
      .map(p => `${p.name} — ${p.kind || 'landmark'} (${p.distance_m} m)`)
  } catch (e) {
    console.warn('[places-nearby] landmarks failed:', e.message)
  }

  return {
    configured: true,
    by_dimension: byDimension,
    connectivity,
    nearby_landmarks: landmarks,
    location_score: computeLocationScore(byDimension),
  }
}

module.exports.NEARBY_DIMENSIONS = NEARBY_DIMENSIONS
module.exports.LANDMARK_TYPES = LANDMARK_TYPES
module.exports.haversineMetres = haversineMetres
module.exports.dimensionPoints = dimensionPoints
module.exports.computeLocationScore = computeLocationScore
module.exports.nearbyInfrastructure = nearbyInfrastructure
