import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, Send, ChevronLeft } from 'lucide-react'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { useClients, clientLabelOf } from '../../lib/useClients'
import { useContacts } from '../../lib/useContacts'
import { US_STATES, stateName } from '../../data/mockData'
import { PRODUCTS } from '../../data/products'
import { ROLE_COLOR } from '../../lib/ui'

// A1 — Admin places an order ON BEHALF OF a client. Same workflow as a client
// placing their own: createOrder parks it in the normal initial Admin state
// ('received', assigned to Admin, unconfirmed), so Admin then Confirms & prices
// it and sets the stage plan exactly as for any other order. Reuses the per-
// company people directory (useContacts) for the "Placed by" person.
const Label = ({ children }) => (
  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>{children}</label>
)
const Opt = ({ children }) => <span style={{ textTransform:'none', opacity:.6 }}> {children}</span>

export default function AdminPlaceOrder() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { createOrder } = useOrders()
  const clients = useClients()
  const [clientCode, setClientCode] = useState('')
  const { contacts, save: savePlacer } = useContacts(clientCode || null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [f, setF] = useState({
    state:'', county:'', address:'', type:'', priority:'normal', clientFileNo:'', notes:'',
    contactName:'', email:'', phone:'', title:'', marketingOptIn:false, placedById:'',
  })
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))

  // Selecting the client resets the placer (the directory is per-company).
  const pickClient = (code) => { setClientCode(code); setF(s => ({ ...s, placedById:'', contactName:'', email:'', phone:'', title:'', marketingOptIn:false })) }
  const pickContact = (id) => {
    const c = contacts.find(x => x.id === id)
    if (!c) { set('placedById', ''); return }
    setF(s => ({ ...s, placedById:id, contactName:c.name, email:c.email||s.email, phone:c.phone||'', title:c.title||'', marketingOptIn:!!c.marketingOptIn }))
  }

  const valid = !!clientCode && !!f.state && f.county.trim() && f.type.trim() && f.contactName.trim()

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true); setErr('')
    try {
      const company = clientLabelOf(clients, clientCode)
      // Save/refresh the placer in the client's directory (best-effort), then
      // snapshot who placed it on the intake.
      let placedBy = null
      try {
        const saved = await savePlacer({
          id: f.placedById || undefined, name: f.contactName.trim(), email: f.email.trim(),
          phone: f.phone.trim(), title: f.title.trim(), marketingOptIn: !!f.marketingOptIn,
          createdBy: user?.name || 'Admin',
        })
        if (saved) placedBy = { id: saved.id, name: saved.name, email: saved.email, title: saved.title }
      } catch { /* directory is best-effort — never block the order */ }
      const order = await createOrder({
        state: f.state, county: f.county.trim(), type: f.type.trim(),
        priority: f.priority, clientFileNo: f.clientFileNo.trim() || null,
        clientCode, client: company,
        intake: {
          source: 'web',   // placed through the portal; isPortalOrder — Admin confirms & prices
          propertyAddress: [f.address, stateName(f.state)].filter(Boolean).join(', '),
          orderType: f.type.trim(), company,
          from: `${f.contactName} <${f.email}>`.trim(), role: f.title, specialInstructions: f.notes,
          placedBy, contactPhone: f.phone.trim() || null,
          placedByAdmin: user?.name || 'Admin',   // internal: Admin placed this on the client's behalf
        },
      })
      navigate(`/admin/orders/${order.id}`)
    } catch {
      setErr('We couldn’t place the order just now. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5" style={{ maxWidth: 720 }}>
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/admin/orders')} title="Back to Orders"
          style={{ display:'flex', alignItems:'center', gap:4, padding:'6px 10px', borderRadius:8,
            border:'1px solid #E6EBF2', background:'#fff', color:'#5C6E8C', fontSize:13, cursor:'pointer' }}>
          <ChevronLeft style={{ width:15, height:15 }} /> Orders
        </button>
        <div>
          <h1 className="text-xl font-bold" style={{ color:'#12284C' }}>Place an order</h1>
          <p className="text-sm" style={{ color:'#5C6E8C' }}>On behalf of a client. It enters your queue to confirm, price and route — like any other order.</p>
        </div>
      </div>

      <div className="glass-card p-5 space-y-4" style={{ background:'#fff', border:'1px solid #E6EBF2', borderRadius:12 }}>
        <div>
          <Label>Client *</Label>
          <select value={clientCode} onChange={e => pickClient(e.target.value)} className="input-field text-sm">
            <option value="">Select a client…</option>
            {clients.map(c => <option key={c.code} value={c.code}>{c.name ? `${c.name} (${c.code})` : c.code}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label>State *</Label>
            <select value={f.state} onChange={e => set('state', e.target.value)} className="input-field text-sm">
              <option value="">State…</option>
              {US_STATES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <Label>County *</Label>
            <input value={f.county} onChange={e => set('county', e.target.value)} placeholder="County" className="input-field text-sm" />
          </div>
          <div>
            <Label>Client file #<Opt>(optional)</Opt></Label>
            <input value={f.clientFileNo} onChange={e => set('clientFileNo', e.target.value)} placeholder="Their reference" className="input-field text-sm" />
          </div>
        </div>

        <div>
          <Label>Property address<Opt>(optional)</Opt></Label>
          <input value={f.address} onChange={e => set('address', e.target.value)} placeholder="Street, city, ZIP" className="input-field text-sm" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Product *</Label>
            <select value={f.type} onChange={e => set('type', e.target.value)} className="input-field text-sm">
              <option value="">Select a product…</option>
              {PRODUCTS.map(p => <option key={p.name} value={p.name}>{p.name} — ${p.price}</option>)}
            </select>
          </div>
          <div>
            <Label>Priority</Label>
            <select value={f.priority} onChange={e => set('priority', e.target.value)} className="input-field text-sm">
              <option value="normal">Standard</option>
              <option value="rush">Rush (additional fee)</option>
            </select>
          </div>
        </div>

        {/* Placed by — per-company people directory (reused from client intake) */}
        <div className="pt-1" style={{ borderTop:'1px dashed #E6EBF2' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wider mt-3 mb-2" style={{ color:'#9AA8BF' }}>Placed by</div>
          {clientCode && contacts.length > 0 && (
            <div className="mb-3">
              <Label>Choose a saved person</Label>
              <select value={f.placedById || 'new'} onChange={e => pickContact(e.target.value === 'new' ? '' : e.target.value)} className="input-field text-sm">
                {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.title ? ` — ${c.title}` : ''}</option>)}
                <option value="new">＋ Someone new…</option>
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Contact name *</Label>
              <input value={f.contactName} onChange={e => set('contactName', e.target.value)} placeholder="Full name" className="input-field text-sm" />
            </div>
            <div>
              <Label>Title / role<Opt>(optional)</Opt></Label>
              <input value={f.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Processor" className="input-field text-sm" />
            </div>
            <div>
              <Label>Email<Opt>(optional)</Opt></Label>
              <input type="email" value={f.email} onChange={e => set('email', e.target.value)} placeholder="name@company.com" className="input-field text-sm" />
            </div>
            <div>
              <Label>Phone<Opt>(optional)</Opt></Label>
              <input value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="(555) 123-4567" className="input-field text-sm" />
            </div>
          </div>
          <label className="flex items-start gap-2.5 cursor-pointer select-none mt-3">
            <input type="checkbox" checked={!!f.marketingOptIn} onChange={e => set('marketingOptIn', e.target.checked)} style={{ marginTop:2 }} disabled={!clientCode} />
            <span className="text-[12.5px]" style={{ color:'#5C6E8C' }}>Okay to send this person occasional product news and updates.</span>
          </label>
        </div>

        <div>
          <Label>Special instructions<Opt>(optional)</Opt></Label>
          <textarea value={f.notes} onChange={e => set('notes', e.target.value)} rows={3} className="input-field text-sm resize-none" placeholder="Anything the search team should know…" />
        </div>

        {err && <div className="text-sm" style={{ color:'#dc2626' }}>{err}</div>}
        <div className="flex items-center gap-3 pt-1">
          <button onClick={submit} disabled={!valid || busy}
            className="btn-primary text-sm px-5 py-2.5 flex items-center gap-2"
            style={(!valid || busy) ? { opacity:0.6, cursor:'not-allowed' } : undefined}>
            <Send className="w-4 h-4" /> {busy ? 'Placing…' : 'Place order'}
          </button>
          <span className="text-xs" style={{ color:'#9AA8BF' }}>
            <ClipboardList className="w-3.5 h-3.5 inline mr-1" style={{ verticalAlign:'-2px' }} />
            You’ll land on the order to confirm, price and set its stage plan.
          </span>
        </div>
      </div>
    </div>
  )
}
