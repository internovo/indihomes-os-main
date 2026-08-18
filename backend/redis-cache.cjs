'use strict'

// AI Search result cache — Redis-backed, fully optional. Every AI Search
// query re-runs the full connector fan-out (Google/Bing/Apify/legacy portal
// scraper/LangGraph agent) even for an identical query moments apart; this
// caches the final response so a repeat search is near-instant instead of
// re-doing all of that work.
//
// Same optional-dependency pattern already used elsewhere in this codebase
// (e.g. server.cjs's `try { chromium = require('playwright').chromium }
// catch(e) {}`) — if `ioredis` isn't installed, or REDIS_URL isn't set, or
// the Redis server is unreachable, every function here becomes a silent
// no-op and callers fall straight through to a normal uncached search.
// Never throws, never blocks a request.

let Redis = null
try { Redis = require('ioredis') } catch (_) { /* ioredis not installed — cache stays disabled */ }

let client = null
let connectFailed = false

function isConfigured() {
  return !!(Redis && process.env.REDIS_URL && !connectFailed)
}

function getClient() {
  if (!Redis || !process.env.REDIS_URL) return null
  if (client) return client
  try {
    client = new Redis(process.env.REDIS_URL, {
      // Fail fast rather than hanging a request behind Redis retry logic —
      // a slow/unreachable Redis must never be slower than just not caching.
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // don't auto-reconnect-retry forever
      lazyConnect: false,
    })
    client.on('error', (e) => {
      // Logged once per distinct failure, not per request — ioredis emits
      // 'error' repeatedly on a down connection, which would otherwise spam
      // the log for every request that happens to hit it.
      if (!connectFailed) console.warn('[redis-cache] connection error, disabling cache for this process:', e.message)
      connectFailed = true
    })
  } catch (e) {
    console.warn('[redis-cache] failed to initialize:', e.message)
    connectFailed = true
    return null
  }
  return client
}

// Normalizes a query + market + explicit location filters into one stable
// cache key — lowercase, whitespace-collapsed, so "2 BHK in Malad" and
// "2  bhk  in  malad" hit the same cache entry. Deliberately does NOT try to
// normalize budget/config/possession phrasing beyond this (that's what
// query-parser.cjs's extraction is for) — this is a cache key, not a second
// parser; a slightly-differently-phrased query that the parser itself would
// treat the same way may still miss the cache, which just means a normal
// (uncached) search runs, never a wrong result.
function buildCacheKey(query, market, locations) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const locKey = (locations || []).map(l => String(l).trim().toLowerCase()).sort().join(',')
  return `ai-search:${market}:${q}::${locKey}`
}

const DEFAULT_TTL_SECONDS = 20 * 60 // 20 min — long enough to absorb a burst
// of repeat searches, short enough that listing data doesn't go stale.

async function getCachedSearch(query, market, locations) {
  const c = getClient()
  if (!c || connectFailed) return null
  try {
    const raw = await c.get(buildCacheKey(query, market, locations))
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    console.warn('[redis-cache] get failed (treating as cache miss):', e.message)
    return null
  }
}

async function setCachedSearch(query, market, locations, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const c = getClient()
  if (!c || connectFailed) return
  try {
    await c.set(buildCacheKey(query, market, locations), JSON.stringify(value), 'EX', ttlSeconds)
  } catch (e) {
    console.warn('[redis-cache] set failed (result was still returned to the client, just not cached):', e.message)
  }
}

module.exports = { isConfigured, getCachedSearch, setCachedSearch, buildCacheKey }
