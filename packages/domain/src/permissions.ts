// Portable authorization model — capabilities, not scattered flag checks.
//
// No React, no Supabase, no I/O — pure functions and data, so the SAME rules run
// in the web app today, in the server/RPCs after the GCP move, and in tests. This
// is the layer that lets us stop sprinkling `user.superAdmin` / `canConfirmPayments`
// across the UI and ask one question instead: `can(user, 'payments.confirm')`.
//
// Design:
//   • A fixed CAPABILITY catalog (verbs the app gates on).
//   • Each ROLE grants a default BUNDLE of capabilities.
//   • Two legacy FLAGS layer on top of an admin: `superAdmin` (see client PII +
//     payouts) and `canConfirmPayments` (the money gate). These are mapped to
//     capabilities here so the rest of the app no longer reads the raw flags.
//   • PER-USER GRANTS can add or remove a capability for one account, optionally
//     SCOPED (e.g. a trainee who may only work the `screener` stage). This is the
//     "grant billing to this person", "let this newbie do screening only" model —
//     stored per user (Phase A-2) and passed in here.
//
// Effective capability set = role defaults ∪ flag-derived ∪ explicit grants,
// minus explicit revokes. `can()` answers the scoped question.
//
// Backward-compatible: with no grants passed, the result is exactly today's
// behaviour expressed as capabilities, so nothing changes until grants exist.

import { StageRole } from './pipeline'

// ── The catalog ──────────────────────────────────────────────────────────────
// Grounded in the actual gates in the app. Keep this the single source of truth;
// add a capability here before gating a new action on it.
export type Capability =
  | 'orders.read'            // see orders (all staff)
  | 'orders.work'            // work a production stage (scopeable to stages)
  | 'orders.assign'          // set the stage plan / route orders (admin)
  | 'orders.hold'            // put an order on hold / resume (admin)
  | 'orders.clarify'         // request clarification from a client (admin)
  | 'clients.view_pii'       // see client names + contact, not just codes
  | 'payouts.view'           // see the vendor-payout ledger
  | 'payouts.manage'         // enter vendor + fee on an order
  | 'payments.confirm'       // confirm funds: payments, payouts, subscriptions (the money gate)
  | 'support.reply_client'   // reply to a client in a thread (admin only)
  | 'support.note'           // add an internal note (all staff)
  | 'users.manage'           // create / edit / deactivate staff + clients
  | 'users.grant_super'      // make someone a super admin / grant high-privilege caps
  | 'client.portal'          // the client's own portal (place orders, pay, view own)

export type Role = 'admin' | 'user' | 'client'

// Capabilities a scope can narrow. Today only stage work is scoped (the trainee
// case); the shape is general so more scoped caps can follow.
export interface CapabilityScope {
  stages?: StageRole[]       // for orders.work — which stages this account may do
}

// A per-user override: add or remove one capability, optionally scoped.
export interface PermissionGrant {
  capability: Capability
  effect: 'grant' | 'revoke'
  scope?: CapabilityScope
}

// The user shape this module reads. Deliberately loose — the app's user object
// carries more; these are the fields authz depends on.
export interface Principal {
  role?: Role | string
  superAdmin?: boolean
  canConfirmPayments?: boolean
  permissions?: PermissionGrant[]   // per-user grants (Phase A-2); optional
  [k: string]: any
}

// ── Role defaults ────────────────────────────────────────────────────────────
const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  // Production desk: works stages, reads orders, leaves internal notes. No admin,
  // no money, no client identities. Stage scope (trainee) is applied via a grant.
  user: ['orders.read', 'orders.work', 'support.note'],
  // Admin: runs operations end to end, manages users, talks to clients. Client
  // PII, payouts and the money gate are NOT here — they come from the flags.
  admin: [
    'orders.read', 'orders.work', 'orders.assign', 'orders.hold', 'orders.clarify',
    'support.reply_client', 'support.note', 'users.manage',
  ],
  // Client: only their own portal.
  client: ['client.portal'],
}

// Capabilities an admin gains from the super-admin flag (visibility + payouts +
// the ability to elevate others). The money gate is a SEPARATE flag below.
const SUPER_ADMIN_CAPABILITIES: Capability[] = [
  'clients.view_pii', 'payouts.view', 'payouts.manage', 'users.grant_super',
]

// A scoped capability entry in the effective set.
interface Held { capability: Capability; scope?: CapabilityScope }

// ── Effective capabilities ───────────────────────────────────────────────────
// role defaults ∪ flag-derived ∪ grants − revokes. Returns the held set with any
// scopes attached. Pure; `grants` defaults to the principal's own.
export function effectiveCapabilities(p: Principal | null | undefined): Held[] {
  if (!p) return []
  const role = (p.role as Role) || 'client'
  const held = new Map<Capability, Held>()
  const add = (c: Capability, scope?: CapabilityScope) => held.set(c, { capability: c, scope })

  for (const c of ROLE_CAPABILITIES[role as Role] || []) add(c)
  if (role === 'admin' && p.superAdmin) for (const c of SUPER_ADMIN_CAPABILITIES) add(c)
  // The money gate: either the explicit flag, or (mock/no-profile fallback) the
  // seeded billing address — mirrors lib/billing.canConfirmPayments so the UI and
  // this module never disagree.
  if (p.canConfirmPayments === true ||
      (p.canConfirmPayments === undefined && String(p.email || '').toLowerCase() === 'vivek@resolute.com')) {
    add('payments.confirm')
  }

  // Per-user overrides last, so an admin can grant or pull a single capability.
  for (const g of p.permissions || []) {
    if (g.effect === 'revoke') held.delete(g.capability)
    else add(g.capability, g.scope)
  }
  return [...held.values()]
}

// ── The question the app asks ────────────────────────────────────────────────
// `can(user, 'payments.confirm')` — held at all?
// `can(user, 'orders.work', { stage: 'screener' })` — held FOR that stage? A held
// `orders.work` with no stage scope means every stage; with a scope, only the
// listed stages. Other capabilities ignore the scope argument.
export function can(
  p: Principal | null | undefined,
  capability: Capability,
  opts: { stage?: StageRole } = {},
): boolean {
  const entry = effectiveCapabilities(p).find(h => h.capability === capability)
  if (!entry) return false
  if (capability === 'orders.work' && opts.stage) {
    const stages = entry.scope?.stages
    return !stages || stages.length === 0 || stages.includes(opts.stage)
  }
  return true
}

// Which production stages a principal may work (for the admin's stage-plan picker
// and the worker desk). null = unscoped (all stages); [] = none; else the subset.
export function workableStages(p: Principal | null | undefined): StageRole[] | null {
  const entry = effectiveCapabilities(p).find(h => h.capability === 'orders.work')
  if (!entry) return []
  const stages = entry.scope?.stages
  return stages && stages.length ? stages : null
}
