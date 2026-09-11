import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()
// RTS-10044 is parked with Admin, has an ETA but no agreed price.
// RTS-10052 is confirmed and priced — its modal must carry no warning.
for (const ID of ['RTS-10044','RTS-10052']) {
  const r = (await sqlJson(`select status, eta, workflow->>'invoiceAmount' amt from orders where id='${ID}'`))[0]
  const { page, ctx, errors } = await login(b, 'rajni')
  await page.waitForTimeout(1400)
  await page.getByRole('button', { name: /^Orders/ }).first().click()
  await page.waitForTimeout(1800)
  const s = page.locator('input[placeholder*="Search order"]').first()
  if (await s.count()) { await s.fill(ID); await page.waitForTimeout(1000) }
  const tr = page.locator('tr', { hasText: ID }).first()
  const btn = tr.getByRole('button', { name: /Assign|Approve & Assign|Reassign/ }).first()
  if (!(await btn.count())) { console.log(`${ID}: no assign action`); await ctx.close(); continue }
  await btn.click(); await page.waitForTimeout(1400)
  const modal = page.locator('div.fixed.inset-0.z-50').first()
  const mt = await modal.innerText()
  const warn = /This order has no [^\n]*/.exec(mt)
  console.log(`${ID}  status=${r.status} eta=${r.eta} price=${r.amt || 'unset'}`)
  console.log(`   right order in modal: ${mt.includes(ID) ? 'yes' : '*** NO'}`)
  console.log(`   warning: ${warn ? JSON.stringify(warn[0]) : 'none'}`)
  await shot(page, `assign-warn-${ID}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0,2))
  await ctx.close()
}
await b.close()
