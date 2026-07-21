import React, { createContext, useContext, useState, useEffect } from 'react'

// Client ⇄ Admin support messaging. Test-report clarification: client support
// messages route to an in-portal Admin inbox (not email). Mock-first with
// localStorage persistence so threads survive reloads within a browser; a
// Supabase-backed store can slot in later behind the same API (mirrors the
// isSupabaseConfigured pattern used elsewhere).
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

export function SupportProvider({ children }) {
  // threads: { [clientCode]: { clientCode, clientName, messages: [...], updatedAt } }
  const [threads, setThreads] = useState(load)

  useEffect(() => { save(threads) }, [threads])

  // Append a message to a client's thread (created on first message).
  const sendMessage = ({ clientCode, clientName, from, text, author }) => {
    const body = (text || '').trim()
    if (!clientCode || !body) return
    setThreads(prev => {
      const existing = prev[clientCode] || { clientCode, clientName: clientName || clientCode, messages: [] }
      const msg = { id: mid(), from, text: body, author: author || null, time: nowLabel(), at: Date.now() }
      return { ...prev, [clientCode]: { ...existing, clientName: clientName || existing.clientName, messages: [...existing.messages, msg], updatedAt: msg.at } }
    })
  }

  const getThread = (clientCode) => threads[clientCode] || null
  // Newest-active first; threads whose last message is from the client are
  // "awaiting reply" (surfaced as the Admin unread indicator).
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
