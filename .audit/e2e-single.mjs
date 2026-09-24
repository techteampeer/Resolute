import { browser, login, sqlJson, shot, SAMPLE_PDF } from './harness.mjs'
import fs from 'node:fs'
const OUT = (process.env.AUDIT_OUT || new URL('./out', import.meta.url).pathname) + '/e2e-single'
fs.mkdirSync(OUT,{recursive:true})
const DOC = SAMPLE_PDF
if (!fs.existsSync(DOC)) fs.writeFileSync(DOC,'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const FILENO='SS-FILE-9001'
let ID=null
const row = async () => (await sqlJson(`select id,status::text,assigned_to::text,progress,completed,completed_dates,completed_by,(workflow->>'singleSeating') ss from orders where id='${ID}'`))[0]
const step = async (l) => { const r=await row(); console.log(`[${l}]\n   status=${r.status} assigned_to=${r.assigned_to} progress=${r.progress} singleSeating=${r.ss} completed=${r.completed||'null'}\n   dates=${JSON.stringify(r.completed_dates)} by=${JSON.stringify(r.completed_by)}`); return r }
const b = await browser()

// 1 — client places
{
  const { page, ctx } = await login(b,'client')
  await page.getByRole('button',{name:'Place Order',exact:true}).first().click(); await page.waitForTimeout(1800)
  await page.locator('select').first().selectOption('Ohio').catch(()=>{})
  await page.fill('input[placeholder="e.g. Miami-Dade"]','Franklin')
  await page.fill('input[placeholder="ABC-2291"]',FILENO)
  await page.click('button:has-text("Continue")'); await page.waitForTimeout(700)
  await page.click('button:has-text("Continue")'); await page.waitForTimeout(700)
  await page.fill('input[placeholder="First name"]','Taylor'); await page.fill('input[placeholder="Last name"]','Brooks')
  await page.fill('input[placeholder="you@company.com"]','client@resolute.com')
  await page.click('button:has-text("Continue")'); await page.waitForTimeout(700)
  await page.click('button:has-text("Submit Order")'); await page.waitForTimeout(3500)
  ID=(await sqlJson(`select id from orders where client_file_no='${FILENO}' order by created_at desc limit 1`))[0]?.id
  console.log('placed', ID); await ctx.close()
}
if(!ID){ console.log('FAILED to place'); process.exit(1) }
await step('placed')

// admin routes it to the Single Seating desk (and re-approves after each phase)
const adminToOperator = async (tag, confirmFirst=false) => {
  const { page, ctx } = await login(b,'admin')
  await page.getByRole('button',{name:/^Orders/}).first().click(); await page.waitForTimeout(1600)
  const s=page.locator('input[placeholder*="Search order"]').first(); if(await s.count()){ await s.fill(ID); await page.waitForTimeout(900) }
  if (confirmFirst) {
    const tr=page.locator('tr',{hasText:ID}).first(); if(await tr.count()) await tr.click(); await page.waitForTimeout(1600)
    const c=page.getByRole('button',{name:/Confirm order/}).first(); if(await c.count()){ await c.click(); await page.waitForTimeout(1600) }
    await page.getByRole('button',{name:/^Orders/}).first().click(); await page.waitForTimeout(1600)
    if(await s.count()){ await s.fill(ID); await page.waitForTimeout(900) }
  }
  const tr=page.locator('tr',{hasText:ID}).first()
  const btn=(await tr.count()) ? tr.getByRole('button',{name:/Assign|Approve & Assign|Reassign/}).first()
                               : page.getByRole('button',{name:/Assign|Approve & Assign|Reassign/}).first()
  if(!(await btn.count())){ console.log('  !! no assign action'); await ctx.close(); return }
  console.log('  row action:', (await btn.innerText()).trim())
  await btn.click(); await page.waitForTimeout(1300)
  const modal=page.locator('div.fixed.inset-0.z-50').first()
  if(!(await modal.innerText()).includes(ID)){ console.log('  !! wrong order in modal'); await ctx.close(); return }
  await modal.getByRole('button',{name:/Production Desk/}).first().click(); await page.waitForTimeout(400)
  await modal.getByRole('button',{name:/Confirm Assignment/}).first().click(); await page.waitForTimeout(2200)
  await shot(page,`ss-admin-${tag}`); await ctx.close()
}
await adminToOperator('route-to-desk', true); await step('admin → Production Desk')

// operator works each phase; admin approves between
const PHASES=['Screen & assign','Examine & upload','Type commitment','Deliver to client']
for (let i=0;i<PHASES.length;i++){
  const { page, ctx, errors } = await login(b,'operator')
  await page.waitForTimeout(1600)
  const dash=await page.locator('body').innerText()
  if(i===0) console.log('  operator dashboard shows the order:', dash.includes(ID))
  const link=page.locator(`text=${ID}`).first()
  if(!(await link.count())){ console.log(`  !! ${ID} not on operator dashboard at phase ${i+1}`); await shot(page,`ss-p${i+1}-missing`); await ctx.close(); break }
  await link.click(); await page.waitForTimeout(2000)
  const txt=await page.locator('body').innerText()
  console.log(`\n--- operator phase ${i+1} (${PHASES[i]}) --- url=${page.url()}`)
  console.log('   phase pill/verb present:', PHASES[i], '->', txt.includes(PHASES[i]))
  if(i===0){ const abs=page.locator('button:has-text("ABS (Abstract)")').first(); if(await abs.count()){ await abs.click(); await page.waitForTimeout(400) } }
  if(i===1){ const fi=page.locator('input[type=file]').first(); if(await fi.count()){ await fi.setInputFiles(DOC); await page.waitForTimeout(3000) } }
  if(i===2){
    const open=page.getByRole('button',{name:/Open Fulfillment Form/}).first()
    if(await open.count()){ await open.click(); await page.waitForTimeout(2500) }
    console.log('   fulfillment url:', page.url(), '| page errors:', errors.filter(e=>!e.includes('ERR_FAILED')))
    const ff=page.locator('text="Fulfillment"').first(); if(await ff.count()){ await ff.click(); await page.waitForTimeout(1500) }
    const t0=await page.locator('body').innerText(); console.log('   completeness before:', (t0.match(/(\d) of 8/)||[])[0])
    await page.fill('input[placeholder="e.g. 0123-45-67-890"]','PARCEL-SS-001').catch(()=>{})
    const ae=page.locator('button:has-text("Add Effective Date")').first()
    if(await ae.count()){ await ae.click(); await page.waitForTimeout(600); const dt=page.locator('input[type="datetime-local"]').first(); if(await dt.count()) await dt.fill('2026-09-04T10:00') }
    await page.fill('textarea[placeholder="Grantor name(s)"]','GRANTOR-SS Alice').catch(()=>{})
    await page.fill('textarea[placeholder^="Grantee name(s)"]','GRANTEE-SS Bob').catch(()=>{})
    await page.fill('textarea[placeholder^="All that certain piece"]','LEGAL-SS Lot 9, Block 1, SINGLE SEATING SUB.').catch(()=>{})
    const fi=page.locator('input[type=file]').first(); if(await fi.count()){ await fi.setInputFiles(DOC); await page.waitForTimeout(3000) }
    await page.waitForTimeout(1200)
    const t1=await page.locator('body').innerText(); console.log('   completeness after :', (t1.match(/(\d) of 8/)||[])[0])
    const sub=page.getByRole('button',{name:/Submit for Admin Approval/}).first()
    console.log('   submit disabled:', await sub.isDisabled().catch(()=>'n/a'))
    if(!(await sub.isDisabled().catch(()=>true))){ await sub.click(); await page.waitForTimeout(6000) }
  } else {
    const sub=page.getByRole('button',{name:new RegExp(PHASES[i].replace(/[&]/g,'\\&')+' & (Send to Admin|Complete)')}).first()
    if(await sub.count()){ console.log('   submit:', (await sub.innerText()).trim(), 'disabled=', await sub.isDisabled())
      if(!(await sub.isDisabled())){ await sub.click(); await page.waitForTimeout(3000) } }
    else console.log('   !! submit button not found')
  }
  await shot(page,`ss-phase${i+1}`); await ctx.close()
  await step(`after operator phase ${i+1} (${PHASES[i]})`)
  if(i<PHASES.length-1){ await adminToOperator(`approve-${i+1}`); await step(`admin approved → back to desk (phase ${i+2})`) }
}
const fin=await row()
console.log('\n================ SINGLE SEATING RESULT ================')
console.log(`order ${ID}: status=${fin.status} assigned_to=${fin.assigned_to} progress=${fin.progress} completed=${fin.completed||'null'}`)
console.log('completed_dates:', JSON.stringify(fin.completed_dates))
console.log('completed_by   :', JSON.stringify(fin.completed_by))
console.log('events:'); console.log((await sqlJson(`select id,type,audience,action from order_events where order_id='${ID}' order by id`)).map(e=>`  ${e.id} ${e.type}/${e.audience} ${e.action}`).join('\n'))
await b.close()
