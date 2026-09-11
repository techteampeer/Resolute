import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()
const ID = 'RTS-10048'   // on the typer's desk
const { page, ctx, errors } = await login(b, 'rajni')
await page.waitForTimeout(1400)
await page.goto(`http://127.0.0.1:5173/admin/order/${ID}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const t = await page.locator('body').innerText()
// what the Finalize block offers Admin
const i = t.indexOf('When you submit')
console.log('Finalize block as Admin:')
console.log(t.slice(i, i + 420).split('\n').filter(Boolean).map(l => '   ' + l).join('\n'))
const btns = (await page.locator('button').allInnerTexts()).map(x => x.trim()).filter(Boolean)
console.log('\nbuttons present:', JSON.stringify(btns.filter(x => /Commitment|Submit|Generat/i.test(x))))
const sub = page.getByRole('button', { name: /Submit for Admin Approval/ }).first()
console.log('submit disabled:', await sub.count() ? await sub.isDisabled() : '(no button)')
// completeness
console.log('completeness:', (t.match(/(\d) of 8/) || ['(none)'])[0])
console.log('tabs:', JSON.stringify(btns.filter(x => ['Overview','Fulfillment','Activity','Inbox','Files'].includes(x))))
// can Admin preview the document from here?
const gen = page.getByRole('button', { name: /Generate Commitment Document/ }).first()
if (await gen.count()) {
  await gen.click(); await page.waitForTimeout(3500)
  const m = await page.locator('body').innerText()
  console.log('preview modal opened:', /Title Commitment|Schedule B-I/i.test(m) ? 'yes ✓' : '*** no')
  await shot(page, 'admin-commitment-preview')
}
const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('PAGE ERRORS:', pe.slice(0,2))
console.log('order untouched by opening the form:', JSON.stringify((await sqlJson(`select status::text, assigned_to::text, progress from orders where id='${ID}'`))[0]))
await ctx.close(); await b.close()
