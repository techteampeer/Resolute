import { Router } from 'express'
import { adminAuth, requireUser, requireRole } from '../lib/auth.js'
import { queryAs, queryAnon, withUser } from '../lib/db.js'

const r = Router()
r.use(requireUser, requireRole('admin'))

/**
 * Admin user management — the port of api/admin/users.js.
 *
 * That file was a Vercel serverless function using the Supabase service-role
 * key, which bypasses RLS across the whole database; its own comment noted that
 * the admin check was "the ONLY thing standing between a request and full user
 * management". Here the identity store is Firebase and the profile rows are
 * written through withUser() as the calling admin, so `profiles_admin_write`
 * enforces in the database what the guard above asserts — the service-role key
 * is gone entirely.
 *
 * The id the UI passes is the PORTAL uuid (profiles.id). Firebase is addressed
 * by its own uid, so every call resolves one to the other through auth.users.
 */

const ROLES = ['admin', 'screener', 'examiner', 'typer', 'delivery', 'client', 'operator']
const genPassword = () => 'Rslt-' + Math.random().toString(36).slice(2, 10) + Math.floor(Math.random() * 900 + 100)

const firebaseUidFor = async (profileId) => {
  const rows = await queryAnon('select firebase_uid from auth.users where id = $1', [profileId])
  return rows[0]?.firebase_uid || null
}

// ── List ────────────────────────────────────────────────────────────────────
r.get('/users', async (req, res) => {
  try {
    const profiles = await queryAs(req.user.profile_id,
      `select p.id, p.name, p.email, p.role::text as role, p.client_code,
              p.super_admin, p.status, u.firebase_uid, u.created_at
         from public.profiles p
         left join auth.users u on u.id = p.id
        order by p.name`)

    // One listUsers call rather than one lookup per row: the disabled flag lives
    // with Firebase, everything else with us.
    const disabled = new Set()
    let page = await adminAuth().listUsers(1000)
    for (;;) {
      for (const u of page.users) if (u.disabled) disabled.add(u.uid)
      if (!page.pageToken) break
      page = await adminAuth().listUsers(1000, page.pageToken)
    }

    res.json({
      users: profiles.map((p) => ({
        id: p.id, email: p.email, name: p.name || '', role: p.role,
        clientCode: p.client_code, superAdmin: !!p.super_admin,
        // No Firebase account linked yet: they cannot sign in, which is the
        // same practical state as deactivated and should read that way.
        active: p.status === 'active' && !!p.firebase_uid && !disabled.has(p.firebase_uid),
        linked: !!p.firebase_uid,
        created: p.created_at,
      })),
    })
  } catch (err) {
    console.error('[admin/users] list', err)
    res.status(500).json({ error: 'Could not list users' })
  }
})

// ── Create ──────────────────────────────────────────────────────────────────
r.post('/users', async (req, res) => {
  const { action } = req.body || {}
  const me = req.user

  try {
    if (action === 'create') {
      const { email, name = '', role, clientCode } = req.body
      if (!email || !ROLES.includes(role)) return res.status(400).json({ error: 'Valid email and role are required' })

      const password = genPassword()
      const fbUser = await adminAuth().createUser({ email, password, emailVerified: true, displayName: name })

      try {
        // The mapping row and the profile are one transaction: a failure between
        // them would leave a Firebase account that can authenticate but resolves
        // to no profile, which reads as "not linked to a portal account".
        await withUser(me.profile_id, async (c) => {
          const { rows } = await c.query(
            'insert into auth.users (firebase_uid, email) values ($1,$2) returning id',
            [fbUser.uid, email])
          await c.query(
            `insert into public.profiles (id, name, email, role, client_code, status)
             values ($1,$2,$3,$4,$5,'active')`,
            [rows[0].id, name, email, role, role === 'client' ? (clientCode || null) : null])
        })
      } catch (err) {
        // Do not leave an orphaned Firebase account behind.
        await adminAuth().deleteUser(fbUser.uid).catch(() => {})
        throw err
      }
      return res.json({ tempPassword: password })
    }

    if (action === 'update') {
      const { id, name, role, clientCode } = req.body
      if (!id) return res.status(400).json({ error: 'id required' })
      if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' })

      const sets = []
      const vals = []
      if (name != null) { vals.push(name); sets.push(`name = $${vals.length}`) }
      if (role != null) {
        vals.push(role); sets.push(`role = $${vals.length}`)
        vals.push(role === 'client' ? (clientCode || null) : null); sets.push(`client_code = $${vals.length}`)
      }
      if (!sets.length) return res.json({ ok: true })
      vals.push(id)

      // profiles_admin_write is what permits this; a non-admin reaching here
      // would be refused by the database, not just by the guard above.
      const out = await withUser(me.profile_id, (c) =>
        c.query(`update public.profiles set ${sets.join(', ')} where id = $${vals.length}`, vals))
      if (!out.rowCount) return res.status(403).json({ error: 'The database refused the change.' })

      if (name != null) {
        const uid = await firebaseUidFor(id)
        if (uid) await adminAuth().updateUser(uid, { displayName: name }).catch(() => {})
      }
      return res.json({ ok: true })
    }

    if (action === 'setActive') {
      const { id, active } = req.body
      if (!id) return res.status(400).json({ error: 'id required' })
      if (id === me.profile_id) return res.status(400).json({ error: 'You cannot deactivate your own account.' })

      const uid = await firebaseUidFor(id)
      if (uid) await adminAuth().updateUser(uid, { disabled: !active })
      await queryAs(me.profile_id, 'update public.profiles set status = $1 where id = $2',
        [active ? 'active' : 'inactive', id])
      // Disabling only stops new sign-ins; an existing session cookie would keep
      // working for its full five days. requireUser verifies with
      // checkRevoked, and this is what makes that check bite immediately.
      if (uid && !active) await adminAuth().revokeRefreshTokens(uid).catch(() => {})
      return res.json({ ok: true })
    }

    if (action === 'resetPassword') {
      const { email } = req.body
      if (!email) return res.status(400).json({ error: 'email required' })
      // A link rather than an email, exactly as before: no SMTP dependency, and
      // the admin hands it over directly.
      return res.json({ link: await adminAuth().generatePasswordResetLink(email) })
    }

    if (action === 'remove') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id required' })
      if (id === me.profile_id) return res.status(400).json({ error: 'You cannot remove your own account.' })

      const uid = await firebaseUidFor(id)
      if (uid) await adminAuth().deleteUser(uid).catch((e) => console.error('[admin/users] firebase delete', e))
      // profiles.id references auth.users(id) on delete cascade, so removing the
      // mapping row takes the profile with it.
      await queryAnon('delete from auth.users where id = $1', [id])
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('[admin/users]', action, err)
    res.status(400).json({ error: err.message || 'Request failed' })
  }
})

export default r
