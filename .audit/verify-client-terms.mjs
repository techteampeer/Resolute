import { browser, login, as, sql, sqlJson, shot } from './harness.mjs'
// Payment terms must survive the PII policy: they live on `clients` (super
// admin only) and on `client_directory` (all staff).
const b = await browser()
sql("update clients set payment_terms='days30' where code='CL01'")
sql("update clients set payment_terms='weekly' where code='CL02'")
console.log('db terms:', JSON.stringify(await sqlJson("select code, payment_terms from clients where code in ('CL01','CL02') order by code")))
for (const who of ['rajni','admin']) {
  const t = await as(who, '/client_directory?select=code,payment_terms&order=code')
  console.log(`  ${who.padEnd(6)} reads directory: ${Array.isArray(t.body) ? JSON.stringify(t.body.filter(r => ['CL01','CL02'].includes(r.code))) : 'HTTP ' + t.status}`)
}
for (const who of ['rajni','admin']) {
  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(1400)
  await page.goto('http://127.0.0.1:5173/admin/billing', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3200)
  const lines = (await page.locator('body').innerText()).split('\n').map(x => x.trim()).filter(Boolean)
  const heads = lines.filter(l => /^CL\d\d ·/.test(l))
  console.log(`  ${who.padEnd(6)} billing shows: ${JSON.stringify(heads)}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0,2))
  await shot(page, `terms-${who}`)
  await ctx.close()
}
sql("update clients set payment_terms='per_order' where code in ('CL01','CL02')")
console.log('restored:', JSON.stringify(await sqlJson("select code, payment_terms from clients where code in ('CL01','CL02') order by code")))
await b.close()
