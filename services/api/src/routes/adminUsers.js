// Admin user-management route (B4), served at /api/admin/users — the GCP port of
// the Vercel handler api/admin/users.js, which the admin UI calls directly (not
// through the provider seam), so the same path serves both backends.
//
// VERIFIABLE IN-REPO SLICE (ADR 0003 B4): only the profile-edit path is wired.
// create / remove / setActive / resetPassword and the user LISTING need Firebase
// Auth Admin AND the GCP auth.users/firebase_uid schema, which live in the
// deployed snapshot — not this repo. They FAIL SAFE with a clear 501 (never a
// fake success) until that auth backend is committed (ADR 0003 B3 / #5).
import { Router } from 'express'
import { withServiceRole } from '../db.js'
import { cleanPermissions, touchesElevated, buildProfilePatch, ROLES } from '../adminUsers.js'
import { getProfilePrivilege, badClientLink, updateProfile } from '../repositories/adminUsers.js'

export const adminUsersRouter = Router()

const notWired = (res, what) => res.status(501).json({
  error: `${what} is not wired on the GCP backend yet — it needs the Firebase Auth admin backend (ADR 0003 B3/B4).`,
})

// GET → list users: auth email/active come from the auth provider → env-gated.
adminUsersRouter.get('/', (_req, res) => notWired(res, 'Listing users'))

adminUsersRouter.post('/', async (req, res, next) => {
  try {
    // The ONLY authorization guard (service-role writes bypass RLS): caller must
    // be an admin; elevated grants additionally need a super admin.
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
    const action = req.body?.action

    if (action === 'update') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id required' })
      if (req.body.role != null && !ROLES.includes(req.body.role)) return res.status(400).json({ error: 'invalid role' })
      const perms = cleanPermissions(req.body.permissions)
      if (!perms.ok) return res.status(400).json({ error: perms.error })

      const caller = await withServiceRole((c) => getProfilePrivilege(c, req.user.id))
      if (touchesElevated(req.body, perms.value) && !caller?.super_admin) {
        return res.status(403).json({ error: 'Only a super admin can grant super-admin, billing, or elevated permissions.' })
      }

      const patch = buildProfilePatch(req.body, perms.value)
      const outcome = await withServiceRole(async (c) => {
        // When the edit makes (or keeps) the account a client, never leave it
        // pointing at a non-existent clients row.
        if (req.body.role === 'client') {
          const bad = await badClientLink(c, 'client', req.body.clientCode)
          if (bad) return { error: bad }
        }
        return { n: await updateProfile(c, id, patch) }
      })
      if (outcome.error) return res.status(400).json({ error: outcome.error })
      if (!outcome.n) return res.status(400).json({ error: 'no such user' })
      // NOTE: the Vercel path also syncs auth user_metadata (name/role). That is
      // Firebase-coupled and env-gated here; the profiles row is the source of truth.
      return res.status(200).json({ ok: true })
    }

    if (['create', 'remove', 'setActive', 'resetPassword'].includes(action)) {
      return notWired(res, `'${action}'`)
    }
    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    next(err)
  }
})
