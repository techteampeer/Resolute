// Render every notification to preview/notifications/ without sending anything.
//
//   node scripts/preview-notifications.mjs
//
// Uses fixed sample data rather than the database so it runs with no
// credentials, no SES identity and no DNS — which is the whole point before
// Friday. The rows are shaped exactly like notification_outbox rows, so what
// you see here is what the live sender will produce.
import { mkdir, writeFile } from 'node:fs/promises'
import { renderOne, renderDigest } from '../services/notify/render.js'
import { TYPES } from '../services/notify/types.js'

const OUT = 'preview/notifications'
const baseUrl = 'https://portal.resolutetitleservices.com'

const order = {
  orderId: 'RTS-10049',
  clientFileNo: 'PNR-2291',
  clientName: 'Pinnacle Real Estate',
  clientCode: 'CL04',
  orderType: 'Full Search',
  state: 'TX', county: 'Travis',
  priority: 'rush',
  status: 'screening',
  assignedTo: 'screener',
  eta: '2026-09-08',
}

const at = (h, m) => new Date(`2026-09-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`).toISOString()

const row = (type_key, extra = {}, i = 1) => ({
  id: i,
  type_key,
  order_id: extra.orderId || order.orderId,
  recipient_email: 'admin@resolutetitleservices.com',
  recipient_name: 'Alex Morrison',
  recipient_role: 'admin',
  mode: 'immediate',
  payload: { ...order, ...extra },
})

const singles = [
  row('order.new', { action: 'New order RTS-10049 placed (Full Search)', occurredAt: at(9, 12), status: 'received', assignedTo: 'admin' }),
  row('order.awaiting_admin', { action: 'Sam Carter completed screening on RTS-10049 → returned to Admin for assignment', actor: 'Sam Carter', occurredAt: at(11, 40) }),
  row('order.cancel_requested', { action: 'Client requested cancellation of RTS-10049 — awaiting Admin approval', occurredAt: at(13, 5) }),
  row('order.delivered', { action: 'Morgan Davis completed delivery on RTS-10049 → delivered', actor: 'Morgan Davis', occurredAt: at(16, 20), status: 'delivered', assignedTo: null }),
  row('message.client', {
    author: 'Riley Stone',
    body: 'Can you confirm whether the 2024 second-half taxes were included in the search? Our lender is asking before we can clear to close.',
    occurredAt: at(14, 2),
  }),
  row('order.progress', { action: 'Jordan Lee completed examination on RTS-10049 → handed to typer', actor: 'Jordan Lee', occurredAt: at(15, 8) }),
]

// A realistic digest: several orders, several updates each.
const digestRows = [
  row('order.progress', { action: 'Sam Carter completed screening on RTS-10049 → handed to examiner', occurredAt: at(9, 40) }, 11),
  row('order.progress', { action: 'Jordan Lee completed examination on RTS-10049 → handed to typer', occurredAt: at(13, 15) }, 12),
  { ...row('order.progress', {}, 13), order_id: 'RTS-10050',
    payload: { ...order, orderId: 'RTS-10050', clientFileNo: 'APX-8841', clientName: 'Apex Lending Partners', clientCode: 'CL02', county: 'Harris', priority: 'normal', action: 'Priya Nair completed typing on RTS-10050 → handed to delivery', occurredAt: at(11, 2) } },
  { ...row('order.progress', {}, 14), order_id: 'RTS-10050',
    payload: { ...order, orderId: 'RTS-10050', clientFileNo: 'APX-8841', clientName: 'Apex Lending Partners', clientCode: 'CL02', county: 'Harris', action: 'Morgan Davis completed delivery on RTS-10050 → delivered', occurredAt: at(16, 45) } },
  { ...row('order.progress', {}, 15), order_id: 'RTS-10051',
    payload: { ...order, orderId: 'RTS-10051', clientFileNo: null, clientName: 'Sterling Law Group', clientCode: 'CL07', state: 'FL', county: 'Orange', action: 'Sam Carter completed screening on RTS-10051 → returned to Admin for assignment', occurredAt: at(10, 20) } },
].map(r => ({ ...r, mode: 'digest' }))

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

await mkdir(OUT, { recursive: true })
const written = []

for (const r of singles) {
  const mail = renderOne(r, { baseUrl, recipientRole: r.recipient_role })
  const name = `${slug(r.type_key)}`
  await writeFile(`${OUT}/${name}.html`, mail.html, 'utf8')
  await writeFile(`${OUT}/${name}.txt`, `Subject: ${mail.subject}\n\n${mail.text}\n`, 'utf8')
  written.push([r.type_key, mail.subject])
}

const digest = renderDigest(digestRows, { baseUrl, recipientRole: 'admin', date: new Date('2026-09-01T18:00:00-04:00') })
await writeFile(`${OUT}/daily-digest.html`, digest.html, 'utf8')
await writeFile(`${OUT}/daily-digest.txt`, `Subject: ${digest.subject}\n\n${digest.text}\n`, 'utf8')
written.push(['daily digest', digest.subject])

// Index page so all of them can be reviewed in one place.
await writeFile(`${OUT}/index.html`, `<!doctype html><meta charset="utf-8">
<title>Notification previews</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#F3F5F8;color:#12284C;margin:0;padding:40px 24px}
main{max-width:760px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}p.sub{color:#5C6E8C;margin:0 0 24px}
a{display:block;padding:14px 16px;margin-bottom:8px;background:#fff;border:1px solid #DDE3EC;border-radius:6px;text-decoration:none;color:#12284C}
a:hover{border-color:#2441E5}small{display:block;color:#5C6E8C;font-size:12px;margin-top:2px}</style>
<main><h1>Notification previews</h1>
<p class="sub">Rendered from sample data — nothing was sent.</p>
${written.map(([k, s]) => `<a href="${slug(k === 'daily digest' ? 'daily-digest' : k)}.html"><strong>${s}</strong><small>${k}</small></a>`).join('\n')}
</main>`, 'utf8')

console.log(`Rendered ${written.length} messages to ${OUT}/`)
for (const [k, s] of written) console.log(`  ${k.padEnd(24)} ${s}`)
