import { commitmentDocDefinition } from '../src/lib/commitmentPdf.js'
import { makeDefaultFulfillment, makeDeed, makeJudgment, makeTax, uid } from '../src/data/fulfillment.js'
import { buildCommitmentHtml } from '../src/components/CommitmentDocument.jsx'
import pdfMake from 'pdfmake/build/pdfmake'
import * as vfs from 'pdfmake/build/vfs_fonts'

pdfMake.vfs = vfs.default || vfs.vfs || vfs

const ORDER = { id: 'RTS-AUDIT-1', type: 'Full Search', county: 'Broward', state: 'FL' }

// ---- FULL fulfillment: every field populated with a findable marker --------
function full() {
  const f = makeDefaultFulfillment(ORDER)
  f.meta.address = 'ADDR-MARK-100 Ocean Drive'
  f.meta.recordOwner = 'OWNER-MARK-Alice Vesting'
  f.meta.searchDate = '2026-08-01'
  f.meta.productType = 'PRODUCT-MARK-Full Search'
  f.meta.clientOrderNo = 'CLIENTORD-MARK-77'
  f.searchEffectiveAt = '2026-08-02T15:30:00.000Z'
  f.estateType = 'ESTATE-MARK-Fee Simple'
  f.parcels = [{ id: uid(), value: 'PARCEL-AAA-111' }, { id: uid(), value: 'PARCEL-BBB-222' }]
  f.legalDescription = 'LEGAL-MARK Lot 7, Block 3, of AUDIT SUBDIVISION, per plat book 99 page 12.'
  f.titleVesting = { text: 'VESTING-BBB-222 Title vests in Alice Vesting by warranty deed.', isAuto: false, autoText: '' }
  const d1 = makeDeed(); Object.assign(d1, { deedType: 'Warranty Deed', grantor: 'GRANTOR-ONE-Smith', grantee: 'GRANTEE-ONE-Alice', dateOfDeed: '2020-03-04', recordedDate: '2020-03-10', book: 'BK101', page: 'PG202' })
  const d2 = makeDeed(); Object.assign(d2, { deedType: 'Quitclaim Deed', grantor: 'GRANTOR-TWO-Jones', grantee: 'GRANTEE-TWO-Smith', dateOfDeed: '2015-06-01', recordedDate: '2015-06-08', book: 'BK55', page: 'PG66' })
  f.deeds = [d1, d2]
  const t = makeTax(); Object.assign(t, { assessedLand: 'TAXLAND-11000', assessedBuilding: 'TAXBLDG-22000', totalAssessed: 'TAXTOTAL-33000', taxYear: 'TAXYEAR-2025', status: 'TAXSTATUS-Paid', firstHalfAmount: 'TAXH1-500', secondHalfAmount: 'TAXH2-600' })
  f.tax = t
  const j1 = makeJudgment(); Object.assign(j1, { instrumentName: 'JUDG-ONE-Lien', caseNo: 'CASE-111', filedOn: '2021-01-05', recDate: '2021-01-09', book: 'JBK1', page: 'JPG1', amount: '4321.00' })
  const j2 = makeJudgment(); Object.assign(j2, { instrumentName: 'JUDG-TWO-Mortgage', caseNo: 'CASE-222', filedOn: '2022-02-06', recDate: '2022-02-10', book: 'JBK2', page: 'JPG2', amount: '8765.00' })
  f.judgments = [j1, j2]
  f.namesSearched = [{ id: uid(), value: 'NAMESEARCH-ONE-Alice Vesting' }, { id: uid(), value: 'NAMESEARCH-TWO-Bob Smith' }]
  f.additionalInfo = [{ id: uid(), value: 'ADDINFO-ONE-No open permits found' }]
  // customer charges the typer entered
  f.invoice = {
    services: [{ id: uid(), type: 'CHARGE-SERVICE-Full Search', costPerUnit: 123.45, units: 1, locked: true }],
    additionalCosts: [
      { id: uid(), type: 'CHARGE-COPY-Copy Costs', costPerUnit: 67.89, units: 2 },
      { id: uid(), type: 'CHARGE-DISCOUNT', costPerUnit: 10, units: 1, discount: true },
    ],
    chargeOnCancel: false,
  }
  return f
}

// ---- SPARSE fulfillment: nothing filled in --------------------------------
function sparse() {
  const f = makeDefaultFulfillment(ORDER)
  f.requirements = []; f.exceptions = []
  f.namesSearched = [{ id: uid(), value: '' }]
  f.additionalInfo = [{ id: uid(), value: '' }]
  f.parcels = [{ id: uid(), value: '' }]
  f.disclaimer = ''
  return f
}
function bare() { return {} }
// An UNTOUCHED fulfillment: exactly what the form seeds, nothing typed. This is
// the state that printed ‹mortgagor›/‹no plat maps added› into the client's
// document and a deeds table of pure em-dashes.
function untouched() { return makeDefaultFulfillment(ORDER) }

const gen = (order, f) => new Promise((res, rej) => {
  try { pdfMake.createPdf(commitmentDocDefinition(order, f)).getBase64(res) } catch (e) { rej(e) }
})

// Walk the docDefinition and dump every text node IN ORDER — proves section order.
function dumpText(node, out = [], depth = 0) {
  if (node == null) return out
  if (typeof node === 'string' || typeof node === 'number') { const s = String(node).trim(); if (s) out.push(s); return out }
  if (Array.isArray(node)) { node.forEach(n => dumpText(n, out, depth)); return out }
  if (typeof node === 'object') {
    if (node.svg) { out.push('[SVG LOGO]'); return out }
    if (node.canvas) { out.push('[HR LINE]'); return out }
    for (const key of ['text', 'stack', 'columns', 'ol', 'ul', 'table', 'body', 'content']) {
      if (key in node) dumpText(node[key], out, depth + 1)
    }
  }
  return out
}

window.__audit = async () => {
  const F = full(), S = sparse()
  const res = {}
  res.fullDef  = dumpText(commitmentDocDefinition(ORDER, F))
  res.sparseDef = dumpText(commitmentDocDefinition(ORDER, S))
  res.fullPdf  = await gen(ORDER, F)
  res.sparsePdf = await gen(ORDER, S)
  try { res.bareDef = dumpText(commitmentDocDefinition(ORDER, bare())); res.bareErr = null }
  catch (e) { res.bareDef = null; res.bareErr = String(e && e.message || e) }
  try { res.barePdf = await gen(ORDER, bare()) } catch (e) { res.barePdf = null; res.barePdfErr = String(e && e.message || e) }
  // Does the doc definition reference the invoice at all?
  res.invoiceMentioned = JSON.stringify(commitmentDocDefinition(ORDER, F)).includes('CHARGE-')

  const U = untouched()
  res.untouchedDef = dumpText(commitmentDocDefinition(ORDER, U))
  res.untouchedPdf = await gen(ORDER, U)
  res.untouchedHtml = buildCommitmentHtml(ORDER, U)
  res.fullHtml = buildCommitmentHtml(ORDER, F)
  return res
}
