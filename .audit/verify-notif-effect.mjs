import { browser, login, sqlJson, sql, shot } from './harness.mjs'
const b = await browser()
console.log('preferences in force:', JSON.stringify(await sqlJson(
  "select p.email, np.type_key, np.mode from notification_preferences np join profiles p on p.id=np.profile_id order by p.email, np.type_key")))

// Catch the "Saved" pill while it is still on screen.
{
  const { page, ctx } = await login(b, 'delivery')
  await page.waitForTimeout(1400)
  await page.goto('http://127.0.0.1:5173/delivery/notifications', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)
  const card = page.locator('.glass-card').filter({ hasText: 'Work assigned to you' }).first()
  await card.getByRole('button', { name: 'Daily digest', exact: true }).click()
  await page.waitForTimeout(700)
  console.log('\nSaved pill visible right after the click:', /Saved/.test(await card.innerText()) ? 'YES ✓' : '*** NO')
  await shot(page, 'notif-saved-pill')
  await ctx.close()
}

// Now the point of the screen: does a preference change what gets queued?
// typer  order.assigned = off    -> must raise NOTHING for the typer
// delivery order.assigned = digest -> must be queued with mode 'digest'
// rajni  order.progress  = off    -> must be skipped for rajni only
const ID = (await sqlJson("select id from orders where status='received' limit 1"))[0]?.id
  || (await sqlJson("select id from orders order by id desc limit 1"))[0]?.id
console.log('\nusing order', ID)
const before = (await sqlJson("select max(id) m from notification_outbox"))[0].m || 0

// Raise one assignment per desk, and one stage-completion, straight through the
// same trigger the app uses.
for (const role of ['screener', 'typer', 'delivery']) {
  sql(`insert into order_events (order_id, action, type, actor, actor_email, audience)
       values ('${ID}', 'Admin assigned ${ID} to ${role} · Pref Test', 'status', 'Pref Test', null, 'staff')`)
}
sql(`insert into order_events (order_id, action, type, actor, actor_email, audience)
     values ('${ID}', 'Pref Test completed screening on ${ID} → handed on', 'progress', 'Pref Test', null, 'staff')`)

const raised = await sqlJson(`select type_key, recipient_email, recipient_role, mode from notification_outbox where id > ${before} order by id`)
console.log('\nqueued by those four events:')
for (const r of raised) console.log(`  ${r.type_key.padEnd(16)} -> ${r.recipient_email.padEnd(24)} mode=${r.mode}`)
const has = (t, e) => raised.some(r => r.type_key === t && r.recipient_email === e)
const modeOf = (t, e) => raised.find(r => r.type_key === t && r.recipient_email === e)?.mode
console.log('\nchecks:')
console.log('  typer set OFF      -> order.assigned for typer@   :', has('order.assigned','typer@resolute.com') ? '*** STILL QUEUED' : 'not queued ✓')
console.log('  screener untouched -> order.assigned for screener@:', has('order.assigned','screener@resolute.com') ? 'queued ✓' : '*** MISSING')
console.log('  delivery = digest  -> order.assigned for delivery@:', modeOf('order.assigned','delivery@resolute.com') === 'digest' ? 'queued as digest ✓' : `*** ${modeOf('order.assigned','delivery@resolute.com') || 'missing'}`)
console.log('  rajni set OFF      -> order.progress for rajni@   :', has('order.progress','rajni@resolute.com') ? '*** STILL QUEUED' : 'not queued ✓')
console.log('  other admins       -> order.progress for admin@   :', modeOf('order.progress','admin@resolute.com') ? `queued as ${modeOf('order.progress','admin@resolute.com')} ✓` : '*** MISSING')
await b.close()
