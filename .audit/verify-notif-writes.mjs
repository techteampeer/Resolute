import { browser, login, sqlJson, shot } from './harness.mjs'
const b = await browser()
const rows = (email) => sqlJson(`select np.type_key, np.mode from notification_preferences np join profiles p on p.id=np.profile_id where p.email='${email}' order by np.type_key`)

// ── the typer turns their one notification to digest, then off, then back to default
{
  const { page, ctx, errors } = await login(b, 'typer')
  await page.waitForTimeout(1400)
  await page.goto('http://127.0.0.1:5173/user/notifications', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)
  const card = page.locator('.glass-card').filter({ hasText: 'Work assigned to you' }).first()
  console.log('typer rows at open:', JSON.stringify(await rows('typer@resolute.com')))
  console.log('state at open:', JSON.stringify((await card.innerText()).split('\n').filter(Boolean).slice(0, 6)))

  for (const label of ['Daily digest', 'Off', 'Immediately']) {
    await card.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(2200)
    const t = await card.innerText()
    console.log(`click "${label}" -> db ${JSON.stringify(await rows('typer@resolute.com'))}  saved-pill=${/Saved/.test(t)}  default-pill=${/\bdefault\b/.test(t.split('\n')[1] || '')}`)
    if (/Not saved/.test(t)) console.log('   *** ', (t.match(/Not saved[^\n]*/) || [])[0])
  }
  await shot(page, 'notif-typer-set')

  // back to the default: the row must be deleted, not set to the default value
  await card.getByRole('button', { name: 'Default', exact: true }).click()
  await page.waitForTimeout(2200)
  console.log('click "Default" -> db', JSON.stringify(await rows('typer@resolute.com')))
  const t2 = await card.innerText()
  console.log('   card now:', JSON.stringify(t2.split('\n').filter(Boolean).slice(0, 5)))

  // reload: what the database holds must be what the screen shows
  await card.getByRole('button', { name: 'Off', exact: true }).click()
  await page.waitForTimeout(2200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2800)
  const t3 = await page.locator('.glass-card').filter({ hasText: 'Work assigned to you' }).first().innerText()
  console.log('after reload:', JSON.stringify(t3.split('\n').filter(Boolean).slice(0, 5)), '| db', JSON.stringify(await rows('typer@resolute.com')))
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('PAGE ERRORS:', pe.slice(0, 2))
  await ctx.close()
}

// ── an admin sets two of their six
{
  const { page, ctx, errors } = await login(b, 'rajni')
  await page.waitForTimeout(1400)
  await page.goto('http://127.0.0.1:5173/admin/notifications', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)
  for (const [kind, label] of [['Stage completed', 'Off'], ['Client message', 'Daily digest']]) {
    const c = page.locator('.glass-card').filter({ hasText: kind }).first()
    await c.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(2000)
  }
  console.log('\nrajni rows:', JSON.stringify(await rows('rajni@resolute.com')))
  const head = (await page.locator('body').innerText()).match(/\d+ immediately[\s\S]{0,40}?\d+ off/)
  console.log('summary line:', JSON.stringify((await page.locator('.glass-card').first().innerText()).replace(/\n+/g, ' | ')))
  await shot(page, 'notif-admin-set')
  const pe = errors.filter(e => e.startsWith('PAGEERROR')); if (pe.length) console.log('PAGE ERRORS:', pe.slice(0, 2))
  await ctx.close()
}
console.log('\nall preference rows:', JSON.stringify(await sqlJson("select p.email, np.type_key, np.mode from notification_preferences np join profiles p on p.id=np.profile_id order by p.email, np.type_key")))
await b.close()
