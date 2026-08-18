'use strict'

// LEGACY — disconnected discovery pipeline (MahaRERA/99acres/MagicBricks/
// Google Ads scraping). This used to be Filter Search's data source before
// the business rule "Filter Search must use only official IndiHomes website
// properties" — it now conflicts with that rule and is no longer wired into
// the live cache/boot loop or the refresh interval.
//
// Kept, not deleted, per the "disconnect + repurpose" decision: required but
// never called by server.cjs today. Nothing here is reachable from any live
// route. Safe reference material if a future need for multi-portal discovery
// (not Filter Search) comes back.
//
// Exported as a factory so it can share server.cjs's live `cache` object, db,
// Playwright `chromium` handle, etc. without a circular require.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim() }

function parsePrice(raw = '') {
  const crR = raw.match(/[₹₹]?\s*(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*Cr/i)
  if (crR) return { min: Math.round(parseFloat(crR[1]) * 1e7), max: Math.round(parseFloat(crR[2]) * 1e7), display: `Rs.${crR[1]} Cr - Rs.${crR[2]} Cr` }
  const lR = raw.match(/[₹₹]?\s*(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)\s*L/i)
  if (lR) return { min: Math.round(parseFloat(lR[1]) * 1e5), max: Math.round(parseFloat(lR[2]) * 1e5), display: `Rs.${lR[1]}L - Rs.${lR[2]}L` }
  const sCr = raw.match(/(?:from|at|starting|Rs\.?|[₹₹])\s*(\d+\.?\d*)\s*Cr/i)
  if (sCr) { const v = Math.round(parseFloat(sCr[1]) * 1e7); return { min: v, max: null, display: `From Rs.${sCr[1]} Cr` } }
  const sL = raw.match(/(?:from|at|starting|Rs\.?|[₹₹])\s*(\d+\.?\d*)\s*L/i)
  if (sL) { const v = Math.round(parseFloat(sL[1]) * 1e5); return { min: v, max: null, display: `From Rs.${sL[1]}L` } }
  return { min: null, max: null, display: null }
}

function parseBHK(raw = '') {
  const types = []
  const s = String(raw)
  const shared = s.match(/(\d+(?:\s*[&,]\s*\d+)+)\s*BHK/gi)
  if (shared) {
    for (const chunk of shared) {
      for (const n of (chunk.match(/\d+/g) || [])) {
        const l = `${n} BHK`; if (!types.includes(l)) types.push(l)
      }
    }
  }
  for (const m of (s.match(/\d+\s*BHK/gi) || [])) {
    const l = `${m.match(/\d+/)[0]} BHK`; if (!types.includes(l)) types.push(l)
  }
  if (!types.length && /studio/i.test(s)) types.push('Studio')
  return types
}

function parsePossession(raw = '') {
  const m = String(raw).match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{4})/i)
  if (m) return `${m[1].slice(0, 3)} ${m[2]}`
  const y = String(raw).match(/20\d\d/); if (y) return y[0]
  if (/ready|immediate|now/i.test(raw)) return 'Ready to Move'
  return raw.trim() || null
}

const GENERIC = [
  /^\d+\+?\s*/i, /projects? in /i, /projects? by /i, /^all projects/i,
  /^best \d+/i, /^top \d+/i, /^under construction/i, /^ongoing (residential|projects)/i,
  /^upcoming (residential|projects)/i, /^new residential/i, /^luxury real estate/i,
  /^premium residential/i, /^residential property in/i, /^residential flats/i,
  /^new (godrej|lodha|tata|piramal|oberoi|hiranandani|rustomjee|runwal|raymond|adani|birla|sunteck|prestige|kolte|mahindra|shapoorji|kalpataru) residential/i,
  /^godrej residential/i, /leadership team/i, /history,/i, /milestones/i,
  /media centre/i, /print coverage/i, /^copyright/i, /share price/i, /ipo performance/i,
  /listing (today|price)/i, /^about /i, /^entering \d{4}/i,
  /to (launch|enter|list|buy|sell|develop|acquire)/i, /plans? (to|up) /i, /announces?/i,
  /inks (joint|pact)/i, /signs pact/i, /acquires? land/i, /unveils?/i, /launches?/i,
  / ₹/i, /\bcrore\b/i, /\brs\.\s*\d/i, / – /, /net sales at/i, /equity funding/i,
  /capex for/i, /portfolio at/i, /\bIPO\b/i, /listing department/i, /sh\/xii\//i,
  /simply wall st/i, /future growth/i, /investment guide/i, /^south mumbai vs/i,
  /edition$/i, /\bsecured\b/i, /\bupdates,?\s+milestones\b/i, /@[a-z]+realty/i,
  /& future development/i, /& commercial projects/i, /\bprojects overview\b/i,
  /\bcomplete overview\b/i, /^view pdf/i, /^flats?$/i, /new projects?$/i,
  /\bbuilder profile\b/i, /\blifespace developers\b/i, /^buy /i, /^\d+ ?bhk /i,
  /^search /i, /^check out /i, /^find /i, /^explore /i, /^visit /i, /^homes? in /i,
  /^houses in /i, /^why /i, /^the vision/i, /^bringing /i, /^from the launch/i,
  /^luxury /i, /^top /i, /\bresidential projects\b/i, /new project$/i,
  /r\/thane/i, /reddit/i, /\.\.\.$/, /\.\s*$/,
]

const CORP_NAME_ONLY = /^(Lodha|Godrej|Prestige|Mahindra|Shapoorji\s*Pallonji|Shapoorji|Piramal|Tata|Oberoi|Hiranandani|Runwal|Kalpataru|Rustomjee|Raymond|Ajmera|Raheja|Kolte[- ]?Patil|Adani|Birla|Sunteck|Dosti|DB\s*Realty)\s*(Properties?|Realty|Group|Housing|Estates?|Lifespaces?|Developers?\s*(Limited)?|Enterprises?|Real\s*Estate|MLDL|SPRE|Pallonji)?\s*(Mumbai|Thane|Pune|Maharashtra|Panvel|Navi\s*Mumbai|Gurugram|India|Ltd\.?)?\s*(,\s*the)?\s*$/i

function cleanProjectName(title) {
  const CITY_SFXS = 'thane west|thane east|thane|mumbai|pune|panvel|navi mumbai|goregaon|malad|bhandup|andheri|kandivali|borivali|mulund|powai|chembur|baner|hinjewadi|wakad|hadapsar|kanjurmarg|majiwada|balkum pada|balkum|kharghar|ulwe|dombivli|badlapur|belapur|airoli|vashi|ghansoli'
  const DEV_SFXS = 'lodha|godrej|prestige|mahindra|shapoorji pallonji|shapoorji|piramal|tata housing|tata|oberoi|hiranandani|runwal|kalpataru|rustomjee|raymond realty|raymond|ajmera|raheja|kolte patil|adani realty|adani|birla estates|birla|sunteck'
  return title
    .replace(new RegExp(`\\s+by\\s+(${DEV_SFXS}).*`, 'i'), '')
    .replace(new RegExp(`\\s*-\\s*(${DEV_SFXS})\\s*$`, 'i'), '')
    .replace(/\s*[-–—]+\s*(price|review|bhk|flat|apartment|property|home|buy|book|check|view|get|explore|why|know|all|latest|ongoing|upcoming|overview|complete|builder|best).*/i, '')
    .replace(new RegExp(`\\s+at\\s+(${CITY_SFXS}).*`, 'i'), '')
    .replace(new RegExp(`\\s+in\\s+(${CITY_SFXS}).*`, 'i'), '')
    .replace(/\s*-\s*\d+,?\s*\d*\s*(&\s*\d+)?\s*bhk.*/i, '')
    .replace(/,\s*(thane|mumbai|pune|panvel|navi mumbai|west|east).*/i, '')
    .replace(/\s+in\s+(pokhran road|ghodbunder road|eastern express highway|western express highway|nh.48|nh.8).*/i, '')
    .replace(new RegExp(`\\s+(${CITY_SFXS})(\\s+(east|west|north|south))?(\\s+(mumbai|thane|pune))?\\s*$`, 'i'), '')
    .replace(/\s*\(.*\)$/, '')
    .replace(/\s*\|\s*.*$/, '')
    .replace(/\s*:\s*.*$/, '')
    .replace(/\s+\d{4}.*$/, '')
    .replace(/[-\s]+$/, '')
    .trim()
}

const KNOWN_DEVS = [
  'Lodha', 'Godrej', 'Prestige', 'Mahindra', 'Shapoorji', 'Piramal', 'Tata',
  'Oberoi', 'Hiranandani', 'Runwal', 'Kalpataru', 'Rustomjee', 'Wadhwa',
  'Raymond', 'Ajmera', 'Raheja', 'Kolte Patil', 'VTP Realty', 'Mantra',
  'Kohinoor', 'Marvel', 'Paranjape', 'Nyati', 'Adani Realty', 'Birla Estates',
  'Brigade', 'Sobha', 'L&T Realty', 'Rohan', 'Sunteck', 'Ruparel', 'Dosti',
  'DB Realty', 'Kumar', 'Naiknavare', 'Provident', 'Macrotech', 'Puravankara',
]

const GOOGLE_QUERIES = [
  'Lodha new residential project 2025 2026 Thane Mumbai price bhk',
  'Godrej Properties new launch 2025 2026 Maharashtra site bhk price',
  'Piramal Realty new project Thane 2025 2026 price',
  'Oberoi Realty new residential project Mumbai 2025 2026',
  'Hiranandani new project Thane Panvel 2025 2026',
  'Kalpataru new residential project Mumbai Thane 2025 2026',
  'Rustomjee new launch project Thane Mumbai 2025',
  'Runwal new project Kanjurmarg Thane 2025 2026',
  'Mahindra Lifespaces new project Mumbai Pune 2025',
  'Shapoorji Pallonji new launch project Maharashtra 2025',
  'Birla Estates new project Pune Mumbai 2025 2026',
  'Raymond Realty new project Thane 2025 2026',
  'Adani Realty new project Panvel Navi Mumbai 2025',
  'Tata Housing new residential project Mumbai Pune 2025',
  'Sunteck Realty new project Mumbai 2025 2026',
  'Prestige Group new project Pune Mumbai 2025',
  'Kolte Patil new project Pune 2025 2026',
]

const CITY_MAP = {
  mumbai: 'Mumbai', thane: 'Thane', pune: 'Pune', 'navi mumbai': 'Navi Mumbai',
  panvel: 'Navi Mumbai', kharghar: 'Navi Mumbai', ulwe: 'Navi Mumbai',
  nashik: 'Nashik', nagpur: 'Nagpur', kalyan: 'Thane', dombivli: 'Thane',
  vasai: 'Mumbai', virar: 'Mumbai', kandivali: 'Mumbai', borivali: 'Mumbai',
  andheri: 'Mumbai', powai: 'Mumbai', chembur: 'Mumbai', mulund: 'Mumbai',
  goregaon: 'Mumbai', malad: 'Mumbai', kanjurmarg: 'Mumbai', bhandup: 'Mumbai',
  hinjewadi: 'Pune', baner: 'Pune', wakad: 'Pune', hadapsar: 'Pune',
}

const RANK_LABELS = ['PRIMARY', 'SECONDARY', 'TERTIARY', '4TH MATCH', '5TH MATCH', '6TH MATCH', '7TH MATCH', '8TH MATCH']
const RANK_COLORS = { PRIMARY: '#2E9E4F', SECONDARY: '#F7941D', TERTIARY: '#8B8BD6' }

function normalize(raw, index) {
  const label = RANK_LABELS[index] || `${index + 1}TH MATCH`
  const bMin = raw.price_min ? Math.round(raw.price_min / 100000) : null
  const bMax = raw.price_max ? Math.round(raw.price_max / 100000) : null
  return {
    id: index + 1,
    name: raw.name || 'Unknown Project',
    builder: raw.developer || 'Unknown Developer',
    city: raw.city || 'Maharashtra',
    location: raw.location || '',
    config: Array.isArray(raw.bhk) ? raw.bhk.join(' & ') : (raw.bhk || ''),
    budgetMin: bMin, budgetMax: bMax,
    budgetLabel: bMin && bMax ? `Rs.${bMin}L - Rs.${bMax}L` : raw.price_display || 'Price on request',
    possession: raw.possession || 'TBD',
    score: raw.indihomes_score || 55,
    match: raw.match_pct || 65,
    rank: label, rankColor: RANK_COLORS[label] || '#8B8BD6',
    rera: !!(raw.rera || raw.reraCode), reraCode: raw.reraCode || null,
    sources: raw._sources || [raw._source || 'unknown'],
    adSrc: (raw._sources || [raw._source || 'portal'])[0],
    units: raw.units || null, sold: raw.sold_pct || null, amenities: raw.amenities || [],
    listingUrl: raw.listing_url || null,
  }
}

function deduplicate(projects) {
  const map = new Map()
  for (const p of projects) {
    const key = ((p.developer || '') + '::' + (p.name || '')).toLowerCase().replace(/\W/g, '')
    if (!map.has(key)) {
      map.set(key, { ...p, _sources: [p._source || 'unknown'] })
    } else {
      const ex = map.get(key)
      ex._sources = [...new Set([...ex._sources, p._source || 'unknown'])]
      if (!ex.rera && p.rera) ex.rera = p.rera
      if (!ex.reraCode && p.reraCode) ex.reraCode = p.reraCode
      if (!ex.price_min && p.price_min) ex.price_min = p.price_min
      if (!ex.price_max && p.price_max) ex.price_max = p.price_max
      if (!ex.possession && p.possession) ex.possession = p.possession
    }
  }
  return [...map.values()]
}

module.exports = function createLegacyScrapers({ cache, db, chromium, scoreProjects, syncAzureSearch, enrichProjectsWithRera }) {
  async function scrapeMahaRERA(browser) {
    const projects = []
    const DISTRICTS = [
      { id: 30, name: 'Mumbai City', city: 'Mumbai' },
      { id: 31, name: 'Mumbai Suburb', city: 'Mumbai' },
      { id: 22, name: 'Thane', city: 'Thane' },
      { id: 25, name: 'Pune', city: 'Pune' },
      { id: 21, name: 'Raigad', city: 'Navi Mumbai' },
    ]
    const page = await browser.newPage()
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-IN,en;q=0.9' })
    for (const dist of DISTRICTS) {
      cache.step = `MahaRERA -> ${dist.name}...`
      console.log(`[maharera] ${dist.name}`)
      try {
        await page.goto('https://maharera.mahaonline.gov.in/SearchDetails/Search', { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForTimeout(2000)
        const apiResult = await page.evaluate(async (distId) => {
          const endpoints = [
            { url: '/Homenew/GetProjectList', body: JSON.stringify({ StartIndex: 1, PageSize: 50, DistrictId: distId, TalukaId: 0, ProjectStatus: 1, ProjectType: 1 }), ct: 'application/json' },
            { url: '/Homenew/GetRegisteredProjectList', body: `DistrictId=${distId}&ProjectType=1&PageSize=50`, ct: 'application/x-www-form-urlencoded' },
            { url: '/SearchDetails/GetProjectList', body: JSON.stringify({ districtId: distId, pageSize: 50, pageNo: 1 }), ct: 'application/json' },
          ]
          for (const ep of endpoints) {
            try {
              const r = await fetch(ep.url, { method: 'POST', headers: { 'Content-Type': ep.ct, 'X-Requested-With': 'XMLHttpRequest' }, body: ep.body })
              if (!r.ok) continue
              const txt = await r.text()
              if (!txt || (txt.trim()[0] !== '{' && txt.trim()[0] !== '[')) continue
              const d = JSON.parse(txt)
              const arr = d.d || d.Data || d.data || d.Result || d.Projects || (Array.isArray(d) ? d : null)
              if (Array.isArray(arr) && arr.length > 0) return { ok: true, data: arr, endpoint: ep.url }
            } catch (_) {}
          }
          return { ok: false }
        }, dist.id)
        if (apiResult.ok && apiResult.data.length > 0) {
          console.log(`[maharera] ${dist.name}: ${apiResult.data.length} via API`)
          for (const item of apiResult.data) {
            const name = clean(item.ProjectName || item.Name || item.ProjectTitle || '')
            const rera = clean(item.RegistrationNo || item.RegNo || item.RERA_No || item.ReraNo || '')
            if (!name || name.length < 3) continue
            projects.push({
              name, developer: clean(item.PromoterName || item.DeveloperName || item.Promoter || 'Unknown Developer'),
              location: clean(item.Taluka || item.TalukaName || item.Locality || dist.name),
              city: dist.city, state: 'Maharashtra',
              bhk: parseBHK(item.BHKConfig || item.Config || ''),
              price_min: null, price_max: null, price_display: 'Price on request',
              possession: parsePossession(item.ProposedDateOfCompletion || item.CompletionDate || ''),
              rera: !!rera, reraCode: rera || null,
              listing_url: rera ? `https://maharera.mahaonline.gov.in/Project/ProjectDetail/${rera}` : null,
              _source: 'maharera',
            })
          }
        } else {
          try {
            const distSel = await page.$('#DistrictId, select[name="DistrictId"]')
            if (distSel) {
              await distSel.selectOption({ value: String(dist.id) }).catch(() => {})
              await page.waitForTimeout(1000)
              const sub = await page.$('#btnSearch, button[type="submit"], input[type="submit"]')
              if (sub) { await sub.click(); await page.waitForTimeout(4000) }
            }
            const rows = await page.evaluate(() => {
              const out = []
              for (const row of document.querySelectorAll('table tr')) {
                const cells = [...row.querySelectorAll('td')]
                if (cells.length < 3) continue
                const text = row.textContent
                const reraM = text.match(/P\d{11,14}/)
                if (reraM || cells.length >= 4) {
                  out.push({ c: cells.map(c => c.textContent.trim()), rera: reraM?.[0] || '', href: row.querySelector('a')?.href || '' })
                }
              }
              return out
            })
            for (const r of rows) {
              const name = r.c.find(c => c.length > 5 && !/^\d/.test(c) && !/^P\d{11}/.test(c)) || ''
              if (!name || name.length < 4) continue
              projects.push({
                name: clean(name), developer: 'Unknown Developer',
                location: dist.name, city: dist.city, state: 'Maharashtra',
                bhk: [], price_min: null, price_max: null, price_display: 'Price on request',
                possession: null, rera: !!r.rera, reraCode: r.rera || null,
                listing_url: r.href || null, _source: 'maharera',
              })
            }
            if (rows.length > 0) console.log(`[maharera] ${dist.name}: ${rows.length} rows from DOM`)
            else console.log(`[maharera] ${dist.name}: 0 (site requires auth or JS)`)
          } catch (domErr) {
            console.log(`[maharera] ${dist.name} DOM err:`, domErr.message)
          }
        }
      } catch (e) {
        console.log(`[maharera] ${dist.name}:`, e.message)
      }
      await sleep(2000)
    }
    await page.close()
    return projects
  }

  async function scrape99AcresSSR(browser) {
    const projects = []
    const URLS = {
      Mumbai: 'https://www.99acres.com/new-projects-in-mumbai-ffid',
      Thane: 'https://www.99acres.com/new-projects-in-thane-ffid',
      Pune: 'https://www.99acres.com/new-projects-in-pune-ffid',
      'Navi Mumbai': 'https://www.99acres.com/new-projects-in-navi-mumbai-ffid',
    }
    for (const [city, url] of Object.entries(URLS)) {
      cache.step = `99acres -> ${city}...`
      console.log(`[99acres] ${city}`)
      try {
        const _ctx99 = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' })
        const page = await _ctx99.newPage()
        await page.route('**/*.{png,jpg,gif,woff,woff2,mp4,svg}', r => r.abort())
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
        await page.waitForTimeout(3500)
        const data = await page.evaluate(() => {
          try {
            const el = document.getElementById('__NEXT_DATA__')
            if (el) return { source: 'next', data: JSON.parse(el.textContent) }
          } catch (_) {}
          for (const k of ['__INITIAL_STATE__', '__STATE__', '__REDUX_STATE__']) {
            try { if (window[k]) return { source: k, data: window[k] } } catch (_) {}
          }
          for (const s of document.querySelectorAll('script:not([src])')) {
            const t = s.textContent || ''
            if ((t.includes('"projectName"') || t.includes('"developer"')) && t.startsWith('{')) {
              try { return { source: 'script', data: JSON.parse(t) } } catch (_) {}
            }
          }
          const cards = document.querySelectorAll('[class*="projectCard"],[class*="ProjectCard"],[class*="searchTuple"],[class*="tupleNew"],.pageComponent')
          return {
            source: 'dom', cards: cards.length,
            items: [...cards].map(c => ({
              name: c.querySelector('[class*="name"],[class*="Name"],[class*="title"],h2,h3')?.textContent?.trim() || '',
              developer: c.querySelector('[class*="developer"],[class*="Developer"],[class*="builder"]')?.textContent?.trim() || '',
              location: c.querySelector('[class*="location"],[class*="Location"],[class*="locality"]')?.textContent?.trim() || '',
              price: c.querySelector('[class*="price"],[class*="Price"],[class*="amount"]')?.textContent?.trim() || '',
              bhk: c.querySelector('[class*="bhk"],[class*="BHK"],[class*="config"]')?.textContent?.trim() || '',
              possession: c.querySelector('[class*="possession"],[class*="Possession"]')?.textContent?.trim() || '',
              link: c.querySelector('a[href*="project"],a[href*="/property"]')?.href || c.querySelector('a')?.href || '',
            })).filter(p => p.name && p.name.length > 2),
          }
        })
        let found = []
        const walk = (obj, depth = 0) => {
          if (depth > 10 || !obj || typeof obj !== 'object') return
          if (Array.isArray(obj) && obj[0]) {
            const s = obj[0]
            if (s.projectName || s.ProjectName || s.name || s.project_name) {
              for (const item of obj) {
                const name = clean(item.projectName || item.ProjectName || item.name || item.project_name || '')
                if (name.length < 3) continue
                const price = parsePrice(String(item.priceRange || item.price || item.minPrice || ''))
                found.push({
                  name, developer: clean(item.developerName || item.developer || item.builderName || 'Unknown Developer'),
                  location: clean(item.locality || item.location || item.city || city),
                  city, state: 'Maharashtra',
                  bhk: parseBHK(item.bhkConfig || item.bhkRange || item.bhk || ''),
                  price_min: price.min, price_max: price.max, price_display: price.display || 'Price on request',
                  possession: parsePossession(item.possessionDate || item.possession || ''),
                  rera: !!(item.rera || item.reraNo || item.reraNumber || item.reraRegistered),
                  reraCode: item.reraNo || item.reraNumber || null,
                  listing_url: item.url ? (item.url.startsWith('http') ? item.url : `https://www.99acres.com${item.url}`) : null,
                  _source: '99acres',
                })
              }
              return
            }
          }
          for (const v of Object.values(obj)) walk(v, depth + 1)
        }
        if (data?.source === 'next' || data?.source?.includes('STATE') || data?.source === 'script') walk(data.data)
        else if (data?.source === 'dom' && data.items?.length > 0) {
          for (const r of data.items) {
            if (!r.name || r.name.length < 3) continue
            const price = parsePrice(r.price)
            found.push({
              name: clean(r.name), developer: clean(r.developer) || 'Unknown Developer',
              location: clean(r.location) || city, city, state: 'Maharashtra',
              bhk: parseBHK(r.bhk), price_min: price.min, price_max: price.max,
              price_display: price.display || 'Price on request',
              possession: parsePossession(r.possession), rera: false,
              listing_url: r.link?.startsWith('http') ? r.link : r.link ? `https://www.99acres.com${r.link}` : null,
              _source: '99acres',
            })
          }
        }
        console.log(`[99acres] ${city}: ${found.length} (src:${data?.source || 'none'})`)
        projects.push(...found)
        await page.close()
        await sleep(2500)
      } catch (e) { console.log(`[99acres] ${city}:`, e.message) }
    }
    return projects
  }

  async function scrapeMagicBricksSSR(browser) {
    const projects = []
    const URLS = {
      Mumbai: 'https://www.magicbricks.com/new-projects/new-residential-projects-in-mumbai',
      Thane: 'https://www.magicbricks.com/new-projects/new-residential-projects-in-thane',
      Pune: 'https://www.magicbricks.com/new-projects/new-residential-projects-in-pune',
      'Navi Mumbai': 'https://www.magicbricks.com/new-projects/new-residential-projects-in-navi-mumbai',
    }
    for (const [city, url] of Object.entries(URLS)) {
      cache.step = `MagicBricks -> ${city}...`
      console.log(`[magicbricks] ${city}`)
      try {
        const _ctxMB = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' })
        const page = await _ctxMB.newPage()
        await page.route('**/*.{png,jpg,gif,woff,woff2,mp4}', r => r.abort())
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
        await page.waitForTimeout(3500)
        const data = await page.evaluate(() => {
          try {
            const el = document.getElementById('__NEXT_DATA__')
            if (el) return { source: 'next', data: JSON.parse(el.textContent) }
          } catch (_) {}
          for (const k of ['__PRELOADED_STATE__', '__REDUX_STATE__', 'INITIAL_STATE']) {
            try { if (window[k]) return { source: k, data: window[k] } } catch (_) {}
          }
          const cards = document.querySelectorAll('.mb-srp__card,[class*="ProjectCard"],[class*="projectCard"],[class*="SrpCard"],[data-type="project"]')
          return {
            source: 'dom', cards: cards.length,
            items: [...cards].map(c => ({
              name: c.querySelector('[class*="title"],[class*="Title"],[class*="name"],h2,h3')?.textContent?.trim() || '',
              developer: c.querySelector('[class*="developer"],[class*="Developer"],[class*="builder"],[class*="promoter"]')?.textContent?.trim() || '',
              location: c.querySelector('[class*="location"],[class*="Location"],[class*="locality"]')?.textContent?.trim() || '',
              price: c.querySelector('[class*="price"],[class*="Price"],[class*="amount"]')?.textContent?.trim() || '',
              bhk: c.querySelector('[class*="bhk"],[class*="BHK"],[class*="config"],[class*="bedroom"]')?.textContent?.trim() || '',
              possession: c.querySelector('[class*="possession"],[class*="Possession"]')?.textContent?.trim() || '',
              link: c.querySelector('a[href*="project"],a[href*="new-project"]')?.href || c.querySelector('a')?.href || '',
            })).filter(p => p.name && p.name.length > 2),
          }
        })
        let found = []
        const walk = (obj, d = 0) => {
          if (d > 8 || !obj || typeof obj !== 'object') return
          if (Array.isArray(obj) && obj[0] && (obj[0].projectTitle || obj[0].ProjectTitle || obj[0].name)) {
            for (const item of obj) {
              const name = clean(item.projectTitle || item.ProjectTitle || item.name || item.title || '')
              if (name.length < 3) continue
              const price = parsePrice(String(item.priceRange || item.minPrice || ''))
              found.push({
                name, developer: clean(item.developerName || item.builderName || 'Unknown Developer'),
                location: clean(item.locality || item.location || city),
                city, state: 'Maharashtra',
                bhk: parseBHK(item.bhkConfig || item.bedrooms || ''),
                price_min: price.min, price_max: price.max, price_display: price.display || 'Price on request',
                possession: parsePossession(item.possessionDate || ''),
                rera: !!(item.reraId || item.rera), reraCode: item.reraId || null,
                listing_url: item.url ? `https://www.magicbricks.com${item.url}` : null,
                _source: 'magicbricks',
              })
            }
            return
          }
          for (const v of Object.values(obj)) walk(v, d + 1)
        }
        if (data?.source === 'next' || data?.source?.includes('STATE')) walk(data.data)
        else if (data?.source === 'dom' && data.items?.length > 0) {
          for (const r of data.items) {
            const price = parsePrice(r.price)
            found.push({
              name: clean(r.name), developer: clean(r.developer) || 'Unknown Developer',
              location: clean(r.location) || city, city, state: 'Maharashtra',
              bhk: parseBHK(r.bhk), price_min: price.min, price_max: price.max,
              price_display: price.display || 'Price on request',
              possession: parsePossession(r.possession), rera: false,
              listing_url: r.link?.startsWith('http') ? r.link : r.link ? `https://www.magicbricks.com${r.link}` : null,
              _source: 'magicbricks',
            })
          }
        }
        console.log(`[magicbricks] ${city}: ${found.length} (src:${data?.source || 'none'})`)
        projects.push(...found)
        await page.close()
        await sleep(2500)
      } catch (e) { console.log(`[magicbricks] ${city}:`, e.message) }
    }
    return projects
  }

  async function scrapeGoogleAds(browser) {
    const projects = []
    const _ctxG = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' })
    const page = await _ctxG.newPage()
    await page.route('**/*.{png,jpg,gif,woff,woff2,mp4,svg}', r => r.abort())
    for (const query of GOOGLE_QUERIES) {
      cache.step = `Google -> "${query.slice(0, 40)}..."`
      console.log(`[google] "${query.slice(0, 50)}"`)
      try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=in&hl=en&num=10`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForTimeout(1500 + Math.random() * 800)
        const results = await page.evaluate(() => {
          const items = []
          for (const el of document.querySelectorAll('div.g,.tF2Cxc,.uEierd,.d5oMvf,[data-sokoban-feature]')) {
            const h = el.querySelector('h3,div[role="heading"]')
            const d = el.querySelector('.VwiC3b,.MUxGbd,.yDYNvb,.lEBKkf,.IsZvec,.aCOpRe')
            const a = el.querySelector('a[href]')
            if (h && h.textContent.trim().length > 3) items.push({ title: h.textContent.trim(), desc: d?.textContent?.trim() || '', url: a?.href || '' })
          }
          for (const sl of document.querySelectorAll('.HiHjCd,.u3VIId,.fl,[class*="sitelink"] a')) {
            const t = sl.textContent?.trim()
            if (t && t.length > 4) items.push({ title: t, desc: '', url: sl.href || '', isSitelink: true })
          }
          return items
        })
        for (const r of results) {
          if (GENERIC.some(re => re.test(r.title))) continue
          const fullText = `${r.title} ${r.desc} ${r.url}`
          const dev = KNOWN_DEVS.find(d => fullText.toLowerCase().includes(d.toLowerCase()))
          if (!dev) continue
          let name = cleanProjectName(r.title)
          if (GENERIC.some(re => re.test(name))) continue
          if (name.length < 4 || name.length > 55) continue
          if (!/^[A-Z]/.test(name)) continue
          if (CORP_NAME_ONLY.test(name)) continue
          const price = parsePrice(`${r.title} ${r.desc}`)
          const bhk = parseBHK(`${r.title} ${r.desc}`)
          const combined = `${r.title} ${r.desc} ${r.url}`.toLowerCase()
          let city = 'Maharashtra', location = 'Maharashtra'
          for (const [k, v] of Object.entries(CITY_MAP)) {
            if (combined.includes(k)) { city = v; location = k.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '); break }
          }
          const possM = `${r.title} ${r.desc}`.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{4})/i)
          const possY = !possM && `${r.title} ${r.desc}`.match(/(?:by|in|possession|ready)\s*(20\d\d)/i)
          const possession = possM ? `${possM[1].slice(0, 3)} ${possM[2]}` : possY ? possY[1] : null
          projects.push({
            name: clean(name), developer: dev || 'Developer', location, city, state: 'Maharashtra',
            bhk, price_min: price.min, price_max: price.max, price_display: price.display || 'Price on request',
            possession, rera: /\brera\b/i.test(`${r.title} ${r.desc}`),
            listing_url: r.url?.startsWith('http') ? r.url : null, _source: 'google-ads',
          })
        }
        await sleep(1800 + Math.random() * 1000)
      } catch (e) { console.log('[google] error:', e.message) }
    }
    await page.close()
    const seen = new Set()
    return projects.filter(p => {
      const k = p.name.toLowerCase().replace(/\W/g, '')
      if (seen.has(k)) return false; seen.add(k); return true
    })
  }

  let isRunning = false
  async function runScrapers() {
    if (isRunning) { console.log('[server] Already running'); return }
    isRunning = true
    cache.status = 'running'
    cache.errors = []
    const startedAt = new Date()
    let browser
    try {
      if (!chromium) throw new Error('Playwright not available')
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] })
      const all = []
      const summary = []
      for (const [name, fn] of [
        ['MahaRERA', () => scrapeMahaRERA(browser)],
        ['99acres', () => scrape99AcresSSR(browser)],
        ['MagicBricks', () => scrapeMagicBricksSSR(browser)],
        ['Google Ads', () => scrapeGoogleAds(browser)],
      ]) {
        try {
          const results = await fn()
          all.push(...results)
          summary.push(`${name}(${results.length})`)
          console.log(`[server] ${name}: ${results.length}`)
        } catch (e) {
          cache.errors.push({ source: name, error: e.message })
          console.error(`[server] ${name}:`, e.message)
        }
      }
      const deduped = deduplicate(all)
      let scored = deduped
      if (scoreProjects) { try { scored = scoreProjects(deduped) } catch (_) {} }
      else scored.sort((a, b) => (b.indihomes_score || 0) - (a.indihomes_score || 0))
      const normalized = scored.map((p, i) => normalize(p, i))
      if (cache.projects.length >= 20 && normalized.length < cache.projects.length * 0.5) {
        cache.status = 'done'
        cache.nextRun = new Date(Date.now() + 60000).toISOString()
        cache.step = `Refresh returned only ${normalized.length} projects (sources likely blocked) — kept existing ${cache.projects.length}`
        console.warn(`[server] Weak scrape result (${normalized.length} vs ${cache.projects.length}) — NOT overwriting cache/snapshot`)
        return
      }
      cache.projects = normalized
      cache.totalFound = normalized.length
      cache.sources = summary
      cache.lastRun = startedAt.toISOString()
      cache.nextRun = new Date(Date.now() + 60000).toISOString()
      cache.status = 'done'
      cache.step = `Done - ${normalized.length} projects from ${summary.join(', ')}`
      console.log(`[server] Done: ${normalized.length} projects`)
      if (normalized.length) {
        try { db.saveProjectsSnapshot(normalized) } catch (e) { console.error('[db] snapshot save failed:', e.message) }
      }
      if (syncAzureSearch) syncAzureSearch()
      if (enrichProjectsWithRera) enrichProjectsWithRera().catch(e => console.error('[enrich] failed:', e.message))
    } catch (e) {
      cache.status = 'error'; cache.step = e.message
      cache.errors.push({ source: 'orchestrator', error: e.message })
      cache.nextRun = new Date(Date.now() + 60000).toISOString()
      console.error('[server] Fatal:', e.message)
    } finally {
      if (browser) try { await browser.close() } catch (_) {}
      isRunning = false
    }
  }

  return { scrapeMahaRERA, scrape99AcresSSR, scrapeMagicBricksSSR, scrapeGoogleAds, runScrapers, normalize, deduplicate }
}
