// Shared Playwright + DB harness for driving the Resolute portal.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export const BASE = 'http://127.0.0.1:5173'
export const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
// Where screenshots and generated evidence land. Override with AUDIT_OUT;
// defaults inside .audit/, which git ignores apart from the harness itself.
export const OUT = process.env.AUDIT_OUT || new URL('./out', import.meta.url).pathname
export const SHOTS = `${OUT}/shots`
fs.mkdirSync(SHOTS, { recursive: true })

// A tiny valid PDF for the upload steps, written on demand so the scripts do
// not depend on a file someone left in a temp directory.
export const SAMPLE_PDF = `${OUT}/sample.pdf`
if (!fs.existsSync(SAMPLE_PDF)) fs.writeFileSync(SAMPLE_PDF, '%PDF-1.4\n% audit sample\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

export const CREDS = {
  rajni:     ['rajni@resolute.com',     'admin123'],
  saravanan: ['saravanan@resolute.com', 'admin123'],
  vivek:     ['vivek@resolute.com',     'vivek123'],
  admin:     ['admin@resolute.com',     'admin123'],
  screener:  ['screener@resolute.com',  'screener123'],
  examiner:  ['examiner@resolute.com',  'examiner123'],
  typer:     ['typer@resolute.com',     'typer123'],
  delivery:  ['delivery@resolute.com',  'delivery123'],
  client:    ['client@resolute.com',    'client123'],
  operator:  ['operator@resolute.com',  'operator123'],
}

// ── DB access (service role / superuser, bypasses RLS) ──────────────────────
export function sql(q) {
  return execFileSync('psql', ['-h','127.0.0.1','-p','54322','-U','postgres','-d','postgres','-X','-A','-F','|','-c',q],
    { env: { ...process.env, PGPASSWORD: 'postgres' }, encoding: 'utf8' })
}
export function sqlJson(q) {
  const out = execFileSync('psql', ['-h','127.0.0.1','-p','54322','-U','postgres','-d','postgres','-X','-A','-t','-c',
    `select coalesce(json_agg(t),'[]'::json)::text from (${q}) t`],
    { env: { ...process.env, PGPASSWORD: 'postgres' }, encoding: 'utf8' })
  return JSON.parse(out.trim() || '[]')
}

// ── Browser ────────────────────────────────────────────────────────────────
export async function browser() {
  return chromium.launch({ executablePath: CHROME, args: ['--no-sandbox','--disable-dev-shm-usage'] })
}

// Log in as a role; returns { page, ctx, errors, logs }
export async function login(b, who, { width = 1600, height = 1100 } = {}) {
  const [email, password] = CREDS[who]
  const ctx = await b.newContext({ viewport: { width, height }, acceptDownloads: true })
  // Block everything that is not our app or the local Supabase stack. The
  // sandbox has no egress, so Google Fonts et al. hang for the full timeout.
  await ctx.route('**/*', route => {
    const u = route.request().url()
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue()
    return route.abort()
  })
  const page = await ctx.newPage()
  const errors = [], logs = []
  page.on('console', m => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  // The login form: fill email + password, submit.
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 })
  await page.fill('input[type="email"], input[name="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForTimeout(2500)
  return { page, ctx, errors, logs }
}

export async function shot(page, name) {
  const p = `${SHOTS}/${name}.png`
  await page.screenshot({ path: p, fullPage: true })
  return p
}

// Dump the visible text of the page (trimmed), for assertions on table content.
export async function text(page) {
  return (await page.locator('body').innerText()).replace(/\n{3,}/g, '\n\n')
}

// Capture every network failure / non-2xx REST response.
export function watchNetwork(page) {
  const bad = []
  page.on('response', r => {
    const u = r.url()
    if ((u.includes('/rest/v1/') || u.includes('/auth/v1/') || u.includes('/api/')) && r.status() >= 400)
      bad.push(`${r.status()} ${r.request().method()} ${u}`)
  })
  page.on('requestfailed', r => bad.push(`FAILED ${r.method()} ${r.url()} — ${r.failure()?.errorText}`))
  return bad
}

// ── RLS-enforced client (acts as a real logged-in user via PostgREST) ───────
export const API = 'http://127.0.0.1:54321'
export const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
export const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

export async function token(who) {
  const [email, password] = CREDS[who]
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const j = await r.json()
  if (!j.access_token) throw new Error(`token failed for ${who}: ${JSON.stringify(j)}`)
  return j.access_token
}

// REST call AS a role, with RLS enforced.
export async function as(who, path, opts = {}) {
  const t = await token(who)
  const r = await fetch(`${API}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: ANON, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json',
               Prefer: opts.prefer || 'return=representation', ...(opts.headers || {}) },
  })
  const body = await r.text()
  let json; try { json = JSON.parse(body) } catch { json = body }
  return { status: r.status, ok: r.ok, body: json }
}

// RPC as a role.
export async function rpc(who, fn, args = {}) {
  const t = await token(who)
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = await r.text()
  let json; try { json = JSON.parse(body) } catch { json = body }
  return { status: r.status, ok: r.ok, body: json }
}
