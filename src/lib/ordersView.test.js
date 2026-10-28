import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ORDER_TABS, tabOf, tabCounts, withinRange, propertyOf, DATE_RANGES,
  statusRank, dueByValue, orderedOnValue, compareValues, sortByAccessor } from './ordersView.js'

const o = (over = {}) => ({ id: 'RES-1', status: 'screening', assignedTo: 'user', ...over })

test('the six Qualia tabs are present and ordered', () => {
  assert.deepEqual(ORDER_TABS.map(t => t.key),
    ['all', 'pending', 'open', 'submitted', 'complete', 'cancelled'])
})

test('tabOf classifies each lifecycle state', () => {
  assert.equal(tabOf(o({ status: 'cancelled' })), 'cancelled')
  assert.equal(tabOf(o({ status: 'delivered' })), 'complete')
  // Parked with Admin → Pending, whatever the stage status says.
  assert.equal(tabOf(o({ status: 'screening', assignedTo: 'admin' })), 'pending')
  assert.equal(tabOf(o({ status: 'received', assignedTo: 'admin' })), 'pending')
  assert.equal(tabOf(o({ status: 'delivery', assignedTo: 'admin' })), 'pending')
  // Delivery stage held by a production user → Out for Delivery (Submitted).
  assert.equal(tabOf(o({ status: 'delivery', assignedTo: 'user' })), 'submitted')
  // Any other stage being worked → Open.
  assert.equal(tabOf(o({ status: 'typing', assignedTo: 'user' })), 'open')
  assert.equal(tabOf(o({ status: 'qc', assignedTo: 'user' })), 'open')
  // Null assignment is treated as parked with Admin.
  assert.equal(tabOf(o({ assignedTo: null })), 'pending')
})

test('tabCounts sums to the order total and buckets correctly', () => {
  const orders = [
    o({ status: 'cancelled' }),
    o({ status: 'delivered' }),
    o({ status: 'received', assignedTo: 'admin' }),
    o({ status: 'delivery', assignedTo: 'user' }),
    o({ status: 'typing', assignedTo: 'user' }),
  ]
  const c = tabCounts(orders)
  assert.equal(c.all, 5)
  assert.equal(c.cancelled, 1)
  assert.equal(c.complete, 1)
  assert.equal(c.pending, 1)
  assert.equal(c.submitted, 1)
  assert.equal(c.open, 1)
})

test('withinRange filters by the created date, keeping undated rows', () => {
  const now = new Date('2026-10-21').getTime()
  assert.equal(withinRange({ created: '2026-10-20' }, '30', now), true)
  assert.equal(withinRange({ created: '2026-01-01' }, '30', now), false)
  assert.equal(withinRange({ created: '2026-01-01' }, 'all', now), true)
  assert.equal(withinRange({}, '30', now), true)   // no date → never filtered out
  assert.deepEqual(DATE_RANGES.map(d => d.key), ['30', '90', '365', 'all'])
})

test('propertyOf shows the address, or an N-properties summary for combined orders', () => {
  assert.equal(propertyOf({ workflow: { intake: { propertyAddress: '12 Oak St' } } }), '12 Oak St')
  assert.equal(propertyOf({ workflow: { intake: {} } }), '—')
  assert.equal(propertyOf({ workflow: { intake: { lineItems: [{}, {}] } } }), '2 properties')
})

test('dueByValue / orderedOnValue read the right order fields', () => {
  assert.equal(orderedOnValue({ created: '2026-05-01' }), '2026-05-01')
  assert.equal(dueByValue({ eta: '2026-06-01' }), '2026-06-01')
  assert.equal(dueByValue({ completed: '2026-06-10', eta: '2026-06-01' }), '2026-06-10') // delivered date wins
  assert.equal(dueByValue({}), null)
})

test('statusRank follows the pipeline; cancelled sorts last', () => {
  assert.ok(statusRank({ status: 'screening' }) < statusRank({ status: 'delivered' }))
  assert.ok(statusRank({ status: 'examining' }) < statusRank({ status: 'typing' })) // examiner precedes typer
  assert.equal(statusRank({ status: 'cancelled' }), Number.MAX_SAFE_INTEGER)
})

test('compareValues: numbers numeric, strings locale, empties always last', () => {
  assert.ok(compareValues(1, 2, 'asc') < 0)
  assert.ok(compareValues(1, 2, 'desc') > 0)
  assert.ok(compareValues('2026-01-01', '2026-02-01', 'asc') < 0)
  assert.ok(compareValues(null, 5, 'asc') > 0)   // empty last regardless of direction
  assert.ok(compareValues(null, 5, 'desc') > 0)
  assert.ok(compareValues(5, null, 'desc') < 0)
})

test('sortByAccessor is stable, honors direction; no accessor → unchanged', () => {
  const list = [{ id: 'a', n: 2 }, { id: 'b', n: 1 }, { id: 'c', n: 2 }]
  assert.deepEqual(sortByAccessor(list, x => x.n, 'asc').map(x => x.id), ['b', 'a', 'c'])  // ties keep input order
  assert.deepEqual(sortByAccessor(list, x => x.n, 'desc').map(x => x.id), ['a', 'c', 'b'])
  assert.equal(sortByAccessor(list, null, 'asc'), list)   // no accessor → same list
})
