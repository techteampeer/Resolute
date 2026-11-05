// The real client registry, shared by every screen that needs to name a client.
//
// mockData's CLIENTS fixture holds seven companies. Admin's billing page looked
// a client up in it to put a name above each invoice block, and Admin's own
// order-intake form built its client <select> from it. Both are wrong the moment
// Resolute onboards anyone new — which the pilot client is. Demonstrated by
// inserting a real client (CL08, Harborline Title Co) with a delivered order:
// the billing header rendered "CL08" over "CL08 · Each invoice due upon receipt"
// with the company's name nowhere, and the intake form could not select them at
// all, so Admin could not place an order on their behalf.
//
// Same shape as useProfiles: cached at module scope, fetched once per page load,
// falling back to the fixture only when Supabase is not configured.
import { useEffect, useState } from 'react'
import { isSupabaseConfigured, fetchClients, createAdminClient } from './backend'
import { CLIENTS } from '../data/mockData'

// The one normalisation rule, mirrored from client_name_key() in
// 20260925000000_email_intake_client_resolution.sql, for the mock-mode match.
const nameKey = (s) => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[''’.]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim()

let cache = null
let inflight = null
const subscribers = new Set()

function load() {
  if (cache) return Promise.resolve(cache)
  if (!isSupabaseConfigured) { cache = CLIENTS; return Promise.resolve(cache) }
  if (!inflight) {
    inflight = fetchClients().then(rows => {
      // No fixture fallback here, deliberately. mockData's CLIENTS carries real
      // company names, and clients_read denies those to anyone who is not a
      // super admin. Falling back to it on an empty read put all seven names
      // back on Admin's billing page for a plain admin — undoing, in the UI,
      // exactly what 20260909120000 was written to enforce. An empty list is
      // the honest answer when the database gives us nothing.
      cache = rows || []
      inflight = null
      subscribers.forEach(fn => fn(cache))
      return cache
    })
  }
  return inflight
}

/** Every client, or the mock fixture in mock mode. `[]` only while loading. */
export function useClients() {
  const [rows, setRows] = useState(cache || [])
  useEffect(() => {
    let alive = true
    const onUpdate = (next) => { if (alive) setRows(next) }
    subscribers.add(onUpdate)
    load().then(onUpdate)
    return () => { alive = false; subscribers.delete(onUpdate) }
  }, [])
  return rows
}

/** A client's company name from its code, or null when the caller may not see
 *  it. Callers render the code in that case — the same masking displayClient
 *  applies everywhere else. */
export const clientNameOf = (clients, code) =>
  (clients || []).find(c => c.code === code)?.name || null

/** How a client should be labelled for this viewer: the company when they are
 *  allowed to see it, the code otherwise. */
export const clientLabelOf = (clients, code) => clientNameOf(clients, code) || code || '—'

/** Discard the cache so the next consumer refetches (after a client is added). */
export function invalidateClients() { cache = null; inflight = null }

/**
 * Admin creates a client by company name (match-or-create). Returns
 * { status: 'matched'|'created'|'ambiguous', code?, name?, codes? } — the same
 * shape the DB RPC returns — so a caller can reuse an existing match, use the
 * new code, or ask the admin to disambiguate. Mock mode matches/creates in the
 * in-memory cache; Supabase mode calls the admin_create_client RPC then refetches.
 */
export async function addClient({ name, contact = '', email = '' } = {}) {
  const company = (name || '').trim()
  if (!company) throw new Error('Company name is required')

  if (!isSupabaseConfigured) {
    const list = cache || CLIENTS
    const key = nameKey(company)
    const matches = (list || []).filter(c => nameKey(c.name) === key)
    if (matches.length > 1) return { status: 'ambiguous', codes: matches.map(c => c.code) }
    if (matches.length === 1) return { status: 'matched', code: matches[0].code, name: matches[0].name }
    // Next CL code from what we can see (same CL<digits> rule as next_client_code).
    const maxN = (list || []).reduce((m, c) => {
      const x = /^CL(\d+)$/i.exec(String(c.code || '')); return x ? Math.max(m, Number(x[1])) : m
    }, 0)
    const code = 'CL' + String(maxN + 1).padStart(2, '0')
    const row = { code, name: company, contact: contact.trim() || null, email: email.trim() || null,
      payment_terms: 'per_order', registered: new Date().toISOString().slice(0, 10) }
    cache = [...(list || []), row].sort((a, b) => String(a.code).localeCompare(String(b.code)))
    subscribers.forEach(fn => fn(cache))
    return { status: 'created', code, name: company }
  }

  const res = await createAdminClient(company, contact, email)
  // Refetch so the new/matched client appears in every useClients consumer.
  invalidateClients()
  await load()
  return res
}
