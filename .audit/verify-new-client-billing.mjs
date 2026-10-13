import { browser, login, sql, sqlJson, shot } from './harness.mjs'
// A client that exists in the database but not in src/data/mockData.js — which
// is every client Resolute onboards from now on, including the pilot.
const CODE = 'CL08', NAME = 'Harborline Title Co'
const b = await browser()
sql(`insert into clients (code,name,contact,email,phone,registered,activity,payment)
     values ('${CODE}','${NAME}','Pat Reyes','pat@harborline.test','(904) 555-0101','2026-09-01','medium','ACH')
     on conflict (code) do update set name=excluded.name`)
sql(`insert into orders (id,client_code,state,county,type,status,priority,progress,created,completed,completed_dates,completed_by,workflow)
     values ('RTS-90001','${CODE}','FL','Duval','Full Search','delivered','normal',100,current_date,current_date,
             jsonb_build_object('delivery', to_char(current_date,'YYYY-MM-DD')), '{"delivery":"Morgan Davis"}'::jsonb,
             '{"invoiceAmount":175,"invoicedAt":"2026-09-11"}'::jsonb)
     on conflict (id) do nothing`)
console.log('seeded:', JSON.stringify(await sqlJson(`select code, name from clients where code='${CODE}'`)))

const { page, ctx, errors } = await login(b, 'rajni')
await page.waitForTimeout(1500)
await page.goto('http://127.0.0.1:5173/admin/billing', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3200)
const lines = (await page.locator('body').innerText()).split('\n').map(x => x.trim()).filter(Boolean)
const i = lines.findIndex(l => l.startsWith(`${CODE} ·`))
console.log(`\nheader for ${CODE}: ${JSON.stringify(lines.slice(Math.max(0,i-1), i+1))}`)
console.log(`shows the client's name? ${lines[i-1] === NAME ? 'YES' : `*** NO — renders "${lines[i-1]}"`}`)
console.log(`invoice row:`, JSON.stringify(lines.slice(i, i+10).find(l => l.includes('RTS-90001')) || '(not found)'))
await shot(page, 'billing-new-client')
console.log('page errors:', errors.filter(e => e.startsWith('PAGEERROR')).slice(0,2))
await ctx.close(); await b.close()
