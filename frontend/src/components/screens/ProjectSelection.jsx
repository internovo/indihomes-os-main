import React, { useState, useEffect, useCallback } from 'react'
import { Search, Loader2, MapPin, Bed, IndianRupee, Calendar, Hammer, Sparkles, History, X, TriangleAlert, ArrowDown, SlidersHorizontal, ClipboardList, Inbox, ExternalLink } from 'lucide-react'
import gazetteer from '../../../../shared/mmr-gazetteer.json'
import FieldBadge from '../ui/FieldBadge.jsx'
import { EmptyValue } from '../ui/EmptyState.jsx'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || ''

// Microlocation search — Places API (New) autocomplete, called directly via
// REST (no JS Places library needed, and no legacy-API activation required).
// This is what makes "mindspace" resolve nationwide: Places covers named
// businesses/landmarks everywhere in India, not just OSM's locality/street data.
async function placesAutocomplete(query, market) {
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
    body: JSON.stringify({ input: query, includedRegionCodes: [market === 'dubai' ? 'ae' : 'in'] }),
  })
  if (!res.ok) throw new Error(`Places ${res.status}`)
  const data = await res.json()
  return (data.suggestions || []).map(s => {
    const pp = s.placePrediction
    if (!pp) return null
    return {
      name: pp.structuredFormat?.mainText?.text || pp.text?.text || '',
      area: pp.structuredFormat?.secondaryText?.text || '',
      type: (pp.types || [])[0] || 'place',
      placeId: pp.placeId,
    }
  }).filter(Boolean)
}

// Session memory (module scope, survives unmount): navigating away — e.g.
// clicking "Analyse this project" — and coming back keeps the AI search
// results, the query, the active tab and the filters exactly as they were.
const sessionMemory = {
  mode: 'filter', aiResult: null, market: 'india', aiLocations: [],
  locations: [], budget: 'All', configs: [], possession: 'All', propertyLocations: [],
}

// Called from Project Intelligence once its deeper research finds a RERA
// number the search-list extraction missed, so the card is correct if the
// user navigates back to the AI Search results (list stays in sync with detail).
export function syncReraIntoSearchResults(name, rera) {
  if (!rera || !sessionMemory.aiResult?.properties) return
  const p = sessionMemory.aiResult.properties.find(x => x.name?.toLowerCase() === String(name).toLowerCase())
  if (p && !p.rera) p.rera = rera
}

const RANK_COLOR = {
  PRIMARY: '#2E9E4F',
  SECONDARY: '#F7941D',
  TERTIARY: '#8B8BD6',
}
const rankColor = (rank) => RANK_COLOR[rank] || '#8B8BD6'

// Tier-first ordering for Filter Search's card list — a project's PRIMARY/
// SECONDARY/TERTIARY tier must always sort above a lower tier's, even when
// that lower-tier project happens to have a marginally higher raw score
// (e.g. a 59-point SECONDARY-adjacent Tertiary result can't outrank a
// genuinely 80+ PRIMARY one). Thresholds mirror server.cjs's /api/filter-rank
// bucketing (score>=80 primary / >=60 secondary / >=40 tertiary) exactly, so
// the sort order always agrees with the badge actually shown on the card.
const TIER_RANK = { PRIMARY: 0, SECONDARY: 1, TERTIARY: 2 }
function tierRankFromScore(score) {
  if (score == null) return 3
  if (score >= 80) return 0
  if (score >= 60) return 1
  if (score >= 40) return 2
  return 3
}
// aiMatch (from /api/filter-rank, reflects the CURRENT filter) takes
// precedence over the project's static baseline `rank` field when present.
function tierRankOf(project, aiMatch) {
  if (aiMatch?.match_score != null) return tierRankFromScore(aiMatch.match_score)
  return TIER_RANK[project.rank] ?? 3
}
function scoreOf(project, aiMatch) {
  return aiMatch?.match_score ?? project.score ?? 0
}
// The badge shown on a card must reflect the LIVE per-search match, not the
// project's static baseline `rank` tag (a heuristic computed once at scrape
// time, unrelated to the current search) — using project.rank here was a
// real bug: a card's score (e.g. 96) and its badge (e.g. SECONDARY, from an
// unrelated static tag) could visibly disagree. Mirrors scoring.cjs's
// labelFor() thresholds (80/60/40), folding its "Tertiary"+"Low Match" into
// one TERTIARY badge — the UI's requested vocabulary is exactly three tiers,
// the real numeric score right next to it is what carries the finer-grained
// precision.
function rankLabelOf(project, aiMatch) {
  if (aiMatch?.match_score != null) {
    const s = aiMatch.match_score
    return s >= 80 ? 'PRIMARY' : s >= 60 ? 'SECONDARY' : 'TERTIARY'
  }
  return project.rank || 'TERTIARY'
}
function compareRanked(aiMatchOf) {
  return (a, b) => {
    const am = aiMatchOf ? aiMatchOf(a) : null, bm = aiMatchOf ? aiMatchOf(b) : null
    const ta = tierRankOf(a, am), tb = tierRankOf(b, bm)
    if (ta !== tb) return ta - tb
    return scoreOf(b, bm) - scoreOf(a, am)
  }
}

const SOURCE_STYLE = {
  'indihomes-website': { bg:'#E6F4EA', color:'#0B6B3A', label:'IndiHomes Website' },
  '99acres':       { bg:'#E8F5EE', color:'#156B35' },
  '99acres-local': { bg:'#E8F5EE', color:'#156B35' },
  'magicbricks':   { bg:'#FEE8E8', color:'#8B1A1A' },
  'housing':       { bg:'#EEE8FF', color:'#4A1A8B' },
  'google-ads':    { bg:'#E8EEFF', color:'#0E0E52' },
}

// Curated builder → Unsplash photo ID for consistent building images
const BUILDER_IMG = {
  lodha:       'photo-1545324418-cc1a3fa10c00',
  godrej:      'photo-1486325212027-8081e485255e',
  piramal:     'photo-1560185893-a55cbc8c57e8',
  hiranandani: 'photo-1512917774080-9991f1c4c750',
  runwal:      'photo-1558618666-fcd25c85cd64',
  rustomjee:   'photo-1600585154340-be6161a56a0c',
  shapoorji:   'photo-1600596542815-ffad4c1539a9',
  raymond:     'photo-1613977257363-707ba9348227',
  adani:       'photo-1580587771525-78b9dba3b914',
  tata:        'photo-1564501049412-61c2a3083791',
  oberoi:      'photo-1600566753086-00f18fb6b3ea',
  kalpataru:   'photo-1600607687939-ce8a6c25118c',
  birla:       'photo-1600047509807-ba8f99d2cdde',
  prestige:    'photo-1600566753190-17f0baa2a6c3',
  kolte:       'photo-1593696140826-c58b021acf8b',
  sunteck:     'photo-1560448204-603b3fc33ddc',
  mahindra:    'photo-1628744448840-55bdb2497bd4',
}

function projectImageUrl(project) {
  const builder = (project.builder || '').toLowerCase()
  for (const [key, id] of Object.entries(BUILDER_IMG)) {
    if (builder.includes(key)) {
      return `https://images.unsplash.com/${id}?w=160&h=110&fit=crop&auto=format&q=70`
    }
  }
  return `https://picsum.photos/seed/${encodeURIComponent(project.name || project.id)}/160/110`
}

const btn = (bg, color, border) => ({
  padding: '8px 16px',
  background: bg,
  color,
  border: `1px solid ${border || 'transparent'}`,
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: "'Plus Jakarta Sans',sans-serif",
  transition: 'opacity 0.2s',
})

function CountdownBar({ nextRun }) {
  const [secs, setSecs] = useState(60)

  useEffect(() => {
    if (!nextRun) return
    const tick = () => {
      const remaining = Math.max(0, Math.round((new Date(nextRun) - Date.now()) / 1000))
      setSecs(remaining)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [nextRun])

  const pct = Math.min(100, Math.max(0, ((60 - secs) / 60) * 100))

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: '#75737F' }}>
        <span>Next auto-refresh</span>
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: '#0E0E52', fontWeight: 600 }}>{secs}s</span>
      </div>
      <div style={{ height: 3, background: '#E9E7E0', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: '#2E9E4F', borderRadius: 2, transition: 'width 1s linear' }} />
      </div>
    </div>
  )
}

function SourceBadge({ source }) {
  const s = SOURCE_STYLE[source] || { bg: '#F6F5F1', color: '#75737F' }
  return (
    <span style={{ background: s.bg, color: s.color, padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600, fontFamily: "'IBM Plex Mono',monospace" }}>
      {s.label || source}
    </span>
  )
}

// Collapses a raw source/hostname (99acres.com, www.magicbricks.com,
// tavily, google-cse, ...) onto SOURCE_STYLE's known keys so an AI Search
// result card shows the same clean badge Property Search already uses,
// instead of a raw domain string or "via X" prose.
function normalizedSourceKey(name) {
  if (!name) return null
  const n = String(name).toLowerCase()
  if (n.includes('99acres')) return '99acres'
  if (n.includes('magicbricks')) return 'magicbricks'
  if (n.includes('housing')) return 'housing'
  if (n.includes('indihomes')) return 'indihomes-website'
  return null
}

function ProjectCard({ project, index, selected, onToggle, aiMatch, hasActiveFilter }) {
  // The PRIMARY/SECONDARY/TERTIARY badge is a claim that real matching
  // happened against something the user asked for — showing it on a bare,
  // unfiltered browse (project.rank is a static heuristic tag, not a live
  // match result) implies ranking that hasn't actually occurred yet. Same
  // gate the score column below already uses.
  const showRank = hasActiveFilter || !!aiMatch
  const rankLabel = showRank ? rankLabelOf(project, aiMatch) : null
  const rc = rankLabel ? rankColor(rankLabel) : '#C8C6D0'
  const imgUrl = projectImageUrl(project)

  return (
    <div
      onClick={() => onToggle(project.id)}
      style={{
        background: '#fff',
        border: selected ? `2px solid #0E0E52` : `1px solid #E9E7E0`,
        borderLeft: selected ? `4px solid #0E0E52` : `4px solid ${rc}`,
        borderRadius: 12,
        padding: selected ? '15px 19px' : '16px 20px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
        cursor: 'pointer',
        transition: 'box-shadow 0.15s, border-color 0.15s',
        boxShadow: selected ? '0 0 0 3px rgba(14,14,82,0.08)' : 'none',
      }}
    >
      {/* Checkbox */}
      <div style={{ paddingTop: 2, flexShrink: 0 }}>
        <div style={{
          width: 18, height: 18, borderRadius: 4,
          border: selected ? '2px solid #0E0E52' : '2px solid #C8C6D0',
          background: selected ? '#0E0E52' : '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.15s',
        }}>
          {selected && (
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
              <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </div>
      </div>

      {/* Rank number */}
      <div style={{ fontSize: 22, fontWeight: 800, color: '#E9E7E0', minWidth: 32, paddingTop: 2, fontFamily: "'IBM Plex Mono',monospace" }}>
        #{index + 1}
      </div>

      {/* Project image */}
      <div style={{ width: 80, height: 60, borderRadius: 8, flexShrink: 0, overflow: 'hidden', background: '#E9E7E0' }}>
        <img
          src={imgUrl}
          alt={project.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={e => {
            e.currentTarget.style.display = 'none'
            e.currentTarget.parentElement.style.background =
              'repeating-linear-gradient(45deg,#E9E7E0,#E9E7E0 4px,#F6F5F1 4px,#F6F5F1 8px)'
          }}
        />
      </div>

      {/* Main info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#1B1B3A' }}>{project.name}</span>
          {showRank && (
            <span style={{ background: rc, color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, fontFamily: "'IBM Plex Mono',monospace" }}>
              {rankLabel}
            </span>
          )}
          {project.reraCode ? (
            <FieldBadge kind="verified" label={`RERA ${project.reraCode}`} />
          ) : project.rera ? (
            <FieldBadge kind="verified" label="RERA ✓" />
          ) : null}
        </div>

        <div style={{ fontSize: 12, color: '#75737F', marginBottom: 2 }}>
          {project.builder} &middot; {project.city} &middot; {project.config}
        </div>

        <div style={{ fontSize: 12, color: '#75737F', marginBottom: 8 }}>
          {project.budgetLabel}
          {project.possession !== 'TBD' && ` · ${project.possession}`}
          {project.sold != null && ` · ${project.sold}% sold`}
          {project.units != null && ` · ${project.units} units`}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {(project.sources || []).map(s => <SourceBadge key={s} source={s} />)}
          {project.listingUrl && (
            <a href={project.listingUrl} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ fontSize: 10, color: '#0E0E52', textDecoration: 'underline', fontWeight: 600 }}>
              View listing ↗
            </a>
          )}
        </div>

        {aiMatch && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: '#4A4A63', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <span style={{ color: '#6B4FBB', fontWeight: 700, flexShrink: 0 }}>✦ Drishti AI</span>
            <span>{aiMatch.why || aiMatch.reason || ''}</span>
          </div>
        )}
      </div>

      {/* Score — only shown once the user has actually asked for something to
          rank against (a filter, an NL "Fill filters" query, or an AI Search
          "Analyse"-derived aiMatch). Before that, project.score/match are
          scoring.cjs's completeness-only baseline (no filter dimensions were
          "applicable"), which looks like a real ranked result but isn't one —
          showing it on a bare, unfiltered browse is misleading. */}
      <div style={{ textAlign: 'center', minWidth: 64 }}>
        {aiMatch ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#6B4FBB', fontFamily: "'IBM Plex Mono',monospace" }}>
              {aiMatch.match_score ?? '—'}
            </div>
            <div style={{ fontSize: 10, color: '#8A8896', textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI match</div>
            {/* Genuinely a different number from AI match above — a static,
                search-independent completeness/data-quality baseline
                (indihomes-client.cjs's attachScore), not a second match
                score. Labeled explicitly so it never reads as a duplicate/
                conflicting percentage (same distinction Project Intelligence
                already makes between "AI Match" and "IndiHomes Score"). */}
            <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700, color: '#1B1B3A' }} title="Static listing-quality baseline — not a search match">{project.match}%</div>
            <div style={{ fontSize: 10, color: '#8A8896' }}>IndiHomes score</div>
          </>
        ) : hasActiveFilter ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 800, color: rc, fontFamily: "'IBM Plex Mono',monospace" }}>
              {project.score}
            </div>
            <div style={{ fontSize: 10, color: '#8A8896', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Score</div>
          </>
        ) : (
          <div title="Apply a filter to rank projects against it">
            <div style={{ fontSize: 22, fontWeight: 800, color: '#C8C6D0', fontFamily: "'IBM Plex Mono',monospace" }}>—</div>
            <div style={{ fontSize: 10, color: '#8A8896', textTransform: 'uppercase', letterSpacing: '0.05em' }}>No filter yet</div>
          </div>
        )}
      </div>
    </div>
  )
}

function AnalyseBar({ count, onClear, onAnalyse, onBrief }) {
  return (
    <div style={{
      position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
      background: '#0E0E52', color: '#fff',
      borderRadius: 16, padding: '14px 24px',
      display: 'flex', alignItems: 'center', gap: 20,
      boxShadow: '0 8px 32px rgba(14,14,82,0.35)',
      zIndex: 100, minWidth: 380,
      fontFamily: "'Plus Jakarta Sans',sans-serif",
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
        <div style={{
          background: '#2E9E4F', borderRadius: 8, width: 32, height: 32,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 15, fontWeight: 800,
        }}>
          {count}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            {count === 1 ? '1 project selected' : `${count} projects selected`}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>Ready for AI analysis</div>
        </div>
      </div>
      <button
        onClick={onClear}
        style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'Plus Jakarta Sans',sans-serif" }}
      >
        Clear
      </button>
      <button
        onClick={onBrief}
        title="Generate a deterministic campaign brief from the selected projects — no AI/LLM involved"
        style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: "'Plus Jakarta Sans',sans-serif", whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}
      >
        <ClipboardList size={14} /> Generate Campaign Brief
      </button>
      <button
        onClick={onAnalyse}
        style={{ background: '#F7941D', border: 'none', color: '#fff', borderRadius: 10, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "'Plus Jakarta Sans',sans-serif", display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}
      >
        Analyse Selected <span style={{ fontSize: 16 }}>→</span>
      </button>
    </div>
  )
}

// Maharashtra real-estate locations grouped by city — powers both the flat
// filter combobox and the detailed, categorised search suggestions
// (LOCALITY | MUMBAI · PROJECT | THANE · …). Merged at runtime with whatever
// the scraper actually returns so nothing is missing.
const LOCATION_GROUPS_BASE = {
  Mumbai: [
    'Andheri', 'Andheri East', 'Andheri West', 'Bandra', 'Bandra East', 'Bandra West',
    'Borivali', 'Borivali East', 'Borivali West', 'Kandivali', 'Kandivali East', 'Kandivali West',
    'Malad', 'Malad East', 'Malad West', 'Goregaon', 'Goregaon East', 'Goregaon West',
    'Jogeshwari East', 'Jogeshwari West', 'Mulund', 'Mulund East', 'Mulund West',
    'Powai', 'Chembur', 'Ghatkopar', 'Ghatkopar East', 'Ghatkopar West',
    'Dadar', 'Dadar East', 'Dadar West', 'Worli', 'Lower Parel', 'Wadala',
    'Mahalaxmi', 'Juhu', 'Vikhroli', 'Bhandup', 'Kurla', 'Santacruz', 'Santacruz East', 'Santacruz West',
    'Vile Parle', 'Vile Parle East', 'Vile Parle West', 'Kanjurmarg', 'Parel', 'Byculla',
    'Dahisar', 'Dahisar East', 'Dahisar West',
    'Bangur Nagar', 'Oshiwara', 'Lokhandwala', 'Versova', 'Yari Road', 'Four Bungalows',
    'Seven Bungalows', 'DN Nagar', 'Azad Nagar', 'Veera Desai Road', 'Marol', 'Chakala',
    'Sakinaka', 'Chandivali', 'Aarey Colony', 'Charkop', 'Mahavir Nagar', 'Poisar',
    'Thakur Village', 'Thakur Complex', 'Magathane', 'IC Colony', 'Shimpoli', 'Gorai',
    'Nahur', 'Kanjurmarg East', 'Vidyavihar', 'Tilak Nagar', 'Pant Nagar', 'Garodia Nagar',
    'Amrut Nagar', 'Sion', 'Matunga', 'Mahim', 'Prabhadevi', 'Sewri', 'Kalina', 'BKC',
    'Khar', 'Khar West', 'Pali Hill', 'Carter Road', 'Chembur East', 'Deonar', 'Govandi',
    'Mankhurd', 'Antop Hill',
  ],
  Thane: [
    'Majiwada', 'Kolshet', 'Ghodbunder Road', 'Kalwa', 'Mumbra', 'Balkum', 'Manpada',
    'Waghbil', 'Kavesar', 'Patlipada', 'Hiranandani Estate', 'Brahmand', 'Ovala',
    'Pokhran Road', 'Vartak Nagar', 'Wagle Estate', 'Teen Hath Naka', 'Anand Nagar',
    'Dombivli East', 'Dombivli West', 'Kalyan West', 'Kalyan East',
  ],
  'Navi Mumbai': [
    'Vashi', 'Nerul', 'Belapur', 'Kharghar', 'Airoli', 'Ghansoli', 'Kopar Khairane',
    'Ulwe', 'Taloja', 'Dronagiri', 'Sanpada',
  ],
  Pune: [
    'Hinjewadi', 'Wakad', 'Baner', 'Kharadi', 'Hadapsar', 'Kothrud', 'Aundh',
    'Wagholi', 'Undri', 'Mundhwa', 'Balewadi', 'Punawale', 'Ravet', 'Pimpri',
    'Chinchwad', 'Viman Nagar', 'Magarpatta', 'Bavdhan', 'Sinhagad Road', 'Kondhwa',
    'Pimple Saudagar', 'Tathawade', 'Kalyani Nagar', 'Koregaon Park', 'Erandwane',
    'Karve Nagar', 'Warje', 'Ambegaon', 'Dhanori', 'Lohegaon', 'Moshi', 'Chikhali',
    'Akurdi', 'Nigdi', 'Pashan', 'Sus', 'Mahalunge', 'Manjari', 'Keshav Nagar', 'NIBM Road',
  ],
}
// Merged with the shared MMR gazetteer (mmr-gazetteer.json, also consumed by
// scoring.cjs/azure-search.cjs/legacy-portal-connector.cjs on the backend) —
// a union, never a replacement, so nothing curated above is ever dropped.
// This is what adds Vasai-Virar/Mira-Bhayandar as first-class buckets and a
// much larger set of micro-localities under the suburbs already listed here.
const LOCATION_GROUPS = {}
for (const city of new Set([...Object.keys(LOCATION_GROUPS_BASE), ...Object.keys(gazetteer.cities || {})])) {
  LOCATION_GROUPS[city] = [...new Set([...(LOCATION_GROUPS_BASE[city] || []), ...((gazetteer.cities || {})[city] || [])])]
}
// Locality/pocket -> parent-suburb + region resolution (e.g. "Gawamin" ->
// parent "Vasai West", city "Vasai-Virar") for names too small to be their
// own LOCATION_GROUPS entry. Used so a search for a covered-but-thin pocket
// still resolves and can show an honest "0 matching projects" instead of
// "location not understood".
const MICRO_ALIASES = gazetteer.aliases || {}
function resolveLocationTerms(term) {
  const key = String(term).trim().toLowerCase()
  const alias = MICRO_ALIASES[key]
  if (!alias) return [key]
  return [...new Set([key, alias.canonical.toLowerCase(), alias.parent.toLowerCase(), alias.city.toLowerCase()])]
}
// Mirrors scoring.cjs's baseLocality() — strips a trailing directional
// qualifier so "Borivali East"/"Borivali West" are recognized as siblings.
// Kept in sync deliberately (same one-line transform, not a shared import —
// this file runs in the browser, scoring.cjs is a CommonJS backend module).
function baseLocality(term) {
  return String(term).trim().toLowerCase().replace(/\s+(east|west|north|south)\.?$/i, '').trim()
}
const MAHARASHTRA_CITIES = [
  'Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'Kalyan', 'Dombivli', 'Vasai', 'Virar',
  'Nallasopara', 'Naigaon', 'Mira-Bhayandar', 'Mira Road', 'Bhayandar', 'Ulhasnagar',
  'Badlapur', 'Ambernath', 'Panvel',
  'Nagpur', 'Nashik', 'Chhatrapati Sambhajinagar', 'Aurangabad', 'Solapur',
  'Kolhapur', 'Amravati', 'Nanded', 'Sangli', 'Jalgaon', 'Akola', 'Latur',
  'Ahmednagar', 'Chandrapur', 'Satara', 'Ratnagiri',
]

// Real Mumbai/Thane/Navi Mumbai/Pune rail + metro stations — public transit
// data, safe to hardcode accurately. Powers instant "TRAIN STATION" results
// (no network call), same category label real portals use for both suburban
// rail and metro stops.
const STATIONS = {
  Mumbai: [
    // Western Line
    'Churchgate', 'Marine Lines', 'Charni Road', 'Grant Road', 'Mumbai Central',
    'Mahalaxmi', 'Lower Parel', 'Elphinstone Road (Prabhadevi)', 'Dadar', 'Matunga Road',
    'Mahim Junction', 'Bandra', 'Khar Road', 'Santacruz', 'Vile Parle', 'Andheri',
    'Jogeshwari', 'Ram Mandir', 'Goregaon', 'Malad', 'Kandivali', 'Borivali',
    'Dahisar', 'Mira Road', 'Bhayandar', 'Naigaon', 'Vasai Road', 'Nallasopara', 'Virar',
    // Central Line
    'CSMT (VT)', 'Masjid', 'Sandhurst Road', 'Byculla', 'Chinchpokli', 'Currey Road',
    'Parel', 'Dadar Central', 'Matunga', 'Sion', 'Kurla', 'Vidyavihar', 'Ghatkopar',
    'Vikhroli', 'Kanjurmarg', 'Bhandup', 'Nahur', 'Mulund', 'Thane', 'Kalwa',
    'Mumbra', 'Diva Junction', 'Dombivli', 'Kalyan Junction',
    // Harbour Line
    'Wadala Road', 'GTB Nagar', 'Chuna Bhatti', 'Kurla Harbour', 'Tilak Nagar',
    'Chembur', 'Govandi', 'Mankhurd', 'Vashi', 'Sanpada', 'Juinagar', 'Nerul',
    'Seawoods-Darave', 'Belapur', 'Kharghar', 'Mansarovar', 'Khandeshwar', 'Panvel',
    // Metro Line 1 (Versova-Andheri-Ghatkopar)
    'Versova Metro', 'D N Nagar Metro', 'Azad Nagar Metro', 'Andheri Metro',
    'Western Express Highway Metro', 'Chakala Metro', 'Airport Road Metro',
    'Marol Naka Metro', 'Saki Naka Metro', 'Asalpha Metro', 'Jagruti Nagar Metro', 'Ghatkopar Metro',
    // Metro Line 2A (Dahisar-DN Nagar) & Line 7 (Dahisar East-Andheri East)
    'Dahisar East Metro', 'Kandivali West Metro', 'Malad West Metro', 'Goregaon West Metro',
    'Aarey Metro', 'Andheri West Metro',
  ],
  Thane: ['Thane Station', 'Mulund Station', 'Kalwa Station'],
  'Navi Mumbai': ['Vashi Station', 'Nerul Station', 'Belapur Station', 'Kharghar Station', 'Panvel Station'],
  Pune: [
    'Pune Junction', 'Shivajinagar', 'Khadki', 'Dapodi',
    // Pune Metro
    'PCMC Metro', 'Sant Tukaram Nagar Metro', 'Nashik Phata Metro', 'Kasarwadi Metro',
    'Phugewadi Metro', 'Dapodi Metro', 'Bopodi Metro', 'Khadki Metro', 'Range Hills Metro',
    'Shivajinagar Metro', 'Civil Court Metro', 'Mandai Metro', 'Ruby Hall Clinic Metro',
    'Bund Garden Metro', 'Yerawada Metro', 'Kalyani Nagar Metro', 'Ramwadi Metro',
    'Vanaz Metro', 'Anand Nagar Metro', 'Ideal Colony Metro', 'Nal Stop Metro',
    'Garware College Metro', 'Deccan Gymkhana Metro',
  ],
}
const STATION_INDEX = Object.entries(STATIONS).flatMap(([city, names]) => names.map(name => ({ name, city, type: 'TRAIN STATION' })))

// Typed index for the detailed search suggestions
const LOCATION_INDEX = [
  ...MAHARASHTRA_CITIES.map(name => ({ name, city: 'Maharashtra', type: 'CITY' })),
  ...Object.entries(LOCATION_GROUPS).flatMap(([city, locs]) => locs.map(name => ({ name, city, type: 'LOCALITY' }))),
  // Micro-locality pockets (Kandarpada, Gawamin, ...) — shown tagged with
  // their parent suburb so picking one is unambiguous about what it resolves to.
  ...Object.values(MICRO_ALIASES).map(a => ({ name: a.canonical, city: a.parent, type: 'LOCALITY' })),
  ...STATION_INDEX,
]

// 99acres-style categorised suggestions for the search bar: localities and
// cities complete the query; project rows jump straight to analysis.
// Ranking (exact > starts-with > contains) rather than a flat startsWith
// split — "Goregaon" typing "gore" should out-rank a longer name that
// merely contains "gore" somewhere in the middle.
function locationMatchRank(name, q) {
  const n = name.toLowerCase()
  if (n === q) return 0
  if (n.startsWith(q)) return 1
  return 2
}
function buildSearchSuggestions(token, projects, limit = 8) {
  const q = token.toLowerCase()
  const locs = LOCATION_INDEX
    .filter(l => l.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ra = locationMatchRank(a.name, q), rb = locationMatchRank(b.name, q)
      return ra !== rb ? ra - rb : a.name.length - b.name.length
    })
    .slice(0, limit)
  const projs = (projects || [])
    .filter(p => p.name.toLowerCase().includes(q) || (p.nearbyLocality || '').toLowerCase().includes(q))
    .slice(0, 4)
    .map(p => ({ name: p.name, city: [p.location, p.city].filter(Boolean).join(', ') || 'Maharashtra', type: 'PROJECT', project: p }))
  return [...locs, ...projs].slice(0, limit)
}

// Curated adjacency of Maharashtra localities — powers "predict what the user
// wants next": pick Malad, we suggest Goregaon/Kandivali/Borivali. Instant and
// free (no LLM tokens), so it works even when the AI quota is exhausted.
const NEARBY = {
  // Mumbai western
  'malad': ['Goregaon', 'Kandivali', 'Borivali', 'Jogeshwari'],
  'goregaon': ['Malad', 'Andheri', 'Jogeshwari', 'Ram Mandir'],
  'andheri': ['Jogeshwari', 'Vile Parle', 'Goregaon', 'Bandra', 'Powai'],
  'borivali': ['Kandivali', 'Dahisar', 'Malad'],
  'kandivali': ['Borivali', 'Malad', 'Goregaon'],
  'dahisar': ['Borivali', 'Mira-Bhayandar'],
  'bandra': ['Khar', 'Santacruz', 'Andheri', 'Worli'],
  'santacruz': ['Bandra', 'Vile Parle', 'Andheri'],
  'vile parle': ['Andheri', 'Santacruz', 'Juhu'],
  'juhu': ['Vile Parle', 'Andheri', 'Santacruz'],
  // Mumbai central / harbour
  'powai': ['Andheri', 'Vikhroli', 'Kanjurmarg', 'Ghatkopar'],
  'chembur': ['Ghatkopar', 'Kurla', 'Wadala'],
  'ghatkopar': ['Vikhroli', 'Kurla', 'Chembur', 'Powai'],
  'mulund': ['Bhandup', 'Thane', 'Vikhroli'],
  'bhandup': ['Mulund', 'Kanjurmarg', 'Vikhroli'],
  'wadala': ['Chembur', 'Dadar', 'Parel'],
  'parel': ['Wadala', 'Dadar', 'Lower Parel', 'Byculla'],
  'lower parel': ['Parel', 'Worli', 'Mahalaxmi'],
  'mahalaxmi': ['Worli', 'Lower Parel', 'Byculla'],
  // Thane
  'thane': ['Majiwada', 'Ghodbunder Road', 'Kolshet', 'Mulund', 'Kalwa'],
  'majiwada': ['Thane', 'Ghodbunder Road', 'Kolshet'],
  'ghodbunder road': ['Thane', 'Majiwada', 'Kolshet'],
  'kolshet': ['Thane', 'Majiwada', 'Ghodbunder Road'],
  // Navi Mumbai
  'kharghar': ['Belapur', 'Kamothe', 'Panvel', 'Taloja'],
  'vashi': ['Nerul', 'Sanpada', 'Turbhe', 'Kopar Khairane'],
  'nerul': ['Vashi', 'Belapur', 'Sanpada'],
  'belapur': ['Nerul', 'Kharghar', 'Panvel'],
  'panvel': ['Kharghar', 'Kamothe', 'Ulwe', 'Taloja'],
  'airoli': ['Ghansoli', 'Kopar Khairane', 'Rabale'],
  // Pune
  'hinjewadi': ['Wakad', 'Baner', 'Balewadi', 'Tathawade'],
  'wakad': ['Hinjewadi', 'Baner', 'Pimple Saudagar', 'Ravet'],
  'baner': ['Aundh', 'Balewadi', 'Wakad', 'Pashan'],
  'aundh': ['Baner', 'Pashan'],
  'kharadi': ['Wagholi', 'Viman Nagar', 'Hadapsar', 'Mundhwa'],
  'hadapsar': ['Kharadi', 'Mundhwa', 'Magarpatta', 'Undri'],
  'balewadi': ['Baner', 'Hinjewadi', 'Wakad'],
  'undri': ['Kondhwa', 'Hadapsar', 'Mundhwa'],
  'wagholi': ['Kharadi', 'Viman Nagar'],
  'viman nagar': ['Kharadi', 'Wagholi'],
  'pimpri': ['Chinchwad', 'Pimple Saudagar'],
  'chinchwad': ['Pimpri', 'Ravet', 'Tathawade'],
}
function nearbySuggestions(selected, alreadyOptions) {
  const sel = new Set(selected.map(s => s.toLowerCase()))
  const out = []
  const seen = new Set(sel)
  for (const s of selected) {
    for (const n of (NEARBY[s.toLowerCase()] || [])) {
      if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n) }
    }
  }
  return out.slice(0, 8)
}

// Free-text location box with predictive suggestions (case-insensitive):
// type "gore" -> Goregaon, Goregaon East, Goregaon West appear below; pick one
// or press Enter to add free text. Selected locations render as removable chips.
// Debounced hook: live-searches ALL of Maharashtra (localities, streets, metro/
// railway stations, landmarks, towns/villages) via /api/location-search
// (OpenStreetMap Nominatim server-side) once the query is 3+ chars. Merged
// with the static curated list for zero-latency short-query suggestions.
const PLACE_TYPE_LABELS = {
  sublocality: 'Locality', sublocality_level_1: 'Locality', neighborhood: 'Locality',
  locality: 'City', administrative_area_level_2: 'District', administrative_area_level_1: 'State',
  route: 'Street', premise: 'Building', point_of_interest: 'Landmark', establishment: 'Place',
  transit_station: 'Station', train_station: 'Railway Station', subway_station: 'Metro Station',
  shopping_mall: 'Mall', park: 'Landmark',
}
function usePlacesAutocomplete(q, market = 'india') {
  const [live, setLive] = useState([])
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    const query = q.trim()
    if (query.length < 3) { setLive([]); setSearching(false); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(() => {
      placesAutocomplete(query, market)
        .then(results => {
          if (cancelled) return
          setSearching(false)
          setLive(results.map(r => ({ ...r, type: PLACE_TYPE_LABELS[r.type] || 'Place' })))
        })
        .catch(() => { if (!cancelled) { setLive([]); setSearching(false) } })
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q, market])
  return [live, searching]
}

// Azure AI Search's suggester index (report Section 2.2 — resolves text to
// an entity from our OWN inventory, weighted by real listing count). Returns
// [] until AZURE_SEARCH_ENDPOINT/AZURE_SEARCH_ADMIN_KEY are set, in which
// case Filter Search and AI Search both merge this in ahead of Google Places —
// it's authoritative for anything we've actually scraped, Places is for
// everything else (malls, offices, landmarks not in our own dataset).
function useSuggesterAutocomplete(q) {
  const [results, setResults] = useState([])
  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) { setResults([]); return }
    let cancelled = false
    const t = setTimeout(() => {
      fetch(`${API}/api/search-suggest?q=${encodeURIComponent(query)}`)
        .then(r => r.json())
        .then(d => { if (!cancelled) setResults(d.configured ? (d.results || []) : []) })
        .catch(() => { if (!cancelled) setResults([]) })
    }, 200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])
  return results
}

// Same category label + row layout as major real-estate portals: name on the
// left, type (LOCALITY / PROJECT / TRAIN STATION / ...) right-aligned on the
// same row. Instant local index (curated localities/cities/stations + our own
// scraped projects) is the PRIMARY result — zero network latency, exactly like
// a portal's own database lookup. The live Maharashtra-wide OSM search is
// appended as a handful of extra rows underneath once it resolves, never
// blocking or delaying the instant local list.
function LocationCombobox({ options, selected, onChange, projects, onSubmit, onAfterAdd, minWidth = 230, maxWidth = 380, disabled = false, submitLabel, loading = false }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [submitHover, setSubmitHover] = useState(false)
  const ref = React.useRef(null)
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const selLower = new Set(selected.map(s => s.toLowerCase()))
  const [liveResults, liveSearching] = usePlacesAutocomplete(q)
  const suggesterResults = useSuggesterAutocomplete(q)

  const qTrim = q.trim()
  const instant = qTrim.length >= 2
    ? buildSearchSuggestions(qTrim, projects, 8).filter(r => !selLower.has(r.name.toLowerCase()))
    : []
  const instantKeys = new Set(instant.map(r => r.name.toLowerCase()))
  // Azure suggester — our own inventory, weighted by real listing count —
  // ranks ahead of Google Places since it's authoritative for anything we've
  // actually scraped (a real "andh" -> Andheri West (12,400 listings) lookup,
  // not a guess). No-ops (empty array) until Azure credentials are set.
  const suggested = suggesterResults
    .filter(r => !selLower.has(r.name.toLowerCase()) && !instantKeys.has(r.name.toLowerCase()))
    .slice(0, 4)
    .map(r => ({ name: r.name, city: r.area, type: r.type, count: r.count }))
  const suggestedKeys = new Set(suggested.map(r => r.name.toLowerCase()))
  const live = liveResults
    .filter(r => !selLower.has(r.name.toLowerCase()) && !instantKeys.has(r.name.toLowerCase()) && !suggestedKeys.has(r.name.toLowerCase()))
    .slice(0, 4)
    .map(r => ({ name: r.name, city: r.area, type: (r.type || 'PLACE').toUpperCase() }))
  const sugg = [...instant, ...suggested, ...live]

  const add = (loc) => {
    const v = (typeof loc === 'string' ? loc : loc?.name || '').trim()
    if (!v || selLower.has(v.toLowerCase())) return
    if (loc?.type === 'PROJECT' && loc.project) { onChange([...selected, v]) } // still usable as a location filter term
    onChange([...selected, v])
    setQ(''); setHi(0)
    onAfterAdd?.()
  }
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // AI Search mode: the box doubles as the NL query input, so Enter runs
      // a full search with whatever's typed rather than adding it as a
      // location chip (Property Search's onSubmit is left undefined, so its
      // add-as-chip behavior below is unchanged).
      if (onSubmit) { onSubmit(q); return }
      add(sugg.length ? sugg[Math.min(hi, sugg.length - 1)] : q)
    }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, sugg.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Backspace' && !q && selected.length) { onChange(selected.slice(0, -1)) }
    else if (e.key === 'Escape') setOpen(false)
  }
  const TYPE_COLOR = { PROJECT: '#2E9E4F', CITY: '#0E0E52' }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', padding: '6px 10px', border: '1px solid #E9E7E0', borderRadius: 8, background: '#fff', minWidth, maxWidth }}>
        {selected.map(loc => (
          <span key={loc} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#0E0E52', color: '#fff', borderRadius: 6, padding: '3px 8px', fontSize: 12, fontWeight: 600 }}>
            {loc}
            <span onClick={() => onChange(selected.filter(l => l !== loc))} style={{ cursor: 'pointer', opacity: 0.7 }}>✕</span>
          </span>
        ))}
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); setHi(0) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          disabled={disabled}
          placeholder={selected.length ? 'Add another…' : onSubmit ? 'Search by location, BHK, budget, possession…' : 'Type a location, street, station…'}
          style={{ flex: 1, minWidth: 110, border: 'none', outline: 'none', fontSize: 13, padding: '3px 2px', fontFamily: "'Plus Jakarta Sans',sans-serif" }}
        />
        {onSubmit && (
          <button
            onClick={() => onSubmit(q)}
            onMouseEnter={() => setSubmitHover(true)}
            onMouseLeave={() => setSubmitHover(false)}
            title="Search" aria-label="Search" disabled={disabled}
            style={submitLabel
              ? {
                  flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  background: disabled ? '#B9B8C9' : submitHover ? '#1A1A6E' : '#0E0E52',
                  color: '#fff', border: 'none', borderRadius: 6, padding: '0 16px', height: 30,
                  cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700,
                  fontFamily: "'Plus Jakarta Sans',sans-serif", transition: 'background-color 0.12s ease',
                }
              : {
                  flexShrink: 0, background: disabled ? '#B9B8C9' : submitHover ? '#1A1A6E' : '#0E0E52',
                  color: '#fff', border: 'none', borderRadius: 6, width: 28, height: 28,
                  cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', transition: 'background-color 0.12s ease',
                }}>
            {loading
              ? <Loader2 size={submitLabel ? 14 : 15} style={{ animation: 'spin 0.8s linear infinite' }} />
              : <Search size={submitLabel ? 14 : 15} />}
            {submitLabel && <span>{loading ? 'Searching…' : submitLabel}</span>}
          </button>
        )}
      </div>
      {open && qTrim.length >= 2 && sugg.length > 0 && (
        <div style={{ position: 'absolute', top: '105%', left: 0, zIndex: 50, width: '100%', minWidth: 320, background: '#fff', border: '1px solid #E9E7E0', borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.14)', padding: 4, maxHeight: 340, overflowY: 'auto' }}>
          {sugg.map((r, i) => (
            <div key={r.name + i} onMouseDown={() => add(r)} onMouseEnter={() => setHi(i)}
              style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '9px 10px', borderRadius: 6, cursor: 'pointer', background: i === hi ? '#F0F1FA' : 'transparent' }}>
              <div style={{ fontSize: 13.5, color: '#1B1B3A', minWidth: 0 }}>
                {r.name}{r.city && r.city !== 'Maharashtra' ? <span style={{ color: '#8A8896' }}>, {r.city}</span> : ''}
              </div>
              <div style={{ fontSize: 10.5, color: TYPE_COLOR[r.type] || '#9B99A6', fontWeight: 700, letterSpacing: '0.03em', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {r.type}{typeof r.count === 'number' ? <span style={{ color: '#8A8896', fontWeight: 600 }}> ({r.count})</span> : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Lightweight markdown renderer for the Claude analyst response ─────────────
// Supports: #/##/### headings, **bold**, tables, bullet & numbered lists,
// [n] citation badges, paragraphs. No external dependency.
function mdInline(text, keyBase) {
  const parts = []
  let rest = String(text), k = 0
  const re = /\*\*(.+?)\*\*|\[(\d+)\]/g
  let last = 0, m
  while ((m = re.exec(rest)) !== null) {
    if (m.index > last) parts.push(<span key={`${keyBase}-${k++}`}>{rest.slice(last, m.index)}</span>)
    if (m[1] !== undefined) parts.push(<b key={`${keyBase}-${k++}`} style={{ color: '#1B1B3A' }}>{m[1]}</b>)
    else parts.push(<sup key={`${keyBase}-${k++}`} style={{ background: '#EEF0FF', color: '#0E0E52', borderRadius: 4, padding: '0 4px', fontSize: 10, fontWeight: 700, marginLeft: 1 }}>{m[2]}</sup>)
    last = m.index + m[0].length
  }
  if (last < rest.length) parts.push(<span key={`${keyBase}-${k++}`}>{rest.slice(last)}</span>)
  return parts
}

function Markdown({ text }) {
  const lines = String(text || '').split('\n')
  const out = []
  let i = 0, key = 0
  while (i < lines.length) {
    const line = lines[i]
    // table: header row + separator row
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
      const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const header = parseRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++ }
      out.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '10px 0 16px' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
            <thead><tr>{header.map((h, j) => (
              <th key={j} style={{ background: '#0E0E52', color: '#fff', padding: '8px 10px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
            ))}</tr></thead>
            <tbody>{rows.map((r, ri) => (
              <tr key={ri} style={{ background: ri % 2 ? '#FBFAF7' : '#fff' }}>
                {r.map((c, ci) => <td key={ci} style={{ border: '1px solid #E9E7E0', padding: '7px 10px', color: '#1B1B3A' }}>{mdInline(c, `t${key}-${ri}-${ci}`)}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )
      continue
    }
    // headings
    const hm = line.match(/^(#{1,3})\s+(.*)/)
    if (hm) {
      const lvl = hm[1].length
      out.push(<div key={key++} style={{ fontWeight: 800, color: '#0E0E52', fontSize: lvl === 1 ? 19 : lvl === 2 ? 16 : 14, margin: '18px 0 8px' }}>{mdInline(hm[2].replace(/\*\*/g, ''), `h${key}`)}</div>)
      i++; continue
    }
    // bullet / numbered list block
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++ }
      out.push(
        <ul key={key++} style={{ margin: '4px 0 12px', paddingLeft: 22 }}>
          {items.map((it, j) => <li key={j} style={{ fontSize: 13.5, color: '#3A3A50', lineHeight: 1.65, marginBottom: 3 }}>{mdInline(it, `li${key}-${j}`)}</li>)}
        </ul>
      )
      continue
    }
    // blank
    if (!line.trim()) { i++; continue }
    // paragraph (merge consecutive non-empty, non-special lines)
    const para = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s|^\s*([-*]|\d+\.)\s|^\s*\|/.test(lines[i])) { para.push(lines[i]); i++ }
    out.push(<p key={key++} style={{ fontSize: 13.5, color: '#3A3A50', lineHeight: 1.7, margin: '0 0 12px' }}>{mdInline(para.join(' '), `p${key}`)}</p>)
  }
  return <div>{out}</div>
}

// ── Canonical candidate identity (Part P1.2) ────────────────────────────────
// Mirrors the SAME priority order the backend now uses on both pipelines
// (agent/dedupe.py's dedup key; external-search.cjs's buildCanonicalCandidateId):
// RERA (authoritative) -> normalized name+location -> source URL. This is
// only ever a FALLBACK — both backend paths now always send a real `id`
// (see external-search.cjs / curator.py), so this mostly guards against an
// older cached response or a manually-constructed test object.
// Portal titles for the SAME project routinely differ only by which page of
// that portal they came from (a price page, an FAQ page, a brochure page) —
// mirrors backend/external-search.cjs's coreNameKey / agent/dedupe.py's
// _core_name_key exactly, same fixed word list, same reasoning (see either
// for the full writeup). Only used to build the identity KEY, never touches
// the name actually shown to the user.
const PORTAL_NOISE_RE = /\bprice(\s*sheet|\s*list)?\b|\bphotos?\b|\bfloor\s*plans?\b|\bfaqs?\b|\bbrochure\b|\bpros\s*(&|and)?\s*cons\b|\breviews?\b|\boverview\b|\bgallery\b|\bamenities\b|\bvideo\s*tour\b|\bmap\b/gi

// Deterministic (Part 8: never Math.random() — same input must always
// produce the same id, never a fresh random string per render/request).
// A tiny DJB2-family string hash is all a browser-safe last-resort id needs
// here; this path only runs for a candidate with no rera/name+location/url
// at all, so there's nothing real to distinguish it by regardless.
function stableHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function buildCanonicalCandidateId(p) {
  if (p.rera) return `rera:${String(p.rera).toUpperCase()}`
  // Each field sanitized independently before joining — see
  // backend/external-search.cjs's buildCanonicalCandidateId for the full
  // writeup of why (a literal colon surviving from the ORIGINAL title text,
  // not just the "::" separator, used to leak into the key and split two
  // variants of the same project into different ids).
  const sanitize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const nameKey = sanitize((p.name || '').replace(PORTAL_NOISE_RE, ''))
  const locKey = sanitize(p.location || p.city || '')
  const key = `${nameKey}::${locKey}`
  if (nameKey || locKey) return `nameloc:${key}`
  const url = p.sourceUrl || p.sources?.[0]?.url
  if (url) return `url:${btoa(unescape(encodeURIComponent(url))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)}`
  return `anon:${stableHash(`${p.name || ''}|${p.location || p.city || ''}|${url || ''}`)}`
}

// A short, deterministic 5-10-line-worthy summary built ONLY from fields
// already on this exact candidate (Part P1.8) — used ONLY when the
// candidate has no real scraped description text at all; when it does,
// that real text is preferred (same "own data first" rule curator.py's
// _project_intelligence_payload already follows: summary = description or
// nothing, never an LLM paraphrase of it).
function buildConciseSummary(p) {
  const bits = []
  const loc = [p.location, p.city].filter(Boolean).join(', ')
  let opening = `${p.name || 'This project'} is a residential development`
  if (loc) opening += ` in ${loc}`
  if (p.developer) opening += ` by ${p.developer}`
  bits.push(opening + '.')
  if (p.config) bits.push(`It offers ${p.config} configurations.`)
  if (p.propertyType) bits.push(`Property type: ${p.propertyType}.`)
  if (p.amenities?.length) bits.push(`Notable amenities include ${p.amenities.slice(0, 4).join(', ')}.`)
  if (p.connectivity) bits.push(`Connectivity: ${p.connectivity}.`)
  if (p.possession && p.possession !== 'TBD') bits.push(`Possession: ${p.possession}.`)
  if (p.reraCode) bits.push(`RERA registered (${p.reraCode}).`)
  if (bits.length === 1) bits.push('No further verified details are available for this listing from the sources researched so far.')
  return bits.join(' ')
}

// ── Client-side project_intelligence synthesis (Part P1.4) ─────────────────
// The agent (LangGraph) path already returns a real, server-built
// project_intelligence payload (curator.py's _project_intelligence_payload)
// — used as-is when present. The LEGACY external-search.cjs path never
// built one, which is EXACTLY what used to send Project Intelligence down
// the generic /api/ai-research fallback (a fresh Claude-driven search by
// bare name+builder+city, discarding every field already known and able to
// return an unrelated project's data). This builds the SAME shape directly
// from the candidate's own already-known fields — no re-search, no risk of
// resolving a different project, honest "Not verified" for anything this
// candidate's evidence never established.
function buildIntelFromCandidate(p) {
  const configs = (p.config ? p.config.split(/&|,/).map(s => s.trim()).filter(Boolean) : [])
  const configEvidence = p.configuration_evidence || {}
  const singleConfig = configs.length === 1
  const configRows = configs.map(c => {
    const bucket = configEvidence[c] || Object.entries(configEvidence).find(([k]) => k.toLowerCase() === c.toLowerCase())?.[1] || {}
    const carpet = bucket.carpet_area || (singleConfig ? p.carpetArea : null) || null
    const price = bucket.price || (singleConfig ? p.budgetLabel : null) || null
    return { type: c, carpet, total: null, available: null, price }
  })
  const reraEntries = p.field_evidence?.rera || []
  const reraValues = [...new Set(reraEntries.map(e => String(e.value)).filter(Boolean))]
  const reraConflict = reraValues.length > 1
  const sourceUrls = (p.sources || []).map(s => s.url).filter(Boolean)
  const usps = []
  if (p.reraCode) usps.push(`RERA registered (${p.reraCode})`)
  if (new Set((p.sources || []).map(s => s.name).filter(Boolean)).size >= 2) usps.push('Corroborated across multiple independent sources')
  for (const a of (p.amenities || []).slice(0, 3)) usps.push(a.charAt(0).toUpperCase() + a.slice(1))

  return {
    official: null,
    rera: p.reraCode || null, rera_confidence: p.reraCode ? 0.6 : 0,
    rera_conflict: reraConflict, rera_conflicting_values: reraConflict ? reraValues : [],
    configs: configRows, configuration_evidence: configEvidence,
    amenities: p.amenities || [], features: p.featureEvidence || [],
    usps, usp_evidence: usps.map(insight => ({ insight, reason: 'Derived from this candidate\'s own researched evidence', sources: sourceUrls.slice(0, 2) })),
    competitors: [],
    summary: p.description || buildConciseSummary(p),
    possession: p.possession && p.possession !== 'TBD' ? p.possession : null,
    _provider: 'ai-search-frontend',
    _note: 'Populated directly from the selected AI Search candidate\'s own evidence — no separate re-search performed.',
    _webSources: sourceUrls,
    fetchedAt: new Date().toISOString(),
  }
}

// Turn an AI-discovered property into a project object Project Intelligence
// understands. _autoResearch is now ONLY a marker of provenance ("this came
// from AI Search"), NOT a trigger for a fresh generic search — _agentIntel
// below is ALWAYS populated (from the agent's own research, or synthesized
// client-side from this candidate's own fields), so ProjectIntelligence.jsx
// never needs to fall back to /api/ai-research for an AI-Search-sourced
// candidate (Part P1.4's priority order).
function toAnalysableProject(p, i) {
  const id = p.id || buildCanonicalCandidateId(p)
  const out = {
    id,
    name: p.name,
    builder: p.developer || '',
    city: p.city || '',
    location: p.location || '',
    config: p.config || '',
    budgetLabel: p.price ? `₹${String(p.price).replace(/^₹/, '')}` : 'Price on request',
    possession: p.possession || 'TBD',
    reraCode: p.rera || null,
    rera: !!p.rera,
    sold: null, units: null, rank: p.match_tier || 'PRIMARY', score: p.match_score || 0, match: p.match_score || 0,
    // Real AI Search match (scoring.cjs's scoreExternalProject, already
    // computed for this result) — genuinely distinct from "IndiHomes Score"
    // here since external listings have no IndiHomes-catalog score at all.
    matchScore: p.match_score ?? null,
    matchWhy: p.matchReason || p.why || null,
    listingUrl: p.sourceUrl || p.sources?.[0]?.url || null,
    // External result — no IndiHomes project code. `market` carries through
    // so Project Intelligence knows to show DLD (not MahaRERA) for Dubai.
    code: null, market: p.market || 'india',
    // Richer facts from external-search.cjs's normalization (Part 10) —
    // additive, carried through so Project Intelligence can show them for
    // an external listing same as it would an official one. Never
    // fabricated on this side — whatever wasn't extracted server-side
    // stays null/[] here too.
    amenities: p.amenities || [], carpetArea: p.carpetArea || null, builtUpArea: p.builtUpArea || null,
    totalFloors: p.totalFloors || null, connectivity: p.connectivity || null,
    propertyType: p.propertyType || null, description: p.description || null,
    dataQuality: p.dataQuality || null, sources: p.sources || [],
    // ── Part P1.3 — the rest of the canonical candidate shape, additive.
    title: p.title || p.name, projectName: p.projectName || p.name, display_name: p.display_name || null,
    match_score: p.match_score ?? null, match_tier: p.match_tier || null,
    match_reasons: p.match_reasons || p.matchReasons || [], limitations: p.limitations || [],
    deck: p.deck || null,
    evidence: p.evidence || [], field_evidence: p.field_evidence || {},
    configuration_evidence: p.configuration_evidence || {}, featureEvidence: p.featureEvidence || [],
    sourceType: p.sourceType || (p.code ? 'indihomes' : 'external'),
    _autoResearch: true,
  }
  // Priority order (Part P1.4): (1) this exact candidate object — always,
  // it's what `out` already is; (2) the agent's own already-researched
  // project_intelligence when present; (3) synthesized directly from this
  // candidate's own known fields, never a fresh generic search. Step 4
  // (generic discovery fallback) is intentionally never reached for an
  // AI-Search-sourced candidate — ProjectIntelligence.jsx's effect no
  // longer calls runResearch() when _agentIntel is set, and this line
  // guarantees it always is.
  out._agentIntel = p.project_intelligence || buildIntelFromCandidate(out)
  return out
}

// ── Campaign Brief (deterministic, no Claude/LLM) ──────────────────────────
// Rule-based recommended angle per project — derived purely from fields
// already on the project object (possession, RERA, budget, config), so this
// works identically whether AI Search or the Claude key is configured.
function campaignAngle(p) {
  const possession = String(p.possession || '').toLowerCase()
  const budgetLabel = String(p.budgetLabel || p.price || '').toLowerCase()
  const config = String(p.config || '').toLowerCase()
  const angles = []
  if (/ready|immediate|possession given|delivered/.test(possession)) angles.push('Ready-to-move urgency')
  else if (/20(2[5-9]|3\d)/.test(possession)) angles.push('Book-now-before-price-escalation')
  if (p.reraCode || p.rera) angles.push('RERA-verified trust & compliance')
  const crMatch = budgetLabel.match(/(\d+(\.\d+)?)\s*cr/)
  if (crMatch && parseFloat(crMatch[1]) >= 1.5) angles.push('Premium / luxury positioning')
  else if (/\d+\s*l(akh)?/.test(budgetLabel) || (crMatch && parseFloat(crMatch[1]) < 1)) angles.push('Affordability & EMI-friendly entry price')
  if (/1\s*bhk|2\s*bhk/.test(config)) angles.push('First-time homebuyer / young professional targeting')
  if (/3\s*bhk|4\s*bhk|5\s*bhk/.test(config)) angles.push('Family upgrade / spacious-living targeting')
  if (!angles.length) angles.push('Location & value positioning')
  return angles.join(' + ')
}

function matchReasonOf(p) {
  if (Array.isArray(p.matchReasons) && p.matchReasons.length) return p.matchReasons.join('; ')
  if (p.why) return p.why
  if (p.aiMatch?.why) return p.aiMatch.why
  return 'Matches the current selection criteria.'
}

function sourceLabelOf(p) {
  if (Array.isArray(p.sources) && p.sources.length) {
    return p.sources.map(s => typeof s === 'string' ? s : (s.name || s.url || '')).filter(Boolean).join(', ')
  }
  return p.sourceLabel || p.adSrc || p.sourceName || 'IndiHomes Website'
}

function reraStatusOf(p) {
  if (p.reraCode) return `RERA ${p.reraCode}`
  if (p.rera) return 'RERA verified (number on file)'
  return 'Not found / needs verification'
}

// Deterministic Markdown brief — every field pulled straight off the project
// objects already on screen (Filter Search cards or AI Search results), no
// AI call involved. Downloadable as .md so it can be dropped straight into
// a campaign doc/ticket.
function buildCampaignBriefMarkdown(projects) {
  const lines = []
  lines.push('# Campaign Brief')
  lines.push('')
  lines.push(`_Generated ${new Date().toLocaleString('en-IN')} · ${projects.length} project${projects.length === 1 ? '' : 's'} shortlisted · deterministic, no AI/LLM used_`)
  lines.push('')
  projects.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.name || 'Untitled project'}`)
    lines.push('')
    lines.push(`- **Location:** ${[p.location, p.city].filter(Boolean).join(', ') || '—'}`)
    lines.push(`- **Configuration:** ${p.config || '—'}`)
    lines.push(`- **Budget:** ${p.budgetLabel || p.price || '—'}`)
    lines.push(`- **Possession:** ${p.possession || '—'}`)
    lines.push(`- **Score:** ${p.score ?? p.match_score ?? '—'}${p.score != null ? '/100' : ''}`)
    lines.push(`- **Match reason:** ${matchReasonOf(p)}`)
    lines.push(`- **RERA status:** ${reraStatusOf(p)}`)
    lines.push(`- **Source:** ${sourceLabelOf(p)}`)
    lines.push(`- **Recommended campaign angle:** ${campaignAngle(p)}`)
    lines.push('')
  })
  lines.push('---')
  lines.push('_All figures above are taken directly from project data already shown on screen; the campaign angle is rule-based, not AI-generated._')
  return lines.join('\n')
}

function downloadTextFile(filename, content, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Rank labels by POSITION — the fallback used only for the legacy (pre-agent)
// external-search path, which never set match_tier (its badges were
// positional: first result PRIMARY, second SECONDARY, ...). The agent path
// below always sets a real match_tier (scoring.py's PRIMARY/SECONDARY/
// TERTIARY, derived from the actual score, never array position) and that
// takes priority whenever present.
const RANK_BY_POSITION = [
  { label: 'PRIMARY', color: '#2E9E4F' },
  { label: 'SECONDARY', color: '#F7941D' },
  { label: 'TERTIARY', color: '#8B8BD6' },
]
const rankOf = (i) => RANK_BY_POSITION[i] || { label: `${i + 1}TH MATCH`, color: '#8B8BD6' }
const TIER_COLOR = { PRIMARY: '#2E9E4F', SECONDARY: '#F7941D', TERTIARY: '#8B8BD6' }

// One key-fact chip — icon + value, or nothing at all when the value isn't
// available (never a fabricated placeholder; Part 19's "must work when
// fields are null/undefined" rule). Shared by the "key facts" and
// "secondary facts" rows below so both read as one consistent visual
// language instead of two different chip styles.
// Human-readable labels for the deterministic lifecycle enum the backend
// already hard-filters to eligible stages before a candidate ever reaches
// the frontend (agent/agent/normalize.py's classify_lifecycle_status /
// backend/scoring.cjs's classifyLifecycleStatus). READY_TO_MOVE/RESALE/
// RENTAL/UNKNOWN are deliberately absent — a candidate carrying one of
// those never reaches this component at all.
const LIFECYCLE_LABEL = {
  UNDER_CONSTRUCTION: 'Under Construction',
  NEAR_POSSESSION: 'Near Possession',
  NEW_LAUNCH: 'New Launch',
}

function FactChip({ icon: Icon, value, title }) {
  if (!value) return null
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: '#1B1B3A', background: '#F6F5F1', borderRadius: 6, padding: '4px 9px' }}>
      {Icon && <Icon size={12} strokeWidth={2.2} color="#75737F" />}
      {value}
    </span>
  )
}

// One researched property — richer than a bare search-result snippet
// (Part 6/12): a primary identity row (rank, thumbnail, name, tier, source,
// match %), a key-facts row (config/area/price/location — the four things
// a salesperson scans first), a secondary-facts row that only renders the
// facts this particular listing actually has (developer/RERA/possession/
// floors/connectivity/property type — never a placeholder for a missing
// one), an amenities strip, and the real match-reasoning line
// (p.matchReason/why, from scoring.cjs — never invented client-side).
// `key_match`/`limitations`/`sources` still carry through to Project
// Intelligence via toAnalysableProject below.
function PropertyCard({ p, i, onAnalyse }) {
  const tierLabel = p.match_tier || rankOf(i).label
  const color = TIER_COLOR[tierLabel] || rankOf(i).color
  const imgUrl = projectImageUrl({ builder: p.developer, name: p.name, id: p.id })
  const amenities = Array.isArray(p.amenities) ? p.amenities : []
  const shownAmenities = amenities.slice(0, 5)
  const matchReason = p.matchReason || p.why || null

  return (
    <div style={{ background: '#fff', border: '1px solid #E9E7E0', borderLeft: `4px solid ${color}`, borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#E9E7E0', minWidth: 32, paddingTop: 2, fontFamily: "'IBM Plex Mono',monospace" }}>#{i + 1}</div>
      <div style={{ width: 80, height: 60, borderRadius: 8, flexShrink: 0, overflow: 'hidden', background: '#E9E7E0' }}>
        <img
          src={imgUrl}
          alt={p.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={e => {
            e.currentTarget.style.display = 'none'
            e.currentTarget.parentElement.style.background = 'repeating-linear-gradient(45deg,#E9E7E0,#E9E7E0 4px,#F6F5F1 4px,#F6F5F1 8px)'
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Primary row — identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#1B1B3A' }}>{p.name}</span>
          <span style={{ background: color, color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, fontFamily: "'IBM Plex Mono',monospace" }}>{tierLabel}</span>
          {/* Deterministic lifecycle classification (Part 2/20) — every
              candidate that reaches this card has already passed the hard
              eligibility filter (backend, never the LLM), so this is
              purely informational: which eligible stage it's at. Never
              rendered for RESALE/RENTAL/UNKNOWN — those are rejected
              before they ever reach this component. */}
          {p.lifecycleStatus && LIFECYCLE_LABEL[p.lifecycleStatus] && (
            <span title={p.lifecycleEvidence || undefined}
              style={{ background: '#EEF6FF', color: '#0E5FA8', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.02em' }}>
              {LIFECYCLE_LABEL[p.lifecycleStatus]}
            </span>
          )}
          {/* Extracted from the listing's own text (see external-search.cjs's
              extractReraFromText) — real, but not cross-checked against
              MahaRERA/DLD the way an IndiHomes-catalog project's RERA is
              (p.rera_verified stays null for every external result). Shown
              as "unverified" kind, not "verified", so the badge itself never
              overclaims what this app hasn't actually confirmed. */}
          {p.rera && <FieldBadge kind="unverified" compact label={`RERA ${p.rera} (unverified)`} />}
          {/* Source/verification (Part 10) — the real connector/portal this
              candidate was actually retrieved from (p.sourceName, e.g.
              "99acres" or "99acres + MagicBricks" once mergeDuplicateProperties
              has combined multiple sources) — never fabricated, never a
              generic "Verified" claim beyond what's true (this is provenance,
              not a correctness guarantee). Links to the real source page when
              one exists. */}
          {p.sourceName && (
            p.sourceUrl ? (
              <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" title="View original source"
                style={{ fontSize:10.5, color:'#75737F', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:3, whiteSpace:'nowrap' }}>
                <ExternalLink size={10} strokeWidth={2.2} /> {p.sourceName}
              </a>
            ) : (
              <span style={{ fontSize:10.5, color:'#75737F', whiteSpace:'nowrap' }}>Source: {p.sourceName}</span>
            )
          )}
        </div>

        {/* Key facts — configuration / area / price / location, the four
            things scanned first. Falls back to nothing rendered for a
            missing one rather than an empty chip. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: shownAmenities.length || matchReason ? 6 : 8 }}>
          <FactChip icon={Bed} value={p.config} title="Configuration" />
          <FactChip icon={ClipboardList} value={p.carpetArea ? `${p.carpetArea} carpet` : p.builtUpArea ? `${p.builtUpArea} built-up` : null} title="Area" />
          <FactChip icon={IndianRupee} value={p.price ? `₹${String(p.price).replace(/^₹/, '')}` : null} title="Price" />
          <FactChip icon={MapPin} value={p.location} title="Location" />
        </div>

        {/* Secondary facts — only the ones this listing actually has. */}
        {(p.developer || p.possession || p.totalFloors || p.connectivity || p.propertyType) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: shownAmenities.length || matchReason ? 6 : 8 }}>
            <FactChip icon={Hammer} value={p.developer} title="Developer" />
            <FactChip icon={Calendar} value={p.possession} title="Possession" />
            <FactChip value={p.totalFloors} title="Floors / towers" />
            <FactChip value={p.connectivity} title="Connectivity" />
            <FactChip value={p.propertyType} title="Property type" />
          </div>
        )}

        {/* Amenities strip */}
        {shownAmenities.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: matchReason ? 6 : 8 }}>
            {shownAmenities.map((a, ai) => (
              <span key={ai} style={{ fontSize: 11, color: '#4A4A63', background: '#F1EDFB', borderRadius: 12, padding: '2px 9px' }}>{a}</span>
            ))}
            {amenities.length > shownAmenities.length && (
              <span style={{ fontSize: 11, color: '#8A8896' }}>+{amenities.length - shownAmenities.length} more</span>
            )}
          </div>
        )}

        {/* Real match reasoning (scoring.cjs's reasons[]) — "why" this
            result scored the way it did, not a restated match %. */}
        {matchReason && (
          <div style={{ fontSize: 11.5, color: '#75737F', marginBottom: 8 }}>
            <span style={{ fontWeight: 700, color: '#8A8896' }}>Matches: </span>{matchReason}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => onAnalyse && onAnalyse([toAnalysableProject(p, i)])}
            style={{ padding: '7px 16px', background: '#0E0E52', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
            Open Project Intelligence →
          </button>
        </div>
      </div>
      <div style={{ textAlign: 'center', minWidth: 64 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: "'IBM Plex Mono',monospace" }}>{p.match_score ?? '—'}</div>
        <div style={{ fontSize: 10, color: '#8A8896', textTransform: 'uppercase', letterSpacing: '0.05em' }}>MATCH %</div>
      </div>
    </div>
  )
}

// AI results as a ranked project card list — the same card language as
// Filter Search (#N, rank badge, RERA badge, match % column). When the
// AI Search Agent (LangGraph) produced this result, an optional research
// summary line appears above the cards.
function RankedResults({ result, onAnalyse }) {
  const props = result.properties || []
  // Part 24 — a genuinely empty, ELIGIBLE result set (every retrieved
  // candidate was resale/rental/a category page/unknown-lifecycle, so the
  // hard eligibility filter correctly rejected all of them) must say so
  // explicitly, never render as a silent blank area — that reads as broken,
  // not as "the search correctly found nothing eligible." Previously this
  // returned null before ever reaching the summary/empty-state below, which
  // swallowed curator.py's own "No verified properties matched..." message
  // along with it.
  if (!props.length) {
    return (
      <div style={{ marginBottom: 20, textAlign: 'center', padding: '28px 20px', background: '#F9F8F6', border: '1px solid #EEEBE3', borderRadius: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1B1B3A', marginBottom: 6 }}>No eligible new residential projects found.</div>
        <div style={{ fontSize: 12.5, color: '#75737F', lineHeight: 1.6 }}>
          {result.summary || 'Every result the search retrieved for this query was resale, a rental listing, a portal category page, or had an undetermined project stage — none of these are shown as new-project alternatives.'}
        </div>
        <div style={{ fontSize: 12, color: '#8A8896', marginTop: 10 }}>Try a nearby locality, a different configuration, or a wider budget.</div>
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 20 }}>
      {result.summary && (
        <div style={{ fontSize: 13, color: '#4A4A63', lineHeight: 1.6, marginBottom: 14, padding: '10px 14px', background: '#F9F8F6', borderRadius: 8, border: '1px solid #EEEBE3' }}>
          <span style={{ fontWeight: 700, color: '#0E0E52' }}>Research summary: </span>{result.summary}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {props.map((p, i) => <PropertyCard key={p.id || i} p={p} i={i} onAnalyse={onAnalyse} />)}
      </div>
    </div>
  )
}

function AnalystReport({ result, onAnalyse, onResultChange }) {
  const [moreLoading, setMoreLoading] = useState(false)
  const [moreErr, setMoreErr] = useState(null)

  const loadMore = () => {
    if (moreLoading || !result.reportId) return
    setMoreLoading(true); setMoreErr(null)
    const excludeNames = (result.properties || []).map(p => p.name).filter(Boolean)
    fetch(`${API}/api/ai-search-more`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId: result.reportId, excludeNames }),
    })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || 'Could not load more projects.')
        const existingNames = new Set(excludeNames.map(n => n.toLowerCase()))
        const fresh = (j.properties || []).filter(p => !existingNames.has(String(p.name || '').toLowerCase()))
        onResultChange?.({
          ...result,
          properties: [...(result.properties || []), ...fresh],
          sources: j.sources?.length ? j.sources : result.sources,
        })
        if (j.warning) setMoreErr(j.warning)
        else if (!fresh.length) setMoreErr('No additional projects found.')
      })
      .catch(e => setMoreErr(e.message))
      .finally(() => setMoreLoading(false))
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#EEF0FF', border: '1px solid #C8CCF0', borderRadius: 8, padding: '9px 14px', marginBottom: 14, fontSize: 12, color: '#0E0E52', fontWeight: 600 }}>
        <SlidersHorizontal size={14} style={{ flexShrink: 0 }} />
        <span>AI Search — external market listings ({result.market === 'dubai' ? 'Dubai / UAE' : 'India'}). Not IndiHomes' own inventory — see Property Search for official IndiHomes projects.</span>
      </div>
      <FilterChips filters={result.filters || {}} />
      {result.warning && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#FEF3E4', border: '1px solid #F7941D40', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: '#9A5B00' }}>
          <TriangleAlert size={14} style={{ flexShrink: 0 }} />
          <span>{result.warning}</span>
        </div>
      )}
      <RankedResults result={result} onAnalyse={onAnalyse} />
      {result.properties?.length > 0 && (
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <button onClick={loadMore} disabled={moreLoading}
            style={{ padding: '10px 24px', background: '#F6F5F1', color: '#0E0E52', border: '1px solid #E9E7E0', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: moreLoading ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {moreLoading
              ? <><Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> Finding more projects…</>
              : <><ArrowDown size={14} /> Load more projects</>}
          </button>
          {moreErr && <div style={{ marginTop: 8, fontSize: 12, color: '#D64545' }}>{moreErr}</div>}
        </div>
      )}
    </div>
  )
}

function FilterChips({ filters }) {
  const chips = []
  // AI Search's query parser (query-parser.cjs) returns `locations` (array) +
  // `budgetMax`/`currency`; the legacy shape (`location`/`budget` string) is
  // still checked so this keeps working if either shape is ever passed in.
  const locs = filters.locations?.length ? filters.locations : filters.location
  if (locs?.length) chips.push({ icon: MapPin, text: locs.join(', ') })
  if (filters.configuration) chips.push({ icon: Bed, text: filters.configuration })
  if (filters.budgetMax) {
    const label = filters.currency === 'AED' ? `AED ${filters.budgetMax.toLocaleString()}` : `₹${filters.budgetMax.toLocaleString('en-IN')}`
    chips.push({ icon: IndianRupee, text: `Under ${label}` })
  } else if (filters.budget) chips.push({ icon: IndianRupee, text: filters.budget })
  if (filters.possession) chips.push({ icon: Calendar, text: filters.possession })
  if (filters.builder) chips.push({ icon: Hammer, text: filters.builder })
  if (filters.requirements) chips.push({ icon: Sparkles, text: filters.requirements })
  if (!chips.length) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
      <span style={{ fontSize: 12, color: '#75737F', fontWeight: 600, alignSelf: 'center' }}>Search understood:</span>
      {chips.map((c, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#0E0E52', color: '#fff', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
          <c.icon size={12} />{c.text}
        </span>
      ))}
    </div>
  )
}


// Staged "researching" copy (Part 19) — names the graph's real phases
// (query_understanding -> search fan-out -> normalizer/dedup/verifier ->
// scorer, see ai-search-agent/agent/graph.py) without exposing any actual
// chain-of-thought or internal reasoning. The request is a single
// request/response, not a stream, so this is a client-side timer advancing
// through the same stages the backend is genuinely working through — not a
// live progress feed, but not fabricated either.
const RESEARCH_STAGES = [
  'Understanding your requirements',
  'Searching property listings',
  'Comparing available properties',
  'Verifying property details',
  'Ranking matching properties',
]

const AI_EXAMPLES = [
  'I need a 2 BHK in Goregaon or Malad under 1.75 Cr with possession before 2027',
  '3 BHK by Lodha or Godrej in Thane, ready to move, good amenities',
  'Budget 1 Cr, near a metro station in Mumbai, family-friendly',
]

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function filterSummary(f) {
  if (!f) return '—'
  const parts = []
  if (f.locations?.length) parts.push(f.locations.join(', '))
  if (f.budget && f.budget !== 'All') parts.push(f.budget)
  if (f.configs?.length) parts.push(f.configs.join(', '))
  if (f.possession && f.possession !== 'All') parts.push(f.possession)
  return parts.length ? parts.join(' · ') : 'No filters'
}

// Every search anyone runs (AI Search bar or Filter Search), persisted
// server-side — survives page reloads and is shared across everyone using
// the app, not scoped to one browser tab.
function SearchHistoryPanel({ onClose }) {
  const [history, setHistory] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    fetch(`${API}/api/search-history?limit=200`)
      .then(r => r.json())
      .then(j => setHistory(j.history || []))
      .catch(e => setErr(e.message))
  }, [])

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(14,14,40,0.45)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', width: 460, maxWidth: '100%', height: '100%', overflowY: 'auto', padding: '24px 26px', boxShadow: '-8px 0 32px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 800, color: '#1B1B3A' }}>
            <History size={18} /> Search History
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', display: 'flex', cursor: 'pointer', color: '#75737F' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: '#8A8896', marginBottom: 18 }}>
          Every AI Search and Property Search anyone has run — shared and persisted across sessions.
        </div>
        {err && <div style={{ color: '#D64545', fontSize: 13 }}>{err}</div>}
        {!history && !err && <div style={{ color: '#75737F', fontSize: 13 }}>Loading…</div>}
        {history && history.length === 0 && <div style={{ color: '#75737F', fontSize: 13 }}>No searches yet.</div>}
        {history && history.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {history.map(h => (
              <div key={h.id} style={{ background: '#F9F8F6', border: '1px solid #E9E7E0', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                    background: h.mode === 'ai-search' ? '#0E0E5215' : '#2E9E4F15',
                    color: h.mode === 'ai-search' ? '#0E0E52' : '#156B35',
                  }}>
                    {h.mode === 'ai-search' ? <><Sparkles size={11} /> AI SEARCH</> : <><SlidersHorizontal size={11} /> FILTER SEARCH</>}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8A8896', fontFamily: "'IBM Plex Mono',monospace" }}>{timeAgo(h.searchedAt)}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1B1B3A', marginBottom: 2 }}>
                  {h.mode === 'ai-search' ? (h.query || <EmptyValue />) : (filterSummary(h.filters) === '—' ? <EmptyValue /> : filterSummary(h.filters))}
                </div>
                <div style={{ fontSize: 11.5, color: '#75737F' }}>
                  {h.resultCount != null ? `${h.resultCount} result${h.resultCount === 1 ? '' : 's'}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ProjectSelection({ onAnalyse }) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  // Internal filter buckets — no longer set by dropdowns; populated purely by
  // parsing the single natural-language search box below via the existing
  // /api/nl-filters -> query-parser.cjs pipeline. Kept in this exact shape
  // because `filtered`/scoring.cjs/runFilterRank below all already key off
  // it — reusing it here (rather than a new state shape) is what makes NL
  // search "just work" through the existing filtering/scoring/ranking path
  // with no parallel implementation.
  const [locations, setLocations] = useState(sessionMemory.locations)
  const [budget, setBudget]     = useState(sessionMemory.budget)
  const [configs, setConfigs]   = useState(sessionMemory.configs)
  const [possession, setPossession] = useState(sessionMemory.possession)
  // Property Search's single input — the SAME LocationCombobox component AI
  // Search uses below (shared location data/autocomplete/gazetteer, not a
  // second implementation): typing shows live location suggestions,
  // clicking one adds it as a chip, and the free text still doubles as the
  // full NL query on submit (see runPropertySearch's merge logic, identical
  // in shape to AI Search's runAiSearch).
  const [propertyLocations, setPropertyLocations] = useState(sessionMemory.propertyLocations || [])
  const [propertySearchResetKey, setPropertySearchResetKey] = useState(0) // bumping remounts the combobox to clear its internal typed text
  const [nlSearchLoading, setNlSearchLoading] = useState(false)
  const [nlSearchNote, setNlSearchNote] = useState(null) // set when a search yields no extractable criteria at all
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [historyOpen, setHistoryOpen] = useState(false)
  const [filterAnalysis, setFilterAnalysis] = useState(null)   // { [projectName]: {match_score, why} }
  const [filterAnalysisLoading, setFilterAnalysisLoading] = useState(false)

  // AI search (Option B) — restored from session memory after navigation.
  // The tab itself is never locked (AI Search always degrades gracefully to a
  // clear "not configured" message) — externalStatus only drives an upfront
  // banner about whether any external source connector is actually wired up.
  const [mode, setMode]           = useState(sessionMemory.mode)  // 'filter' | 'ai'
  const [externalStatus, setExternalStatus] = useState(null)
  // Structured locality picker (same LocationCombobox component + gazetteer
  // Property Search uses) — the ONE search input for AI Search. Its own
  // internal freeform text doubles as the natural-language query (submitted
  // via onSubmit -> runAiSearch), and any chip picked here is passed as an
  // explicit filters.locations array rather than only being re-parsed out
  // of the query text.
  const [aiLocations, setAiLocations] = useState(sessionMemory.aiLocations || [])
  const [aiResult, setAiResult]   = useState(sessionMemory.aiResult)
  const [aiLoading, setAiLoading] = useState(false)
  const [researchStage, setResearchStage] = useState(0)
  const [aiError, setAiError]     = useState(null)
  // Which market AI Search runs against — India (RERA, our scraped dataset,
  // Filter Search) or Dubai/UAE (Bayut, Property Finder, DLD). Filter Search
  // stays India-only since it's our own scraped dataset; the toggle only
  // changes what AI Search's live web discovery targets.
  const [market, setMarket] = useState(sessionMemory.market || 'india')
  // Stale-response guard (Part 4) — an in-flight India request that
  // resolves AFTER the user has already switched to Dubai (or started a
  // newer Dubai search) must never overwrite the newer state. Incremented
  // on every new search AND on every market switch; a resolving fetch only
  // applies its result if the generation it captured at request-start is
  // still the current one. No AbortController — the existing fetch call
  // has no signal wired in and adding one is a larger change than this bug
  // needs; a plain ref counter is the smallest correct fix (the request
  // still completes over the wire, its result is just discarded).
  const searchGenerationRef = React.useRef(0)

  useEffect(() => {
    fetch(`${API}/api/ai-status`).then(r => r.json()).then(d => setExternalStatus(d)).catch(() => {})
  }, [])

  // Persist search/filter state across screen switches (module-scope memory).
  useEffect(() => {
    Object.assign(sessionMemory, { mode, aiResult, market, aiLocations, locations, budget, configs, possession, propertyLocations })
  }, [mode, aiResult, market, aiLocations, locations, budget, configs, possession, propertyLocations])

  // Query mentions Dubai/UAE-specific terms strongly enough to be worth
  // switching markets for — deliberately narrow (place names + the AED
  // currency code) so it doesn't false-positive on an Indian query that
  // happens to contain an unrelated word.
  const DUBAI_TERMS = /\b(dubai|u\.?a\.?e\.?|abu dhabi|sharjah|ajman|ras al khaimah|fujairah|umm al quwain|aed)\b/i
  // Part 11 — the fix above is one-way (India -> Dubai) only, which left a
  // real, confirmed gap: a user already on the Dubai/UAE tab (from a prior
  // search, or sessionMemory restoring a stale market value on remount)
  // typing a plainly-Indian query ("1bhk in borivali west") stayed on
  // Dubai and the search ran against Dubai/AED sources for an Indian
  // locality. "bhk" is a virtually unambiguous Indian configuration term
  // (Dubai/UAE listings say "bedroom"/"BR"/"studio", never "BHK") and
  // INR/₹ plus major India metro names are equally unambiguous — same
  // "deliberately narrow, real signals only" discipline as DUBAI_TERMS
  // above, not "anything that isn't a Dubai term."
  const INDIA_TERMS = /\b(\d\s*bhk|bhk|india|mumbai|thane|navi mumbai|pune|bengaluru|bangalore|hyderabad|delhi|ncr|gurugram|gurgaon|noida|chennai|kolkata|ahmedabad|borivali|malad|andheri|goregaon|kandivali|dahisar|₹|inr)\b/i
  const [marketAutoNote, setMarketAutoNote] = useState(null)

  const runAiSearch = async (q) => {
    let query = (q ?? '').trim()
    if (!query && !aiLocations.length) return
    // Fold any picked location chip(s) into the query text too (not just the
    // explicit filters.locations array below) — some connectors (Google CSE,
    // Bing) only ever see `query`, they never read `filters`, so a chip that
    // never appears in the text would be invisible to them. Skips a location
    // already mentioned in the typed text to avoid a redundant "...in Malad
    // in Malad". Also covers the case of a bare location chip with no typed
    // keywords at all (server requires non-empty `query`).
    if (aiLocations.length) {
      const missing = aiLocations.filter(l => !query.toLowerCase().includes(l.toLowerCase()))
      if (missing.length) query = query ? `${query} in ${missing.join(', ')}` : `properties in ${missing.join(', ')}`
    }
    // Auto-switch market when the query clearly targets Dubai/UAE but the
    // toggle is still on India — this was the exact bug report (query said
    // "Dubai Marina" while results banner said "India"). Runs the search
    // against the corrected market immediately rather than making the user
    // notice the mismatch, click Dubai, and re-run.
    let effectiveMarket = market
    if (market === 'india' && DUBAI_TERMS.test(query)) {
      effectiveMarket = 'dubai'
      setMarket('dubai')
      setMarketAutoNote('Switched to Dubai / UAE — your search mentioned a Dubai/UAE location.')
    } else if (market === 'dubai' && !DUBAI_TERMS.test(query) && INDIA_TERMS.test(query)) {
      // Symmetric reverse case (Part 11) — DUBAI_TERMS is checked first and
      // wins if present (e.g. "2bhk near Dubai Marina" from an Indian
      // buyer's habit of saying "bhk" — the explicit Dubai mention is the
      // stronger, more specific signal and takes priority either way).
      effectiveMarket = 'india'
      setMarket('india')
      setMarketAutoNote('Switched to India — your search mentioned an Indian location/configuration.')
    } else {
      setMarketAutoNote(null)
    }
    // This request's own generation number — captured now, checked again
    // once the fetch resolves (Part 4's stale-response guard). Any newer
    // search OR a market switch bumps searchGenerationRef past this value,
    // which is how a late India response is told apart from a current one.
    const myGeneration = ++searchGenerationRef.current
    setAiLoading(true); setAiError(null); setAiResult(null); setResearchStage(0)
    // Cycles through RESEARCH_STAGES while the single request/response call
    // below is in flight — stops advancing at the last stage rather than
    // looping, so it never implies a phase repeated.
    const stageTimer = setInterval(() => {
      if (searchGenerationRef.current !== myGeneration) return
      setResearchStage(s => Math.min(s + 1, RESEARCH_STAGES.length - 1))
    }, 1100)
    try {
      const res = await fetch(`${API}/api/ai-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, market: effectiveMarket, filters: { locations: aiLocations } }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      // Stale check — a market switch (or a newer search) since this
      // request started means this response is no longer relevant; drop it
      // silently rather than let it overwrite whatever the user is looking
      // at now.
      if (searchGenerationRef.current !== myGeneration) return
      setAiResult(json)
    } catch (e) {
      if (searchGenerationRef.current === myGeneration) setAiError(e.message)
    } finally {
      clearInterval(stageTimer)
      if (searchGenerationRef.current === myGeneration) setAiLoading(false)
    }
  }

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/projects`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (e) {
      setError('Cannot reach the data server (port 3001). Run: npm run server')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 5000)
    return () => clearInterval(id)
  }, [fetchData])

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const clearSelection = () => setSelectedIds(new Set())

  const handleAnalyse = () => {
    const allProjects = data?.projects || []
    // _autoResearch tells Project Intelligence to run Drishti AI research
    // immediately — without it, a project opened this way (vs. AI Search's
    // "Analyse ->") would never trigger the only source it now has.
    //
    // matchScore/matchWhy: the real, query-specific match (/api/filter-rank's
    // scoring.cjs output, already computed above for the cards currently on
    // screen) carried through to Project Intelligence — without this,
    // Project Intelligence's "AI Match" had nothing real of its own to show
    // and silently duplicated the project's static IndiHomes Score instead
    // (indihomes-client.cjs's attachScore sets `match: score` verbatim).
    // null (not 0) when there's no active search to match against — Project
    // Intelligence shows an honest "Not calculated" state for that, never a
    // fabricated number.
    const chosen = allProjects.filter(p => selectedIds.has(p.id)).map(p => {
      const fa = filterAnalysis?.[p.name]
      return { ...p, _autoResearch: true, matchScore: fa?.match_score ?? null, matchWhy: fa?.why ?? null }
    })
    if (onAnalyse) onAnalyse(chosen)
  }

  const handleGenerateBrief = () => {
    const allProjects = data?.projects || []
    const chosen = allProjects.filter(p => selectedIds.has(p.id))
    if (!chosen.length) return
    const md = buildCampaignBriefMarkdown(chosen)
    downloadTextFile(`campaign-brief-${new Date().toISOString().slice(0, 10)}.md`, md)
  }

  const projects = data?.projects || []

  // Single source of truth for "has the user actually asked for a ranking
  // yet" — reused by the score/match visibility logic, the history-log
  // effect, and the filter-rank effect below (previously each recomputed
  // this inline).
  const hasActiveFilter = locations.length > 0 || budget !== 'All' || configs.length > 0 || possession !== 'All'

  const filtered = projects.filter(p => {
    if (locations.length > 0) {
      // Include nearbyLocality ("Near Liberty Garden, Road No 3") — IndiHomes'
      // own API returns this as a separate field from city/location/name, and
      // it's often the exact phrase a buyer searches (a landmark, not the
      // official locality name). Without it, a real project can score 0 and
      // never even reach scoring.cjs (which already checked this field) because
      // it's filtered out of the candidate list before scoring ever runs.
      const hay = `${p.city} ${p.location || ''} ${p.nearbyLocality || ''} ${p.name}`.toLowerCase()
      // Expand each selected location through the gazetteer (e.g. "Gawamin"
      // also checks "Vasai West"/"Vasai-Virar") so a micro-locality with real
      // coverage still matches, and one with none honestly returns 0 results
      // instead of silently behaving like an unrecognised location.
      const terms = locations.flatMap(resolveLocationTerms)
      // Also admit "sibling" localities (same umbrella area, different
      // direction — e.g. searching "Borivali East" still admits a "Borivali
      // West" project) so scoring.cjs's graduated location tier has a real
      // TERTIARY/SECONDARY candidate to downrank instead of the project
      // being silently excluded before scoring ever sees it.
      const bases = locations.map(baseLocality).filter(b => b && b.length > 2)
      const hit = terms.some(t => hay.includes(t)) || bases.some(b => hay.includes(b))
      if (!hit) return false
    }
    if (budget === 'Under 75L'   && p.budgetMax  >= 75)  return false
    if (budget === '75L–1.5Cr'  && (p.budgetMax < 75 || p.budgetMin > 150)) return false
    if (budget === 'Above 1.5Cr' && p.budgetMax  < 150)  return false
    // Configuration and possession are NOT hard-excluded here (unlike
    // location/budget above) — they're left for scoring.cjs's graduated
    // partial-credit logic to rank instead. A project that's exact on
    // location but has a different BHK, or possession a year later than
    // asked, is still a real candidate worth showing (as SECONDARY/
    // TERTIARY per the ranking spec) rather than vanishing outright; hard-
    // excluding them here previously meant scoring.cjs's own partial-credit
    // paths for these two dimensions could never actually run.
    return true
  })

  // Log Filter Search activity to the shared, persisted history — debounced
  // so it fires once after the user settles on a set of filters, not on
  // every intermediate click, and only when a filter is actually applied.
  useEffect(() => {
    if (mode !== 'filter') return
    if (!hasActiveFilter) return
    const t = setTimeout(() => {
      fetch(`${API}/api/log-filter-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: { locations, budget, configs, possession }, resultCount: filtered.length }),
      }).catch(() => {})
    }, 1200)
    return () => clearTimeout(t)
  }, [mode, locations, budget, configs, possession, filtered.length])

  // Single natural-language Property Search — reuses the exact same
  // deterministic parser + bucket shape /api/nl-filters already exposed
  // (query-parser.cjs's parseNLQuery under the hood, no second parser).
  // Setting locations/budget/configs/possession from the parse result is
  // what lets the existing `filtered` filter, gazetteer expansion,
  // runFilterRank scoring, and compareRanked sort below all work completely
  // unmodified — this function is the ONLY thing that changed how those
  // buckets get populated, not what happens once they are.
  const runPropertySearch = useCallback(async (typedText) => {
    let query = (typedText ?? '').trim()
    setNlSearchNote(null)
    // Fold any picked location chip(s) into the query text — identical merge
    // pattern to AI Search's runAiSearch below, so the ONE existing parser
    // (/api/nl-filters -> query-parser.cjs) still sees one full string and
    // still extracts location/BHK/budget/possession together, whether the
    // location came from typed prose or a clicked suggestion. Skips a
    // location already mentioned in the typed text to avoid "...in Malad in
    // Malad".
    if (propertyLocations.length) {
      const missing = propertyLocations.filter(l => !query.toLowerCase().includes(l.toLowerCase()))
      if (missing.length) query = query ? `${query} in ${missing.join(', ')}` : `properties in ${missing.join(', ')}`
    }
    if (!query) {
      // Empty search = back to the full unfiltered inventory, not an error.
      setLocations([]); setBudget('All'); setConfigs([]); setPossession('All')
      return
    }
    setNlSearchLoading(true)
    try {
      const res = await fetch(`${API}/api/nl-filters`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      const nextLocations = json.locations || []
      const nextBudget = json.budget || 'All'
      const nextConfigs = json.configs || []
      const nextPossession = json.possession || 'All'
      setLocations(nextLocations); setBudget(nextBudget); setConfigs(nextConfigs); setPossession(nextPossession)
      if (!nextLocations.length && nextBudget === 'All' && !nextConfigs.length && nextPossession === 'All') {
        setNlSearchNote("Couldn't identify a location, BHK, budget, or possession in that search — showing the full inventory instead.")
      }
    } catch (e) {
      setNlSearchNote(`Search failed: ${e.message}`)
    } finally {
      setNlSearchLoading(false)
    }
  }, [propertyLocations])

  const clearPropertySearch = () => {
    setPropertyLocations([])
    setLocations([]); setBudget('All'); setConfigs([]); setPossession('All')
    setNlSearchNote(null)
    setPropertySearchResetKey(k => k + 1) // remounts the combobox so its internal typed text clears too
  }

  // Filter Search's cards default to a static heuristic score computed once
  // at scrape time. Once the user settles on a filter set, also run the same
  // Claude scoring AI Search uses (Agent 2 / rankProjects) against the
  // filtered candidates, so a real match_score + "why" appears here too.
  // Extracted into a standalone function (not inlined in the effect below)
  // so the explicit "Search" button / Enter-in-location-box can trigger it
  // immediately too, reusing this exact fetch rather than duplicating it.
  const runFilterRank = useCallback(() => {
    if (mode !== 'filter') return
    if (!hasActiveFilter || !filtered.length) { setFilterAnalysis(null); return }
    setFilterAnalysisLoading(true)
    fetch(`${API}/api/filter-rank`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: { locations, budget, configs, possession }, candidates: filtered }),
    })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || 'Analysis failed')
        const map = {}
        for (const bucket of [j.primary_matches, j.secondary_matches, j.stretch_matches, j.excluded_projects]) {
          // excluded_projects now carries its own real match_score (server
          // fix) — no longer force-zeroed, so a 35-point near-miss reads
          // differently from a genuine 0.
          for (const m of (bucket || [])) if (m.name) map[m.name] = m
        }
        setFilterAnalysis(map)
      })
      .catch(() => setFilterAnalysis(null))
      .finally(() => setFilterAnalysisLoading(false))
  }, [mode, hasActiveFilter, filtered, locations, budget, configs, possession])

  useEffect(() => {
    if (mode !== 'filter') { setFilterAnalysis(null); return }
    if (!hasActiveFilter || !filtered.length) { setFilterAnalysis(null); return }
    const t = setTimeout(runFilterRank, 1200)
    return () => { clearTimeout(t); setFilterAnalysisLoading(false) }
  }, [mode, locations, budget, configs, possession, filtered.length])

  const selectedCount = selectedIds.size
  // Displayed order only — tier-first, score second within a tier (see
  // compareRanked above). `filtered` itself stays in its original order for
  // everything else (selection, the /api/filter-rank candidates payload,
  // history logging), since those don't care about display order.
  const sortedFiltered = [...filtered].sort(compareRanked(p => filterAnalysis?.[p.name] || null))

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1280, paddingBottom: selectedCount > 0 ? 100 : 28 }}>
      {historyOpen && <SearchHistoryPanel onClose={() => setHistoryOpen(false)} />}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: '#8A8896', letterSpacing: '0.1em', marginBottom: 4 }}>
            MODULE 02
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: '#1B1B3A', margin: 0 }}>Project Selection</h1>
          <p style={{ fontSize: 13, color: '#75737F', marginTop: 4 }}>
            AI-powered project discovery — Drishti AI researches the live market (portals, builder sites, news) and ranks projects against your requirements, with every fact linked to its source.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {selectedCount > 0 && (
            <span style={{ fontSize: 13, color: '#0E0E52', fontWeight: 600 }}>
              {selectedCount} selected
            </span>
          )}
          <button onClick={() => setHistoryOpen(true)}
            style={{ padding: '9px 16px', background: '#F6F5F1', color: '#0E0E52', border: '1px solid #E9E7E0', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7 }}>
            <History size={14} /> Search History
          </button>
        </div>
      </div>

      {/* Search-mode toggle */}
      <div style={{ display: 'flex', gap: 4, background: '#EFEDE6', padding: 4, borderRadius: 10, width: 'fit-content', marginBottom: 16 }}>
        {[['filter', '⚙ Property Search'], ['ai', '✦ AI Search']].map(([m, lbl]) => (
          <button key={m} onClick={() => setMode(m)}
            style={{
              padding: '8px 18px', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              fontFamily: "'Plus Jakarta Sans',sans-serif",
              background: mode === m ? '#fff' : 'transparent',
              color: mode === m ? '#0E0E52' : '#75737F',
              boxShadow: mode === m ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}>
            {lbl}
          </button>
        ))}
      </div>

      {/* AI SEARCH MODE — external (non-IndiHomes) market listings. Never
          locked: it always degrades to a clear message when no external
          source connector is configured, rather than hiding the tab. */}
      {mode === 'ai' && (
        <div style={{ marginBottom: 16 }}>
          {/* Only the genuine "nothing is set up at all" state gets a banner —
              no per-connector ✓/✗ breakdown. That detail is an operator/
              deployment concern (visible in the server startup log and
              console.warn lines), not something a salesperson using this
              screen needs to see or can act on. */}
          {externalStatus && !externalStatus.enabled && (
            <div style={{ background: '#FEF3E4', border: '1px solid #F7941D40', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#B5651D' }}>
              No external search connector is configured yet. Contact your administrator to enable external India/Dubai results.
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {[['india', '🇮🇳 India'], ['dubai', '🇦🇪 Dubai / UAE']].map(([m, label]) => (
              <button key={m} onClick={() => {
                if (m === market) return
                // Invalidate any in-flight request for the OLD market and
                // wipe its results immediately — India's UI must never
                // stay on screen after switching to Dubai, regardless of
                // whether a request happens to still be in flight (Part 4).
                searchGenerationRef.current++
                setMarket(m)
                setAiResult(null); setAiError(null); setAiLoading(false); setMarketAutoNote(null)
              }} disabled={aiLoading}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: aiLoading ? 'not-allowed' : 'pointer',
                  border: market === m ? '1.5px solid #0E0E52' : '1.5px solid #E9E7E0',
                  background: market === m ? '#0E0E5210' : '#fff', color: market === m ? '#0E0E52' : '#75737F',
                }}>
                {label}
              </button>
            ))}
          </div>
          {marketAutoNote && (
            <div style={{ background: '#EEF0FF', border: '1px solid #C8CCF0', borderRadius: 8, padding: '7px 12px', marginBottom: 10, fontSize: 12, color: '#0E0E52', fontWeight: 600 }}>
              ℹ {marketAutoNote}
            </div>
          )}
          {/* ONE search input for AI Search — the same LocationCombobox +
              gazetteer Property Search uses, extended with onSubmit so it
              doubles as the full natural-language query box. Typing shows
              location autocomplete (Gawamin -> Vasai-Virar, same as Property
              Search); clicking a suggestion adds it as a location chip
              (folded into filters.locations, more reliable than re-parsing
              it out of prose); pressing Enter or the search button runs the full
              query — current free text + any chips — through the existing
              runAiSearch (query parsing, location detection, BHK/budget/
              possession extraction, external search, scoring/ranking all
              unchanged, all still happen server-side exactly as before). */}
          <div style={{ marginBottom: 10 }}>
            <LocationCombobox options={[]} selected={aiLocations} onChange={setAiLocations} projects={projects}
              minWidth="100%" maxWidth="100%" onSubmit={(text) => runAiSearch(text)} disabled={aiLoading} loading={aiLoading} />
          </div>
          {!aiResult && !aiLoading && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#8A8896', alignSelf: 'center' }}>Try:</span>
              {AI_EXAMPLES.map((ex, i) => (
                <button key={i} onClick={() => runAiSearch(ex)}
                  style={{ background: '#F6F5F1', border: '1px solid #E9E7E0', borderRadius: 20, padding: '6px 14px', fontSize: 12, color: '#4A4A63', cursor: 'pointer' }}>
                  {ex}
                </button>
              ))}
            </div>
          )}
          {aiLoading && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#75737F' }}>
              <Loader2 size={28} style={{ marginBottom: 10, color: '#0E0E52', animation: 'spin 0.8s linear infinite' }} />
              <div style={{ fontWeight: 700, color: '#0E0E52' }}>{RESEARCH_STAGES[researchStage]}…</div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginTop: 10 }}>
                {RESEARCH_STAGES.map((_, i) => (
                  <span key={i} style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: i <= researchStage ? '#0E0E52' : '#E9E7E0',
                    transition: 'background 0.2s',
                  }} />
                ))}
              </div>
            </div>
          )}
          {aiError && (
            <div style={{ background: '#FEE8E8', border: '1px solid #D6454540', borderRadius: 8, padding: '12px 14px', color: '#D64545', fontSize: 13 }}>{aiError}</div>
          )}
          {aiResult && <AnalystReport result={aiResult} onAnalyse={onAnalyse} onResultChange={setAiResult} />}
        </div>
      )}

      {/* Single natural-language Property Search — location, BHK/configuration,
          budget, and possession all come from this one box (extended
          query-parser.cjs via /api/nl-filters), not separate dropdowns. */}
      {mode === 'filter' && (
      <>
      {/* Same LocationCombobox component AI Search uses below — shared
          location data source, autocomplete logic, gazetteer/alias
          normalization, and suggestion rendering, not a second
          implementation. onSubmit still runs the full NL parse (see
          runPropertySearch's merge logic); clicking a suggestion adds it as
          a chip that's folded into the query text at submit time. */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <LocationCombobox key={propertySearchResetKey} options={[]} selected={propertyLocations} onChange={setPropertyLocations} projects={projects}
            minWidth="100%" maxWidth="100%" disabled={nlSearchLoading} loading={nlSearchLoading} submitLabel="Search"
            onSubmit={(text) => runPropertySearch(text)} />
        </div>
        {hasActiveFilter && (
          <button onClick={clearPropertySearch}
            style={{ ...btn('#fff', '#75737F', '#E9E7E0'), padding: '0 16px', fontSize: 13, height: 44, flexShrink: 0 }}>
            ✕ Clear
          </button>
        )}
      </div>
      {nlSearchNote && (
        <div style={{ fontSize: 12.5, color: '#B5651D', background: '#FEF3E4', border: '1px solid #F7941D40', borderRadius: 8, padding: '7px 12px', marginBottom: 10 }}>
          ℹ {nlSearchNote}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, fontSize: 13, color: '#75737F' }}>
        {loading ? 'Loading…' : hasActiveFilter ? `${filtered.length} matching project${filtered.length === 1 ? '' : 's'} ranked` : `${filtered.length} project${filtered.length === 1 ? '' : 's'} available`}
      </div>
      </>
      )}

      {/* Predictive nearby-location suggestions */}
      {mode === 'filter' && locations.length > 0 && nearbySuggestions(locations).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: -8, marginBottom: 20 }}>
          <span style={{ fontSize: 12, color: '#8A8896', fontWeight: 600 }}>✦ Also consider nearby:</span>
          {nearbySuggestions(locations).map(loc => (
            <button key={loc} onClick={() => setLocations([...locations, loc])}
              style={{ background: '#EEF0FF', border: '1px solid #C8CCF0', color: '#0E0E52', borderRadius: 20, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              + {loc}
            </button>
          ))}
        </div>
      )}

      {/* Loading skeleton */}
      {mode === 'filter' && loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{ background: '#fff', border: '1px solid #E9E7E0', borderRadius: 12, padding: '16px 20px', height: 96, opacity: 0.5, animation: 'pulse 1.5s ease-in-out infinite alternate' }} />
          ))}
        </div>
      )}

      {/* No data yet */}
      {mode === 'filter' && !loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: '#75737F' }}>
          <Inbox size={40} style={{ marginBottom: 12, color: '#C8C6D0' }} />
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8, color: '#1B1B3A' }}>
            {error ? 'Server offline' : 'No projects match these filters'}
          </div>
          <div style={{ fontSize: 13 }}>
            {error
              ? 'Start the backend with: npm run server'
              : 'Adjust the filters, or try the ✦ AI Search tab — Drishti AI will find matching projects on the live market.'
            }
          </div>
        </div>
      )}

      {/* Project Cards */}
      {mode === 'filter' && !loading && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filterAnalysisLoading && (
            <div style={{ fontSize: 12.5, color: '#8A8896', marginBottom: 2 }}>✦ Drishti AI is scoring these matches against your filters…</div>
          )}
          {sortedFiltered.map((p, idx) => (
            <ProjectCard
              key={p.id}
              project={p}
              index={idx}
              selected={selectedIds.has(p.id)}
              onToggle={toggleSelect}
              aiMatch={filterAnalysis?.[p.name] || null}
              hasActiveFilter={hasActiveFilter}
            />
          ))}
        </div>
      )}

      {/* Floating analyse bar */}
      {selectedCount > 0 && (
        <AnalyseBar
          count={selectedCount}
          onClear={clearSelection}
          onAnalyse={handleAnalyse}
          onBrief={handleGenerateBrief}
        />
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes pulse { from { opacity: 0.4 } to { opacity: 0.8 } }
      `}</style>
    </div>
  )
}
