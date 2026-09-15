import { Router } from 'express'
import {
  verifyPassword, createSessionCookie, setSessionCookie, clearSessionCookie,
  profileForFirebaseUid, requireUser, friendlyAuthError, sendPasswordReset,
} from '../lib/auth.js'

const r = Router()

const publicUser = (p) => ({
  id: p.profile_id, email: p.email, name: p.name, role: p.role,
  superAdmin: p.super_admin, clientCode: p.client_code,
  canConfirmPayments: p.can_confirm_payments,
})

r.post('/login', async (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' })

  let identity
  try {
    identity = await verifyPassword(email, password)
  } catch (err) {
    return res.status(401).json({ error: friendlyAuthError(err) })
  }

  // Authenticated by Identity Platform, but is this a portal user? Binding is
  // deliberate (scripts/link-firebase-users.mjs), never automatic on a matching
  // email — otherwise anyone who can create an Identity Platform account with a
  // Resolute address would inherit that person's profile and client data.
  const profile = await profileForFirebaseUid(identity.localId)
  if (!profile) {
    return res.status(403).json({ error: 'This login is not linked to a portal account yet. Ask an administrator.' })
  }
  if (profile.status !== 'active') {
    return res.status(403).json({ error: 'This account has been deactivated.' })
  }

  try {
    setSessionCookie(res, await createSessionCookie(identity.idToken))
  } catch (err) {
    // Almost always the runtime service account missing "Service Account Token
    // Creator" on itself — the password was fine, the cookie could not be minted.
    console.error('[auth] session cookie failed', err)
    return res.status(500).json({ error: 'Could not start a session.' })
  }
  res.json({ user: publicUser(profile) })
})

r.post('/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }) })

r.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }))

r.post('/reset', async (req, res) => {
  // Always reports success: saying "no such account" turns this into a way to
  // test whether an address is registered.
  try { await sendPasswordReset(req.body?.email) } catch (err) { console.error('[auth] reset', err) }
  res.json({ ok: true })
})

export default r
