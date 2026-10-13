import { browser, login, sqlJson, sql, shot } from './harness.mjs'
const b = await browser()
const rows = () => sqlJson("select p.email, np.type_key, np.mode from notification_preferences np join profiles p on p.id=np.profile_id order by p.email, np.type_key")
console.log('preference rows before:', JSON.stringify(await rows()))

for (const [who, role] of [['rajni','admin'],['screener','screener'],['examiner','examiner'],['typer','typer'],['delivery','delivery'],['operator','user'],['client','client']]) {
  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(1400)
  await page.goto(`http://127.0.0.1:5173/${role}/notifications`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)
  const t = await page.locator('body').innerText()
  const nav = (await page.locator('aside button, nav button').allInnerTexts()).map(x => x.split('\n')[0].trim())
  const kinds = [...t.matchAll(/^(New order placed|Work assigned to you|Stage completed|Awaiting Admin approval|Order delivered|Cancellation requested|Client message)$/gm)].map(m => m[1])
  const head = (t.match(/\d+ kinds? of update reach the \w+ desk/) || ['(none)'])[0]
  console.log(`\n${role.padEnd(9)} nav has Notifications: ${nav.includes('Notifications') ? 'yes' : 'NO'}  | ${head}`)
  console.log(`   types listed: ${JSON.stringify(kinds)}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR'))
  if (pe.length) console.log('   PAGE ERRORS:', pe.slice(0, 2))
  if (role === 'client') console.log('   client message:', JSON.stringify((t.match(/Notifications are for Resolute staff[^\n]*/) || ['(none)'])[0]))
  await shot(page, `notif-${role}`)
  await ctx.close()
}
await b.close()
