import { cert, getApps, initializeApp, applicationDefault } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { queryAnon } from './db.js'

/**
 * Authentication: Google Cloud Identity Platform (Firebase Auth).
 *
 * Two things are worth understanding before changing anything here.
 *
 * 1. THE BROWSER NEVER HOLDS A TOKEN. Sign-in posts credentials to this server,
 *    which checks them against Identity Platform and sets an httpOnly session
 *    cookie. The Firebase client SDK is deliberately not in the SPA bundle: it
 *    would put a bearer token in reachable JavaScript, and it is ~150 KB on a
 *    bundle that is already large.
 *
 * 2. THE FIREBASE UID IS NOT THE PORTAL'S USER ID. Firebase issues 28-character
 *    strings; profiles.id is a uuid, it is a foreign key to auth.users, and
 *    every one of the 36 RLS policies is built on auth.uid() returning that
 *    uuid. So auth.users maps one to the other (see gcp/01_bootstrap.sql) and
 *    what gets injected into the Postgres session is always the PORTAL uuid.
 *    Injecting a raw Firebase UID makes auth.uid() throw on the cast, and every
 *    policy with it.
 */

let app
function adminApp() {
  if (app) return app
  const existing = getApps()
  if (existing.length) { app = existing[0]; return app }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  app = initializeApp({
    credential: raw ? cert(JSON.parse(raw)) : applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
  })
  return app
}
export const adminAuth = () => getAuth(adminApp())

export const SESSION_COOKIE = '__session'
const SESSION_MS = 1000 * 60 * 60 * 24 * 5

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts'
function apiKey() {
  const k = process.env.FIREBASE_API_KEY
  if (!k) throw new Error('FIREBASE_API_KEY is not set')
  return k
}

/** Check an email and password against Identity Platform. */
export async function verifyPassword(email, password) {
  const res = await fetch(`${IDENTITY}:signInWithPassword?key=${apiKey()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body?.error?.message || 'UNKNOWN')
    err.identityCode = body?.error?.message
    throw err
  }
  return body // { idToken, localId, email, ... }
}

export async function sendPasswordReset(email) {
  await fetch(`${IDENTITY}:sendOobCode?key=${apiKey()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  })
}

/**
 * Resolve a Firebase UID to the portal profile it is bound to.
 *
 * Binding is NOT done here, and not on first sign-in. An unbound Firebase
 * account is refused, because auto-binding on a matching email would mean
 * anyone who can create an Identity Platform account with a Resolute address
 * inherits that person's portal profile, orders and client data. The accounts
 * are linked deliberately, by an admin, with scripts/link-firebase-users.mjs.
 */
export async function profileForFirebaseUid(firebaseUid) {
  const rows = await queryAnon(
    `select u.id as profile_id, p.email, p.name, p.role::text as role,
            p.super_admin, p.client_code, p.status, p.can_confirm_payments
       from auth.users u
       join public.profiles p on p.id = u.id
      where u.firebase_uid = $1`,
    [firebaseUid]
  )
  return rows[0] || null
}

/** Exchange a verified ID token for the session cookie. */
export async function createSessionCookie(idToken) {
  // Reject a token minted long ago, so a replayed one cannot be upgraded into a
  // five-day session.
  const decoded = await adminAuth().verifyIdToken(idToken, true)
  if (Date.now() - decoded.auth_time * 1000 > 5 * 60 * 1000) {
    throw new Error('Sign-in is too old to start a session.')
  }
  return adminAuth().createSessionCookie(idToken, { expiresIn: SESSION_MS })
}

export function setSessionCookie(res, value) {
  res.cookie(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MS,
  })
}

export const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, { path: '/' })

/**
 * Attach req.user from the session cookie, or 401.
 *
 * checkRevoked: true costs a lookup but means a disabled account or a signed-out
 * session stops working immediately rather than up to five days later. For a
 * portal holding client financial records that is the right trade.
 */
export async function requireUser(req, res, next) {
  const cookie = req.cookies?.[SESSION_COOKIE]
  if (!cookie) return res.status(401).json({ error: 'Not signed in' })
  try {
    const decoded = await adminAuth().verifySessionCookie(cookie, true)
    const profile = await profileForFirebaseUid(decoded.uid)
    // Authenticated by Firebase but not a portal user, or deactivated. Treated
    // as signed out rather than half-signed-in.
    if (!profile || profile.status !== 'active') {
      clearSessionCookie(res)
      return res.status(401).json({ error: 'Not signed in' })
    }
    req.user = profile
    next()
  } catch {
    clearSessionCookie(res)
    return res.status(401).json({ error: 'Not signed in' })
  }
}

/** Role gate. Layered on top of RLS, never instead of it. */
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Forbidden' })

/**
 * Turn an Identity Platform code into something worth showing a person. Wrong
 * password and unknown email deliberately produce the SAME message: a different
 * one for each tells anyone with a list of addresses which hold accounts here.
 */
export function friendlyAuthError(err) {
  const c = err?.identityCode || ''
  if (c.startsWith('USER_DISABLED')) return 'This account has been disabled. Contact your administrator.'
  if (c.startsWith('TOO_MANY_ATTEMPTS')) return 'Too many attempts. Please wait a few minutes and try again.'
  return 'That email and password do not match.'
}
