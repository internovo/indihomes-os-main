'use strict'

// Housing.com builder-leads pull client — implements the exact contract from
// the integration spec (GETTING LEADS.pdf): GET get-builder-leads with epoch
// date range, HMAC-SHA256(apiKey, currentTime) request signing, and the
// {apiErrors} / {data} response envelope. Uses global fetch instead of axios
// (no new dependency; same request shape).

const crypto = require('crypto')

const API_URL = process.env.HOUSING_API_URL || 'https://pahal.housing.com/api/v0/get-builder-leads'
const API_KEY = process.env.HOUSING_API_KEY || ''
const USER_ID = process.env.HOUSING_USER_ID || ''

function isConfigured() { return !!(API_KEY && USER_ID) }

function toEpochSeconds(date) {
  const d = new Date(date)
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${date}`)
  return Math.floor(d.getTime() / 1000)
}

function generateHash(currentTime) {
  return crypto.createHmac('sha256', API_KEY).update(String(currentTime)).digest('hex')
}

async function getLeads({ startDate, endDate, perPage = 100 }) {
  if (!isConfigured()) throw new Error('HOUSING_API_KEY / HOUSING_USER_ID not set')
  const startEpoch = toEpochSeconds(startDate)
  const endEpoch = toEpochSeconds(endDate)
  if (startEpoch > endEpoch) throw new Error('startDate cannot be after endDate')

  const currentTime = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    start_date: String(startEpoch),
    end_date: String(endEpoch),
    current_time: String(currentTime),
    hash: generateHash(currentTime),
    id: String(USER_ID),
    per_page: String(perPage),
  })

  const res = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(10000) })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(`Housing HTTP ${res.status}`)
    err.details = body
    throw err
  }
  if (body?.apiErrors) {
    const err = new Error('Housing API_ERROR')
    err.details = body.apiErrors
    throw err
  }
  return body?.data || []
}

module.exports = { isConfigured, getLeads }
