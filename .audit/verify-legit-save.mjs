import { browser, login, sqlJson, shot } from './harness.mjs'
const ID = 'RTS-10048'
const b = await browser()

async function drive(who, path, value) {
  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(1200)
  await page.goto(`http://127.0.0.1:5173${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const legal = page.locator('textarea[placeholder^="All that certain piece"]').first()
  const found = await legal.count()
  let indicator = '(field not found)'
  if (found) {
    await legal.fill(value)
    await page.waitForTimeout(4000)
    const t = await page.locator('body').innerText()
    indicator = /Not saved/i.test(t) ? '*** Not saved' : (/Saved/i.test(t) ? 'Saved ✓' : '(no indicator)')
  }
  const row = (await sqlJson(`select (data->>'legalDescription') legal, length(data::text) len,
    (select name from profiles where id = f.updated_by) author
    from fulfillments f where order_id='${ID}'`))[0]
  console.log(`${who.padEnd(9)} ${path}`)
  console.log(`  body chars: ${(await page.locator('body').innerText()).length}  field: ${found ? 'yes' : 'NO'}  indicator: ${indicator}`)
  console.log(`  row now: legal=${JSON.stringify(row.legal)} len=${row.len} updated_by=${row.author}`)
  const pe = errors.filter(e => e.startsWith('PAGEERROR'))
  if (pe.length) console.log('  PAGE ERRORS:', pe.slice(0, 2))
  await shot(page, `legit-${who}`)
  await ctx.close()
}

console.log('order state:', JSON.stringify((await sqlJson(`select id,status,assigned_to from orders where id='${ID}'`))[0]))
await drive('user',   `/user/order/${ID}`, 'USER-UI-SAVE Lot 4, Block 2, RESTORED SUBDIVISION.')
await drive('rajni',  `/admin/order/${ID}`, 'ADMIN-UI-SAVE Lot 4, Block 2, RESTORED SUBDIVISION.')
await b.close()
