// Admin user-management data access (B4, profile side). Runs under withServiceRole
// — the same choice api/admin/users.js makes: the profiles_guard_privilege_columns
// BEFORE UPDATE trigger (migration 20260901220000) rejects any role / super_admin
// / client_code / status change unless the caller has no auth.uid() (i.e. the
// service role), so an admin editing ANOTHER user's privilege columns must go
// through service role. Authorization is therefore the ROUTE's code gate, not RLS
// — keep that gate airtight.

// The caller's own privilege, to decide whether an elevated grant is allowed
// (req.user carries role, not the super_admin flag).
export async function getProfilePrivilege(client, id) {
  const { rows } = await client.query('select role, super_admin from public.profiles where id = $1 limit 1', [id])
  return rows[0] || null
}

// A client user MUST point at a real clients row. orders.client_code is FK'd to
// clients(code), so a blank/unknown code mints an account that logs in and passes
// RLS but whose every order placement is rejected by the FK (23503) — the "newly
// created client can't place orders" bug. Returns an error string or null.
export async function badClientLink(client, role, clientCode) {
  if (role !== 'client') return null
  const code = (clientCode || '').trim()
  if (!code) return 'A client user must be linked to a client (client code required).'
  const { rows } = await client.query('select 1 from public.clients where code = $1 limit 1', [code])
  if (!rows.length) return `Client ${code} does not exist. Create the client first, or choose an existing one.`
  return null
}

// Column specs: [column, value, cast]. role is the user_role enum and permissions
// is jsonb, so both need an explicit cast on a text/JSON parameter.
const COLS = {
  name: (v) => ['name', v, ''],
  role: (v) => ['role', v, '::public.user_role'],
  client_code: (v) => ['client_code', v, ''],
  super_admin: (v) => ['super_admin', v, ''],
  can_confirm_payments: (v) => ['can_confirm_payments', v, ''],
  permissions: (v) => ['permissions', JSON.stringify(v ?? []), '::jsonb'],
}

// Apply a profiles patch (from buildProfilePatch). Returns the row count so the
// route can distinguish "updated" from "no such user" (0 rows).
export async function updateProfile(client, id, patch) {
  const sets = []
  const vals = []
  for (const [key, val] of Object.entries(patch)) {
    const spec = COLS[key]
    if (!spec) continue
    const [col, pval, cast] = spec(val)
    vals.push(pval)
    sets.push(`${col} = $${vals.length}${cast}`)
  }
  if (!sets.length) return 0
  vals.push(id)
  const { rowCount } = await client.query(
    `update public.profiles set ${sets.join(', ')} where id = $${vals.length}`, vals)
  return rowCount
}
