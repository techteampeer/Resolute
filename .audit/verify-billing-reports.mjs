import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()
const { page, ctx, errors } = await login(b, 'rajni')
await page.waitForTimeout(1500)

await page.goto('http://127.0.0.1:5173/admin/billing', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const bill = (await page.locator('body').innerText()).split('\n').map(x => x.trim()).filter(Boolean)
const i = bill.findIndex(l => /^CL\d\d ·/.test(l))
console.log('=== /admin/billing, around the client headers ===')
console.log(bill.slice(Math.max(0, i - 2), i + 24).join('\n'))

console.log('\n=== /admin/reports, each grouping ===')
await page.goto('http://127.0.0.1:5173/admin/reports', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
for (const g of ['By State', 'By Client', 'By Status']) {
  const btn = page.getByRole('button', { name: g, exact: true }).first()
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(1200) }
  const t = (await page.locator('body').innerText()).split('\n').map(x => x.trim()).filter(Boolean)
  const j = t.findIndex(l => l === 'By Client')
  console.log(`\n--- ${g} ---`)
  console.log(t.slice(j + 1, j + 20).join(' | '))
}
console.log('\ndb by state:', JSON.stringify(await sqlJson("select state, count(*) n from orders group by 1 order by 2 desc, 1")))
console.log('db by client:', JSON.stringify(await sqlJson("select client_code, count(*) n from orders group by 1 order by 1")))
await shot(page, 'reports-by')
console.log('\npage errors:', errors.filter(e => e.startsWith('PAGEERROR')).slice(0, 3))
await ctx.close(); await b.close()
