import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()

console.log('=== what the database actually holds ===')
console.log('orders per state:', JSON.stringify(await sqlJson("select state, count(*) n from orders group by 1 order by 2 desc, 1")))
console.log('clients in the DB:', JSON.stringify(await sqlJson("select code, name from clients order by code")))
console.log('client codes on orders:', JSON.stringify(await sqlJson("select distinct client_code from orders where client_code is not null order by 1")))

const { page, ctx, errors } = await login(b, 'rajni')
await page.waitForTimeout(1500)

// Coverage Map
await page.goto('http://127.0.0.1:5173/admin/map', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const map = await page.locator('body').innerText()
console.log('\n=== /admin/map ===')
console.log(map.split('\n').filter(l => l.trim()).slice(6, 26).join('\n'))
await shot(page, 'map')

// Billing — client names
await page.goto('http://127.0.0.1:5173/admin/billing', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const bill = await page.locator('body').innerText()
console.log('\n=== /admin/billing (client headers) ===')
console.log(bill.split('\n').filter(l => /^(CL\d\d|.*· (Per order|Weekly|Every))/.test(l.trim())).slice(0, 20).join('\n'))
const codes = [...bill.matchAll(/\bCL\d\d\b/g)].map(m => m[0])
console.log('codes seen on screen:', JSON.stringify([...new Set(codes)]))
await shot(page, 'billing')

// Reports
await page.goto('http://127.0.0.1:5173/admin/reports', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
console.log('\n=== /admin/reports ===')
console.log((await page.locator('body').innerText()).split('\n').filter(l => l.trim()).slice(6, 30).join('\n'))
await shot(page, 'reports')

console.log('\npage errors:', errors.filter(e => e.startsWith('PAGEERROR')).slice(0, 3))
await ctx.close(); await b.close()
