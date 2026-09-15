import { browser, login, sqlJson, shot, SAMPLE_PDF } from './harness.mjs'
import fs from 'node:fs'
const OUT = (process.env.AUDIT_OUT || new URL('./out', import.meta.url).pathname) + '/e2e'
fs.mkdirSync(OUT,{recursive:true})
const DOC = SAMPLE_PDF
const FILENO='E2E-FILE-4242'
let ID=null
const row = async () => (await sqlJson(`select id, status::text, assigned_to::text, progress, completed_dates, completed_by, completed, client_file_no from orders where id='${ID}'`))[0]
const step = async (label) => { const r = await row(); console.log(`\n[${label}]\n  status=${r.status} assigned_to=${r.assigned_to} progress=${r.progress} completed=${r.completed||'null'}\n  completed_dates=${JSON.stringify(r.completed_dates)}\n  completed_by=${JSON.stringify(r.completed_by)}`); return r }
const b = await browser()

// ── S1 client places the order ────────────────────────────────────────────
{
  const { page, ctx } = await login(b, 'client')
  await page.getByRole('button',{name:'Place Order',exact:true}).first().click(); await page.waitForTimeout(1800)
  await page.locator('select').first().selectOption({ label:'Ohio' }).catch(async()=>{ await page.locator('select').first().selectOption('Ohio') })
  await page.fill('input[placeholder="e.g. Miami-Dade"]', 'Franklin')
  await page.fill('input[placeholder="123 Main St, City, State 00000"]', '900 E2E Parkway')
  await page.fill('input[placeholder="ABC-2291"]', FILENO)
  await page.click('button:has-text("Continue")'); await page.waitForTimeout(700)
  await page.click('button:has-text("Continue")'); await page.waitForTimeout(700)
  await page.fill('input[placeholder="First name"]','Taylor'); await page.fill('input[placeholder="Last name"]','Brooks')
  await page.fill('input[placeholder="you@company.com"]','client@resolute.com')
  await page.click('button:has-text("Continue")'); await page.waitForTimeout(700)
  await page.click('button:has-text("Submit Order")'); await page.waitForTimeout(3500)
  ID = (await sqlJson(`select id from orders where client_file_no='${FILENO}' order by created_at desc limit 1`))[0]?.id
  console.log('placed order id =', ID)
  await shot(page,'e2e-01-placed'); await ctx.close()
}
if (!ID) { console.log('FAILED to place order'); process.exit(1) }
await step('S1 client placed')

const asAdminAssign = async (stageLabel, person, tag) => {
  const { page, ctx } = await login(b, 'admin')
  const gotoOrders = async () => {
    await page.getByRole('button',{name:/^Orders/}).first().click(); await page.waitForTimeout(1600)
    const s = page.locator('input[placeholder*="Search order"]').first()
    if (await s.count()) { await s.fill(ID); await page.waitForTimeout(900) }
  }
  await gotoOrders()

  if (tag === 'confirm') {                       // confirm lives on the DETAIL page
    const trc = page.locator('tr', { hasText: ID }).first()
    if (await trc.count()) await trc.click(); else await page.locator(`text=${ID}`).first().click()
    await page.waitForTimeout(1600)
    const conf = page.getByRole('button',{name:/Confirm & price order|Set price & date/}).first()
    if (await conf.count()) {
      console.log('  clicked:', (await conf.innerText()).trim())
      await conf.click(); await page.waitForTimeout(1200)
      const go = page.getByRole('button',{name:/^(Confirm order|Save price & date)$/}).first()
      if (await go.count()) { await go.click(); await page.waitForTimeout(2500); console.log('  priced & dated') }
      else console.log('  !! modal submit not found')
    } else console.log('  !! pricing button not found on detail')
    await gotoOrders()                           // back to the list for the assign action
  }

  // The assign action is a ROW action on the orders list — scope it to OUR row,
  // otherwise .first() grabs whichever order happens to sit at the top.
  const tr = page.locator('tr', { hasText: ID }).first()
  const rowBtn = (await tr.count())
    ? tr.getByRole('button',{name:/Assign|Approve & Assign|Reassign/}).first()
    : page.getByRole('button',{name:/Assign|Approve & Assign|Reassign/}).first()
  if (!(await rowBtn.count())) { console.log('  !! no assign row action found'); await shot(page,`e2e-fail-${tag}`); await ctx.close(); return null }
  console.log('  row action:', (await rowBtn.innerText()).trim())
  await rowBtn.click(); await page.waitForTimeout(1400)

  const modal = page.locator('div.fixed.inset-0.z-50').first()
  if (!(await modal.count())) { console.log('  !! assign modal did not open'); await shot(page,`e2e-fail-${tag}`); await ctx.close(); return null }
  const mtxt = await modal.innerText()
  if (!mtxt.includes(ID)) { console.log(`  !! modal is for the WRONG order (expected ${ID}):`, mtxt.split('\n')[0]); await ctx.close(); return null }
  for (const lbl of ['Screener','Examiner','Typer','Delivery']) {
    const bb = modal.getByRole('button',{ name: lbl, exact: true }).first()
    if (await bb.count()) console.log(`    gate "${lbl}" disabled=${await bb.isDisabled()}`)
  }
  const stageBtn = modal.getByRole('button',{ name: stageLabel, exact: true }).first()
  if (!(await stageBtn.count())) { console.log(`  !! stage "${stageLabel}" not in modal`); await shot(page,`e2e-fail-${tag}`); await ctx.close(); return null }
  const disabled = await stageBtn.isDisabled()
  console.log(`  assign modal: "${stageLabel}" disabled=${disabled}`)
  if (!disabled) {
    await stageBtn.click(); await page.waitForTimeout(400)
    if (person) await modal.locator('select').first().selectOption(person).catch(e=>console.log('  person select failed:', e.message.slice(0,60)))
    await modal.getByRole('button',{ name:/Confirm Assignment/ }).first().click(); await page.waitForTimeout(2400)
  }
  await shot(page, `e2e-admin-${tag}`)
  await ctx.close()
  return disabled
}

await asAdminAssign('Screener','Sam Carter','confirm');            await step('S2 admin → screener')

// ── S3 screener ───────────────────────────────────────────────────────────
{
  const { page, ctx } = await login(b, 'screener')
  await page.waitForTimeout(1400); await page.locator(`text=${ID}`).first().click(); await page.waitForTimeout(1800)
  const scr = page.locator('text="Screening"').last(); if (await scr.count()) { await scr.click(); await page.waitForTimeout(1000) }
  const abs = page.locator('text=/ABS \\(Abstract\\)/').first(); if (await abs.count()) { await abs.click(); await page.waitForTimeout(500) }
  const fi = page.locator('input[type=file]').first(); if (await fi.count()) { await fi.setInputFiles(DOC); await page.waitForTimeout(2500) }
  const send = page.locator('button:has-text("Confirm & Send to Admin")').first()
  if (await send.count()) { await send.click(); await page.waitForTimeout(2800) } else console.log('  !! screener submit button not found')
  await shot(page,'e2e-03-screener'); await ctx.close()
}
await step('S3 screener done (must park with admin)')
await asAdminAssign('Examiner','Jordan Lee','to-examiner');       await step('S4 admin → examiner')

// ── S5 examiner ───────────────────────────────────────────────────────────
{
  const { page, ctx } = await login(b, 'examiner')
  await page.waitForTimeout(1400); await page.locator(`text=${ID}`).first().click(); await page.waitForTimeout(1800)
  const ex = page.locator('text="Examination"').last(); if (await ex.count()) { await ex.click(); await page.waitForTimeout(1000) }
  const boxes = page.locator('input[type=checkbox]'); const n = await boxes.count()
  for (let i=0;i<n;i++) { await boxes.nth(i).check().catch(()=>{}) }
  console.log(`  ticked ${n} checklist boxes`)
  const fi = page.locator('input[type=file]').first(); if (await fi.count()) { await fi.setInputFiles(DOC); await page.waitForTimeout(2500) }
  const send = page.locator('button:has-text("Confirm & Send to Admin")').first()
  if (await send.count()) { await send.click(); await page.waitForTimeout(2800) } else console.log('  !! examiner submit not found')
  await shot(page,'e2e-05-examiner'); await ctx.close()
}
await step('S5 examiner done (must park with admin)')

await asAdminAssign('Typer','Priya Nair','to-typer')
await step('S6 admin → typer')

// ── S7 typer fills the commitment and submits ─────────────────────────────
{
  const { page, ctx, errors } = await login(b, 'typer')
  await page.waitForTimeout(1400); await page.locator(`text=${ID}`).first().click(); await page.waitForTimeout(2000)
  await page.locator('text="Fulfillment"').first().click(); await page.waitForTimeout(1800)
  console.log('  page errors on fulfillment:', errors.filter(e=>!e.includes('ERR_FAILED')))
  const before = await page.locator('body').innerText()
  console.log('  completeness before:', (before.match(/(\d) of 8/)||[])[0])
  await page.fill('input[placeholder="e.g. 0123-45-67-890"]','PARCEL-E2E-777')
  const addEff = page.locator('button:has-text("Add Effective Date")').first()
  if (await addEff.count()) { await addEff.click(); await page.waitForTimeout(700)
    const dt = page.locator('input[type="datetime-local"]').first()
    if (await dt.count()) await dt.fill('2026-09-02T14:30') }
  await page.fill('textarea[placeholder="Grantor name(s)"]','GRANTOR-E2E Alice Smith')
  await page.fill('textarea[placeholder^="Grantee name(s)"]','GRANTEE-E2E Bob Jones')
  await page.fill('textarea[placeholder^="All that certain piece"]','LEGAL-E2E Lot 7, Block 3, AUDIT SUBDIVISION, plat book 99 page 12.')
  const files = page.locator('input[type=file]')
  if (await files.count()) { await files.first().setInputFiles(DOC); await page.waitForTimeout(3000) }
  await page.waitForTimeout(1500)
  const after = await page.locator('body').innerText()
  console.log('  completeness after :', (after.match(/(\d) of 8/)||[])[0])
  const missing = after.split('\n').find(l=>l.includes('Complete') && l.includes('more section'))
  if (missing) console.log('  still missing:', missing.slice(0,160))
  const sub = page.locator('button:has-text("Submit for Admin Approval")').first()
  const dis = await sub.isDisabled().catch(()=>true)
  console.log('  Submit disabled =', dis)
  if (!dis) { await sub.click(); await page.waitForTimeout(6000) }
  await shot(page,'e2e-07-typer'); await ctx.close()
}
await step('S7 typer done (must park with admin)')
await asAdminAssign('Delivery','Morgan Davis','to-delivery');     await step('S8 admin → delivery')

// ── S9 delivery ───────────────────────────────────────────────────────────
{
  const { page, ctx } = await login(b, 'delivery')
  await page.waitForTimeout(1400); await page.locator(`text=${ID}`).first().click(); await page.waitForTimeout(1800)
  const em = page.locator('input[placeholder="client@company.com"]').first()
  if (await em.count()) await em.fill('dana@lakewoodtitle.com')
  const note = page.locator('textarea[placeholder="Notes for the client…"]').first()
  if (await note.count()) await note.fill('E2E delivery note')
  // NB: must be the action button, not the "Delivered" nav tab.
  const d = page.getByRole('button',{name:/Deliver & Submit to Admin/}).first()
  if (await d.count()) { await d.click(); await page.waitForTimeout(4000) } else console.log('  !! deliver button not found')
  await shot(page,'e2e-09-delivery'); await ctx.close()
}
const fin = await step('S9 DELIVERED?')
console.log('\n================ RESULT ================')
console.log(`order ${ID}: status=${fin.status} assigned_to=${fin.assigned_to} progress=${fin.progress} completed=${fin.completed||'null'}`)
console.log('client_file_no survived:', fin.client_file_no)
console.log('order_events:'); console.log((await sqlJson(`select id, type, audience, action from order_events where order_id='${ID}' order by id`)).map(e=>`  ${e.id} ${e.type}/${e.audience} ${e.action}`).join('\n'))
console.log('fulfillment saved:', JSON.stringify(await sqlJson(`select order_id, length(data::text) bytes, (data->>'legalDescription') legal, (data->'parcels'->0->>'value') parcel, (select name from profiles where id=updated_by) author from fulfillments where order_id='${ID}'`)))
console.log('workflow money/doc:', JSON.stringify(await sqlJson(`select workflow->>'invoiceAmount' invoice_amount, workflow->>'invoicedAt' invoiced_at, workflow->'commitmentDoc'->>'name' commitment_doc, workflow->>'searchAssignment' route, eta from orders where id='${ID}'`)))
console.log('charges the typer entered:', JSON.stringify(await sqlJson(`select jsonb_pretty(data->'invoice') inv from fulfillments where order_id='${ID}'`))[0] ? (await sqlJson(`select data->'invoice' inv from fulfillments where order_id='${ID}'`))[0].inv : null)
console.log('vendor payout owed (ABS route):', JSON.stringify(await sqlJson(`select order_id, vendor_code, amount, status from vendor_payouts where order_id='${ID}'`)))
console.log('notifications raised:'); console.log((await sqlJson(`select type_key, recipient_email, recipient_role, mode, status from notification_outbox where order_id='${ID}' order by id`)).map(r=>`  ${r.type_key.padEnd(24)} -> ${r.recipient_email} (${r.recipient_role}, ${r.mode}, ${r.status})`).join('\n'))
console.log('client-visible messages:'); console.log((await sqlJson(`select sender, author, visibility, body from support_messages where order_id='${ID}' order by created_at`)).map(m=>`  [${m.sender}/${m.visibility}] ${m.author||''} — ${String(m.body).slice(0,130)}`).join('\n') || '  (none)')
await b.close()
