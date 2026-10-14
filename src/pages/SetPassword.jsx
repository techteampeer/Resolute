import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Eye, EyeOff, ArrowRight, AlertCircle, ShieldCheck } from 'lucide-react'
import { useAuth, toErrorMessage } from '../context/AuthContext'

// Where an invite / password-reset link lands. The recovery link has already
// established a session (AuthContext flipped `recovery` on); here the person
// chooses their own password, which activates the account for normal sign-in.
export default function SetPassword() {
  const navigate = useNavigate()
  const { setPassword, user } = useAuth()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const tooShort = pw.length > 0 && pw.length < 8
  const mismatch = confirm.length > 0 && confirm !== pw
  const ok = pw.length >= 8 && pw === confirm

  const submit = async (e) => {
    e.preventDefault()
    if (!ok) return
    setLoading(true); setError('')
    try {
      const r = await setPassword(pw)
      if (r.success) navigate('/', { replace: true })
      else setError(toErrorMessage(r.error))
    } catch (err) { setError(toErrorMessage(err)) }
    finally { setLoading(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#F3F5F8' }}>
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-8">
          <img src="/logo-horizontal.png" alt="Resolute Title Services"
            style={{ height: 42, width: 'auto', maxWidth: '100%' }} />
        </div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-8">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-5 h-5" style={{ color: '#2441E5' }} />
            <h2 className="text-2xl font-bold" style={{ color: '#12284C' }}>Set your password</h2>
          </div>
          <p className="text-sm mb-7" style={{ color: '#5C6E8C' }}>
            {user?.email ? <>Choose a password for <strong style={{ color: '#12284C' }}>{user.email}</strong>.</> : 'Choose a password to activate your account.'}
          </p>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: '#5C6E8C' }}>New password</label>
              <div className="relative">
                <input type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)}
                  placeholder="At least 8 characters" className="input-field pr-12" autoFocus required />
                <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: '#5C6E8C' }}>
                  {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {tooShort && <div className="text-xs mt-1" style={{ color: '#b45309' }}>Use at least 8 characters.</div>}
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: '#5C6E8C' }}>Confirm password</label>
              <input type={show ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)}
                placeholder="Re-enter password" className="input-field" required />
              {mismatch && <div className="text-xs mt-1" style={{ color: '#dc2626' }}>Passwords don’t match.</div>}
            </div>
            {error && (
              <div className="flex items-center gap-2 text-sm px-4 py-3 rounded-xl"
                style={{ background: 'rgba(220,60,60,0.10)', border: '1px solid rgba(220,60,60,0.22)', color: '#dc2626' }}>
                <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
              </div>
            )}
            <motion.button type="submit" disabled={loading || !ok} whileTap={{ scale: 0.99 }}
              className="w-full btn-primary flex items-center justify-center gap-2 mt-1"
              style={{ opacity: (loading || !ok) ? 0.6 : 1 }}>
              {loading
                ? <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: '#5C6E8C', borderTopColor: '#12284C' }} />
                : <><span>Set password & continue</span><ArrowRight className="w-4 h-4" /></>}
            </motion.button>
          </form>
        </motion.div>
      </div>
    </div>
  )
}
