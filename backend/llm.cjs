'use strict'
/**
 * Provider-agnostic LLM client + the AI Property Intelligence Agent.
 *
 * Providers (auto-detected from env, in priority order):
 *   ANTHROPIC_API_KEY  -> Claude   (default; set LLM_MODEL to override, e.g. claude-3-5-sonnet-latest)
 *   GROQ_API_KEY       -> Groq     (Llama 3.3 70B — free/fast)
 *   GEMINI_API_KEY     -> Gemini   (Google AI Studio — free tier)
 *
 * Grounding rule: every agent function is fed our REAL scraped data and told to
 * rank/analyse only that — never to invent projects or facts.
 */

const PROVIDER = process.env.ANTHROPIC_API_KEY ? 'anthropic'
  : process.env.GROQ_API_KEY ? 'groq'
  : process.env.GEMINI_API_KEY ? 'gemini'
  : null

// Per-provider model defaults; override with the provider-specific env var
// (a single shared LLM_MODEL breaks whichever provider it wasn't written for).
const MODELS = {
  anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  groq:      process.env.GROQ_MODEL      || 'llama-3.3-70b-versatile',
  gemini:    process.env.GEMINI_MODEL    || 'gemini-2.0-flash',
}

function isConfigured() { return !!PROVIDER }
function providerName() { return PROVIDER || 'none' }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Wrap fetch with retry-on-429 (rate limit). Free tiers (esp. Groq's 12k TPM)
// throttle bursts; we honour the provider's "try again in Ns" hint when present.
async function fetchWithRetry(url, opts, tries = 5) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const res = await fetch(url, opts)
    if (res.status !== 429) return res
    const body = await res.text()
    const m = body.match(/try again in ([\d.]+)\s*s/i)
    const waitMs = Math.min(15000, m ? (parseFloat(m[1]) * 1000 + 400) : (1500 * (attempt + 1)))
    if (attempt === tries - 1) { const e = new Error(`rate limited: ${body.slice(0,200)}`); e.status = 429; throw e }
    await sleep(waitMs)
  }
}

async function llmComplete({ system, user, maxTokens = 4096, json = false, temperature = 0.15 }) {
  if (!PROVIDER) throw new Error('No LLM key configured. Set ANTHROPIC_API_KEY (or GROQ_API_KEY / GEMINI_API_KEY).')
  const sys = json ? `${system}\n\nRespond with ONLY valid JSON. No prose, no markdown fences.` : system

  if (PROVIDER === 'anthropic') {
    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODELS.anthropic, max_tokens: maxTokens, system: sys, temperature,
        messages: [{ role: 'user', content: user }] }),
    })
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const d = await res.json()
    return d.content?.[0]?.text || ''
  }

  if (PROVIDER === 'groq') {
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODELS.groq, max_tokens: maxTokens, temperature,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    })
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const d = await res.json()
    return d.choices?.[0]?.message?.content || ''
  }

  // gemini
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${process.env.GEMINI_API_KEY}`
  const res = await fetchWithRetry(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d = await res.json()
  return d.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

// Claude's native, server-side web search tool — Claude runs the search
// itself (Anthropic's own infrastructure) and incorporates real results into
// its answer in one API call. This replaces the old pattern of fetching
// results from a separate provider (Tavily) and stuffing them into the
// prompt: one fewer moving part, one fewer API key/quota to run out of, and
// it's what the user asked for — Claude doing its own search, not a
// third-party search API Claude merely reads.
function webSearchAvailable() { return PROVIDER === 'anthropic' }
async function webSearchComplete({ system, user, maxTokens = 4096, json = false }) {
  if (PROVIDER !== 'anthropic') throw new Error('Live web search requires the Anthropic (Claude) provider.')
  const sys = json ? `${system}\n\nAfter you finish searching, respond with ONLY a valid JSON object as your final message. No prose, no markdown fences — just the JSON.` : system
  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODELS.anthropic, max_tokens: maxTokens, system: sys, temperature: 0.15,
      messages: [{ role: 'user', content: user }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d = await res.json()
  const textBlocks = (d.content || []).filter(b => b.type === 'text')
  const text = textBlocks.map(b => b.text).join('\n')
  const sources = []
  for (const b of textBlocks) {
    for (const c of (b.citations || [])) {
      if (c.url && !sources.some(s => s.url === c.url)) sources.push({ url: c.url, title: c.title || c.cited_text?.slice(0, 80) || c.url })
    }
  }
  return { text, sources }
}

// Robustly pull a JSON object/array out of an LLM response.
function parseJSON(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch (_) {}
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  try { return JSON.parse(cleaned) } catch (_) {}
  const start = cleaned.search(/[[{]/)
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
  if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)) } catch (_) {} }
  return null
}

// ── AGENT 1: natural-language query -> structured filters ─────────────────────
async function extractFilters(query) {
  const text = await llmComplete({
    system: `You extract structured real-estate search filters from a natural-language query for the Indian (Maharashtra) market.
Return JSON with these keys (use null / [] when not stated):
{"location":[], "budget":"", "budget_max_cr":null, "configuration":"", "possession":"", "builder":"", "requirements":""}
- location: array of area/city names mentioned.
- budget: verbatim budget phrase; budget_max_cr: numeric max budget in Crores (e.g. 1.75) or null.
- configuration: e.g. "2 BHK".
- possession: year or phrase (e.g. "2027", "ready to move").
- requirements: any other preferences (amenities, connectivity, etc.).`,
    user: query, json: true, maxTokens: 500,
  })
  return parseJSON(text) || { location: [], budget: '', budget_max_cr: null, configuration: '', possession: '', builder: '', requirements: '' }
}

// ── AGENT 2: rank/score/categorise REAL candidate projects ────────────────────
async function rankProjects(requirements, candidates) {
  const slim = candidates.map(p => ({
    name: p.name, developer: p.builder, city: p.city, location: p.location,
    configuration: p.config, price: p.budgetLabel, budget_min_l: p.budgetMin, budget_max_l: p.budgetMax,
    possession: p.possession, rera: p.reraCode || null, amenities: (p.amenities || []).slice(0, 8),
  }))
  const text = await llmComplete({
    system: `You are an expert Real Estate Research Analyst for IndiHomes.
You are given USER REQUIREMENTS and a list of CANDIDATE PROJECTS (already scraped from RERA/99acres/MagicBricks — this is real data).
Rank ONLY these candidates against the requirements. NEVER invent projects, prices, or RERA numbers. Use only the provided fields; if a field is missing, say so — do not fabricate.

For each project assign a match_score (0-100) and a one-line "why" explaining the match. For partial matches, state the exact gap (e.g. "budget exceeds by ~₹10L", "possession later than requested", "config unavailable").
Categorise every candidate into exactly one bucket:
- primary_matches: strong fit (score >= 80)
- secondary_matches: good fit with minor gaps (60-79)
- stretch_matches: notable gaps but relevant (40-59)
- excluded_projects: poor fit (<40) — include a short reason.

Return JSON:
{"executive_summary":"2-4 sentence overview of what was found and the top picks",
 "primary_matches":[{"name":"","match_score":0,"why":""}],
 "secondary_matches":[{"name":"","match_score":0,"why":""}],
 "stretch_matches":[{"name":"","match_score":0,"why":""}],
 "excluded_projects":[{"name":"","reason":""}]}
Use the exact project "name" strings from the candidates so results can be linked back.`,
    user: `USER REQUIREMENTS:\n${JSON.stringify(requirements, null, 2)}\n\nCANDIDATE PROJECTS (${slim.length}):\n${JSON.stringify(slim)}`,
    json: true, maxTokens: 4096,
  })
  return parseJSON(text) || { executive_summary: '', primary_matches: [], secondary_matches: [], stretch_matches: [], excluded_projects: [] }
}

// ── AGENT 3: per-project due-diligence, grounded in scraped intel + web research ─
async function dueDiligence(project, intel) {
  const facts = {
    name: project.name, developer: project.builder, city: project.city, location: intel?.location || project.location,
    configuration: project.config, price: intel?.priceRange || project.budgetLabel,
    possession: (intel?.possession && intel.possession !== 'TBD') ? intel.possession : project.possession,
    rera: intel?.rera || project.reraCode || null,
    amenities: intel?.amenities || project.amenities || [],
    infra_nearby: (intel?.infra || []).map(i => i.name || i).slice(0, 12),
    latitude: intel?.latitude, longitude: intel?.longitude,
    competitors: (intel?.competitors || []).map(c => c.name || c).slice(0, 6),
    configs_carpet_price: intel?.configs || intel?.priceBands || null,
    connectivity: intel?.connectivity || null,
    nearby: intel?.nearby || null,
    usps: intel?.usps || [],
    pros_found: intel?.pros || [],
    cons_found: intel?.cons || [],
    description: (intel?.description || '').slice(0, 1200),
    sources: intel?._webSources || intel?._sources || project.sources || null,
  }
  const text = await llmComplete({
    system: `You are a Real Estate Due Diligence Analyst for IndiHomes.
Analyse the project using ONLY the FACTS provided (scraped from RERA/99acres/MagicBricks + live web research + OpenStreetMap). Be factual. Do NOT hallucinate. Where a fact is genuinely missing from the FACTS, write "Not available" — never guess numbers or RERA IDs. Use every fact that IS present (RERA, configs with carpet/price, amenities, connectivity, nearby infrastructure) rather than claiming it is missing.

Return JSON with these keys (each a CONCISE string — 2-3 sentences max, except pros/cons/risks which are short string arrays):
{"project_overview":"","builder_profile":"","rera_verification":"","price_analysis":"","configuration_analysis":"","carpet_area_analysis":"","amenities_summary":"","connectivity_analysis":"","nearby_infrastructure":"","pros":[],"cons":[],"investment_potential":"","end_user_potential":"","risk_factors":[],"ai_summary":"","sources_used":[],"missing_information":[]}`,
    user: `FACTS:\n${JSON.stringify(facts, null, 2)}`,
    json: true, maxTokens: 4500,
  })
  return parseJSON(text)
}

// ── AGENT 4: structure a raw listing into the fields the UI boxes need ─────────
// Scraped project descriptions are prose that already contain the inventory,
// USPs, per-config carpet/price, possession, RERA etc. This parses that prose
// into structured fields AND writes a clean summary — strictly extractive, no
// invented values (missing -> null / []).
async function structureListing(intel) {
  const raw = {
    name: intel.name, builder: intel.builder || intel.developer,
    description: (intel.description || intel.descriptionRaw || '').slice(0, 4000),
    amenities: intel.amenities || [],
    rera: intel.rera || null,
    known_configs: intel.configs || [],
  }
  if (!raw.description && !(raw.amenities || []).length) return null
  const text = await llmComplete({
    system: `You extract structured facts from a real-estate project listing. Use ONLY the provided text — never invent numbers, prices, carpet areas, RERA IDs, or possession dates. If a value isn't in the text, use null (or [] for lists).

Return JSON:
{
 "summary": "clean 2-3 sentence project summary written from the description",
 "configs": [{"type":"2 BHK","carpet":"650 sq.ft.","price":"₹1.2 Cr"}],
 "usps": ["short unique selling points pulled from the text"],
 "amenities": ["amenities mentioned"],
 "possession": "possession date/phrase if stated, else null",
 "total_units": null,
 "towers": null,
 "price_range": "overall price range if stated, else null",
 "rera": "RERA registration number ONLY if it literally appears in the text, else null"
}`,
    user: `LISTING:\n${JSON.stringify(raw)}`,
    json: true, maxTokens: 1500,
  })
  return parseJSON(text)
}

// ── AGENT 5: DYNAMIC web research -> fill every box from live sources ──────────
// Claude searches the live web itself (native tool, see webSearchComplete)
// for this specific project and extracts a factual profile — no separate
// search provider fetching pages for Claude to read secondhand.
async function researchFromWeb(project, excludeRera = null) {
  const market = project.market === 'dubai' ? 'dubai' : 'india'
  const regHint = market === 'dubai'
    ? `Registration extraction is important — search specifically for "${project.name} DLD registration" or "${project.name} Dubai Land Department" if it's not immediately visible. UAE projects are registered with the Dubai Land Department (DLD), not India's RERA — report exactly what you find (a DLD project number, "oqood"/registration status), do not force an Indian RERA-shaped format onto it.`
    : `RERA extraction is important — search specifically for "${project.name} RERA registration number" if it's not immediately visible on the first pages you find. The exact format depends on the state (Maharashtra uses "P" or "A" + digits like P51700012345; other states use their own state RERA authority's format) — report exactly what you find, do not force it into the Maharashtra pattern if the project is elsewhere.`
  const { text, sources } = await webSearchComplete({
    system: `You are a real-estate research analyst with live web search. Search the web for the project "${project.name}"${project.builder ? ` by ${project.builder}` : ''}${project.city ? ` in ${project.city}` : ''} and extract a factual profile from what you actually find. Never invent values; use null / [] for anything you can't verify from a real source.

${regHint}

Competitors: note any OTHER nearby residential projects actually mentioned while you're searching (comparison pages, "similar projects" sections, area overviews) — never invent ones.

Return JSON:
{
 "summary": "2-3 sentence factual overview",
 "rera": "RERA number if you found one, else null",
 "developer": "",
 "location": "",
 "possession": "",
 "price_range": "",
 "configs": [{"type":"2 BHK","carpet":"","price":""}],
 "amenities": [],
 "connectivity": "nearby metro/road/rail/airport if mentioned",
 "nearby": ["short list of nearby schools/hospitals/malls/landmarks actually named in what you found — each its own short item, not a sentence"],
 "competitors": [{"name":"","builder":null,"price":null,"status":null}],
 "usps": [],
 "pros": [],
 "cons": []
}`,
    user: `Research this project now.`,
    json: true, maxTokens: 2500,
  })
  const parsed = parseJSON(text)
  if (parsed) parsed._allSources = sources.map((s, i) => ({ n: i + 1, title: s.title, url: s.url }))
  return parsed
}

// discoverProjectsFromWeb (AGENT 6) and analystReport (AGENT 7) — the
// Claude-live-web-search "conversational search" pair — were removed here.
// Confirmed via grep against server.cjs before removal: zero callers
// anywhere (server.cjs's own comment at its old /api/ai-chat route already
// documented these as "never wired into any frontend screen"; that route
// itself was already retired to a 501 stub). AI Search's new agent
// (ai-search-agent/, a LangGraph pipeline — see its README) is the
// intentional, non-Claude replacement for what these two functions used to
// do. `researchFromWeb`/`dueDiligence` below are NOT dead — they still
// back /api/ai-research's and /api/ai-analyze's Claude-web-research branch
// (permanently inert in this deployment, no ANTHROPIC_API_KEY by design,
// but the route itself remains live for its official-IndiHomes-data path).

module.exports = { isConfigured, providerName, extractFilters, rankProjects, dueDiligence, structureListing, researchFromWeb, llmComplete, webSearchComplete, webSearchAvailable }
