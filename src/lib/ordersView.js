// Shared orders-view model — the single source of truth for the Qualia-style
// orders list used by BOTH the admin and client portals, so the two never drift.
// Pure (no React, no JSX): tab classification, tab counts, the "Ordered within"
// date ranges, and the property accessor. Status COLOURS live in orderStatus.js;
// Total Price lives in lib/billing (invoiceAmount) — both imported by the views.
import { lineItemsOf } from '../data/mockData'

// The Qualia filter tabs, in order. Mapping (confirmed):
//   Pending   = Awaiting Approval  (parked with Admin, nothing to work yet)
//   Open      = in production      (a production user is working a stage)
//   Submitted = Out for Delivery   (the delivery stage is being worked)
//   Complete  = Delivered
//   Cancelled = Cancelled
export const ORDER_TABS = [
  { key: 'all',       label: 'All' },
  { key: 'pending',   label: 'Pending' },
  { key: 'open',      label: 'Open' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'complete',  label: 'Complete' },
  { key: 'cancelled', label: 'Cancelled' },
]

// Which tab an order belongs to. Order of checks matters: a terminal status wins,
// then "parked with Admin" (Pending) outranks the delivery stage — an order parked
// for the Admin to assign delivery is still awaiting Admin, not yet out for
// delivery. Only a delivery stage actually held by a production user is Submitted.
export function tabOf(o) {
  if (!o) return 'pending'
  if (o.status === 'cancelled') return 'cancelled'
  if (o.status === 'delivered') return 'complete'
  if (o.assignedTo === 'admin' || o.assignedTo == null) return 'pending'
  if (o.status === 'delivery') return 'submitted'
  return 'open'
}

// Per-tab counts over a set of orders ({ all, pending, open, submitted, ... }).
export function tabCounts(orders) {
  const counts = { all: orders.length }
  for (const t of ORDER_TABS) if (t.key !== 'all') counts[t.key] = 0
  for (const o of orders) counts[tabOf(o)] += 1
  return counts
}

// "Ordered within" presets — the order's `created` date vs a rolling window.
export const DATE_RANGES = [
  { key: '30',  label: 'Last 30 Days' },
  { key: '90',  label: 'Last 3 Months' },
  { key: '365', label: 'Last 12 Months' },
  { key: 'all', label: 'All Time' },
]

export function withinRange(o, key, now = Date.now()) {
  if (key === 'all' || !key) return true
  const created = o?.created ? new Date(o.created).getTime() : NaN
  if (Number.isNaN(created)) return true   // undated legacy rows never filtered out
  return created >= now - Number(key) * 24 * 60 * 60 * 1000
}

// The Property column value: a single property's address, or "N properties" for a
// combined (multi-parcel) order. Falls back to an em dash when nothing was captured.
export function propertyOf(o) {
  const items = lineItemsOf(o)
  if (items.length > 1) return `${items.length} properties`
  return o?.workflow?.intake?.propertyAddress || '—'
}
