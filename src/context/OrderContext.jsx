import React, { createContext, useContext, useState, useEffect } from 'react'
import { ORDERS, ACTIVITY, nextRoleFor, statusForRole } from '../data/mockData'
import { isSupabaseConfigured, fetchOrders, saveOrder, subscribeOrders, insertOrder, fetchActivity, logEvent, nextOrderId, markOrderPayment, cancelOrderRpc, respondClarificationRpc } from '../lib/backend'
import { useAuth } from './AuthContext'

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
  const { user } = useAuth()
  const [orders, setOrders]           = useState(ORDERS)
  const [activityLog, setActivityLog] = useState(ACTIVITY)

  // Hydrate from Supabase + live updates when configured; otherwise keep mock.
  // Keyed on the signed-in identity: the provider mounts on the login page
  // (before auth), so the first fetch would run as anon and RLS would return
  // nothing. Re-running when the user resolves ensures the just-logged-in user
  // actually sees their own rows. Demo users have no backend session — skip.
  useEffect(() => {
    if (!isSupabaseConfigured || !user || user.demo) return
    let unsub = () => {}
    const load = () => fetchOrders().then(rows => { if (rows) setOrders(rows) })
    load()
    fetchActivity().then(rows => { if (rows) setActivityLog(rows) })
    unsub = subscribeOrders(load)
    return () => unsub()
  }, [user?.email, user?.demo])

  // Local activity feed + best-effort append to the durable order_events audit
  // trail (orderId/actor ride on the entry when the caller knows them).
  const log = (entry) => {
    setActivityLog(a => [entry, ...a])
    if (isSupabaseConfigured) logEvent({ orderId: entry.orderId, action: entry.action, type: entry.type, actor: entry.actor })
  }
  const persist = (order) => { if (isSupabaseConfigured) saveOrder(order) }

  const assignOrder = (orderId, { queue, personName } = {}) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const next = { ...o, assignedTo: queue }
      // Routing to the Single Seating desk claims the order for that desk
      // end-to-end; routing to a stage role releases it back to the pipeline.
      if (queue === 'operator') next.workflow = { ...o.workflow, singleSeating: true }
      else if (['screener', 'examiner', 'typer', 'delivery'].includes(queue)) next.workflow = { ...o.workflow, singleSeating: false }
      if (personName) next[queue] = personName
      if (o.status == null || o.status === 'received') next.status = 'received'
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, action: `Admin assigned ${orderId} to ${queue}${personName ? ` · ${personName}` : ''}`, time: 'Just now', type: 'status' })
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
      id: Date.now(), orderId, actor: userName,
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
    log({ id: Date.now(), orderId, actor: userName, action: `${userName} completed ${STAGE_BY_ROLE[role] || role} on ${orderId} → returned to Admin for assignment` + (notes ? ` (${notes})` : ''), time: 'Just now', type: 'status' })
  }

  const updateOrder = (updated) => {
    setOrders(os => os.map(o => (o.id === updated.id ? updated : o)))
    persist(updated)
  }

  // Client marks an invoice paid. Clients can't UPDATE orders directly (RLS), so
  // persist through the client_mark_payment RPC; the row's other fields are
  // untouched. Staff/admin confirmation still flows through updateOrder.
  const markPayment = (order, payment) => {
    const next = { ...order, workflow: { ...order.workflow, payment } }
    setOrders(os => os.map(o => (o.id === order.id ? next : o)))
    if (isSupabaseConfigured) markOrderPayment(order.id, payment).catch(() => {})
    return next
  }

  // BUG_003: client-initiated cancellation. Policy = free until screening starts.
  // While the order is still 'received' (nothing worked yet) the client cancels
  // outright; once any stage is underway it becomes a request parked for Admin.
  const cancelOrder = (orderId, actor = 'Client') => {
    const target = orders.find(o => o.id === orderId)
    const fresh = target?.status === 'received'
    const mode = fresh ? 'cancelled' : 'requested'
    // Optimistic local update.
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      return fresh
        ? { ...o, status: 'cancelled', assignedTo: null, progress: 0, workflow: { ...o.workflow, cancelRequested: null } }
        : { ...o, workflow: { ...o.workflow, cancelRequested: { by: actor, at: todayISO() } } }
    }))
    // Durable persistence: clients can't UPDATE orders (RLS), so go through the
    // SECURITY DEFINER RPC, which also records the order_events row that shows up
    // in Admin's notifications. Mock mode just keeps the local update.
    if (isSupabaseConfigured) cancelOrderRpc(orderId).catch(() => {})
    // Local activity feed only — the RPC writes the durable event (a client
    // logEvent insert would be denied by RLS).
    setActivityLog(a => [{
      id: Date.now(), orderId, actor,
      action: mode === 'cancelled'
        ? `${actor} cancelled ${orderId} before screening`
        : `${actor} requested cancellation of ${orderId} — awaiting Admin approval`,
      time: 'Just now', type: 'status',
    }, ...a])
    return mode
  }

  // Client responds to a pending clarification (RLS-safe RPC; own order only).
  const respondClarification = (orderId) => {
    setOrders(os => os.map(o => (o.id === orderId ? { ...o, clarification: 'responded' } : o)))
    if (isSupabaseConfigured) respondClarificationRpc(orderId).catch(() => {})
  }

  // Admin resolves a pending cancellation request (approve = cancel the order).
  const resolveCancel = (orderId, approve, actor = 'Admin') => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const next = approve
        ? { ...o, status: 'cancelled', assignedTo: null, progress: 0, workflow: { ...o.workflow, cancelRequested: null } }
        : { ...o, workflow: { ...o.workflow, cancelRequested: null } }
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, actor, action: `${actor} ${approve ? 'approved' : 'declined'} cancellation of ${orderId}`, time: 'Just now', type: 'status' })
  }

  // Create a new order (client "Place an Order"). It parks with Admin for
  // confirmation (assignedTo 'admin', unconfirmed) rather than going straight to
  // the screener — Admin acknowledges/prices it, then forwards to a screener.
  // ID comes from the DB sequence when Supabase is on (two simultaneous orders
  // can't collide); the local max()+1 is the mock fallback.
  const createOrder = async (data = {}) => {
    let id = isSupabaseConfigured ? await nextOrderId() : null
    if (!id) {
      const max = orders.reduce((m, o) => {
        const n = parseInt(String(o.id).replace(/\D/g, ''), 10)
        return Number.isNaN(n) ? m : Math.max(m, n)
      }, 10048)
      id = `RTS-${max + 1}`
    }
    const order = {
      id,
      // Attribute the order to the placing client so it appears in their
      // My Orders (clientCode scoping) and satisfies/readbacks under RLS.
      client: data.client || 'Web Order',
      clientCode: data.clientCode || null,
      state: data.state || '', county: data.county || '', type: data.type || 'Full Search',
      status: 'received', priority: data.priority || 'normal', payment: data.payment || 'Check',
      clarification: null, assignedTo: 'admin',
      screener: null, examiner: null, typer: null, delivery: null,
      progress: 5, created: todayISO(), eta: data.eta || '', completed: null,
      completedDates: {}, completedBy: {},
      workflow: { intake: { source: 'web', ...(data.intake || {}) } },
    }
    setOrders(os => [order, ...os])
    // Await the insert so the row exists before the caller uploads any
    // attachments — the documents storage policy authorizes a client upload by
    // checking that the order (path orders/<id>/…) belongs to them.
    if (isSupabaseConfigured) await insertOrder(order)
    log({ id: Date.now(), orderId: order.id, action: `New order ${order.id} placed (${order.type})`, time: 'Just now', type: 'new' })
    return order
  }

  const getOrdersForRole = (role) => orders.filter(o => o.assignedTo === role)

  return (
    <OrderContext.Provider value={{ orders, activityLog, assignOrder, completeStep, returnToAdmin, updateOrder, markPayment, respondClarification, createOrder, cancelOrder, resolveCancel, getOrdersForRole }}>
      {children}
    </OrderContext.Provider>
  )
}

export const useOrders = () => useContext(OrderContext)
