'use strict'

const path = require('path')
const { DatabaseSync } = require('node:sqlite')

// On Railway/Render, set DB_PATH to a mounted persistent-volume path
// (e.g. /data/data.sqlite) — without that, the SQLite file lives on the
// container's ephemeral filesystem and is wiped on every redeploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite')
const db = new DatabaseSync(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS project_intel (
    cache_key   TEXT PRIMARY KEY,
    name        TEXT,
    builder     TEXT,
    city        TEXT,
    data        TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects_snapshot (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    data        TEXT NOT NULL,
    saved_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discovered_rera (
    listing_url   TEXT PRIMARY KEY,
    rera          TEXT NOT NULL,
    price_display TEXT,
    possession    TEXT,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS search_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mode          TEXT NOT NULL,
    query         TEXT,
    filters       TEXT,
    result_count  INTEGER,
    searched_at   INTEGER NOT NULL
  );
  -- Lead Capturing module (timeline row 7): one canonical row per real person,
  -- keyed by normalized phone. The same person enquiring via Meta and then
  -- Housing.com must resolve to ONE leads row, not two — lead_touches keeps
  -- every raw intake event for audit even after they've been merged.
  CREATE TABLE IF NOT EXISTS leads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone         TEXT NOT NULL,
    name          TEXT,
    email         TEXT,
    project       TEXT,
    budget        TEXT,
    configuration TEXT,
    location      TEXT,
    status        TEXT NOT NULL DEFAULT 'New',
    assigned_to   TEXT,
    primary_source TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
  CREATE TABLE IF NOT EXISTS lead_touches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER NOT NULL,
    source          TEXT NOT NULL,
    source_lead_id  TEXT,
    is_duplicate    INTEGER NOT NULL,
    raw_payload     TEXT NOT NULL,
    received_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_touches_lead ON lead_touches(lead_id);
  -- One row per Housing.com/Meta sync attempt (manual or hourly poll) — powers
  -- the Lead Capture "connected/last success/last failure" status UI, which
  -- today only finds out sync health transiently, on click.
  CREATE TABLE IF NOT EXISTS sync_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    status        TEXT NOT NULL,
    fetched       INTEGER,
    created       INTEGER,
    duplicates    INTEGER,
    error         TEXT,
    ran_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs(source, ran_at);
  -- One row per attempt to push a lead to the official IndiHomes CRM
  -- (createLead). Per-lead history, separate from sync_runs (which is
  -- per-source batch pulls, not per-lead pushes).
  CREATE TABLE IF NOT EXISTS crm_push_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT,
    pushed_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_crm_push_lead ON crm_push_log(lead_id);
`)

// Additive migration — `leads` predates `notes`/CRM-push tracking. SQLite has
// no "ADD COLUMN IF NOT EXISTS", so check PRAGMA table_info first; safe to
// run on every boot.
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}
ensureColumn('leads', 'notes', 'TEXT')
// crm_status: 'not_pushed' (default — either push is disabled, or hasn't been
// attempted/succeeded yet) | 'success' | 'failed'. Never 'disabled' on the
// row itself — whether push is enabled at all is a server-config question
// (indihomes-leads-client.cjs), not per-lead state.
ensureColumn('leads', 'crm_status', "TEXT NOT NULL DEFAULT 'not_pushed'")
ensureColumn('leads', 'crm_synced_at', 'INTEGER')
ensureColumn('leads', 'crm_error', 'TEXT')
// Scaffolding for the Lead Capture detail modal's WhatsApp Bot / AI Calling
// Agent summary sections — WhatsApp Agent and AI Calling Agent are today
// separate sidebar modules with no lead-level data pipeline into this table,
// so these stay NULL until such a pipeline exists. The detail modal shows an
// honest "not connected" state rather than fabricating a summary — same
// convention as crm_status above and every other real-vs-unavailable
// distinction already enforced across this app.
ensureColumn('leads', 'whatsapp_summary', 'TEXT')
ensureColumn('leads', 'whatsapp_summary_at', 'INTEGER')
ensureColumn('leads', 'call_summary', 'TEXT')
ensureColumn('leads', 'call_summary_at', 'INTEGER')
// Meta identification fields — Meta leads are identified by ad_id/form_id
// rather than by project name (which they often lack entirely).
ensureColumn('leads', 'ad_id', 'TEXT')
ensureColumn('leads', 'campaign_id', 'TEXT')
ensureColumn('leads', 'form_id', 'TEXT')
// Editable-detail-view fields not previously persisted anywhere.
ensureColumn('leads', 'possession_date', 'TEXT')
ensureColumn('leads', 'amenities', 'TEXT')
// Qualification taxonomy (see qualification.cjs). sub_status is a second,
// more specific tier under `status` (e.g. status='Qualified', sub_status=
// 'Budget match') — a DIFFERENT concept from crm_status (CRM-push outcome,
// untouched by any of this). `qualification` is the derived
// qualified/disqualified/unknown value qualification.classify() computes
// from status+sub_status — stored (not computed on every read) specifically
// so the Meta CAPI sweep can query "which leads changed qualification"
// cheaply, and so qualification_locked below has something concrete to
// protect.
ensureColumn('leads', 'sub_status', 'TEXT')
ensureColumn('leads', 'qualification', "TEXT NOT NULL DEFAULT 'unknown'")
// 'human' | 'auto' — who set the CURRENT qualification value. Not an
// audit trail (lead_edits already is one) — this is a live flag read by
// qualification.buildQualificationUpdate() on every new write attempt.
ensureColumn('leads', 'qualification_source', "TEXT NOT NULL DEFAULT 'human'")
// 0/1 — once a HUMAN sets qualification, this flips to 1 and a future
// auto-classifier (e.g. Sarvam call disposition) is refused from
// overwriting it. See qualification.cjs's module docstring for the full
// "robust system" rationale — this column is the entire enforcement
// mechanism for that rule.
ensureColumn('leads', 'qualification_locked', "INTEGER NOT NULL DEFAULT 0")
ensureColumn('leads', 'qualified_at', 'INTEGER')

db.exec(`
  -- Append-only field-edit history for the lead detail view's audit trail —
  -- same "append-only log, never mutated" shape as lead_touches.
  CREATE TABLE IF NOT EXISTS lead_edits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    field       TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    edited_by   TEXT,
    edited_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lead_edits_lead ON lead_edits(lead_id);
  -- One row per Meta Conversions API send attempt — mirrors crm_push_log's
  -- shape, keyed by the crm_status value each attempt reported so a state
  -- that's already been successfully reported is never re-sent, but a real
  -- transition (e.g. failed -> success on retry) sends a fresh event.
  CREATE TABLE IF NOT EXISTS meta_capi_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id       INTEGER NOT NULL,
    event_id      TEXT NOT NULL,
    crm_status    TEXT NOT NULL,
    status        TEXT NOT NULL,
    http_status   INTEGER,
    response_body TEXT,
    sent_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_meta_capi_lead ON meta_capi_log(lead_id);
  -- Append-only conversation-checkpoint log, fed by WATI chatbot-V1,
  -- Phase 2's campaign service, and (later) Sarvam's voice webhook — see
  -- lead-events.cjs and lead-journey.cjs. Every tick, tracker, and status
  -- projection the frontend shows is DERIVED from this table, never
  -- stored redundantly, so nothing can drift out of sync with what
  -- actually happened (same discipline as lead_touches/lead_edits above).
  --
  -- lead_id is nullable: an event can arrive for a phone that has no
  -- leads row yet (a WhatsApp message can land before any form
  -- intake has run) — see the orphan-adoption logic in intakeLead()
  -- below. idempotency_key is UNIQUE so a retried webhook (WATI, Phase 2,
  -- or Sarvam can all legitimately retry a failed POST) is silently
  -- deduped rather than double-logging the same checkpoint.
  CREATE TABLE IF NOT EXISTS lead_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER,
    phone           TEXT NOT NULL,
    channel         TEXT NOT NULL,
    checkpoint      TEXT NOT NULL,
    payload         TEXT,
    source_ref      TEXT,
    idempotency_key TEXT,
    occurred_at     INTEGER NOT NULL,
    received_at     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_events_idem ON lead_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_lead_events_phone ON lead_events(phone, occurred_at);
`)

const upsertIntelStmt = db.prepare(`
  INSERT INTO project_intel (cache_key, name, builder, city, data, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    name=excluded.name, builder=excluded.builder, city=excluded.city,
    data=excluded.data, fetched_at=excluded.fetched_at
`)
const getIntelStmt = db.prepare(`SELECT data, fetched_at FROM project_intel WHERE cache_key = ?`)
const allIntelStmt = db.prepare(`SELECT cache_key, name, builder, city, fetched_at FROM project_intel ORDER BY fetched_at DESC`)
const deleteIntelStmt = db.prepare(`DELETE FROM project_intel WHERE cache_key = ?`)

function saveIntel(cacheKey, { name, builder, city }, data) {
  upsertIntelStmt.run(cacheKey, name || '', builder || '', city || '', JSON.stringify(data), Date.now())
}

function getIntel(cacheKey) {
  const row = getIntelStmt.get(cacheKey)
  if (!row) return null
  try { return { data: JSON.parse(row.data), fetchedAt: row.fetched_at } }
  catch(_) { return null }
}

function listIntel() {
  return allIntelStmt.all()
}

// Full intel rows (including the JSON payload) — used to bundle the local intel
// cache into the published seed so the hosted app can serve Project Intelligence
// for projects it can't scrape itself (its datacenter IP is WAF-blocked).
const allIntelFullStmt = db.prepare(`SELECT cache_key, name, builder, city, data, fetched_at FROM project_intel`)
function getAllIntelFull() {
  return allIntelFullStmt.all().map(r => {
    try { return { cacheKey: r.cache_key, name: r.name, builder: r.builder, city: r.city, data: JSON.parse(r.data) } }
    catch { return null }
  }).filter(Boolean)
}

// Restore an intel row verbatim under a known cache_key (used by boot-time seed
// restore). Re-stamps fetched_at to now so restored intel stays within TTL.
function putIntel(cacheKey, { name, builder, city }, data) {
  upsertIntelStmt.run(cacheKey, name || '', builder || '', city || '', JSON.stringify(data), Date.now())
}

function deleteIntel(cacheKey) {
  deleteIntelStmt.run(cacheKey)
}

const insertSnapshotStmt = db.prepare(`INSERT INTO projects_snapshot (data, saved_at) VALUES (?, ?)`)
const latestSnapshotStmt = db.prepare(`SELECT data, saved_at FROM projects_snapshot ORDER BY id DESC LIMIT 1`)
const pruneSnapshotsStmt = db.prepare(`
  DELETE FROM projects_snapshot WHERE id NOT IN (SELECT id FROM projects_snapshot ORDER BY id DESC LIMIT 20)
`)

function saveProjectsSnapshot(projects) {
  insertSnapshotStmt.run(JSON.stringify(projects), Date.now())
  pruneSnapshotsStmt.run()
}

function getLatestProjectsSnapshot() {
  const row = latestSnapshotStmt.get()
  if (!row) return null
  try { return { projects: JSON.parse(row.data), savedAt: row.saved_at } }
  catch(_) { return null }
}

const upsertDiscoveredStmt = db.prepare(`
  INSERT INTO discovered_rera (listing_url, rera, price_display, possession, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(listing_url) DO UPDATE SET
    rera=excluded.rera, price_display=excluded.price_display,
    possession=excluded.possession, updated_at=excluded.updated_at
`)
const allDiscoveredStmt = db.prepare(`SELECT listing_url, rera, price_display, possession FROM discovered_rera`)

// Persists a project's RERA the moment it's first found via its listing link, so
// background enrichment (server.cjs enrichProjectsWithRera) never has to redo
// work that a previous scrape cycle or server run already did — without this,
// every fresh discovery scrape wipes cache.projects and starts RERA from scratch.
function saveDiscoveredRera(listingUrl, { rera, priceDisplay, possession }) {
  if (!listingUrl || !rera) return
  upsertDiscoveredStmt.run(listingUrl, rera, priceDisplay || '', possession || '', Date.now())
}

function getAllDiscoveredRera() {
  const map = new Map()
  for (const row of allDiscoveredStmt.all()) map.set(row.listing_url, row)
  return map
}

// Every search anyone runs (AI Search bar or Filter Search) — persisted so
// the whole team's search activity survives page reloads, browser sessions,
// and server redeploys (this table lives in the same DB_PATH volume as
// everything else, not in memory).
const insertSearchStmt = db.prepare(`
  INSERT INTO search_history (mode, query, filters, result_count, searched_at)
  VALUES (?, ?, ?, ?, ?)
`)
const listSearchStmt = db.prepare(`
  SELECT id, mode, query, filters, result_count, searched_at
  FROM search_history ORDER BY id DESC LIMIT ?
`)
const pruneSearchStmt = db.prepare(`
  DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY id DESC LIMIT 2000)
`)

function logSearch({ mode, query, filters, resultCount }) {
  insertSearchStmt.run(mode || 'unknown', query || null, filters ? JSON.stringify(filters) : null, resultCount ?? null, Date.now())
  pruneSearchStmt.run()
}

function listSearchHistory(limit = 100) {
  return listSearchStmt.all(limit).map(r => ({
    id: r.id, mode: r.mode, query: r.query,
    filters: (() => { try { return r.filters ? JSON.parse(r.filters) : null } catch { return null } })(),
    resultCount: r.result_count, searchedAt: r.searched_at,
  }))
}

const findLeadByPhoneStmt = db.prepare(`SELECT * FROM leads WHERE phone = ?`)
const insertLeadStmt = db.prepare(`
  INSERT INTO leads (phone, name, email, project, budget, configuration, location, notes, ad_id, campaign_id, form_id, status, assigned_to, primary_source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', NULL, ?, ?, ?)
`)
const updateLeadStmt = db.prepare(`
  UPDATE leads SET name=?, email=?, project=?, budget=?, configuration=?, location=?, notes=?, ad_id=?, campaign_id=?, form_id=?, updated_at=? WHERE id=?
`)
const insertTouchStmt = db.prepare(`
  INSERT INTO lead_touches (lead_id, source, source_lead_id, is_duplicate, raw_payload, received_at)
  VALUES (?, ?, ?, ?, ?, ?)
`)
const findTouchStmt = db.prepare(`
  SELECT id FROM lead_touches WHERE lead_id = ? AND source = ? AND source_lead_id = ? LIMIT 1
`)
// ai_whatsapp_active/ai_voice_active — cheap per-row projection of "did this
// channel ever reach this lead", for the list view's AI Activity column
// (see LeadCapture.jsx). Deliberately NOT the full getAiActivity() detail
// (checkpoint-level attempted/delivered/failed) — that stays a per-lead-
// detail-view-only query. These are plain EXISTS subqueries against
// idx_lead_events_lead (lead_id, occurred_at), so this scales fine even at
// the 5000-row cap listLeads() already allows; a plain boolean projection
// like this can never drift from lead_events since it's read fresh every call.
const listLeadsStmt = db.prepare(`
  SELECT leads.*,
    EXISTS(SELECT 1 FROM lead_events e WHERE e.lead_id = leads.id AND e.channel = 'whatsapp' AND e.checkpoint = 'template_sent') AS ai_whatsapp_active,
    EXISTS(SELECT 1 FROM lead_events e WHERE e.lead_id = leads.id AND e.channel = 'whatsapp' AND e.checkpoint = 'failed') AS ai_whatsapp_failed,
    EXISTS(SELECT 1 FROM lead_events e WHERE e.lead_id = leads.id AND e.channel = 'voice' AND e.checkpoint = 'call_connected') AS ai_voice_active,
    EXISTS(SELECT 1 FROM lead_events e WHERE e.lead_id = leads.id AND e.channel = 'voice' AND e.checkpoint IN ('call_no_answer','call_busy','call_failed')) AS ai_voice_failed
  FROM leads ORDER BY id DESC LIMIT ?
`)
const leadTouchesStmt = db.prepare(`SELECT * FROM lead_touches WHERE lead_id = ? ORDER BY received_at ASC`)

// Core of the Lead Identification model: one canonical row per phone number.
// A second intake for a phone that already exists fills in any fields the
// first intake left blank (never overwrites a value that's already there —
// the first real answer wins) and logs the event as a duplicate touch rather
// than creating a second lead. Returns the resolved canonical lead plus
// whether this specific intake was a duplicate.
function intakeLead({ phone, name, email, project, budget, configuration, location, notes, adId, campaignId, formId, source, sourceLeadId, rawPayload }) {
  const now = Date.now()
  const existing = findLeadByPhoneStmt.get(phone)
  if (existing) {
    updateLeadStmt.run(
      existing.name || name || null,
      existing.email || email || null,
      existing.project || project || null,
      existing.budget || budget || null,
      existing.configuration || configuration || null,
      existing.location || location || null,
      existing.notes || notes || null,
      existing.ad_id || adId || null,
      existing.campaign_id || campaignId || null,
      existing.form_id || formId || null,
      now, existing.id,
    )
    // A stable sourceLeadId (Meta leadgen_id, Housing project+timestamp key) that's
    // already been recorded for this lead means this is the exact same upstream
    // event re-arriving (hourly poll overlapping a manual sync, webhook + poll
    // both catching it, etc.) — not a new touch worth logging again. Without a
    // stable id there's nothing to dedupe against, so it's recorded as before.
    const alreadyTouched = sourceLeadId && findTouchStmt.get(existing.id, source, sourceLeadId)
    if (!alreadyTouched) insertTouchStmt.run(existing.id, source, sourceLeadId || null, 1, JSON.stringify(rawPayload || {}), now)
    // Best-effort: a lead_events adoption failure must never break a real
    // intake. Covers the case where an orphan event arrived for this
    // phone AFTER the lead already existed but BEFORE this particular
    // event got claimed (e.g. two intake sources racing) - see
    // adoptOrphanEvents' own docstring.
    try { adoptOrphanEvents(existing.id, phone) } catch (e) { console.error('[db] adoptOrphanEvents (existing lead) failed:', e.message) }
    return { lead: findLeadByPhoneStmt.get(phone), isDuplicate: true }
  }
  const info = insertLeadStmt.run(phone, name || null, email || null, project || null, budget || null, configuration || null, location || null, notes || null, adId || null, campaignId || null, formId || null, source, now, now)
  const leadId = info.lastInsertRowid
  insertTouchStmt.run(leadId, source, sourceLeadId || null, 0, JSON.stringify(rawPayload || {}), now)
  // A phone can message the WhatsApp bot (or get called by the voice
  // agent) before ANY form intake has ever run for them - those events
  // land with lead_id=NULL (see lead_events' CREATE TABLE comment above).
  // The moment this phone gets its first real leads row, claim them, so
  // the tracker isn't missing its earliest checkpoints. Best-effort, same
  // reasoning as the existing-lead branch above.
  try { adoptOrphanEvents(leadId, phone) } catch (e) { console.error('[db] adoptOrphanEvents (new lead) failed:', e.message) }
  return { lead: db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId), isDuplicate: false }
}

function listLeads(limit = 200) {
  return listLeadsStmt.all(limit)
}

// Thin wrapper around the existing findLeadByPhoneStmt (used internally by
// intakeLead() above) - exposed for lead-events.cjs's ingest endpoint,
// which needs to check "does a lead already exist for this phone" without
// duplicating the raw SQL, and without reaching into intakeLead()'s
// merge/dedup side effects (this is a plain read, not an intake).
function findLeadByPhone(phone) {
  return findLeadByPhoneStmt.get(phone)
}

const getLeadByIdStmt = db.prepare(`SELECT * FROM leads WHERE id = ?`)
function getLeadById(id) {
  return getLeadByIdStmt.get(id)
}

const deleteLeadStmt = db.prepare(`DELETE FROM leads WHERE id = ?`)
const deleteLeadTouchesStmt = db.prepare(`DELETE FROM lead_touches WHERE lead_id = ?`)
function deleteLead(id) {
  deleteLeadTouchesStmt.run(id)
  deleteLeadStmt.run(id)
}

function getLeadTouches(leadId) {
  return leadTouchesStmt.all(leadId)
}

const insertSyncRunStmt = db.prepare(`
  INSERT INTO sync_runs (source, status, fetched, created, duplicates, error, ran_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
const lastSyncRunStmt = db.prepare(`SELECT * FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 1`)
const lastSuccessRunStmt = db.prepare(`SELECT * FROM sync_runs WHERE source = ? AND status = 'success' ORDER BY id DESC LIMIT 1`)
const lastFailureRunStmt = db.prepare(`SELECT * FROM sync_runs WHERE source = ? AND status = 'failure' ORDER BY id DESC LIMIT 1`)
const listSyncRunsStmt = db.prepare(`SELECT * FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT ?`)
const pruneSyncRunsStmt = db.prepare(`
  DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 200)
`)

function recordSyncRun(source, { status, fetched, created, duplicates, error }) {
  insertSyncRunStmt.run(source, status, fetched ?? null, created ?? null, duplicates ?? null, error || null, Date.now())
  pruneSyncRunsStmt.run(source)
}

// Everything the Lead Capture status strip needs for one source in a single
// call: most recent run of any kind, plus the most recent success/failure
// specifically (a source can be failing right now but still show when it
// last worked, rather than only ever showing the latest failure).
function getSyncStatus(source, recentLimit = 5) {
  return {
    last: lastSyncRunStmt.get(source) || null,
    lastSuccess: lastSuccessRunStmt.get(source) || null,
    lastFailure: lastFailureRunStmt.get(source) || null,
    recentRuns: listSyncRunsStmt.all(source, recentLimit),
  }
}

function listSyncRuns(source, limit = 50) {
  return listSyncRunsStmt.all(source, limit)
}

// ── Official IndiHomes CRM push (createLead) tracking ───────────────────────
const insertCrmPushStmt = db.prepare(`
  INSERT INTO crm_push_log (lead_id, status, error, pushed_at) VALUES (?, ?, ?, ?)
`)
const updateLeadCrmStmt = db.prepare(`
  UPDATE leads SET crm_status=?, crm_synced_at=?, crm_error=? WHERE id=?
`)
const pruneCrmPushStmt = db.prepare(`
  DELETE FROM crm_push_log WHERE id NOT IN (SELECT id FROM crm_push_log WHERE lead_id = ? ORDER BY id DESC LIMIT 20)
`)
const lastCrmPushStmt = db.prepare(`SELECT * FROM crm_push_log ORDER BY id DESC LIMIT 1`)
const crmPushCountsStmt = db.prepare(`SELECT crm_status, COUNT(*) as n FROM leads GROUP BY crm_status`)
const leadCrmHistoryStmt = db.prepare(`SELECT * FROM crm_push_log WHERE lead_id = ? ORDER BY id DESC LIMIT ?`)

// Records one push attempt (success or failure) and updates the lead's own
// crm_status/crm_synced_at/crm_error — the lead row always reflects the
// latest attempt; crm_push_log keeps the full history per lead.
function recordCrmPush(leadId, { status, error }) {
  const now = Date.now()
  insertCrmPushStmt.run(leadId, status, error || null, now)
  pruneCrmPushStmt.run(leadId)
  updateLeadCrmStmt.run(status, status === 'success' ? now : null, error || null, leadId)
}

function getLeadCrmHistory(leadId, limit = 20) {
  return leadCrmHistoryStmt.all(leadId, limit)
}

// Aggregate CRM push health for the Lead Capture status strip: counts by
// status across all leads, plus the single most recent push attempt of any
// kind/outcome (so "last error" is visible even if most leads are fine).
function getCrmPushSummary() {
  const counts = { not_pushed: 0, success: 0, failed: 0 }
  for (const row of crmPushCountsStmt.all()) counts[row.crm_status] = row.n
  return { counts, lastPush: lastCrmPushStmt.get() || null }
}

// ── Lead detail view: editable fields + append-only audit trail ────────────
// Only these fields may be edited from the detail view — name/phone/
// created_at/crm_status are locked (phone is the dedup key, crm_status is
// CRM-push-driven, never manually overridden). Enforced here (not just in
// the UI) so a stray API call can't sneak past the lock either.
// 'status' (the CRM lifecycle stage — New/Contacted/Qualified/etc) goes
// through this exact same generic edit path as every other editable field:
// same audit trail (lead_edits), same "skip if unchanged" guard, same
// PATCH /api/leads/:id route. It is a distinct column from crm_status
// (push-delivery success/fail to the external IndiHomes CRM — see
// crm_push_log) and never touches it — editing status here never triggers
// a CRM push or Meta CAPI send by itself.
// 'status' and 'sub_status' are listed here so PATCH /api/leads/:id
// recognises them as legitimate fields (never reported in `rejected`) -
// but server.cjs's route handler pulls them OUT of the generic fields
// object before calling updateLeadFields() below, and routes them through
// updateLeadQualification() instead (see that function's docstring for why:
// a status/sub_status change has a real side effect - qualification.cjs's
// classify() + the human-lock - that a blind per-field UPDATE loop must
// never bypass).
const EDITABLE_LEAD_FIELDS = ['project', 'budget', 'configuration', 'location', 'email', 'possession_date', 'amenities', 'notes', 'status', 'sub_status']
const insertLeadEditStmt = db.prepare(`
  INSERT INTO lead_edits (lead_id, field, old_value, new_value, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?)
`)
const leadEditsStmt = db.prepare(`SELECT * FROM lead_edits WHERE lead_id = ? ORDER BY id DESC LIMIT ?`)

function logLeadEdit(leadId, field, oldValue, newValue, editedBy) {
  insertLeadEditStmt.run(leadId, field, oldValue ?? null, newValue ?? null, editedBy || null, Date.now())
}

function getLeadEdits(leadId, limit = 100) {
  return leadEditsStmt.all(leadId, limit)
}

// Applies a partial update to a lead, restricted to EDITABLE_LEAD_FIELDS,
// logging one lead_edits row per field that actually changed (skips fields
// that were sent but equal the current value — not a real edit). Returns
// the updated lead row plus the list of fields actually changed.
function updateLeadFields(leadId, fields = {}, editedBy = null) {
  const existing = getLeadByIdStmt.get(leadId)
  if (!existing) return null
  const changed = []
  for (const [key, value] of Object.entries(fields)) {
    if (!EDITABLE_LEAD_FIELDS.includes(key)) continue
    const oldValue = existing[key] ?? null
    const newValue = value === '' ? null : value
    if ((oldValue ?? null) === (newValue ?? null)) continue
    db.prepare(`UPDATE leads SET ${key} = ?, updated_at = ? WHERE id = ?`).run(newValue, Date.now(), leadId)
    logLeadEdit(leadId, key, oldValue, newValue, editedBy)
    changed.push(key)
  }
  return { lead: getLeadByIdStmt.get(leadId), changed }
}

// ── Meta Conversions API send log ───────────────────────────────────────────
// Retry-safe: a state (crm_status value) that was already sent successfully
// is never re-sent; a real transition (e.g. failed -> success) sends fresh.
const insertMetaCapiLogStmt = db.prepare(`
  INSERT INTO meta_capi_log (lead_id, event_id, crm_status, status, http_status, response_body, sent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
const lastSuccessfulCapiForStateStmt = db.prepare(`
  SELECT id FROM meta_capi_log WHERE lead_id = ? AND crm_status = ? AND status = 'success' LIMIT 1
`)
const metaCapiLogForLeadStmt = db.prepare(`SELECT * FROM meta_capi_log WHERE lead_id = ? ORDER BY id DESC LIMIT ?`)

function recordMetaCapiSend(leadId, { eventId, crmStatus, status, httpStatus, responseBody }) {
  insertMetaCapiLogStmt.run(leadId, eventId, crmStatus, status, httpStatus ?? null, responseBody ? String(responseBody).slice(0, 2000) : null, Date.now())
}

function hasSuccessfulCapiSend(leadId, crmStatus) {
  return !!lastSuccessfulCapiForStateStmt.get(leadId, crmStatus)
}

function getMetaCapiLog(leadId, limit = 20) {
  return metaCapiLogForLeadStmt.all(leadId, limit)
}

// The Meta leadgen_id for a lead — recorded as lead_touches.source_lead_id
// on intake (see server.cjs's syncMetaLeads), reused here rather than
// storing it a second time on the leads row itself.
const firstMetaTouchStmt = db.prepare(`
  SELECT source_lead_id FROM lead_touches WHERE lead_id = ? AND source = 'meta' AND source_lead_id IS NOT NULL ORDER BY received_at ASC LIMIT 1
`)
function getMetaLeadgenId(leadId) {
  return firstMetaTouchStmt.get(leadId)?.source_lead_id || null
}

// ── Lead events (WhatsApp/voice checkpoint log) ───────────────────────────────
// See lead-events.cjs (the router that calls these) and lead-journey.cjs
// (the ladder these get projected against). Every function here is a thin
// SQL wrapper - the actual "what does this mean" decisions live in
// lead-events.cjs / qualification.cjs, not here, matching how this file
// already keeps SQL separate from decision logic everywhere else.

const insertLeadEventStmt = db.prepare(`
  INSERT INTO lead_events (lead_id, phone, channel, checkpoint, payload, source_ref, idempotency_key, occurred_at, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

// Inserts one checkpoint event. Returns { inserted: true, id } on a fresh
// insert, or { inserted: false, deduped: true } if idempotency_key already
// exists (the UNIQUE index on lead_events.idempotency_key throws a
// constraint-violation error, which this catches and turns into a normal
// return value rather than letting it bubble up as a 500 - a retried
// webhook from WATI/Phase 2/Sarvam is an expected, NORMAL occurrence, not
// an error condition; see this task's design conversation, "Trap 8").
function insertLeadEvent({ leadId, phone, channel, checkpoint, payload, sourceRef, idempotencyKey, occurredAt }) {
  const now = Date.now()
  try {
    const info = insertLeadEventStmt.run(
      leadId ?? null, phone, channel, checkpoint,
      payload ? JSON.stringify(payload) : null,
      sourceRef || null, idempotencyKey || null,
      occurredAt ?? now, now,
    )
    return { inserted: true, id: info.lastInsertRowid, deduped: false }
  } catch (e) {
    // node:sqlite throws a generic Error whose message contains the
    // sqlite3 error string - matching on 'UNIQUE constraint failed' is
    // the same pattern this file already uses elsewhere in this codebase
    // (see the try/catch around ALTER TABLE ADD COLUMN above) since
    // node:sqlite does not expose a typed/coded error class to check
    // against instead.
    if (String(e.message || '').includes('UNIQUE constraint failed')) {
      return { inserted: false, deduped: true, id: null }
    }
    throw e
  }
}

const leadEventsForLeadStmt = db.prepare(`
  SELECT * FROM lead_events WHERE lead_id = ? ORDER BY occurred_at ASC
`)
function listLeadEventsForLead(leadId) {
  return leadEventsForLeadStmt.all(leadId).map(r => ({
    ...r,
    payload: (() => { try { return r.payload ? JSON.parse(r.payload) : null } catch { return null } })(),
  }))
}

const adoptOrphanEventsStmt = db.prepare(`
  UPDATE lead_events SET lead_id = ? WHERE phone = ? AND lead_id IS NULL
`)

// Called from intakeLead() below, every time a phone resolves to a lead
// (new or existing) - claims any events that arrived BEFORE this phone had
// a leads row (e.g. the customer messaged the WhatsApp bot before any form
// intake ever ran for them). See lead-events.cjs's module docstring for
// the full "orphan events" design note. Best-effort by design: called from
// inside intakeLead(), which must never fail an actual lead intake because
// of a tracker-table hiccup - wrapped in try/catch at the call site below,
// not here, so this function itself stays a plain, testable SQL operation.
function adoptOrphanEvents(leadId, phone) {
  if (!leadId || !phone) return 0
  const info = adoptOrphanEventsStmt.run(leadId, phone)
  return info.changes || 0
}

// ── AI Activity projection (the tick mascots) ─────────────────────────
// Computes the "did WhatsApp / did voice actually reach this lead" ticks
// straight from lead_events - never stored redundantly, so it can never
// drift from what the events actually say (see this task's design
// conversation for why a stored boolean tick was rejected in favor of
// this). One query per channel; cheap, and this is only called when a
// lead's detail view is open, not on every list render.
function getAiActivity(leadId) {
  const events = listLeadEventsForLead(leadId)
  const wa = events.filter(e => e.channel === 'whatsapp')
  const voice = events.filter(e => e.channel === 'voice')

  const findLast = (list, checkpoints) => {
    const matches = list.filter(e => checkpoints.includes(e.checkpoint))
    return matches.length ? matches[matches.length - 1] : null
  }

  const waSent = findLast(wa, ['template_sent'])
  const waDelivered = findLast(wa, ['delivered'])
  const waFailed = findLast(wa, ['failed'])
  const voiceAttempted = findLast(voice, ['call_attempted'])
  const voiceConnected = findLast(voice, ['call_connected'])
  const voiceFailed = findLast(voice, ['call_no_answer', 'call_busy', 'call_failed'])

  return {
    whatsapp: {
      attempted: !!waSent,
      attemptedAt: waSent ? waSent.occurred_at : null,
      delivered: !!waDelivered,
      deliveredAt: waDelivered ? waDelivered.occurred_at : null,
      failed: !!waFailed,
      failedAt: waFailed ? waFailed.occurred_at : null,
    },
    voice: {
      attempted: !!voiceAttempted,
      attemptedAt: voiceAttempted ? voiceAttempted.occurred_at : null,
      connected: !!voiceConnected,
      connectedAt: voiceConnected ? voiceConnected.occurred_at : null,
      failed: !!voiceFailed,
      failedAt: voiceFailed ? voiceFailed.occurred_at : null,
    },
  }
}

// ── Qualification writes (status / sub_status / the derived lock) ──────────
// THE single write path for status+sub_status - see EDITABLE_LEAD_FIELDS'
// comment above and qualification.cjs's module docstring. Returns
// { applied, reason, lead, changed } - `applied: false` (reason
// 'locked_by_human') means the write was correctly REFUSED, not an error;
// callers must check this rather than assuming every call succeeds.
function updateLeadQualification(leadId, { status, subStatus, source = 'human' }, editedBy = null) {
  const qualification = require('./qualification.cjs')
  const existing = getLeadByIdStmt.get(leadId)
  if (!existing) return { applied: false, reason: 'not_found', lead: null, changed: [] }

  const decision = qualification.buildQualificationUpdate(existing, { status, subStatus, source })
  if (!decision.applied) {
    return { applied: false, reason: decision.reason, lead: existing, changed: [] }
  }

  const changed = []
  for (const [key, value] of Object.entries(decision.fields)) {
    const oldValue = existing[key] ?? null
    const newValue = value === '' ? null : value
    if ((oldValue ?? null) === (newValue ?? null)) continue
    db.prepare(`UPDATE leads SET ${key} = ?, updated_at = ? WHERE id = ?`).run(newValue, Date.now(), leadId)
    // Only log the human-meaningful fields to the audit trail - the
    // derived bookkeeping columns (qualification_locked,
    // qualification_source, qualified_at) would just be noise in the
    // Activity feed, which already renders lead_edits rows verbatim.
    if (key === 'status' || key === 'sub_status' || key === 'qualification') {
      logLeadEdit(leadId, key, oldValue, newValue, editedBy)
    }
    changed.push(key)
  }
  return { applied: true, reason: null, lead: getLeadByIdStmt.get(leadId), changed }
}

module.exports = {
  saveIntel, getIntel, listIntel, deleteIntel,
  getAllIntelFull, putIntel,
  saveProjectsSnapshot, getLatestProjectsSnapshot,
  saveDiscoveredRera, getAllDiscoveredRera,
  logSearch, listSearchHistory,
  intakeLead, listLeads, getLeadById, getLeadTouches, deleteLead, findLeadByPhone,
  recordSyncRun, getSyncStatus, listSyncRuns,
  recordCrmPush, getLeadCrmHistory, getCrmPushSummary,
  EDITABLE_LEAD_FIELDS, updateLeadFields, logLeadEdit, getLeadEdits,
  recordMetaCapiSend, hasSuccessfulCapiSend, getMetaCapiLog, getMetaLeadgenId,
  insertLeadEvent, listLeadEventsForLead, adoptOrphanEvents, getAiActivity,
  updateLeadQualification,
}
