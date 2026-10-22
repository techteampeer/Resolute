// Verifies the per-company people directory (client_contacts) RLS over the real
// REST path (PostgREST + RLS, real JWTs):
//   • a client can create + read ONLY their own company's contacts;
//   • a client cannot write a contact for another company;
//   • a PRODUCTION user (role 'user') can read NONE (PII) and cannot write;
//   • an ADMIN can read every company's contacts.
// Model script: asserts with an exit code (exit 1 on any failure).
//   node .audit/verify-contacts-rls.mjs
import { as, sql, sqlJson } from './harness.mjs'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}
const n = (res) => (Array.isArray(res.body) ? res.body.length : `status ${res.status}`)

// The client login's own company code (RLS keys on my_client_code()), and some
// OTHER company's code to prove isolation.
const MINE = sqlJson(`select client_code from profiles where email = 'client@resolute.com'`)[0]?.client_code
const OTHER = sqlJson(`select code from clients where code <> '${MINE}' order by code limit 1`)[0]?.code

console.log('── client_contacts RLS ──')
check('client login has a client_code', !!MINE, `code=${MINE}`)
sql(`delete from public.client_contacts where name like 'AUDIT %'`)

// 1. Client creates a contact for their OWN company.
const ins = await as('client', 'client_contacts', { method: 'POST',
  body: JSON.stringify({ client_code: MINE, name: 'AUDIT Jo Placer', email: 'jo@acme.test', marketing_opt_in: true }) })
check('client can add a contact to their own company', ins.status < 300, `HTTP ${ins.status}`)

// 2. Client reads their own contacts.
const mine = await as('client', 'client_contacts?select=*&name=like.AUDIT*')
check('client reads their own contacts', mine.status < 300 && n(mine) >= 1, `n=${n(mine)}`)

// 3. Client cannot write a contact for ANOTHER company (spoofed client_code).
const spoof = await as('client', 'client_contacts', { method: 'POST',
  body: JSON.stringify({ client_code: OTHER, name: 'AUDIT Spoof' }) })
check('client cannot add a contact for another company', spoof.status >= 400, `HTTP ${spoof.status}`)

// 4. A production user (role 'user') reads NO contacts (PII — the client-code rule).
const prod = await as('user', 'client_contacts?select=*&name=like.AUDIT*')
check('production user sees zero contacts', prod.status < 300 && n(prod) === 0, `n=${n(prod)}`)

// 5. A production user cannot write a contact.
const prodW = await as('user', 'client_contacts', { method: 'POST',
  body: JSON.stringify({ client_code: MINE, name: 'AUDIT ProdWrite' }) })
check('production user cannot add a contact', prodW.status >= 400, `HTTP ${prodW.status}`)

// 6. An admin reads every company's contacts (incl. the client's).
const adm = await as('admin', 'client_contacts?select=*&name=like.AUDIT*')
check('admin reads all contacts', adm.status < 300 && n(adm) >= 1, `n=${n(adm)}`)

sql(`delete from public.client_contacts where name like 'AUDIT %'`)

// ── client_profiles RLS (the editable half of Company Settings) ──────────────
console.log('── client_profiles RLS ──')
sql(`delete from public.client_profiles where client_code in ('${MINE}', '${OTHER}')`)
// 1. Client saves their own company profile.
const pIns = await as('client', 'client_profiles', { method: 'POST',
  body: JSON.stringify({ client_code: MINE, address: '1 Audit Way', city: 'Testville' }) })
check('client can save their own company profile', pIns.status < 300, `HTTP ${pIns.status}`)
// 2. Client reads their own profile.
const pMine = await as('client', `client_profiles?select=*&client_code=eq.${MINE}`)
check('client reads their own profile', pMine.status < 300 && n(pMine) === 1, `n=${n(pMine)}`)
// 3. Client cannot write another company's profile.
const pSpoof = await as('client', 'client_profiles', { method: 'POST',
  body: JSON.stringify({ client_code: OTHER, address: 'nope' }) })
check('client cannot write another company profile', pSpoof.status >= 400, `HTTP ${pSpoof.status}`)
// 4. A production user sees no company profiles.
const pProd = await as('user', `client_profiles?select=*&client_code=eq.${MINE}`)
check('production user sees no company profiles', pProd.status < 300 && n(pProd) === 0, `n=${n(pProd)}`)
// 5. An admin reads it.
const pAdm = await as('admin', `client_profiles?select=*&client_code=eq.${MINE}`)
check('admin reads company profiles', pAdm.status < 300 && n(pAdm) >= 1, `n=${n(pAdm)}`)
sql(`delete from public.client_profiles where client_code in ('${MINE}', '${OTHER}')`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
