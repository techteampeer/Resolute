// Additional-fee domain, server side. MIRRORS packages/domain/src/money.ts
// (buildCharge / isAmountInRange / AMOUNT_LIMIT / money) the same way mappers.js
// mirrors toAppOrder: the domain is pure TypeScript with no compiled output, and
// this service runs plain `node src/index.js` with no build step, so it cannot
// import the .ts at runtime. Keep this in lockstep with money.ts — the amount
// bound especially (both cite the F3 SQL guard, migration 20260921010000).
//
// Pure and dependency-free on purpose, so it unit-tests without a database and
// runs unchanged in a browser preview, a Vercel function and Cloud Run.

export const AMOUNT_LIMIT = 1_000_000

// Magnitude bound only (a credit can be negative); the >0 rule for a raised fee
// lives in validateRaise below, matching OrderCharges' submit guard.
export const isAmountInRange = (n) => {
  const v = Number(n)
  return Number.isFinite(v) && Math.abs(v) <= AMOUNT_LIMIT
}

const todayISO = () => new Date().toISOString().slice(0, 10)

// Same output as money.ts's money(): "$100.00". Used only for the human-readable
// activity line, never for any stored amount.
export const money = (n) =>
  (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// The client-visible activity line a raise writes — byte-identical to the string
// OrderContext.raiseCharge logs on the Supabase path, so the feed reads the same
// whichever backend served it. actor is masked to 'Resolute' (never the staff
// name) and the notify classifier ignores this wording, so raising sends NO
// email — only the client's later approve/decline does.
export const raiseEventAction = (orderId, amount) =>
  `Additional fee of ${money(amount)} requested on ${orderId} — awaiting approval`

// Build a pending charge. The server owns id + timestamps + status; a client id,
// status or resolvedAt is never trusted. Mirrors money.ts buildCharge.
export const buildPendingCharge = ({ label, amount, raisedBy, raisedByRole }) => ({
  id: `chg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
  label: String(label || 'Additional fee').trim().slice(0, 120) || 'Additional fee',
  amount: isAmountInRange(amount) ? Number(amount) : 0,
  raisedBy,
  raisedByRole,
  raisedAt: todayISO(),
  status: 'pending',
  resolvedAt: null,
})

// Authoritative request validation for a raise (§8 of the B1 spec). Returns the
// coerced { label, amount } on success, or { ok:false, message } for a 422. A
// supplied id/status is ignored — the server generates them.
export const validateRaise = (body) => {
  const label = typeof body?.label === 'string' ? body.label.trim() : ''
  if (label.length < 1 || label.length > 120) {
    return { ok: false, message: 'label must be 1–120 characters' }
  }
  const amount = Number(body?.amount)
  if (!Number.isFinite(amount) || amount <= 0 || !isAmountInRange(amount)) {
    return { ok: false, message: `amount must be a positive number up to ${AMOUNT_LIMIT}` }
  }
  return { ok: true, label, amount }
}

export const DECISIONS = ['approved', 'declined']
export const validateDecision = (d) => DECISIONS.includes(d)
