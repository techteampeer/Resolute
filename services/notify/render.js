// Email rendering. Produces { subject, html, text } and nothing else.
//
// Written for mail clients, not browsers: tables rather than flex/grid, inline
// styles rather than a stylesheet, no web fonts, no external images. Outlook
// ignores most of what the portal's CSS relies on, so none of it is reused.
//
// Every message ships a text/plain alternative. It is not a formality — a
// message with no text part scores worse with spam filters, and this is
// operational mail that has to arrive.
import { typeOf, factsFor, linkFor, orderRef, clientLabel } from './types.js'

const NAVY = '#12284C'
const INK = '#3D5171'
const MUTED = '#5C6E8C'
const BORDER = '#DDE3EC'
const GROUND = '#F3F5F8'

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

// Outer chrome shared by every message.
const shell = (title, inner) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GROUND};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:6px;overflow:hidden;">
  <tr><td style="background:${NAVY};padding:16px 24px;">
    <span style="font:600 15px ${FONT};color:#ffffff;letter-spacing:.02em;">Resolute</span>
    <span style="font:400 13px ${FONT};color:#8FA3C4;padding-left:8px;">Portal</span>
  </td></tr>
  ${inner}
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;">
  <tr><td style="padding:14px 24px;font:400 11px ${FONT};color:${MUTED};line-height:1.5;">
    You are receiving this because of your role in the Resolute portal.
    Change what you are notified about in Settings → Notifications.
  </td></tr>
</table>
</td></tr></table></body></html>`

const factRows = (facts) => facts.map(([k, v]) => `
  <tr>
    <td style="padding:5px 0;font:400 12px ${FONT};color:${MUTED};width:120px;vertical-align:top;">${esc(k)}</td>
    <td style="padding:5px 0;font:600 13px ${FONT};color:${NAVY};vertical-align:top;">${esc(v)}</td>
  </tr>`).join('')

const button = (href, label, accent) => href ? `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;">
    <tr><td style="background:${accent};border-radius:5px;">
      <a href="${esc(href)}" style="display:inline-block;padding:11px 22px;font:600 14px ${FONT};color:#ffffff;text-decoration:none;">${esc(label)} &rarr;</a>
    </td></tr>
  </table>` : ''

// ---- single event ---------------------------------------------------------
export function renderOne(row, { baseUrl, recipientRole = 'admin' } = {}) {
  const t = typeOf(row.type_key)
  const p = row.payload || {}
  const subject = t.subject(p, recipientRole)
  const href = linkFor(p, baseUrl, recipientRole)
  const quote = t.quote?.(p)
  const facts = factsFor(row.type_key, p, recipientRole)

  const inner = `
  <tr><td style="height:4px;background:${t.accent};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:26px 24px 24px;">
    <div style="font:600 11px ${FONT};color:${t.accent};letter-spacing:.09em;text-transform:uppercase;">${esc(t.label)}</div>
    <div style="font:700 21px ${FONT};color:${NAVY};padding:8px 0 10px;">${esc(t.headline(p))}</div>
    <div style="font:400 14px ${FONT};color:${INK};line-height:1.6;">${esc(t.lead(p, recipientRole))}</div>
    ${quote ? `<div style="margin:16px 0 4px;padding:12px 14px;background:${GROUND};border-left:3px solid ${t.accent};font:400 14px ${FONT};color:${NAVY};line-height:1.6;">${esc(quote)}</div>` : ''}
    ${facts.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:18px;border-top:1px solid ${BORDER};padding-top:6px;">${factRows(facts)}</table>` : ''}
    ${button(href, t.cta, t.accent)}
  </td></tr>`

  const text = [
    t.label.toUpperCase(),
    t.headline(p),
    '',
    t.lead(p, recipientRole),
    quote ? `\n  "${quote}"` : '',
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    href ? `\n${t.cta}: ${href}` : '',
  ].filter(x => x !== '').join('\n')

  return { subject, html: shell(subject, inner), text }
}

// ---- daily digest ---------------------------------------------------------
// One message covering everything queued for digest. The point is that nobody
// gets forty emails a day, so this must stay a roll-up even when it is long:
// grouped by order, newest first, with the order's own line as the heading.
export function renderDigest(rows, { baseUrl, recipientRole = 'admin', date = new Date() } = {}) {
  const byOrder = new Map()
  for (const r of rows) {
    const key = r.order_id || '—'
    if (!byOrder.has(key)) byOrder.set(key, [])
    byOrder.get(key).push(r)
  }

  const day = date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  })
  const n = rows.length
  const subject = `Resolute · ${n} update${n === 1 ? '' : 's'} · ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`

  const blocks = [...byOrder.entries()].map(([orderId, items]) => {
    const p = items[0].payload || {}
    const href = linkFor(p, baseUrl, recipientRole)
    const heading = [orderRef({ ...p, orderId }), clientLabel(p, recipientRole)].filter(Boolean).join(' · ')
    const lines = items.map(it => {
      const t = typeOf(it.type_key)
      const when = it.payload?.occurredAt
        ? new Date(it.payload.occurredAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
        : ''
      return `<tr>
        <td style="padding:4px 10px 4px 0;font:400 11px ${FONT};color:${MUTED};white-space:nowrap;vertical-align:top;">${esc(when)}</td>
        <td style="padding:4px 0;font:400 13px ${FONT};color:${INK};line-height:1.5;vertical-align:top;">${esc(it.payload?.action || t.label)}</td>
      </tr>`
    }).join('')
    return `
    <tr><td style="padding:0 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid ${BORDER};padding-top:14px;margin-top:14px;">
        <tr><td style="padding:14px 0 4px;">
          ${href ? `<a href="${esc(href)}" style="font:600 14px ${FONT};color:${NAVY};text-decoration:none;">${esc(heading)}</a>`
                 : `<span style="font:600 14px ${FONT};color:${NAVY};">${esc(heading)}</span>`}
        </td></tr>
        <tr><td><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">${lines}</table></td></tr>
      </table>
    </td></tr>`
  }).join('')

  const inner = `
  <tr><td style="height:4px;background:#00B8D9;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:26px 24px 6px;">
    <div style="font:600 11px ${FONT};color:#00849B;letter-spacing:.09em;text-transform:uppercase;">Daily digest</div>
    <div style="font:700 21px ${FONT};color:${NAVY};padding:8px 0 4px;">${n} update${n === 1 ? '' : 's'} across ${byOrder.size} order${byOrder.size === 1 ? '' : 's'}</div>
    <div style="font:400 13px ${FONT};color:${MUTED};">${esc(day)}</div>
  </td></tr>
  ${blocks}
  <tr><td style="padding:8px 24px 26px;">
    ${button(baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/${recipientRole}` : null, 'Open the portal', '#2441E5')}
  </td></tr>`

  const text = [
    `RESOLUTE — DAILY DIGEST`, day, '',
    ...[...byOrder.entries()].flatMap(([orderId, items]) => {
      const p = items[0].payload || {}
      return [
        [orderRef({ ...p, orderId }), clientLabel(p, recipientRole)].filter(Boolean).join(' · '),
        ...items.map(it => `  - ${it.payload?.action || typeOf(it.type_key).label}`),
        '',
      ]
    }),
  ].join('\n')

  return { subject, html: shell(subject, inner), text }
}
