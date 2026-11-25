// Profiles data access. Takes a pg client that is ALREADY inside a
// withUserClaims transaction, so RLS applies. profiles_read still lets staff
// read the whole roster, so it is the explicit `where id = $1` -- not RLS -- that
// keeps this to the requester's own row.

// The requester's own profile, by the verified profiles.id: only the columns
// the user object needs, plus status for the active check. No email, no
// Firebase mapping.
export async function getOwnProfile(client, id) {
  const { rows } = await client.query(
    `select id, name, role, status, super_admin, client_code, can_confirm_payments, permissions
       from public.profiles
      where id = $1`,
    [id],
  )
  return rows[0] || null
}

// The staff roster the Admin screens name people from and assign work to (the
// Stage Plan picker keeps active production accounts). Only what those screens
// use -- id, name, role, status -- never email, flags or the Firebase mapping.
// Gated to active admins by the route; RLS (profiles_read) still applies.
export async function listRoster(client) {
  const { rows } = await client.query(
    `select id::text as id, name, role::text as role, status
       from public.profiles
      order by name, id`,
  )
  return rows
}

// The caller's authority, from the database's status-aware helpers -- never the
// token or the request -- read in the same transaction as the work it gates.
export async function callerAuthority(client) {
  const { rows } = await client.query(
    'select public.is_admin() as admin, public.can_work_production() as production, public.my_client_code() as client_code',
  )
  return rows[0]
}
