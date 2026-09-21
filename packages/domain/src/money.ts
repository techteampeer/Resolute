// Portable money domain: invoices, payment terms, vendor payouts, subscriptions.
// Pure functions and constants only — the I/O-coupled pieces (localStorage
// caches, Supabase reads/writes) stay in src/lib/billing.js and payouts.js and
// call into these. Extracted from those files to keep the money math in one
// tested, portable place shared with the future server RPCs (workstream B/F3).
import { todayISO } from './pipeline'
import type { Order } from './pipeline'

export const money = (n: unknown): string =>
  (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// Sanity bound on any stored money amount. The single source of truth: the F3
// SQL guards (migration 20260921010000) mirror this number and cite it. A credit
// / discount can push an invoice negative (see the typer Finalize), so the bound
// is on magnitude, not sign — it exists to catch non-numeric values and absurd
// tampering, not to police legitimate quotes.
export const AMOUNT_LIMIT = 1_000_000
export const isAmountInRange = (n: unknown): boolean => {
  const v = Number(n)
  return Number.isFinite(v) && Math.abs(v) <= AMOUNT_LIMIT
}

// ── Client payment terms ────────────────────────────────────────────────────
export interface Term { key: string; label: string; days: number; desc: string }
export const TERMS: Term[] = [
  { key: 'per_order', label: 'Per Order', days: 0,  desc: 'Each invoice due upon receipt' },
  { key: 'weekly',    label: 'Weekly',    days: 7,  desc: 'One statement, every 7 days' },
  { key: 'net15',     label: 'Net 15',    days: 15, desc: 'One statement, 15-day cycle' },
  { key: 'net30',     label: 'Net 30',    days: 30, desc: 'One statement, 30-day cycle' },
]
export const termByKey = (key?: string): Term => TERMS.find(t => t.key === key) || TERMS[0]

// ── Vendor / subscription payout cycles ──────────────────────────────────────
export interface Cycle { key: string; label: string; days: number; desc: string }
export const PAYOUT_CYCLES: Cycle[] = [
  { key: 'weekly', label: 'Weekly',  days: 7,  desc: 'Paid every 7 days' },
  { key: 'days15', label: '15 Days', days: 15, desc: 'Paid on a 15-day cycle' },
  { key: 'days30', label: '30 Days', days: 30, desc: 'Paid on a 30-day cycle' },
]
export const cycleByKey = (key?: string): Cycle => PAYOUT_CYCLES.find(c => c.key === key) || PAYOUT_CYCLES[2]

// ── Dates ─────────────────────────────────────────────────────────────────────
export const addDays = (iso: string | null | undefined, days: number): string | null => {
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Invoice amount ────────────────────────────────────────────────────────────
// The authoritative invoice computation shared by the UI and (soon) the server.
// Precedence: an admin/typer-set invoiceAmount, else the catalogue price for the
// order type, else a flat fallback; a rush order adds a surcharge. Coerced with
// Number() so a stored string can never concatenate.
export interface InvoiceOpts { catalogue?: Record<string, number>; fallback?: number; rushSurcharge?: number }
export const invoiceTotal = (
  order: Order,
  { catalogue = {}, fallback = 125, rushSurcharge = 50 }: InvoiceOpts = {},
): number => {
  const base = order.workflow?.invoiceAmount ?? catalogue[order.type as string] ?? fallback
  return (Number(base) || 0) + (order.priority === 'rush' ? rushSurcharge : 0)
}
export const invoiceNumber = (order: Pick<Order, 'id'>): string => `INV-${order.id}`

// ── Payment state ─────────────────────────────────────────────────────────────
export interface Payment { status: string; [k: string]: any }
export const PAY_STATUS: Record<string, { label: string; color: string }> = {
  unpaid:    { label: 'Unpaid',      color: '#5C6E8C' },
  marked:    { label: 'Marked Paid', color: '#b45309' },
  confirmed: { label: 'Paid',        color: '#15803d' },
  bounced:   { label: 'Bounced',     color: '#dc2626' },
}
// Normalize the legacy { status:'submitted' } shape to 'marked'.
export const paymentOf = (order: Order): Payment | null => {
  const p = order.workflow?.payment
  if (!p) return null
  return { ...p, status: p.status === 'submitted' ? 'marked' : p.status }
}
export const payStatusOf = (order: Order): string => paymentOf(order)?.status || 'unpaid'

// Billable once delivered (invoice after delivery; nothing blocks on payment).
export const isBillable = (order: Order): boolean => order.status === 'delivered'

export const dueDate = (order: Order, termKey?: string): string | null =>
  addDays(order.completed || order.created, termByKey(termKey).days)
export const isOverdue = (order: Order, termKey?: string): boolean => {
  if (payStatusOf(order) === 'confirmed') return false
  const due = dueDate(order, termKey)
  return Boolean(due && due < todayISO())
}

// Payment object builders. A client may only MARK; confirm/bounce belong to the
// billing owner (enforced by DB trigger, see enforce_payment_confirmer).
export interface BuildPaymentArgs { method: string; reference?: string | null; checkDoc?: any; statementId?: string | null }
export const buildPayment = ({ method, reference, checkDoc = null, statementId = null }: BuildPaymentArgs): Payment => ({
  method, reference: reference || null, checkDoc, statementId,
  status: 'marked', markedAt: todayISO(),
})
export const confirmPayment = (p: Payment, userName: string): Payment =>
  ({ ...p, status: 'confirmed', confirmedAt: todayISO(), confirmedBy: userName })
export const bouncePayment = (p: Payment, userName: string): Payment =>
  ({ ...p, status: 'bounced', bouncedAt: todayISO(), confirmedBy: userName })

// ── Vendor payouts (money OUT) ────────────────────────────────────────────────
export const isAbsAssigned = (order: Order): boolean =>
  ['abs', 'both', 'abc'].includes(order.workflow?.searchAssignment)
export const payoutOf = (order: Order): any => order.workflow?.abstractorFee || null
export const needsFee = (order: Order): boolean => isAbsAssigned(order) && !payoutOf(order)
export const buildPayout = ({ vendor, amount, userName }: { vendor: string; amount: unknown; userName: string }) =>
  ({ vendor, amount: Number(amount) || 0, status: 'accrued', setBy: userName, setAt: todayISO() })
export const payPayout = (p: any, userName: string, reference: string | null = null) =>
  ({ ...p, status: 'paid', paidAt: todayISO(), paidBy: userName, reference })

// ── Recurring subscriptions ─────────────────────────────────────────────────
export interface Subscription { id: string; name: string; amount: number; cycle: string; lastPaidAt?: string | null; paidBy?: string | null }
export const subscriptionNextDue = (s: Subscription): string | null =>
  s.lastPaidAt ? addDays(s.lastPaidAt, cycleByKey(s.cycle).days) : todayISO()
export const isSubscriptionDue = (s: Subscription): boolean => (subscriptionNextDue(s) as string) <= todayISO()
export const paySubscription = (s: Subscription, userName: string): Subscription =>
  ({ ...s, lastPaidAt: todayISO(), paidBy: userName })
