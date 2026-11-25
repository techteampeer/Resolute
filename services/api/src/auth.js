// Firebase token verification + identity resolution (the gate in front of the
// data API). The full Firebase project wiring (web app, provisioning a profile
// on first sign-in) is B3; this is the server-side verification path.
import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { config } from './config.js'
import { withIdentityLookup, withUserClaims } from './db.js'

if (!getApps().length) {
  initializeApp(config.firebaseProjectId ? { projectId: config.firebaseProjectId } : {})
}

// Verify `Authorization: Bearer <firebase id token>`. Returns the decoded token
// ({ uid, email, ... }) or null. checkRevoked: a token whose session was revoked
// (or whose account was disabled) is refused even before it expires.
export async function verifyBearer(authorization) {
  const m = /^Bearer (.+)$/.exec(authorization || '')
  if (!m) return null
  try {
    return await getAuth().verifyIdToken(m[1], true)
  } catch {
    return null
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Production contract (resolute_live), verified:
//   auth.resolve_app_user(text) RETURNS TABLE(id uuid, role text, status text)
//   SECURITY DEFINER, executed directly by the restricted app login.
export const RESOLVE_APP_USER_SQL = 'SELECT id, role, status FROM auth.resolve_app_user($1)'

// Map a VERIFIED Firebase identity to the portal app user, the way production
// does: the login calls the resolver with the token's uid (never a
// client-supplied value) — no service_role, no RLS bypass in the API. The
// resolver must report exactly one ACTIVE identity; the profile is then read in
// an ordinary RLS-secured request transaction AS that user (profiles_read: own
// row) and must be the same, active row. Returns { id, role, email }, or null
// (-> 403). A database error propagates (-> 500); either way no req.user is set.
export async function resolveAppUser(decoded) {
  const uid = decoded && typeof decoded.uid === 'string' ? decoded.uid : ''
  if (!uid) return null

  const rows = await withIdentityLookup(async (client) => (await client.query(RESOLVE_APP_USER_SQL, [uid])).rows)
  if (rows.length > 1) throw new Error('auth.resolve_app_user returned more than one row')
  const r = rows[0]
  if (!r || typeof r.id !== 'string' || !UUID.test(r.id) || r.status !== 'active') return null

  const profile = await withUserClaims({ id: r.id, email: decoded.email || null }, async (client) => {
    const { rows: p } = await client.query(
      'select id, role, email, status from public.profiles where id = auth.uid() limit 1')
    return p[0] || null
  })
  if (!profile || profile.id !== r.id || profile.status !== 'active') return null
  return { id: profile.id, role: profile.role, email: profile.email }
}
