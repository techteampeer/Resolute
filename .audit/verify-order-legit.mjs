import { browser, login, sqlJson, shot } from './harness.mjs'
// RTS-10044 IS on the screener's desk: the same action must succeed, move the
// row, and show no banner.
const ID = 'RTS-10044'
const b = await browser()
console.log('before:', JSON.stringify((await sqlJson(`select status, assigned_to, progress, workflow->>'searchRoute' route from orders where id='${ID}'`))[0]))
const { page, ctx, errors } = await login(b, 'screener')
await page.waitForTimeout(1200)
await page.goto(`http://127.0.0.1:5173/screener/order/${ID}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.getByRole('button', { name: /^In-House$/ }).first().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: /Confirm & Send to Admin/i }).first().click()
await page.waitForTimeout(1200)
const conf = page.getByRole('button', { name: /^(Confirm|Yes|Submit|Send)/i }).first()
if (await conf.count()) await conf.click()
await page.waitForTimeout(3500)
const t = await page.locator('body').innerText()
console.log('banner shown:', /Not saved/i.test(t) ? '*** YES (should be none)' : 'no ✓')
console.log('after: ', JSON.stringify((await sqlJson(`select status, assigned_to, progress, workflow->>'searchRoute' route from orders where id='${ID}'`))[0]))
console.log('events:', JSON.stringify(await sqlJson(`select action, actor from order_events where order_id='${ID}' order by created_at desc limit 2`)))
console.log('errors:', errors.filter(e => !e.includes('ERR_FAILED')).slice(0, 3))
await shot(page, 'order-legit'); await ctx.close(); await b.close()
