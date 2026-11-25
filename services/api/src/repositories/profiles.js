// Profile data access. Takes a pg client ALREADY inside a withUserClaims
// transaction (the caller's claims, RLS on): profiles_read lets a user read
// their own row, so this can never return someone else's profile.

// The requester's own profile row, or null. `id` is req.user.id -- set by the
// auth gate from the verified Firebase token, never from request input.
export async function getOwnProfile(client, id) {
  const { rows } = await client.query(
    `SELECT id, name, role, status, super_admin,
            client_code, can_confirm_payments, permissions
       FROM public.profiles
      WHERE id = $1`,
    [id],
  )
  return rows[0] || null
}
