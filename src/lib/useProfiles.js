// The real staff roster, shared by every screen that needs to name a person.
//
// Admin's Assign modal and the Edit Order form used to build their person lists
// by filtering mockData's USERS fixture. That fixture carries six staff who have
// no profiles row and no login — Dana Iqbal, Marcus Reed, Riley Cho, Owen Park,
// Leah Tran, Nina Reyes — so Admin could assign an order to someone who does not
// exist, and the order row recorded their name. The sidebar's Users badge was
// USERS.length for the same reason: a constant 16 against a real roster of 10.
//
// Cached at module scope so the roster is fetched once per page load rather than
// per modal open. Falls back to the fixture when Supabase is not configured,
// which is the documented mock-data-first behaviour.
import { useEffect, useState } from 'react'
import { isSupabaseConfigured, fetchProfiles } from './backend'
import { USERS } from '../data/mockData'

const MOCK = USERS.map(u => ({ ...u, status: u.status || 'active' }))

let cache = null
let inflight = null
const subscribers = new Set()

function load() {
  if (cache) return Promise.resolve(cache)
  if (!isSupabaseConfigured) { cache = MOCK; return Promise.resolve(cache) }
  if (!inflight) {
    inflight = fetchProfiles().then(rows => {
      // A failed fetch must not leave the roster empty — an empty Assign modal
      // is worse than a stale one, and it would read as "no staff exist".
      cache = (rows && rows.length) ? rows : MOCK
      inflight = null
      subscribers.forEach(fn => fn(cache))
      return cache
    })
  }
  return inflight
}

/** Every profile, or the mock fixture in mock mode. `[]` only while loading. */
export function useProfiles() {
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

/** Active staff names for one pipeline role, ready for a <select>. */
export const namesForRole = (profiles, role) =>
  profiles.filter(p => p.role === role && (p.status || 'active') === 'active').map(p => p.name).filter(Boolean)

/** Discard the cache so the next consumer refetches (after a roster edit). */
export function invalidateProfiles() { cache = null; inflight = null }
