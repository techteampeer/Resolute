// Firebase token verification + identity resolution (the gate in front of the
// data API). The full Firebase project wiring (web app, provisioning a profile
// on first sign-in) is B3; this is the server-side verification path.
import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { config } from './config.js'
import { withServiceRole } from './db.js'

if (!getApps().length) {
  initializeApp(config.firebaseProjectId ? { projectId: config.firebaseProjectId } : {})
}

// Verify `Authorization: Bearer <firebase id token>`. Returns the decoded token
// ({ uid, email, ... }) or null.
export async function verifyBearer(authorization) {
  const m = /^Bearer (.+)$/.exec(authorization || '')
  if (!m) return null
  try {
    return await getAuth().verifyIdToken(m[1])
  } catch {
    return null
  }
}

// Map a verified Firebase identity to the portal app user. auth.users holds the
// firebase_uid -> profiles.id mapping; we read it (and the profile) as
// service_role because no user claims exist yet — this is the one narrow,
// justified RLS bypass (identity resolution). Returns { id, role, email }, or
// null when this Firebase account has no profile yet.
export async function resolveAppUser(decoded) {
  if (!decoded || !decoded.uid) return null
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `select p.id, p.role, p.email
         from auth.users u
         join public.profiles p on p.id = u.id
        where u.firebase_uid = $1
        limit 1`,
      [decoded.uid],
    )
    return rows[0] || null
  })
}
