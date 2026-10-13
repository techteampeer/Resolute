import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()
console.log('ABS/Both-routed orders with no payout row:', JSON.stringify(await sqlJson(
  "select o.id, o.workflow->>'searchAssignment' route, o.status::text from orders o left join vendor_payouts v on v.order_id=o.id where (o.workflow->>'searchAssignment') in ('abs','both') and v.order_id is null order by o.id")))
const { page, ctx, errors } = await login(b, 'vivek')
await page.waitForTimeout(1500)
await page.goto('http://127.0.0.1:5173/admin/billing', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
const tabs = (await page.locator('button').allInnerTexts()).map(t => t.trim()).filter(Boolean)
console.log('billing tabs:', JSON.stringify(tabs.slice(0, 14)))
const pay = page.getByRole('button', { name: /payout/i }).first()
if (await pay.count()) { await pay.click(); await page.waitForTimeout(2000) }
const t = await page.locator('body').innerText()
console.log('--- payouts view ---')
console.log(t.split('\n').filter(l => l.trim()).slice(6, 46).join('\n'))
console.log('RTS-10055 listed?', t.includes('RTS-10055') ? 'YES ✓' : '*** NO')
await shot(page, 'payouts-pending')
const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('PAGE ERRORS:', pe.slice(0,2))
await ctx.close(); await b.close()
