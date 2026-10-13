import { browser, login, sqlJson, sql, shot } from './harness.mjs'
// A plain admin places an order for a client whose name they may not see. The
// row must still carry the right client_code — the old form derived it by
// looking the NAME up in mockData, so it saved null for anyone not in the seven.
const b = await browser()
const before = (await sqlJson("select id from orders order by id desc limit 1"))[0].id
const { page, ctx, errors } = await login(b, 'admin')
await page.waitForTimeout(1400)
await page.goto('http://127.0.0.1:5173/admin/orders', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
await page.getByRole('button', { name: /^New Order$/ }).first().click()
await page.waitForTimeout(1500)
await page.locator('select').first().selectOption('CL05')
const inputs = page.locator('input[type="text"], input:not([type])')
await inputs.nth(0).fill('TX')
await inputs.nth(1).fill('Travis')
await page.waitForTimeout(400)
const create = page.getByRole('button', { name: /Create|Place|Add order/i }).first()
console.log('submit button:', await create.count() ? JSON.stringify((await create.innerText()).trim()) : '*** none')
if (await create.count()) { await create.click(); await page.waitForTimeout(4000) }
const row = (await sqlJson(`select id, client_code, client_file_no, state, county, status::text, assigned_to::text
                            from orders where id > '${before}' order by id desc limit 1`))[0]
console.log('new order row:', JSON.stringify(row || '(none created)'))
if (row) {
  console.log(`  client_code linked? ${row.client_code === 'CL05' ? 'YES ✓ (CL05)' : `*** ${row.client_code}`}`)
  console.log(`  what the client column stored:`, JSON.stringify((await sqlJson(`select client_code from orders where id='${row.id}'`))[0]))
  sql(`delete from order_events where order_id='${row.id}'`)
  sql(`delete from orders where id='${row.id}'`)
  console.log('  (test order removed)')
}
console.log('page errors:', errors.filter(e => e.startsWith('PAGEERROR')).slice(0, 2))
await shot(page, 'intake-plain-admin')
await ctx.close(); await b.close()
