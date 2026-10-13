import { browser, login, sqlJson, shot } from './harness.mjs'
// Admin's access to the typer's fulfillment form, on orders sitting on OTHER
// desks. Reached the way Admin actually reaches it: Orders → the order → the
// "Open fulfillment form" button on the detail page.
const b = await browser()

// A super admin and a plain admin, on an examiner's order and a screener's.
const cases = [
  ['rajni', 'RTS-10041', 'ADMIN-SUPER-EDIT'],
  ['admin', 'RTS-10045', 'ADMIN-PLAIN-EDIT'],
]
for (const [who, ID, marker] of cases) {
  const before = (await sqlJson(`select o.status::text, o.assigned_to::text,
      (select length(data::text) from fulfillments f where f.order_id=o.id) bytes,
      (select p.name from fulfillments f join profiles p on p.id=f.updated_by where f.order_id=o.id) author
    from orders o where o.id='${ID}'`))[0]
  console.log(`\n── ${who} → ${ID}  (desk: ${before.assigned_to}, status: ${before.status})`)
  console.log(`   fulfillment before: ${before.bytes ? before.bytes + ' bytes, last by ' + (before.author || 'nobody') : 'none yet'}`)

  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(1400)
  await page.goto(`http://127.0.0.1:5173/admin/orders/${ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)
  const open = page.getByRole('button', { name: /fulfillment form|Review commitment/i }).first()
  console.log(`   button on the order page: ${await open.count() ? JSON.stringify((await open.innerText()).trim()) : '*** none'}`)
  if (!(await open.count())) { await shot(page, `adminful-nobtn-${who}`); await ctx.close(); continue }
  await open.click()
  await page.waitForTimeout(3200)
  console.log(`   url: ${page.url().replace('http://127.0.0.1:5173','')}  chars: ${(await page.locator('body').innerText()).length}`)

  // Edit three separate sections, so this is not one lucky field.
  const legal   = page.locator('textarea[placeholder^="All that certain piece"]').first()
  const grantor = page.locator('textarea[placeholder="Grantor name(s)"]').first()
  const parcel  = page.locator('input[placeholder="e.g. 0123-45-67-890"]').first()
  const edits = []
  if (await legal.count())   { await legal.fill(`${marker} legal description.`); edits.push('legalDescription') }
  if (await grantor.count()) { await grantor.fill(`${marker}-GRANTOR`); edits.push('deeds[0].grantor') }
  if (await parcel.count())  { await parcel.fill(`${marker}-PARCEL`); edits.push('parcels[0]') }
  await page.waitForTimeout(4000)
  const t = await page.locator('body').innerText()
  console.log(`   fields edited: ${JSON.stringify(edits)}`)
  console.log(`   indicator: ${/Not saved/.test(t) ? '*** ' + (t.match(/Not saved[^\n]*/)||[])[0] : (/Saved/.test(t) ? 'Saved ✓' : '(none seen)')}`)

  const after = (await sqlJson(`select length(data::text) bytes,
      (data->>'legalDescription') legal, (data->'deeds'->0->>'grantor') grantor,
      (data->'parcels'->0->>'value') parcel,
      (select p.name from profiles p where p.id=f.updated_by) author
    from fulfillments f where order_id='${ID}'`))[0]
  console.log(`   row after: ${JSON.stringify(after)}`)
  console.log(`   all three landed? ${after && after.legal?.startsWith(marker) && after.grantor?.startsWith(marker) && after.parcel?.startsWith(marker) ? 'YES ✓' : '*** NO'}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0,2))
  await shot(page, `adminful-${who}-${ID}`)
  await ctx.close()
}
await b.close()
