'use strict'

// ── MahaRERA registration-number verification ───────────────────────────────
//
// Answers ONE question: does this RERA registration number exist on the
// public Maharashtra register, and what project/promoter is it actually
// registered to?
//
// WHY THIS IS NOT THE THING WE JUST REMOVED. The 99acres/MagicBricks
// connector was deleted because it defeated those sites' bot protection to
// take listing inventory they protect. This is the opposite on every axis
// that matters:
//   - MahaRERA is a statutory PUBLIC DISCLOSURE register. It is published
//     so buyers can inspect it; inspecting it is the intended use.
//   - One plain GET per unique registration number, cached for 24h. A
//     registry record changes at most on an extension filing.
//   - No bot-detection circumvention of any kind. No browser, no headful
//     Chromium, no WAF workaround. If a plain GET stops working, that is
//     the register telling us no, and we report "unverified" rather than
//     finding a way around it.
//   - We take one record we already hold the key to, and use it only to
//     check our own claim. We do not enumerate, mirror or re-serve it.
//
// Verified live before this was written: a GET on projects-search-result
// with certificate_no returns the correct distinct record with no CAPTCHA
// (P51700079740 -> "Gami Avant"; P51800047979 -> "JEEVAN SHOBHA CHSL AND
// BHANSALI CHSL"). Name and pincode search do NOT work over GET — they
// return a stale session row — so this module deliberately supports lookup
// by number ONLY. Do not extend it to enumeration without re-verifying.

const SEARCH_URL = 'https://maharera.maharashtra.gov.in/projects-search-result'

const TIMEOUT_MS = Number(process.env.MAHARERA_TIMEOUT_MS || 8000)
// A registry record is stable between filings; a day is conservative.
const CACHE_TTL_MS = Number(process.env.MAHARERA_CACHE_TTL_MS || 24 * 60 * 60 * 1000)
// Never more than one in-flight request to a government host, and a floor
// between requests. Verification runs over at most the 8 displayed results,
// almost all of which are cache hits after the first search of the day.
const MIN_GAP_MS = Number(process.env.MAHARERA_MIN_GAP_MS || 350)
const ENABLED = String(process.env.MAHARERA_VERIFY_ENABLED ?? 'true') !== 'false'

// An honest, identifying User-Agent. Deliberately NOT the spoofed Chrome
// string the page-fetch path uses: this is a public register being read as
// intended, so there is nothing to disguise, and if the register would
// rather we did not, we want to be told plainly.
const USER_AGENT = 'IndiHomes-RERA-Verify/1.0 (+registration-number lookup; contact: tech@internovo.in)'

// MahaRERA registration numbers only. Gate before spending a request.
const MAHARERA_NUMBER_RE = /^P\d{11}$/i

const cache = new Map() // normalised number -> { data, ts }
let chain = Promise.resolve()
let lastAt = 0

function normalise(n) {
  return String(n || '').replace(/[\s/_-]/g, '').toUpperCase()
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|td|tr|li|h\d|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
}

// Reads the value that follows a label ("Pincode", "District"), which is how
// the result card is laid out. Label-driven, not position-driven, so a
// layout change moves a field to null rather than to a wrong value.
function valueAfterLabel(lines, label) {
  const i = lines.findIndex(l => l.toLowerCase() === label.toLowerCase())
  if (i === -1) return null
  for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
    const v = lines[j]
    if (!v || /^(state|pincode|district|certificate|last modified|extension certificate|application)$/i.test(v)) continue
    return v
  }
  return null
}

const NOISE_RE = /^(state|pincode|district|certificate|last modified|extension certificate|application|view details|view original application|find route|back|registered projects|revoked projects|search project|n\/a|maharashtra)$/i

function parseResult(html, wanted) {
  const text = stripTags(html)
  if (/no records? found/i.test(text)) {
    return { found: false, reason: 'not_found' }
  }
  const lines = text.split('\n')
  // Anchor on the registration number itself. Everything between it and the
  // first labelled row is the project name then the promoter.
  const idx = lines.findIndex(l => normalise(l).includes(normalise(wanted)))
  if (idx === -1) return { found: false, reason: 'not_found' }

  const after = []
  for (let j = idx + 1; j < Math.min(idx + 8, lines.length); j++) {
    const l = lines[j].replace(/\s*Find Route\s*$/i, '').trim()
    if (!l || NOISE_RE.test(l)) continue
    after.push(l)
    if (after.length === 3) break
  }
  // Never guess. If the shape isn't what we expect, say so — a wrong
  // "registered name" is worse than an honest "could not read it".
  if (after.length < 2) return { found: false, reason: 'unparsed' }

  return {
    found: true,
    project_name: after[0] || null,
    promoter_name: after[1] || null,
    district: valueAfterLabel(lines, 'District'),
    pincode: valueAfterLabel(lines, 'Pincode'),
  }
}

async function politeGet(url) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastAt))
    if (wait) await new Promise(r => setTimeout(r, wait))
    lastAt = Date.now()
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  })
  chain = run.then(() => {}, () => {})
  return run
}

function buildUrl(number) {
  const q = new URLSearchParams({
    project_name: '', project_location: '', promoter_name: '',
    certificate_no: number, project_completion_date: '',
    project_state: '', project_division: '', project_district: '',
    project_taluka: '', project_village: '', project_pincode: '',
    op: 'Search', form_id: 'projects_search_form',
  })
  return `${SEARCH_URL}?${q.toString()}`
}

function isMahareraNumber(n) {
  return MAHARERA_NUMBER_RE.test(normalise(n))
}

/**
 * Verify one registration number against the public register.
 *
 * Returns, always — never throws for a caller to forget to catch:
 *   { status, registration_number, project_name, promoter_name,
 *     district, pincode, source_url, checked_at, error }
 *
 * status is one of:
 *   'verified'   the number exists on the register (compare the name yourself)
 *   'not_found'  the register has no such number      -> show unverified
 *   'unchecked'  we could not reach or read it        -> show unverified
 *   'skipped'    not a MahaRERA-shaped number, or disabled
 *
 * 'unchecked' is deliberately distinct from 'not_found': "we could not
 * check" and "the register says no" are different claims, and only the
 * second is evidence of anything.
 */
async function verifyRegistrationNumber(number) {
  const n = normalise(number)
  const base = {
    registration_number: n || null, project_name: null, promoter_name: null,
    district: null, pincode: null, source_url: null,
    checked_at: new Date().toISOString(), error: null,
  }
  if (!ENABLED) return { ...base, status: 'skipped', error: 'MAHARERA_VERIFY_ENABLED=false' }
  if (!isMahareraNumber(n)) return { ...base, status: 'skipped', error: 'not a MahaRERA-shaped registration number' }

  const hit = cache.get(n)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { ...hit.data, cached: true }

  const url = buildUrl(n)
  let out
  try {
    const parsed = parseResult(await politeGet(url), n)
    out = parsed.found
      ? { ...base, status: 'verified', source_url: url, project_name: parsed.project_name,
          promoter_name: parsed.promoter_name, district: parsed.district, pincode: parsed.pincode }
      : { ...base, status: parsed.reason === 'unparsed' ? 'unchecked' : 'not_found', source_url: url,
          error: parsed.reason === 'unparsed' ? 'result page shape not recognised' : null }
  } catch (e) {
    // Reaching the register failed. That says nothing about the number.
    out = { ...base, status: 'unchecked', source_url: url, error: e.message }
  }
  // Cache a negative too — but only a real one. An 'unchecked' is a
  // transient failure of ours and must be retried, never remembered.
  if (out.status === 'verified' || out.status === 'not_found') cache.set(n, { data: out, ts: Date.now() })
  return out
}

/**
 * Does the registered project name plausibly correspond to the name we are
 * about to display next to this number?
 *
 * Deliberately lenient, because Mumbai redevelopments are routinely
 * registered under the housing societies being redeveloped while being
 * marketed under a brand name. Live example: P51800047979 is registered as
 * "JEEVAN SHOBHA CHSL AND BHANSALI CHSL" (promoter HIRANI REALTORS LLP) and
 * marketed as "24k Residences by Hirani Group". That is not a fake number —
 * it is a normal, legitimate mismatch, and the honest response is to show
 * the registered name alongside, not to accuse the listing.
 *
 * So a name mismatch alone NEVER makes a number "unverified". It sets
 * name_matches=false, and the UI surfaces the registered name.
 */
function namesCorrespond(displayName, registeredName, promoterName) {
  const toks = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'ltd', 'llp', 'pvt', 'private', 'limited', 'chsl',
      'chs', 'group', 'realtors', 'realty', 'developers', 'builders', 'infra', 'projects',
      'project', 'residences', 'residence', 'tower', 'towers', 'apartment', 'apartments'].includes(w)))
  const a = toks(displayName)
  if (!a.size) return false
  for (const other of [registeredName, promoterName]) {
    const b = toks(other)
    if (!b.size) continue
    for (const w of a) if (b.has(w)) return true
  }
  return false
}

module.exports = {
  verifyRegistrationNumber,
  namesCorrespond,
  isMahareraNumber,
  // exported for tests
  _parseResult: parseResult,
  _stripTags: stripTags,
  _buildUrl: buildUrl,
}
