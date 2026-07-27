import React, { createContext, useContext, useState, useEffect } from 'react'
import { clientName as nameForCode } from '../data/mockData'
import { isSupabaseConfigured, fetchSupportMessages, insertSupportMessage, subscribeSupport } from '../lib/backend'
import { useAuth } from './AuthContext'

// Client ⇄ Admin messaging. Two flavours share one store (support_messages):
//   • General Support thread   — message.orderId == null
//   • Per-order "Client Inbox" — message.orderId == <order id>
//
// Persistence follows the app's isSupabaseConfigured seam:
//   • Supabase on  → support_messages table (RLS-scoped, realtime).
//   • Supabase off → flat message list persisted to localStorage (per-browser).
const SupportContext = createContext(null)
const STORE_KEY = 'resolute:support:v2'

const load = () => {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
const save = (msgs) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(msgs)) } catch { /* quota */ } }
const nowLabel = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const mid = () => Math.random().toString(36).slice(2, 10)

// Group messages (optionally filtered) into per-client threads, newest-active first.
const threadsByClient = (msgs) => {
  const out = {}
  for (const m of msgs) {
    const code = m.clientCode
    if (!out[code]) out[code] = { clientCode: code, clientName: nameForCode(code) || code, messages: [] }
    out[code].messages.push(m)
    out[code].updatedAt = Math.max(out[code].updatedAt || 0, m.at || 0)
  }
  return Object.values(out).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function SupportProvider({ children }) {
  const { user } = useAuth()
  // Flat list: { id, clientCode, orderId, from, text, author, time, at }
  const [messages, setMessages] = useState(() => (isSupabaseConfigured ? [] : load()))

  // Supabase: hydrate + live updates once authenticated. Mock: persist locally.
  useEffect(() => {
    if (!isSupabaseConfigured || !user || user.demo) return
    let unsub = () => {}
    const reload = () => fetchSupportMessages().then(rows => {
      if (rows) setMessages(rows.map(r => ({ id: r.id, clientCode: r.clientCode, orderId: r.orderId || null, from: r.from, text: r.body, author: r.author, time: r.time, at: r.at })))
    })
    reload()
    unsub = subscribeSupport(reload)
    return () => unsub()
  }, [user?.email, user?.demo])

  useEffect(() => { if (!isSupabaseConfigured) save(messages) }, [messages])

  // orderId null → general Support thread; set → that order's inbox.
  const sendMessage = ({ clientCode, clientName, from, text, author, orderId = null }) => {
    const body = (text || '').trim()
    if (!clientCode || !body) return
    const optimistic = { id: mid(), clientCode, orderId: orderId || null, from, text: body, author: author || null, time: nowLabel(), at: Date.now() }
    setMessages(prev => [...prev, optimistic])
    if (isSupabaseConfigured) {
      insertSupportMessage({ clientCode, sender: from, author, body, orderId })
        .then(() => fetchSupportMessages())
        .then(rows => { if (rows) setMessages(rows.map(r => ({ id: r.id, clientCode: r.clientCode, orderId: r.orderId || null, from: r.from, text: r.body, author: r.author, time: r.time, at: r.at }))) })
    }
  }

  // ── General Support (untagged) ──────────────────────────────────────────────
  const general = () => messages.filter(m => !m.orderId)
  const getThread = (clientCode) => {
    const msgs = general().filter(m => m.clientCode === clientCode).sort((a, b) => a.at - b.at)
    return msgs.length ? { clientCode, clientName: nameForCode(clientCode) || clientCode, messages: msgs } : null
  }
  const threadList = () => threadsByClient(general())
  const awaitingReply = (t) => { const m = t.messages[t.messages.length - 1]; return m && m.from === 'client' }
  const pendingCount = () => threadList().filter(awaitingReply).length

  // ── Per-order inbox ─────────────────────────────────────────────────────────
  const getOrderThread = (orderId) =>
    messages.filter(m => m.orderId === orderId).sort((a, b) => a.at - b.at)
  // Orders (by id) that have a client message awaiting a staff reply.
  const ordersAwaitingReply = () => {
    const byOrder = {}
    for (const m of messages.filter(m => m.orderId)) {
      if (!byOrder[m.orderId] || m.at > byOrder[m.orderId].at) byOrder[m.orderId] = m
    }
    return Object.entries(byOrder).filter(([, m]) => m.from === 'client').map(([id]) => id)
  }

  return (
    <SupportContext.Provider value={{ messages, sendMessage, getThread, threadList, awaitingReply, pendingCount, getOrderThread, ordersAwaitingReply }}>
      {children}
    </SupportContext.Provider>
  )
}

export const useSupport = () => useContext(SupportContext)
