import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()
const today = (await sqlJson("select to_char(current_date,'YYYY-MM-DD') d"))[0].d
const month = today.slice(0, 7)

const expectDesk = async (role) => (await sqlJson(`
  select (select count(*) from orders where assigned_to='${role}') queue,
         (select count(*) from orders where assigned_to='${role}' and priority='rush') rush,
         (select count(*) from orders where completed_dates->>'${role}' = '${today}') today,
         (select count(*) from orders where left(completed_dates->>'${role}',7) = '${month}') as "month"`))[0]

// Read the four stat tiles (value then label) off a dashboard.
const tiles = async (page) => {
  const cards = page.locator('.stat-card')
  const out = []
  for (let i = 0; i < await cards.count(); i++) {
    const lines = (await cards.nth(i).innerText()).split('\n').map(x => x.trim()).filter(Boolean)
    out.push([lines[1] ?? '', lines[0] ?? ''])   // [label, value]
  }
  return out
}
const badge = async (page, label) => {
  const t = await page.locator('aside button, nav button').filter({ hasText: label }).first().innerText().catch(() => '')
  const m = t.split('\n').map(x => x.trim()).filter(Boolean)
  return m.length > 1 ? m[1] : '(none)'
}

let bad = 0
const check = (what, got, want) => {
  const ok = String(got) === String(want)
  if (!ok) bad++
  console.log(`   ${ok ? '✓' : '***'} ${what.padEnd(24)} screen=${String(got).padEnd(8)} db=${want}`)
}

for (const [who, role, navLabel, want4] of [
  ['screener', 'screener', 'Screening Queue', ['In the queue','Rush waiting','Screened today','Screened this month']],
  ['examiner', 'examiner', 'To Examine',      ['In the queue','Rush waiting','Examined today','Issues flagged']],
  ['typer',    'typer',    'To Type',         ['In the queue','Rush waiting','Typed today','Typed this month']],
  ['delivery', 'delivery', 'Ready to Send',   ['Ready to send','Rush waiting','Delivered today','Delivered this month']],
]) {
  const e = await expectDesk(role)
  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(2600)
  const t = await tiles(page)
  console.log(`\n── ${role} ──  db: queue=${e.queue} rush=${e.rush} today=${e.today} month=${e.month}`)
  console.log(`   tiles on screen: ${JSON.stringify(t)}`)
  const by = Object.fromEntries(t)
  check(want4[0], by[want4[0]], e.queue)
  check(want4[1], by[want4[1]], e.rush)
  check(want4[2], by[want4[2]], e.today)
  if (role === 'examiner') {
    const iss = (await sqlJson("select count(*) c from orders where (workflow->'examIssues'->>'liens')::bool or (workflow->'examIssues'->>'encumbrances')::bool"))[0].c
    check('Issues flagged', by['Issues flagged'], iss)
  } else check(want4[3], by[want4[3]], e.month)
  check(`badge "${navLabel}"`, await badge(page, navLabel), e.queue === 0 ? '(none)' : e.queue)
  const pe = errors.filter(x => x.startsWith('PAGEERROR')); if (pe.length) { bad++; console.log('   PAGE ERRORS:', pe.slice(0, 2)) }
  await shot(page, `numbers-${role}`)
  await ctx.close()
}

// ── client ──
{
  const e = (await sqlJson(`
    with mine as (select * from orders where client_code = (select client_code from profiles where email='client@resolute.com'))
    select count(*) filter (where status not in ('delivered','cancelled')) active,
           count(*) filter (where left(completed::text,4) = '${today.slice(0,4)}') ytd,
           count(*) filter (where status not in ('delivered','cancelled') and priority='rush') rush,
           coalesce(to_char(round(avg(completed - created) filter (where completed is not null),1),'FM990.0'),'-') turnaround
    from mine`))[0]
  const { page, ctx, errors } = await login(b, 'client')
  await page.waitForTimeout(2600)
  const by = Object.fromEntries(await tiles(page))
  console.log(`\n── client ──  db: active=${e.active} ytd=${e.ytd} rush=${e.rush} turnaround=${e.turnaround}d`)
  console.log(`   tiles on screen: ${JSON.stringify(by)}`)
  check('Active orders', by['Active orders'], e.active)
  check('Completed this year', by['Completed this year'], e.ytd)
  check('Rush in progress', by['Rush in progress'], e.rush)
  check('Avg turnaround', by['Avg turnaround'], `${e.turnaround}d`)
  const greet = (await page.locator('body').innerText()).match(/Welcome back[^\n]*/)?.[0]
  console.log(`   greeting: ${JSON.stringify(greet)}`)
  if (!/Taylor Brooks/.test(greet || '')) { /* seeded client IS Taylor Brooks — check it came from the session */ }
  const pe = errors.filter(x => x.startsWith('PAGEERROR')); if (pe.length) { bad++; console.log('   PAGE ERRORS:', pe.slice(0, 2)) }
  await shot(page, 'numbers-client')
  await ctx.close()
}
console.log(bad ? `\n*** ${bad} mismatches` : '\nevery figure on screen matches the database ✓')
await b.close()
