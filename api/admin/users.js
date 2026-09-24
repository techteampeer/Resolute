// Admin User Management (CRUD) — service-role serverless endpoint.
//   GET                      → list users (auth + profile, with active state)
//   POST { action: 'create'  , email, name, role, clientCode } → invite/add user
//   POST { action: 'update'  , id, name, role, clientCode }     → edit profile
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

async function requireAdmin(req) {
  const authz = req.headers.authorization || ''
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : ''
  if (!token) return { code: 401 }
  const { data: { user } = {}, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) return { code: 401 }
  const { data: prof } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (prof?.role !== 'admin') return { code: 403 }
  return { user }
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
    const { email, name = '', role, clientCode } = body
    if (!email || !ROLES.includes(role)) return send(res, 400, { error: 'Valid email and role are required' })
    const password = genPassword()
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name, role },
    })
    if (error) return send(res, 400, { error: error.message })
    // The handle_new_user trigger created the profile; set the authoritative fields.
    await supabaseAdmin.from('profiles').update({
      name, role, client_code: role === 'client' ? (clientCode || null) : null, status: 'active',
    }).eq('id', data.user.id)
    return send(res, 200, { id: data.user.id, tempPassword: password })
  }

  // ── Update (edit profile) ──────────────────────────────────────────────────
  if (action === 'update') {
    const { id, name, role, clientCode } = body
    if (!id) return send(res, 400, { error: 'id required' })
    if (role && !ROLES.includes(role)) return send(res, 400, { error: 'invalid role' })
    const patch = {}
    if (name != null) patch.name = name
    if (role != null) { patch.role = role; patch.client_code = role === 'client' ? (clientCode || null) : null }
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
