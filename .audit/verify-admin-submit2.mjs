import { browser, login, sqlJson, shot } from './harness.mjs'
const ID = 'RTS-10048'      // on the typer's desk, fulfillment already 8/8
const b = await browser()
const row = async () => (await sqlJson(`select status::text, assigned_to::text, progress, completed_by, completed_dates,
  workflow->'commitmentDoc'->>'name' doc, workflow->>'invoiceAmount' amt, workflow->>'invoicedAt' invoiced_at
  from orders where id='${ID}'`))[0]
console.log('before:', JSON.stringify(await row()))

const { page, ctx, errors } = await login(b, 'rajni')
await page.waitForTimeout(1400)
await page.goto(`http://127.0.0.1:5173/admin/order/${ID}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3200)
const t = await page.locator('body').innerText()
console.log('completeness:', t.match(/(\d) of 8/)?.[0])
const sub = page.getByRole('button', { name: /Mark typing complete/ }).first()
console.log('button:', await sub.count() ? JSON.stringify((await sub.innerText()).trim()) : '*** none', '| disabled:', await sub.count() ? await sub.isDisabled() : '-')
if (await sub.count() && !(await sub.isDisabled())) { await sub.click(); await page.waitForTimeout(8000) }
console.log('after :', JSON.stringify(await row()))
console.log('event :', JSON.stringify((await sqlJson(`select action, actor from order_events where order_id='${ID}' order by created_at desc limit 1`))[0]))
const t2 = await page.locator('body').innerText()
console.log('banner:', /Not saved/.test(t2) ? '*** ' + (t2.match(/Not saved[^\n]*/)||[])[0] : 'none ✓')
const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('PAGE ERRORS:', pe.slice(0,2))
await shot(page, 'admin-submit-fixed')
await ctx.close(); await b.close()
