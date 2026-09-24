import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { UploadCloud, FileSpreadsheet, CheckCircle, AlertCircle, Download, Trash2, Loader2, ArrowRight } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { stateCode, stateName, clientName } from '../../data/mockData'

const ACCENT = '#2441E5'

// Spreadsheet columns we understand. Header matching is tolerant of case and
// punctuation (see `norm`), so "Property State", "state", "STATE" all map to state.
const COLUMNS = [
  { key: 'state',        label: 'State',         required: true,  example: 'FL' },
  { key: 'county',       label: 'County',        required: true,  example: 'Miami-Dade' },
  { key: 'address',      label: 'Address',       required: false, example: '123 Main St' },
  { key: 'city',         label: 'City',          required: false, example: 'Miami' },
  { key: 'zip',          label: 'ZIP',           required: false, example: '33101' },
  { key: 'parcel',       label: 'Parcel / APN',  required: false, example: '14-25-376-012' },
  { key: 'searchType',   label: 'Search Type',   required: false, example: 'Full Search' },
  { key: 'propertyType', label: 'Property Type', required: false, example: 'Residential' },
  { key: 'buyer',        label: 'Buyer',         required: false, example: 'Jane Doe' },
  { key: 'seller',       label: 'Seller',        required: false, example: 'John Roe' },
  { key: 'clientFileNo', label: 'Your file #',   required: false, example: 'ABC-2291' },
  { key: 'notes',        label: 'Notes',         required: false, example: '' },
]

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
// Accepted header spellings → canonical field key.
const HEADER_MAP = {
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
  clientfile: 'clientFileNo', clientfileno: 'clientFileNo', fileno: 'clientFileNo', file: 'clientFileNo', yourfile: 'clientFileNo',
  notes: 'notes', specialinstructions: 'notes', instructions: 'notes',
}

// Validity per row: State must resolve to a 2-letter code, County must be present.
const rowErrors = (r) => {
  const errs = []
  if (!r.state || !/^[A-Z]{2}$/.test(stateCode(r.state))) errs.push('state')
  if (!String(r.county || '').trim()) errs.push('county')
  return errs
}

export default function BulkImport() {
  const { user } = useAuth()
  const { createOrder } = useOrders()
  const [rows, setRows] = useState(null)      // parsed rows (or null before upload)
  const [fileName, setFileName] = useState('')
  const [parseErr, setParseErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState(null)  // { created:[ids], failed:[{row,error}] }
  const [drag, setDrag] = useState(false)

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

  const valid = (rows || []).filter(r => !r._errors.length)

  const createAll = async () => {
    if (busy || !valid.length) return
    setBusy(true); setProgress(0)
    const created = [], failed = []
    for (let i = 0; i < valid.length; i++) {
      const r = valid[i]
      try {
        const parties = [
          ...(r.buyer ? [{ role: 'Buyer', name: r.buyer }] : []),
          ...(r.seller ? [{ role: 'Seller', name: r.seller }] : []),
        ]
        const order = await createOrder({
          state: stateCode(r.state), county: r.county,
          type: r.searchType || 'Full Search',
          clientFileNo: r.clientFileNo || null,
          clientCode: user?.clientCode || null,
          client: clientName(user?.clientCode) || user?.name || 'Web Order',
          intake: {
            source: 'web-bulk',
            propertyAddress: [r.address, r.city, stateName(r.state), r.zip].filter(Boolean).join(', '),
            parcelNumberAPN: r.parcel || '', propertyType: r.propertyType || null,
            buyer: r.buyer || '', seller: r.seller || '', parties,
            orderType: r.searchType || 'Full Search',
            from: `${user?.name || ''} <${user?.email || ''}>`.trim(),
            specialInstructions: r.notes || '',
          },
        })
        created.push(order.id)
      } catch (e) {
        failed.push({ row: i + 1, error: e?.message || 'failed' })
      }
      setProgress(i + 1)
    }
    setResult({ created, failed })
    setBusy(false)
  }

  // ── Result screen ──
  if (result) return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-6 text-center">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(0,184,217,0.18)' }}>
        <CheckCircle className="w-8 h-8" style={{ color: '#15803d' }} />
      </div>
      <h2 className="text-xl font-bold mb-1" style={{ color: '#12284C' }}>{result.created.length} order{result.created.length === 1 ? '' : 's'} placed</h2>
      {result.failed.length > 0 && (
        <p className="text-sm mb-3" style={{ color: '#dc2626' }}>{result.failed.length} row{result.failed.length === 1 ? '' : 's'} could not be created.</p>
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
          <p className="text-sm" style={{ color: '#5C6E8C' }}>Upload a spreadsheet of properties — one order is created per row.</p>
        </div>
        <button type="button" onClick={downloadTemplate} className="text-xs font-semibold flex items-center gap-1.5 flex-shrink-0" style={{ color: ACCENT }}>
          <Download className="w-3.5 h-3.5" /> Template
        </button>
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
          <div className="text-[11px] mt-0.5" style={{ color: '#5C6E8C' }}>Excel (.xlsx) or CSV · State &amp; County required per row</div>
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
            <span style={{ color: '#5C6E8C' }}>· {rows.length} row{rows.length === 1 ? '' : 's'} · {valid.length} ready{rows.length - valid.length ? ` · ${rows.length - valid.length} with issues` : ''}</span>
            <button type="button" onClick={() => { setRows(null); setFileName('') }} className="ml-auto text-xs" style={{ color: '#5C6E8C' }}>Clear</button>
          </div>
          <div className="overflow-auto rounded-xl border" style={{ borderColor: 'rgba(18,40,76,0.10)', maxHeight: 320 }}>
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ background: 'rgba(18,40,76,0.04)' }}>
                  <th className="px-2 py-1.5 text-left" style={{ color: '#5C6E8C' }}>#</th>
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
                    <td className="px-2 py-1.5" style={{ color: r._errors.includes('state') ? '#dc2626' : '#12284C' }}>{r.state || '—'}</td>
                    <td className="px-2 py-1.5" style={{ color: r._errors.includes('county') ? '#dc2626' : '#12284C' }}>{r.county || '—'}</td>
                    <td className="px-2 py-1.5" style={{ color: '#3D5171' }}>{r.searchType || 'Full Search'}</td>
                    <td className="px-2 py-1.5 truncate" style={{ color: '#5C6E8C', maxWidth: 200 }}>{[r.address, r.city].filter(Boolean).join(', ') || '—'}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button type="button" onClick={() => removeRow(i)} title="Remove row" style={{ color: '#dc2626' }}><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length - valid.length > 0 && (
            <div className="flex items-center gap-2 text-[12px]" style={{ color: '#b45309' }}>
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> Rows missing a valid State or County are highlighted and will be skipped.
            </div>
          )}
          <button type="button" onClick={createAll} disabled={busy || !valid.length}
            className="btn-primary w-full flex items-center justify-center gap-2" style={{ opacity: (busy || !valid.length) ? 0.6 : 1 }}>
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating {progress}/{valid.length}…</>
              : <>Create {valid.length} order{valid.length === 1 ? '' : 's'} <ArrowRight className="w-4 h-4" /></>}
          </button>
        </>
      )}
    </div>
  )
}
