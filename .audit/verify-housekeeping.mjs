import { ANON, as, sql } from './harness.mjs'
const BASE = 'http://127.0.0.1:54321/rest/v1'
const TABLES = ['orders','profiles','order_events','fulfillments','notification_preferences','notification_types','clients','vendor_payouts']

console.log('── anon (no JWT): must be empty or 401, never a 500 ──')
for (const t of TABLES) {
  const r = await fetch(`${BASE}/${t}?select=*&limit=2`, { headers: { apikey: ANON } })
  const body = await r.text()
  console.log(`  ${t.padEnd(26)} HTTP ${r.status}  ${body.length > 90 ? body.slice(0,90)+'…' : body}`)
}

console.log('── anon calling the helpers directly over RPC: must be refused ──')
for (const fn of ['is_admin','is_staff','my_role','my_client_code']) {
  const r = await fetch(`${BASE}/rpc/${fn}`, { method:'POST', headers: { apikey: ANON, 'Content-Type':'application/json' }, body: '{}' })
  console.log(`  ${fn.padEnd(16)} HTTP ${r.status}  ${(await r.text()).slice(0,80)}`)
}

console.log('── signed-in roles: reads must still work ──')
for (const who of ['rajni','screener','examiner','typer','delivery','operator','client']) {
  const o = await as(who, '/orders?select=id&limit=3')
  const p = await as(who, '/profiles?select=id,name&limit=3')
  const e = await as(who, '/order_events?select=id&limit=3')
  const f = await as(who, '/fulfillments?select=order_id&limit=3')
  const n = (x) => Array.isArray(x.body) ? x.body.length : `HTTP ${x.status} ${JSON.stringify(x.body).slice(0,60)}`
  console.log(`  ${who.padEnd(9)} orders=${n(o)}  profiles=${n(p)}  events=${n(e)}  fulfillments=${n(f)}`)
}

console.log('── schema state ──')
process.stdout.write(sql("select conname from pg_constraint where conrelid='public.order_events'::regclass and contype='c';"))
process.stdout.write(sql("select indexname from pg_indexes where schemaname='public' and indexname in ('notification_outbox_recipient_id_idx','notification_outbox_type_key_idx','notification_preferences_type_key_idx','fulfillments_updated_by_idx') order by 1;"))
process.stdout.write(sql("select count(*) as policies_still_calling_uid_per_row from pg_policy p where (coalesce(pg_get_expr(p.polqual,p.polrelid),'') ~ 'auth\\.uid\\(\\)' and coalesce(pg_get_expr(p.polqual,p.polrelid),'') !~ '\\( SELECT auth\\.uid\\(\\)') or (coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') ~ 'auth\\.uid\\(\\)' and coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') !~ '\\( SELECT auth\\.uid\\(\\)');"))
process.stdout.write(sql("select p.proname, array_agg(distinct a.rolname order by a.rolname) grantees from pg_proc p, aclexplode(p.proacl) ac, pg_roles a where p.pronamespace='public'::regnamespace and a.oid=ac.grantee and p.proname in ('is_admin','is_staff','my_role','my_client_code') group by 1 order by 1;"))
