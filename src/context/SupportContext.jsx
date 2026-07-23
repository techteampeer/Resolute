import React, { createContext, useContext, useState, useEffect } from 'react'
import { clientName as nameForCode } from '../data/mockData'
import { isSupabaseConfigured, fetchSupportMessages, insertSupportMessage, subscribeSupport } from '../lib/backend'
import { useAuth } from './AuthContext'

// Client ⇄ Admin support messaging. Test-report clarification: client support
// messages route to an in-portal Admin inbox (not email).
//
// Persistence follows the app's isSupabaseConfigured seam:
//   • Supabase on  → support_messages table (RLS-scoped, realtime), synced
//     across devices; localStorage is untouched.
//   • Supabase off → mock store persisted to localStorage (per-browser).
const SupportContext = createContext(null)
const STORE_KEY = 'resolute:support'

const load = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
}
const save = (threads) => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(threads)) } catch { /* ignore quota */ }
}
const nowLabel = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const mid = () => Math.random().toString(36).slice(2, 10)

// Group a flat message list (from Supabase) into per-client threads.
const buildThreads = (msgs = []) => {
  const out = {}
  for (const m of msgs) {
    const code = m.clientCode
    if (!out[code]) out[code] = { clientCode: code, clientName: nameForCode(code) || code, messages: [] }
    out[code].messages.push({ id: m.id, from: m.from, text: m.body, author: m.author, time: m.time, at: m.at })
    out[code].updatedAt = Math.max(out[code].updatedAt || 0, m.at || 0)
  }
  return out
}

// Append a message to a thread locally (mock mode + optimistic Supabase echo).
const appendLocal = (prev, { clientCode, clientName, from, text, author }) => {
  const existing = prev[clientCode] || { clientCode, clientName: clientName || clientCode, messages: [] }
  const msg = { id: mid(), from, text, author: author || null, time: nowLabel(), at: Date.now() }
  return { ...prev, [clientCode]: { ...existing, clientName: clientName || existing.clientName, messages: [...existing.messages, msg], updatedAt: msg.at } }
}

export function SupportProvider({ children }) {
  const { user } = useAuth()
  // threads: { [clientCode]: { clientCode, clientName, messages: [...], updatedAt } }
  const [threads, setThreads] = useState(() => (isSupabaseConfigured ? {} : load()))

  // Supabase mode: hydrate + live updates once the user is authenticated (RLS
  // returns nothing to anon). Mock mode: persist to localStorage. Demo skips.
  useEffect(() => {
    if (!isSupabaseConfigured || !user || user.demo) return
    let unsub = () => {}
    const reload = () => fetchSupportMessages().then(msgs => { if (msgs) setThreads(buildThreads(msgs)) })
    reload()
    unsub = subscribeSupport(reload)
    return () => unsub()
  }, [user?.email, user?.demo])

  useEffect(() => { if (!isSupabaseConfigured) save(threads) }, [threads])

  const sendMessage = ({ clientCode, clientName, from, text, author }) => {
    const body = (text || '').trim()
    if (!clientCode || !body) return
    // Optimistic local append so the sender sees it immediately in both modes.
    setThreads(prev => appendLocal(prev, { clientCode, clientName, from, text: body, author }))
    if (isSupabaseConfigured) {
      // Write through; realtime will reconcile, but refetch too in case the
      // table isn't in the realtime publication on this project.
      insertSupportMessage({ clientCode, sender: from, author, body })
        .then(() => fetchSupportMessages())
        .then(msgs => { if (msgs) setThreads(buildThreads(msgs)) })
    }
  }

  const getThread = (clientCode) => threads[clientCode] || null
  const threadList = () => Object.values(threads).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const awaitingReply = (t) => { const m = t.messages[t.messages.length - 1]; return m && m.from === 'client' }
  const pendingCount = () => threadList().filter(awaitingReply).length

  return (
    <SupportContext.Provider value={{ threads, sendMessage, getThread, threadList, awaitingReply, pendingCount }}>
      {children}
    </SupportContext.Provider>
  )
}

export const useSupport = () => useContext(SupportContext)
