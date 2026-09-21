import React, { createContext, useContext, useState, useEffect } from 'react'
import { ORDERS, ACTIVITY } from '../data/mockData'
// The order state machine is now the portable domain core (packages/domain).
// This context keeps the side effects (setState, persistence, logging) and
// delegates every state transition to these pure functions.
import {
  applyAssign, applyCompleteStep, applyReturnToAdmin, applyClientCancel, applyResolveCancel,
  STAGE_BY_ROLE, todayISO,
} from '@domain'
import { isSupabaseConfigured, fetchOrders, saveOrder, subscribeOrders, insertOrder, fetchActivity, logEvent, nextOrderId, markOrderPayment, cancelOrderRpc, respondClarificationRpc } from '../lib/backend'
import { useAuth } from './AuthContext'

const OrderContext = createContext(null)

export function OrderProvider({ children }) {
  const { user } = useAuth()
  const [orders, setOrders]           = useState(ORDERS)
  const [activityLog, setActivityLog] = useState(ACTIVITY)
  // Why the last order write was refused, or null. A write filtered out by RLS
  // comes back from PostgREST as 200 with zero rows, so completing a stage on an
  // order that is no longer yours looked identical to succeeding — the optimistic
  // local update stayed on screen and the work was silently discarded.
  const [writeError, setWriteError]   = useState(null)

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
    // Only staff may append to the durable trail — order_events_insert is
    // is_staff(). Everything a client does is recorded by the database itself
    // (log_order_created() on placement, client_cancel_order() and
    // client_mark_payment() for the rest), so attempting the insert from a
    // client session added nothing and put a 403 in the console on every single
    // order placed.
    if (isSupabaseConfigured && user?.role && user.role !== 'client') logEvent({
      orderId: entry.orderId, action: entry.action, type: entry.type, actor: entry.actor,
      // Whoever performed the action does not need to be told about it.
      actorEmail: entry.actorEmail || user?.email || null,
      audience: entry.audience || 'staff',
    })
  }
  const persist = (order) => {
    if (!isSupabaseConfigured) return
    saveOrder(order)
      .then(r => setWriteError(r && r.ok === false ? (r.error || 'not saved') : null))
      .catch(e => setWriteError(e.message))
  }
  const clearWriteError = () => setWriteError(null)

  const assignOrder = (orderId, { queue, personName } = {}) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const next = applyAssign(o, { queue, personName })
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, action: `Admin assigned ${orderId} to ${queue}${personName ? ` · ${personName}` : ''}`, time: 'Just now', type: 'status', audience: 'staff' })
  }

  // `extra` merges into workflow as part of the SAME write as the stage move.
  // Callers used to do updateOrder() for their documents and then completeStep()
  // for the move, as two independent un-awaited PATCHes; whichever landed last
  // won, and the updateOrder one carries the pre-move status. It only ever
  // appeared to work because RLS refused the stale write once the move took the
  // order off the caller's desk (orders_update_assigned), which is not
  // protection — it is luck, and it runs out for anyone with a broader policy.
  const completeStep = (orderId, role, userName, notes, extra = {}) => {
    let advancedTo = null
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const { next, advancedTo: adv } = applyCompleteStep(o, role, userName, extra)
      advancedTo = adv
      persist(next)
      return next
    }))
    log({
      id: Date.now(), orderId, actor: userName,
      action: `${userName} completed ${STAGE_BY_ROLE[role] || role} on ${orderId}`
        + (advancedTo ? ` → handed to ${advancedTo}` : ' → delivered') + (notes ? ` (${notes})` : ''),
      time: 'Just now', type: 'progress',
      audience: advancedTo ? 'staff' : 'all',
    })
  }

  // A role finishes its stage and hands the order BACK to Admin to assign the
  // next stage (screener → admin, examiner → admin). Stamps completion + saves
  // any workflow data (assignment choice, uploaded doc), advances status, and
  // parks the order in the Admin queue (assignedTo = 'admin').
  const returnToAdmin = (orderId, role, userName, notes, extra = {}) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const { next } = applyReturnToAdmin(o, role, userName, extra)
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, actor: userName, action: `${userName} completed ${STAGE_BY_ROLE[role] || role} on ${orderId} → returned to Admin for assignment` + (notes ? ` (${notes})` : ''), time: 'Just now', type: 'status', audience: 'staff' })
  }

  const updateOrder = (updated) => {
    setOrders(os => os.map(o => (o.id === updated.id ? updated : o)))
    persist(updated)
  }

  // Record an admin action in the durable audit trail. Hold, resume and
  // clarification all changed the row and messaged the client but wrote no
  // order_events row, so none of them appeared in the order's history.
  const logAction = ({ orderId, action, type = 'status', audience = 'all', actor }) =>
    log({ id: Date.now(), orderId, actor, action, time: 'Just now', type, audience })

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
    // The cancel policy (free until screening) lives in the domain core; take the
    // resulting mode from it rather than re-deriving the rule here.
    const mode = target ? applyClientCancel(target, actor).mode : 'requested'
    // Optimistic local update (same pure transition).
    setOrders(os => os.map(o => (o.id === orderId ? applyClientCancel(o, actor).next : o)))
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
      const next = applyResolveCancel(o, approve)
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, actor, action: `${actor} ${approve ? 'approved' : 'declined'} cancellation of ${orderId}`, time: 'Just now', type: 'status', audience: 'all' })
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
      // The client's own reference. Display only — it leads the subject line of
      // every notification so the team can match mail to the client's system.
      clientFileNo: (data.clientFileNo || '').trim() || null,
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
    log({ id: Date.now(), orderId: order.id, action: `New order ${order.id} placed (${order.type})`, time: 'Just now', type: 'new', audience: 'all' })
    return order
  }

  const getOrdersForRole = (role) => orders.filter(o => o.assignedTo === role)

  return (
    <OrderContext.Provider value={{ orders, activityLog, writeError, clearWriteError, assignOrder, completeStep, returnToAdmin, updateOrder, logAction, markPayment, respondClarification, createOrder, cancelOrder, resolveCancel, getOrdersForRole }}>
      {children}
    </OrderContext.Provider>
  )
}

export const useOrders = () => useContext(OrderContext)
