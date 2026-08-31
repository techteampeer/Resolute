import React, { useEffect, useMemo, useRef, useState } from 'react'
import { X, Printer, Download, FileText } from 'lucide-react'
import { useFulfillmentStore } from '../context/FulfillmentContext'
import { downloadCommitmentPdf } from '../lib/commitmentPdf'
import {
  requirementText, exceptionText, fmtDate, fmtDateTime, titleVestingAuto, recInfo,
} from '../data/fulfillment'

// Inline brand mark (swoosh + wordmark + tagline). Swap for the official PNG by
// dropping it in /public and replacing this with <img src="/resolute-logo.png">.
export const LOGO_SVG = `
<svg width="150" height="52" viewBox="0 0 150 52" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Resolute">
  <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#f0a020"/><stop offset="1" stop-color="#e0431f"/></linearGradient></defs>
  <g transform="translate(2,2)">
    <path d="M24 4a20 20 0 1 0 14 6" fill="none" stroke="url(#rg)" stroke-width="7" stroke-linecap="round"/>
    <path d="M38 2 L42 14 L30 12 Z" fill="#e0431f"/>
  </g>
  <text x="52" y="26" font-family="Georgia, serif" font-size="20" font-weight="700" fill="#12284C" letter-spacing="1">RESOLUTE</text>
  <text x="52" y="40" font-family="Arial, sans-serif" font-size="8" fill="#2441E5" letter-spacing="0.5">integrity · intelligence · innovation</text>
</svg>`

// Prefer the official logo from /public; fall back to the inline mark if absent.
const LOGO_HTML = `<span style="display:inline-block">
  <img src="/logo-left.jpg" alt="Resolute" style="height:58px;width:auto;max-width:300px;display:block"
       onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block'" />
  <span style="display:none">${LOGO_SVG}</span>
</span>`

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const val = (s, ph = '—') => (s && String(s).trim() ? esc(s) : `<span class="ph">${ph}</span>`)

function deedRows(deeds = []) {
  return deeds.map((d, i) => `
    <tr>
      <td><b>${i === 0 ? 'Vesting' : '#' + (i + 1)}</b>${d.deedType ? '<br><span class="sub">' + esc(d.deedType) + '</span>' : ''}</td>
      <td>${val(d.grantor)}</td>
      <td>${val(d.grantee)}</td>
      <td class="num">${d.dateOfDeed ? fmtDate(d.dateOfDeed) : '—'}</td>
      <td class="num">${d.recordedDate ? fmtDate(d.recordedDate) : '—'}</td>
      <td class="num">${esc(recInfo(d)) || '—'}</td>
    </tr>`).join('')
}

function listBlock(items, resolve) {
  if (!items || !items.length) return '<p class="ph">None.</p>'
  return `<ol class="clauses">${items.map(it => `<li>${esc(resolve(it)).replace(/\n/g, '<br>')}</li>`).join('')}</ol>`
}

function judgmentRows(js = []) {
  if (!js.length) return ''
  return `<h2>Judgments / Liens</h2><table><thead><tr>
      <th>Instrument</th><th>Case No.</th><th>Filed</th><th>Recorded</th><th>Rec Info</th><th class="num">Amount</th></tr></thead><tbody>
    ${js.map(j => `<tr><td>${val(j.instrumentName)}</td><td>${val(j.caseNo)}</td>
      <td class="num">${j.filedOn ? fmtDate(j.filedOn) : '—'}</td><td class="num">${j.recDate ? fmtDate(j.recDate) : '—'}</td>
      <td class="num">${esc(recInfo(j)) || '—'}</td><td class="num">${j.amount ? '$' + esc(j.amount) : '—'}</td></tr>`).join('')}
    </tbody></table>`
}

function lines(arr) {
  const vals = (arr || []).map(x => x.value).filter(v => v && v.trim())
  return vals.length ? `<ul class="plain">${vals.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : '<p class="ph">None recorded.</p>'
}

// Build the full standalone HTML document (used for preview iframe, print, and .doc).
export function buildCommitmentHtml(order, f) {
  const m = f.meta || {}
  const vest = f.titleVesting?.isAuto ? titleVestingAuto(f.deeds?.[0] || {}, m.county) : (f.titleVesting?.text || '')
  const tax = f.tax || {}
  const hasTax = Object.values(tax).some(v => v && String(v).trim())
  const genAt = fmtDateTime(new Date().toISOString())
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(order.id)} — Title Commitment</title>
<style>
  @page { size: letter; margin: 0.7in; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #12284C; font-size: 11pt; line-height: 1.5; margin: 0; }
  .wrap { max-width: 7.1in; margin: 0 auto; }
  header { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 3px solid #2441E5; padding-bottom: 12px; margin-bottom: 6px; }
  header .doc-title { text-align: right; }
  header .doc-title h1 { font-size: 16pt; margin: 0; color: #12284C; letter-spacing: 0.5px; }
  header .doc-title .meta { font-family: Arial, sans-serif; font-size: 8.5pt; color: #3D5171; margin-top: 3px; }
  h2 { font-family: Arial, sans-serif; font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.06em;
       color: #2441E5; border-bottom: 1px solid #DDE3EC; padding-bottom: 3px; margin: 18px 0 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-family: Arial, sans-serif; font-size: 9.5pt; }
  .grid .row { display: flex; justify-content: space-between; border-bottom: 1px dotted #DDE3EC; padding: 2px 0; }
  .grid .k { color: #5C6E8C; text-transform: uppercase; font-size: 8pt; letter-spacing: 0.04em; }
  .grid .v { color: #12284C; font-weight: 600; text-align: right; }
  table { width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; font-size: 9pt; margin-top: 4px; }
  th { background: #EEF1FE; color: #12284C; text-align: left; padding: 5px 7px; border: 1px solid #C6CFFA; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.03em; }
  td { padding: 5px 7px; border: 1px solid #DDE3EC; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  p.legal { white-space: pre-wrap; text-align: justify; }
  ol.clauses { padding-left: 18px; margin: 4px 0; } ol.clauses li { margin-bottom: 7px; text-align: justify; }
  ul.plain { padding-left: 18px; margin: 4px 0; }
  .ph { color: #9AA8BF; font-style: italic; }
  .sub { color: #5C6E8C; font-size: 8pt; }
  .disclaimer { font-family: Arial, sans-serif; font-size: 7.5pt; color: #5C6E8C; line-height: 1.45; border-top: 1px solid #DDE3EC; margin-top: 22px; padding-top: 8px; text-align: justify; }
  footer { font-family: Arial, sans-serif; font-size: 7.5pt; color: #9AA8BF; display: flex; justify-content: space-between; margin-top: 10px; border-top: 1px solid #DDE3EC; padding-top: 6px; }
</style></head><body><div class="wrap">
  <header>
    <div>${LOGO_HTML}</div>
    <div class="doc-title"><h1>Title Commitment &amp; Search Report</h1>
      <div class="meta">Order ${esc(order.id)} &nbsp;·&nbsp; ${esc(m.productType || order.type || '')}<br>Prepared ${esc(genAt)}</div></div>
  </header>

  <h2>Search Information</h2>
  <div class="grid">
    <div class="row"><span class="k">Client Order No.</span><span class="v">${val(m.clientOrderNo || order.id)}</span></div>
    <div class="row"><span class="k">Product Type</span><span class="v">${val(m.productType || order.type)}</span></div>
    <div class="row"><span class="k">Property Address</span><span class="v">${val(m.address)}</span></div>
    <div class="row"><span class="k">State &amp; County</span><span class="v">${val((m.county || '') + ', ' + (m.state || ''))}</span></div>
    <div class="row"><span class="k">Search Date</span><span class="v">${m.searchDate ? fmtDate(m.searchDate) : '<span class=ph>—</span>'}</span></div>
    <div class="row"><span class="k">Effective Date</span><span class="v">${f.searchEffectiveAt ? esc(fmtDateTime(f.searchEffectiveAt)) : '<span class=ph>—</span>'}</span></div>
    <div class="row"><span class="k">Record Owner</span><span class="v">${val(m.recordOwner)}</span></div>
    <div class="row"><span class="k">Estate Type</span><span class="v">${val(f.estateType)}</span></div>
    <div class="row"><span class="k">Parcel ID(s)</span><span class="v">${val((f.parcels || []).map(p => p.value).filter(Boolean).join('; '))}</span></div>
  </div>

  <h2>Title Vesting</h2>
  <p class="legal">${vest ? esc(vest) : '<span class="ph">Not provided.</span>'}</p>

  <h2>Deeds — Vesting &amp; Chain of Title</h2>
  <table><thead><tr><th>Deed</th><th>Grantor</th><th>Grantee</th><th class="num">Dated</th><th class="num">Recorded</th><th class="num">Rec Info</th></tr></thead>
    <tbody>${deedRows(f.deeds) || '<tr><td colspan="6" class="ph">No deeds recorded.</td></tr>'}</tbody></table>

  <h2>Legal Description</h2>
  <p class="legal">${f.legalDescription ? esc(f.legalDescription) : '<span class="ph">Not provided.</span>'}</p>

  ${hasTax ? `<h2>Assessment &amp; Tax Information</h2><div class="grid">
    <div class="row"><span class="k">Assessed Land</span><span class="v">${val(tax.assessedLand)}</span></div>
    <div class="row"><span class="k">Assessed Building</span><span class="v">${val(tax.assessedBuilding)}</span></div>
    <div class="row"><span class="k">Total Assessed</span><span class="v">${val(tax.totalAssessed)}</span></div>
    <div class="row"><span class="k">Tax Year</span><span class="v">${val(tax.taxYear)}</span></div>
    <div class="row"><span class="k">Status</span><span class="v">${val(tax.status)}</span></div>
    <div class="row"><span class="k">1st Half</span><span class="v">${val(tax.firstHalfAmount)}</span></div>
    <div class="row"><span class="k">2nd Half</span><span class="v">${val(tax.secondHalfAmount)}</span></div></div>` : ''}

  <h2>Schedule B-I — Requirements</h2>
  ${listBlock(f.requirements, requirementText)}

  <h2>Schedule B-II — Exceptions</h2>
  ${listBlock(f.exceptions, exceptionText)}

  ${judgmentRows(f.judgments)}

  <h2>Names Searched</h2>${lines(f.namesSearched)}
  <h2>Additional Information</h2>${lines(f.additionalInfo)}

  <div class="disclaimer">${esc(f.disclaimer || '').replace(/\n/g, '<br>')}</div>
  <footer><span>Resolute Title Services · Confidential</span><span>${esc(order.id)} · Generated ${esc(genAt)}</span></footer>
</div></body></html>`
}

// Modal preview with Print (→ Save as PDF) and Download (.doc). Pulls the
// fulfillment from the shared store, so Admin / Delivery / Typer can all open it.
export function CommitmentDocumentModal({ order, onClose }) {
  const { byOrder, ensure } = useFulfillmentStore()
  const frameRef = useRef(null)
  useEffect(() => { ensure(order) }, [order, ensure])
  const f = byOrder[order.id]
  const html = useMemo(() => (f ? buildCommitmentHtml(order, f) : null), [order, f])

  const print = () => frameRef.current?.contentWindow?.print()
  // BUG_011: clients must receive PDF, never Word. Download is a real vector
  // PDF (selectable text) built from the same fulfillment data as the preview.
  const [saving, setSaving] = useState(false)
  const download = async () => {
    if (!f || saving) return
    setSaving(true)
    try { await downloadCommitmentPdf(order, f) }
    catch (err) { console.error('[commitment pdf]', err); window.alert('Could not generate the PDF. Please try again.') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col" style={{ background: 'rgba(12,29,56,0.55)' }} onClick={onClose}>
      <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{ background: '#ffffff', borderBottom: '1px solid #DDE3EC' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4" style={{ color: '#2441E5' }} />
          <span className="text-sm font-semibold" style={{ color: '#12284C' }}>Commitment Document · {order.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={download} disabled={!f || saving}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium"
            style={{ color: '#33465F', border: '1px solid #DDE3EC', background: '#fff', opacity: (f && !saving) ? 1 : 0.5 }}>
            <Download className="w-4 h-4" /> {saving ? 'Generating…' : 'Download PDF'}
          </button>
          <button onClick={print} disabled={!html}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-white"
            style={{ background: '#2441E5', opacity: html ? 1 : 0.5 }}>
            <Printer className="w-4 h-4" /> Print / Save as PDF
          </button>
          <button onClick={onClose} className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ color: '#5C6E8C', border: '1px solid #DDE3EC', background: '#fff' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden p-4" onClick={e => e.stopPropagation()}>
        {html
          ? <iframe ref={frameRef} title="Commitment Document" srcDoc={html}
              className="w-full h-full rounded-lg" style={{ background: '#fff', border: '1px solid #DDE3EC' }} />
          : <div className="h-full flex items-center justify-center text-sm" style={{ color: '#5C6E8C' }}>Loading document…</div>}
      </div>
    </div>
  )
}
