// Shared orders-view model — the single source of truth for the Qualia-style
// orders list used by BOTH the admin and client portals, so the two never drift.
// Pure (no React, no JSX): tab classification, tab counts, the "Ordered within"
// date ranges, and the property accessor. Status COLOURS live in orderStatus.js;
// Total Price lives in lib/billing (invoiceAmount) — both imported by the views.
import { lineItemsOf } from '../data/mockData'
import { progressFor } from '@domain'

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

// ── Column sorting ────────────────────────────────────────────────────────────
// Shared so every order table (client, admin, production) sorts identically.
// A column that can be sorted supplies a `sortValue(order)` accessor returning a
// comparable (number, date string 'YYYY-MM-DD', or plain string). The pure
// accessors below cover the columns the portals share; `total` lives with the
// caller because it needs the billing estimate (lib/billing), which this module
// deliberately does not depend on.

// Status progression rank: follows the pipeline (received → … → delivered) via
// the domain's progressFor, so it never drifts from the stage order. Cancelled
// has no pipeline position, so it sorts to the end ascending.
export const statusRank = (o) =>
  o?.status === 'cancelled' ? Number.MAX_SAFE_INTEGER : progressFor(o?.status || '')

// The "Due By" column value: the delivered date once done, else the committed /
// estimated delivery date. Date strings sort chronologically as plain strings.
export const dueByValue = (o) => o?.completed || o?.eta || null

// The "Ordered On" column value.
export const orderedOnValue = (o) => o?.created || null

// Compare two accessor values for sorting. Empty values (null/undefined/'') sort
// LAST regardless of direction, so blank due dates never crowd the top.
export function compareValues(a, b, dir = 'asc') {
  const s = dir === 'desc' ? -1 : 1
  const aEmpty = a == null || a === ''
  const bEmpty = b == null || b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * s
  return String(a).localeCompare(String(b)) * s
}

// Stable sort of `list` by a column accessor + direction. A falsy accessor or
// direction returns the list unchanged (no active sort). Ties keep input order.
export function sortByAccessor(list, accessor, dir) {
  if (!accessor || !dir) return list
  return list
    .map((o, i) => [o, i])
    .sort((x, y) => compareValues(accessor(x[0]), accessor(y[0]), dir) || (x[1] - y[1]))
    .map(([o]) => o)
}
