import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth, toErrorMessage } from '../context/AuthContext'
import {
  ShieldCheck, Users, Search, FileSearch, Truck, Building2, Keyboard,
  Eye, EyeOff, ArrowRight, MapPin, CheckCircle2, AlertCircle
} from 'lucide-react'

const ROLES = [
  { key: 'admin',    label: 'Admin',    icon: ShieldCheck, color: '#3d7020', desc: 'Full system control',        demo: 'rajni@resolute.com',    pass: 'admin123'    },
  { key: 'screener', label: 'Screener', icon: Search,      color: '#4d7c2f', desc: 'Review incoming orders',     demo: 'screener@resolute.com', pass: 'screener123' },
  { key: 'examiner', label: 'Examiner', icon: FileSearch,  color: '#a16207', desc: 'Examine title documents',    demo: 'examiner@resolute.com', pass: 'examiner123' },
  { key: 'typer',    label: 'Typer',    icon: Keyboard,    color: '#0e7490', desc: 'Type final reports',         demo: 'typer@resolute.com',    pass: 'typer123'    },
  { key: 'delivery', label: 'Delivery', icon: Truck,       color: '#b45309', desc: 'Deliver completed searches', demo: 'delivery@resolute.com', pass: 'delivery123' },
  { key: 'client',   label: 'Client',   icon: Building2,   color: '#4d7c2f', desc: 'Place & track orders',       demo: 'client@resolute.com',   pass: 'client123'   },
  { key: 'operator', label: 'Single Seating', icon: Users, color: '#0f766e', desc: 'All stages · admin approved', demo: 'operator@resolute.com', pass: 'operator123' },
]

// Admin tier accounts — super admins see full client detail, members see client codes only.
const ADMIN_ACCOUNTS = [
  { key: 'rajni',     label: 'Rajni',     tier: 'Super admin', email: 'rajni@resolute.com',     pass: 'admin123' },
  { key: 'saravanan', label: 'Saravanan', tier: 'Super admin', email: 'saravanan@resolute.com', pass: 'admin123' },
  { key: 'vivek',     label: 'Vivek',     tier: 'Super admin · Billing', email: 'vivek@resolute.com', pass: 'vivek123' },
  { key: 'member',    label: 'Member',    tier: 'Client codes only', email: 'admin@resolute.com', pass: 'admin123' },
]

// The role picker + credential pre-fill are a LOCAL-DEV convenience only.
// Production builds must never advertise accounts or passwords, so they render
// a plain email/password sign-in instead. `import.meta.env.DEV` is true under
// `vite` (dev server) and false under `vite build`; set VITE_SHOW_DEMO_CREDS=true
// to force the demo picker on in a non-dev build (e.g. an internal staging URL).
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_CREDS === 'true'

// `variant` splits the entry surfaces: 'client' (external, /login) never shows
// the role picker or any account hints; 'staff' (internal, /staff) keeps the
// role convenience — but only in dev/staging via SHOW_DEMO. Both post to the
// same auth backend; the split is UX + not advertising internal roles to clients.
export default function LoginPage({ variant = 'client' }) {
  const navigate = useNavigate()
  const { login } = useAuth()
  const isStaff = variant === 'staff'
  const showPicker = isStaff && SHOW_DEMO
  const [selectedRole, setSelectedRole] = useState(null)
  const [adminAccount, setAdminAccount] = useState('rajni')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass]  = useState(false)
  const [error, setError]        = useState('')
  const [loading, setLoading]    = useState(false)

  const handleRoleSelect = (role) => {
    setSelectedRole(role)
    setEmail(role.demo)
    setPassword(role.pass)
    if (role.key === 'admin') setAdminAccount('rajni')
    setError('')
  }

  const handleAdminAccount = (acct) => {
    setAdminAccount(acct.key)
    setEmail(acct.email)
    setPassword(acct.pass)
    setError('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await new Promise(r => setTimeout(r, 250))
      const result = await login(email, password)
      if (result?.success) navigate(`/${result.role}`)
      else setError(toErrorMessage(result?.error))
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex overflow-hidden relative" style={{ background: '#f0f2f4' }}>
      {/* Ambient blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-48 -left-48 w-96 h-96 rounded-full blur-3xl animate-pulse-slow"
          style={{ background: 'rgba(61,112,32,0.22)' }} />
        <div className="absolute -bottom-48 -right-48 w-96 h-96 rounded-full blur-3xl animate-pulse-slow"
          style={{ background: 'rgba(61,112,32,0.15)', animationDelay: '2s' }} />
        <div className="absolute top-1/3 right-1/4 w-64 h-64 rounded-full blur-3xl"
          style={{ background: 'rgba(196,164,78,0.08)' }} />
        {/* Subtle grid */}
        <div className="absolute inset-0" style={{
          backgroundImage:
            'linear-gradient(rgba(138,194,104,0.04) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(138,194,104,0.04) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }} />
      </div>

      {/* ── Left hero panel ── */}
      <div className="hidden lg:flex flex-col justify-between w-1/2 p-16 relative z-10">
        <div>
          {/* Logo */}
          <div className="flex items-center gap-3 mb-16">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#3d7020' }}>
              <MapPin className="w-5 h-5" style={{ color: '#f5f7f2' }} />
            </div>
            <span className="text-2xl font-bold tracking-tight" style={{ color: '#1e293b' }}>Resolute</span>
            <span className="text-sm font-medium ml-1" style={{ color: '#64748b' }}>Portal</span>
          </div>

          <h1 className="text-5xl font-bold leading-tight mb-6">
            <span style={{ color: '#1e293b' }}>Human-Verified</span><br />
            <span className="gradient-text">Title Intelligence</span>
          </h1>
          <p className="text-lg leading-relaxed max-w-md" style={{ color: '#475569' }}>
            Your unified portal for managing title searches across all 50 states
            with real-time tracking and instant delivery.
          </p>

          <div className="mt-10 space-y-4">
            {['50-State Coverage', '3,140+ Counties', '98.4% On-Time Delivery', 'Real-Time Tracking'].map(f => (
              <div key={f} className="flex items-center gap-3">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: '#4d7c2f' }} />
                <span className="text-sm font-medium" style={{ color: '#475569' }}>{f}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-sm" style={{ color: 'rgba(30,41,59,0.18)' }}>
          © 2026 Resolute Title Services. All rights reserved.
        </p>
      </div>

      {/* ── Right sign-in panel ── */}
      <div className="flex-1 flex items-center justify-center p-6 relative z-10">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-8 lg:hidden">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: '#3d7020' }}>
              <MapPin className="w-4 h-4" style={{ color: '#f5f7f2' }} />
            </div>
            <span className="text-xl font-bold" style={{ color: '#1e293b' }}>Resolute Portal</span>
          </div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="glass-card p-8">
            <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>{isStaff ? 'Staff sign in' : 'Sign in'}</h2>
            <p className="text-sm mb-8" style={{ color: '#64748b' }}>{showPicker ? 'Select your role to continue' : isStaff ? 'Internal team access' : 'Sign in to your account'}</p>

            {showPicker && (<>
            {/* Role grid */}
            <div className="grid grid-cols-3 gap-2 mb-8">
              {ROLES.map(role => {
                const Icon   = role.icon
                const active = selectedRole?.key === role.key
                return (
                  <motion.button key={role.key}
                    whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.96 }}
                    onClick={() => handleRoleSelect(role)}
                    className="flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all duration-200"
                    style={{
                      background: active ? `${role.color}1a` : 'rgba(30,41,59,0.04)',
                      borderColor: active ? `${role.color}55` : 'rgba(30,41,59,0.08)',
                    }}>
                    <Icon className="w-5 h-5" style={{ color: active ? role.color : '#64748b' }} />
                    <span className="text-xs font-medium"
                      style={{ color: active ? '#1e293b' : '#64748b' }}>
                      {role.label}
                    </span>
                  </motion.button>
                )
              })}
            </div>

            {/* Role description strip */}
            <AnimatePresence>
              {selectedRole && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }} className="overflow-hidden mb-5">
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
                    style={{ background: `${selectedRole.color}16`, border: `1px solid ${selectedRole.color}2e` }}>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: selectedRole.color }} />
                    <span className="text-sm font-semibold" style={{ color: selectedRole.color }}>
                      {selectedRole.label}
                    </span>
                    <span className="text-xs ml-auto" style={{ color: '#64748b' }}>
                      {selectedRole.desc}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Admin tier sub-picker */}
            <AnimatePresence>
              {selectedRole?.key === 'admin' && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }} className="overflow-hidden mb-5">
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
                    style={{ color: '#64748b' }}>Admin account</label>
                  <div className="grid grid-cols-3 gap-2">
                    {ADMIN_ACCOUNTS.map(acct => {
                      const active = adminAccount === acct.key
                      return (
                        <button key={acct.key} type="button" onClick={() => handleAdminAccount(acct)}
                          className="px-2 py-2 rounded-xl border text-left transition-all"
                          style={{
                            background: active ? 'rgba(90,140,62,0.16)' : 'rgba(30,41,59,0.04)',
                            borderColor: active ? 'rgba(90,140,62,0.45)' : 'rgba(30,41,59,0.08)',
                          }}>
                          <div className="text-xs font-semibold"
                            style={{ color: active ? '#1e293b' : '#475569' }}>{acct.label}</div>
                          <div className="text-[10px] leading-tight mt-0.5"
                            style={{ color: active ? '#4d7c2f' : '#64748b' }}>{acct.tier}</div>
                        </button>
                      )
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            </>)}

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
                  style={{ color: '#64748b' }}>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Enter your email" className="input-field" required />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5"
                  style={{ color: '#64748b' }}>Password</label>
                <div className="relative">
                  <input type={showPass ? 'text' : 'password'} value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter your password" className="input-field pr-12" required />
                  <button type="button" onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                    style={{ color: '#64748b' }}>
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <AnimatePresence>
                {error && (
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="flex items-center gap-2 text-sm px-4 py-3 rounded-xl"
                    style={{ background: 'rgba(220,60,60,0.10)', border: '1px solid rgba(220,60,60,0.22)', color: '#dc2626' }}>
                    <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.button type="submit" disabled={loading}
                whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
                className="w-full btn-primary flex items-center justify-center gap-2 mt-1"
                style={{ opacity: loading ? 0.6 : 1 }}>
                {loading
                  ? <div className="w-5 h-5 border-2 rounded-full animate-spin"
                      style={{ borderColor: '#64748b', borderTopColor: '#1e293b' }} />
                  : <><span>Sign in</span><ArrowRight className="w-4 h-4" /></>}
              </motion.button>
            </form>

            {showPicker && (
              <p className="text-center text-xs mt-6" style={{ color: '#64748b' }}>
                Demo credentials pre-filled · Select a role above
              </p>
            )}

            {/* Cross-link between the client and staff entries */}
            <p className="text-center text-xs mt-5" style={{ color: '#64748b' }}>
              {isStaff
                ? <Link to="/login" style={{ color: '#4d7c2f', fontWeight: 600 }}>← Back to client portal</Link>
                : <>Resolute team member? <Link to="/staff" style={{ color: '#4d7c2f', fontWeight: 600 }}>Staff sign-in →</Link></>}
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  )
}
