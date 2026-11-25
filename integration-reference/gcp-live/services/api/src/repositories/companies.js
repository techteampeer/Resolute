// Company profiles and client contacts (gcp/02_post_migrate.sql section 14).
// Each function takes a pg client ALREADY inside a withUserClaims transaction:
// RLS decides whose rows the caller reads and writes (a client its own
// company's, Admin every company's, production nothing); the guard triggers
// normalise the values and set author and times. Contacts are archived, never
// deleted.
const TS = (col) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
const CONTACT = `id::text as id, client_code, name, email, phone, title, marketing_opt_in, created_by,
       ${TS('created_at')} as created_at, ${TS('updated_at')} as updated_at`
const PROFILE = `client_code, address, city, state, zip, phone, website, logo_url, updated_by, ${TS('updated_at')} as updated_at`

// Is this client code one the caller may see (client_directory: Admin all, a client its own)?
export async function clientVisible(client, code) {
  const { rows } = await client.query('select 1 from public.client_directory where code = $1', [code])
  return rows.length === 1
}

export async function getProfile(client, code) {
  const { rows } = await client.query(`select ${PROFILE} from public.client_profiles where client_code = $1`, [code])
  return rows[0] || null
}

// Insert (baseline null: there must be none yet) or update on the version read.
// Returns the stored row, or null when it moved on / appeared meanwhile.
export async function saveProfile(client, code, baseline, p) {
  const vals = [code, p.address, p.city, p.state, p.zip, p.phone, p.website, p.logoUrl]
  if (baseline === null) {
    const { rows } = await client.query(
      `insert into public.client_profiles (client_code, address, city, state, zip, phone, website, logo_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (client_code) do nothing
       returning ${PROFILE}`, vals)
    return rows[0] || null
  }
  const { rows } = await client.query(
    `update public.client_profiles
        set address = $2, city = $3, state = $4, zip = $5, phone = $6, website = $7, logo_url = $8
      where client_code = $1 and updated_at = $9::timestamptz
      returning ${PROFILE}`, [...vals, baseline])
  return rows[0] || null
}

export async function listContacts(client, code) {
  const { rows } = await client.query(
    `select ${CONTACT} from public.client_contacts where client_code = $1 and archived_at is null order by lower(name), id`, [code])
  return rows
}

export async function getContact(client, id) {
  const { rows } = await client.query(`select ${CONTACT}, archived_at is not null as archived from public.client_contacts where id = $1`, [id])
  return rows[0] || null
}

export async function insertContact(client, code, c) {
  const { rows } = await client.query(
    `insert into public.client_contacts (client_code, name, email, phone, title, marketing_opt_in)
     values ($1, $2, $3, $4, $5, $6) returning ${CONTACT}`,
    [code, c.name, c.email, c.phone, c.title, c.marketingOptIn])
  return rows[0]
}

// On the version read; null when nothing matched (moved on, archived or hidden).
export async function updateContact(client, id, baseline, c) {
  const { rows } = await client.query(
    `update public.client_contacts set name = $3, email = $4, phone = $5, title = $6, marketing_opt_in = $7
      where id = $1 and updated_at = $2::timestamptz and archived_at is null
      returning ${CONTACT}`,
    [id, baseline, c.name, c.email, c.phone, c.title, c.marketingOptIn])
  return rows[0] || null
}

export async function archiveContact(client, id) {
  const { rows } = await client.query(
    'update public.client_contacts set archived_at = now() where id = $1 and archived_at is null returning id::text as id', [id])
  return rows[0] || null
}

// The contact an order's "placed by" names: a live contact of that company.
export async function placerFor(client, code, id) {
  const { rows } = await client.query(
    `select id::text as id, name, email, title from public.client_contacts
      where id = $1 and client_code = $2 and archived_at is null`, [id, code])
  return rows[0] || null
}
