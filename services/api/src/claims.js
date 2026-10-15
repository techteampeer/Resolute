// The JWT claims the Cloud SQL auth shim reads, per transaction.
//
// gcp/01_bootstrap.sql defines:
//   auth.uid()  = current_setting('request.jwt.claims', true)::jsonb ->> 'sub'  (a UUID)
//   auth.role() = current_setting('request.jwt.claims', true)::jsonb ->> 'role' (default 'anon')
//
// So `sub` MUST be the portal's own profiles.id UUID — NEVER the Firebase UID
// (Firebase issues 28-char strings; every policy and FK is built on the uuid).
// The app role (admin/user/client) is NOT carried here: my_role() reads it from
// the profiles row via auth.uid(), so the database stays the source of truth.
//
// Pure and dependency-free on purpose: it is the one piece of the claims path
// that can be unit-tested without a database.
export function claimsForUser(user) {
  if (!user || !user.id) {
    throw new Error('claimsForUser: user.id (the profiles.id UUID) is required')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
    // Guard the exact failure gcp/README warns about: a raw Firebase UID here
    // makes auth.uid()'s ::uuid cast throw and every policy with it.
    throw new Error('claimsForUser: user.id must be a UUID (profiles.id), not a Firebase UID')
  }
  return JSON.stringify({
    sub: user.id,            // -> auth.uid()
    role: 'authenticated',   // -> auth.role(); the DB ROLE is SET separately
    email: user.email || null,
  })
}
