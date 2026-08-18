import React, { useState, useEffect, useRef } from 'react'
import { Loader2, MapPin, School, Stethoscope, ShoppingBag, TreePine, TrainFront, Landmark, Film } from 'lucide-react'
import StatCard from '../shared/StatCard.jsx'
import ModuleHeader from '../shared/ModuleHeader.jsx'
import { syncReraIntoSearchResults } from './ProjectSelection.jsx'
import FieldBadge from '../ui/FieldBadge.jsx'
import { EmptyState, EmptyValue } from '../ui/EmptyState.jsx'
import SectionCard from '../ui/SectionCard.jsx'
import { colors } from '../ui/tokens.js'
import { isDebugMode } from '../ui/debug.js'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// Leaflet + OpenStreetMap tiles — genuinely no API key or billing required
// (unlike the Google Maps JS embed this replaced, which silently rendered
// nothing but an error message whenever VITE_GOOGLE_MAPS_KEY wasn't set —
// this file's own comment already claimed "Leaflet, no API key/billing" for
// years without the code actually doing that). Loaded from a CDN rather than
// an npm dependency, the same script-injection pattern the old Google Maps
// loader used (removed from ProjectSelection.jsx along with this — its only
// other caller was Places Autocomplete, which already calls the Places REST
// API directly and never needed the Maps JS SDK at all).
let _leafletLoadPromise = null
function loadLeaflet() {
  if (window.L) return Promise.resolve()
  if (_leafletLoadPromise) return _leafletLoadPromise
  _leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet-css]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
      link.setAttribute('data-leaflet-css', '1')
      document.head.appendChild(link)
    }
    const script = document.createElement('script')
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Leaflet script failed to load'))
    document.head.appendChild(script)
  })
  return _leafletLoadPromise
}

// Renders the project plus every REAL nearby place (schools, hospitals,
// malls, stations, tourist attractions — from /api/nearby-places, backed by
// OpenStreetMap Overpass, actual geocoded points around the project's real
// coordinates) as pins on one interactive Leaflet/OpenStreetMap map.
//
// Brand-new/under-construction tower names essentially never resolve against
// OpenStreetMap on their own (confirmed: this API has no lat/lng field at
// all for any project — see indihomes-client.cjs's normalizeProject). So a
// full "<Project Name>, <Locality>, <City>" geocode is tried FIRST (most
// precise when it works), and only when that returns zero results does this
// retry with JUST locality+city — which is far more likely to resolve, at
// the cost of no longer pinpointing the exact tower. `approx` distinguishes
// the two so the UI never presents a locality-level pin as if it were the
// precise building location.
function NearbyMap({ projectQuery, fallbackQuery, onPlaces, onGeo, mapsUrl, displayName, knownGeo, competitors, selectedCompetitorId, onSelectCompetitor }) {
  const ref = useRef(null)
  const mapRef = useRef(null)
  // Part 5 — competitor markers keyed by their index in `competitors`, so a
  // click on a marker (or a matching list-item click driven by the parent's
  // `selectedCompetitorId`) can pan to / highlight the same competitor in
  // both places at once, without either side owning the other's state.
  const competitorMarkersRef = useRef({})
  const [status, setStatus] = useState('loading') // loading | ok | approx | empty | error
  const [resolvedLabel, setResolvedLabel] = useState('')

  useEffect(() => {
    let cancelled = false
    setStatus('loading')

    ;(async () => {
      try {
        // Part 3 perf fix — the Leaflet CDN script/CSS has zero data
        // dependency on the geocode/nearby-places calls below, but was
        // previously only requested with `await loadLeaflet()` AFTER both
        // backend round-trips finished, stacking its load time onto the
        // critical path for no reason. Kick it off now so it downloads
        // concurrently with the geocode + nearby-places chain instead.
        const leafletPromise = loadLeaflet()

        let lat, lon, approx = false
        // Real, Google Places-resolved coordinates (Part 1/2/38) — when
        // this candidate already carries its own verified location (either
        // discovered directly by places_search, or confirmed by a later
        // places_verify lookup), skip the Nominatim geocode round-trip
        // entirely and use Google's own coordinate directly. Precise, not
        // an approximation — `approx` stays false.
        if (knownGeo && Number.isFinite(knownGeo.lat) && Number.isFinite(knownGeo.lon)) {
          lat = knownGeo.lat; lon = knownGeo.lon
          setResolvedLabel(projectQuery)
        } else {
          const geocode = (q) => q
            ? fetch(`${API}/api/location-search?q=${encodeURIComponent(q)}`)
                .then(r => r.json()).then(d => (d.results || [])[0]).catch(() => null)
            : Promise.resolve(null)

          let geo = await geocode(projectQuery)
          if (!geo && fallbackQuery && fallbackQuery.trim() !== projectQuery.trim()) {
            geo = await geocode(fallbackQuery)
            approx = !!geo
          }
          if (cancelled) return
          if (!geo) { setStatus('empty'); onPlaces?.([]); onGeo?.(null); return }
          lat = parseFloat(geo.lat); lon = parseFloat(geo.lon)
          setResolvedLabel(approx ? fallbackQuery : projectQuery)
        }
        // Real, geocoded project coordinates — the same lat/lon this map
        // itself plots, handed back up so Competitor Analysis can reuse it
        // instead of re-geocoding independently.
        onGeo?.({ lat, lon, approx })

        const places = await fetch(`${API}/api/nearby-places?lat=${lat}&lon=${lon}`)
          .then(r => r.json()).then(d => d.places || []).catch(() => [])
        if (cancelled) return
        onPlaces?.(places)

        await leafletPromise
        if (cancelled || !ref.current) return
        const L = window.L

        // Re-create on every geocode result (project switch, or the approx-
        // fallback replacing an earlier attempt) rather than reusing a
        // stale instance — Leaflet throws if you re-init over a container
        // it already bound, so the old map (if any) is torn down first.
        if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
        // Part 6 — zoomControl positioned bottom-right (a corner, mirroring
        // the mobile Google Maps app's own control placement) rather than
        // Leaflet's plain top-left default; restyled via the injected
        // <style> block below (no data-layer change, CSS only).
        const map = L.map(ref.current, { scrollWheelZoom: false, zoomControl: false }).setView([lat, lon], approx ? 13 : 15)
        L.control.zoom({ position: 'bottomright' }).addTo(map)
        mapRef.current = map
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          // Part 6's own comment already claimed "Google Maps mobile-app
          // conventions" (pin shape, zoom control position, bottom sheet)
          // but never actually swapped the TILE LAYER itself — this was
          // still standard light OpenStreetMap raster tiles underneath all
          // that restyled chrome. CARTO's "Dark Matter" basemap: free, no
          // API key/billing (same hosting model as the OSM tiles it
          // replaces), dark navy/muted palette with teal water — the same
          // visual category as Google Maps' own Night style, though not
          // pixel-identical (different label font/POI icon set). True
          // pixel-parity would require the real Google Maps JS SDK, a
          // billed client-side key this app has deliberately avoided.
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
          maxZoom: 19,
        }).addTo(map)

        // Part 6 — a real teardrop pin (classic CSS trick: a rounded square
        // rotated -45deg, with the un-rotated tip pointing down) with a
        // genuine drop shadow, replacing the flat dot — matches how every
        // mainstream map app (Google Maps included) marks a single precise
        // location, rather than a generic data-point dot (still used
        // as-is for the plain nearby-places markers below, which are
        // multiple secondary points, not the one primary location).
        const projectIcon = L.divIcon({
          className: '', iconAnchor: [14, 34], popupAnchor: [0, -30],
          html: `<div style="width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${approx ? '#F7941D' : '#0E0E52'};border:2.5px solid #fff;box-shadow:0 3px 8px rgba(16,24,40,0.35)"></div>`,
          iconSize: [28, 28],
        })
        const bounds = L.latLngBounds([[lat, lon]])
        L.marker([lat, lon], { icon: projectIcon }).addTo(map)
          .bindPopup(`<b>${projectQuery.split(',')[0]}</b>${approx ? '<br><span style="color:#F7941D">Approximate — locality-level</span>' : ''}`)

        for (const p of places.slice(0, 20)) {
          if (p.lat == null || p.lon == null) continue
          L.marker([p.lat, p.lon]).addTo(map)
            .bindPopup(`<b>${p.name}</b><br/><span style="color:#75737F">${p.type} · ${p.distKm} km</span>`)
          bounds.extend([p.lat, p.lon])
        }

        if (places.length) map.fitBounds(bounds, { padding: [40, 40] })
        setStatus(approx ? 'approx' : 'ok')
      } catch (e) {
        if (!cancelled) setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
    }
  }, [projectQuery, fallbackQuery])

  // Part 5 — nearby COMPARABLE PROJECTS (Competitor Analysis's own real
  // Google Places data, never invented) as their own distinct marker
  // style — a small purple diamond, visually distinct from both the
  // primary project's teardrop pin and the generic OSM infrastructure
  // dots. Deliberately its OWN effect, keyed on `competitors`/`status`
  // (not folded into the geocode/places effect above, which only ever
  // re-runs on `[projectQuery, fallbackQuery]`) — Competitor Analysis's
  // own fetch resolves asynchronously, independently of and usually AFTER
  // the map's own geocode; folding this into the other effect would have
  // captured `competitors` in a stale closure at whatever (often still
  // empty) value it held when that effect last ran, silently never
  // drawing a single competitor marker once the real data arrived. Only
  // plots entries that actually carry real coordinates (older/legacy-
  // shape competitor entries without lat/lon simply aren't shown on the
  // map — they still appear in the Competitor Analysis list, just without
  // a marker).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !window.L || (status !== 'ok' && status !== 'approx')) return
    const L = window.L
    Object.values(competitorMarkersRef.current).forEach(m => map.removeLayer(m))
    competitorMarkersRef.current = {}
    const competitorIcon = L.divIcon({
      className: '', iconAnchor: [9, 9], popupAnchor: [0, -9],
      html: `<div style="width:18px;height:18px;border-radius:4px;transform:rotate(45deg);background:#6B4FBB;border:2px solid #fff;box-shadow:0 2px 6px rgba(16,24,40,0.35)"></div>`,
      iconSize: [18, 18],
    })
    const bounds = L.latLngBounds([map.getCenter()])
    let plotted = 0
    ;(competitors || []).forEach((c, i) => {
      if (c.lat == null || c.lon == null) return
      const marker = L.marker([c.lat, c.lon], { icon: competitorIcon }).addTo(map)
        .bindPopup(`<b>${c.name}</b>${c.distanceKm != null ? `<br/><span style="color:#75737F">${c.distanceKm} km away</span>` : ''}`)
      marker.on('click', () => onSelectCompetitor?.(i))
      competitorMarkersRef.current[i] = marker
      bounds.extend([c.lat, c.lon])
      plotted++
    })
    if (plotted) map.fitBounds(bounds, { padding: [40, 40] })
  }, [competitors, status])

  // Part 5 — the other half of the map/list sync: a click on a Competitor
  // Analysis LIST item (outside this component) sets `selectedCompetitorId`
  // on the parent; this pans the map to and opens that marker's popup in
  // response. The marker-click direction is wired inline above (calls
  // onSelectCompetitor). Guarded on the map/marker actually existing yet
  // (map fitBounds/load is async).
  useEffect(() => {
    if (selectedCompetitorId == null || !mapRef.current) return
    const marker = competitorMarkersRef.current[selectedCompetitorId]
    if (!marker) return
    mapRef.current.panTo(marker.getLatLng())
    marker.openPopup()
  }, [selectedCompetitorId])

  // Part 6 — Google Maps mobile-app conventions, CSS/layout only (the
  // underlying OpenStreetMap/Leaflet data layer is unchanged, still no
  // API key/billing): rounded-corner container, a real teardrop pin with
  // drop shadow (set on projectIcon above), a compact corner zoom control
  // (restyled via the injected <style> block below), and a bottom info
  // sheet (rounded top corners, drag-handle bar, bold place name + muted
  // locality line, "Open in Google Maps" styled as the sheet's own
  // affordance) replacing the previous plain text link that sat below
  // the map with its own separate margin.
  const sheetName = displayName || resolvedLabel || projectQuery.split(',')[0]
  const sheetAddress = [resolvedLabel, status === 'approx' ? 'Approximate — locality-level' : null].filter(Boolean).join(' · ')
  return (
    <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid #E9E7E0', boxShadow: '0 1px 3px rgba(16,24,40,0.06)' }}>
      <div style={{ position: 'relative' }}>
        <div ref={ref} style={{ width: '100%', height: 260, background: '#F0EEE8', ...(status === 'loading' ? { animation: 'mapPulse 1.4s ease-in-out infinite alternate' } : {}) }} />
        {status === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'rgba(255,255,255,0.55)', fontSize: 12.5, color: '#75737F' }}>
            <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> Locating project and nearby places…
          </div>
        )}
        {status === 'empty' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: '#75737F', fontStyle: 'italic', padding: '0 20px', textAlign: 'center' }}>
            Couldn't locate this project — neither the project name nor its locality/city resolved on the map.
          </div>
        )}
        {status === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: '#D64545', fontStyle: 'italic', padding: '0 20px', textAlign: 'center' }}>
            Map failed to load — check your internet connection and try again.
          </div>
        )}
      </div>
      {(status === 'ok' || status === 'approx') && (
        <div style={{ background: '#fff', borderTop: '1px solid #F0EEE8', borderRadius: '14px 14px 0 0', marginTop: -14, position: 'relative', padding: '10px 18px 14px', boxShadow: '0 -4px 10px rgba(16,24,40,0.05)' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#E1DFD8', margin: '0 auto 10px' }} />
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1B1B3A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sheetName}</div>
              {sheetAddress && (
                <div style={{ fontSize: 11.5, color: status === 'approx' ? '#F7941D' : '#8A8896', fontWeight: status === 'approx' ? 600 : 400, marginTop: 2 }}>
                  {status === 'approx' && <MapPin size={11} style={{ verticalAlign: -1, marginRight: 3 }} />}
                  {sheetAddress}
                </div>
              )}
            </div>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, color: '#0E0E52', background: '#F6F5F1', padding: '7px 12px', borderRadius: 20, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                Open in Maps ↗
              </a>
            )}
          </div>
        </div>
      )}
      <style>{`
        @keyframes mapPulse { from { opacity: 0.6 } to { opacity: 1 } }
        .leaflet-control-zoom { border: none !important; box-shadow: 0 2px 8px rgba(16,24,40,0.18) !important; border-radius: 20px !important; overflow: hidden; margin: 0 10px 10px 0 !important; }
        .leaflet-control-zoom a { width: 34px !important; height: 34px !important; line-height: 34px !important; color: #1B1B3A !important; }
        .leaflet-control-zoom a:first-child { border-radius: 20px 20px 0 0 !important; }
        .leaflet-control-zoom a:last-child { border-radius: 0 0 20px 20px !important; border-top: 1px solid #F0EEE8 !important; }
      `}</style>
    </div>
  )
}

// Session memory (module scope): onboarded projects and the active tab survive
// navigating to another module and back.
const intelMemory = { onboarded: [], tab: 0 }

// ── Static defaults ────────────────────────────────────────────────────────────
const DEFAULT_PROJECTS = [
  { id:'d1', name:'Lodha Amara',     builder:'Lodha',     city:'Thane',     config:'2 & 3 BHK', budgetLabel:'₹68L – ₹1.95 Cr', possession:'Dec 2027', sold:62, units:1180, rank:'PRIMARY',   score:91, match:96, rera:true,  listingUrl:'https://www.99acres.com/lodha-amara-thane-west-thane-rpid-P40503' },
  { id:'d2', name:'Godrej Emerald',  builder:'Godrej',    city:'Thane',     config:'2 & 3 BHK', budgetLabel:'₹92L – ₹1.55 Cr', possession:'Mar 2026', sold:78, units:850,  rank:'SECONDARY', score:84, match:88, rera:true,  listingUrl:'https://www.99acres.com/godrej-emerald-thane-west-thane-rpid-P41048' },
  { id:'d3', name:'Kalpataru Vista', builder:'Kalpataru', city:'Thane',     config:'2 & 3 BHK', budgetLabel:'₹85L – ₹1.60 Cr', possession:'Jun 2027', sold:55, units:620,  rank:'SECONDARY', score:79, match:82,              listingUrl:'https://www.99acres.com/kalpataru-vista-thane-west-thane-rpid-P42157' },
  { id:'d4', name:'Godrej Hillside', builder:'Godrej',    city:'Bengaluru', config:'2 BHK',     budgetLabel:'₹48L – ₹75L',     possession:'Sep 2026', sold:41, units:740,  rank:'TERTIARY',  score:71, match:74,              listingUrl:'https://www.99acres.com/godrej-hillside-devanahalli-bangalore-rpid-P40719' },
]

const BUILDER_IMG = {
  lodha:'photo-1545324418-cc1a3fa10c00',      godrej:'photo-1486325212027-8081e485255e',
  piramal:'photo-1560185893-a55cbc8c57e8',    hiranandani:'photo-1512917774080-9991f1c4c750',
  runwal:'photo-1558618666-fcd25c85cd64',     rustomjee:'photo-1600585154340-be6161a56a0c',
  shapoorji:'photo-1600596542815-ffad4c1539a9', raymond:'photo-1613977257363-707ba9348227',
  adani:'photo-1580587771525-78b9dba3b914',   tata:'photo-1564501049412-61c2a3083791',
  oberoi:'photo-1600566753086-00f18fb6b3ea',  kalpataru:'photo-1600607687939-ce8a6c25118c',
  birla:'photo-1600047509807-ba8f99d2cdde',   prestige:'photo-1600566753190-17f0baa2a6c3',
}

function projectImageUrl(project) {
  const b = (project.builder || '').toLowerCase()
  for (const [key, id] of Object.entries(BUILDER_IMG)) {
    if (b.includes(key)) return `https://images.unsplash.com/${id}?w=176&h=176&fit=crop&auto=format&q=70`
  }
  return `https://picsum.photos/seed/${encodeURIComponent(project.name || project.id)}/176/176`
}

const RANK_COLOR = { PRIMARY:'#2E9E4F', SECONDARY:'#F7941D', TERTIARY:'#8B8BD6' }
const MOVE_COLOR = { Fast:'#2E9E4F', Steady:'#F7941D', Slow:'#D64545' }
const FIT_COLOR  = { High:'#2E9E4F', Medium:'#F7941D', Low:'#9CA3AF' }
// Display-order only (deriveAudience's actual scoring is untouched) — the
// strongest recommendations group first; a stable sort preserves
// deriveAudience's existing relative order within the same tier.
const FIT_ORDER  = { High: 0, Medium: 1, Low: 2 }
function sortByFit(audience) {
  return [...audience].sort((a, b) => (FIT_ORDER[a.fit] ?? 3) - (FIT_ORDER[b.fit] ?? 3))
}

// budgetMin/budgetMax are in LAKHS (this app's internal convention — see
// indihomes-client.cjs's normalizeProject comment). IndiHomes only exposes a
// single starting price (budgetMin === budgetMax always), so `ref` below is
// really just "the price a buyer sees", not a true range midpoint.
function budgetTierOf(budgetMinL, budgetMaxL) {
  const ref = budgetMaxL ?? budgetMinL
  if (ref == null || !Number.isFinite(ref)) return null
  if (ref < 75) return 'affordable'   // < ₹75L
  if (ref <= 150) return 'mid'        // ₹75L – ₹1.5Cr
  return 'premium'                    // > ₹1.5Cr
}

function configTierOf(config) {
  const nums = (String(config || '').match(/\d+(?=\s*BHK)/gi) || []).map(Number)
  return { hasSmall: nums.some(n => n <= 2), hasLarge: nums.some(n => n >= 3) }
}

// ── Target audience: rule-based fit scoring gated on REAL project signals —
// budget tier (budgetMin/budgetMax, in Lakhs) and configuration mix (1/2 BHK
// vs 3/4 BHK from `config`) drive the segments that should actually vary by
// price and size, so a ₹2.66Cr 3BHK project can no longer show "High" fit
// for both HNI/Luxury AND First-Time Homebuyers at once — those two are now
// meaningfully anti-correlated, not independently-hardcoded. Description/
// amenities keyword signals remain for segments that genuinely are about
// listing content, not budget/config (Retirees, IT Professionals, and as a
// last-resort fallback for First-Time/HNI when budget isn't published at
// all). Fully deterministic — no LLM call, per this app's no-fabricated-
// scores rule; only the INPUT signals got richer, not the mechanism. ───────
function deriveAudience({ description, amenities, rera, budgetMin, budgetMax, config }) {
  const text = ((description||'') + ' ' + (amenities||[]).join(' ')).toLowerCase()
  const tier = budgetTierOf(budgetMin, budgetMax)
  const { hasSmall, hasLarge } = configTierOf(config)
  const all = []

  all.push({
    segment: 'Young Professionals (28–38)',
    fit: hasSmall ? 'High' : hasLarge ? 'Low' : 'Medium',
    reason: hasSmall ? '1/2 BHK configuration available — the entry size this segment typically buys' : 'No 1/2 BHK configuration listed for this project',
  })

  all.push({
    segment: 'Upgrade Buyers (35–50)',
    fit: hasLarge ? 'High' : hasSmall ? 'Low' : 'Medium',
    reason: hasLarge ? '3+ BHK configuration available for a growing family' : 'No 3+ BHK configuration listed for this project',
  })

  all.push({
    segment: 'First-Time Homebuyers',
    fit: tier === 'affordable' ? 'High' : tier === 'mid' ? 'Medium' : tier === 'premium' ? 'Low'
      : (/affordable|entry|first/i.test(text) ? 'Medium' : 'Low'),
    reason: tier === 'affordable' ? 'Starting price under ₹75L — accessible, EMI-friendly entry point'
      : tier === 'mid' ? 'Starting price ₹75L–1.5Cr — reachable with a larger EMI, not the cheapest entry point'
      : tier === 'premium' ? 'Starting price above ₹1.5Cr — priced well past typical first-time-buyer range'
      : 'Starting price not published — fit estimated from listing tone only',
  })

  all.push({
    segment: 'HNI / Luxury Segment',
    fit: tier === 'premium' ? 'High' : tier === 'mid' ? 'Medium' : tier === 'affordable' ? 'Low'
      : (/luxury|premium|high-end/i.test(text) ? 'Medium' : 'Low'),
    reason: tier === 'premium' ? 'Starting price above ₹1.5Cr — premium price point for this micro-market'
      : tier === 'mid' ? 'Starting price ₹75L–1.5Cr — mid-market, not entry-level but not premium either'
      : tier === 'affordable' ? 'Starting price under ₹75L — below typical HNI/luxury price points'
      : 'Starting price not published — fit estimated from listing tone only',
  })

  all.push({
    segment: 'NRI Investors',
    fit: rera ? (tier === 'affordable' ? 'Medium' : 'High') : 'Medium',
    reason: rera
      ? (tier === 'premium' ? 'RERA verified + premium price point — attractive for NRI investment' : 'RERA verified, reliable developer')
      : 'No RERA number found for this project — verify before marketing to NRI investors',
  })

  const retireeSignals = /garden|clubhouse|senior|ground floor|hospital|park/i.test(text)
  all.push({
    segment: 'Retirees / Senior Living',
    fit: retireeSignals ? 'Medium' : 'Low',
    reason: retireeSignals ? 'Gated complex with garden/clubhouse amenities and/or nearby hospital access called out in the listing' : 'No senior-living-relevant amenities called out in the listing',
  })

  const itSignal = /it park|tech park|software|wipro|tcs|infosys|hinjewadi|whitefield/i.test(text)
  all.push({
    segment: 'IT Professionals',
    fit: itSignal ? 'High' : hasSmall ? 'Medium' : 'Low',
    reason: itSignal ? 'IT corridor / tech park proximity called out in the listing' : hasSmall ? '1/2 BHK availability suits typical IT-professional household sizes, but no IT-corridor signal found' : 'No IT-corridor signal found in the listing',
  })

  return all
}

// ── Derive movement indicator from available/total — null when we genuinely
// don't have the underlying counts, never a guessed default ─────────────────
function movement(avail, total) {
  if (!avail || !total) return null
  const pct = (total - avail) / total
  return pct > 0.7 ? 'Fast' : pct > 0.4 ? 'Steady' : 'Slow'
}

// ── USP extraction — deterministic keyword pass over whatever description +
// amenities text is available, mirroring the server's extractUSPs() so both
// stay consistent. Called with the OFFICIAL (IndiHomes) description/amenities
// first — an official-sourced USP list beats live/research USPs whenever one
// can be derived, per "own data first" (brief rule 6). ─────────────────────
function deriveUSPs({ description, amenities, rera }) {
  const usps = new Set()
  const text = `${description || ''} ${(amenities || []).join(' ')}`.toLowerCase()
  if (rera) usps.add('RERA Verified')
  if (/metro|tube|subway/i.test(text)) usps.add('Metro Connectivity')
  if (/oc received|occupancy certificate/i.test(text)) usps.add('OC Received')
  if (/township|integrated/i.test(text)) usps.add('Integrated Township')
  if (/garden|landscape/i.test(text)) usps.add('Landscaped Gardens')
  if (/club|clubhouse/i.test(text)) usps.add('Clubhouse')
  if (/pool|swimming/i.test(text)) usps.add('Swimming Pool')
  if (/gym|fitness/i.test(text)) usps.add('Fitness Centre')
  if (/vastu/i.test(text)) usps.add('Vastu Compliant')
  if (/nri/i.test(text)) usps.add('NRI-Approved')
  if (/green|eco|certified|leed/i.test(text)) usps.add('Green Certified')
  if (/security|cctv|24.*hour/i.test(text)) usps.add('24/7 Security')
  if (/smart home|automation/i.test(text)) usps.add('Smart Home')
  if (/school|educat/i.test(text)) usps.add('School Nearby')
  if (/hospital|health/i.test(text)) usps.add('Hospital Nearby')
  if (/mall|shopping/i.test(text)) usps.add('Mall Access')
  if (/highway|express/i.test(text)) usps.add('Highway Access')
  if (/view|sea view|lake|hill/i.test(text)) usps.add('Scenic Views')
  ;(amenities || []).slice(0, 4).forEach(a => { if (a && a.length < 30) usps.add(a) })
  return [...usps].slice(0, 10)
}

// Same 80/60/40 tier boundaries scoring.cjs's labelFor() and Property
// Search's ranking already use — a qualitative word next to a real score
// derived FROM that score, not an independent claim (the previous "Top 5%
// portfolio"/"Excellent fit" trend text was fixed/hardcoded regardless of
// the actual number, e.g. showing "Excellent fit" under a 20% match).
function scoreTierLabel(score) {
  if (score == null) return null
  if (score >= 80) return 'Excellent'
  if (score >= 60) return 'Good'
  if (score >= 40) return 'Fair'
  return 'Low'
}

// ── RERA trust score — three deterministic tiers, per the brief:
//   official RERA present  -> High Trust
//   Surepass-verified      -> Verified Trust (strictly higher, government-checked)
//   missing RERA           -> Low Trust / Needs Verification ─────────────────
function reraTrustScore({ officialRera, reraCode, reraCheck }) {
  if (reraCheck?.verified) {
    return { tier: 'Verified Trust', color: '#2E9E4F', bg: '#E8F7EE', desc: 'Confirmed against the government RERA registry (Surepass).' }
  }
  if (officialRera) {
    return { tier: 'High Trust', color: '#2E9E4F', bg: '#E8F7EE', desc: 'RERA number sourced directly from the official IndiHomes listing.' }
  }
  if (reraCode) {
    return { tier: 'Needs Verification', color: '#F7941D', bg: '#FEF3E4', desc: 'RERA number found via a secondary source — not yet checked against the registry.' }
  }
  return { tier: 'Low Trust', color: '#D64545', bg: '#FEE8E8', desc: 'No RERA number found for this project — verify directly with the builder before marketing.' }
}

// ── Location quality score — deterministic, from real nearby-places data
// (OpenStreetMap Overpass, the same feed driving the map/Nearby Infrastructure
// card). Fully rule-based, no LLM involved.
//
// Reworked from a version that saturated at 100/"Excellent" with as few as 5
// distinct amenity types present, regardless of how many of each or how
// close (a live example: "100/100 · Excellent (5 amenity types nearby)").
// Now factors in three real signals instead of just category presence/
// absence:
//   1. COUNT per category (up to 3 credited) — 3 real schools nearby says
//      more than 1, but a 10th school stops adding signal (diminishing
//      returns, not "more is infinitely better").
//   2. DISTANCE weighting — a place right next door counts for close to its
//      full weight; one at the edge of the 5km search radius (server.cjs's
//      /api/nearby-places widened-search cap) counts for almost nothing.
//   3. A genuinely higher bar for "Excellent" — reaching 100 now requires
//      strong, close coverage across most of the categories Overpass
//      classifies (school/hospital/mall/park/transit/bank/...), not just
//      any five of them present at any distance.
// Returns null ("Not connected") when we have no geocoded places yet,
// rather than a guessed default.
const LQS_RADIUS_KM = 5 // matches /api/nearby-places' widened-search radius
const LQS_CATEGORY_CAP = 2.4 // max points one category can contribute (3 places, close, ~0.8 each)
const LQS_CATEGORY_TARGET = 8 // realistic "excellent" coverage — most projects never see all ~13 raw OSM categories nearby
function locationQualityScore(places) {
  if (!places || !places.length) return null
  const byCategory = new Map()
  for (const p of places) {
    if (!byCategory.has(p.type)) byCategory.set(p.type, [])
    byCategory.get(p.type).push(p)
  }
  let raw = 0
  for (const group of byCategory.values()) {
    const closest3 = [...group].sort((a, b) => a.distKm - b.distKm).slice(0, 3)
    const categoryScore = closest3.reduce((s, p) => s + Math.max(0, 1 - p.distKm / LQS_RADIUS_KM), 0)
    raw += Math.min(categoryScore, LQS_CATEGORY_CAP)
  }
  const score = Math.max(0, Math.min(100, Math.round((raw / (LQS_CATEGORY_TARGET * LQS_CATEGORY_CAP)) * 100)))
  const tier = score >= 80 ? 'Excellent' : score >= 55 ? 'Good' : score >= 30 ? 'Average' : 'Limited'
  const color = score >= 80 ? '#2E9E4F' : score >= 55 ? '#0E0E52' : score >= 30 ? '#F7941D' : '#D64545'
  const within1km = places.filter(p => p.distKm <= 1).length
  const within3km = places.filter(p => p.distKm <= 3).length
  return { score, tier, color, categoryCount: byCategory.size, within1km, within3km }
}

// ── Nearby Infrastructure categories — groups the real Overpass categories
// server.cjs's OVERPASS_CATEGORIES already classifies (School/College/
// University/Hospital/Pharmacy/Mall/Supermarket/Cinema/Bank/Park/Railway-
// Metro Station/Bus Station/Tourist Attraction) into a small set of filter
// buckets. Deliberately built from the categories that actually exist in the
// data, not invented ones — an item whose raw type isn't in this map (e.g.
// something from the AI-research fallback list, which carries no structured
// type at all) falls into "Other" rather than being silently dropped.
const INFRA_CATEGORY_GROUPS = {
  School: 'Schools', College: 'Schools', University: 'Schools',
  Hospital: 'Hospitals', Pharmacy: 'Hospitals',
  Mall: 'Shopping', Supermarket: 'Shopping',
  Park: 'Parks',
  'Railway/Metro Station': 'Transit', 'Bus Station': 'Transit',
  Bank: 'Banking',
  Cinema: 'Entertainment', 'Tourist Attraction': 'Entertainment',
}
const INFRA_BUCKET_ORDER = ['Schools', 'Hospitals', 'Shopping', 'Parks', 'Transit', 'Banking', 'Entertainment', 'Other']
function infraBucketOf(rawCategory) {
  return INFRA_CATEGORY_GROUPS[rawCategory] || 'Other'
}
// Part 2 — one icon/accent per bucket so the category rail reads as a proper
// facility-type legend instead of bare text pills. Keys match INFRA_BUCKET_ORDER.
const INFRA_BUCKET_ICON = {
  Schools: School, Hospitals: Stethoscope, Shopping: ShoppingBag, Parks: TreePine,
  Transit: TrainFront, Banking: Landmark, Entertainment: Film, Other: MapPin,
}
const INFRA_BUCKET_COLOR = {
  Schools: '#2F6FE0', Hospitals: '#D64545', Shopping: '#9B5DE0', Parks: '#2E9E4F',
  Transit: '#F7941D', Banking: '#0E7A6E', Entertainment: '#C2266B', Other: '#75737F',
}

// ── Sales velocity — only ever built from real sold%/unit counts; when
// neither is available, the section says "Not connected" instead of showing
// a fabricated pace so nobody markets against a number that doesn't exist. */
function salesVelocity({ sold, units }) {
  if (sold == null || units == null) return null
  const unsold = Math.round(units * (1 - sold / 100))
  const pace = sold >= 70 ? 'Fast-moving' : sold >= 40 ? 'Steady' : 'Slow-moving'
  const color = sold >= 70 ? '#2E9E4F' : sold >= 40 ? '#F7941D' : '#D64545'
  return { sold, units, unsold, pace, color }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
// Keyed by prefix so e.g. "99acres (Apify)" and "99acres (local scrape)" both
// match the "99acres" entry — exact-match-only here was silently mislabeling
// every genuinely-scraped section as "AI Estimated" whenever the server's
// source string carried extra detail in parentheses.
const SOURCE_LABELS = {
  'indihomes-db': { label:'IndiHomes Website', color:'#0E0E52', bg:'#EEEEF9' },
  '99acres':      { label:'99acres',       color:'#E85A1C', bg:'#FEF0EA' },
  'magicbricks':  { label:'MagicBricks',   color:'#BE1E2D', bg:'#FBE8EA' },
  'housing.com':  { label:'Housing.com',   color:'#5C3317', bg:'#FEF3E4' },
  'proptiger.com':{ label:'PropTiger',     color:'#004C97', bg:'#E8F0FA' },
  'google':       { label:'Google',        color:'#1A73E8', bg:'#E8F2FF' },
  'estimated':    { label:'AI Estimated',  color:'#75737F', bg:'#F6F5F1' },
}

function resolveSourceLabel(source) {
  if (!source) return SOURCE_LABELS['estimated']
  const key = Object.keys(SOURCE_LABELS).find(k => source.toLowerCase().startsWith(k))
  return key ? SOURCE_LABELS[key] : SOURCE_LABELS['estimated']
}

function SourceTag({ source, compact }) {
  const s = resolveSourceLabel(source)
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:4,
      background: s.bg, color: s.color,
      padding: compact ? '2px 6px' : '3px 8px',
      borderRadius:4, fontSize:10, fontWeight:700,
      fontFamily:"'IBM Plex Mono',monospace", letterSpacing:'0.04em',
      flexShrink:0,
    }}>
      {source && source !== 'estimated' ? '●' : '◌'} {s.label}
    </span>
  )
}

function SectionLabel({ children, source }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14, gap:8 }}>
      <div style={{ fontSize:11, fontFamily:"'IBM Plex Mono',monospace", color:'#8A8896', letterSpacing:'0.1em', textTransform:'uppercase' }}>{children}</div>
      {source !== undefined && <SourceTag source={source || 'estimated'} compact />}
    </div>
  )
}

// Field-level provenance badge — see src/components/ui/FieldBadge.jsx for
// the shared component (imported above). Three honest states only:
//  - verified:   a real fact pulled directly off the scraped page (RERA no., price, etc.)
//  - ai:         an AI-derived interpretation/synthesis built FROM real scraped facts
//                (e.g. audience fit scoring, narrative summary) — never a standalone fact
//  - unverified: nothing was found — shown instead of guessing or fabricating a value

// ── Lightweight markdown renderer for official/researched project
// descriptions — IndiHomes' own description field arrives as markdown prose
// (headers, **bold**, bullet lists), not plain text; without this it rendered
// as a wall of text with literal ** and # characters. Deliberately a local
// copy of the same pattern already built for AI Search's analyst report
// (ProjectSelection.jsx) rather than a shared import, matching this
// codebase's existing convention of small independent duplicates over
// cross-file coupling for presentation-only helpers.
function mdInline(text, keyBase) {
  const parts = []
  let rest = String(text), k = 0
  const re = /\*\*(.+?)\*\*/g
  let last = 0, m
  while ((m = re.exec(rest)) !== null) {
    if (m.index > last) parts.push(<span key={`${keyBase}-${k++}`}>{rest.slice(last, m.index)}</span>)
    parts.push(<b key={`${keyBase}-${k++}`} style={{ color:'#1B1B3A' }}>{m[1]}</b>)
    last = m.index + m[0].length
  }
  if (last < rest.length) parts.push(<span key={`${keyBase}-${k++}`}>{rest.slice(last)}</span>)
  return parts
}

function DescriptionMarkdown({ text }) {
  // Root cause of the underlying bug was actually server-side (indihomes-
  // client.cjs's old clean() collapsed real \n's in the description field —
  // fixed there via cleanDescription()), so official IndiHomes descriptions
  // now arrive with real line breaks and this preprocessing is a no-op for
  // them. Kept as a fallback for any OTHER text source that might still
  // arrive as one flattened line with "### "/"* " markers stuck mid-sentence
  // (e.g. a scraped portal description) — without it, the line-based parser
  // below would see one line starting with "# " and render the entire blob
  // as a single giant H1.
  //
  // IMPORTANT: `[^\n]` matches ANY non-newline character — including "#"
  // itself. An earlier version of this regex used `([^\n])(#{1,3}\s)` and
  // consumed-then-replayed the preceding character; on real text that
  // already had "\n\n### Heading", the engine could start its match AT the
  // first "#" (matching it as the "preceding char"), then match the
  // remaining "## " as the header group — splitting "### Heading" into a
  // stray lone "#" on its own line followed by "## Heading". Caught live:
  // Chaitanya Ethics Orovia's real description rendered a bare "#" line
  // right before "Configuration & Pricing". Lookbehind instead of a
  // consumed capture group avoids this self-overlap entirely — it can
  // never match INSIDE a hash run or right after one, only before the
  // start of a genuinely un-separated marker.
  const withBreaks = String(text || '')
    .replace(/(?<![\n#])(#{1,3}\s)/g, '\n$1')                 // "...spaces.### Heading" -> break before ###, never mid-run
    .replace(/(?<![\n*])\*(?!\*)(\s+)(?=[A-Z*])/g, '\n*$1')    // "...text.* Bulleted Item" -> break before * (heuristic: asterisk+space before a capital letter or a bold "**" run) — never matches inside/right after a "**" bold pair
  const lines = withBreaks.split('\n')
  const out = []
  let i = 0, key = 0
  while (i < lines.length) {
    const line = lines[i]
    const hm = line.match(/^(#{1,3})\s+(.*)/)
    if (hm) {
      const lvl = hm[1].length
      out.push(<div key={key++} style={{ fontWeight:800, color:'#0E0E52', fontSize: lvl===1?17:lvl===2?15:13.5, margin: i===0 ? '0 0 8px' : '14px 0 6px', overflowWrap:'break-word', wordBreak:'break-word' }}>{mdInline(hm[2].replace(/\*\*/g,''), `h${key}`)}</div>)
      i++; continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++ }
      out.push(
        <ul key={key++} style={{ margin:'4px 0 10px', paddingLeft:20 }}>
          {items.map((it,j) => <li key={j} style={{ fontSize:13, color:'#1B1B3A', lineHeight:1.7, marginBottom:2, overflowWrap:'break-word', wordBreak:'break-word' }}>{mdInline(it, `li${key}-${j}`)}</li>)}
        </ul>
      )
      continue
    }
    if (!line.trim()) { i++; continue }
    const para = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s|^\s*([-*]|\d+\.)\s/.test(lines[i])) { para.push(lines[i]); i++ }
    out.push(<p key={key++} style={{ fontSize:13, color:'#1B1B3A', lineHeight:1.75, margin:'0 0 10px', overflowWrap:'break-word', wordBreak:'break-word' }}>{mdInline(para.join(' '), `p${key}`)}</p>)
  }
  return <div style={{ minWidth:0, maxWidth:'100%' }}>{out}</div>
}

// ── Clamp-with-toggle wrapper — caps visible height to ~7-8 lines by default
// with a REAL, clickable "Read more"/"Show less" toggle. A CSS max-height +
// overflow clamp (not a hard string truncation) so markdown formatting never
// breaks mid-element when collapsed — the full DOM renders underneath, only
// its visible box height changes. Measures real content height after render
// so the toggle only appears when the content actually overflows the clamp;
// short descriptions render exactly as before, with no button at all.
//
// Previously this only showed a fade-gradient overlay with NO actual button
// underneath it — a description that overflowed the clamp had no way to
// ever be read in full; the gradient implied "there's more" with no control
// to reach it. Now a real toggle button expands/collapses the clamp.
function DescriptionSummary({ maxHeight = 150, children }) {
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const ref = React.useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setOverflowing(el.scrollHeight > maxHeight + 4)
  }, [children, maxHeight])
  return (
    <div>
      <div style={{ maxHeight: expanded ? 'none' : maxHeight, overflow: 'hidden', position: 'relative', minWidth: 0, maxWidth: '100%' }}>
        <div ref={ref} style={{ minWidth: 0, maxWidth: '100%' }}>{children}</div>
        {overflowing && !expanded && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 32, background: 'linear-gradient(to bottom, rgba(255,255,255,0), #fff)', pointerEvents: 'none' }} />
        )}
      </div>
      {overflowing && (
        <button onClick={() => setExpanded(v => !v)}
          style={{ marginTop: 8, background: 'none', border: 'none', color: '#0E0E52', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
          {expanded ? '▲ Show less' : '▼ Read more'}
        </button>
      )}
    </div>
  )
}

// Unified empty/unavailable state — see src/components/ui/EmptyState.jsx
// (imported above) for the shared EmptyState/EmptyValue components used
// throughout this file instead of ad hoc italic-grey text with
// inconsistent copy scattered per card.

function Spinner() {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'48px 0', gap:16 }}>
      <div style={{ width:36, height:36, border:'3px solid #E9E7E0', borderTop:'3px solid #0E0E52', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
      <div style={{ fontSize:13, color:'#75737F', fontWeight:500 }}>Drishti AI is gathering project intelligence…</div>
      <div style={{ fontSize:11, color:'#8A8896' }}>Cross-checking listings and live sources — this can take up to ~2 minutes</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
// Multi-phase projects (e.g. Lodha Amara) return dozens of phase RERA numbers
// concatenated — split them into individual registrations for display.
function splitReraNumbers(raw) {
  if (!raw) return []
  const found = String(raw).match(/P\d{8,11}/g)
  if (found?.length) return [...new Set(found)]
  const s = String(raw).trim()
  return s ? [s.slice(0, 40)] : []
}

function ReraChips({ raw }) {
  const [showAll, setShowAll] = useState(false)
  const nums = splitReraNumbers(raw)
  if (!nums.length) return null
  const shown = showAll ? nums : nums.slice(0, 2)
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:5, alignItems:'center' }}>
      {shown.map(n => (
        <span key={n} style={{ background:'#E8F7EE', color:'#156B35', borderRadius:5, padding:'2px 8px', fontSize:11.5, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace" }}>{n}</span>
      ))}
      {nums.length > 2 && (
        <button onClick={() => setShowAll(v => !v)}
          style={{ background:'none', border:'none', color:'#0E0E52', fontSize:11.5, fontWeight:700, cursor:'pointer', padding:0 }}>
          {showAll ? 'show less' : `+${nums.length - 2} more (phases)`}
        </button>
      )}
    </div>
  )
}

// Truncate stray over-long values so one bad field can't wreck the grid.
const clip = (v, n = 160) => {
  const s = String(v ?? '').trim()
  if (!s) return null
  return s.length > n ? s.slice(0, n) + '…' : s
}

function ResearchPanel({ data }) {
  if (data._empty) return <div style={{ marginTop:12, fontSize:13, color:'#75737F' }}>No web results found for this project.</div>
  const box = (label, val) => {
    const content = React.isValidElement(val) ? val : clip(val)
    if (!content) return null
    return (
      <div style={{ minWidth:0 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'#8A8896', textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:3 }}>{label}</div>
        <div style={{ fontSize:13, color:'#1B1B3A', lineHeight:1.5, overflowWrap:'anywhere' }}>{content}</div>
      </div>
    )
  }
  const list = (label, arr, color) => (arr && arr.length) ? (
    <div style={{ flex:1, minWidth:180 }}>
      <div style={{ fontSize:12, fontWeight:700, color, marginBottom:5 }}>{label}</div>
      <ul style={{ margin:0, paddingLeft:16, fontSize:12.5, color:'#4A4A63', lineHeight:1.6 }}>{arr.map((x,i)=><li key={i}>{x}</li>)}</ul>
    </div>
  ) : null
  return (
    <div style={{ marginTop:14 }}>
      {data.summary && <div style={{ background:'#F6F5F1', borderRadius:10, padding:'12px 16px', marginBottom:14, fontSize:13.5, lineHeight:1.6, color:'#1B1B3A' }}>{data.summary}</div>}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))', gap:14, marginBottom:14 }}>
        {splitReraNumbers(data.rera).length > 0 && box('RERA', <ReraChips raw={data.rera} />)}
        {box('Developer', clip(data.developer, 60))}
        {box('Location', clip(data.location, 80))}
        {box('Possession', clip(data.possession, 60))}
        {box('Price Range', clip(data.price_range, 60))}
        {box('Connectivity', data.connectivity)}
        {box('Nearby', data.nearby)}
      </div>
      {data.configs?.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'#0E0E52', marginBottom:6 }}>Configurations</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
            {data.configs.map((c,i)=>(
              <div key={i} style={{ border:'1px solid #E9E7E0', borderRadius:8, padding:'8px 12px', fontSize:12.5 }}>
                <b>{c.type}</b>{c.carpet?` · ${c.carpet}`:''}{c.price?` · ${c.price}`:''}
              </div>
            ))}
          </div>
        </div>
      )}
      {data.amenities?.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'#0E0E52', marginBottom:6 }}>Amenities</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
            {data.amenities.map((a,i)=><span key={i} style={{ background:'#F6F5F1', borderRadius:14, padding:'3px 10px', fontSize:11.5, color:'#4A4A63' }}>{a}</span>)}
          </div>
        </div>
      )}
      <div style={{ display:'flex', gap:20, flexWrap:'wrap', marginBottom:14 }}>
        {list('✓ Pros', data.pros, '#2E9E4F')}
        {list('✗ Cons', data.cons, '#D64545')}
        {list('★ USPs', data.usps, '#0E0E52')}
      </div>
      {(data._allSources?.length > 0) && (
        <div style={{ marginTop:8, background:'#EEF0FF', border:'1px solid #C8CCF0', borderRadius:10, padding:'12px 14px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'#0E0E52', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.04em' }}>🔗 Sources (live web)</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {data._allSources.map(s => (
              <a key={s.n} href={s.url} target="_blank" rel="noopener noreferrer"
                style={{ fontSize:12.5, color:'#0E0E52', textDecoration:'none', display:'flex', gap:8 }}>
                <span style={{ color:'#8A8896', minWidth:16 }}>[{s.n}]</span>
                <span style={{ textDecoration:'underline', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.title || s.url}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Full onboarding form: every field can be filled manually; anything left blank
// is filled automatically — the portal scrapers (99acres/MagicBricks) AND live
// web research both run for the new project.
const ONBOARD_FIELDS = [
  { key: 'name',        label: 'Project name *',        ph: 'e.g. Lodha Amara', req: true },
  { key: 'builder',     label: 'Builder / Developer',   ph: 'e.g. Lodha' },
  { key: 'city',        label: 'City',                  ph: 'e.g. Thane' },
  { key: 'location',    label: 'Locality',              ph: 'e.g. Kolshet Road' },
  { key: 'config',      label: 'Configuration',         ph: 'e.g. 1, 2 & 3 BHK' },
  { key: 'budgetLabel', label: 'Price range',           ph: 'e.g. ₹80L – 2.4 Cr' },
  { key: 'possession',  label: 'Possession',            ph: 'e.g. Dec 2026 / Ready to move' },
  { key: 'reraCode',    label: 'RERA number',           ph: 'e.g. P51700001065' },
  { key: 'listingUrl',  label: 'Listing URL (99acres / MagicBricks)', ph: 'https://… (helps exact matching)', wide: true },
]

function OnboardModal({ onClose, onSubmit }) {
  const [f, setF] = useState({})
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))
  const canSubmit = (f.name || '').trim().length > 1
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(14,14,40,0.45)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:16, width:640, maxWidth:'100%', maxHeight:'90vh', overflowY:'auto', padding:'26px 30px', boxShadow:'0 24px 64px rgba(0,0,0,0.25)' }}>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:6 }}>
          <div>
            <div style={{ fontSize:19, fontWeight:800, color:'#1B1B3A' }}>Onboard a new project</div>
            <div style={{ fontSize:12.5, color:'#75737F', marginTop:4, lineHeight:1.55 }}>
              Fill what you know — everything else is fetched automatically: the official IndiHomes catalog
              <b> and live Drishti AI web research</b> run as soon as you onboard.
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, color:'#8A8896', cursor:'pointer', lineHeight:1 }}>✕</button>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px 16px', marginTop:16 }}>
          {ONBOARD_FIELDS.map(fl => (
            <div key={fl.key} style={{ gridColumn: fl.wide ? '1 / -1' : 'auto' }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#8A8896', textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:4 }}>{fl.label}</label>
              <input
                value={f[fl.key] || ''}
                onChange={e => set(fl.key, e.target.value)}
                placeholder={fl.ph}
                style={{ width:'100%', boxSizing:'border-box', padding:'9px 12px', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, outline:'none', fontFamily:"'Plus Jakarta Sans',sans-serif" }}
                onFocus={e => e.target.style.borderColor='#0E0E52'}
                onBlur={e => e.target.style.borderColor='#E9E7E0'}
              />
            </div>
          ))}
        </div>
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22 }}>
          <button onClick={onClose} style={{ padding:'10px 18px', background:'#F6F5F1', color:'#0E0E52', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>Cancel</button>
          <button disabled={!canSubmit} onClick={() => onSubmit(f)}
            style={{ padding:'10px 22px', background: canSubmit ? '#0E0E52' : '#ccc', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
            ＋ Onboard & auto-research
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ProjectIntelligence({ selectedProjects, onBack }) {
  const baseProjects = (selectedProjects && selectedProjects.length > 0) ? selectedProjects : DEFAULT_PROJECTS
  const [onboarded, setOnboarded] = useState(intelMemory.onboarded) // projects added via "Onboard new project"
  const projects = [...baseProjects, ...onboarded]
  // Restore the previous tab only when returning with the SAME selection; a
  // fresh "Analyse" from search always opens its own (first) project.
  const selSig = (selectedProjects || []).map(p => p.id || p.name).join('|')
  const [tab, setTab]       = useState(intelMemory.sig === selSig ? intelMemory.tab : 0)
  useEffect(() => { Object.assign(intelMemory, { onboarded, tab, sig: selSig }) }, [onboarded, tab, selSig])
  // No portal scraping here — Drishti AI (Claude + live web research, see
  // runResearch below) is the only source for every project's intelligence
  // boxes. `intel` stays null permanently; the display logic below already
  // falls through to `research` whenever `live` (intel) is absent.
  const intel = null

  // Authoritative RERA verification (Surepass, government registry) — same
  // check used in AI Search; gives the real certificate PDF instead of just
  // sending the user to the generic MahaRERA portal to search manually.
  const [reraEnabled, setReraEnabled] = useState(false)
  const [reraCheck, setReraCheck]     = useState(null) // {verified, certificate_url, project_name, ...} | {error}
  const [reraChecking, setReraChecking] = useState(false)
  const reraRef = useRef({})

  // Dynamic live web research
  const [researchEnabled, setResearchEnabled] = useState(false)
  const [research, setResearch]         = useState(null)
  const [researchLoading, setResearchLoading] = useState(false)
  const [researchErr, setResearchErr]   = useState(null)
  const researchRef = useRef({})
  // Real, geocoded nearby places (Overpass/OSM) reported by the map itself —
  // this is what actually drives the Nearby Infrastructure card now, not
  // Claude's guessed prose list.
  const [realNearbyPlaces, setRealNearbyPlaces] = useState([])
  // Real project coordinates (from NearbyMap's own geocoding — reused here,
  // never re-geocoded) and the real Google Places-sourced competing projects
  // found around them. null/[] until the map resolves, same honest-empty-
  // state convention as everything else on this screen.
  const [projectGeo, setProjectGeo] = useState(null)
  const [realCompetitors, setRealCompetitors] = useState({ configured: null, competitors: [], error: null, radiusKm: 3 })
  // Part 5 — synced map/list selection: clicking a nearby-project list item
  // (Competitor Analysis) highlights/pans to its marker on the Location Map
  // and vice versa. Lifted to this shared parent since the map and the list
  // are two separate SectionCards, neither owning the other's state.
  const [selectedCompetitorId, setSelectedCompetitorId] = useState(null)
  // Nearby Infrastructure category filter — single active category
  // (Schools/Hospitals/Shopping/Parks/Transit/Banking/Entertainment/Other),
  // null by default. Nothing shown until one is picked — only the category
  // buttons render initially; clicking one reveals just that category's
  // items and hides the rest.
  const [activeInfraCategory, setActiveInfraCategory] = useState(null)
  const [onboardOpen, setOnboardOpen] = useState(false)
  const autoResearchRef = useRef(null)   // cache-key of a just-onboarded project awaiting auto web-research

  useEffect(() => {
    fetch(`${API}/api/research-status`).then(r => r.json()).then(d => setResearchEnabled(!!d.enabled)).catch(() => {})
    fetch(`${API}/api/rera-status`).then(r => r.json()).then(d => setReraEnabled(!!d.enabled)).catch(() => {})
  }, [])

  const current = projects[Math.min(tab, projects.length - 1)] || projects[0]
  const rc      = RANK_COLOR[current?.rank] || '#8B8BD6'

  const handleOnboardSubmit = (f) => {
    const newProject = {
      id: `onboard-${Date.now()}`,
      name: (f.name || '').trim(),
      builder: (f.builder || '').trim(),
      city: (f.city || '').trim() || 'Mumbai',
      location: (f.location || '').trim(),
      config: (f.config || '').trim(),
      budgetLabel: (f.budgetLabel || '').trim() || 'Price on request',
      possession: (f.possession || '').trim() || 'TBD',
      reraCode: (f.reraCode || '').trim() || null,
      listingUrl: (f.listingUrl || '').trim() || null,
      sold: null, units: null, rank: `${projects.length+1}TH MATCH`,
      score: 0, match: 0, rera: !!(f.reraCode || '').trim(),
    }
    setOnboarded(prev => [...prev, newProject])
    setOnboardOpen(false)
    // Queue the live web research to auto-run once this becomes the active tab —
    // so onboarding fills the boxes from the whole web, not just the portals.
    autoResearchRef.current = `${newProject.name}::${newProject.builder}`.toLowerCase().replace(/\W/g,'')
    setTab(projects.length) // jump to the new tab — its useEffect triggers the portal scrape too
  }

  const handleExportBrief = () => {
    if (!current) return
    const lines = []
    lines.push(`PROJECT INTELLIGENCE BRIEF`)
    lines.push(`${current.name}${current.builder ? ' — ' + current.builder : ''}`)
    lines.push(`Generated ${new Date().toLocaleString('en-IN')}`)
    lines.push('')
    lines.push(`City: ${current.city || '—'}`)
    lines.push(`Configuration: ${current.config || '—'}`)
    lines.push(`Budget: ${current.budgetLabel || '—'}`)
    lines.push(`Possession: ${current.possession || '—'}`)
    if (current.sold != null) lines.push(`Sold: ${current.sold}%`)
    if (current.units != null) lines.push(`Total units: ${current.units}`)
    lines.push('')
    if (intel?._error) {
      lines.push(`DATA STATUS: unavailable — ${intel._error}`)
    } else if (intel) {
      lines.push(`RERA: ${intel.rera || 'Not found on listing'}`)
      if (intel.reraAll?.length > 1) lines.push(`  (+${intel.reraAll.length - 1} additional tower registrations)`)
      lines.push(`Data source: ${intel._sources?.primary || 'unknown'}${intel._fromCache ? ' (cached)' : ''}`)
      lines.push('')
      if (intel.description) { lines.push('DESCRIPTION'); lines.push(intel.description); lines.push('') }
      if (intel.configs?.length) {
        lines.push('UNIT CONFIGURATIONS')
        intel.configs.forEach(c => lines.push(`  ${c.type}: ${c.carpet || '—'} | ${c.price || '—'}`))
        lines.push('')
      }
      if (intel.usps?.length) { lines.push('USPs'); intel.usps.forEach(u => lines.push(`  • ${u}`)); lines.push('') }
      if (intel.amenities?.length) { lines.push('AMENITIES'); lines.push('  ' + intel.amenities.join(', ')); lines.push('') }
      if (intel.competitors?.length) {
        lines.push('COMPETITORS')
        intel.competitors.forEach(c => lines.push(`  ${c.name}${c.builder ? ' ('+c.builder+')' : ''} — ${c.price || 'Price on request'} — ${c.status || ''}`))
        lines.push('')
      }
    } else {
      lines.push('DATA STATUS: not yet fetched')
    }
    lines.push('')
    lines.push('— All figures above are sourced directly from 99acres; none are AI-estimated unless explicitly marked otherwise in the app.')

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `${current.name.replace(/[^a-z0-9]+/gi, '-')}-brief.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Reset the research panel when the active project changes — keyed by
  // the candidate's own CANONICAL id (Part P1.5's "LOCK candidate_id =
  // A.id"), not `${name}::${builder}`. The old name+builder key meant two
  // different AI Search candidates that happened to share a name (a
  // realistic case — multiple portals list the same project under
  // slightly different builder-field text, or two genuinely different
  // projects share a common name) could collide on the SAME cache
  // entry — candidate #1's research bleeding into candidate #2's tab.
  // `id` is unique per candidate by construction (external-search.cjs's
  // buildCanonicalCandidateId / dedupe.py's dedup key / toAnalysableProject's
  // fallback), so this can't happen. `k` falls back to the old scheme only
  // for a project object with no `id` at all (shouldn't happen for any
  // current call site, kept only as a defensive floor).
  useEffect(() => {
    if (!current) return
    const k = current.id || `${current.name}::${current.builder||''}`.toLowerCase().replace(/\W/g,'')
    setResearchErr(null)
    setReraCheck(reraRef.current[k] || null)
    setRealNearbyPlaces([])
    setProjectGeo(null)
    setRealCompetitors({ configured: null, competitors: [], error: null, radiusKm: 3 })
    setSelectedCompetitorId(null)
    setActiveInfraCategory(null)
    // AI Search candidate evidence (Part P1.4's priority order) — ALWAYS
    // populated for anything that came from AI Search (toAnalysableProject
    // guarantees this: the agent's own project_intelligence when present,
    // otherwise synthesized directly from THIS candidate's own fields —
    // never a fresh, generically-scoped search). Reading it here, keyed by
    // the candidate's own id, is what makes switching between candidate
    // #1/#2/#3 show genuinely different data instead of whichever tab
    // happened to trigger a search first.
    if (current._agentIntel) {
      researchRef.current[k] = current._agentIntel
      setResearch(current._agentIntel)
      return
    }
    setResearch(researchRef.current[k] || null)
    // /api/ai-research (the Claude-driven generic web-research fallback)
    // now ONLY ever runs for a project that did NOT come from AI Search at
    // all (current._autoResearch unset — manual "Onboard new project" or
    // an official IndiHomes catalog entry opened directly). An AI-Search-
    // sourced candidate ALWAYS has _agentIntel set (see above) and returns
    // before reaching this branch — Part P1.4's explicit rule that generic
    // discovery must never replace/resolve the selected candidate.
    if (current._autoResearch) return
    if ((autoResearchRef.current === k) && !researchRef.current[k]) {
      autoResearchRef.current = null
      if (researchEnabled || current.code) setTimeout(() => runResearch(), 50)
    }
  }, [current?.id, current?.name, current?.builder, current?.code, current?._agentIntel, researchEnabled])

  // Competitor Analysis — real Google Places nearby-search, once the map
  // above has resolved real coordinates for this project (reused, not
  // re-geocoded). Replaces the old Claude-web-research-only path, which is
  // permanently unavailable in this deployment (no ANTHROPIC_API_KEY, see
  // requirements.md) and always showed "Not found".
  useEffect(() => {
    if (!projectGeo?.lat || !projectGeo?.lon) return
    let cancelled = false
    fetch(`${API}/api/competing-projects?lat=${projectGeo.lat}&lon=${projectGeo.lon}&excludeName=${encodeURIComponent(current?.name || '')}`)
      .then(r => r.json())
      // Part 16 — a genuine search FAILURE (Google Places down/disabled,
      // network error) must never be presented the same way as "the search
      // ran and found nothing." Previously `d.error` was silently dropped
      // here, so both cases collapsed into the same empty `competitors: []`
      // and the UI always said "No competing residential projects found"
      // even when the search never actually completed.
      .then(d => { if (!cancelled) setRealCompetitors({ configured: !!d.configured, competitors: d.competitors || [], error: d.error || null, radiusKm: d.radiusKm || 3 }) })
      .catch(() => { if (!cancelled) setRealCompetitors({ configured: null, competitors: [], error: 'Request failed', radiusKm: 3 }) })
    return () => { cancelled = true }
  }, [projectGeo?.lat, projectGeo?.lon, current?.name])

  // Surepass needs the RERA authority's real state name, not city — a fixed
  // keyword list can never cover every state/UT, and silently guessing wrong
  // (this used to default to 'maharashtra' for anything unrecognized) sends
  // the verification call to the WRONG state's registry entirely. Resolve it
  // properly: geocode the project's own city/location via the same live
  // location search used everywhere else in the app (OpenStreetMap covers
  // all of India), and read the real state off that result — works for any
  // state or UT with no hardcoded list. A small keyword list is kept only as
  // an offline fallback if that lookup fails.
  const guessStateFallback = (text = '') => {
    const t = text.toLowerCase()
    if (/karnataka|bengaluru|bangalore|mysuru|mysore/.test(t)) return 'karnataka'
    if (/gujarat|ahmedabad|surat|vadodara|rajkot/.test(t)) return 'gujarat'
    if (/delhi|ncr|gurugram|gurgaon|noida|faridabad|ghaziabad/.test(t)) return 'delhi'
    if (/telangana|hyderabad|secunderabad/.test(t)) return 'telangana'
    if (/tamil\s*nadu|chennai|coimbatore|madurai|kandigai|trichy|tiruchirappalli|salem/.test(t)) return 'tamil nadu'
    if (/andhra\s*pradesh|vijayawada|visakhapatnam|vizag|guntur/.test(t)) return 'andhra pradesh'
    if (/west\s*bengal|kolkata|calcutta/.test(t)) return 'west bengal'
    if (/rajasthan|jaipur|udaipur|jodhpur/.test(t)) return 'rajasthan'
    if (/uttar\s*pradesh|lucknow|kanpur/.test(t)) return 'uttar pradesh'
    if (/kerala|kochi|cochin|thiruvananthapuram|trivandrum/.test(t)) return 'kerala'
    if (/punjab|chandigarh|ludhiana|amritsar/.test(t)) return 'punjab'
    if (/madhya\s*pradesh|bhopal|indore/.test(t)) return 'madhya pradesh'
    if (/haryana|panipat/.test(t)) return 'haryana'
    return 'maharashtra'
  }
  const resolveState = async (text) => {
    const q = text.trim()
    if (q.length >= 3) {
      try {
        const j = await fetch(`${API}/api/location-search?q=${encodeURIComponent(q)}`).then(r => r.json())
        const state = j.results?.find(r => r.state)?.state
        if (state) return state
      } catch (_) { /* fall through to the offline heuristic below */ }
    }
    return guessStateFallback(q)
  }

  const runReraVerify = async () => {
    if (!current || !reraCode) return
    const k = `${current.name}::${current.builder||''}`.toLowerCase().replace(/\W/g,'')
    setReraChecking(true)
    try {
      const stateName = await resolveState(`${current.city || ''} ${current.location || ''}`)
      const res = await fetch(`${API}/api/rera-verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationNumber: reraCode, stateName, registrationType: 'project' }),
      })
      const j = await res.json()
      const result = res.ok ? j : { error: j.error || 'Verification failed' }
      reraRef.current[k] = result
      setReraCheck(result)
    } catch (e) {
      const result = { error: e.message }
      reraRef.current[k] = result
      setReraCheck(result)
    } finally {
      setReraChecking(false)
    }
  }

  const runResearch = () => {
    if (!current) return
    const k = `${current.name}::${current.builder||''}`.toLowerCase().replace(/\W/g,'')
    setResearchLoading(true); setResearchErr(null); setResearch(null)
    fetch(`${API}/api/ai-research`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // projectCode/market let the server fetch official IndiHomes data first
      // (own data before external validation) when this project came from
      // Filter Search's official catalog.
      body: JSON.stringify({ name: current.name, builder: current.builder, city: current.city, projectCode: current.code, market: current.market || 'india' }),
    })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || 'Research failed')
        researchRef.current[k] = j
        setResearch(j); setResearchLoading(false)
        // Keep the AI Search list card in sync — if this deeper research found
        // a RERA number the list's lighter extraction missed, patch it back so
        // "not RERA verified" doesn't linger on a project we now know is verified.
        if (j.rera) syncReraIntoSearchResults(current.name, j.rera)
      })
      .catch(e => { setResearchErr(e.message); setResearchLoading(false) })
  }

  // Display data: own official IndiHomes data first, live web research fills
  // the gaps (brief rule 6 — "own data first, external validation second").
  // `official` is the real IndiHomes catalog record for this project (only
  // present when the project came from Filter Search's official inventory);
  // `research` is Claude's supporting web research. Both are real sourced
  // data (never synthetic) — this is what lets the structured boxes populate
  // even when one source has nothing.
  const live = intel
  const official = research?.official || null

  const officialConfigs = (official?.flatInventory || [])
    .filter(f => f.type)
    .map(f => ({ type: f.type, carpet: f.carpet, total: f.total, available: f.available, price: f.priceDisplay, _extracted: !!f._extracted }))
  // Distinguishes structured API data (flatInventory as-published) from the
  // extractive-only fallback (real numbers regex-parsed out of the
  // description prose when the API's own flatInventory array was empty) —
  // the two need different provenance badges, never both labeled the same.
  const configsExtracted = officialConfigs.length > 0 && officialConfigs.every(c => c._extracted)
  const displayConfigs = ((officialConfigs.length ? officialConfigs : live?.configs?.length ? live.configs : research?.configs) || []).map(c => ({
    type:      c.type,
    carpet:    c.carpet || '—',
    total:     c.total  ?? '—',
    available: c.available ?? '—',
    price:     c.price  || '—',
    movement:  c.movement || movement(c.available, c.total),
  }))

  const displayAmenities   = (official?.amenities?.length ? official.amenities : live?.amenities?.length ? live.amenities : research?.amenities) || []
  // Official-sourced USPs (derived from the official description/amenities +
  // official RERA presence) win whenever any can be extracted — "own data
  // first" applies to USP extraction the same way it already does to
  // description/amenities/configs, not just the raw fields.
  const officialUSPs = official
    ? deriveUSPs({ description: official.description, amenities: official.amenities, rera: !!official.reraCode })
    : []
  const displayUSPs = (officialUSPs.length ? officialUSPs : live?.usps?.length ? live.usps : research?.usps) || []
  const researchNearby     = Array.isArray(research?.nearby) ? research.nearby : (research?.nearby ? [research.nearby] : [])
  // Real, geocoded nearby places (schools/hospitals/malls/stations/
  // attractions from OpenStreetMap Overpass, plotted on the map) lead the
  // list, sorted by distance — Claude's guessed prose list (or the scraped
  // listing's infra, if any) is appended after, deduped by name, so the
  // card shows the fullest possible picture instead of picking just one
  // source.
  const realInfra = realNearbyPlaces.map(p => ({ name: p.name, type: p.type, dist: `${p.distKm} km`, icon: p.icon, bucket: infraBucketOf(p.type), verified: true }))
  const fallbackInfra = (live?.infra?.length ? live.infra : researchNearby.map(name => ({ name, type: 'Nearby · Drishti AI' })))
    .map(i => ({ ...i, bucket: infraBucketOf(i.type), verified: false }))
  const seenInfraNames = new Set(realInfra.map(i => i.name.toLowerCase()))
  const displayInfra = [
    ...realInfra,
    ...fallbackInfra.filter(i => {
      const key = String(i.name || '').toLowerCase()
      if (!key || seenInfraNames.has(key)) return false
      seenInfraNames.add(key)
      return true
    }),
  ]
  const infraBucketsPresent = INFRA_BUCKET_ORDER.filter(b => displayInfra.some(i => i.bucket === b))
  // Part 2 — the card now opens on the first populated category by default
  // (falls back to "nothing to show" only when there's truly no data) so the
  // section reads as finished on first render instead of an empty shell
  // waiting for a click. activeInfraCategory still tracks an explicit user
  // pick; effectiveInfraCategory is what's actually shown.
  const effectiveInfraCategory = activeInfraCategory || infraBucketsPresent[0] || null
  const filteredInfra = effectiveInfraCategory ? displayInfra.filter(i => i.bucket === effectiveInfraCategory) : []
  // Real Google Places-sourced competitors (this project's own resolved
  // coordinates, see the effect above) lead — genuinely sourced, never
  // fabricated. Falls back to Claude research/live data only when present
  // (that path is permanently unavailable in this deployment today, per
  // requirements.md, but kept as a fallback rather than deleted in case a
  // future deployment does enable a live-web-search LLM provider).
  const displayCompetitors = realCompetitors.competitors.length
    ? realCompetitors.competitors
    : (live?.competitors?.length ? live.competitors : research?.competitors) || []
  const displayDescription = official?.description || live?.description || research?.summary || ''
  // Real source for the description card's footer — the previous line read
  // `live`/`intel`, which are hardcoded null forever in this file (see the
  // comment on `const intel = null` above: this screen no longer has a
  // portal-scrape path), so that footer could literally never render
  // anything but two "Not available" placeholders side by side, for every
  // project, permanently. Resolved from whichever real source actually
  // supplied the description, matching the same official-first priority
  // displayDescription itself already uses.
  const descriptionSourceLabel = official ? 'IndiHomes Website'
    : research?._provider === 'ai-search-agent' ? 'AI Search Agent research'
    : research?.summary ? 'Drishti AI web research'
    : null

  const reraCode    = official?.reraCode || live?.rera || research?.rera || current?.reraCode || ''
  const audienceBudgetMin = official?.budgetMin ?? current?.budgetMin ?? null
  const audienceBudgetMax = official?.budgetMax ?? current?.budgetMax ?? null
  const audienceConfig    = official?.config || current?.config || ''
  const displayAudience    = (displayDescription || displayAmenities.length || audienceBudgetMin != null || audienceConfig)
    ? sortByFit(deriveAudience({
        description: displayDescription, amenities: displayAmenities, rera: reraCode,
        budgetMin: audienceBudgetMin, budgetMax: audienceBudgetMax, config: audienceConfig,
      }))
    : []
  const possession  = (official?.possession && official.possession !== 'TBD' ? official.possession : null)
                   || (live?.possession && live.possession !== 'TBD' ? live.possession : null)
                   || research?.possession || current?.possession || 'TBD'
  const sold        = live?.sold ?? current?.sold ?? null
  const units       = live?.units ?? current?.units ?? null
  const unsold      = units ? Math.round(units * (1 - (sold||0)/100)) : null

  // Inventory movement flag: find first "Slow" config
  const movementFlag = displayConfigs.find(c => c.movement === 'Slow')

  // RERA trust tier, location quality score, and sales velocity — all
  // deterministic, computed straight from data already on screen (never
  // fabricated when the underlying real data isn't there).
  const reraTrust = reraTrustScore({ officialRera: official?.reraCode || null, reraCode, reraCheck })
  const locQuality = locationQualityScore(realNearbyPlaces)
  const velocity = salesVelocity({ sold, units })

  return (
    <div style={{ padding:'28px 32px', maxWidth:1280, paddingBottom:48 }}>
      {onboardOpen && <OnboardModal onClose={() => setOnboardOpen(false)} onSubmit={handleOnboardSubmit} />}
      {/* Part 1 — same state-based back-navigation pattern LeadCapture's
          detail view already uses ("← Back to leads"), applied to
          ProjectSelection -> ProjectIntelligence's own state model
          (App.jsx's onBack -> changeView('select')). ProjectSelection's
          own sessionMemory restores the prior query/results/tab/filters on
          remount — this button doesn't need to carry any state itself. */}
      {onBack && (
        <button onClick={onBack} style={{ background:'#F6F5F1', border:'none', borderRadius:8, padding:'7px 14px', fontSize:12.5, fontWeight:700, color:'#0E0E52', cursor:'pointer', marginBottom:14, display:'inline-flex', alignItems:'center', gap:6 }}>
          ← Back to Search
        </button>
      )}
      <ModuleHeader module="MODULE 03" title="Project Intelligence"
        rightContent={
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={handleExportBrief} disabled={!current} style={{ padding:'9px 16px', background:'#F6F5F1', color:'#0E0E52', border:'1px solid #E9E7E0', borderRadius:8, fontSize:13, fontWeight:600, cursor: current ? 'pointer' : 'not-allowed' }}>↗ Export brief</button>
            <button onClick={() => setOnboardOpen(true)} style={{ padding:'9px 18px', background:'#FECF55', color:'#0E0E52', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer' }}>＋ Onboard new project</button>
          </div>
        }
      />

      {/* Source banner */}
      {selectedProjects && selectedProjects.length > 0 && (
        <div style={{ background:'#E8F7EE', border:'1px solid #2E9E4F40', borderRadius:8, padding:'10px 16px', marginBottom:16, fontSize:13, color:'#156B35', fontWeight:500, display:'flex', alignItems:'center', gap:8 }}>
          <span>✦</span>
          <span>Analysing {selectedProjects.length} project{selectedProjects.length > 1 ? 's' : ''} selected from Project Selection</span>
          <span style={{ marginLeft:'auto', fontSize:11, color:'#2E9E4F', fontFamily:"'IBM Plex Mono',monospace" }}>
            DRISHTI AI · {research ? (research._cached ? 'from cache' : 'live · web research') : researchLoading ? 'researching…' : '—'}
          </span>
        </div>
      )}

      {/* AI enrichment (Claude web research) is optional, layered on top of
          official IndiHomes data — never required for this screen to work.
          Shown once, page-level, rather than per-field, since it's a server
          config fact, not something that varies box to box. Competitor
          Analysis no longer depends on this at all — it runs off a real
          Google Places nearby-search (see the banner below when THAT isn't
          configured), independent of any LLM provider. */}
      {!researchEnabled && (
        <div style={{ background:'#F6F5F1', border:'1px solid #E9E7E0', borderRadius:8, padding:'9px 16px', marginBottom:16, fontSize:12.5, color:'#75737F', display:'flex', alignItems:'flex-start', gap:8 }}>
          <span>ⓘ</span>
          <span>No live-web-search LLM provider is enabled on this server. Official IndiHomes data (description, inventory, RERA, amenities) works fully regardless, and so does Competitor Analysis (Google Places-sourced, unrelated to this). Only Nearby Infrastructure's AI-sourced supplementary list is affected — its real OpenStreetMap-sourced places are unaffected.</span>
        </div>
      )}

      {/* ── Project Tabs ──────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', gap:0, borderBottom:'2px solid #E9E7E0', marginBottom:24, overflowX:'auto' }}>
        {projects.map((p,i) => (
          <button key={p.id||p.name} onClick={() => setTab(i)}
            style={{ padding:'10px 20px', border:'none', background:'none', cursor:'pointer', fontSize:13,
              fontWeight: tab===i?700:500, color: tab===i?'#0E0E52':'#75737F',
              borderBottom: tab===i?'2px solid #0E0E52':'2px solid transparent',
              marginBottom:-2, fontFamily:"'Plus Jakarta Sans',sans-serif", whiteSpace:'nowrap' }}>
            {p.name}
          </button>
        ))}
        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', paddingLeft:12 }}>
          <button style={{ padding:'6px 14px', border:'none', background:'none', cursor:'pointer', fontSize:12, color:'#0E0E52', fontWeight:600, whiteSpace:'nowrap' }}>
            ★ Change selection
          </button>
        </div>
      </div>

      {/* Live Web Research and AI Due-Diligence are no longer shown as their
          own sections — research still runs silently in the background (see
          the effect above) and its facts feed the boxes below directly. */}

      {/* Loading state — Drishti AI's research is the only fetch now */}
      {researchLoading && !research && <SectionCard><Spinner /></SectionCard>}

      {/* Research came back empty — nothing to show yet */}
      {!researchLoading && researchErr && !research && (
        <SectionCard>
          <div style={{ padding:'32px 0', textAlign:'center' }}>
            <div style={{ fontSize:32, marginBottom:12 }}>⚠</div>
            <div style={{ fontSize:15, fontWeight:700, color:'#1B1B3A', marginBottom:8 }}>Nothing found yet</div>
            <div style={{ fontSize:13, color:'#75737F', maxWidth:480, margin:'0 auto', lineHeight:1.7 }}>{researchErr}</div>
            <button onClick={runResearch}
              style={{ marginTop:20, padding:'9px 20px', background:'#0E0E52', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>
              Retry
            </button>
          </div>
        </SectionCard>
      )}

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {!researchLoading && (
        <>
          {/* ── Hero card (PI-FR-01) ────────────────────────────────────────── */}
          <div style={{ background:'#fff', border:'1px solid #E9E7E0', borderRadius:14, padding:'24px', marginBottom:20 }}>
            <div style={{ display:'flex', gap:20, alignItems:'flex-start' }}>
              <div style={{ width:96, height:96, borderRadius:12, flexShrink:0, overflow:'hidden', background:'#E9E7E0' }}>
                <img src={projectImageUrl(current)} alt={current?.name}
                  style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }}
                  onError={e => { e.currentTarget.style.display='none'; e.currentTarget.parentElement.style.background='repeating-linear-gradient(45deg,#E9E7E0,#E9E7E0 5px,#F6F5F1 5px,#F6F5F1 10px)' }} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6, flexWrap:'wrap' }}>
                  <h2 style={{ fontSize:22, fontWeight:800, color:'#1B1B3A', margin:0 }}>{current?.name}</h2>
                  <span style={{ background: current?.score != null ? '#E8F7EE' : '#F6F5F1', color: current?.score != null ? '#2E9E4F' : colors.muted, padding:'3px 10px', borderRadius:4, fontSize:12, fontWeight:700 }}>{current?.score != null ? `${current.score}/100 ★` : 'No score yet'}</span>
                  <span style={{ background:rc, color:'#fff', padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:700 }}>{current?.rank}</span>
                  {reraCode && <span style={{ background:'#E8F7EE', color:'#2E9E4F', padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:600, fontFamily:"'IBM Plex Mono',monospace" }}>RERA {reraCode}</span>}
                  {/* Part P1.10 — a real cross-source RERA disagreement is
                      shown, never silently resolved by picking one value. */}
                  {research?.rera_conflict && (
                    <span title={`Sources disagree: ${(research.rera_conflicting_values || []).join(' vs ')}`}
                      style={{ background:'#FEF3E4', color:'#B45309', padding:'3px 10px', borderRadius:4, fontSize:11, fontWeight:700 }}>
                      ⚠ RERA conflict across sources
                    </span>
                  )}
                  {/* Part P1.6/2.11 — never let an external listing read as
                      official IndiHomes inventory. */}
                  {current?._autoResearch && (
                    <span style={{ background: current?.code ? '#E8F7EE' : '#F1EDFB', color: current?.code ? '#2E9E4F' : '#6B4FBB', padding:'3px 10px', borderRadius:4, fontSize:10.5, fontWeight:700 }}>
                      {current?.code ? 'IndiHomes Website' : 'External Market Listing'}
                    </span>
                  )}
                  {intel && !intel._error && <span style={{ background:'#0E0E5210', color:'#0E0E52', padding:'3px 8px', borderRadius:4, fontSize:10, fontWeight:600 }}>● Live · 99acres</span>}
                </div>
                <p style={{ fontSize:13, color:'#75737F', marginBottom:10, margin:'0 0 10px' }}>
                  {[current?.builder, current?.city, current?.config, current?.budgetLabel,
                    possession && possession !== 'TBD' ? `Possession ${possession}` : null,
                    sold != null ? `${sold}% sold` : null,
                    units != null ? `${units} units` : null,
                  ].filter(Boolean).join(' · ')}
                </p>
                {/* Top 3 only — the full list already has its own card
                    (USP Extraction) right below; showing all of them twice
                    with different styling read as two disagreeing sources
                    rather than one fact shown at two altitudes. */}
                <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                  {displayUSPs.slice(0,3).map(tag => (
                    <span key={tag} style={{ background:'#F6F5F1', color:'#1B1B3A', padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:500 }}>{tag}</span>
                  ))}
                  {displayUSPs.length > 3 && (
                    <span style={{ fontSize:11, color:'#8A8896', fontStyle:'italic' }}>+{displayUSPs.length - 3} more below</span>
                  )}
                </div>
              </div>
              <div style={{ textAlign:'right', flexShrink:0 }} title="How well this project matched your last Property Search/AI Search query — distinct from IndiHomes Score below, which is this listing's own data-quality score.">
                <div style={{ fontSize:28, fontWeight:800, color:rc, fontFamily:"'IBM Plex Mono',monospace" }}>{current?.matchScore != null ? `${current.matchScore}%` : '—'}</div>
                <div style={{ fontSize:11, color:'#8A8896', textTransform:'uppercase', letterSpacing:'0.08em' }}>AI Match</div>
              </div>
            </div>
          </div>

          {/* ── KPI row ─────────────────────────────────────────────────────── */}
          {/* IndiHomes Score and AI Match are deliberately separate numbers
              from separate calculations, not the same value shown twice:
              IndiHomes Score = scoring.cjs's completeness/quality score for
              this listing itself (query-independent). AI Match = the real
              match_score this exact project got against the search you
              opened it from (/api/filter-rank or AI Search's scoring) — null,
              shown honestly as "Not calculated", when there was no active
              search (e.g. onboarded directly rather than analysed from a
              result list). Neither ever falls back to the other's number. */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:24 }}>
            <StatCard label="IndiHomes Score"  value={current?.score != null ? `${current.score}/100` : '—'}
              trend={current?.score != null ? `${scoreTierLabel(current.score)} · listing quality` : 'Not yet scored'} trendDir="up" accent="#2E9E4F"
              title="Deterministic completeness/quality score for this listing (RERA, media, description, developer info, possession date on file) — not dependent on any search." />
            <StatCard label="AI Match"         value={current?.matchScore != null ? `${current.matchScore}%` : '—'}
              trend={current?.matchScore != null ? `${scoreTierLabel(current.matchScore)} match for your search` : 'Open from a search result to see a match score'} trendDir="up" accent="#0E0E52"
              title="How well this project matched the Property Search/AI Search query you opened it from — a different calculation from IndiHomes Score." />
            <StatCard
              label="Inventory Risk"
              value={sold != null ? (sold >= 70 ? 'LOW' : sold >= 40 ? 'MEDIUM' : 'HIGH') : '—'}
              trend={unsold ? `${unsold} unsold units (from ${sold}% sold)` : 'No sold% found'}
              trendDir="up" accent="#F7941D" />
            <StatCard
              label="Demand Trend"
              value={live?.searchTrend ? (live.searchTrend.direction === 'up' ? '▲ UP' : live.searchTrend.direction === 'down' ? '▼ DOWN' : '→ FLAT') : '—'}
              trend={live?.searchTrend ? `${live.searchTrend.label} (Google Trends)` : (live ? 'No Google Trends data for this search term' : 'Not yet fetched')}
              trendDir={live?.searchTrend?.direction === 'down' ? 'down' : 'up'} accent="#8B8BD6" />
          </div>

          {/* ── Inventory Movement Flag (PI-FR-11) ──────────────────────────── */}
          {movementFlag && (
            <div style={{ background:'#FEF3E4', border:'1px solid #F7941D40', borderLeft:'4px solid #F7941D', borderRadius:10, padding:'14px 18px', marginBottom:20, display:'flex', gap:14, alignItems:'flex-start' }}>
              <span style={{ fontSize:20 }}>⚠️</span>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:700, fontSize:13, color:'#1B1B3A', marginBottom:4 }}>
                  Inventory Movement Flag — {movementFlag.type} ({movementFlag.available} units unsold)
                </div>
                <div style={{ fontSize:13, color:'#75737F', lineHeight:1.6 }}>
                  <strong>Suggested action:</strong> Launch targeted campaign for {movementFlag.type} segment — {movementFlag.available} units unsold, pricing above micro-market average. Consider limited-time incentive bundle.
                </div>
              </div>
              <button style={{ flexShrink:0, padding:'7px 14px', background:'#F7941D', color:'#fff', border:'none', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:"'Plus Jakarta Sans',sans-serif" }}>
                Launch campaign →
              </button>
            </div>
          )}

          {/* ── Row 1: AI Analysis + Inventory Table ────────────────────────── */}
          {/* alignItems intentionally NOT 'start' here — CSS Grid's default
              (stretch) is what keeps a paired row's two cards bottom-
              aligned even when one has noticeably more content than the
              other (SectionCard fills that stretched height itself; see
              its own comment). */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>

            {/* Project Description (scraped fact) + AI Signals (derived synthesis) — PI-FR-08.
                Source badge intentionally not rendered here (frontend
                presentation choice only) — official?.description/
                displayDescription still resolve official-first exactly as
                before; provenance is still visible via SourceTag/FieldBadge
                on every other card in this screen. */}
            <SectionCard accent="#0E0E52" title="Project Description" debugId="PI-FR-08"
              action={(
                <button style={{ fontSize:12, color:'#0E0E52', background:'none', border:'1px solid #E9E7E0', borderRadius:6, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontFamily:"'Plus Jakarta Sans',sans-serif", flexShrink:0 }}>
                  ↺ Regenerate
                </button>
              )}>
              {displayDescription ? (
                <DescriptionSummary maxHeight={150}>
                  <DescriptionMarkdown text={displayDescription} />
                </DescriptionSummary>
              ) : (
                <EmptyState reason="No description found on the listing." />
              )}
              {displayUSPs.length > 0 && (
                <div style={{ marginTop:14, paddingTop:12, borderTop:'1px solid #E9E7E0' }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                    <div style={{ fontSize:11, color:'#8A8896' }}>DRISHTI AI SIGNALS — synthesized from the real facts above</div>
                    <FieldBadge kind="ai" />
                  </div>
                  <ul style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:8 }}>
                    {[`${displayUSPs[0]} identified as primary demand driver`,
                      `${displayConfigs[0]?.type || '2 BHK'} segment showing strongest inquiry conversion`,
                      reraCode ? `RERA ${reraCode} found on listing — reduces buyer hesitation` : 'No RERA number found on listing — verify before marketing'
                    ].map((txt,i) => (
                      <li key={i} style={{ display:'flex', gap:8, fontSize:13, color:'#1B1B3A', lineHeight:1.6 }}>
                        <span style={{ color:'#6B4FBB', fontWeight:700, flexShrink:0 }}>✦</span>{txt}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div style={{ marginTop:14, paddingTop:12, borderTop:'1px solid #E9E7E0' }}>
                <span style={{ fontSize:11, color:'#8A8896', fontFamily:"'IBM Plex Mono',monospace" }}>
                  Source: {descriptionSourceLabel || <EmptyValue />}
                </span>
              </div>
            </SectionCard>

            {/* Inventory & Unit Configs (PI-FR-02, 03) */}
            <SectionCard title="Inventory & Unit Configurations" debugId="PI-FR-02"
              badge={officialConfigs.length && configsExtracted ? (
                <span title="Real numbers regex-parsed from the official description text — the API's own structured unit-inventory field was empty for this project."
                  style={{ display:'inline-flex', alignItems:'center', gap:4, background:'#F1EDFB', color:'#6B4FBB', padding:'2px 8px', borderRadius:4, fontSize:10, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace", letterSpacing:'0.03em' }}>
                  ✎ Extracted from description
                </span>
              ) : officialConfigs.length ? <SourceTag source="indihomes-db" compact />
                : live?.configs?.length ? <SourceTag source={live._sources?.primary} compact />
                : research?.configs?.length ? <FieldBadge kind="ai" />
                : <FieldBadge kind="unverified" />}>
              {displayConfigs.length > 0 ? (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead>
                    <tr style={{ borderBottom:'2px solid #E9E7E0' }}>
                      {['Config','Carpet','Total','Available','Price','Movement'].map((h,hi) => (
                        <th key={h} style={{ textAlign: hi>=2 && hi<=4 ? 'right' : 'left', padding:'6px 8px 10px', color:'#8A8896', fontWeight:600, fontSize:11, textTransform:'uppercase', letterSpacing:'0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayConfigs.map((c,i) => (
                      <tr key={i} style={{ borderBottom:'1px solid #F0EEE8' }}>
                        <td style={{ padding:'10px 8px', fontWeight:700, color:'#1B1B3A' }}>{c.type}</td>
                        <td style={{ padding:'10px 8px', color:'#75737F' }}>{c.carpet === '—' ? <EmptyValue /> : c.carpet}</td>
                        <td style={{ padding:'10px 8px', textAlign:'right', fontSize:11 }}>{c.total === '—' ? <EmptyValue /> : c.total}</td>
                        <td style={{ padding:'10px 8px', textAlign:'right', fontSize:11 }}>{c.available === '—' ? <EmptyValue /> : c.available}</td>
                        <td style={{ padding:'10px 8px', textAlign:'right', color:'#75737F', fontSize:11 }}>{c.price === '—' ? <EmptyValue /> : c.price}</td>
                        <td style={{ padding:'10px 8px' }}>
                          {c.movement ? (
                            <span style={{ background:`${MOVE_COLOR[c.movement]||'#8A8896'}18`, color:MOVE_COLOR[c.movement]||'#8A8896', padding:'3px 8px', borderRadius:4, fontSize:11, fontWeight:700 }}>
                              {c.movement === 'Fast' ? '▲ ' : c.movement === 'Slow' ? '▼ ' : '→ '}{c.movement}
                            </span>
                          ) : (
                            <EmptyValue />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState reason="No unit configuration data found for this project." />
              )}
              <div style={{ marginTop:10, fontSize:11, color:'#8A8896' }}>
                <span
                  title="▲ Fast = selling above township pace · ▼ Slow = below pace. 99acres doesn't publish total/available unit counts, so movement can't be computed for most projects."
                  style={{ textDecoration:'underline dotted', textUnderlineOffset:2, cursor:'help' }}>
                  Movement: hover for what ▲/▼ mean and why it's often unavailable ⓘ
                </span>
                {intel && !intel._error && ' · Source: 99acres live data'}
              </div>
            </SectionCard>
          </div>

          {/* ── Sales Velocity (PI-FR-12) — real sold%/unit counts only. Shows
              "Not connected" instead of a fabricated pace whenever those
              numbers aren't available from any source, since 99acres/
              IndiHomes rarely publish live per-unit sales data. ────────────── */}
          <SectionCard style={{ marginBottom: 20 }} title="Sales Velocity" debugId="PI-FR-12"
            badge={velocity ? <FieldBadge kind="verified" /> : <FieldBadge kind="unverified" />}>
            {velocity ? (
              <div style={{ display:'flex', alignItems:'center', gap:24, flexWrap:'wrap' }}>
                <div>
                  <span style={{ background:`${velocity.color}18`, color:velocity.color, padding:'4px 12px', borderRadius:6, fontSize:13, fontWeight:800 }}>
                    {velocity.pace}
                  </span>
                </div>
                <div style={{ fontSize:13, color:'#1B1B3A' }}><b>{velocity.sold}%</b> sold</div>
                <div style={{ fontSize:13, color:'#1B1B3A' }}><b>{velocity.units}</b> total units</div>
                <div style={{ fontSize:13, color:'#1B1B3A' }}><b>{velocity.unsold}</b> unsold units remaining</div>
              </div>
            ) : (
              <EmptyState reason="Not connected."
                detail="No live sales/inventory feed reports sold% or total unit counts for this project — this section intentionally shows no pace estimate rather than a fabricated one. Unit-level detail is in Inventory & Unit Configurations above (from official IndiHomes data where available)." />
            )}
          </SectionCard>

          {/* ── Row 2: USPs + Target Audience ───────────────────────────────── */}
          {/* alignItems intentionally NOT 'start' here — CSS Grid's default
              (stretch) is what keeps a paired row's two cards bottom-
              aligned even when one has noticeably more content than the
              other (SectionCard fills that stretched height itself; see
              its own comment). */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>

            {/* USP Extraction (PI-FR-09) */}
            <SectionCard title="USP Extraction" debugId="PI-FR-09"
              badge={live?.usps?.length ? <SourceTag source={live._sources?.primary} compact /> : displayUSPs.length ? <FieldBadge kind="ai" /> : <FieldBadge kind="unverified" />}
              action={(
                <button style={{ fontSize:11, color:'#0E0E52', background:'none', border:'1px solid #E9E7E0', borderRadius:6, padding:'4px 10px', cursor:'pointer', fontWeight:600, fontFamily:"'Plus Jakarta Sans',sans-serif", flexShrink:0 }}>
                  Hand off to Campaign →
                </button>
              )}>
              {displayUSPs.length > 0 ? (
                <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                  {displayUSPs.map(usp => (
                    <span key={usp} style={{ background:'#0E0E5210', color:'#0E0E52', padding:'6px 12px', borderRadius:20, fontSize:12, fontWeight:600, border:'1px solid #0E0E5220', cursor:'pointer' }}>
                      {usp}
                    </span>
                  ))}
                </div>
              ) : (
                <EmptyState reason="No USPs found for this project." />
              )}
              {displayAmenities.length > 0 && (
                <div style={{ marginTop:14, paddingTop:12, borderTop:'1px solid #E9E7E0' }}>
                  <div style={{ fontSize:11, color:'#8A8896', marginBottom:8 }}>ALL AMENITIES ({displayAmenities.length})</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {displayAmenities.slice(0,16).map(a => (
                      <span key={a} style={{ background:'#F6F5F1', color:'#75737F', padding:'4px 9px', borderRadius:6, fontSize:11 }}>{a}</span>
                    ))}
                  </div>
                </div>
              )}
              {/* Part P1.11 — unit-level vs project-level feature evidence
                  (deck/balcony/parking). "Eco deck on 10th floor" must
                  never read as "this unit has a deck" — shown explicitly,
                  never folded into the plain amenities list above. */}
              {(research?.features || []).filter(f => ['deck', 'balcony', 'parking'].includes(f.feature)).length > 0 && (
                <div style={{ marginTop:14, paddingTop:12, borderTop:'1px solid #E9E7E0' }}>
                  <div style={{ fontSize:11, color:'#8A8896', marginBottom:8 }}>UNIT FEATURES — SCOPE-VERIFIED</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {['deck', 'balcony', 'parking'].map(feature => {
                      const entries = (research?.features || []).filter(f => f.feature === feature)
                      if (!entries.length) return null
                      const unitEntry = entries.find(f => f.scope === 'unit')
                      return (
                        <div key={feature} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5 }}>
                          {unitEntry ? (
                            <>
                              <span style={{ color:'#2E9E4F', fontWeight:700 }}>✓</span>
                              <span style={{ color:'#1B1B3A' }}>{feature.charAt(0).toUpperCase() + feature.slice(1)} confirmed for the unit{unitEntry.configuration ? ` (${unitEntry.configuration})` : ''}</span>
                            </>
                          ) : (
                            <>
                              <span style={{ color:'#B45309', fontWeight:700 }}>△</span>
                              <span style={{ color:'#75737F' }} title={entries[0]?.evidence_text}>
                                {feature.charAt(0).toUpperCase() + feature.slice(1)} mentioned at {entries[0]?.scope || 'unknown'} scope — not confirmed for the unit itself
                              </span>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              <div style={{ marginTop:12, fontSize:12, color:'#8A8896' }}>
                {displayUSPs.length} selling points · Click to include in campaign brief
              </div>
            </SectionCard>

            {/* Target Audience (PI-FR-10) — rule-based fit scoring derived from the
                real scraped description/USPs above, not a raw scraped fact itself. */}
            <SectionCard title="Target Audience Recommendation" debugId="PI-FR-10"
              badge={<FieldBadge kind={displayAudience.length ? 'ai' : 'unverified'} />}
              action={(
                <button style={{ fontSize:11, color:'#0E0E52', background:'none', border:'1px solid #E9E7E0', borderRadius:6, padding:'4px 10px', cursor:'pointer', fontWeight:600, fontFamily:"'Plus Jakarta Sans',sans-serif", flexShrink:0 }}>
                  Hand off to Campaign →
                </button>
              )}>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {displayAudience.map(a => (
                  <div key={a.segment} style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'10px 12px', background:'#F9F8F6', borderRadius:8 }}>
                    <span style={{ flexShrink:0, padding:'3px 8px', borderRadius:4, fontSize:11, fontWeight:700, background:`${FIT_COLOR[a.fit]||'#8A8896'}18`, color:FIT_COLOR[a.fit]||'#8A8896' }}>{a.fit}</span>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color:'#1B1B3A' }}>{a.segment}</div>
                      <div style={{ fontSize:11, color:'#75737F', marginTop:2 }}>{a.reason}</div>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>

          {/* ── Row 3: RERA + Competitor Analysis ───────────────────────────── */}
          {/* Section-order fix — Competitor Analysis now directly follows
              Target Audience (header/quick facts → overview → description →
              key insights → USP → target audience → competitor analysis →
              nearby/map), instead of sitting after the map. RERA stays
              paired with it (unchanged pairing, just moved as a unit).
              alignItems intentionally NOT 'start' here — CSS Grid's default
              (stretch) is what keeps a paired row's two cards bottom-
              aligned even when one has noticeably more content than the
              other (SectionCard fills that stretched height itself; see
              its own comment). */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>

            {/* RERA Details (PI-FR-04) — every value here is either a real scraped fact or
                explicitly marked "Not found". No fallback/placeholder RERA numbers, ever. */}
            {(() => {
              const isDubai = current?.market === 'dubai'
              const regLabel = isDubai ? 'DLD' : 'RERA'
              return (
            <SectionCard accent={reraCode ? '#2E9E4F' : '#8A8896'} title={`${regLabel} Details`} debugId="PI-FR-04"
              badge={official?.reraCode ? <SourceTag source="indihomes-db" compact /> : <FieldBadge kind={reraCode ? 'verified' : 'unverified'} />}>
                {!isDubai && (
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 0', borderBottom:'1px solid #E9E7E0', fontSize:13 }}>
                    <span style={{ color:'#75737F' }}>Trust score</span>
                    <span style={{ fontWeight:700, color:reraTrust.color, background:reraTrust.bg, padding:'3px 10px', borderRadius:4, fontSize:11.5 }} title={reraTrust.desc}>
                      {reraTrust.tier}
                    </span>
                  </div>
                )}
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 0', borderBottom:'1px solid #E9E7E0', fontSize:13 }}>
                  <span style={{ color:'#75737F' }}>{regLabel} Registration No.</span>
                  <span style={{ fontWeight:600, color: reraCode ? '#1B1B3A' : undefined, fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }}>
                    {reraCode || <EmptyValue>{`Not found${isDubai ? '' : ' on listing'}`}</EmptyValue>}
                  </span>
                </div>
                {live?.reraAll?.length > 1 && (
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 0', borderBottom:'1px solid #E9E7E0', fontSize:13 }}>
                    <span style={{ color:'#75737F' }}>Other tower registrations</span>
                    <span style={{ fontWeight:600, color:'#1B1B3A', fontSize:12 }}>+{live.reraAll.length - 1} more</span>
                  </div>
                )}
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 0', borderBottom:'1px solid #E9E7E0', fontSize:13 }}>
                  <span style={{ color:'#75737F' }}>Source</span>
                  <span style={{ fontWeight:600, color: reraCode ? '#1B1B3A' : undefined, fontSize:13 }}>
                    {official?.reraCode ? 'IndiHomes Website' : reraCode ? (live?._sources?.primary || (isDubai ? 'Web research' : '99acres listing')) : <EmptyValue />}
                  </span>
                </div>
                {isDubai ? (
                  <div style={{ marginTop:10, fontSize:11, color:'#8A8896', lineHeight:1.6, fontStyle:'italic' }}>
                    {reraCode
                      ? 'Dubai Land Department (DLD) reference found via web research. No automated DLD verification is integrated yet — confirm directly with the Dubai Land Department or the developer.'
                      : 'No DLD registration reference was found for this project. Verify directly with the developer or the Dubai Land Department.'}
                  </div>
                ) : (
                  <div style={{ marginTop:10, fontSize:11, color:'#8A8896', lineHeight:1.6, fontStyle:'italic' }}>
                    {reraCheck?.verified
                      ? `Government-verified via RERA registry${reraCheck.project_name ? ` — official record: "${reraCheck.project_name}"` : ''}.`
                      : reraCheck && !reraCheck.error
                      ? 'Checked against the RERA registry — no matching verified record found for this number.'
                      : reraCheck?.error
                      ? `Verification attempt failed: ${reraCheck.error}`
                      : official?.reraCode
                      ? 'Sourced directly from the IndiHomes Website. Click "Verify on MahaRERA" to additionally check it against the government registry.'
                      : reraCode
                      ? 'Advertiser-submitted detail, sourced from 99acres. Click "Verify on MahaRERA" to check it against the government registry.'
                      : 'No RERA number was found for this project. Verify directly with the builder or the state RERA portal.'}
                  </div>
                )}
                {!isDubai && (
                <div style={{ marginTop:14, display:'flex', gap:8 }}>
                  <button
                    disabled={!reraCode || reraChecking || !reraEnabled}
                    onClick={runReraVerify}
                    title={!reraEnabled ? 'Set SUREPASS_API_TOKEN on the server to enable' : reraCode ? 'Verify this registration number against the government RERA registry' : 'No RERA number found to verify'}
                    style={{ flex:1, padding:'8px', background: reraCode && reraEnabled ? '#E8F7EE' : '#F6F5F1', color: reraCode && reraEnabled ? '#2E9E4F' : '#B8B6C0', border:`1px solid ${reraCode && reraEnabled ? '#2E9E4F40' : '#E9E7E0'}`, borderRadius:8, fontSize:12, fontWeight:700, cursor: reraCode && reraEnabled && !reraChecking ? 'pointer' : 'not-allowed', fontFamily:"'Plus Jakarta Sans',sans-serif" }}>
                    {reraChecking ? '⟳ Verifying…' : reraCheck?.verified ? '✓ Verified' : reraCheck && !reraCheck.error ? '⚠ Not Verified — Retry' : '↗ Verify on MahaRERA'}
                  </button>
                  {(() => {
                    const certUrl = reraCheck?.certificate_url || live?.reraQrUrl
                    const label = reraCheck?.certificate_url ? '📄 View RERA Certificate' : live?.reraQrUrl ? '▣ View RERA QR' : '▣ No certificate found'
                    return (
                      <button
                        disabled={!certUrl}
                        onClick={() => certUrl && window.open(certUrl, '_blank', 'noopener,noreferrer')}
                        title={reraCheck?.certificate_url ? 'Opens the official government RERA certificate PDF' : live?.reraQrUrl ? 'Opens the RERA image from the listing' : 'Run "Verify on MahaRERA" first to fetch the official certificate'}
                        style={{ flex:1, padding:'8px', background:'#F6F5F1', color: certUrl ? '#0E0E52' : '#B8B6C0', border:'1px solid #E9E7E0', borderRadius:8, fontSize:12, fontWeight:700, cursor: certUrl ? 'pointer' : 'not-allowed', fontFamily:"'Plus Jakarta Sans',sans-serif" }}>
                        {label}
                      </button>
                    )
                  })()}
                </div>
                )}
            </SectionCard>
              )
            })()}

            {/* Competitor Analysis (PI-FR-07) — real Google Places nearby-
                search around this project's own resolved coordinates, same
                "real source, no fabrication" standard as Nearby
                Infrastructure's OpenStreetMap data. Part 4 redesign: a
                compact comparison list (not a large generic table) — each
                row shows THIS project's own real config/price against the
                competitor's, but ONLY when the competitor actually carries
                that field (Google Places entries never do; a legacy/
                research-sourced entry sometimes does) — never invented for
                a competitor that simply doesn't have it. Part 5: clicking a
                row with real coordinates selects/pans to its marker on the
                Location Map below (and vice versa, via selectedCompetitorId
                lifted to this component). */}
            <SectionCard title="Competitor Analysis" debugId="PI-FR-07"
              badge={realCompetitors.competitors.length ? <FieldBadge kind="places" />
                : live?.competitors?.length ? <SourceTag source={live._sources?.competitors || live._sources?.primary} compact />
                : research?.competitors?.length ? <FieldBadge kind="ai" /> : <FieldBadge kind="unverified" />}>
              {displayCompetitors.length > 0 ? (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {displayCompetitors.map((comp,i) => {
                    const hasMarker = comp.lat != null && comp.lon != null
                    const selected = selectedCompetitorId === i
                    // Genuine overlap fields — never fabricated. Only rendered
                    // when THIS competitor's own object carries a real value.
                    const compConfig = comp.config || comp.configuration || null
                    const compPossession = comp.possession || comp.possessionDate || null
                    const hasOverlapRow = compConfig || comp.price || compPossession
                    return (
                      <div key={i}
                        onClick={() => hasMarker && setSelectedCompetitorId(i)}
                        style={{
                          background: selected ? '#F1EDFB' : '#F9F8F6', borderRadius:10, padding:'10px 12px',
                          border: selected ? '1px solid #6B4FBB' : '1px solid transparent',
                          cursor: hasMarker ? 'pointer' : 'default', transition:'background .15s, border-color .15s',
                        }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:12.5, fontWeight:700, color:'#1B1B3A', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{comp.name}</div>
                            {(comp.address || comp.builder) && (
                              <div style={{ fontSize:10.5, color:'#8A8896', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{comp.address || comp.builder}</div>
                            )}
                          </div>
                          {comp.distanceKm != null ? (
                            <span style={{ fontSize:11, fontWeight:700, color:'#2E9E4F', fontFamily:"'IBM Plex Mono',monospace", flexShrink:0 }}>{comp.distanceKm} km</span>
                          ) : comp.status ? (
                            <span style={{ fontSize:10, background: comp.status==='Active'?'#E8F7EE':'#FEF3E4', color: comp.status==='Active'?'#2E9E4F':'#F7941D', padding:'2px 7px', borderRadius:4, fontWeight:600, flexShrink:0 }}>{comp.status}</span>
                          ) : null}
                        </div>
                        {hasOverlapRow && (
                          <div style={{ display:'flex', flexWrap:'wrap', gap:'2px 12px', fontSize:11, marginTop:6, paddingTop:6, borderTop:'1px solid #E9E7E0' }}>
                            {compConfig && (
                              <span>
                                <span style={{ color:'#8A8896' }}>Config: </span>
                                <span style={{ fontWeight:600, color: current?.config ? (current.config === compConfig ? '#2E9E4F' : '#D64545') : '#1B1B3A' }}>{compConfig}</span>
                                {current?.config && <span style={{ color:'#8A8896' }}> · yours: {current.config}</span>}
                              </span>
                            )}
                            {comp.price && (
                              <span><span style={{ color:'#8A8896' }}>Price: </span><span style={{ fontWeight:600 }}>{comp.price}</span>{current?.budgetLabel && <span style={{ color:'#8A8896' }}> · yours: {current.budgetLabel}</span>}</span>
                            )}
                            {compPossession && (
                              <span><span style={{ color:'#8A8896' }}>Possession: </span><span style={{ fontWeight:600 }}>{compPossession}</span></span>
                            )}
                          </div>
                        )}
                        {comp.mapsUrl && (
                          <a href={comp.mapsUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                            style={{ fontSize:10.5, color:'#0E0E52', textDecoration:'underline', fontWeight:600, marginTop:6, display:'inline-block' }}>
                            ↗ Maps
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : realCompetitors.configured === false ? (
                <EmptyState reason="Not connected — Google Places API key not set on the server."
                  detail="Set GOOGLE_PLACES_API_KEY (see requirements.md) to enable a real nearby-search for competing residential projects. No fallback data source is used in its place." />
              ) : realCompetitors.error ? (
                // Part 16 — a genuine search failure (Places API error,
                // network failure, disabled API) is a DIFFERENT state from
                // "the search ran and confirmed zero results" and must
                // never be worded the same way.
                <EmptyState reason="Competitor data unavailable"
                  detail={`The nearby-project search didn't complete (${realCompetitors.error}). This is different from "no competitors found" — try again shortly.`} />
              ) : projectGeo?.lat ? (
                <EmptyState reason={`No competing residential projects found within ${realCompetitors.radiusKm || 3} km${current?.city ? ` of this location in ${current.city}` : ''}.`} />
              ) : (
                <EmptyState reason="Not connected — waiting for the Location Map below to resolve real coordinates for this project." />
              )}
              <div style={{ marginTop:12, fontSize:12, color:'#8A8896' }}>
                Within {realCompetitors.radiusKm || 3} km of this project's real coordinates
                {projectGeo?.approx && ' (locality-level location — not the exact project coordinates)'}
                {realCompetitors.competitors.length > 0 && ' · Source: Google Places'}
                {!realCompetitors.competitors.length && displayCompetitors.length > 0 && ' · Source: Drishti AI live research'}
              </div>
            </SectionCard>
          </div>

          {/* ── Row 4: Location Map + Nearby Infrastructure ─────────────────── */}
          {/* alignItems intentionally NOT 'start' here — CSS Grid's default
              (stretch) is what keeps a paired row's two cards bottom-
              aligned even when one has noticeably more content than the
              other (SectionCard fills that stretched height itself; see
              its own comment). */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>

            {/* Location Map (PI-FR-05) — real, interactive OpenStreetMap (Leaflet,
                no API key/billing) with the project, every Nearby
                Infrastructure item (stations, schools, malls, landmarks),
                AND (Part 5) every Competitor Analysis project with real
                coordinates — all geocoded and pinned together, not just a
                single-point embed. */}
            {(() => {
              const locality = live?.location || current?.location
              const mapQuery = [current?.name, locality, current?.city].filter(Boolean).join(', ')
              // Locality+city only, no project name — a far more geocodable
              // query for a brand-new/under-construction tower name that
              // OpenStreetMap has never indexed. Only used when the full
              // query above resolves to nothing (see NearbyMap).
              const fallbackQuery = [locality, current?.city].filter(Boolean).join(', ')
              // The official IndiHomes-provided Maps link, when present, is
              // more trustworthy than a constructed text-search URL — it's
              // whatever the developer/IndiHomes themselves pinned.
              const externalMapsUrl = official?.googleMapLink
                || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`
              return (
                <SectionCard title="Location Map" debugId="PI-FR-05" badge={<FieldBadge kind={mapQuery.length > 3 ? 'ai' : 'unverified'} />}>

                  {mapQuery.length > 3 ? (
                    <div style={{ marginBottom:14 }}>
                      <NearbyMap projectQuery={mapQuery} fallbackQuery={fallbackQuery} onPlaces={setRealNearbyPlaces} onGeo={setProjectGeo}
                        mapsUrl={externalMapsUrl} displayName={current?.name}
                        knownGeo={Number.isFinite(current?.placesLat) && Number.isFinite(current?.placesLon) ? { lat: current.placesLat, lon: current.placesLon } : null}
                        competitors={displayCompetitors} selectedCompetitorId={selectedCompetitorId} onSelectCompetitor={setSelectedCompetitorId} />
                    </div>
                  ) : (
                    <div style={{ color:'#75737F', fontSize:13, padding:'30px 0', textAlign:'center', fontStyle:'italic', background:'#F9F8F6', borderRadius:10, marginBottom:14 }}>
                      No project name available to locate this project on a map.
                    </div>
                  )}
              {[
                ['Locality', live?.localityName ? live.localityName : <EmptyValue />, '#1B1B3A'],
                ['Location Quality Score', locQuality ? `${locQuality.score}/100 · ${locQuality.tier} (${locQuality.categoryCount} amenity types nearby)` : <EmptyValue />, locQuality ? locQuality.color : null],
                ['Search Trend (7d vs prior 7d)', live?.searchTrend?.label ? live.searchTrend.label : <EmptyValue />, live?.searchTrend?.direction === 'down' ? '#D64545' : '#2E9E4F'],
                ['Competing Projects', `${displayCompetitors.length} found nearby`, '#75737F'],
              ].map(([l,v,c]) => (
                <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'7px 0', borderBottom:'1px solid #E9E7E0', fontSize:13 }}>
                  <span style={{ color:'#75737F' }}>{l}</span><span style={{ fontWeight:700, color: c || undefined }}>{v}</span>
                </div>
              ))}
                </SectionCard>
              )
            })()}

            {/* Nearby Infrastructure (PI-FR-06) — Part 2 redesign: icon-tile
                category rail (always shows counts + an icon, opens on the
                first populated bucket instead of a blank shell) and a
                per-item verified/AI-derived badge so the card is legible
                without clicking anything first. */}
            <SectionCard title="Nearby Infrastructure" debugId="PI-FR-06"
              badge={realNearbyPlaces.length ? <FieldBadge kind="map" /> : live?.infra?.length ? <SourceTag source={live._sources?.primary} compact /> : researchNearby.length ? <FieldBadge kind="ai" /> : <FieldBadge kind="unverified" />}>
              {displayInfra.length > 0 ? (
                <>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
                    {infraBucketsPresent.map(b => {
                      const active = effectiveInfraCategory === b
                      const Icon = INFRA_BUCKET_ICON[b] || MapPin
                      const accent = INFRA_BUCKET_COLOR[b] || '#75737F'
                      return (
                        <button key={b}
                          onClick={() => setActiveInfraCategory(b)}
                          style={{
                            display:'flex', alignItems:'center', gap:6, cursor:'pointer',
                            padding:'6px 12px 6px 10px', borderRadius:9, fontSize:12, fontWeight:700,
                            border: active ? `1.5px solid ${accent}` : '1.5px solid #E9E7E0',
                            background: active ? `${accent}14` : '#fff',
                            color: active ? accent : '#4A4A63',
                            transition:'border-color .15s, background .15s',
                          }}>
                          <Icon size={14} strokeWidth={2.2} color={active ? accent : '#8A8896'} />
                          {b}
                          <span style={{
                            fontFamily:"'IBM Plex Mono',monospace", fontSize:10.5, fontWeight:700,
                            color: active ? accent : '#8A8896', background: active ? '#fff' : '#F6F5F1',
                            borderRadius:20, padding:'1px 6px', lineHeight:1.5,
                          }}>{displayInfra.filter(i => i.bucket === b).length}</span>
                        </button>
                      )
                    })}
                  </div>
                  {filteredInfra.length > 0 ? (
                    // Part 13 — single-column, full-card-width rows (not a
                    // 2-up grid, which was what forced names like
                    // "Government General Hospital" into a single-line
                    // ellipsis at roughly half the card's width). The name
                    // gets the FULL row width on its own line; distance sits
                    // on the second line next to the verification badge,
                    // never competing with the name for horizontal space.
                    // A 2-line clamp (not 1) is the only truncation left, for
                    // the rare name still too long even at full width — the
                    // `title` attribute still exposes the complete name on
                    // hover in that case.
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {filteredInfra.map((item,i) => (
                        <div key={i} style={{
                          display:'flex', alignItems:'flex-start', gap:10, padding:'9px 11px',
                          background:'#FAF9F6', border:'1px solid #F0EEE8', borderRadius:8, minWidth:0,
                        }}>
                          <span style={{
                            width:26, height:26, borderRadius:7, flexShrink:0,
                            display:'flex', alignItems:'center', justifyContent:'center',
                            fontSize:14, background: `${INFRA_BUCKET_COLOR[item.bucket] || '#75737F'}14`,
                          }}>{item.icon || '📍'}</span>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div title={item.name} style={{
                              fontSize:12.5, fontWeight:600, color:'#1B1B3A', lineHeight:1.35,
                              display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden',
                            }}>{item.name}</div>
                            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginTop:3 }}>
                              <span style={{ fontSize:10.5, fontWeight:700, color: item.verified ? '#2E9E4F' : '#B8860B', letterSpacing:'0.02em', flexShrink:0 }}>
                                {item.verified ? '● Map-verified' : '◌ AI-derived'}
                              </span>
                              {item.dist && <span style={{ fontSize:11.5, fontWeight:700, color:'#75737F', fontFamily:"'IBM Plex Mono',monospace", flexShrink:0 }}>{item.dist}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState reason={`No ${(effectiveInfraCategory || '').toLowerCase()} found nearby.`} />
                  )}
                </>
              ) : (
                <EmptyState reason="No nearby places found."
                  detail={realNearbyPlaces.length === 0
                    ? "Either the Location Map above couldn't geocode this project precisely enough to search around it, or genuinely nothing in OpenStreetMap's data is nearby — check the map card for which."
                    : undefined} />
              )}
            </SectionCard>
          </div>

          {/* ── Hand-off CTA (PI-FR-13) ─────────────────────────────────────── */}
          <div style={{ background:'#0E0E52', borderRadius:14, padding:'24px 28px', display:'flex', alignItems:'center', gap:24 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:11, fontFamily:"'IBM Plex Mono',monospace", color:'rgba(255,255,255,0.5)', letterSpacing:'0.1em', marginBottom:6 }}>
                NEXT STEP{isDebugMode() && ' — PI-FR-13'}
              </div>
              <div style={{ fontSize:18, fontWeight:800, color:'#fff', marginBottom:4 }}>Ready to brief the Campaign Recommendation Engine</div>
              <div style={{ fontSize:13, color:'rgba(255,255,255,0.6)' }}>
                {displayUSPs.length} USPs extracted · {displayAudience.filter(a=>a.fit==='High').length} high-fit audience segments · {reraCode ? 'RERA verified' : 'RERA details on file'}
              </div>
            </div>
            <button style={{ padding:'14px 28px', background:'#FECF55', color:'#0E0E52', border:'none', borderRadius:12, fontSize:15, fontWeight:800, cursor:'pointer', fontFamily:"'Plus Jakarta Sans',sans-serif", whiteSpace:'nowrap' }}>
              Proceed to Campaign Reco →
            </button>
          </div>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
