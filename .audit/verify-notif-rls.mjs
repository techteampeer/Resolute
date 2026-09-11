import { as, sqlJson, ANON } from './harness.mjs'
const ids = Object.fromEntries((await sqlJson("select email, id from profiles where email in ('typer@resolute.com','screener@resolute.com','rajni@resolute.com','client@resolute.com')")).map(r => [r.email, r.id]))
const BASE = 'http://127.0.0.1:54321/rest/v1'

console.log('── writing someone ELSE\'s preference ──')
for (const [who, victim] of [['screener','typer@resolute.com'], ['typer','screener@resolute.com'], ['rajni','typer@resolute.com'], ['client','typer@resolute.com']]) {
  const r = await as(who, '/notification_preferences', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ profile_id: ids[victim], type_key: 'order.assigned', mode: 'off' }),
  })
  console.log(`  ${who.padEnd(9)} -> ${victim.padEnd(24)} HTTP ${r.status} ${Array.isArray(r.body) ? r.body.length + ' rows' : JSON.stringify(r.body).slice(0, 70)}`)
}

console.log('── writing your OWN ──')
for (const who of ['screener','typer','rajni']) {
  const email = `${who === 'rajni' ? 'rajni' : who}@resolute.com`
  const r = await as(who, '/notification_preferences', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ profile_id: ids[email], type_key: 'order.assigned', mode: 'digest' }),
  })
  console.log(`  ${who.padEnd(9)} -> own                      HTTP ${r.status} ${Array.isArray(r.body) ? r.body.length + ' rows' : JSON.stringify(r.body).slice(0, 70)}`)
}

console.log('── reading ──')
for (const who of ['screener','typer','rajni','client']) {
  const r = await as(who, '/notification_preferences?select=profile_id,type_key,mode')
  console.log(`  ${who.padEnd(9)} sees ${Array.isArray(r.body) ? r.body.length : JSON.stringify(r.body)} row(s)`)
}
console.log('── notification_types (catalogue) ──')
for (const who of ['screener','client']) {
  const r = await as(who, '/notification_types?select=key')
  console.log(`  ${who.padEnd(9)} HTTP ${r.status} ${Array.isArray(r.body) ? r.body.length + ' types' : JSON.stringify(r.body).slice(0, 70)}`)
}
const an = await fetch(`${BASE}/notification_preferences?select=*`, { headers: { apikey: ANON } })
console.log(`  anon      HTTP ${an.status} ${(await an.text()).slice(0, 60)}`)

console.log('\nwhat actually landed:', JSON.stringify(await sqlJson("select p.email, np.type_key, np.mode from notification_preferences np join profiles p on p.id=np.profile_id order by p.email, np.type_key")))
