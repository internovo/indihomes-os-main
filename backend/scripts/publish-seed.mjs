#!/usr/bin/env node
/**
 * publish-seed.mjs — one-command re-seed of production.
 *
 * Picks the strongest projects snapshot from the LOCAL data.sqlite (most
 * projects, then most RERA), writes it to seed/projects-seed.json, commits,
 * pushes, and redeploys Railway. The server's boot-time self-heal then loads
 * this baseline on the hosted volume.
 *
 * Workflow:
 *   1. Locally: open the app, hit "Scrape now" to refresh data.sqlite.
 *   2. Run:  node scripts/publish-seed.mjs
 *
 * Flags:
 *   --no-push     regenerate the seed file only (no git push / deploy)
 *   --no-deploy   commit + push, but skip `railway up`
 */
import { DatabaseSync } from 'node:sqlite'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DB = path.join(ROOT, 'data.sqlite')
const SEED = path.join(ROOT, 'seed', 'projects-seed.json')

const args = new Set(process.argv.slice(2))
const run = (cmd) => { console.log(`$ ${cmd}`); execSync(cmd, { cwd: ROOT, stdio: 'inherit' }) }
const reraCount = (ps) => ps.filter(p => p && (p.reraCode || p.rera)).length

if (!fs.existsSync(DB)) {
  console.error(`No local DB at ${DB}. Run the app and scrape first.`)
  process.exit(1)
}

const db = new DatabaseSync(DB)

// Pick the strongest snapshot: most projects, tie-broken by most RERA.
const rows = db.prepare('SELECT id, data FROM projects_snapshot ORDER BY id DESC LIMIT 20').all()
let best = null
for (const r of rows) {
  let ps
  try { ps = JSON.parse(r.data) } catch { continue }
  const score = { id: r.id, projects: ps, n: ps.length, rera: reraCount(ps) }
  if (!best || score.n > best.n || (score.n === best.n && score.rera > best.rera)) best = score
}
if (!best) { console.error('No usable snapshot found.'); process.exit(1) }

const discovered = db.prepare('SELECT listing_url, rera, price_display, possession FROM discovered_rera').all()
  .map(r => ({ listingUrl: r.listing_url, rera: r.rera, priceDisplay: r.price_display, possession: r.possession }))

// Bundle the locally-scraped Project Intelligence cache so the hosted app can
// serve detailed per-project intel it can't scrape itself.
const intel = db.prepare('SELECT cache_key, name, builder, city, data FROM project_intel').all()
  .map(r => { try { return { cacheKey: r.cache_key, name: r.name, builder: r.builder, city: r.city, data: JSON.parse(r.data) } } catch { return null } })
  .filter(Boolean)

const seed = { projects: best.projects, discoveredRera: discovered, intel }
fs.mkdirSync(path.dirname(SEED), { recursive: true })
fs.writeFileSync(SEED, JSON.stringify(seed), 'utf-8')
console.log(`\nSeed written: ${best.n} projects / ${best.rera} RERA (snapshot #${best.id}), ${discovered.length} discovered-RERA rows, ${intel.length} intel entries.`)

if (args.has('--no-push')) { console.log('--no-push: stopping after seed file.'); process.exit(0) }

// Commit only if the seed actually changed.
const changed = execSync('git status --porcelain seed/projects-seed.json', { cwd: ROOT }).toString().trim()
if (!changed) { console.log('Seed unchanged — nothing to publish.'); process.exit(0) }

run('git add seed/projects-seed.json')
run(`git commit -q -m "chore: refresh production seed (${best.n} projects / ${best.rera} RERA)"`)
run('git push')

if (args.has('--no-deploy')) { console.log('--no-deploy: pushed; skipping railway up.'); process.exit(0) }

run('npx --yes @railway/cli up --service indihomes-api --detach')
console.log('\nDone. Railway is building; the self-heal seed loads on boot.')
