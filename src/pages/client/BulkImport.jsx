import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { UploadCloud, FileSpreadsheet, CheckCircle, AlertCircle, Download, Trash2, Loader2, ArrowRight } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { stateCode, stateName, clientName, US_STATES } from '../../data/mockData'

const VALID_STATE_CODES = new Set(US_STATES.map(s => s.code))

const ACCENT = '#2441E5'

// Spreadsheet columns we understand, in template order. Header matching is
// tolerant of case and punctuation (see `norm`), so "Property State", "state",
// "STATE" all map to state.
const COLUMNS = [
  { key: 'groupId',      label: 'Group ID',      required: false, example: 'A' },
  { key: 'businessName', label: 'Business Name', required: false, example: 'Acme Title LLC' },
  { key: 'clientFileNo', label: 'Your File #',   required: false, example: 'ABC-2291' },
  { key: 'searchType',   label: 'Search Type',   required: true,  example: 'Full Search' },
  { key: 'propertyType', label: 'Property Type', required: false, example: 'Residential' },
  { key: 'state',        label: 'State',         required: true,  example: 'FL' },
  { key: 'county',       label: 'County',        required: true,  example: 'Miami-Dade' },
  { key: 'address',      label: 'Address',       required: false, example: '123 Main St' },
  { key: 'city',         label: 'City',          required: false, example: 'Miami' },
  { key: 'zip',          label: 'ZIP',           required: false, example: '33101' },
  { key: 'parcel',       label: 'Parcel / APN',  required: false, example: '14-25-376-012' },
  { key: 'buyer',        label: 'Buyer',         required: false, example: 'Jane Doe' },
  { key: 'seller',       label: 'Seller',        required: false, example: 'John Roe' },
  { key: 'borrower',     label: 'Borrower',      required: false, example: 'Sam Lee' },
  { key: 'priority',     label: 'Priority',      required: false, example: 'Normal' },
  { key: 'notes',        label: 'Notes',         required: false, example: 'Include HOA documents' },
]

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
// Accepted header spellings → canonical field key.
const HEADER_MAP = {
  groupid: 'groupId', group: 'groupId',
  businessname: 'businessName', business: 'businessName', company: 'businessName', companyname: 'businessName',
  state: 'state', propertystate: 'state',
  county: 'county',
  address: 'address', propertyaddress: 'address', street: 'address',
  city: 'city',
  zip: 'zip', zipcode: 'zip', postalcode: 'zip',
  parcel: 'parcel', parcelapn: 'parcel', apn: 'parcel', parcelnumber: 'parcel',
  searchtype: 'searchType', product: 'searchType', searchproduct: 'searchType',
  propertytype: 'propertyType',
  buyer: 'buyer', buyername: 'buyer',
  seller: 'seller', sellername: 'seller',
  borrower: 'borrower', borrowername: 'borrower',
  clientfile: 'clientFileNo', clientfileno: 'clientFileNo', fileno: 'clientFileNo', file: 'clientFileNo', yourfile: 'clientFileNo', yourfileno: 'clientFileNo',
  priority: 'priority',
  notes: 'notes', specialinstructions: 'notes', instructions: 'notes',
}

// Validity per row: Search Type must be present, State must resolve to a
// 2-letter code, County must be present.
const rowErrors = (r) => {
  const errs = []
  if (!String(r.searchType || '').trim()) errs.push('searchType')
  // Must resolve to a REAL state (stateCode passes unknown input through, so
  // check membership — 'ZZ' is not a state).
  if (!VALID_STATE_CODES.has(stateCode(r.state))) errs.push('state')
  if (!String(r.county || '').trim()) errs.push('county')
  return errs
}

// Blank or "Normal" → normal; "Rush" → rush (case/punctuation-insensitive).
const priorityOf = (r) => (norm(r.priority) === 'rush' ? 'rush' : 'normal')

// Creation units — one per order to create — from the valid rows ({ r, srcRow }).
// Separate: one unit per row. Combine: rows with the same non-empty trimmed
// Group ID share one unit (placed where the group first appears); a blank
// Group ID is always its own unit.
const unitsFor = (validRows, mode) => {
  if (mode !== 'combine') return validRows.map(x => ({ group: null, rows: [x] }))
  const units = [], byGroup = new Map()
  for (const x of validRows) {
    const g = String(x.r.groupId || '').trim()
    if (!g) { units.push({ group: null, rows: [x] }); continue }
    if (!byGroup.has(g)) { const u = { group: g, rows: [] }; byGroup.set(g, u); units.push(u) }
    byGroup.get(g).rows.push(x)
  }
  return units
}

export default function BulkImport() {
  const { user } = useAuth()
  const { createOrder } = useOrders()
  const [rows, setRows] = useState(null)      // parsed rows (or null before upload)
  const [fileName, setFileName] = useState('')
  const [parseErr, setParseErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState(null)  // { created:[ids], failed:[{group,rows,error}], skipped }
  const [drag, setDrag] = useState(false)
  const [mode, setMode] = useState('separate')   // 'separate' | 'combine'

  const parse = async (file) => {
    setParseErr(''); setResult(null); setRows(null); setFileName(file?.name || '')
    if (!file) return
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) { setParseErr('Upload a .xlsx, .xls, or .csv file.'); return }
    try {
      const XLSX = await import('xlsx')     // ~lazy: only pulled when someone imports
      const buf = new Uint8Array(await file.arrayBuffer())
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const raw = XLSX.utils.sheet_to_json(ws, { defval: '' })
      if (!raw.length) { setParseErr('That sheet has no data rows.'); return }
      const mapped = raw.map((o) => {
        const row = {}
        for (const [k, v] of Object.entries(o)) {
          const field = HEADER_MAP[norm(k)]
          if (field) row[field] = String(v).trim()
        }
        row._errors = rowErrors(row)
        return row
      })
      setRows(mapped)
    } catch (e) {
      console.error('[bulkImport]', e?.message || e)
      setParseErr('We couldn’t read that file. Make sure it’s a valid spreadsheet with a header row.')
    }
  }

  const removeRow = (i) => setRows(rs => rs.filter((_, idx) => idx !== i))

  const downloadTemplate = () => {
    const header = COLUMNS.map(c => c.label).join(',')
    const example = COLUMNS.map(c => c.example).join(',')
    const blob = new Blob([`${header}\n${example}\n`], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'resolute-bulk-orders-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  // Valid rows keep their preview row number for failure reporting. The units
  // (orders to create) derive from them and the mode, so removing a row or
  // switching mode re-plans the counts automatically.
  const validRows = (rows || []).map((r, idx) => ({ r, srcRow: idx + 1 })).filter(x => !x.r._errors.length)
  const units = unitsFor(validRows, mode)
  const hasGroups = (rows || []).some(r => r.groupId)

  // One createOrder payload per unit. The unit's first valid row carries every
  // order-level field (so existing order views read as before); a multi-row
  // unit also lists each grouped row's property on intake.properties.
  const orderPayload = ({ rows: unitRows }) => {
    const { r } = unitRows[0]
    // Display/intake only — identity stays the signed-in client's clientCode.
    const business = r.businessName || clientName(user?.clientCode) || user?.name || 'Web Order'
    const parties = [
      ...(r.buyer ? [{ role: 'Buyer', name: r.buyer }] : []),
      ...(r.seller ? [{ role: 'Seller', name: r.seller }] : []),
      ...(r.borrower ? [{ role: 'Borrower', name: r.borrower }] : []),
    ]
    return {
      state: stateCode(r.state), county: r.county,
      type: r.searchType,
      priority: priorityOf(r),
      clientFileNo: r.clientFileNo || null,
      clientCode: user?.clientCode || null,
      client: business,
      intake: {
        source: 'web-bulk',
        propertyAddress: [r.address, r.city, stateName(r.state), r.zip].filter(Boolean).join(', '),
        parcelNumberAPN: r.parcel || '', propertyType: r.propertyType || null,
        buyer: r.buyer || '', seller: r.seller || '', borrowerName: r.borrower || '', parties,
        orderType: r.searchType,
        from: `${user?.name || ''} <${user?.email || ''}>`.trim(),
        company: business,
        specialInstructions: r.notes || '',
        // PropertyItem (packages/domain pipeline.ts) per grouped row.
        ...(unitRows.length > 1 && {
          properties: unitRows.map(({ r: p }) => ({
            address: p.address || '', city: p.city || '', state: stateCode(p.state),
            county: p.county || '', zip: p.zip || '', parcelId: p.parcel || '',
          })),
        }),
      },
    }
  }

  const createAll = async () => {
    if (busy || !units.length) return
    setBusy(true); setProgress(0)
    const created = [], failed = []
    for (let i = 0; i < units.length; i++) {
      const unit = units[i]
      try {
        const order = await createOrder(orderPayload(unit))
        created.push(order.id)
      } catch (e) {
        failed.push({ group: unit.group, rows: unit.rows.map(x => x.srcRow), error: e?.message || 'failed' })
      }
      setProgress(i + 1)
    }
    setResult({ created, failed, skipped: (rows || []).length - validRows.length })
    setBusy(false)
  }

  // ── Result screen ──
  if (result) return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-6 text-center">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(0,184,217,0.18)' }}>
        <CheckCircle className="w-8 h-8" style={{ color: '#15803d' }} />
      </div>
      <h2 className="text-xl font-bold mb-1" style={{ color: '#12284C' }}>{result.created.length} order{result.created.length === 1 ? '' : 's'} placed</h2>
      {result.skipped > 0 && (
        <p className="text-sm" style={{ color: '#b45309' }}>{result.skipped} row{result.skipped === 1 ? '' : 's'} skipped (missing a Search Type, a valid State, or a County).</p>
      )}
      {result.failed.length > 0 && (
        <p className="text-sm mb-1" style={{ color: '#dc2626' }}>{result.failed.length} order{result.failed.length === 1 ? '' : 's'} could not be created ({result.failed.map(f => f.group ? `group ${f.group}: rows ${f.rows.join(', ')}` : `row ${f.rows[0]}`).join('; ')}).</p>
      )}
      <div className="text-[12px] font-mono mt-3 max-h-40 overflow-auto" style={{ color: ACCENT }}>{result.created.join(' · ')}</div>
      <button onClick={() => { setRows(null); setResult(null); setFileName('') }} className="btn-primary mt-5">Import another file</button>
    </motion.div>
  )

  return (
    <div className="glass-card p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: '#12284C' }}>Bulk import</h2>
          <p className="text-sm" style={{ color: '#5C6E8C' }}>Upload a spreadsheet of properties, then choose how rows become orders.</p>
        </div>
        <button type="button" onClick={downloadTemplate} className="text-xs font-semibold flex items-center gap-1.5 flex-shrink-0" style={{ color: ACCENT }}>
          <Download className="w-3.5 h-3.5" /> Template
        </button>
      </div>

      {/* Import mode — how valid rows become orders */}
      <div className="space-y-1.5">
        <div className="inline-flex p-1 rounded-xl" style={{ background: 'rgba(18,40,76,0.05)' }}>
          {[['separate', 'Separate orders'], ['combine', 'Combine into one order']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setMode(k)} disabled={busy} aria-pressed={mode === k}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={mode === k ? { background: '#fff', color: '#12284C', boxShadow: '0 1px 2px rgba(18,40,76,0.10)' } : { color: '#5C6E8C' }}>
              {l}
            </button>
          ))}
        </div>
        <p className="text-[11px]" style={{ color: '#5C6E8C' }}>
          {mode === 'combine'
            ? 'Rows that share a Group ID become one order covering all of their properties. Rows with no Group ID stay separate orders.'
            : 'Each valid row becomes its own order.'}
        </p>
      </div>

      {!rows && (
        <div role="button" tabIndex={0}
          onClick={() => document.getElementById('bulk-file')?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('bulk-file')?.click() } }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); parse(e.dataTransfer.files?.[0]) }}
          className="rounded-xl flex flex-col items-center justify-center py-8 px-4 cursor-pointer transition-all"
          style={{ border: `1.5px dashed ${drag ? ACCENT : 'rgba(36,65,229,0.30)'}`, background: drag ? `${ACCENT}10` : 'transparent' }}>
          <UploadCloud className="w-7 h-7 mb-2" style={{ color: drag ? ACCENT : '#5C6E8C' }} />
          <div className="text-sm font-medium" style={{ color: '#12284C' }}>Drag &amp; drop or <span style={{ color: ACCENT }}>browse</span></div>
          <div className="text-[11px] mt-0.5" style={{ color: '#5C6E8C' }}>Excel (.xlsx) or CSV · Search Type, State &amp; County required per row</div>
          <input id="bulk-file" type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={e => { parse(e.target.files?.[0]); e.target.value = '' }} />
        </div>
      )}

      {parseErr && <div className="flex items-center gap-2 text-sm" style={{ color: '#dc2626' }}><AlertCircle className="w-4 h-4" /> {parseErr}</div>}

      {rows && (
        <>
          <div className="flex items-center gap-2 text-sm" style={{ color: '#3D5171' }}>
            <FileSpreadsheet className="w-4 h-4" style={{ color: ACCENT }} />
            <span className="font-medium">{fileName}</span>
            <span style={{ color: '#5C6E8C' }}>· {rows.length} row{rows.length === 1 ? '' : 's'} · {validRows.length} ready{rows.length - validRows.length ? ` · ${rows.length - validRows.length} with issues` : ''} · {units.length} order{units.length === 1 ? '' : 's'} to create</span>
            <button type="button" onClick={() => { setRows(null); setFileName('') }} className="ml-auto text-xs" style={{ color: '#5C6E8C' }}>Clear</button>
          </div>
          <div className="overflow-auto rounded-xl border" style={{ borderColor: 'rgba(18,40,76,0.10)', maxHeight: 320 }}>
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ background: 'rgba(18,40,76,0.04)' }}>
                  <th className="px-2 py-1.5 text-left" style={{ color: '#5C6E8C' }}>#</th>
                  {hasGroups && <th className="px-2 py-1.5 text-left" style={{ color: '#5C6E8C' }}>Group</th>}
                  <th className="px-2 py-1.5 text-left" style={{ color: '#5C6E8C' }}>State</th>
                  <th className="px-2 py-1.5 text-left" style={{ color: '#5C6E8C' }}>County</th>
                  <th className="px-2 py-1.5 text-left" style={{ color: '#5C6E8C' }}>Search</th>
                  <th className="px-2 py-1.5 text-left" style={{ color: '#5C6E8C' }}>Address</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ background: r._errors.length ? 'rgba(220,60,60,0.06)' : '#fff', borderTop: '1px solid rgba(18,40,76,0.06)' }}>
                    <td className="px-2 py-1.5" style={{ color: '#9AA8BF' }}>{i + 1}</td>
                    {hasGroups && <td className="px-2 py-1.5 font-mono" style={{ color: '#3D5171' }}>{r.groupId || '—'}</td>}
                    <td className="px-2 py-1.5" style={{ color: r._errors.includes('state') ? '#dc2626' : '#12284C' }}>{r.state || '—'}</td>
                    <td className="px-2 py-1.5" style={{ color: r._errors.includes('county') ? '#dc2626' : '#12284C' }}>{r.county || '—'}</td>
                    <td className="px-2 py-1.5" style={{ color: r._errors.includes('searchType') ? '#dc2626' : '#3D5171' }}>{r.searchType || '—'}</td>
                    <td className="px-2 py-1.5 truncate" style={{ color: '#5C6E8C', maxWidth: 200 }}>{[r.address, r.city].filter(Boolean).join(', ') || '—'}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button type="button" onClick={() => removeRow(i)} disabled={busy} title="Remove row" style={{ color: '#dc2626' }}><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length - validRows.length > 0 && (
            <div className="flex items-center gap-2 text-[12px]" style={{ color: '#b45309' }}>
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> Rows missing a Search Type, a valid State, or a County are highlighted and will be skipped.
            </div>
          )}
          <button type="button" onClick={createAll} disabled={busy || !units.length}
            className="btn-primary w-full flex items-center justify-center gap-2" style={{ opacity: (busy || !units.length) ? 0.6 : 1 }}>
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating {progress}/{units.length}…</>
              : <>Create {units.length} order{units.length === 1 ? '' : 's'} <ArrowRight className="w-4 h-4" /></>}
          </button>
        </>
      )}
    </div>
  )
}
