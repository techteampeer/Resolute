import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()
for (const id of ['RTS-10052','RTS-10041']) {
  const row = (await sqlJson(`select status, progress, workflow->>'confirmed' confirmed from orders where id='${id}'`))[0]
  const { page, ctx, errors } = await login(b, 'rajni')
  await page.waitForTimeout(1200)
  await page.goto(`http://127.0.0.1:5173/admin/orders/${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const btns = (await page.locator('button').allInnerTexts()).map(t => t.trim()).filter(Boolean)
  const label = btns.find(t => /price/i.test(t)) || '(no pricing button)'
  console.log(`${id}  ${row.status}/${row.progress}%  confirmed=${row.confirmed}  ->  button: ${JSON.stringify(label)}`)
  const open = page.getByRole('button', { name: /price/i }).first()
  if (await open.count()) {
    await open.click(); await page.waitForTimeout(900)
    const modal = await page.locator('body').innerText()
    const head = modal.match(/Set price & committed date|Confirm & price order/)
    const warn = /Work on this order has already started[^\n]*/.exec(modal)
    console.log(`   modal title: ${JSON.stringify(head?.[0] || '(none)')}`)
    console.log(`   warning:     ${warn ? JSON.stringify(warn[0]) : 'none'}`)
    console.log(`   submit:      ${JSON.stringify((await page.locator('button').allInnerTexts()).map(t=>t.trim()).find(t => /^(Confirm order|Save price & date)$/.test(t)) || '(none)')}`)
    await shot(page, `confirm-${id}`)
  }
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0,2))
  await ctx.close()
}
await b.close()
