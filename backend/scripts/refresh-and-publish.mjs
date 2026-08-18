#!/usr/bin/env node
/**
 * refresh-and-publish.mjs — the full "keep the web fresh" cycle, hands-free.
 *
 * The hosted backend (Railway) sits on a datacenter IP that 99acres and
 * MagicBricks block, so it can't scrape live. This machine's residential IP
 * CAN. This script bridges that gap: it triggers a fresh local scrape, waits
 * for it to finish, then publishes the new snapshot to production.
 *
 *   1. POST http://localhost:3001/api/scrape   (local backend must be running)
 *   2. poll /api/status until the run completes
 *   3. run publish-seed.mjs  (regenerate seed -> commit -> push -> railway up)
 *
 * Run manually:   node scripts/refresh-and-publish.mjs
 * Or on a schedule (see scripts/register-refresh-task.ps1).
 *
 * Flags forwarded to publish-seed: --no-deploy (push only), --no-push (seed only).
 */
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API = process.env.LOCAL_API || 'http://localhost:3001'
const MAX_WAIT_MS = 6 * 60 * 1000
const forward = process.argv.slice(2).join(' ')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const log = (m) => console.log(`[refresh] ${new Date().toISOString()} ${m}`)

async function getJSON(url, opts) {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function main() {
  // 0. Confirm the local backend is up (it's the thing that can actually scrape).
  try {
    await getJSON(`${API}/api/status`)
  } catch {
    console.error(`Local backend not reachable at ${API}. Start it first: npm run server`)
    process.exit(1)
  }

  // 1. Trigger a fresh scrape.
  log('triggering local scrape...')
  await fetch(`${API}/api/scrape`, { method: 'POST' }).catch(() => {})

  // 2. Wait for it to finish.
  const started = Date.now()
  let last = ''
  // give the run a moment to flip into "running" before we watch for "done"
  await sleep(4000)
  while (Date.now() - started < MAX_WAIT_MS) {
    let s
    try { s = await getJSON(`${API}/api/status`) } catch { await sleep(5000); continue }
    if (s.step && s.step !== last) { log(s.step); last = s.step }
    if (s.status === 'done') {
      log(`scrape done: ${s.step}`)
      break
    }
    if (s.status === 'error') {
      console.error(`scrape errored: ${s.step}`)
      break
    }
    await sleep(5000)
  }

  // 3. Publish to production.
  log('publishing snapshot to production...')
  execSync(`node ${path.join(__dirname, 'publish-seed.mjs')} ${forward}`.trim(), {
    cwd: path.join(__dirname, '..'), stdio: 'inherit',
  })
  log('cycle complete.')
}

main().catch(e => { console.error(e); process.exit(1) })
