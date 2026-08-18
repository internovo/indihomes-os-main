'use strict'

// Meta Lead Ads client — Graph API directly (the spec's "can use GraphQL/
// Graph API instead" option) rather than the facebook-nodejs-business-sdk
// package: one GET per lead needs no SDK dependency.
//
// Flow: Meta's Lead Ads webhook (POST /api/meta-webhook) delivers only a
// leadgen_id — this client exchanges it for the actual lead (field_data,
// created_time), which then goes through the same normalize -> dedup intake
// as every other source.

// META_PAGE_ACCESS_TOKEN is the correct token type — a PAGE access token
// (leads_retrieval, pages_show_list, pages_read_engagement, ads_management
// scopes), not a user token. A user token here is exactly what produces
// Graph API's "(#10) User has insufficient privileges on the page" error.
// META_ACCESS_TOKEN is kept as a fallback name for back-compat with any
// existing .env that already set it.
const ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || ''
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0'

function isConfigured() { return !!ACCESS_TOKEN }

async function getLead(leadgenId) {
  if (!isConfigured()) throw new Error('META_PAGE_ACCESS_TOKEN not set')
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(leadgenId)}` +
    `?fields=field_data,created_time,ad_id,form_id,campaign_id&access_token=${encodeURIComponent(ACCESS_TOKEN)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.error) {
    const err = new Error(`Meta Graph ${res.status}: ${body?.error?.message || 'unknown error'}`)
    err.details = body?.error
    throw err
  }
  return body
}

// Pull path — lists every lead form on the page and fetches leads created
// since a given time, for the manual/hourly sync (mirrors housing-client.cjs).
// Complements the webhook: the webhook only carries NEW leads going forward;
// this is what backfills everything already sitting in these forms.
const PAGE_ID = process.env.META_PAGE_ID || ''

async function graphGet(path, params) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path}?${new URLSearchParams({ ...params, access_token: ACCESS_TOKEN })}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.error) {
    const err = new Error(`Meta Graph ${res.status}: ${body?.error?.message || 'unknown error'}`)
    err.details = body?.error
    throw err
  }
  return body
}

async function listForms() {
  if (!isConfigured() || !PAGE_ID) throw new Error('META_PAGE_ACCESS_TOKEN / META_PAGE_ID not set')
  const forms = []
  let next = null
  do {
    const body = next
      ? await fetch(next, { signal: AbortSignal.timeout(15000) }).then(r => r.json())
      : await graphGet(PAGE_ID + '/leadgen_forms', { fields: 'id,name,status,leads_count', limit: '100' })
    forms.push(...(body.data || []))
    next = body.paging?.next || null
  } while (next)
  // Include ALL forms (active and archived) that have at least 1 lead.
  // Filtering to ACTIVE-only silently drops older/archived forms which hold
  // the bulk of historical leads.
  return forms.filter(f => (f.leads_count || 0) > 0)
}

async function listLeadsForForm(formId, sinceEpoch) {
  const leads = []
  let next = null
  do {
    const body = next
      ? await fetch(next, { signal: AbortSignal.timeout(15000) }).then(r => r.json())
      // Only apply a time filter when sinceEpoch is non-zero; a zero/falsy
      // epoch means "fetch everything" (full backfill), and passing
      // GREATER_THAN 0 to the Graph API can itself filter out valid leads.
      : await graphGet(formId + '/leads', {
          fields: 'field_data,created_time,id,ad_id,campaign_id',
          ...(sinceEpoch ? { filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceEpoch }]) } : {}),
          limit: '100',
        })
    leads.push(...(body.data || []))
    next = body.paging?.next || null
  } while (next)
  return leads
}

module.exports = { isConfigured, getLead, listForms, listLeadsForForm }
