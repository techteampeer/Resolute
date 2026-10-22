import { useState, useEffect, useCallback } from 'react'
import { isSupabaseConfigured, fetchContacts, saveContact, deleteContact } from './backend'

// Per-company people directory, scoped to one client_code. Backs the intake
// "Placed by" selector (and, later, Company Settings). RLS already limits what a
// caller sees (own company, or all for an admin; production users: nothing), so
// this hook just fetches the current client's people and can add/update one.
//
// Mock mode (no backend): an in-memory store keyed by client_code so "add a
// person inline, then select them" works for the demo/mock path. It resets on
// reload — acceptable, since mock data is not durable anyway.
const mockStore = new Map()   // clientCode -> contact[]
let mockSeq = 1

export function useContacts(clientCode) {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!clientCode) { setContacts([]); return }
    if (!isSupabaseConfigured) { setContacts(mockStore.get(clientCode) || []); return }
    setLoading(true)
    const rows = await fetchContacts(clientCode)
    setLoading(false)
    if (rows) setContacts(rows)
  }, [clientCode])

  useEffect(() => { load() }, [load])

  // Add a new contact (no id) or update an existing one. Returns the saved
  // contact (with its id) so the caller can immediately select it.
  const save = useCallback(async (contact) => {
    if (!clientCode) return null
    const c = { ...contact, clientCode }
    if (!isSupabaseConfigured) {
      const list = mockStore.get(clientCode) || []
      const saved = c.id ? c : { ...c, id: `CT-${mockSeq++}` }
      mockStore.set(clientCode, c.id ? list.map(x => (x.id === c.id ? saved : x)) : [...list, saved])
      setContacts(mockStore.get(clientCode))
      return saved
    }
    const r = await saveContact(c)
    if (r && r.ok && r.contact) { await load(); return r.contact }
    return null
  }, [clientCode, load])

  // Remove a contact from the directory (manage People in Company Settings).
  const remove = useCallback(async (id) => {
    if (!id) return false
    if (!isSupabaseConfigured) {
      const list = (mockStore.get(clientCode) || []).filter(x => x.id !== id)
      mockStore.set(clientCode, list); setContacts(list); return true
    }
    const r = await deleteContact(id)
    if (r && r.ok) { await load(); return true }
    return false
  }, [clientCode, load])

  return { contacts, loading, save, remove, reload: load }
}
