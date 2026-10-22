// Per-order invoice → branded PDF. Same engine as the title commitment
// (pdfmake, dynamically imported so the ~2MB font pack is paid for only when
// someone downloads an invoice). The portal is a LEDGER, never a gateway — this
// document records the amount, dates, payment status and where to remit; it does
// not take payment.
import {
  invoiceNumber, invoiceAmount, money, payStatusOf, PAY_STATUS,
  dueDate, paymentOf, REMITTANCE, termByKey,
} from './billing'

const ACCENT = '#2441E5'
const TEXT   = '#12284C'
const MUTED  = '#5C6E8C'
const BORDER = '#DDE3EC'

// Load pdfmake on demand + register its bundled fonts (0.3 exports the vfs as
// the module default). Mirrors commitmentPdf.js.
async function pdfMakeInstance() {
  const [{ default: pdfMake }, fonts] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ])
  pdfMake.vfs = fonts.default || fonts.vfs || fonts
  return pdfMake
}

// The brand mark as a data URI (pdfmake needs raster as data). Memoised; the
// document still renders without it (falls back to a wordmark).
let _brandLogo
async function brandLogo() {
  if (_brandLogo !== undefined) return _brandLogo
  try {
    const res = await fetch('/logo-horizontal.png')
    if (!res.ok) throw new Error(`logo ${res.status}`)
    const blob = await res.blob()
    _brandLogo = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })
  } catch { _brandLogo = null }
  return _brandLogo
}

// Remittance block mirroring the Billing page's on-screen instructions.
function remitStack() {
  const lines = []
  if (REMITTANCE.payee && REMITTANCE.checkAddress) {
    lines.push({ text: `Check payable to: ${REMITTANCE.payee}`, style: 'remit' })
    lines.push({ text: REMITTANCE.checkAddress, style: 'remit' })
  }
  if (REMITTANCE.routingNumber && REMITTANCE.accountNumber) {
    lines.push({ text: `ACH — ${REMITTANCE.bankName || ''} · Routing ${REMITTANCE.routingNumber} · Acct ${REMITTANCE.accountNumber}`, style: 'remit' })
  }
  if (!lines.length) lines.push({ text: `Contact ${REMITTANCE.billingEmail} for ACH or check remittance details.`, style: 'remit' })
  lines.push({ text: 'Reference the invoice number on your payment. Credit is applied once funds are received and deposited.', style: 'remitFine', margin: [0, 2, 0, 0] })
  return lines
}

export function invoiceDocDefinition(order, { company, termKey, logo }) {
  const invoiceNo = invoiceNumber(order)
  const amount = invoiceAmount(order)
  const status = payStatusOf(order)
  const statusMeta = PAY_STATUS[status] || PAY_STATUS.unpaid
  const term = termByKey(termKey)
  const due = dueDate(order, termKey)
  const p = paymentOf(order)
  const property = order.workflow?.intake?.propertyAddress || [order.county, order.state].filter(Boolean).join(', ')

  return {
    pageSize: 'LETTER',
    pageMargins: [50, 50, 50, 46],
    info: { title: `${invoiceNo} — Invoice`, author: 'Resolute Title Services' },
    content: [
      {
        columns: [
          logo ? { image: logo, fit: [190, 52] } : { text: 'Resolute Title Services', style: 'h1', margin: [0, 6, 0, 0] },
          { width: '*', stack: [
            { text: 'INVOICE', style: 'h1', alignment: 'right' },
            { text: invoiceNo, style: 'meta', alignment: 'right' },
            { text: `Issued ${new Date().toISOString().slice(0, 10)}`, style: 'meta', alignment: 'right' },
          ] },
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 511, y2: 4, lineWidth: 2, lineColor: ACCENT }], margin: [0, 0, 0, 10] },

      {
        columns: [
          { width: '*', stack: [
            { text: 'BILL TO', style: 'k' },
            { text: company || order.client || '—', style: 'v', margin: [0, 1, 0, 0] },
          ] },
          { width: '*', stack: [
            { text: 'ORDER', style: 'k' },
            { text: `${order.id} · ${order.type || ''}`, style: 'v', margin: [0, 1, 0, 0] },
            { text: property, style: 'small' },
            { text: `Delivered ${order.completed || '—'}   ·   Due ${due || 'on receipt'}${term?.key && term.key !== 'per_order' ? ` (${term.label})` : ''}`, style: 'small' },
          ] },
        ],
        margin: [0, 0, 0, 14],
      },

      {
        table: {
          headerRows: 1, widths: ['*', 90],
          body: [
            [{ text: 'DESCRIPTION', style: 'th' }, { text: 'AMOUNT', style: 'th', alignment: 'right' }],
            [{ text: `${order.type || 'Title search'} — order ${order.id}`, style: 'cell' }, { text: money(amount), style: 'cell', alignment: 'right' }],
            [{ text: 'Total', style: 'totalLabel', alignment: 'right' }, { text: money(amount), style: 'total', alignment: 'right' }],
          ],
        },
        layout: {
          hLineWidth: () => 0.5, vLineWidth: () => 0,
          hLineColor: () => BORDER,
          paddingTop: () => 6, paddingBottom: () => 6,
        },
      },

      { text: 'STATUS', style: 'k', margin: [0, 12, 0, 2] },
      { text: statusMeta.label + (status === 'confirmed' && p?.confirmedAt ? ` · ${p.confirmedAt}` : status === 'marked' ? ' · awaiting deposit confirmation' : ''), color: statusMeta.color, bold: true, fontSize: 11 },
      ...(p && status !== 'unpaid' ? [{ text: `${p.method} ref ${p.reference}`, style: 'small' }] : []),

      { text: 'REMIT TO', style: 'k', margin: [0, 14, 0, 2] },
      ...remitStack(),
    ],
    styles: {
      h1: { fontSize: 16, bold: true, color: TEXT },
      meta: { fontSize: 8.5, color: MUTED, margin: [0, 2, 0, 0] },
      k: { fontSize: 7.5, color: MUTED, characterSpacing: 0.4 },
      v: { fontSize: 11, bold: true, color: TEXT },
      small: { fontSize: 8.5, color: MUTED, margin: [0, 1, 0, 0] },
      th: { fontSize: 8, bold: true, color: TEXT, fillColor: '#EEF1FE' },
      cell: { fontSize: 10, color: TEXT },
      totalLabel: { fontSize: 9, bold: true, color: MUTED },
      total: { fontSize: 12, bold: true, color: ACCENT },
      remit: { fontSize: 9, color: TEXT, margin: [0, 1, 0, 0] },
      remitFine: { fontSize: 7.5, color: MUTED, lineHeight: 1.3 },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: TEXT, lineHeight: 1.35 },
    footer: (page, pages) => ({
      margin: [50, 8, 50, 0],
      columns: [
        { text: 'Resolute Title Services · Thank you for your business', fontSize: 7, color: '#9AA8BF' },
        { text: `${invoiceNo} · Page ${page} of ${pages}`, fontSize: 7, color: '#9AA8BF', alignment: 'right' },
      ],
    }),
  }
}

export const invoiceFileName = (order) => `Invoice ${invoiceNumber(order)} - ${order.id}.pdf`

export async function downloadInvoicePdf(order, opts = {}) {
  const [pdfMake, logo] = await Promise.all([pdfMakeInstance(), brandLogo()])
  pdfMake.createPdf(invoiceDocDefinition(order, { ...opts, logo })).download(invoiceFileName(order))
}
