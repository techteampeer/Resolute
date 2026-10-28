import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  PlusCircle, CheckCircle, Zap, Send, FileText,
  UploadCloud, Paperclip, Trash2, AlertCircle, Eye, ChevronLeft,
} from 'lucide-react'
import { US_STATES, stateName, clientName } from '../data/mockData'
import { PRODUCTS } from '../data/products'
import { fileKind, uid } from '../data/fulfillment'
import { isSupabaseConfigured, openDocument, uploadDocument } from '../lib/backend'
import { ROLE_COLOR } from '../lib/ui'
import { useClients, clientLabelOf } from '../lib/useClients'
import { useContacts } from '../lib/useContacts'
import { useOrders } from '../context/OrderContext'
import { useAuth } from '../context/AuthContext'
import BulkImport from '../pages/client/BulkImport'

// Shared order-intake wizard used by BOTH the client "Place a New Order" page
// and the Admin "Place an order" page, so the two forms can never drift apart.
// `mode` is the only difference:
//   • 'client' — the signed-in client places their own order; company is implicit
//     from the login, contact prefills from the profile, 4 steps, and a success
//     screen afterwards.
//   • 'admin'  — Admin places an order ON BEHALF OF a client; a leading "Client"
//     step selects the company (existing clients only, which also loads that
//     company's people directory), then the same 4 steps. On submit it lands on
//     the order so Admin can confirm, price and route it. Either way createOrder
//     parks a normal order in the initial Admin state — no special lifecycle.

const CLIENT_ATTACH_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,image/*'
const validAttach = (file) => /\.(pdf|docx?|jpe?g|png|tiff?)$/i.test(file.name || '')

// Drag-and-drop reference-document uploader (deed scans, prior policies, payoff
// letters). Exported so the client order-detail page can reuse it for the
// clarification upload. When an orderId + Supabase are present it uploads
// immediately; otherwise it stages the files in session for submit-time upload.
export function ClientAttach({ orderId = null, value = [], onChange, accent = ROLE_COLOR }) {
  const inputRef = React.useRef(null)
  const [err, setErr] = useState('')
  const [drag, setDrag] = useState(false)

  const add = async (list) => {
    const incoming = Array.from(list || [])
    if (!incoming.length) return
    if (incoming.some(f => !validAttach(f))) { setErr('PDF, Word, or image files only'); return }
    setErr('')
    for (const file of incoming) {
      const ref = { id: uid(), name: file.name, type: fileKind(file.name), status: 'staged', file, url: URL.createObjectURL(file) }
      if (orderId && isSupabaseConfigured) {
        ref.status = 'uploading'; delete ref.file
        onChange(v => [...v, ref])
        try { const { url, path } = await uploadDocument(orderId, file); onChange(v => v.map(x => x.id === ref.id ? { ...x, status: 'done', url, path } : x)) }
        catch { onChange(v => v.map(x => x.id === ref.id ? { ...x, status: 'error' } : x)) }
      } else {
        onChange(v => [...v, ref])
      }
    }
  }
  const remove = (id) => onChange(v => v.filter(x => x.id !== id))

  return (
    <div className="space-y-2">
      <div role="button" tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files) }}
        className="rounded-xl flex flex-col items-center justify-center py-5 px-4 cursor-pointer transition-all"
        style={{ border:`1.5px dashed ${drag ? accent : 'rgba(36,65,229,0.30)'}`, background: drag ? `${accent}10` : 'transparent' }}>
        <UploadCloud className="w-6 h-6 mb-1.5" style={{ color: drag ? accent : '#5C6E8C' }} />
        <div className="text-sm font-medium" style={{ color:'#12284C' }}>Drag &amp; drop or <span style={{ color:accent }}>browse</span></div>
        <div className="text-[11px] mt-0.5" style={{ color:'#5C6E8C' }}>PDF, Word, or image · up to 25 MB each</div>
        <input ref={inputRef} type="file" accept={CLIENT_ATTACH_ACCEPT} multiple className="hidden"
          onChange={e => { add(e.target.files); e.target.value = '' }} />
      </div>
      {err && <div className="flex items-center gap-1.5 text-[12px]" style={{ color:'#dc2626' }}><AlertCircle className="w-3.5 h-3.5" /> {err}</div>}
      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map(f => (
            <div key={f.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background:'#fff', border:'1px solid rgba(18,40,76,0.10)' }}>
              <FileText className="w-4 h-4 flex-shrink-0" style={{ color: f.type === 'pdf' ? '#dc2626' : f.type === 'word' ? '#2441E5' : '#5C6E8C' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color:'#12284C' }}>{f.name}</div>
                <div className="text-[10px]" style={{ color:'#5C6E8C' }}>
                  {f.status === 'uploading' ? 'Uploading…' : f.status === 'error' ? 'Upload failed' : f.status === 'staged' ? 'Ready to send' : 'Uploaded'}
                </div>
              </div>
              {(f.url || f.path) && f.status !== 'uploading' && (
                <button type="button" onClick={() => openDocument(f)} title="Preview" className="p-1" style={{ color:'#5C6E8C' }}><Eye className="w-4 h-4" /></button>
              )}
              <button type="button" onClick={() => remove(f.id)} title="Remove" className="p-1" style={{ color:'#dc2626' }}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const TURNAROUND = [
  { key:'normal', label:'Standard — 48 hrs', fee:0,  desc:'Delivered within 2 business days' },
  { key:'rush',   label:'Rush — 24 hrs',     fee:50, desc:'Priority processing, next business day' },
]

// County list per state, served from public/ (us-atlas, ~32 KB) and fetched once
// on demand so it never weighs down the initial bundle. Module-level cache keeps
// it across wizard remounts. Absent/failed load → the county field is a plain
// text input (still works), so it degrades gracefully offline.
let _countiesCache = null

const Field = ({ children }) => (
  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>{children}</label>
)
// Small accent dot for the admin "Placing for …" note (avoids another icon import).
const Building2Dot = () => <span aria-hidden style={{ width:6, height:6, borderRadius:999, background:ROLE_COLOR, flexShrink:0, marginTop:6 }} />

export default function OrderWizard({ mode = 'client' }) {
  const admin = mode === 'admin'
  const navigate = useNavigate()
  const { user } = useAuth()
  const { createOrder, updateOrder } = useOrders()
  // Admin picks WHICH client the order is for (existing clients only); the client
  // portal's wizard is always scoped to the signed-in client.
  const clients = useClients()
  const [adminClientCode, setAdminClientCode] = useState('')
  const activeClientCode = admin ? (adminClientCode || null) : (user?.clientCode || null)
  const companyName = admin ? (clientLabelOf(clients, adminClientCode) || '') : (clientName(user?.clientCode) || '')
  // Per-company people directory (#12): who is placing the order. Scoped to the
  // active client so admin only ever sees the selected company's people.
  const { contacts, save: savePlacer } = useContacts(activeClientCode)

  const [step, setStep] = useState(1)
  const [wizMode, setWizMode] = useState('single')   // client: 'single' | 'bulk'
  const [counties, setCounties] = useState(_countiesCache)
  useEffect(() => {
    if (_countiesCache) return
    fetch(`${import.meta.env.BASE_URL}us-counties.json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { _countiesCache = d; setCounties(d) } })
      .catch(() => {})
  }, [])
  const [createdId, setCreatedId] = useState(null)
  const [attachments, setAttachments] = useState([])
  const [busy, setBusy] = useState(false)

  // A fresh blank form. Client prefills contact from the signed-in profile; admin
  // starts blank (the placer is a person at the selected client company).
  const makeInitialForm = () => ({
    searchType:'', customSearch:'', state:'', county:'', address:'', city:'', zip:'', parcelId:'', clientFileNo:'',
    propertyType:'', propertyTypeOther:'',
    parties: [
      { id: uid(), role:'Buyer',  name:'' },
      { id: uid(), role:'Seller', name:'' },
    ],
    priority:'normal',
    contactName: admin ? '' : (user?.name || ''),
    email: admin ? '' : (user?.email || ''),
    phone:'', role:'', notes:'', marketingOptIn:false, placedById:'',
  })
  const [form, setForm] = useState(makeInitialForm)
  const [submitted, setSubmitted] = useState(false)
  const [stepErr, setStepErr] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const set = (k,v) => setForm(f => ({ ...f, [k]:v }))

  // Selecting a saved person fills their details; "Someone new" clears the pick.
  const pickContact = (id) => {
    const c = contacts.find(x => x.id === id)
    if (!c) { setForm(f => ({ ...f, placedById: '' })); return }
    setForm(f => ({ ...f, placedById: id, contactName: c.name, email: c.email || f.email,
      phone: c.phone || '', role: c.title || '', marketingOptIn: !!c.marketingOptIn }))
  }
  // Admin: choosing the client resets the placer (the directory is per-company).
  const pickClient = (code) => {
    setAdminClientCode(code)
    setForm(f => ({ ...f, placedById:'', contactName:'', email:'', phone:'', role:'', marketingOptIn:false }))
  }

  const addParty = (role = 'Buyer') => setForm(f => ({ ...f, parties: [...f.parties, { id: uid(), role, name:'' }] }))
  const setParty = (id, patch) => setForm(f => ({ ...f, parties: f.parties.map(p => p.id === id ? { ...p, ...patch } : p) }))
  const removeParty = (id) => setForm(f => ({ ...f, parties: f.parties.filter(p => p.id !== id) }))

  // Step model — admin inserts a leading "Client" step before the four content
  // steps, so `cs` (content step) is 1..4 for Property/Search/Contact/Review.
  const STEPS = admin
    ? ['Client','Property Info','Search Details','Contact','Review']
    : ['Property Info','Search Details','Contact','Review']
  const total = STEPS.length
  const cs = admin ? step - 1 : step

  const stepValid = (s) => {
    const c = admin ? s - 1 : s
    if (admin && s === 1) return !!adminClientCode
    if (c === 1) return !!(form.state.trim() && form.county.trim())
    if (c === 2) return !!(form.searchType.trim() || form.customSearch.trim())
    if (c === 3) return !!(form.contactName.trim() && /\S+@\S+\.\S+/.test(form.email))
    return true
  }
  const goNext = () => { if (!stepValid(step)) { setStepErr(true); return } setStepErr(false); setStep(s => s + 1) }

  const submit = async () => {
    if (busy) return
    if (admin && !adminClientCode) { setStep(1); setStepErr(true); return }
    setBusy(true)
    setSubmitErr('')
    try {
      const parties = form.parties.map(p => ({ role: p.role, name: (p.name || '').trim() })).filter(p => p.name)
      const namesByRole = (role) => parties.filter(p => p.role === role).map(p => p.name).join(', ')
      const buyer = namesByRole('Buyer'), seller = namesByRole('Seller'), borrower = namesByRole('Borrower')
      const propertyType = form.propertyType === 'Other' ? (form.propertyTypeOther.trim() || 'Other') : form.propertyType
      const customSearch = form.customSearch.trim()
      const type = form.searchType || customSearch || 'Full Search'
      const company = admin
        ? (companyName || 'Web Order')
        : (companyName || user?.name || 'Web Order')
      // Record WHO placed the order in the company directory (best-effort — never
      // block an order on it) and attach a snapshot to the intake.
      let placedBy = null
      try {
        const saved = await savePlacer({
          id: form.placedById || undefined,
          name: form.contactName.trim(), email: form.email.trim(),
          phone: form.phone.trim(), title: form.role.trim(),
          marketingOptIn: !!form.marketingOptIn, createdBy: admin ? (user?.name || 'Admin') : 'client',
        })
        if (saved) placedBy = { id: saved.id, name: saved.name, email: saved.email, title: saved.title }
      } catch { /* directory is best-effort */ }
      const order = await createOrder({
        state: form.state, county: form.county, type,
        priority: form.priority,
        clientFileNo: form.clientFileNo || null,
        clientCode: activeClientCode,
        client: company,
        intake: {
          source: 'web', propertyAddress: [form.address, form.city, stateName(form.state), form.zip].filter(Boolean).join(', '),
          parcelNumberAPN: form.parcelId, borrowerName: borrower, buyer, seller,
          parties, propertyType: propertyType || null, customSearch: customSearch || null,
          orderType: type, from: `${form.contactName} <${form.email}>`.trim(),
          company, role: form.role, specialInstructions: form.notes,
          placedBy, contactPhone: form.phone.trim() || null,
          ...(admin ? { placedByAdmin: user?.name || 'Admin' } : {}),
        },
      })
      // Upload staged reference docs now that we have an order id, then persist
      // the refs onto the order so they travel with it to every stage.
      if (attachments.length) {
        const clientDocs = []
        for (const a of attachments) {
          if (isSupabaseConfigured && a.file) {
            try { const { url, path } = await uploadDocument(order.id, a.file); clientDocs.push({ id: a.id, name: a.name, type: a.type, status: 'done', url, path }) }
            catch { clientDocs.push({ id: a.id, name: a.name, type: a.type, status: 'error' }) }
          } else {
            clientDocs.push({ id: a.id, name: a.name, type: a.type, status: 'done', url: a.url || null })
          }
        }
        updateOrder({ ...order, workflow: { ...order.workflow, clientDocs } })
      }
      // Admin lands on the order to confirm, price and set its stage plan; the
      // client sees a confirmation screen with their Resolute file number.
      if (admin) { navigate(`/admin/orders/${order.id}`); return }
      setCreatedId(order.id)
      setSubmitted(true)
    } catch (e) {
      console.error('[placeOrder]', e?.message || e)
      setSubmitErr('We couldn’t submit this order just now. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Demo is a read-only sandbox — client only (admin is never a demo login).
  if (!admin && user?.demo) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5" style={{ background:'rgba(36,65,229,0.14)' }}>
        <PlusCircle className="w-8 h-8" style={{ color:ROLE_COLOR }} />
      </div>
      <h2 className="text-xl font-bold mb-2" style={{ color:'#12284C' }}>Placing orders is disabled in the demo</h2>
      <p className="text-sm mb-6" style={{ color:'#3D5171' }}>
        You're exploring a read-only sandbox. Create a free account to place and track real title orders.
      </p>
      <button onClick={() => navigate('/client/orders')} className="btn-primary text-sm px-5 py-2.5">
        Browse the sample orders instead
      </button>
    </div>
  )

  if (submitted) return (
    <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }}
      className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6"
        style={{ background:'rgba(0,184,217,0.18)' }}>
        <CheckCircle className="w-10 h-10" style={{ color:'#15803d' }} />
      </div>
      <h2 className="text-2xl font-bold mb-2" style={{ color:'#12284C' }}>Order Submitted!</h2>
      <p className="text-sm mb-1" style={{ color:'#3D5171' }}>
        Resolute file # <span className="font-mono font-bold" style={{ color:ROLE_COLOR }}>{createdId || 'RTS-10049'}</span>
      </p>
      <p className="text-xs mb-8" style={{ color:'#5C6E8C' }}>
        We'll email a quote to {form.email || 'your email'} within 1 business hour.
      </p>
      <div className="flex gap-3">
        <button onClick={() => { setSubmitted(false); setStep(1); setCreatedId(null); setForm(makeInitialForm()); setAttachments([]) }} className="btn-primary">Place Another</button>
        <button onClick={() => navigate('/client/orders')} className="btn-secondary">Track Order</button>
      </div>
    </motion.div>
  )

  return (
    <div className="max-w-2xl mx-auto">
      {admin ? (
        <div className="mb-8 flex items-center gap-3">
          <button onClick={() => navigate('/admin/orders')} title="Back to Orders"
            style={{ display:'flex', alignItems:'center', gap:4, padding:'6px 10px', borderRadius:8,
              border:'1px solid #E6EBF2', background:'#fff', color:'#5C6E8C', fontSize:13, cursor:'pointer' }}>
            <ChevronLeft style={{ width:15, height:15 }} /> Orders
          </button>
          <div>
            <h1 className="text-2xl font-bold mb-0.5" style={{ color:'#12284C' }}>Place an order</h1>
            <p className="text-sm" style={{ color:'#5C6E8C' }}>On behalf of a client. It enters your queue to confirm, price and route — like any other order.</p>
          </div>
        </div>
      ) : (
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-1" style={{ color:'#12284C' }}>Place a New Order</h1>
          <p className="text-sm" style={{ color:'#5C6E8C' }}>Title search across all 50 states · Confirmation within minutes</p>
        </div>
      )}

      {/* Single order vs bulk import — client only. */}
      {!admin && (
        <div className="inline-flex p-1 rounded-xl mb-6" style={{ background:'rgba(18,40,76,0.05)' }}>
          {[['single','Single order'],['bulk','Bulk import']].map(([k,l]) => (
            <button key={k} type="button" onClick={()=>setWizMode(k)}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={wizMode===k ? { background:'#fff', color:'#12284C', boxShadow:'0 1px 2px rgba(18,40,76,0.10)' } : { color:'#5C6E8C' }}>
              {l}
            </button>
          ))}
        </div>
      )}

      {!admin && wizMode === 'bulk' ? <BulkImport /> : (<>
      {/* Steps indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s,i) => (
          <React.Fragment key={s}>
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => i+1 < step && setStep(i+1)}>
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                style={i+1 < step
                  ? { background:'#2441E5', color:'#FFFFFF' }
                  : i+1 === step
                  ? { background:'#2441E5', color:'#FFFFFF', boxShadow:`0 0 0 3px rgba(90,140,62,0.25)` }
                  : { background:'rgba(18,40,76,0.07)', color:'#5C6E8C' }}>
                {i+1 < step ? <CheckCircle className="w-3.5 h-3.5" /> : i+1}
              </div>
              <span className="text-xs font-medium hidden sm:block"
                style={{ color: i+1===step ? '#12284C' : '#5C6E8C' }}>{s}</span>
            </div>
            {i < STEPS.length-1 && (
              <div className="flex-1 h-0.5 rounded-full"
                style={{ background: i+1 < step ? '#1B34C4' : 'rgba(18,40,76,0.10)' }} />
            )}
          </React.Fragment>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity:0, x:20 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:-20 }}
          className="glass-card p-6">
          <form onSubmit={e => { e.preventDefault(); submit() }}>
            {admin && step===1 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Client</h2>
                <div>
                  <Field>Client *</Field>
                  <select value={adminClientCode} onChange={e => pickClient(e.target.value)} className="input-field text-sm" required>
                    <option value="">Select a client…</option>
                    {clients.map(c => <option key={c.code} value={c.code}>{c.name ? `${c.name} (${c.code})` : c.code}</option>)}
                  </select>
                  <div className="text-[11px] mt-1" style={{ color:'#9AA8BF' }}>The order is placed on behalf of this company — it becomes the order’s client.</div>
                </div>
                {adminClientCode && (
                  <div className="flex items-start gap-2 p-3 rounded-xl text-[12.5px]" style={{ background:'rgba(36,65,229,0.06)', border:'1px solid rgba(36,65,229,0.18)', color:'#3D5171' }}>
                    <Building2Dot />
                    <span>Placing for <strong style={{ color:'#12284C' }}>{companyName}</strong>{contacts.length ? ` · ${contacts.length} saved ${contacts.length === 1 ? 'contact' : 'contacts'} on file` : ''}.</span>
                  </div>
                )}
              </div>
            )}
            {cs===1 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Property Information</h2>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Property State *</label>
                  <select value={form.state} onChange={e=>{ set('state', e.target.value); set('county', '') }} className="input-field text-sm" required>
                    <option value="">Select state…</option>
                    {US_STATES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>County *</label>
                  <input value={form.county} onChange={e=>set('county',e.target.value)}
                    list="county-options" disabled={!form.state}
                    placeholder={form.state ? 'Start typing or pick a county…' : 'Select a state first'}
                    className="input-field text-sm" required/>
                  <datalist id="county-options">
                    {(counties?.[form.state] || []).map(c => <option key={c} value={c} />)}
                  </datalist>
                  {form.state && counties?.[form.state] && (
                    <div className="text-[11px] mt-1" style={{ color:'#9AA8BF' }}>{counties[form.state].length} counties · type to filter</div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Property Address</label>
                  <input value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Main St, City, State 00000" className="input-field text-sm"/>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>City</label>
                    <input value={form.city} onChange={e=>set('city',e.target.value)} placeholder="Springfield" className="input-field text-sm"/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>ZIP <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.zip} onChange={e=>set('zip',e.target.value)} placeholder="62701" className="input-field text-sm"/>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Parcel / APN # <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.parcelId} onChange={e=>set('parcelId',e.target.value)} placeholder="14-25-376-012" className="input-field text-sm"/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Your file # <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.clientFileNo} onChange={e=>set('clientFileNo',e.target.value)} placeholder="ABC-2291" className="input-field text-sm"/>
                    <div className="text-[11px] mt-1" style={{ color:'#9AA8BF' }}>{admin ? 'The client’s own reference — quoted back on every update.' : 'Your own reference — we quote it back on every update.'}</div>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Property Type <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {['Residential','Commercial','Vacant Land','Agriculture','Other'].map(pt => (
                      <button key={pt} type="button" onClick={() => set('propertyType', pt)}
                        className="py-2 px-2 rounded-lg text-xs font-medium border transition-all"
                        style={form.propertyType === pt
                          ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14`, color:'#12284C' }
                          : { border:'1px solid #DDE3EC', background:'#fff', color:'#5C6E8C' }}>
                        {pt}
                      </button>
                    ))}
                  </div>
                  {form.propertyType === 'Other' && (
                    <input value={form.propertyTypeOther} onChange={e=>set('propertyTypeOther', e.target.value)}
                      placeholder="Describe the property type" className="input-field text-sm mt-2"/>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Parties <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <div className="space-y-2">
                    {form.parties.map(p => (
                      <div key={p.id} className="grid grid-cols-[104px,1fr,auto] gap-2 items-center">
                        <select value={p.role} onChange={e=>setParty(p.id, { role: e.target.value })} className="input-field text-sm">
                          {['Buyer','Seller','Borrower'].map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <input value={p.name} onChange={e=>setParty(p.id, { name: e.target.value })} placeholder="Full name" className="input-field text-sm"/>
                        <button type="button" onClick={()=>removeParty(p.id)} disabled={form.parties.length <= 1}
                          title="Remove" className="p-2" style={{ color: form.parties.length <= 1 ? '#C7CFDB' : '#dc2626' }}>
                          <Trash2 className="w-4 h-4"/>
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3 mt-2">
                    <button type="button" onClick={()=>addParty('Buyer')} className="text-xs font-semibold flex items-center gap-1" style={{ color:ROLE_COLOR }}><PlusCircle className="w-3.5 h-3.5"/> Add buyer</button>
                    <button type="button" onClick={()=>addParty('Seller')} className="text-xs font-semibold flex items-center gap-1" style={{ color:ROLE_COLOR }}><PlusCircle className="w-3.5 h-3.5"/> Add seller</button>
                  </div>
                </div>
              </div>
            )}
            {cs===2 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Search Details</h2>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color:'#5C6E8C' }}>Titled Products *</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {PRODUCTS.map(p => {
                      const active = form.searchType === p.name
                      return (
                        <button key={p.name} type="button" onClick={() => set('searchType', p.name)}
                          className="p-3 rounded-xl text-left border transition-all"
                          style={active
                            ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14`, boxShadow:`0 0 0 1px ${ROLE_COLOR}44` }
                            : { border:'1px solid #DDE3EC', background:'#fff' }}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-sm" style={{ color:'#12284C' }}>{p.name}</span>
                            {p.price != null
                              ? <span className="font-bold text-sm" style={{ color:'#b45309' }}>${p.price}</span>
                              : <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0" style={{ background:'#EEF1FE', color:ROLE_COLOR }}>Quote</span>}
                          </div>
                          <p className="text-[11px] mt-1 leading-snug" style={{ color:'#5C6E8C' }}>{p.desc}</p>
                          {p.tat && <span className="inline-block mt-2 text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background:'#EDF0F5', color:'#3D5171' }}>⏱ {p.tat}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Custom search <span style={{textTransform:'none',opacity:.6}}>(not in the list above?)</span></label>
                  <input value={form.customSearch} onChange={e=>set('customSearch', e.target.value)}
                    placeholder="e.g. Mineral rights search, Foreclosure guarantee…" className="input-field text-sm"/>
                  <div className="text-[11px] mt-1" style={{ color:'#9AA8BF' }}>Describe a search outside our standard products and we’ll quote it.</div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color:'#5C6E8C' }}>Turnaround</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {TURNAROUND.map(t => (
                      <button key={t.key} type="button" onClick={() => set('priority', t.key)}
                        className="p-3 rounded-xl text-left border transition-all"
                        style={form.priority===t.key
                          ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14` }
                          : { border:'1px solid #DDE3EC', background:'#fff' }}>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-sm" style={{ color:'#12284C' }}>{t.label}</span>
                          <span className="text-xs font-bold" style={{ color: t.fee ? '#b45309' : '#5C6E8C' }}>+${t.fee}</span>
                        </div>
                        <div className="text-xs mt-0.5" style={{ color:'#5C6E8C' }}>{t.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Special Instructions</label>
                  <textarea value={form.notes} onChange={e=>set('notes',e.target.value)} rows={3} className="input-field text-sm resize-none" placeholder="Any notes for the search team…"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Attachments <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <p className="text-[11px] mb-2" style={{ color:'#5C6E8C' }}>Deed scans, prior title policies, payoff letters, or anything else the search team should reference.</p>
                  <ClientAttach value={attachments} onChange={setAttachments} />
                </div>
              </div>
            )}
            {cs===3 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Contact Information</h2>
                {contacts.length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Placed by</label>
                    <select value={form.placedById || 'new'} onChange={e=>pickContact(e.target.value === 'new' ? '' : e.target.value)} className="input-field text-sm">
                      {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.title ? ` — ${c.title}` : ''}</option>)}
                      <option value="new">＋ Someone new…</option>
                    </select>
                    <p className="text-[11px] mt-1.5" style={{ color:'#5C6E8C' }}>Pick who’s placing this order, or add a new person below — we’ll remember them for next time.</p>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Contact Name *</label>
                    <input value={form.contactName} onChange={e=>set('contactName',e.target.value)} placeholder="Full name" className="input-field text-sm" required/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Title / Role <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.role} onChange={e=>set('role',e.target.value)} placeholder="e.g. Processor" className="input-field text-sm"/>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Work Email *</label>
                    <input type="email" value={form.email} onChange={e=>set('email',e.target.value)} placeholder="you@company.com" className="input-field text-sm" required/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Phone <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.phone} onChange={e=>set('phone',e.target.value)} placeholder="(555) 123-4567" className="input-field text-sm"/>
                  </div>
                </div>
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input type="checkbox" checked={!!form.marketingOptIn} onChange={e=>set('marketingOptIn',e.target.checked)} style={{ marginTop:2 }} />
                  <span className="text-[12.5px]" style={{ color:'#5C6E8C' }}>Okay to send this person occasional product news and updates.</span>
                </label>
              </div>
            )}
            {cs===4 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Review &amp; Submit</h2>
                <div className="space-y-3">
                  {[
                    ...(admin ? [['Client', [
                      ['Company', companyName],
                      ['Client code', adminClientCode],
                    ]]] : []),
                    ['Property', [
                      ['State', stateName(form.state)],
                      ['County', form.county],
                      ['Address', [form.address, form.city, stateName(form.state), form.zip].filter(Boolean).join(', ')],
                      ['Property type', form.propertyType === 'Other' ? (form.propertyTypeOther.trim() || 'Other') : form.propertyType],
                      ['Parcel / APN #', form.parcelId],
                      [admin ? 'Client file #' : 'Your file #', form.clientFileNo],
                    ]],
                    ['Search', [
                      ['Product', form.searchType],
                      ...(form.customSearch.trim() ? [['Custom search', form.customSearch]] : []),
                      ['Turnaround', (() => { const t = TURNAROUND.find(x => x.key === form.priority); return t ? `${t.label}${t.fee ? ` (+$${t.fee})` : ''}` : form.priority })()],
                      ['Special instructions', form.notes],
                    ]],
                    ['Parties', form.parties.filter(p => p.name.trim()).map(p => [p.role, p.name])],
                    ['Contact', [
                      ['Placed by', form.contactName],
                      ['Title / role', form.role],
                      ['Work email', form.email],
                      ['Phone', form.phone],
                    ]],
                  ].map(([title, pairs]) => (
                    <div key={title} className="glass p-4 rounded-xl">
                      <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color:'#5C6E8C' }}>
                        {title}{title === 'Parties' ? ` (${pairs.length})` : ''}
                      </div>
                      {pairs.length ? pairs.map(([k, v], idx) => (
                        <div key={idx} className="flex gap-3 py-0.5 text-sm">
                          <span style={{ color:'#5C6E8C', minWidth:150, flexShrink:0 }}>{k}</span>
                          <span className="font-medium" style={{ color:'#12284C', wordBreak:'break-word' }}>{v || '—'}</span>
                        </div>
                      )) : <div className="text-sm" style={{ color:'#9AA8BF' }}>None added</div>}
                    </div>
                  ))}
                </div>
                {attachments.length > 0 && (
                  <div className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-xl" style={{ background:'rgba(36,65,229,0.08)', border:'1px solid rgba(36,65,229,0.20)', color:'#2441E5' }}>
                    <Paperclip className="w-4 h-4 flex-shrink-0" />
                    {attachments.length} {attachments.length === 1 ? 'file' : 'files'} attached
                  </div>
                )}
                {form.priority==='rush' && (
                  <div className="flex items-center gap-2 p-3 rounded-xl text-sm"
                    style={{ background:'rgba(220,80,60,0.10)', border:'1px solid rgba(220,80,60,0.22)', color:'#dc2626' }}>
                    <Zap className="w-4 h-4 flex-shrink-0" />
                    Rush order selected — additional fees apply. Delivery within 24 hours.
                  </div>
                )}
                <div className="flex items-start gap-2 p-3 rounded-xl text-[12px] leading-snug"
                  style={{ background:'rgba(18,40,76,0.04)', border:'1px solid rgba(18,40,76,0.10)', color:'#3D5171' }}>
                  <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color:'#15803d' }} />
                  <span><strong>Free cancellation.</strong> There is no charge to cancel an order any time before we begin the title search (screening). Once work has started, a cancellation becomes a request our team reviews.</span>
                </div>
              </div>
            )}
            {stepErr && !stepValid(step) && (
              <div className="mt-4 text-[12px] px-3 py-2 rounded-lg" style={{ background:'rgba(220,38,38,0.08)', border:'1px solid rgba(220,38,38,0.22)', color:'#dc2626' }}>
                {admin && step===1 ? 'Select a client to place this order for.'
                  : cs===1 ? 'Property State and County are required.'
                  : cs===2 ? 'Choose a product or describe a custom search.'
                  : 'Contact name and a valid email are required.'}
              </div>
            )}
            {submitErr && (
              <div className="mt-4 text-[12px] px-3 py-2 rounded-lg" style={{ background:'rgba(220,38,38,0.08)', border:'1px solid rgba(220,38,38,0.22)', color:'#dc2626' }}>
                {submitErr}
              </div>
            )}
            <div className="flex gap-3 mt-8">
              {step>1 && <button type="button" onClick={() => { setStepErr(false); setStep(s=>s-1) }} className="btn-secondary px-6">Back</button>}
              {step<total
                ? <button type="button" onClick={goNext} className="btn-primary flex-1">Continue</button>
                : <button type="submit" disabled={busy} className="btn-primary flex-1 flex items-center justify-center gap-2" style={busy ? { opacity:0.7, cursor:'wait' } : undefined}>
                    <Send className="w-4 h-4" /> {busy ? (admin ? 'Placing…' : 'Submitting…') : (admin ? 'Place order' : 'Submit Order')}
                  </button>
              }
            </div>
          </form>
        </motion.div>
      </AnimatePresence>
      </>)}
    </div>
  )
}
