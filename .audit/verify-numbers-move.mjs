import { browser, login, sqlJson, sql, shot } from './harness.mjs'
const b = await browser()
const read = async (who, label) => {
  const { page, ctx } = await login(b, who)
  await page.waitForTimeout(2600)
  const cards = page.locator('.stat-card')
  const out = {}
  for (let i = 0; i < await cards.count(); i++) {
    const l = (await cards.nth(i).innerText()).split('\n').map(x => x.trim()).filter(Boolean)
    out[l[1]] = l[0]
  }
  const nav = await page.locator('aside button, nav button').filter({ hasText: label }).first().innerText().catch(() => '')
  const m = nav.split('\n').map(x => x.trim()).filter(Boolean)
  await ctx.close()
  return { tiles: out, badge: m.length > 1 ? m[1] : '(none)' }
}

console.log('typer, before:', JSON.stringify(await read('typer', 'To Type')))

// Move two real orders onto the typer's desk, one of them rush.
// Capture what these rows actually were, so the restore puts them back rather
// than assuming a default. Restoring to a guessed value silently rewrote a
// seeded rush order to normal once already.
const before = await sqlJson("select id, assigned_to::text, status::text, priority from orders where assigned_to='examiner' order by id limit 2")
const ids = before.map(r => r.id)
console.log('moving to the typer desk:', JSON.stringify(before))
sql(`update orders set assigned_to='typer', status='typing' where id in ('${ids[0]}','${ids[1]}')`)
sql(`update orders set priority='rush' where id='${ids[0]}'`)
console.log('typer, after: ', JSON.stringify(await read('typer', 'To Type')))

// And a completion today: stamp one order's typer date as today.
const doneRow = (await sqlJson("select id, completed_dates->>'typer' was from orders where completed_dates ? 'typer' order by id limit 1"))[0]
const done = doneRow.id, doneWas = doneRow.was
sql(`update orders set completed_dates = jsonb_set(completed_dates,'{typer}', to_jsonb(to_char(current_date,'YYYY-MM-DD'))) where id='${done}'`)
console.log(`stamped ${done} typer completion as today`)
console.log('typer, after: ', JSON.stringify(await read('typer', 'To Type')))

// Restore exactly what was there, including the date this row actually held.
for (const r of before) {
  sql(`update orders set assigned_to='${r.assigned_to}', status='${r.status}', priority='${r.priority}' where id='${r.id}'`)
}
sql(`update orders set completed_dates = jsonb_set(completed_dates,'{typer}', to_jsonb('${doneWas}'::text)) where id='${done}'`)
console.log('typer, restored:', JSON.stringify(await read('typer', 'To Type')))

// The greeting must be the signed-in person, not a fixture name.
const wasName = (await sqlJson("select name from profiles where email='client@resolute.com'"))[0].name
sql(`update profiles set name='Dana Whitfield-Test' where email='client@resolute.com'`)
{
  const { page, ctx } = await login(b, 'client')
  await page.waitForTimeout(2600)
  const g = (await page.locator('body').innerText()).match(/Welcome back[^\n]*/)?.[0]
  console.log(`\ngreeting with profiles.name renamed: ${JSON.stringify(g)}  ${/Dana Whitfield-Test/.test(g||'') ? '✓ from the session' : '*** still hardcoded'}`)
  await shot(page, 'greeting-renamed')
  await ctx.close()
}
sql(`update profiles set name='${wasName}' where email='client@resolute.com'`)
console.log('profile name restored to:', (await sqlJson("select name from profiles where email='client@resolute.com'"))[0].name)
await b.close()
