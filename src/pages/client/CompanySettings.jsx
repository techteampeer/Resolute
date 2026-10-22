import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, Users, Lock, Save, Plus, Pencil, Trash2, Check, X, Bell, Mail } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useClientProfile } from '../../lib/useClientProfile'
import { useContacts } from '../../lib/useContacts'
import { clientName } from '../../data/mockData'
import { US_STATES } from '../../data/mockData'
import { getClientTerms, termByKey } from '../../lib/billing'
import { ROLE_COLOR } from '../../lib/ui'

const Label = ({ children }) => (
  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>{children}</label>
)
const Card = ({ icon:Icon, title, hint, children, right }) => (
  <div className="glass-card p-5" style={{ background:'#fff', border:'1px solid #E6EBF2', borderRadius:12 }}>
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="flex items-center gap-2.5">
        <div style={{ width:34, height:34, borderRadius:9, background:`${ROLE_COLOR}12`, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <Icon className="w-4 h-4" style={{ color:ROLE_COLOR }} />
        </div>
        <div>
          <h2 className="text-[15px] font-bold" style={{ color:'#12284C' }}>{title}</h2>
          {hint && <p className="text-[12px]" style={{ color:'#5C6E8C' }}>{hint}</p>}
        </div>
      </div>
      {right}
    </div>
    {children}
  </div>
)

// ── People (contacts directory) manager ──────────────────────────────────────
const BLANK = { name:'', title:'', email:'', phone:'', marketingOptIn:false }
function PeopleManager({ clientCode }) {
  const { contacts, save, remove } = useContacts(clientCode)
  const [editing, setEditing] = useState(null)   // contact id being edited, '' for a new one, null = closed
  const [f, setF] = useState(BLANK)
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))
  const openNew = () => { setF(BLANK); setEditing('') }
  const openEdit = (c) => { setF({ name:c.name, title:c.title, email:c.email, phone:c.phone, marketingOptIn:c.marketingOptIn }); setEditing(c.id) }
  const close = () => { setEditing(null); setF(BLANK) }
  const submit = async () => {
    if (!f.name.trim() || busy) return
    setBusy(true)
    await save({ id: editing || undefined, ...f, name:f.name.trim(), createdBy:'client' })
    setBusy(false); close()
  }
  return (
    <div className="space-y-3">
      {contacts.length === 0 && editing === null && (
        <p className="text-[13px]" style={{ color:'#9AA8BF' }}>No people yet. Add the colleagues who place or follow orders.</p>
      )}
      {contacts.map(c => (
        <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg"
          style={{ border:'1px solid #EEF1F6' }}>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold" style={{ color:'#12284C' }}>
              {c.name}{c.title ? <span className="font-normal" style={{ color:'#5C6E8C' }}> · {c.title}</span> : null}
              {c.marketingOptIn && <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background:'#eef2ff', color:'#4338CA' }}>marketing OK</span>}
            </div>
            <div className="text-[12px] truncate" style={{ color:'#5C6E8C' }}>{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => openEdit(c)} title="Edit" style={{ padding:6, borderRadius:6, border:'none', background:'transparent', cursor:'pointer', color:'#5C6E8C' }}><Pencil className="w-4 h-4" /></button>
            <button onClick={() => remove(c.id)} title="Remove" style={{ padding:6, borderRadius:6, border:'none', background:'transparent', cursor:'pointer', color:'#dc2626' }}><Trash2 className="w-4 h-4" /></button>
          </div>
        </div>
      ))}
      {editing !== null ? (
        <div className="p-3.5 rounded-lg space-y-3" style={{ background:'#F7F9FC', border:'1px solid #E6EBF2' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>Name *</Label><input value={f.name} onChange={e=>set('name',e.target.value)} className="input-field text-sm" placeholder="Full name" /></div>
            <div><Label>Title / role</Label><input value={f.title} onChange={e=>set('title',e.target.value)} className="input-field text-sm" placeholder="e.g. Processor" /></div>
            <div><Label>Email</Label><input type="email" value={f.email} onChange={e=>set('email',e.target.value)} className="input-field text-sm" placeholder="name@company.com" /></div>
            <div><Label>Phone</Label><input value={f.phone} onChange={e=>set('phone',e.target.value)} className="input-field text-sm" placeholder="(555) 123-4567" /></div>
          </div>
          <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color:'#5C6E8C' }}>
            <input type="checkbox" checked={!!f.marketingOptIn} onChange={e=>set('marketingOptIn',e.target.checked)} /> Okay to send product news &amp; updates.
          </label>
          <div className="flex items-center gap-2">
            <button onClick={submit} disabled={!f.name.trim() || busy} className="btn-primary text-sm px-4 py-2 flex items-center gap-1.5" style={(!f.name.trim()||busy)?{opacity:.6,cursor:'not-allowed'}:undefined}>
              <Check className="w-4 h-4" /> {editing ? 'Save person' : 'Add person'}
            </button>
            <button onClick={close} className="text-sm px-3 py-2 rounded-lg flex items-center gap-1.5" style={{ border:'1px solid #E6EBF2', background:'#fff', color:'#5C6E8C', cursor:'pointer' }}><X className="w-4 h-4" /> Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={openNew} className="text-sm px-3.5 py-2 rounded-lg flex items-center gap-1.5" style={{ border:`1px dashed ${ROLE_COLOR}66`, background:`${ROLE_COLOR}08`, color:ROLE_COLOR, cursor:'pointer' }}>
          <Plus className="w-4 h-4" /> Add a person
        </button>
      )}
    </div>
  )
}

export default function CompanySettings() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const code = user?.clientCode || null
  const { profile, save } = useClientProfile(code)
  const [f, setF] = useState(profile)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setF(profile) }, [profile])
  const set = (k, v) => { setF(s => ({ ...s, [k]: v })); setSaved(false) }

  const company = clientName(code) || code || '—'
  const terms = termByKey(getClientTerms(code))

  const saveProfile = async () => {
    if (busy) return
    setBusy(true)
    const r = await save(f, user?.name || 'Client')
    setBusy(false)
    if (r?.ok) { setSaved(true); setTimeout(() => setSaved(false), 2500) }
  }

  return (
    <div className="space-y-5" style={{ maxWidth: 820 }}>
      <div>
        <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Company Settings</h1>
        <p className="text-sm" style={{ color:'#5C6E8C' }}>Keep your company details and people up to date. Account terms are managed by Resolute.</p>
      </div>

      {/* Company profile — client editable */}
      <Card icon={Building2} title="Company profile" hint="Your address, contact details and logo."
        right={
          <button onClick={saveProfile} disabled={busy} className="btn-primary text-sm px-4 py-2 flex items-center gap-1.5" style={busy?{opacity:.6}:undefined}>
            {saved ? <><Check className="w-4 h-4" /> Saved</> : <><Save className="w-4 h-4" /> Save</>}
          </button>
        }>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div style={{ width:56, height:56, borderRadius:12, overflow:'hidden', background:'#F1F5F9', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, border:'1px solid #E6EBF2' }}>
              {f.logoUrl
                ? <img src={f.logoUrl} alt="logo" style={{ width:'100%', height:'100%', objectFit:'contain' }} onError={e => { e.currentTarget.style.display='none' }} />
                : <span className="text-lg font-bold" style={{ color:'#9AA8BF' }}>{company.slice(0,2).toUpperCase()}</span>}
            </div>
            <div className="flex-1"><Label>Logo URL</Label><input value={f.logoUrl} onChange={e=>set('logoUrl',e.target.value)} className="input-field text-sm" placeholder="https://…/logo.png" /></div>
          </div>
          <div><Label>Street address</Label><input value={f.address} onChange={e=>set('address',e.target.value)} className="input-field text-sm" placeholder="123 Main St, Suite 100" /></div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div><Label>City</Label><input value={f.city} onChange={e=>set('city',e.target.value)} className="input-field text-sm" /></div>
            <div>
              <Label>State</Label>
              <select value={f.state} onChange={e=>set('state',e.target.value)} className="input-field text-sm">
                <option value="">State…</option>
                {US_STATES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            </div>
            <div><Label>ZIP</Label><input value={f.zip} onChange={e=>set('zip',e.target.value)} className="input-field text-sm" /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><Label>Phone</Label><input value={f.phone} onChange={e=>set('phone',e.target.value)} className="input-field text-sm" placeholder="(555) 123-4567" /></div>
            <div><Label>Website</Label><input value={f.website} onChange={e=>set('website',e.target.value)} className="input-field text-sm" placeholder="https://company.com" /></div>
          </div>
        </div>
      </Card>

      {/* People — client editable (the contacts directory) */}
      <Card icon={Users} title="People" hint="Colleagues who place or follow orders. Pick them at checkout.">
        <PeopleManager clientCode={code} />
      </Card>

      {/* Account — admin managed, read-only to the client */}
      <Card icon={Lock} title="Account" hint="Managed by Resolute — contact us to change these.">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[['Client code', code || '—'], ['Company', company], ['Payment terms', terms?.label || 'Per order']].map(([k, v]) => (
            <div key={k} className="px-3.5 py-3 rounded-lg" style={{ background:'#F7F9FC', border:'1px solid #EEF1F6' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color:'#9AA8BF' }}>{k}</div>
              <div className="text-[14px] font-semibold" style={{ color:'#12284C' }}>{v}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Preferences — notifications live on their own page */}
      <Card icon={Bell} title="Notifications" hint="Choose which updates reach you.">
        <button onClick={() => navigate('/client/notifications')} className="text-sm px-4 py-2 rounded-lg flex items-center gap-1.5" style={{ border:'1px solid #E6EBF2', background:'#fff', color:ROLE_COLOR, cursor:'pointer' }}>
          <Mail className="w-4 h-4" /> Manage notification preferences
        </button>
      </Card>
    </div>
  )
}
