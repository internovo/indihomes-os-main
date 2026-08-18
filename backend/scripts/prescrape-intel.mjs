#!/usr/bin/env node
/**
 * prescrape-intel.mjs — warm the Project Intelligence cache locally.
 *
 * Hits the local /api/project-intel endpoint for each discovered project so the
 * detailed intel (competitors, RERA, price bands, infra, trend, lat/long) gets
 * scraped once on this residential IP and stored in SQLite. Once published, the
 * hosted app serves it straight from the DB cache — no live scrape needed.
 *
 *   node scripts/prescrape-intel.mjs            # top 25 projects w/ scrapable link
 *   node scripts/prescrape-intel.mjs --limit 60
 *   node scripts/prescrape-intel.mjs --all      # every discovered project (slow)
 *
 * Requires the local backend running (npm run server).
 */
const API = process.env.LOCAL_API || 'http://localhost:3001'
const args = process.argv.slice(2)
const all = args.includes('--all')
const limIdx = args.indexOf('--limit')
const LIMIT = all ? Infinity : (limIdx >= 0 ? parseInt(args[limIdx + 1]) : 25)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const scrapable = (u = '') => /npxid|pdpid|99acres\.com|magicbricks\.com/.test(u)

async function main() {
  let projects
  try {
    const r = await fetch(`${API}/api/projects`)
    projects = (await r.json()).projects || []
  } catch {
    console.error(`Local backend not reachable at ${API}. Start it: npm run server`); process.exit(1)
  }

  // Prioritise projects with a directly-scrapable listing link (fast, reliable),
  // then fall back to name-search for the rest if --all.
  const ranked = [...projects].sort((a, b) => (scrapable(b.listingUrl) ? 1 : 0) - (scrapable(a.listingUrl) ? 1 : 0))
  const targets = (all ? ranked : ranked.filter(p => scrapable(p.listingUrl))).slice(0, LIMIT)

  console.log(`Pre-scraping intel for ${targets.length} projects (of ${projects.length})...\n`)
  let ok = 0, cached = 0, fail = 0
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i]
    const tag = `[${i + 1}/${targets.length}] ${p.name}`
    try {
      const res = await fetch(`${API}/api/project-intel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: p.name, builder: p.builder || p.developer, city: p.city,
          listingUrl: p.listingUrl, reraCode: p.reraCode, bhk: p.bhk,
          possession: p.possession, priceDisplay: p.budgetLabel,
        }),
      })
      const d = await res.json()
      if (d._fromCache) { cached++; console.log(`${tag} — cached ✓`) }
      else if (d._scraped && !d._error) { ok++; console.log(`${tag} — scraped ✓ (${d._sources?.primary || 'ok'})`) }
      else { fail++; console.log(`${tag} — no data (${(d._error || '').slice(0, 60)})`) }
    } catch (e) {
      fail++; console.log(`${tag} — ERROR ${e.message}`)
    }
    await sleep(500)
  }
  console.log(`\nDone. scraped=${ok} cached=${cached} failed=${fail}`)
  console.log('Next: node scripts/publish-seed.mjs   to push this intel to the live web app.')
}

main().catch(e => { console.error(e); process.exit(1) })
