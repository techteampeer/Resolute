// Title Commitment → real PDF.
//
// BUG_011: the commitment was generated as `.doc` (HTML with a Word MIME type)
// and that file is what reached the client. Clients must receive a PDF.
//
// pdfmake renders true vector output, so the result is selectable, searchable
// and small — which matters for a legal document that gets archived. (A
// canvas-rasterising converter would produce an image-only PDF instead.)
// pdfmake + its font pack is ~2 MB, so it is imported dynamically: the cost is
// paid only when someone actually generates a commitment.
import {
  requirementText, exceptionText, fmtDate, fmtDateTime, titleVestingAuto, recInfo,
} from '../data/fulfillment'
import { LOGO_SVG } from '../components/CommitmentDocument'

const GREEN = '#3d7020'
const TEXT   = '#1e293b'
const MUTED  = '#64748b'
const BORDER = '#e2e8f0'
const PLACEHOLDER = { text: '—', color: '#94a3b8', italics: true }

const v = (s) => (s && String(s).trim() ? String(s) : PLACEHOLDER)
const heading = (text) => ({
  text, style: 'h2', margin: [0, 14, 0, 6],
})

// Two-column key/value grid, matching the HTML layout.
const grid = (pairs) => ({
  table: {
    widths: ['22%', '28%', '22%', '28%'],
    body: chunk(pairs.filter(Boolean), 2).map(row => {
      const cells = []
      for (const [k, val] of row) {
        cells.push({ text: String(k).toUpperCase(), style: 'k' })
        cells.push({ text: val && String(val).trim() ? String(val) : '—', style: 'v' })
      }
      while (cells.length < 4) cells.push({ text: '' })
      return cells
    }),
  },
  layout: {
    hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
    vLineWidth: () => 0,
    hLineColor: () => BORDER,
    paddingTop: () => 3, paddingBottom: () => 3,
    paddingLeft: () => 0, paddingRight: () => 8,
  },
  margin: [0, 0, 0, 4],
})

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const dataTable = (headers, rows, emptyText) => {
  if (!rows.length) return { text: emptyText, color: '#94a3b8', italics: true, fontSize: 9, margin: [0, 2, 0, 4] }
  return {
    table: {
      headerRows: 1,
      widths: headers.map(h => h.width),
      body: [
        headers.map(h => ({ text: h.label.toUpperCase(), style: 'th', alignment: h.align || 'left' })),
        ...rows,
      ],
    },
    layout: {
      hLineWidth: () => 0.5, vLineWidth: () => 0.5,
      hLineColor: () => BORDER, vLineColor: () => BORDER,
      paddingTop: () => 4, paddingBottom: () => 4,
    },
    margin: [0, 2, 0, 4],
  }
}

// Numbered clause list (Schedule B-I / B-II).
const clauses = (items, resolve) => {
  if (!items || !items.length) return { text: 'None.', color: '#94a3b8', italics: true, fontSize: 9.5, margin: [0, 2, 0, 4] }
  return {
    ol: items.map(it => ({ text: resolve(it) || '—', margin: [0, 0, 0, 5], alignment: 'justify' })),
    fontSize: 9.5, margin: [0, 2, 0, 4],
  }
}

const bullets = (arr) => {
  const vals = (arr || []).map(x => x.value).filter(x => x && x.trim())
  if (!vals.length) return { text: 'None recorded.', color: '#94a3b8', italics: true, fontSize: 9.5, margin: [0, 2, 0, 4] }
  return { ul: vals, fontSize: 9.5, margin: [0, 2, 0, 4] }
}

// pdfmake document definition mirroring buildCommitmentHtml().
export function commitmentDocDefinition(order, f) {
  const m = f.meta || {}
  const vest = f.titleVesting?.isAuto
    ? titleVestingAuto(f.deeds?.[0] || {}, m.county)
    : (f.titleVesting?.text || '')
  const tax = f.tax || {}
  const hasTax = Object.values(tax).some(x => x && String(x).trim())
  const genAt = fmtDateTime(new Date().toISOString())

  const deedRows = (f.deeds || []).map((d, i) => ([
    { text: [{ text: i === 0 ? 'Vesting' : `#${i + 1}`, bold: true }, d.deedType ? { text: `\n${d.deedType}`, fontSize: 7.5, color: MUTED } : ''] },
    v(d.grantor), v(d.grantee),
    { text: d.dateOfDeed ? fmtDate(d.dateOfDeed) : '—', alignment: 'right' },
    { text: d.recordedDate ? fmtDate(d.recordedDate) : '—', alignment: 'right' },
    { text: recInfo(d) || '—', alignment: 'right' },
  ]))

  const judgmentRows = (f.judgments || []).map(j => ([
    v(j.instrumentName), v(j.caseNo),
    { text: j.filedOn ? fmtDate(j.filedOn) : '—', alignment: 'right' },
    { text: j.recDate ? fmtDate(j.recDate) : '—', alignment: 'right' },
    { text: recInfo(j) || '—', alignment: 'right' },
    { text: j.amount ? `$${j.amount}` : '—', alignment: 'right' },
  ]))

  const content = [
    // Header: brand mark left, document title right.
    {
      columns: [
        { svg: LOGO_SVG, width: 150 },
        {
          width: '*',
          stack: [
            { text: 'Title Commitment & Search Report', style: 'h1', alignment: 'right' },
            { text: `Order ${order.id}  ·  ${m.productType || order.type || ''}`, style: 'meta', alignment: 'right' },
            { text: `Prepared ${genAt}`, style: 'meta', alignment: 'right' },
          ],
        },
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 511, y2: 4, lineWidth: 2, lineColor: GREEN }] },

    heading('Search Information'),
    grid([
      ['Client Order No.', m.clientOrderNo || order.id],
      ['Product Type', m.productType || order.type],
      ['Property Address', m.address],
      ['State & County', [m.county, m.state].filter(Boolean).join(', ')],
      ['Search Date', m.searchDate ? fmtDate(m.searchDate) : ''],
      ['Effective Date', f.searchEffectiveAt ? fmtDateTime(f.searchEffectiveAt) : ''],
      ['Record Owner', m.recordOwner],
      ['Estate Type', f.estateType],
      ['Parcel ID(s)', (f.parcels || []).map(p => p.value).filter(Boolean).join('; ')],
    ]),

    heading('Title Vesting'),
    vest ? { text: vest, alignment: 'justify' } : { text: 'Not provided.', color: '#94a3b8', italics: true },

    heading('Deeds — Vesting & Chain of Title'),
    dataTable(
      [{ label: 'Deed', width: 62 }, { label: 'Grantor', width: '*' }, { label: 'Grantee', width: '*' },
       { label: 'Dated', width: 58, align: 'right' }, { label: 'Recorded', width: 58, align: 'right' },
       { label: 'Rec Info', width: 66, align: 'right' }],
      deedRows, 'No deeds recorded.'),

    heading('Legal Description'),
    f.legalDescription
      ? { text: f.legalDescription, alignment: 'justify', preserveLeadingSpaces: true }
      : { text: 'Not provided.', color: '#94a3b8', italics: true },
  ]

  if (hasTax) {
    content.push(heading('Assessment & Tax Information'), grid([
      ['Assessed Land', tax.assessedLand], ['Assessed Building', tax.assessedBuilding],
      ['Total Assessed', tax.totalAssessed], ['Tax Year', tax.taxYear],
      ['Status', tax.status], ['1st Half', tax.firstHalfAmount],
      ['2nd Half', tax.secondHalfAmount],
    ]))
  }

  content.push(
    heading('Schedule B-I — Requirements'), clauses(f.requirements, requirementText),
    heading('Schedule B-II — Exceptions'),   clauses(f.exceptions, exceptionText),
  )

  if (judgmentRows.length) {
    content.push(heading('Judgments / Liens'), dataTable(
      [{ label: 'Instrument', width: '*' }, { label: 'Case No.', width: 70 },
       { label: 'Filed', width: 56, align: 'right' }, { label: 'Recorded', width: 56, align: 'right' },
       { label: 'Rec Info', width: 62, align: 'right' }, { label: 'Amount', width: 56, align: 'right' }],
      judgmentRows, ''))
  }

  content.push(
    heading('Names Searched'), bullets(f.namesSearched),
    heading('Additional Information'), bullets(f.additionalInfo),
  )

  if (f.disclaimer) {
    content.push({
      text: f.disclaimer, style: 'disclaimer', alignment: 'justify',
      margin: [0, 18, 0, 0],
    })
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [50, 50, 50, 46],
    info: { title: `${order.id} — Title Commitment`, author: 'Resolute Title Services' },
    content,
    styles: {
      h1: { fontSize: 15, bold: true, color: TEXT },
      h2: { fontSize: 10, bold: true, color: GREEN, characterSpacing: 0.5 },
      meta: { fontSize: 8, color: MUTED, margin: [0, 2, 0, 0] },
      k: { fontSize: 7.5, color: MUTED, characterSpacing: 0.3 },
      v: { fontSize: 8.5, bold: true, color: TEXT },
      th: { fontSize: 7.5, bold: true, color: '#33501a', fillColor: '#f0f7ea' },
      disclaimer: { fontSize: 7, color: MUTED, lineHeight: 1.35 },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: TEXT, lineHeight: 1.35 },
    footer: (page, pages) => ({
      margin: [50, 8, 50, 0],
      columns: [
        { text: 'Resolute Title Services · Confidential', fontSize: 7, color: '#94a3b8' },
        { text: `${order.id} · Page ${page} of ${pages}`, fontSize: 7, color: '#94a3b8', alignment: 'right' },
      ],
    }),
  }
}

// Load pdfmake on demand and register its bundled fonts (pdfmake 0.3 exports
// the virtual file system as the module's default export).
async function pdfMakeInstance() {
  const [{ default: pdfMake }, fonts] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ])
  pdfMake.vfs = fonts.default || fonts.vfs || fonts
  return pdfMake
}

export const commitmentFileName = (order) => `Title Commitment - ${order.id}.pdf`

// Blob for upload/attachment (what the client eventually downloads).
export async function commitmentPdfBlob(order, f) {
  const pdfMake = await pdfMakeInstance()
  return new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(commitmentDocDefinition(order, f)).getBlob(resolve)
    } catch (err) { reject(err) }
  })
}

// Direct browser download (preview modal).
export async function downloadCommitmentPdf(order, f) {
  const pdfMake = await pdfMakeInstance()
  pdfMake.createPdf(commitmentDocDefinition(order, f)).download(commitmentFileName(order))
}
