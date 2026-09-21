// Billing/payment domain logic for the ACH + Check (no-gateway) payment system.
//
// Money moves OUTSIDE the app: ACH = client pushes from their bank to ours;
// Check = client mails a physical check (and uploads an image for reference).
// The app tracks intent + reconciliation: Unpaid → Client Marked Paid →
// Confirmed (by the billing super admin) → or Bounced.
import { clientByName } from '../data/mockData'
import { PRODUCT_PRICE } from '../data/products'
import { isSupabaseConfigured, fetchClientTerms, saveClientTerms } from './backend'
// The pure money math now lives in the portable domain core (packages/domain).
// This file keeps the I/O (localStorage + Supabase term persistence), the
// catalogue binding for the invoice estimate, and the client-code resolver.
import {
  money, invoiceNumber, TERMS, termByKey, PAY_STATUS, paymentOf, payStatusOf,
  isBillable, dueDate, isOverdue, buildPayment, confirmPayment, bouncePayment,
  invoiceTotal, addDays,
} from '@domain'

export {
  money, invoiceNumber, TERMS, termByKey, PAY_STATUS, paymentOf, payStatusOf,
  isBillable, dueDate, isOverdue, buildPayment, confirmPayment, bouncePayment,
}

// ── Remittance details (PLACEHOLDERS — fill in real values here later) ──────
export const REMITTANCE = {
  billingEmail: 'billing@resolute.com',
  payee: null,            // e.g. 'Resolute Title Services LLC'
  checkAddress: null,     // e.g. '123 Main St, Suite 400, Miami, FL 33101'
  bankName: null,         // e.g. 'First National Bank'
  routingNumber: null,    // e.g. '021000021'
  accountNumber: null,    // e.g. '1234567890'
  accountName: null,      // business name on the account
}
export const hasRemittanceDetails = Boolean(REMITTANCE.routingNumber && REMITTANCE.accountNumber)

// Client terms: localStorage is the synchronous read cache; Supabase
// clients.payment_terms is the durable source when configured (hydrate on
// page load, write through on change).
const TERMS_LS_KEY = 'resolute.clientTerms'
const readTermsMap = () => { try { return JSON.parse(localStorage.getItem(TERMS_LS_KEY)) || {} } catch { return {} } }
export const getClientTerms = (clientCode) => readTermsMap()[clientCode] || 'per_order'
export function setClientTerms(clientCode, termKey) {
  const map = readTermsMap(); map[clientCode] = termKey
  localStorage.setItem(TERMS_LS_KEY, JSON.stringify(map))
  if (isSupabaseConfigured) saveClientTerms(clientCode, termKey)
}
// Pull the durable terms into the local cache; returns true when refreshed.
export async function hydrateClientTerms() {
  if (!isSupabaseConfigured) return false
  const map = await fetchClientTerms()
  if (map) localStorage.setItem(TERMS_LS_KEY, JSON.stringify(map))
  return !!map
}

// ── Who may confirm payments (deposit reconciliation) ────────────────────────
// Reads the capability off the profile (profiles.can_confirm_payments) instead of
// comparing a hardcoded address, so the person who reconciles deposits can change
// without a deploy. This is the UI mirror only: the same rule is enforced by
// triggers on orders, vendor_payouts and subscriptions, because it used to be a
// UI check with nothing behind it and every admin could confirm money over the
// REST API. The email fallback keeps mock mode (no profile) working.
export const canConfirmPayments = (user) =>
  user?.canConfirmPayments === true ||
  (user?.canConfirmPayments === undefined && user?.email?.toLowerCase() === 'vivek@resolute.com')

// ── Invoices ─────────────────────────────────────────────────────────────────
// Estimate from the shared product catalog (the price the client saw when
// ordering) until the Typer's final invoice total is stamped on the order
// (workflow.invoiceAmount, set on Finalize). invoiceTotal is the portable
// computation; this binding supplies the catalogue. Quote-only products with no
// fixed price fall back to a flat estimate inside invoiceTotal.
export const invoiceAmount = (o) => invoiceTotal(o, { catalogue: PRODUCT_PRICE })

export const clientCodeOf = (o) => o.clientCode || clientByName(o.client)?.code || null

// ── Statements (termed clients pay one consolidated amount) ──────────────────
// The open statement for a client = all billable orders not yet confirmed,
// due at (earliest delivery + term days). One payment/reference settles all.
export function openStatement(orders, clientCode, termKey) {
  const t = termByKey(termKey)
  if (t.key === 'per_order') return null
  const items = orders.filter(o => clientCodeOf(o) === clientCode && isBillable(o) && payStatusOf(o) !== 'confirmed')
  if (!items.length) return null
  const earliest = items.map(o => o.completed || o.created).sort()[0]
  const due = addDays(earliest, t.days)
  return {
    id: `STMT-${clientCode}-${due}`,
    clientCode, term: t, items, due,
    total: items.reduce((a, o) => a + invoiceAmount(o), 0),
    overdue: items.some(o => isOverdue(o, termKey)),
  }
}
