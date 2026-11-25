// Account-management data access. Every function takes a pg client that is
// ALREADY inside a withUserClaims transaction (the caller's claims, RLS on).
// The authorization decisions are the database's: auth.provision_app_user()
// and auth.activate_app_user() (gcp/02_post_migrate.sql section 7) re-derive
// them from the caller's own profile every time they run.
import { randomUUID } from 'node:crypto'

// The caller's own profile, if it is an active admin. Staff can read every
// profile through RLS, so listing is gated on this, not on RLS.
export async function getActiveAdmin(client, id) {
  const { rows } = await client.query(
    `select role, status, super_admin
       from public.profiles
      where id = $1`,
    [id],
  )
  const r = rows[0]
  return r && r.role === 'admin' && r.status === 'active' ? { superAdmin: !!r.super_admin } : null
}

// The account columns the Admin Users screen shows, plus the optimistic-lock
// version (updated_at, exact to the microsecond so it round-trips).
const ACCOUNT = `id, name, email, role::text as role, client_code, super_admin, can_confirm_payments, permissions, status,
       created_at, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`

export async function listProfiles(client) {
  const { rows } = await client.query(`select ${ACCOUNT} from public.profiles order by lower(name), email`)
  return rows
}

export async function getProfile(client, id) {
  const { rows } = await client.query(`select ${ACCOUNT} from public.profiles where id = $1`, [id])
  return rows[0] || null
}

// Every account's Firebase UID, for reporting sign-in states (active admins
// only, enforced by auth.admin_account_uids). Never sent to the browser.
export async function listAccountUids(client) {
  const { rows } = await client.query('select id::text as id, firebase_uid from auth.admin_account_uids()')
  return rows
}

// Edit one account on the version the caller read (auth.update_app_user decides).
export async function updateProfile(client, id, expected, a) {
  await client.query('select auth.update_app_user($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb)',
    [id, expected, a.name, a.role, a.clientCode, a.superAdmin, a.canConfirmPayments, JSON.stringify(a.permissions)])
}

// active <-> inactive (auth.set_app_user_status decides). Returns
// { firebase_uid, email, status, changed } for the backend's sign-in step.
export async function setProfileStatus(client, id, active, expected) {
  const { rows } = await client.query(
    'select firebase_uid, email, status, changed from auth.set_app_user_status($1, $2, $3::timestamptz)',
    [id, active, expected])
  return rows[0]
}

// The same decision as a dry run, rolled back: who the account is in Firebase,
// once the database has authorized the change. Writes nothing.
export async function previewProfileStatus(client, id, active, expected) {
  await client.query('SAVEPOINT status_preflight')
  try {
    return await setProfileStatus(client, id, active, expected)
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT status_preflight')
  }
}

const PROVISION = 'select auth.provision_app_user($1, $2, $3, $4, $5, $6, $7, $8::jsonb) as id'
const provisionArgs = (firebaseUid, a) => [
  firebaseUid, a.email, a.role, a.name, a.clientCode, a.superAdmin, a.canConfirmPayments, JSON.stringify(a.permissions),
]

// Map + pending profile for a Firebase UID; returns the new profiles.id.
export async function provisionProfile(client, firebaseUid, attrs) {
  const { rows } = await client.query(PROVISION, provisionArgs(firebaseUid, attrs))
  return rows[0].id
}

// The same call with a throwaway UID, rolled back: the database validates and
// authorizes the request -- and checks the email is unused -- before anything
// exists in Firebase. Throws the database's refusal; writes nothing.
export async function preflightProvision(client, attrs) {
  await client.query('SAVEPOINT provision_preflight')
  try {
    await client.query(PROVISION, provisionArgs(`preflight-${randomUUID()}`, attrs))
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT provision_preflight')
  }
}

// pending -> active (idempotent). Returns { firebase_uid, email, activated }
// for the backend to enable the Firebase account; never sent to the client.
export async function activateProfile(client, id) {
  const { rows } = await client.query(
    'select firebase_uid, email, activated from auth.activate_app_user($1)',
    [id],
  )
  return rows[0]
}
