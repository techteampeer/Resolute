import { browser, login, sqlJson, sql, shot } from './harness.mjs'
const b = await browser()
// An order on the TYPER desk, opened by the OPERATOR: RLS allows the read but
// refuses the write (orders_update_assigned requires assigned_to = my_role()).
const foreign = (await sqlJson("select id from orders where assigned_to='typer' limit 1"))[0]?.id
console.log('order on the typer desk:', foreign)
const before = (await sqlJson(`select progress, (select length(data::text) from fulfillments where order_id='${foreign}') fb from orders where id='${foreign}'`))[0]
console.log('before:', JSON.stringify(before))

const { page, ctx, errors } = await login(b,'operator')
await page.waitForTimeout(1500)
// deep-link straight to the fulfillment form for a foreign order (works now that
// the session survives a direct navigation)
await page.goto(`http://127.0.0.1:5173/user/order/${foreign}`, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(3000)
console.log('url:', page.url(), '| body chars:', (await page.locator('body').innerText()).length)
// type into the form -> autosave fires -> RLS refuses it
const legal = page.locator('textarea[placeholder^="All that certain piece"]').first()
if (await legal.count()) {
  await legal.fill('OPERATOR-SHOULD-NOT-PERSIST')
  await page.waitForTimeout(4000)
  const t = await page.locator('body').innerText()
  const bad = /Not saved/i.test(t)
  console.log('indicator shows "Not saved":', bad ? 'YES ✓' : '*** NO (still claims success)')
  const i = t.search(/Not saved/i)
  if (i>=0) console.log('  ->', JSON.stringify(t.slice(i, i+130).replace(/\n/g,' ')))
  console.log('did the text actually persist?', JSON.stringify(await sqlJson(`select (data->>'legalDescription') legal from fulfillments where order_id='${foreign}'`)))
} else {
  console.log('  (legal description field not found — form may not have rendered)')
}
console.log('page errors:', errors.filter(e=>!e.includes('ERR_FAILED')).slice(0,3))
await shot(page,'silent-write'); await ctx.close(); await b.close()
