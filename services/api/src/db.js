// The connection pool and the per-transaction claims injector — the security
// core of the data tier. Read gcp/README "Two things that will bite" before
// touching this.
import pg from 'pg'
import { config } from './config.js'
import { claimsForUser } from './claims.js'

// One pool for the process. Every client in it logs in as the NON-SUPERUSER app
// role (config.db.user). Postgres skips RLS for superusers / BYPASSRLS, so the
// app must never connect as `postgres` or a BYPASSRLS role.
const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: config.db.max,
})

// Run `fn(client)` inside a transaction that acts as `authenticated` with THIS
// user's claims. Both the role and the claims are transaction-local
// (SET LOCAL ROLE, set_config(..., true)), so nothing leaks to the next request
// that checks the same pooled connection out. The app login is NOINHERIT
// (gcp/01_bootstrap.sql), so SET ROLE is required to pick up the authenticated
// grants; RLS then enforces via auth.uid() read from the claims.
export async function withUserClaims(user, fn) {
  const claims = claimsForUser(user)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE authenticated')
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already broken; releasing resets it */ }
    throw err
  } finally {
    client.release()
  }
}

// A narrow, RLS-bypassing read used ONLY for identity resolution — mapping a
// verified Firebase UID to the portal profiles.id before any user claims exist
// (the chicken-and-egg: we need profiles.id to set `sub`). service_role holds
// BYPASSRLS. Keep its use to this one lookup; everything else goes through
// withUserClaims so RLS is in force.
export async function withServiceRole(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE service_role')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* released connection resets state */ }
    throw err
  } finally {
    client.release()
  }
}

export async function closePool() {
  await pool.end()
}
