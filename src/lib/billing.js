// Billing/payment domain logic for the ACH + Check (no-gateway) payment system.
//
// Money moves OUTSIDE the app: ACH = client pushes from their bank to ours;
// Check = client mails a physical check (and uploads an image for reference).
// The app tracks intent + reconciliation: Unpaid → Client Marked Paid →
// Confirmed (by the billing super admin) → or Bounced.
import { clientByName } from '../data/mockData'
import { isSupabaseConfigured, supabase } from './supabase'

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

// ── Payment terms (Admin assigns per client; default per-order) ──────────────
export const TERMS = [
  { key: 'per_order', label: 'Per Order',  days: 0,  desc: 'Each invoice due upon receipt' },
  { key: 'weekly',    label: 'Weekly',     days: 7,  desc: 'One statement, every 7 days' },
  { key: 'net15',     label: 'Net 15',     days: 15, desc: 'One statement, 15-day cycle' },
  { key: 'net30',     label: 'Net 30',     days: 30, desc: 'One statement, 30-day cycle' },
]
export const termByKey = (key) => TERMS.find(t => t.key === key) || TERMS[0]

// Client terms live in localStorage (mock mode) and best-effort sync to
// Supabase clients.payment_terms when configured.
const TERMS_LS_KEY = 'resolute.clientTerms'
const readTermsMap = () => { try { return JSON.parse(localStorage.getItem(TERMS_LS_KEY)) || {} } catch { return {} } }
export const getClientTerms = (clientCode) => readTermsMap()[clientCode] || 'per_order'
export function setClientTerms(clientCode, termKey) {
  const map = readTermsMap(); map[clientCode] = termKey
  localStorage.setItem(TERMS_LS_KEY, JSON.stringify(map))
  if (isSupabaseConfigured) {
    supabase.from('clients').update({ payment_terms: termKey }).eq('code', clientCode)
      .then(({ error }) => { if (error) console.error('[terms]', error.message) })
  }
}

// ── Who may confirm payments (deposit reconciliation) ────────────────────────
export const canConfirmPayments = (user) => user?.email?.toLowerCase() === 'vivek@resolute.com'

// ── Invoices ─────────────────────────────────────────────────────────────────
// Price precedence: the quote the client AGREED to (workflow.quote.amount,
// once accepted/confirmed) → the Typer's final invoice total
// (workflow.invoiceAmount, stamped on Finalize) → catalog estimate.
const BASE_PRICE = { 'Full Search': 175, 'Two-Owner': 150, 'Current Owner': 125, 'Lien Search': 110, 'Tax Certificate': 95, 'HOA Estoppel': 120 }
export const invoiceAmount = (o) => {
  const q = o.workflow?.quote
  if (q?.amount != null && ['accepted', 'confirmed'].includes(q.stage)) return Number(q.amount)
  return (o.workflow?.invoiceAmount ?? BASE_PRICE[o.type] ?? 125) + (o.priority === 'rush' ? 50 : 0)
}
export const invoiceNumber = (o) => `INV-${o.id}`
export const money = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export const clientCodeOf = (o) => o.clientCode || clientByName(o.client)?.code || null

// Normalize legacy payment shapes ({status:'submitted'} from the old card).
export function paymentOf(o) {
  const p = o.workflow?.payment
  if (!p) return null
  return { ...p, status: p.status === 'submitted' ? 'marked' : p.status }
}
export const PAY_STATUS = {
  unpaid:    { label: 'Unpaid',        color: '#64748b' },
  marked:    { label: 'Marked Paid',   color: '#b45309' },
  confirmed: { label: 'Paid',          color: '#15803d' },
  bounced:   { label: 'Bounced',       color: '#dc2626' },
}
export const payStatusOf = (o) => paymentOf(o)?.status || 'unpaid'
// Billable = delivered (invoice after delivery; nothing is blocked on payment).
export const isBillable = (o) => o.status === 'delivered'

const addDays = (iso, days) => {
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
export function dueDate(o, termKey) {
  const t = termByKey(termKey)
  return addDays(o.completed || o.created, t.days)
}
export function isOverdue(o, termKey) {
  const s = payStatusOf(o)
  if (s === 'confirmed') return false
  const due = dueDate(o, termKey)
  return Boolean(due && due < new Date().toISOString().slice(0, 10))
}

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

// Build the payment object written onto order.workflow.payment.
export function buildPayment({ method, reference, checkDoc = null, statementId = null }) {
  return {
    method, reference: reference || null, checkDoc, statementId,
    status: 'marked', markedAt: new Date().toISOString().slice(0, 10),
  }
}
export const confirmPayment = (p, userName) =>
  ({ ...p, status: 'confirmed', confirmedAt: new Date().toISOString().slice(0, 10), confirmedBy: userName })
export const bouncePayment = (p, userName) =>
  ({ ...p, status: 'bounced', bouncedAt: new Date().toISOString().slice(0, 10), confirmedBy: userName })
