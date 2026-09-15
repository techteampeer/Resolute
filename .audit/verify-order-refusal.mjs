import { browser, login, sqlJson, shot } from './harness.mjs'
// RTS-10041 is on the EXAMINER's desk. Drive the SCREENER to it and complete the
// stage: orders_update_assigned refuses it (200, zero rows) and the old build
// left the optimistic move on screen while the row never budged.
const ID = 'RTS-10041'
const b = await browser()
const before = (await sqlJson(`select status, assigned_to, progress from orders where id='${ID}'`))[0]
console.log('before:', JSON.stringify(before))

const { page, ctx, errors } = await login(b, 'screener')
await page.waitForTimeout(1200)
await page.goto(`http://127.0.0.1:5173/screener/order/${ID}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
console.log('url:', page.url(), '| body chars:', (await page.locator('body').innerText()).length)

const btns = await page.locator('button').allInnerTexts()
console.log('buttons:', JSON.stringify(btns.filter(t => t.trim()).slice(0, 24)))
await page.getByRole('button', { name: /^In-House$/ }).first().click()
await page.waitForTimeout(400)
const target = page.getByRole('button', { name: /Confirm & Send to Admin/i }).first()
if (await target.count()) {
  console.log('clicking:', JSON.stringify((await target.innerText()).trim()))
  await target.click()
  await page.waitForTimeout(1200)
  // a confirm dialog may follow
  const conf = page.getByRole('button', { name: /^(Confirm|Yes|Submit|Send)/i }).first()
  if (await conf.count()) { console.log('confirming:', JSON.stringify((await conf.innerText()).trim())); await conf.click() }
  await page.waitForTimeout(3500)
  const t = await page.locator('body').innerText()
  const i = t.search(/Not saved/i)
  console.log('banner shown:', i >= 0 ? 'YES ✓' : '*** NO')
  if (i >= 0) console.log('  ->', JSON.stringify(t.slice(i, i + 150).replace(/\n/g, ' ')))
} else {
  console.log('*** no stage-completion button on this screen')
}
console.log('after: ', JSON.stringify((await sqlJson(`select status, assigned_to, progress from orders where id='${ID}'`))[0]))
console.log('errors:', errors.filter(e => !e.includes('ERR_FAILED')).slice(0, 3))
await shot(page, 'order-refusal'); await ctx.close(); await b.close()
