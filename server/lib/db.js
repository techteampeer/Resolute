import pg from 'pg'

/**
 * Postgres access for the portal, against Cloud SQL.
 *
 * Replaces the Supabase JS client. The syntax change is the least of it: over
 * PostgREST, Supabase attached the caller's identity to every request for us,
 * and the RLS policies keyed on it. Nothing does that now, so this module owns
 * it — every query made on a user's behalf goes through `withUser`, which sets
 * `request.jwt.claims` for the life of one transaction. That is what
 * `auth.uid()` reads (see gcp/01_bootstrap.sql), so all 36 policies keep
 * applying exactly as they did.
 *
 * Read `withUser` before adding a query anywhere in this server.
 */

// On Cloud Run the instance is reached through the unix socket that
// --add-cloudsql-instances mounts at /cloudsql/<connection name>; `pg` takes
// that directory as `host`. Locally it is ordinary TCP, usually to the Cloud SQL
// Auth Proxy or a local Postgres.
const instance = process.env.INSTANCE_CONNECTION_NAME
const useSocket = Boolean(instance)

export const pool = new pg.Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ...(useSocket
    ? { host: `/cloudsql/${instance}` }
    : {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 5432),
        // The Auth Proxy terminates TLS itself, so asking for SSL on top of a
        // direct connection to it fails.
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
      }),
  // Cloud SQL's connection limit is per instance, not per container, and Cloud
  // Run scales containers out. Keep this modest.
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

// A broken idle client must never take the process down.
pool.on('error', (err) => console.error('[db] idle client error', err))

/**
 * Run `fn` inside one transaction, as `profileId`, with RLS applying.
 *
 * The third argument to set_config is `true`: the value is scoped to this
 * transaction and discarded at COMMIT or ROLLBACK. That matters more than it
 * looks — clients are pooled and reused, so a value that outlived its
 * transaction would still be set when the next request borrowed the same
 * connection, and that request would read the previous user's rows. Every
 * statement that needs RLS therefore has to run inside this transaction, on
 * this client, not on `pool` directly.
 *
 * `profileId` is the portal's own profiles.id uuid, never the raw Firebase UID —
 * see lib/auth.js for why, and gcp/01_bootstrap.sql for the mapping.
 */
export async function withUser(profileId, fn) {
  if (!profileId) throw new Error('withUser: profileId is required')
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
      [profileId]
    )
    // PostgREST ran as the `authenticated` role; match that so policies which
    // check the role behave identically. Reset happens with the transaction.
    await client.query('set local role authenticated')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (err) {
    try { await client.query('rollback') } catch { /* connection already gone */ }
    throw err
  } finally {
    client.release()
  }
}

/** One query as `profileId`. Returns rows. */
export async function queryAs(profileId, text, params = []) {
  return withUser(profileId, async (c) => (await c.query(text, params)).rows)
}

/** First row as `profileId`, or null. */
export async function oneAs(profileId, text, params = []) {
  const rows = await queryAs(profileId, text, params)
  return rows[0] ?? null
}

/**
 * A query with NO user attached, so RLS sees a null auth.uid().
 *
 * Only for work that genuinely precedes a session — resolving a Firebase UID to
 * a profile at sign-in. It is not an admin escape hatch: the policies still
 * apply, and with no user set they match nothing on most tables.
 */
export async function queryAnon(text, params = []) {
  return (await pool.query(text, params)).rows
}
