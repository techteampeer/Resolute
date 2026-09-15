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
import { isBackendConfigured, fetchClients } from './backend'
import { CLIENTS } from '../data/mockData'

let cache = null
let inflight = null
const subscribers = new Set()

function load() {
  if (cache) return Promise.resolve(cache)
  if (!isBackendConfigured) { cache = CLIENTS; return Promise.resolve(cache) }
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
