import { test } from 'vitest'
import assert from 'node:assert/strict'
import { collectOrderDocs, docIsShared, clientVisibleDocs } from './orderDocs.js'

const ref = (name) => ({ name, type: 'pdf', url: `blob:${name}` })

// A fully-populated order that has travelled through every stage.
const fullOrder = () => ({
  id: 'RES-1',
  workflow: {
    clientDocs: [{ id: 'c1', name: 'client-deed.pdf', type: 'pdf', url: 'blob:c1' }],
    screenerDoc: ref('screener.pdf'),
    examinerDoc: ref('examiner.pdf'),
    titleSearchDoc: ref('search-package.pdf'),
    commitmentDoc: ref('commitment.pdf'),
    supplementaryDocs: [
      { file: { id: 's1', name: 'supp-flagged.pdf', type: 'pdf', url: 'blob:s1' }, sendToCustomer: true },
      { file: { id: 's2', name: 'supp-internal.pdf', type: 'pdf', url: 'blob:s2' }, sendToCustomer: false },
    ],
    deliveryDocs: [{ id: 'd1', name: 'delivery-cover.pdf', type: 'pdf', url: 'blob:d1' }],
  },
})

test('collectOrderDocs gathers the whole paper trail across every stage', () => {
  const docs = collectOrderDocs(fullOrder())
  assert.deepEqual(docs.map(d => d.id), [
    'client:c1', 'screener', 'examiner', 'titleSearch', 'commitment', 'supp:s1', 'supp:s2', 'delivery:d1',
  ])
})

test('collectOrderDocs skips refs with no openable file', () => {
  const order = { workflow: { commitmentDoc: { name: 'pending.pdf' }, screenerDoc: ref('ok.pdf') } }
  assert.deepEqual(collectOrderDocs(order).map(d => d.id), ['screener'])
})

test('collectOrderDocs is safe on empty / missing workflow', () => {
  assert.deepEqual(collectOrderDocs(null), [])
  assert.deepEqual(collectOrderDocs({}), [])
  assert.deepEqual(collectOrderDocs({ workflow: {} }), [])
})

test('search package and commitment default to client-visible; stage work does not', () => {
  const order = fullOrder()
  const byId = Object.fromEntries(collectOrderDocs(order).map(d => [d.id, d]))
  assert.equal(docIsShared(order, byId['titleSearch']), true)
  assert.equal(docIsShared(order, byId['commitment']), true)
  assert.equal(docIsShared(order, byId['screener']), false)
  assert.equal(docIsShared(order, byId['examiner']), false)
  assert.equal(docIsShared(order, byId['client:c1']), false)
})

test('a flagged supplementary ships; an unflagged one does not', () => {
  const order = fullOrder()
  const byId = Object.fromEntries(collectOrderDocs(order).map(d => [d.id, d]))
  assert.equal(docIsShared(order, byId['supp:s1']), true)
  assert.equal(docIsShared(order, byId['supp:s2']), false)
})

test('delivery uploads default to shared', () => {
  const order = fullOrder()
  const byId = Object.fromEntries(collectOrderDocs(order).map(d => [d.id, d]))
  assert.equal(docIsShared(order, byId['delivery:d1']), true)
})

test('delivery curation (docShare) overrides every default, both ways', () => {
  const order = fullOrder()
  order.workflow.docShare = { screener: true, commitment: false, 'supp:s2': true }
  const byId = Object.fromEntries(collectOrderDocs(order).map(d => [d.id, d]))
  assert.equal(docIsShared(order, byId['screener']), true)    // opted a stage doc in
  assert.equal(docIsShared(order, byId['commitment']), false) // opted a default-on doc out
  assert.equal(docIsShared(order, byId['supp:s2']), true)     // overrode the flag
  assert.equal(docIsShared(order, byId['examiner']), false)   // untouched → still default
})

test('clientVisibleDocs returns exactly what Delivery chose to send', () => {
  const order = fullOrder()
  order.workflow.docShare = { commitment: false, screener: true }
  const visible = clientVisibleDocs(order).map(d => d.id)
  // commitment opted out, screener opted in; titleSearch + flagged supp + delivery stay on default-on.
  assert.deepEqual(visible, ['screener', 'titleSearch', 'supp:s1', 'delivery:d1'])
})
