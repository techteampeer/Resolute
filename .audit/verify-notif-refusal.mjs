import { browser, login, sql, sqlJson, shot } from './harness.mjs'
// The UI's refusal path cannot be reached from a real session — a user may
// always write their own row. Add a RESTRICTIVE policy that blocks exactly one
// account, drive the click, then remove it and prove the policy set is back to
// what the migrations define.
const before = sqlJson("select polname from pg_policy where polrelid='public.notification_preferences'::regclass order by polname")
console.log('policies before:', JSON.stringify(before.map(r => r.polname)))
sql(`create policy notif_pref_audit_block on public.notification_preferences
     as restrictive for all
     using (profile_id <> (select id from profiles where email='typer@resolute.com'))
     with check (profile_id <> (select id from profiles where email='typer@resolute.com'))`)
const b = await browser()
try {
  const { page, ctx, errors } = await login(b, 'typer')
  await page.waitForTimeout(1400)
  await page.goto('http://127.0.0.1:5173/user/notifications', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)
  const card = page.locator('.glass-card').filter({ hasText: 'Work assigned to you' }).first()
  const was = (await card.innerText()).match(/(Your choice|Following Resolute's default)[^\n]*/)?.[0]
  console.log('before the click:', JSON.stringify(was))
  console.log('db before:', JSON.stringify(await sqlJson("select np.mode from notification_preferences np join profiles p on p.id=np.profile_id where p.email='typer@resolute.com'")))
  await card.getByRole('button', { name: 'Off', exact: true }).click()
  await page.waitForTimeout(3000)
  const t = await card.innerText()
  console.log('banner shown:', /Not saved/.test(t) ? 'YES ✓' : '*** NO')
  console.log('  ->', JSON.stringify((t.match(/Not saved[^\n]*/) || [])[0]))
  console.log('choice reverted on screen:', JSON.stringify(t.match(/(Your choice|Following Resolute's default)[^\n]*/)?.[0]))
  console.log('db unchanged:', JSON.stringify(await sqlJson("select np.mode from notification_preferences np join profiles p on p.id=np.profile_id where p.email='typer@resolute.com'")))
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('PAGE ERRORS:', pe.slice(0, 2))
  await shot(page, 'notif-refused')
  await ctx.close()
} finally {
  sql('drop policy if exists notif_pref_audit_block on public.notification_preferences')
  const after = sqlJson("select polname from pg_policy where polrelid='public.notification_preferences'::regclass order by polname")
  console.log('policies after cleanup:', JSON.stringify(after.map(r => r.polname)))
  console.log('policy set restored:', JSON.stringify(after) === JSON.stringify(before) ? 'yes ✓' : '*** NO')
  await b.close()
}
