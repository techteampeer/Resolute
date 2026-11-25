// The connection pool, the identity lookup and the per-transaction claims
// injector — the security core of the data tier. Read gcp/README "Security
// model" and "Two things that will bite" before touching this.
import { config } from './config.js'
import { claimsForUser } from './claims.js'

// One pool for the process. Every client in it logs in as the NON-SUPERUSER app
// login (config.db.user): LOGIN NOINHERIT, member of authenticated + anon only
// (gcp/01_bootstrap.sql). Postgres skips RLS for superusers / BYPASSRLS, so the
// app must never connect as `postgres` or a BYPASSRLS role — the pool refuses
// to start if it does. Created on first use, so this module loads without the
// pg driver; the optional `pool` arguments below exist only for unit tests.
let poolPromise = null
function getPool() {
  poolPromise ??= createPool().catch((err) => { poolPromise = null; throw err })
  return poolPromise
}

// When an IDLE client's connection fails (server restart, failover,
// pg_terminate_backend), the pool emits 'error'. With no listener Node turns
// that into an uncaught exception and the process dies. node-postgres has
// already removed the failed client from the pool by then, so there is nothing
// to clean up — just record it. Only the error code is logged: the message can
// carry server details. Errors on ACTIVE queries never come here; they reject
// their own query as before.
export function onIdleClientError(err) {
  console.error('[db] idle client error:', (err && err.code) || 'unknown')
}

// Builds the process pool with the 'error' listener attached at construction,
// so no code path can obtain the pool without it.
export function buildPool(pg) {
  const pool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    max: config.db.max,
    connectionTimeoutMillis: config.db.connectTimeoutMs,
  })
  pool.on('error', onIdleClientError)
  return pool
}

async function createPool() {
  const { default: pg } = await import('pg')
  const pool = buildPool(pg)
  try {
    await assertRestrictedLogin(pool)
  } catch (err) {
    await pool.end()
    throw err
  }
  return pool
}

// Refuse to serve through a privileged login: a superuser or BYPASSRLS role
// skips RLS outright, and a CREATEROLE login gets auth.uid()'s operator NULL
// when claims are missing — the migrations' "trusted maintenance" path.
export async function assertRestrictedLogin(db) {
  const { rows } = await db.query(
    'select rolsuper, rolbypassrls, rolcreaterole from pg_catalog.pg_roles where rolname = current_user',
  )
  const r = rows[0]
  if (!r || r.rolsuper || r.rolbypassrls || r.rolcreaterole) {
    throw new Error('refusing to serve: the database login is privileged (superuser, BYPASSRLS or CREATEROLE)')
  }
}

// Firebase UID -> { id, role, status } through auth.resolve_app_user()
// (gcp/01_bootstrap.sql) — the one read that happens before claims exist. It
// runs as the app login itself, with no SET ROLE: EXECUTE on that SECURITY
// DEFINER function is granted to the app login alone, and it returns at most
// one row. The UID (from a verified ID token, see auth.js) is only ever a bound
// parameter. One statement, so no transaction; a client whose query failed is
// destroyed rather than returned to the pool.
export async function resolveIdentity(firebaseUid, pool) {
  const client = await (pool || await getPool()).connect()
  let discard
  try {
    const { rows } = await client.query(
      'select id, role, status from auth.resolve_app_user($1)',
      [firebaseUid],
    )
    return rows[0] || null
  } catch (err) {
    discard = err
    throw err
  } finally {
    client.release(discard)
  }
}

// Run `fn(client)` inside a transaction that acts as `authenticated` with THIS
// user's claims. Both the role and the claims are transaction-local
// (SET LOCAL ROLE, set_config(..., true)), so nothing leaks to the next request
// that checks the same pooled connection out. The app login is NOINHERIT, so
// SET ROLE is required to pick up the authenticated grants; RLS then enforces
// via auth.uid() read from the claims, and auth.uid() raises when they carry no
// `sub`. The claims come only from claimsForUser(user) — `sub` = profiles.id,
// role the constant 'authenticated' — and no other claim (request.jwt.claim.role
// in particular) is ever set, so nothing from a request can widen them.
export async function withUserClaims(user, fn, pool) {
  const claims = claimsForUser(user)
  const client = await (pool || await getPool()).connect()
  let discard
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE authenticated')
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    // A client that cannot roll back may still hold this user's role and
    // claims: destroy it instead of handing it to the next request.
    try { await client.query('ROLLBACK') } catch (rollbackErr) { discard = rollbackErr }
    throw err
  } finally {
    client.release(discard)
  }
}

// Start-up check (index.js): the pool can be built -- so the login works and is
// not privileged (assertRestrictedLogin) -- and the database has been
// bootstrapped: the identity resolver exists and this login may run it. A
// service pointed at an empty database, or one the bootstrap has not
// finished, refuses to start instead of answering 500 to every request.
export async function checkDatabase(pool) {
  const db = pool || await getPool()
  const { rows } = await db.query(
    `select to_regprocedure('auth.resolve_app_user(text)') is not null as resolver,
            coalesce(has_function_privilege(current_user, to_regprocedure('auth.resolve_app_user(text)')::oid, 'execute'), false) as can_resolve,
            to_regclass('public.orders') is not null as orders`)
  const r = rows[0] || {}
  if (!r.resolver || !r.orders) throw new Error('the database has not been bootstrapped (gcp/bootstrap.sh)')
  if (!r.can_resolve) throw new Error('the database login may not resolve identities -- it is not the bootstrap\'s app login')
}

export async function closePool() {
  if (poolPromise) await (await poolPromise).end()
}
