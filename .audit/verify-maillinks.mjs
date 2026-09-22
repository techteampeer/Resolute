import { browser, login, sqlJson } from './harness.mjs'
const SEG = { admin:'orders', client:'orders', operator:'orders', screener:'order', examiner:'order', typer:'order', delivery:'order' }
const b = await browser()
const staffOrder = 'RTS-10048'
const clientOrder = (await sqlJson("select o.id from orders o join clients c on c.code=o.client_code join profiles p on p.client_code=c.code where p.email='client@resolute.com' limit 1"))[0]?.id
console.log('client-visible order:', clientOrder)
for (const [who, role] of [['rajni','admin'],['screener','screener'],['examiner','examiner'],['typer','typer'],['delivery','delivery'],['operator','user'],['client','client']]) {
  const id = role === 'client' ? clientOrder : staffOrder
  const path = `/${role}/${SEG[role]}/${id}`
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
