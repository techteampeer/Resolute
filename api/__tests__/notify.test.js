// Routing table for portal notifications. These assertions are the spec: who
// receives mail for each event. Runs without a database or SMTP by injecting
// the recipient resolvers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plansFromRecord } from '../notify.js'

const ADMINS  = 'rajni@x.com, vivek@x.com'
const CLIENT  = 'dana@lakewood.com'
const BY_ROLE = {
  screener: 'sam@x.com',
  examiner: 'jordan@x.com',
  typer:    'priya@x.com',
  delivery: 'morgan@x.com',
  operator: 'jb@x.com',
}

// assigned_to drives staff routing; client_code drives client routing.
const deps = (order = {}) => ({
  clientEmail: async (code) => (code ? CLIENT : null),
  adminEmails: async () => ADMINS,
  staffEmails: async (role) => (role === 'admin' ? ADMINS : BY_ROLE[role] || null),
  orderById:   async () => ({ client_code: 'CL01', type: 'Full Search', ...order }),
})

const to = (plans) => plans.map(p => p.to)

test('new order → admins only', async () => {
  const plans = await plansFromRecord('order_events',
    { order_id: 'RTS-1', type: 'new', action: 'New order RTS-1 placed', audience: 'all' },
    deps({ assigned_to: 'screener' }))
  assert.deepEqual(to(plans), [ADMINS])
})

test('handed to a stage → that stage’s staff, not the client', async () => {
  for (const role of ['screener', 'examiner', 'typer', 'delivery', 'operator']) {
    const plans = await plansFromRecord('order_events',
      { order_id: 'RTS-1', type: 'progress', action: 'completed → handed on', audience: 'staff' },
      deps({ assigned_to: role }))
    assert.deepEqual(to(plans), [BY_ROLE[role]], `${role} should be notified`)
    assert.match(plans[0].subject, /ready for/)
  }
})

test('staff deep link points at that portal’s order route', async () => {
  const [screener] = await plansFromRecord('order_events',
    { order_id: 'RTS-1', action: 'x', audience: 'staff' }, deps({ assigned_to: 'screener' }))
  assert.match(screener.link, /\/screener\/order\/RTS-1$/)
  // Single Seating uses the plural route; fulfillment owns /operator/order/:id.
  const [operator] = await plansFromRecord('order_events',
    { order_id: 'RTS-1', action: 'x', audience: 'staff' }, deps({ assigned_to: 'operator' }))
  assert.match(operator.link, /\/operator\/orders\/RTS-1$/)
})

test('returned for assignment → admins, asking them to assign', async () => {
  const plans = await plansFromRecord('order_events',
    { order_id: 'RTS-1', action: 'returned to Admin for assignment', audience: 'staff' },
    deps({ assigned_to: 'admin' }))
  assert.deepEqual(to(plans), [ADMINS])
  assert.match(plans[0].subject, /needs assignment/)
})

test('delivered (audience all) → client AND the owning staff', async () => {
  const plans = await plansFromRecord('order_events',
    { order_id: 'RTS-1', type: 'progress', action: 'completed delivery → delivered', audience: 'all' },
    deps({ assigned_to: 'delivery' }))
  assert.deepEqual(to(plans).sort(), [BY_ROLE.delivery, CLIENT].sort())
})

test('client-facing event never reaches staff', async () => {
  const plans = await plansFromRecord('order_events',
    { order_id: 'RTS-1', action: 'Clarification needed', audience: 'client' },
    deps({ assigned_to: 'screener' }))
  assert.deepEqual(to(plans), [CLIENT])
})

test('cancellation request → admins; the decision → client', async () => {
  const req = await plansFromRecord('order_events',
    { order_id: 'RTS-1', action: 'Client requested cancellation of RTS-1', audience: 'all' },
    deps({ assigned_to: 'screener' }))
  assert.deepEqual(to(req), [ADMINS])

  const decided = await plansFromRecord('order_events',
    { order_id: 'RTS-1', action: 'Admin approved cancellation of RTS-1', audience: 'all' },
    deps({ assigned_to: null }))
  assert.ok(decided.some(p => p.to === CLIENT), 'client must learn the outcome')
})

test('internal note → admins only, never the client', async () => {
  const plans = await plansFromRecord('support_messages',
    { client_code: 'CL01', order_id: 'RTS-1', sender: 'support', visibility: 'internal', body: 'APN looks wrong', author: 'Sam' },
    deps())
  assert.deepEqual(to(plans), [ADMINS])
  assert.ok(!plans.some(p => p.to === CLIENT))
})

test('client message → admins; admin reply → client', async () => {
  const inbound = await plansFromRecord('support_messages',
    { client_code: 'CL01', order_id: 'RTS-1', sender: 'client', visibility: 'client', body: 'any update?' }, deps())
  assert.deepEqual(to(inbound), [ADMINS])

  const reply = await plansFromRecord('support_messages',
    { client_code: 'CL01', order_id: 'RTS-1', sender: 'support', visibility: 'client', body: 'on track' }, deps())
  assert.deepEqual(to(reply), [CLIENT])
})

test('missing recipients are dropped, not sent as null', async () => {
  const plans = await plansFromRecord('order_events',
    { order_id: 'RTS-1', action: 'x', audience: 'all' },
    { ...deps({ assigned_to: 'screener' }), clientEmail: async () => null, staffEmails: async () => null })
  assert.deepEqual(plans, [])
})

test('event with no order id is not notifiable', async () => {
  assert.deepEqual(await plansFromRecord('order_events', { action: 'x' }, deps()), [])
})
