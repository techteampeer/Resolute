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
      if (rows) setMessages(rows.map(r => ({ id: r.id, clientCode: r.clientCode, orderId: r.orderId || null, from: r.from, text: r.body, author: r.author, attachment: r.attachment || null, visibility: r.visibility, time: r.time, at: r.at })))
    })
    reload()
    unsub = subscribeSupport(reload)
    return () => unsub()
  }, [user?.email, user?.demo])

  useEffect(() => { if (!isSupabaseConfigured) save(messages) }, [messages])

  // Communication policy (enforced in RLS, mirrored here so the UI matches):
  //   • Clients write to their own thread, always client-visible.
  //   • ONLY admins reply to clients.
  //   • Every other staff role is read-only on the client conversation and may
  //     write 'internal' notes, which clients can never see.
  const isAdmin = user?.role === 'admin'
  const isStaff = Boolean(user?.role) && user.role !== 'client'
  const canReplyToClient = isAdmin
  const canAddInternalNote = isStaff

  // orderId null → general Support thread; set → that order's inbox.
  // A message may carry a single `attachment` ({ name, type, path }); a body OR
  // an attachment is enough to send.
  const sendMessage = ({ clientCode, clientName, from, text, author, orderId = null, attachment = null, visibility = 'client' }) => {
    const body = (text || '').trim()
    if (!clientCode || (!body && !attachment)) return
    // Guard before the write so a non-admin never sees a phantom reply that RLS
    // is going to reject anyway.
    if (from === 'support' && visibility === 'client' && !canReplyToClient) return
    if (visibility === 'internal' && !canAddInternalNote) return
    const optimistic = { id: mid(), clientCode, orderId: orderId || null, from, text: body, author: author || null, attachment: attachment || null, visibility, time: nowLabel(), at: Date.now() }
    setMessages(prev => [...prev, optimistic])
    if (isSupabaseConfigured) {
      insertSupportMessage({ clientCode, sender: from, author, body, orderId, attachment, visibility })
        .then(() => fetchSupportMessages())
        .then(rows => { if (rows) setMessages(rows.map(r => ({ id: r.id, clientCode: r.clientCode, orderId: r.orderId || null, from: r.from, text: r.body, author: r.author, attachment: r.attachment || null, visibility: r.visibility, time: r.time, at: r.at }))) })
        // Rejected by RLS (or offline) — drop the optimistic row again.
        .catch(() => setMessages(prev => prev.filter(m => m.id !== optimistic.id)))
    }
  }

  // ── General Support (untagged) ──────────────────────────────────────────────
  // Internal notes never count as part of the client conversation, so they
  // don't skew thread lists or the "awaiting reply" badge.
  const general = () => messages.filter(m => !m.orderId && m.visibility !== 'internal')
  const getThread = (clientCode) => {
    const msgs = general().filter(m => m.clientCode === clientCode).sort((a, b) => a.at - b.at)
    return msgs.length ? { clientCode, clientName: nameForCode(clientCode) || clientCode, messages: msgs } : null
  }
  const threadList = () => threadsByClient(general())
  const awaitingReply = (t) => { const m = t.messages[t.messages.length - 1]; return m && m.from === 'client' }
  const pendingCount = () => threadList().filter(awaitingReply).length

  // ── Per-order inbox ─────────────────────────────────────────────────────────
  // The client conversation on an order (what clients see; staff read-only
  // unless admin). Internal notes are requested separately.
  const getOrderThread = (orderId) =>
    messages.filter(m => m.orderId === orderId && m.visibility !== 'internal').sort((a, b) => a.at - b.at)
  const getOrderNotes = (orderId) =>
    messages.filter(m => m.orderId === orderId && m.visibility === 'internal').sort((a, b) => a.at - b.at)
  // Orders (by id) that have a client message awaiting a staff reply.
  const ordersAwaitingReply = () => {
    const byOrder = {}
    for (const m of messages.filter(m => m.orderId && m.visibility !== 'internal')) {
      if (!byOrder[m.orderId] || m.at > byOrder[m.orderId].at) byOrder[m.orderId] = m
    }
    return Object.entries(byOrder).filter(([, m]) => m.from === 'client').map(([id]) => id)
  }

  return (
    <SupportContext.Provider value={{
      messages, sendMessage, getThread, threadList, awaitingReply, pendingCount,
      getOrderThread, getOrderNotes, ordersAwaitingReply,
      canReplyToClient, canAddInternalNote,
    }}>
      {children}
    </SupportContext.Provider>
  )
}

export const useSupport = () => useContext(SupportContext)
