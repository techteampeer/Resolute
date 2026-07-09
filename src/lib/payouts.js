// Vendor payout domain — money OUT to abstractor vendors (ABS searches) and
// recurring subscription services. Mirrors billing.js: the transfer itself
// happens outside the app (Vivek pays from the Chase account); the app tracks
// accrual → paid reconciliation. Super admins can view and enter fees; only
// Vivek (canConfirmPayments) may mark anything paid.
import { VENDORS } from '../data/mockData'

export const PAYOUT_CYCLES = [
  { key: 'weekly', label: 'Weekly',  days: 7,  desc: 'Paid every 7 days' },
  { key: 'days15', label: '15 Days', days: 15, desc: 'Paid on a 15-day cycle' },
  { key: 'days30', label: '30 Days', days: 30, desc: 'Paid on a 30-day cycle' },
]
export const cycleByKey = (key) => PAYOUT_CYCLES.find(c => c.key === key) || PAYOUT_CYCLES[2]

// Vendor payout cycles live in localStorage (mock mode), same pattern as
// client payment terms; the VENDORS registry provides the default.
const CYCLES_LS_KEY = 'resolute.vendorCycles'
const readCycles = () => { try { return JSON.parse(localStorage.getItem(CYCLES_LS_KEY)) || {} } catch { return {} } }
export const getVendorCycle = (code) =>
  readCycles()[code] || VENDORS.find(v => v.code === code)?.cycle || 'days30'
export function setVendorCycle(code, cycleKey) {
  const map = readCycles(); map[code] = cycleKey
  localStorage.setItem(CYCLES_LS_KEY, JSON.stringify(map))
}

// Orders routed to outside abstractors owe the vendor a search fee.
// 'both' = in-house + ABS (fee reflects the vendor's share); 'abc' = legacy key.
export const isAbsAssigned = (o) => ['abs', 'both', 'abc'].includes(o.workflow?.searchAssignment)
export const payoutOf = (o) => o.workflow?.abstractorFee || null
export const needsFee = (o) => isAbsAssigned(o) && !payoutOf(o)

const todayISO = () => new Date().toISOString().slice(0, 10)
const addDays = (iso, days) => {
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// Fee accrues when the search work happened (screening handed it out), and is
// due one vendor cycle later.
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

export const buildPayout = ({ vendor, amount, userName }) =>
  ({ vendor, amount: Number(amount) || 0, status: 'accrued', setBy: userName, setAt: todayISO() })
export const payPayout = (p, userName, reference = null) =>
  ({ ...p, status: 'paid', paidAt: todayISO(), paidBy: userName, reference })

// ── Recurring subscriptions (title plants, software, services) ───────────────
// Fully client-side (localStorage): { id, name, amount, cycle, lastPaidAt, paidBy }.
// nextDue = lastPaidAt + cycle days (or today when never paid).
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
export const subscriptionNextDue = (s) =>
  s.lastPaidAt ? addDays(s.lastPaidAt, cycleByKey(s.cycle).days) : todayISO()
export const isSubscriptionDue = (s) => subscriptionNextDue(s) <= todayISO()
export const paySubscription = (s, userName) => ({ ...s, lastPaidAt: todayISO(), paidBy: userName })
