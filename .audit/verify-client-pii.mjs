import { browser, login, as, sqlJson, shot } from './harness.mjs'
const b = await browser()
console.log('=== what each role may read, at the database ===')
for (const who of ['rajni','admin','screener','typer','client']) {
  const t = await as(who, '/clients?select=code,name')
  const d = await as(who, '/client_directory?select=code,payment_terms')
  const n = (x) => Array.isArray(x.body) ? `${x.body.length} rows` : `HTTP ${x.status}`
  console.log(`  ${who.padEnd(9)} clients(name): ${String(n(t)).padEnd(9)}  client_directory: ${n(d)}`)
}
console.log('\n=== what the billing page SHOWS each admin ===')
const names = (await sqlJson('select name from clients order by code')).map(r => r.name)
for (const who of ['rajni','admin']) {
  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(1400)
  await page.goto('http://127.0.0.1:5173/admin/billing', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3200)
  const txt = await page.locator('body').innerText()
  const shown = names.filter(n => txt.includes(n))
  const lines = txt.split('\n').map(x => x.trim()).filter(Boolean)
  const heads = lines.map((l, i) => /^CL\d\d ·/.test(l) ? `${lines[i-1]} / ${l.slice(0,4)}` : null).filter(Boolean)
  console.log(`  ${who.padEnd(6)} (super=${who === 'rajni'}) headers: ${JSON.stringify(heads)}`)
  console.log(`         company names visible: ${shown.length ? JSON.stringify(shown) : 'none'}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0,2))
  await shot(page, `pii-billing-${who}`)

  // The intake select must offer every client to both, by code.
  await page.goto('http://127.0.0.1:5173/admin/orders', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  const nb = page.getByRole('button', { name: /^New Order$/ }).first()
  if (await nb.count()) {
    await nb.click(); await page.waitForTimeout(1600)
    const opts = (await page.locator('select').first().locator('option').allInnerTexts()).slice(1)
    console.log(`         intake options (${opts.length}): ${JSON.stringify(opts)}`)
    const dbCodes = (await sqlJson('select code from clients order by code')).map(r => r.code)
    console.log(`         every client offered? ${opts.length === dbCodes.length ? 'yes ✓' : `*** ${opts.length} of ${dbCodes.length}`}`)
    const leaks = names.filter(n => opts.join(' ').includes(n))
    console.log(`         names in the options: ${leaks.length ? JSON.stringify(leaks) : 'none'}`)
    await shot(page, `pii-intake-${who}`)
  } else console.log('         *** New Order button not found')
  await ctx.close()
}
await b.close()
