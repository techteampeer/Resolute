// Admin user-management domain, server side (B4). The PORTABLE, provider-agnostic
// logic lifted out of the Vercel handler api/admin/users.js, so a GCP route is a
// thin adapter over it (CLAUDE.md: "handlers are thin adapters over portable
// modules"). Pure + dependency-free — unit-testable without a DB or an auth
// provider. The Supabase/Firebase-coupled operations (create/remove/ban/link
// generation) are NOT here; they stay in the handler/adapter.

// Post-D3 (ADR 0001) a staff account is an admin or a production `user`; the four
// stage labels remain valid enum values for history but are never minted anew.
export const ROLES = ['admin', 'user', 'client']

// Capabilities that confer elevated privilege. Toggling super_admin / billing, or
// granting one of these, is reserved to a SUPER-ADMIN caller.
export const ELEVATED = new Set([
  'payments.confirm', 'users.grant_super', 'users.manage', 'clients.view_pii', 'payouts.view', 'payouts.manage',
])
const VALID_EFFECT = new Set(['grant', 'revoke'])

// Random throwaway password for an invited account (it is immediately overridden
// via a set-password link; never handed back). Portable; used by the env-gated
// create path.
export const genPassword = () => 'Rslt-' + Math.random().toString(36).slice(2, 10) + Math.floor(Math.random() * 900 + 100)

// Validate + normalise a permissions array from the request body.
//   undefined → not provided (leave the column as-is on update).
export function cleanPermissions(input) {
  if (input == null) return { ok: true, value: undefined }
  if (!Array.isArray(input)) return { ok: false, error: 'permissions must be an array' }
  const out = []
  for (const p of input) {
    if (!p || typeof p.capability !== 'string' || !VALID_EFFECT.has(p.effect)) {
      return { ok: false, error: 'each permission needs a capability and effect grant|revoke' }
    }
    const e = { capability: p.capability, effect: p.effect }
    if (p.scope && typeof p.scope === 'object' && Array.isArray(p.scope.stages)) {
      e.scope = { stages: p.scope.stages.filter((s) => typeof s === 'string') }
    }
    out.push(e)
  }
  return { ok: true, value: out }
}

// Does this write try to confer elevated privilege? If so it needs a super admin.
export const touchesElevated = (body, perms) =>
  'superAdmin' in body || 'canConfirmPayments' in body ||
  (Array.isArray(perms) && perms.some((p) => p.effect === 'grant' && ELEVATED.has(p.capability)))

// Build the profiles patch from an update body (mirrors api/admin/users.js). A
// non-admin role cannot hold super_admin / billing, so they clear on demotion;
// client_code only rides a client role. `perms` is cleanPermissions(...).value
// (undefined = leave the column as-is).
export function buildProfilePatch(body, perms) {
  const patch = {}
  if (body.name != null) patch.name = body.name
  if (body.role != null) { patch.role = body.role; patch.client_code = body.role === 'client' ? (body.clientCode || null) : null }
  if ('superAdmin' in body) patch.super_admin = !!body.superAdmin
  if ('canConfirmPayments' in body) patch.can_confirm_payments = !!body.canConfirmPayments
  if (body.role != null && body.role !== 'admin') { patch.super_admin = false; patch.can_confirm_payments = false }
  if (perms !== undefined) patch.permissions = perms
  return patch
}
