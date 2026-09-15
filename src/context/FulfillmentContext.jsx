import React, { createContext, useContext, useState, useRef, useCallback } from 'react'
import { makeDefaultFulfillment, hydrateFulfillment } from '../data/fulfillment'
import { isBackendConfigured, fetchFulfillment, saveFulfillment } from '../lib/backend'

// Per-order Typer fulfillment state with a transient autosave indicator.
// Persists to Supabase (fulfillments.data JSONB) when configured; otherwise
// in-memory mock that survives navigation within the session.
const FulfillmentContext = createContext(null)

export function FulfillmentProvider({ children }) {
  const [byOrder, setByOrder] = useState({})       // { [orderId]: fulfillment }
  const [save, setSave]       = useState('idle')   // 'idle' | 'saving' | 'saved' | 'error'
  const [saveError, setError] = useState(null)     // why the last write was refused
  const pulseTimer = useRef(null)
  const saveTimers = useRef({})                    // per-order debounce for backend writes
  const loaded     = useRef(new Set())             // orders already fetched/seeded

  const ensure = useCallback((order) => {
    if (loaded.current.has(order.id)) return
    loaded.current.add(order.id)
    if (isBackendConfigured) {
      fetchFulfillment(order.id).then(data => {
        if (data) { setByOrder(s => ({ ...s, [order.id]: hydrateFulfillment(order, data) })) }
        else { const def = makeDefaultFulfillment(order); setByOrder(s => ({ ...s, [order.id]: def })); saveFulfillment(order.id, def) }
      })
    } else {
      setByOrder(s => (s[order.id] ? s : { ...s, [order.id]: makeDefaultFulfillment(order) }))
    }
  }, [])

  // 'saved' is now only shown once the row has actually moved. It used to flip on
  // a 550ms timer whether or not the write landed, so a refused save (RLS returns
  // 200 with zero rows) read as success and an hour of typing could be lost.
  const pulse = useCallback(() => {
    setSave('saving')
    clearTimeout(pulseTimer.current)
  }, [])
  const settle = useCallback((res) => {
    if (res && res.ok === false) { setError(res.error || 'not saved'); setSave('error'); return }
    setError(null)
    setSave('saved')
  }, [])

  const update = useCallback((orderId, recipe) => {
    setByOrder(s => {
      // Never write a recipe applied to nothing: `{ ...undefined, x: 1 }` is a
      // valid object, so an edit that arrived before the row finished loading
      // would have replaced a full commitment with a one-key payload.
      if (!s[orderId]) return s
      const next = recipe(s[orderId])
      if (isBackendConfigured) {
        clearTimeout(saveTimers.current[orderId])
        saveTimers.current[orderId] = setTimeout(
          () => saveFulfillment(orderId, next).then(settle).catch(e => settle({ ok: false, error: e.message })),
          700)
      }
      return { ...s, [orderId]: next }
    })
    pulse()
  }, [pulse])

  return (
    <FulfillmentContext.Provider value={{ byOrder, ensure, update, save, saveError }}>
      {children}
    </FulfillmentContext.Provider>
  )
}

export const useFulfillmentStore = () => useContext(FulfillmentContext)
