// Vendor payout domain — money OUT to abstractor vendors (ABS searches) and
// recurring subscription services. Mirrors billing.js: the transfer itself
// happens outside the app (Vivek pays from the Chase account); the app tracks
// accrual → paid reconciliation. Super admins can view and enter fees; only
// Vivek (canConfirmPayments) may mark anything paid.
import { VENDORS } from '../data/mockData'
import {
  isSupabaseConfigured, fetchVendors, saveVendorCycle as saveVendorCycleRemote,
  fetchSubscriptions, saveSubscription,
} from './backend'
// Pure payout/subscription math now lives in the portable domain core
// (packages/domain). This file keeps the localStorage caches, the vendor
// registry fallback, and Supabase persistence.
import {
  PAYOUT_CYCLES, cycleByKey, isAbsAssigned, payoutOf, needsFee, buildPayout, payPayout,
  subscriptionNextDue, isSubscriptionDue, paySubscription, addDays, todayISO,
} from '@domain'

export {
  PAYOUT_CYCLES, cycleByKey, isAbsAssigned, payoutOf, needsFee, buildPayout, payPayout,
  subscriptionNextDue, isSubscriptionDue, paySubscription,
}

// Vendor cycles: localStorage is the synchronous read cache; the vendors table
// is durable when Supabase is configured. The VENDORS registry is the mock
// fallback and default.
const CYCLES_LS_KEY = 'resolute.vendorCycles'
const readCycles = () => { try { return JSON.parse(localStorage.getItem(CYCLES_LS_KEY)) || {} } catch { return {} } }
export const getVendorCycle = (code) =>
  readCycles()[code] || VENDORS.find(v => v.code === code)?.cycle || 'days30'
export function setVendorCycle(code, cycleKey) {
  const map = readCycles(); map[code] = cycleKey
  localStorage.setItem(CYCLES_LS_KEY, JSON.stringify(map))
  if (isSupabaseConfigured) saveVendorCycleRemote(code, cycleKey)
}
// Pull the vendor registry (incl. cycles) from Supabase; refreshes the cycle
// cache and returns the list, or null in mock mode / on error.
export async function hydrateVendors() {
  if (!isSupabaseConfigured) return null
  const vendors = await fetchVendors()
  if (vendors) {
    localStorage.setItem(CYCLES_LS_KEY, JSON.stringify(Object.fromEntries(vendors.map(v => [v.code, v.cycle]))))
  }
  return vendors
}

// Fee accrues when the search work happened (screening handed it out), and is
// due one vendor cycle later. Depends on the (I/O) vendor-cycle lookup, so it
// stays here rather than in the pure core.
export const payoutDue = (o) => {
  const p = payoutOf(o)
  if (!p) return null
  const start = o.completedDates?.screener || o.created
  return addDays(start, cycleByKey(getVendorCycle(p.vendor)).days)
}
export const isPayoutOverdue = (o) => {
  const p = payoutOf(o)
  if (!p || p.status === 'paid') return false
  const due = payoutDue(o)
  return Boolean(due && due < todayISO())
}

// ── Recurring subscriptions (title plants, software, services) ───────────────
// localStorage cache; Supabase durable when configured.
const SUBS_LS_KEY = 'resolute.subscriptions'
const DEFAULT_SUBS = [
  { id: 'sub1', name: 'DataTree Title Plant',   amount: 299, cycle: 'days30', lastPaidAt: null, paidBy: null },
  { id: 'sub2', name: 'NetOnline County Access', amount: 149, cycle: 'days30', lastPaidAt: null, paidBy: null },
]
export const readSubscriptions = () => {
  try { return JSON.parse(localStorage.getItem(SUBS_LS_KEY)) || DEFAULT_SUBS } catch { return DEFAULT_SUBS }
}
export function writeSubscriptions(subs) {
  localStorage.setItem(SUBS_LS_KEY, JSON.stringify(subs))
  return subs
}
// Pull durable subscriptions into the local cache; null in mock mode / on error.
export async function hydrateSubscriptions() {
  if (!isSupabaseConfigured) return null
  const subs = await fetchSubscriptions()
  if (subs) writeSubscriptions(subs)
  return subs
}
// Persist a single subscription row (call after paySubscription).
export function persistSubscription(s) {
  if (isSupabaseConfigured) saveSubscription(s)
}
