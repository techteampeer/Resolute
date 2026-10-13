import { chromium } from 'playwright'
import { CHROME, CREDS } from './harness.mjs'
// Mock mode: a second Vite on :5174 with the Supabase env blanked.
const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const ctx = await b.newContext()
await ctx.route('**/*', r => {
  const u = r.request().url()
  return (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost') || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort()
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
const [email, pw] = CREDS.typer
await page.goto('http://127.0.0.1:5174/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 })
await page.fill('input[type="email"], input[name="email"]', email)
await page.fill('input[type="password"]', pw)
await page.click('button[type="submit"]')
await page.waitForTimeout(2500)
console.log('after login:', page.url())
// Navigate in-app: mock mode keeps the session in React state only, so a hard
// navigation reloads the app with nobody signed in (there is no session to
// restore, unlike the Supabase path).
await page.locator('aside button, nav button').filter({ hasText: 'Notifications' }).first().click()
await page.waitForTimeout(2000)
const t = await page.locator('body').innerText()
console.log('url:', page.url())
console.log('demo notice:', JSON.stringify((t.match(/Demo mode[^\n]*/) || ['*** none'])[0]))
console.log('types listed:', JSON.stringify([...t.matchAll(/^(Work assigned to you|New order placed)$/gm)].map(m => m[1])))
const card = page.locator('.glass-card').filter({ hasText: 'Work assigned to you' }).first()
if (await card.count()) {
  await card.getByRole('button', { name: 'Off', exact: true }).click()
  await page.waitForTimeout(800)
  const c = await card.innerText()
  console.log('local toggle works:', /Your choice: Off/.test(c) ? 'yes ✓' : '*** no')
  console.log('no error banner:', /Not saved/.test(c) ? '*** banner shown' : 'correct ✓')
}
console.log('page errors:', errors.slice(0, 3))
await ctx.close(); await b.close()
