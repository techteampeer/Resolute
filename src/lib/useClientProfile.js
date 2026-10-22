import { useState, useEffect, useCallback } from 'react'
import { isSupabaseConfigured, fetchClientProfile, saveClientProfile } from './backend'

// The client-editable company profile (address / phone / website / logo), one
// row per company — the editable half of Company Settings (#13). Mock mode keeps
// it in an in-memory store so edits persist for the session.
const EMPTY = { address: '', city: '', state: '', zip: '', phone: '', website: '', logoUrl: '' }
const mockStore = new Map()   // clientCode -> profile

export function useClientProfile(clientCode) {
  const [profile, setProfile] = useState(EMPTY)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!clientCode) { setProfile(EMPTY); return }
    if (!isSupabaseConfigured) { setProfile(mockStore.get(clientCode) || EMPTY); return }
    setLoading(true)
    const row = await fetchClientProfile(clientCode)
    setLoading(false)
    setProfile(row || EMPTY)
  }, [clientCode])

  useEffect(() => { load() }, [load])

  const save = useCallback(async (next, updatedBy) => {
    if (!clientCode) return { ok: false }
    const p = { ...EMPTY, ...next }
    if (!isSupabaseConfigured) { mockStore.set(clientCode, p); setProfile(p); return { ok: true } }
    const r = await saveClientProfile(clientCode, { ...p, updatedBy })
    if (r && r.ok) { setProfile(r.profile || p); return { ok: true } }
    return { ok: false, error: r?.error }
  }, [clientCode])

  return { profile, loading, save }
}
