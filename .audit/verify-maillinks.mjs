import { browser, login, sqlJson } from './harness.mjs'
// Post-D3 (ADR 0001): notification deep-links resolve to a LIVE portal for every
// recipient. Admin and client link into their own portal; every production
// recipient — the `user` desk, and any legacy stage recipient_role carried by an
// outbox row queued before D3 — is normalized by linkFor() to the /user desk
// (/user/orders/:id), never a deleted /<stage>/… route. This mirrors the
// normalization in services/notify/types.js.
const pathFor = (role, id) =>
  role === 'admin'  ? `/admin/orders/${id}`
  : role === 'client' ? `/client/orders/${id}`
  : `/user/orders/${id}`   // `user` and any retired stage role
const b = await browser()
const staffOrder = 'RTS-10048'
const clientOrder = (await sqlJson("select o.id from orders o join clients c on c.code=o.client_code join profiles p on p.client_code=c.code where p.email='client@resolute.com' limit 1"))[0]?.id
console.log('client-visible order:', clientOrder)
// `operator@` holds the `user` role; it also stands in for a legacy stage
// recipient, whose link linkFor() normalizes to the same /user desk.
for (const [who, role] of [['rajni','admin'],['operator','user'],['operator','screener'],['operator','delivery'],['client','client']]) {
  const id = role === 'client' ? clientOrder : staffOrder
  const path = pathFor(role, id)
  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(1200)
  await page.goto(`http://127.0.0.1:5173${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const t = await page.locator('body').innerText()
  const bad = /not found/i.test(t)
  console.log(`${role.padEnd(9)} ${path.padEnd(34)} chars=${String(t.length).padEnd(6)} url=${page.url().replace('http://127.0.0.1:5173','')} ${bad ? '*** NOT FOUND' : (t.includes(id) ? 'shows the order ✓' : '(order id not on page)')}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR'))
  if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0,2))
  await ctx.close()
}
await b.close()
