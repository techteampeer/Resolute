import React, { createContext, useContext, useState, useEffect } from 'react'
import { isSupabaseConfigured, getCurrentUser, signIn, signOut, onAuthChange } from '../lib/backend'
import { DEMO_USER } from '../data/demoData'

const AuthContext = createContext(null)

// Coerce anything (string, Error, Supabase error object, empty object) into a
// human-readable message. Guards against rendering `{}`/`[object Object]` in the
// login error box when an auth failure carries no usable message string.
export function toErrorMessage(err) {
  if (typeof err === 'string') {
    const s = err.trim()
    return s && s !== '{}' && s !== '[object Object]' ? s : 'Invalid email or password. Please try again.'
  }
  if (err && typeof err === 'object') {
    const m = typeof err.message === 'string' ? err.message.trim() : ''
    if (m && m !== '{}') return m
  }
  return 'Invalid email or password. Please try again.'
}

const MOCK_USERS = {
  'rajni@resolute.com':     { password: 'admin123',     role: 'admin',    name: 'Rajni',         avatar: 'RJ', superAdmin: true },
  'saravanan@resolute.com': { password: 'admin123',     role: 'admin',    name: 'Saravanan',     avatar: 'SV', superAdmin: true },
  'vivek@resolute.com':     { password: 'vivek123',     role: 'admin',    name: 'Vivek',         avatar: 'VK', superAdmin: true },
  'admin@resolute.com':     { password: 'admin123',     role: 'admin',    name: 'Alex Morrison', avatar: 'AM', superAdmin: false },
  'screener@resolute.com':  { password: 'screener123',  role: 'screener', name: 'Sam Carter',    avatar: 'SC' },
  'examiner@resolute.com':  { password: 'examiner123',  role: 'examiner', name: 'Jordan Lee',    avatar: 'JL' },
  'typer@resolute.com':     { password: 'typer123',     role: 'typer',    name: 'Priya Nair',    avatar: 'PN' },
  'delivery@resolute.com':  { password: 'delivery123',  role: 'delivery', name: 'Morgan Davis',  avatar: 'MD' },
  'client@resolute.com':    { password: 'client123',    role: 'client',   name: 'Taylor Brooks', avatar: 'TB', clientCode: 'CL01' },
  'operator@resolute.com':  { password: 'operator123',  role: 'user',     name: 'Jordan Blake',   avatar: 'JB' },
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // Whether the stored session has been checked yet. Restoring it is async, so
  // on a cold load `user` is null for the first render — and a route guard that
  // reads null as "signed out" redirects before the session arrives. That is why
  // a refresh, a bookmark, or the "Approve and assign →" deep link in every
  // notification email landed on the login page instead of the order. Guards
  // must wait for this, not for `user`.
  // Mock mode has nothing to restore, so it starts ready.
  const [ready, setReady] = useState(!isSupabaseConfigured)

  // With Supabase: restore the session on load and track auth changes.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let unsub = () => {}
    // Only restore a session that has a resolved role; never auto-land on client.
    getCurrentUser()
      .then(u => setUser(u && u.role ? u : null))
      .catch(() => setUser(null))
      .finally(() => setReady(true))
    unsub = onAuthChange(u => { setUser(u && u.role ? u : null); setReady(true) })
    return () => unsub()
  }, [])

  const login = async (email, password) => {
    if (isSupabaseConfigured) {
      let res
      try {
        res = await signIn(email, password)
      } catch (err) {
        return { success: false, error: toErrorMessage(err) }
      }
      if (res.success && !res.user?.role) {
        await signOut()
        return { success: false, error: 'This account has no role assigned. In Supabase, set profiles.role for this user (see SUPABASE.md).' }
      }
      if (res.success) setUser(res.user)
      return { ...res, error: res.success ? undefined : toErrorMessage(res.error) }
    }
    const found = MOCK_USERS[email.toLowerCase()]
    if (found && found.password === password) {
      setUser({ email: email.toLowerCase(), role: found.role, name: found.name, avatar: found.avatar, superAdmin: !!found.superAdmin, clientCode: found.clientCode || null })
      return { success: true, role: found.role }
    }
    return { success: false, error: 'Invalid credentials' }
  }

  // Guest demo: an ephemeral client session that NEVER touches the backend
  // (no signIn, no Supabase session), so it can't reach real data and resets on
  // refresh. The demo client view reads its own fixture (see demoData.js).
  const loginAsDemo = () => setUser({ ...DEMO_USER })

  const logout = async () => {
    if (isSupabaseConfigured && !user?.demo) await signOut()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, ready, login, loginAsDemo, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
