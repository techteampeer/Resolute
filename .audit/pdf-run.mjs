import { chromium } from 'playwright'
import fs from 'node:fs'
const OUT = (process.env.AUDIT_OUT || new URL('./out', import.meta.url).pathname) + '/lead-pdf'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox','--disable-dev-shm-usage'] })
const ctx = await b.newContext()
await ctx.route('**/*', r => {
  const u = r.request().url()
  return (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort()
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()) })
try {
  // Serve the bundle from the dev server's origin so an ES module can execute.
  fs.copyFileSync('.audit/pdf-bundle.mjs', 'public/__audit-bundle.mjs')
  await p.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
  await p.addScriptTag({ url: '/__audit-bundle.mjs', type: 'module' })
  await p.waitForFunction(() => typeof window.__audit === 'function', null, { timeout: 60000 })
  const r = await p.evaluate(() => window.__audit())
  fs.writeFileSync(`${OUT}/full.pdf`, Buffer.from(r.fullPdf, 'base64'))
  fs.writeFileSync(`${OUT}/sparse.pdf`, Buffer.from(r.sparsePdf, 'base64'))
  if (r.barePdf) fs.writeFileSync(`${OUT}/bare.pdf`, Buffer.from(r.barePdf, 'base64'))
  fs.writeFileSync(`${OUT}/full-textnodes.txt`, r.fullDef.join('\n'))
  fs.writeFileSync(`${OUT}/sparse-textnodes.txt`, r.sparseDef.join('\n'))
  if (r.bareDef) fs.writeFileSync(`${OUT}/bare-textnodes.txt`, r.bareDef.join('\n'))
  fs.writeFileSync(`${OUT}/untouched.pdf`, Buffer.from(r.untouchedPdf, 'base64'))
  fs.writeFileSync(`${OUT}/untouched-textnodes.txt`, r.untouchedDef.join('\n'))
  fs.writeFileSync(`${OUT}/untouched.html`, r.untouchedHtml)
  fs.writeFileSync(`${OUT}/full.html`, r.fullHtml)
  const scan = (label, txt) => {
    const toks = [...String(txt).matchAll(/‹[^›]*›/g)].map(m => m[0])
    console.log(`${label}: ${toks.length ? '*** TOKENS ' + JSON.stringify([...new Set(toks)]) : 'no ‹token› anywhere ✓'}`)
  }
  scan('untouched PDF text', r.untouchedDef.join('\n'))
  scan('untouched HTML    ', r.untouchedHtml)
  scan('full PDF text     ', r.fullDef.join('\n'))
  scan('full HTML         ', r.fullHtml)
  scan('sparse PDF text   ', r.sparseDef.join('\n'))
  const u = r.untouchedDef.join('\n')
  console.log('untouched: deeds table printed?', /GRANTOR|GRANTEE/.test(u) ? '(headers present)' : 'no', '| "No deeds recorded." present?', u.includes('No deeds recorded.') ? 'YES ✓' : '*** NO')
  const bi = u.indexOf('SCHEDULE B-I'); const bii = u.indexOf('SCHEDULE B-II')
  console.log('untouched Schedule B-I clauses:')
  console.log(u.slice(bi, bii).split('\n').slice(1).map((l,i)=>`   ${i+1}. ${l.slice(0,110)}`).join('\n'))
  console.log('CHARGE- markers present anywhere in docDefinition?', r.invoiceMentioned)
  console.log('empty {} fulfillment -> docDefinition:', r.bareErr || 'built OK')
  console.log('empty {} fulfillment -> pdf:', r.barePdfErr || 'rendered OK')
  console.log('full.pdf bytes:', fs.statSync(`${OUT}/full.pdf`).size, '| sparse.pdf bytes:', fs.statSync(`${OUT}/sparse.pdf`).size)
} catch (e) {
  console.log('FAILED:', e.message)
} finally {
  console.log('errors:', errs.length ? errs.slice(0, 6) : 'none')
  try { fs.unlinkSync('public/__audit-bundle.mjs') } catch {}
  await b.close()
}
