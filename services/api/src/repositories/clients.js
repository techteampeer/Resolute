// Client-company data access (B2). Admin match-or-create a client by company
// NAME — never a code, never fuzzy. Reuses the tested admin_create_client
// SECURITY DEFINER wrapper verbatim (migration 20261104000000): it re-checks
// is_admin() on the CALLER's auth.uid() (defense in depth, even though it runs as
// its owner) and delegates to intake_resolve_client — the same per-name
// advisory-locked resolver the email/website intake uses. So the GCP path is
// byte-for-byte the Supabase behaviour; createAdminClient in supabase.js is the
// oracle.
//
// Returns the resolver's result unchanged:
//   { status: 'created',   code, name }
//   { status: 'matched',   code, name }   (idempotent — an existing client)
//   { status: 'ambiguous', codes }        (several match — the UI asks admin to pick)
import { HttpError } from '../errors.js'

export async function createAdminClient(client, { company, contact, email }) {
  try {
    const { rows } = await client.query(
      'select public.admin_create_client($1, $2, $3) as result',
      [company, contact, email],
    )
    return rows[0].result
  } catch (err) {
    // The wrapper raises with explicit SQLSTATEs. 42501: the caller is not an
    // admin (the DB guard behind the route's role pre-check). 22023: the company
    // normalised to nothing. Everything else is unexpected → 500 via the route.
    if (err?.code === '42501') throw new HttpError(403, 'only an admin can create a client')
    if (err?.code === '22023') throw new HttpError(422, 'company name is required')
    throw err
  }
}
