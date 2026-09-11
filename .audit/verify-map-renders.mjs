import { browser, login, sqlJson, shot } from './harness.mjs'
// The coverage map draws from public/us-states-10m.json, served by us, and
// colours every state from real orders. It used to fetch the topology from
// cdn.jsdelivr.net at runtime and colour from a hardcoded fixture.
const b = await browser()
const { page, ctx, errors } = await login(b, 'rajni')
const net = []
page.on('response', r => { if (/states-10m/.test(r.url())) net.push(`${r.status()} ${new URL(r.url()).host}`) })
page.on('requestfailed', r => { if (/states-10m|jsdelivr/.test(r.url())) net.push(`FAILED ${r.url()}`) })
await page.waitForTimeout(1200)
await page.goto('http://127.0.0.1:5173/admin/map', { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForTimeout(4000)

const byState = await sqlJson("select state, count(*) n from orders group by 1 order by 2 desc, 1")
console.log('db by state:', JSON.stringify(byState))
console.log('topology served by:', JSON.stringify([...new Set(net)]))
console.log('states drawn:', await page.locator('svg g').count(), '| paths:', await page.locator('svg path').count())

// innerText is unreliable on SVG <text>; read textContent directly.
const labels = await page.evaluate(() => [...document.querySelectorAll('svg text')]
  .map(t => (t.textContent || '').trim()).filter(Boolean))
const want = byState.map(r => r.state).sort()
console.log('labelled states:', JSON.stringify([...labels].sort()))
console.log('expected (states with orders):', JSON.stringify(want))
console.log(JSON.stringify([...labels].sort()) === JSON.stringify(want)
  ? '  ✓ a label on exactly the states that have orders' : '  *** mismatch')

const busiest = byState[0]
const idx = await page.evaluate((ab) => [...document.querySelectorAll('svg g')]
  .findIndex(g => g.querySelector('text')?.textContent?.trim() === ab), busiest.state)
if (idx >= 0) {
  await page.locator('svg g').nth(idx).locator('path').first().hover()
  await page.waitForTimeout(800)
  const tip = (await page.locator('body').innerText()).match(/(\d+) active orders/)
  console.log(`tooltip over ${busiest.state}: ${JSON.stringify(tip?.[0] || '(none)')} — db says ${busiest.n}`,
    tip && tip[1] === String(busiest.n) ? '✓' : '***')
}
const t = await page.locator('body').innerText()
console.log('spinner stuck?', /Loading map/.test(t) ? '*** yes' : 'no ✓',
            '| failure notice?', /could not be loaded/.test(t) ? '*** yes' : 'no ✓')
await shot(page, 'map-rendered')
console.log('page errors:', errors.filter(e => e.startsWith('PAGEERROR')).slice(0, 3))
await ctx.close(); await b.close()
