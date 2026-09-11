import { browser, login, watchNetwork, shot } from './harness.mjs'
// Every portal's landing page after this batch: the Layout change touches all
// seven shells, and hydrateFulfillment touches every fulfillment read.
const ROLES = [['rajni','admin'],['admin','admin'],['vivek','admin'],['screener','screener'],
               ['examiner','examiner'],['typer','typer'],['delivery','delivery'],
               ['operator','operator'],['client','client']]
const b = await browser()
let fails = 0
for (const [who] of ROLES) {
  const { page, ctx, errors } = await login(b, who)
  await page.waitForTimeout(2500)
  const t = await page.locator('body').innerText()
  const pe = errors.filter(e => e.startsWith('PAGEERROR'))
  const banner = /Not saved/i.test(t)
  const ok = t.length > 200 && !pe.length && !banner
  if (!ok) fails++
  console.log(`${who.padEnd(9)} ${page.url().replace('http://127.0.0.1:5173','').padEnd(12)} chars=${String(t.length).padEnd(6)} ${ok ? 'ok ✓' : '*** ' + (pe.length ? pe.slice(0,1) : banner ? 'stray Not-saved banner' : 'empty page')}`)
  // walk every sidebar entry (they are buttons, not anchors)
  const nav = page.locator('aside button, nav button')
  const n = await nav.count()
  const seen = new Set()
  for (let i = 0; i < n; i++) {
    const item = nav.nth(i)
    const label = (await item.innerText().catch(() => '')).split('\n')[0].trim()
    if (!label || seen.has(label) || /sign out/i.test(label)) continue
    seen.add(label)
    await item.click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1100)
    const tt = await page.locator('body').innerText()
    const p2 = errors.filter(e => e.startsWith('PAGEERROR'))
    const url = page.url().replace('http://127.0.0.1:5173', '')
    const bad = tt.length < 200 || p2.length > pe.length || /Not saved/i.test(tt)
    console.log(`   ${bad ? '***' : '  '} ${label.padEnd(20)} ${url.padEnd(24)} chars=${tt.length}${p2.length > pe.length ? ' ' + p2.slice(pe.length, pe.length + 1) : ''}`)
    if (bad) fails++
  }
  await shot(page, `smoke7-${who}`)
  await ctx.close()
}
console.log(fails ? `*** ${fails} problems` : 'all portals and nav items rendered ✓')
await b.close()
