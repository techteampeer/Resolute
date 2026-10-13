import { browser, login, sql, sqlJson, shot } from './harness.mjs'
const b = await browser()
const CODE = 'CL08', NAME = 'Harborline Title Co'
const { page, ctx, errors } = await login(b, 'rajni')
await page.waitForTimeout(1500)

// 1. Billing header for a client the fixture has never heard of
await page.goto('http://127.0.0.1:5173/admin/billing', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3200)
const lines = (await page.locator('body').innerText()).split('\n').map(x => x.trim()).filter(Boolean)
const i = lines.findIndex(l => l.startsWith(`${CODE} ·`))
console.log(`billing header for ${CODE}: ${JSON.stringify(lines.slice(Math.max(0,i-1), i+1))}`)
console.log(`  ${lines[i-1] === NAME ? '✓ names the client from the registry' : `*** still "${lines[i-1]}"`}`)
// every client block names a company, not a bare code
const headers = lines.map((l, n) => /^CL\d\d ·/.test(l) ? [lines[n-1], l.slice(0,4)] : null).filter(Boolean)
console.log('  all client blocks:', JSON.stringify(headers))
console.log('  any bare-code header?', headers.some(([nm, cd]) => nm === cd) ? '*** yes' : 'no ✓')
await shot(page, 'billing-registry')

// 2. Admin's order-intake select must offer the new client
await page.goto('http://127.0.0.1:5173/admin/orders', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
const labels = (await page.locator('button').allInnerTexts()).map(x => x.trim()).filter(Boolean)
console.log('\nbuttons on /admin/orders:', JSON.stringify(labels.slice(0, 18)))
const nb = page.getByRole('button', { name: /New Order|Place Order|\+ Order/i }).first()
if (await nb.count()) {
  await nb.click(); await page.waitForTimeout(1500)
  const opts = await page.locator('select').first().locator('option').allInnerTexts()
  console.log(`\nintake client options (${opts.length - 1}): ${JSON.stringify(opts.slice(1))}`)
  console.log(`  offers ${CODE}? ${opts.some(o => o.includes(CODE)) ? 'YES ✓' : '*** NO'}`)
  const dbCodes = (await sqlJson('select code from clients order by code')).map(r => r.code)
  console.log(`  matches the registry (${dbCodes.length} clients)? ${opts.length - 1 === dbCodes.length ? 'yes ✓' : '*** ' + (opts.length-1) + ' vs ' + dbCodes.length}`)
  await shot(page, 'intake-clients')
  await page.keyboard.press('Escape')
} else console.log('\n*** New Order button not found')

// 3. Coverage map legend + tooltip must come from real orders
const byState = await sqlJson("select state, count(*) n from orders group by 1 order by 2 desc, 1")
const max = Math.max(...byState.map(r => Number(r.n)))
console.log(`\ndb by state: ${JSON.stringify(byState)}  max=${max}`)
await page.goto('http://127.0.0.1:5173/admin/map', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const map = (await page.locator('body').innerText()).split('\n').map(x => x.trim()).filter(Boolean)
// The legend sits in the map card, after the page subtitle — not the sidebar.
const sub = map.findIndex(l => /Real-time order distribution/.test(l))
const li = map.findIndex((l, n) => n > sub && l === 'Orders')
console.log('legend on screen:', JSON.stringify(li === -1 ? map.slice(sub + 1, sub + 8) : map.slice(li + 1, li + 5)))
const step = Math.max(1, Math.ceil(max / 4))
const want = [`1–${step}`, `${step+1}–${step*2}`, `${step*2+1}–${step*3}`, `${step*3+1}+`]
  .map(l => l.replace(/^(\d+)–\1$/, '$1'))
console.log('legend expected: ', JSON.stringify(want))
console.log('  ', JSON.stringify(map.slice(li+1, li+5)) === JSON.stringify(want) ? '✓ derived from the real maximum' : '*** mismatch')
// top-five panel under the map
console.log('top states panel:', JSON.stringify(map.slice(li + 5, li + 16)))
await shot(page, 'map-real')
console.log('\npage errors:', errors.filter(e => e.startsWith('PAGEERROR')).slice(0, 3))
await ctx.close(); await b.close()
