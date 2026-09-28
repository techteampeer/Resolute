import React, { createContext, useContext, useState, useEffect } from 'react'
import { ORDERS, ACTIVITY } from '../data/mockData'
// The order state machine is now the portable domain core (packages/domain).
// This context keeps the side effects (setState, persistence, logging) and
// delegates every state transition to these pure functions.
import {
  applyAssign, applyCompleteStep, applyReturnToAdmin, applyClientCancel, applyResolveCancel,
  applySingleSeatStep, applyReassign, applyPartialHandoff,
  STAGE_BY_ROLE, todayISO,
} from '@domain'
import { isSupabaseConfigured, fetchOrders, fetchOrderById, saveOrder, subscribeOrders, insertOrder, fetchActivity, logEvent, nextOrderId, markOrderPayment, cancelOrderRpc, respondClarificationRpc } from '../lib/backend'
import { useAuth } from './AuthContext'

const OrderContext = createContext(null)

// Mock-mode order-id sequence. Module-scoped so it survives across createOrder
// calls that happen faster than React flushes state (e.g. a bulk import loop),
// where the closed-over `orders` array would otherwise yield the same max twice.
let mockIdSeq = null

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
    let alive = true
    let started = false          // snapshot fetch begun (once, after SUBSCRIBED)
    let hydrated = false         // snapshot applied
    const pending = new Set()    // ids that changed before the snapshot landed
    const gen = new Map()        // per-id generation: the newest event/read wins

    // Realtime applies DELTAS instead of re-reading the whole table. The old
    // handler re-ran fetchOrders() on every change, so N connected staff each
    // re-read every order on every write — O(N²) traffic that melts at ~100
    // concurrent. Now a change fetches only the row that changed (by id, RLS-
    // scoped, same client-name join) and upserts it, or drops it if it is gone.
    const bump = (id) => { const g = (gen.get(id) || 0) + 1; gen.set(id, g); return g }

    // Fetch this id's CURRENT row and apply it, unless a newer event superseded
    // this read (generation guard — prevents a slow read from resurrecting a
    // deleted row or applying stale data). A transient fetch error is ignored, so
    // a network blip is never mistaken for a delete.
    const refresh = (id) => {
      const g = bump(id)
      return fetchOrderById(id).then(res => {
        if (!alive || gen.get(id) !== g || res.error) return
        const row = res.row
        setOrders(os => {
          if (!row) return os.some(o => o.id === id) ? os.filter(o => o.id !== id) : os
          const i = os.findIndex(o => o.id === row.id)
          if (i === -1) return [row, ...os]
          const next = os.slice(); next[i] = row; return next
        })
      })
    }

    const onChange = (payload) => {
      const id = payload?.new?.id ?? payload?.old?.id
      if (!id) return
      // Before the snapshot lands, buffer ids — applying now would be clobbered by
      // the snapshot; they are replayed against the CURRENT state after hydrate.
      if (!hydrated) { pending.add(id); return }
      if (payload.eventType === 'DELETE') { bump(id); setOrders(os => os.filter(o => o.id !== id)); return }
      refresh(id)   // INSERT / UPDATE
    }

    // Start the snapshot only once the channel is actually SUBSCRIBED — before
    // that, postgres changes are not delivered, so a change would be neither seen
    // nor buffered. On a channel error/timeout, hydrate anyway (degraded realtime
    // beats an empty screen). Either way it runs once.
    const startHydrate = () => {
      if (started) return
      started = true
      fetchOrders().then(rows => {
        if (!alive) return
        if (rows) setOrders(rows)
        hydrated = true
        pending.forEach(refresh)   // replay changes that raced the snapshot
        pending.clear()
      })
    }
    const unsub = subscribeOrders(onChange, (status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') startHydrate()
    })
    // Safety net: if the channel never reports a status (realtime down/misconfig),
    // hydrate anyway after a moment so data still loads (startHydrate is idempotent).
    const fallback = setTimeout(startHydrate, 3000)
    fetchActivity().then(rows => { if (alive && rows) setActivityLog(rows) })
    return () => { alive = false; clearTimeout(fallback); unsub() }
    // Keyed on identity, not the whole `user` object: re-subscribe only when who's
    // logged in actually changes, never on every render that hands us a fresh ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const assignOrder = (orderId, { queue, personName, userId } = {}) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const next = applyAssign(o, { queue, personName, userId })
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, action: `Admin assigned ${orderId} to ${personName || queue}`, time: 'Just now', type: 'status', audience: 'staff' })
  }

  // Admin reassigns an order to a different production user (cover an absence,
  // rebalance workload). Keeps the pipeline position; admin writes bypass the
  // handoff guard, so this may set the owner directly.
  const reassign = (orderId, toUserId, toName) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const next = applyReassign(o, toUserId)
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, action: `Admin reassigned ${orderId}${toName ? ` to ${toName}` : ''}`, time: 'Just now', type: 'status', audience: 'staff' })
  }

  // Single-seating: the owner completes a stage and CONTINUES on the same order
  // with no Admin gate (A1). Delivery completes the order. Mirrors completeStep
  // but keeps the order with the same production user between stages.
  const advanceInSeat = (orderId, role, userName, notes, extra = {}) => {
    let advancedTo = null
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const { next, advancedTo: adv } = applySingleSeatStep(o, role, userName, extra)
      advancedTo = adv
      persist(next)
      return next
    }))
    log({
      id: Date.now(), orderId, actor: userName,
      action: `${userName} completed ${STAGE_BY_ROLE[role] || role} on ${orderId}`
        + (advancedTo ? ` → continuing to ${STAGE_BY_ROLE[advancedTo] || advancedTo}` : ' → delivered') + (notes ? ` (${notes})` : ''),
      time: 'Just now', type: 'progress',
      audience: advancedTo ? 'staff' : 'all',
    })
  }

  // A production user hands a partially-completed order back to Admin with an
  // internal note (they can't finish it); Admin then reassigns it. No stage is
  // stamped. Handoffs route through Admin, never user-to-user.
  const partialHandoff = (orderId, note, userName) => {
    setOrders(os => os.map(o => {
      if (o.id !== orderId) return o
      const next = applyPartialHandoff(o, note, userName)
      persist(next)
      return next
    }))
    log({ id: Date.now(), orderId, actor: userName, action: `${userName} handed ${orderId} back to Admin` + (note ? ` (${note})` : ''), time: 'Just now', type: 'status', audience: 'staff' })
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
      // Seed the monotonic sequence once from the current max, then increment —
      // so a rapid loop can't collide before setOrders flushes.
      if (mockIdSeq === null) {
        mockIdSeq = orders.reduce((m, o) => {
          const n = parseInt(String(o.id).replace(/\D/g, ''), 10)
          return Number.isNaN(n) ? m : Math.max(m, n)
        }, 10048)
      }
      mockIdSeq += 1
      id = `RTS-${mockIdSeq}`
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
    <OrderContext.Provider value={{ orders, activityLog, writeError, clearWriteError, assignOrder, reassign, advanceInSeat, partialHandoff, completeStep, returnToAdmin, updateOrder, logAction, markPayment, respondClarification, createOrder, cancelOrder, resolveCancel, getOrdersForRole }}>
      {children}
    </OrderContext.Provider>
  )
}

export const useOrders = () => useContext(OrderContext)
