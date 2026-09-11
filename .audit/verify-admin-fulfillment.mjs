import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()

// Three cases:
//  A. an order on the TYPER's desk, opened by Admin        -> must be editable
//  B. an order on the EXAMINER's desk with no fulfillment  -> must seed + edit
//  C. a non-super-admin (admin@) rather than a super admin -> same access
const cases = [
  ['rajni', 'RTS-10048', 'ADMIN-SUPER-EDIT'],
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
  // Reach it the way Admin does: Orders → the row → "Open fulfillment form"
  await page.getByRole('button', { name: /^Orders/ }).first().click()
  await page.waitForTimeout(1800)
  const s = page.locator('input[placeholder*="Search order"]').first()
  if (await s.count()) { await s.fill(ID); await page.waitForTimeout(1000) }
  const tr = page.locator('tr', { hasText: ID }).first()
  if (await tr.count()) await tr.click(); else await page.locator(`text=${ID}`).first().click()
  await page.waitForTimeout(1800)
  const openBtn = page.getByRole('button', { name: /fulfillment form|Review commitment/i }).first()
  console.log(`   button on the detail page: ${await openBtn.count() ? JSON.stringify((await openBtn.innerText()).trim()) : '*** none'}`)
  if (!(await openBtn.count())) { await shot(page, `adminful-nobtn-${who}`); await ctx.close(); continue }
  await openBtn.click()
  await page.waitForTimeout(3000)
  console.log(`   url: ${page.url().replace('http://127.0.0.1:5173','')}  chars: ${(await page.locator('body').innerText()).length}`)

  // Edit three different sections, so this is not one lucky field.
  const legal = page.locator('textarea[placeholder^="All that certain piece"]').first()
  const grantor = page.locator('textarea[placeholder="Grantor name(s)"]').first()
  const parcel = page.locator('input[placeholder="e.g. 0123-45-67-890"]').first()
  const edits = []
  if (await legal.count())   { await legal.fill(`${marker} legal description.`); edits.push('legalDescription') }
  if (await grantor.count()) { await grantor.fill(`${marker}-GRANTOR`); edits.push('deeds[0].grantor') }
  if (await parcel.count())  { await parcel.fill(`${marker}-PARCEL`); edits.push('parcels[0]') }
  await page.waitForTimeout(4000)
  const t = await page.locator('body').innerText()
  console.log(`   fields edited: ${JSON.stringify(edits)}`)
  console.log(`   indicator: ${/Not saved/.test(t) ? '*** ' + (t.match(/Not saved[^\n]*/)||[])[0] : (/Saved/.test(t) ? 'Saved ✓' : '(none seen)')}`)

  const after = (await sqlJson(`select length(data::text) bytes,
      (data->>'legalDescription') legal,
      (data->'deeds'->0->>'grantor') grantor,
      (data->'parcels'->0->>'value') parcel,
      (select p.name from profiles p where p.id=f.updated_by) author
    from fulfillments f where order_id='${ID}'`))[0]
  console.log(`   row after: ${JSON.stringify(after)}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0,2))
  await shot(page, `adminful-${who}-${ID}`)
  await ctx.close()
}
await b.close()
