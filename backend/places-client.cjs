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
const BOOKING_PLATFORM_NAME_RE = /\bbooking\.com\b|\bairbnb(?:\.com|\.in)?\b|\bmakemytrip\b|\boyo(?:\s*rooms?)?\b|\bgoibibo\b|\bcleartrip\b|\byatra\b|\btreebo\b|\bfabhotels?\b|\bagoda\b|\btrivago\b|\bexpedia\b/i
const BOOKING_PLACE_TYPES = new Set(['lodging', 'hotel', 'travel_agency', 'vacation_rental_agency'])
function isBookingOrRentalPlatform(p) {
  if ((p.types || []).some(t => BOOKING_PLACE_TYPES.has(t))) return true
  if (BOOKING_PLATFORM_NAME_RE.test(p.name || '')) return true
  if (p.website && BOOKING_PLATFORM_NAME_RE.test(p.website)) return true
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
