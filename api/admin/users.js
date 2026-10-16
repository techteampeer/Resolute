// Admin User Management (CRUD) — service-role serverless endpoint.
//   GET                      → list users (auth + profile, with active state)
//   POST { action: 'create'  , email, name, role, clientCode, superAdmin?, canConfirmPayments?, permissions? } → invite/add user
//   POST { action: 'update'  , id, name, role, clientCode, superAdmin?, canConfirmPayments?, permissions? }     → edit profile
//     (superAdmin / canConfirmPayments / elevated permission grants require a super-admin caller)
//   POST { action: 'setActive', id, active }                    → activate/deactivate (auth ban)
//   POST { action: 'resetPassword', email }                     → recovery link
//   POST { action: 'remove'  , id }                             → hard delete (auth + profile)
//
// Every request is gated: the caller's bearer token must resolve to a profile
// with role = 'admin'. The service-role client bypasses RLS, so this guard is
// the ONLY thing standing between a request and full user management — keep it.
import { supabaseAdmin, hasSupabaseAdmin } from '../_lib/supabaseAdmin.js'

const send = (res, code, body) => res.status(code).json(body)
const genPassword = () => 'Rslt-' + Math.random().toString(36).slice(2, 10) + Math.floor(Math.random() * 900 + 100)
// Post-D3 (ADR 0001) the four stage login roles are retired; a staff account is
// an admin or a production `user`. The stage labels remain valid enum values for
// historical rows, but new accounts are never minted with them.
const ROLES = ['admin', 'user', 'client']

// Capabilities that confer elevated privilege. Toggling super_admin / billing, or
// granting one of these via permissions, is reserved to a SUPER-ADMIN caller — a
// plain admin manages basic users (name / role / client / active) but cannot mint
// new super admins, hand out the money gate, or self-escalate the roster.
const ELEVATED = new Set(['payments.confirm', 'users.grant_super', 'users.manage', 'clients.view_pii', 'payouts.view', 'payouts.manage'])
const VALID_EFFECT = new Set(['grant', 'revoke'])

// Validate + normalise a permissions array from the request body.
//   undefined → not provided (leave the column as-is on update).
function cleanPermissions(input) {
  if (input == null) return { ok: true, value: undefined }
  if (!Array.isArray(input)) return { ok: false, error: 'permissions must be an array' }
  const out = []
  for (const p of input) {
    if (!p || typeof p.capability !== 'string' || !VALID_EFFECT.has(p.effect))
      return { ok: false, error: 'each permission needs a capability and effect grant|revoke' }
    const e = { capability: p.capability, effect: p.effect }
    if (p.scope && typeof p.scope === 'object' && Array.isArray(p.scope.stages))
      e.scope = { stages: p.scope.stages.filter(s => typeof s === 'string') }
    out.push(e)
  }
  return { ok: true, value: out }
}

// Does this write try to confer elevated privilege? If so it needs a super admin.
const touchesElevated = (body, perms) =>
  'superAdmin' in body || 'canConfirmPayments' in body ||
  (Array.isArray(perms) && perms.some(p => p.effect === 'grant' && ELEVATED.has(p.capability)))

async function requireAdmin(req) {
  const authz = req.headers.authorization || ''
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : ''
  if (!token) return { code: 401 }
  const { data: { user } = {}, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) return { code: 401 }
  const { data: prof } = await supabaseAdmin.from('profiles').select('role, super_admin').eq('id', user.id).maybeSingle()
  if (prof?.role !== 'admin') return { code: 403 }
  return { user, superAdmin: !!prof.super_admin }
}

export default async function handler(req, res) {
  if (!hasSupabaseAdmin) return send(res, 500, { error: 'Server not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' })
  const gate = await requireAdmin(req)
  if (gate.code) return send(res, gate.code, { error: gate.code === 401 ? 'Unauthorized' : 'Forbidden' })
  const me = gate.user

  // ── List ────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 })
    if (error) return send(res, 400, { error: error.message })
    const { data: profs } = await supabaseAdmin.from('profiles').select('*')
    const pmap = Object.fromEntries((profs || []).map(p => [p.id, p]))
    const users = (list?.users || []).map(u => {
      const p = pmap[u.id] || {}
      const banned = u.banned_until && new Date(u.banned_until) > new Date()
      return {
        id: u.id, email: u.email, name: p.name || u.user_metadata?.name || '',
        role: p.role || null, clientCode: p.client_code || null, superAdmin: !!p.super_admin,
        canConfirmPayments: !!p.can_confirm_payments,
        permissions: Array.isArray(p.permissions) ? p.permissions : [],
        active: !banned, created: u.created_at,
      }
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    return send(res, 200, { users })
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const { action } = body
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  // ── Create / invite ───────────────────────────────────────────────────────
  if (action === 'create') {
    const { email, name = '', role, clientCode, superAdmin, canConfirmPayments } = body
    if (!email || !ROLES.includes(role)) return send(res, 400, { error: 'Valid email and role are required' })
    const perms = cleanPermissions(body.permissions)
    if (!perms.ok) return send(res, 400, { error: perms.error })
    if (touchesElevated(body, perms.value) && !gate.superAdmin)
      return send(res, 403, { error: 'Only a super admin can grant super-admin, billing, or elevated permissions.' })
    const isAdmin = role === 'admin'
    const password = genPassword()
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name, role },
    })
    if (error) return send(res, 400, { error: error.message })
    // The handle_new_user trigger created the profile (default role='client');
    // set the authoritative fields. super_admin / billing only apply to admins;
    // grants apply to anyone.
    const { data: provisioned, error: profErr } = await supabaseAdmin.from('profiles').update({
      name, role, client_code: role === 'client' ? (clientCode || null) : null, status: 'active',
      super_admin: isAdmin ? !!superAdmin : false,
      can_confirm_payments: isAdmin ? !!canConfirmPayments : false,
      permissions: perms.value ?? [],
    }).eq('id', data.user.id).select('id')
    // CRITICAL: if this UPDATE fails or touches 0 rows, the account keeps the
    // trigger's default role='client' — a "production user" silently created as a
    // client, invisible in the assign picker. Causes: a behind migration (missing
    // `permissions` / `can_confirm_payments` column rejects the whole statement) or
    // an absent handle_new_user trigger. Roll the half-created account back and
    // surface the error rather than return 200 on a mis-provisioned user.
    if (profErr || !provisioned || provisioned.length === 0) {
      await supabaseAdmin.auth.admin.deleteUser(data.user.id).catch(() => {})
      await supabaseAdmin.from('profiles').delete().eq('id', data.user.id).catch(() => {})
      return send(res, 400, { error: profErr?.message
        || 'Account provisioning failed: the profile could not be set (check that all migrations are applied). No user was created.' })
    }
    // No plaintext password is ever handed back. The random one above is a
    // throwaway the invitee immediately overrides via a secure set-password link.
    let inviteLink = null
    try {
      const { data: link } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email })
      inviteLink = link?.properties?.action_link || null
    } catch { /* non-fatal: the admin can resend with "Reset" */ }
    return send(res, 200, { id: data.user.id, inviteLink })
  }

  // ── Update (edit profile) ──────────────────────────────────────────────────
  if (action === 'update') {
    const { id, name, role, clientCode, superAdmin, canConfirmPayments } = body
    if (!id) return send(res, 400, { error: 'id required' })
    if (role && !ROLES.includes(role)) return send(res, 400, { error: 'invalid role' })
    const perms = cleanPermissions(body.permissions)
    if (!perms.ok) return send(res, 400, { error: perms.error })
    if (touchesElevated(body, perms.value) && !gate.superAdmin)
      return send(res, 403, { error: 'Only a super admin can grant super-admin, billing, or elevated permissions.' })
    const patch = {}
    if (name != null) patch.name = name
    if (role != null) { patch.role = role; patch.client_code = role === 'client' ? (clientCode || null) : null }
    if ('superAdmin' in body) patch.super_admin = !!superAdmin
    if ('canConfirmPayments' in body) patch.can_confirm_payments = !!canConfirmPayments
    // A non-admin role can't hold super_admin / billing — clear them on demotion.
    if (role != null && role !== 'admin') { patch.super_admin = false; patch.can_confirm_payments = false }
    if (perms.value !== undefined) patch.permissions = perms.value
    const { error } = await supabaseAdmin.from('profiles').update(patch).eq('id', id)
    if (error) return send(res, 400, { error: error.message })
    if (role || name != null) {
      await supabaseAdmin.auth.admin.updateUserById(id, { user_metadata: { name: name ?? undefined, role: role ?? undefined } })
    }
    return send(res, 200, { ok: true })
  }

  // ── Activate / deactivate (reversible auth ban) ─────────────────────────────
  if (action === 'setActive') {
    const { id, active } = body
    if (!id) return send(res, 400, { error: 'id required' })
    if (id === me.id) return send(res, 400, { error: 'You cannot deactivate your own account.' })
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: active ? 'none' : '876000h' })
    if (error) return send(res, 400, { error: error.message })
    await supabaseAdmin.from('profiles').update({ status: active ? 'active' : 'inactive' }).eq('id', id)
    return send(res, 200, { ok: true })
  }

  // ── Reset password (recovery link; no SMTP dependency) ──────────────────────
  if (action === 'resetPassword') {
    const { email } = body
    if (!email) return send(res, 400, { error: 'email required' })
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email })
    if (error) return send(res, 400, { error: error.message })
    return send(res, 200, { link: data?.properties?.action_link || null })
  }

  // ── Remove (hard delete auth user + profile) ────────────────────────────────
  if (action === 'remove') {
    const { id } = body
    if (!id) return send(res, 400, { error: 'id required' })
    if (id === me.id) return send(res, 400, { error: 'You cannot remove your own account.' })
    const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
    if (error) return send(res, 400, { error: error.message })
    await supabaseAdmin.from('profiles').delete().eq('id', id)   // in case the FK isn't ON DELETE CASCADE
    return send(res, 200, { ok: true })
  }

  return send(res, 400, { error: 'Unknown action' })
}
