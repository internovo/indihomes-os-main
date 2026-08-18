'use strict'

// Lead Identification model (timeline row 7 — "Lead Capturing", Meta & Housing).
// Two jobs, kept separate on purpose:
//   1. normalize*(payload)  — turn a source-specific payload into one common
//      shape, so dedup/CRM never need to know which portal a lead came from.
//   2. normalizePhone + matchProjectFromText — the actual "identification"
//      logic: which real person is this, and which of our projects are they
//      asking about.

// Indian mobiles normalize to the bare 10-digit number (strip +91 / leading
// 0) — the canonical dedup key. Non-Indian numbers (NRI leads — e.g. +971
// Dubai enquiries on Housing.com, which really occur) keep their country
// code prefixed, so they're preserved rather than dropped, and the same
// person enquiring twice from the same foreign number still dedups.
function normalizePhone(raw, countryCode) {
  let digits = String(raw || '').replace(/\D/g, '')
  const cc = String(countryCode || '').replace(/\D/g, '')
  if (cc && cc !== '91') {
    if (digits.length < 7 || digits.length > 12) return null
    return `+${cc}${digits}`
  }
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  if (digits.length !== 10 || !/^[6-9]/.test(digits)) return null
  return digits
}

// Fuzzy-match free text (an enquiry subject/message) against our own project
// catalog — used wherever a source's payload doesn't cleanly carry a
// project field of its own. Token-overlap scoring, not embeddings: cheap,
// deterministic, good enough for "Enquiry for My Heaven Dombivli 2BHK".
function matchProjectFromText(text, projectCatalog = []) {
  const hay = String(text || '').toLowerCase()
  if (!hay.trim() || !projectCatalog.length) return null
  let best = null, bestScore = 0
  for (const name of projectCatalog) {
    const tokens = String(name).toLowerCase().split(/\s+/).filter(t => t.length > 2)
    if (!tokens.length) continue
    const hits = tokens.filter(t => hay.includes(t)).length
    const score = hits / tokens.length
    if (score > bestScore) { bestScore = score; best = name }
  }
  return bestScore >= 0.5 ? best : null // require at least half the project's name tokens present — avoids false positives on single common words
}

function pick(obj, keys) {
  for (const k of keys) if (obj?.[k] != null && obj[k] !== '') return obj[k]
  return null
}

// Generic website enquiry form — field names vary by whatever the form was
// built with, so every intake accepts common aliases rather than one fixed shape.
function normalizeWebsite(payload) {
  return {
    name: pick(payload, ['name', 'full_name', 'fullName']),
    email: pick(payload, ['email', 'email_address']),
    phone: normalizePhone(pick(payload, ['phone', 'mobile', 'phone_number', 'phoneNumber'])),
    project: pick(payload, ['project', 'project_name', 'projectName']),
    budget: pick(payload, ['budget']),
    configuration: pick(payload, ['configuration', 'config', 'bhk']),
    location: pick(payload, ['location', 'locality']),
    notes: pick(payload, ['notes', 'message', 'remarks', 'comments']),
    targetPossessionDate: pick(payload, ['targetPossessionDate', 'target_possession_date', 'possession']),
    userType: pick(payload, ['user_type', 'userType']),
    sourceLeadId: pick(payload, ['id', 'enquiry_id']),
  }
}

// Meta Lead Ads — standard webhook/Graph API shape: an array of
// {name, values:[...]} question/answer pairs, not a flat object. Field
// "name" is whatever the ad form's question was mapped to, so this also
// accepts common variants rather than one exact key.
function normalizeMeta(payload) {
  const fields = {}
  for (const f of (payload.field_data || payload.fieldData || [])) {
    const key = String(f.name || '').toLowerCase()
    fields[key] = Array.isArray(f.values) ? f.values[0] : f.values
  }
  // Real field names confirmed against live Meta lead data — Indihomes' forms
  // don't carry a project field at all (each form IS one project; the form's
  // own name is the project — see server.cjs's syncMetaLeads, which passes
  // formName through here as `payload._formName`), and configuration comes
  // through as a lowercase run-together value ("3bhk") rather than "3 BHK".
  const rawConfig = pick(fields, ['what_configuration_are_you_looking_for?', 'configuration', 'bhk'])
  const configMatch = rawConfig && String(rawConfig).match(/(\d)\s*bhk/i)
  return {
    name: pick(fields, ['full_name', 'name']),
    email: pick(fields, ['email']),
    phone: normalizePhone(pick(fields, ['phone_number', 'phone'])),
    // Meta leads are identified by ad_id/form_id, not by a project field —
    // project is still attempted (form name / matched catalog entry) but a
    // Meta lead with none is expected and must render fine, never crash.
    project: pick(fields, ['project', 'project_name', 'which_project_are_you_interested_in?']) || payload._formName || null,
    budget: pick(fields, ['budget', 'what_is_your_budget?']),
    configuration: configMatch ? `${configMatch[1]} BHK` : rawConfig || null,
    location: pick(fields, ['location', 'city']),
    sourceLeadId: payload.leadgen_id || payload.leadgenId || payload.id || null,
    adId: payload.ad_id || null,
    // form_id isn't part of the Graph API's per-lead field list (it's
    // implicit from the /{form_id}/leads endpoint used to fetch it) —
    // server.cjs's syncMetaLeads injects it as _formId before normalizing.
    formId: payload.form_id || payload._formId || null,
    campaignId: payload.campaign_id || null,
  }
}

// Housing.com get-builder-leads — real payload shape confirmed against the
// live API: lead_name / lead_phone / lead_email / project_name /
// apartment_names ("2 BHK") / locality_name / city_name / min_price /
// max_price (rupees) / project_id / lead_date (epoch seconds). The earlier
// guessed aliases are kept as fallbacks in case other Housing products
// (rentals, resale) use different names.
function formatINR(n) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (n >= 1e5) return `₹${Math.round(n / 1e5)} L`
  return `₹${n}`
}
function normalizeHousing(payload, projectCatalog = []) {
  const text = pick(payload, ['enquiry', 'message', 'subject', 'remarks']) || ''
  const minP = payload.min_price, maxP = payload.max_price
  const budget = minP && maxP ? `${formatINR(minP)} - ${formatINR(maxP)}` : (pick(payload, ['budget']) || null)
  // Housing's own data sometimes carries a literal "undefined" where the
  // buyer's name should be (e.g. "undefined (Owner)") — strip it so the
  // inbox shows a clean blank instead of junk.
  const rawName = pick(payload, ['lead_name', 'name', 'customer_name', 'customerName'])
  const cleanName = rawName ? String(rawName).replace(/\bundefined\b/gi, '').replace(/\s+/g, ' ').trim() || null : null
  return {
    name: cleanName === '(Owner)' ? null : cleanName,
    email: pick(payload, ['lead_email', 'email', 'customer_email']),
    phone: normalizePhone(pick(payload, ['lead_phone', 'phone', 'mobile', 'customer_phone', 'customerPhone']), payload.country_code),
    project: pick(payload, ['project_name', 'project', 'listing_title']) || matchProjectFromText(text, projectCatalog),
    budget,
    configuration: pick(payload, ['apartment_names', 'configuration', 'bhk', 'unit_type']),
    location: [payload.locality_name, payload.city_name].filter(Boolean).join(', ') || pick(payload, ['location', 'locality']),
    sourceLeadId: payload.project_id != null && payload.lead_date != null
      ? `${payload.project_id}-${payload.lead_date}` // API has no per-lead id; project+timestamp is the closest stable key
      : pick(payload, ['lead_id', 'enquiry_id', 'id']),
  }
}

const NORMALIZERS = { meta: normalizeMeta, website: normalizeWebsite, housing: normalizeHousing }

// Single normalization entry point — server.cjs's universal intake endpoint
// calls this, then hands the result to db.intakeLead() for the actual
// dedup/merge. `source` must be one of NORMALIZERS' keys, or any other
// string (99acres, magicbricks, referral, walkin) is accepted verbatim and
// treated as already-flat data (normalizeWebsite's generic aliasing covers it).
function normalizeLead(source, payload, projectCatalog = []) {
  const fn = NORMALIZERS[source] || normalizeWebsite
  const result = fn === normalizeHousing ? fn(payload, projectCatalog) : fn(payload)
  return { ...result, source }
}

module.exports = { normalizePhone, matchProjectFromText, normalizeLead }
