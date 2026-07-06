import React, { createContext, useContext, useState, useEffect } from 'react'
import { ORDERS, ACTIVITY, nextRoleFor, statusForRole } from '../data/mockData'
import { isSupabaseConfigured, fetchOrders, saveOrder, subscribeOrders, insertOrder } from '../lib/backend'

const OrderContext = createContext(null)

// Status follows the owning role, so it advances one stage at a time in order.
const PIPELINE = ['received', 'screening', 'examining', 'typing', 'delivery', 'delivered']
const progressFor = (status) => {
  const i = PIPELINE.indexOf(status)
  return i <= 0 ? (status === 'received' ? 5 : 0) : Math.round((i / (PIPELINE.length - 1)) * 100)
}
const STAGE_BY_ROLE = { screener: 'screening', examiner: 'examination', typer: 'typing', delivery: 'delivery' }
const todayISO = () => new Date().toISOString().slice(0, 10)

export function OrderProvider({ children }) {
  const [orders, setOrders]           = useState(ORDERS)
  const [activityLog, setActivityLog] = useState(ACTIVITY)

  // Hydrate from Supabase + live updates when configured; otherwise keep mock.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let unsub = () => {}
    const load = () => fetchOrders().then(rows => { if (rows) setOrders(rows) })
    load()
    unsub = subscribeOrders(load)
    return () => unsub()
  }, [])

  const log = (entry) => setActivityLog(a => [entry, ...a])
  const persist = (order) => { if (isSupabaseConfigured) saveOrder(order) }

  const assignOrder = (orderId, { queue, personName } = {}) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const next = { ...o, assignedTo: queue }
      if (personName) next[queue] = personName
      if (o.status == null || o.status === 'received') next.status = 'received'
      persist(next)
      return next
    }))
    log({ id: Date.now(), action: `Admin assigned ${orderId} to ${queue}${personName ? ` · ${personName}` : ''}`, time: 'Just now', type: 'status' })
  }

  let advancedTo = null
  const completeStep = (orderId, role, userName, notes) => {
    advancedTo = null
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const newDates = { ...o.completedDates, [role]: todayISO() }
      const nextRole = nextRoleFor({ completedDates: newDates })
      advancedTo = nextRole
      const allDone = nextRole === null
      const nextStatus = statusForRole(nextRole)   // owner and status stay in lockstep
      const next = {
        ...o, status: nextStatus, assignedTo: nextRole,
        progress: allDone ? 100 : progressFor(nextStatus),
        completed: allDone ? (o.completed || todayISO()) : o.completed,
        completedDates: newDates, completedBy: { ...o.completedBy, [role]: userName },
      }
      persist(next)
      return next
    }))
    log({
      id: Date.now(),
      action: `${userName} completed ${STAGE_BY_ROLE[role] || role} on ${orderId}`
        + (advancedTo ? ` → handed to ${advancedTo}` : ' → delivered') + (notes ? ` (${notes})` : ''),
      time: 'Just now', type: 'progress',
    })
  }

  // A role finishes its stage and hands the order BACK to Admin to assign the
  // next stage (screener → admin, examiner → admin). Stamps completion + saves
  // any workflow data (assignment choice, uploaded doc), advances status, and
  // parks the order in the Admin queue (assignedTo = 'admin').
  const returnToAdmin = (orderId, role, userName, notes, extra = {}) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const newDates = { ...o.completedDates, [role]: todayISO() }
      const nextStatus = statusForRole(nextRoleFor({ completedDates: newDates }))
      const next = {
        ...o,
        status: nextStatus,
        assignedTo: 'admin',
        progress: progressFor(nextStatus),
        completedDates: newDates,
        completedBy: { ...o.completedBy, [role]: userName },
        workflow: { ...o.workflow, ...extra },
      }
      persist(next)
      return next
    }))
    log({ id: Date.now(), action: `${userName} completed ${STAGE_BY_ROLE[role] || role} on ${orderId} → returned to Admin for assignment` + (notes ? ` (${notes})` : ''), time: 'Just now', type: 'status' })
  }

  const updateOrder = (updated) => {
    setOrders(os => os.map(o => (o.id === updated.id ? updated : o)))
    persist(updated)
  }

  // Create a new draft order (client "Place an Order"). New orders are HELD
  // with Admin for the quote/price discussion — production (Screener) only
  // sees them after the client accepts and Admin sends the confirmation.
  const createOrder = (data = {}) => {
    const max = orders.reduce((m, o) => {
      const n = parseInt(String(o.id).replace(/\D/g, ''), 10)
      return Number.isNaN(n) ? m : Math.max(m, n)
    }, 10048)
    const order = {
      id: `RTS-${max + 1}`,
      client: data.client || 'Web Order',
      state: data.state || '', county: data.county || '', type: data.type || 'Full Search',
      status: 'received', priority: data.priority || 'normal', payment: data.payment || 'Check',
      clarification: null, assignedTo: 'admin',
      screener: null, examiner: null, typer: null, delivery: null,
      progress: 5, created: todayISO(), eta: data.eta || '', completed: null,
      completedDates: {}, completedBy: {},
      workflow: {
        intake: { source: 'web', ...(data.intake || {}) },
        quote: { stage: 'pending', amount: null, thread: [] },
      },
    }
    setOrders(os => [order, ...os])
    if (isSupabaseConfigured) insertOrder(order)
    log({ id: Date.now(), action: `New order ${order.id} placed (${order.type})`, time: 'Just now', type: 'new' })
    return order
  }

  const getOrdersForRole = (role) => orders.filter(o => o.assignedTo === role)

  return (
    <OrderContext.Provider value={{ orders, activityLog, assignOrder, completeStep, returnToAdmin, updateOrder, createOrder, getOrdersForRole }}>
      {children}
    </OrderContext.Provider>
  )
}

export const useOrders = () => useContext(OrderContext)
