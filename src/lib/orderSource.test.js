import { test } from 'vitest'
import assert from 'node:assert/strict'
import { orderSourceOf, orderSourceLabel, ORDER_SOURCE_LABEL } from './orderSource.js'

const withSource = (source) => ({ id: 'RES-1', workflow: { intake: { source } } })

test('the three stored sources display as Website, Email and Portal', () => {
  assert.equal(orderSourceLabel(withSource('website')), 'Website')
  assert.equal(orderSourceLabel(withSource('email')), 'Email')
  assert.equal(orderSourceLabel(withSource('web')), 'Portal')   // the portal's own Place Order value
})

test('legacy orders with no intake source fall back to Portal', () => {
  assert.equal(orderSourceOf({ id: 'RES-1' }), 'portal')
  assert.equal(orderSourceOf({ id: 'RES-1', workflow: {} }), 'portal')
  assert.equal(orderSourceOf({ id: 'RES-1', workflow: { intake: {} } }), 'portal')
  assert.equal(orderSourceOf({ id: 'RES-1', workflow: null }), 'portal')
  assert.equal(orderSourceOf(null), 'portal')
  assert.equal(orderSourceOf(undefined), 'portal')
})

test('only the exact stored values are recognised', () => {
  assert.equal(orderSourceOf(withSource('Website')), 'portal')
  assert.equal(orderSourceOf(withSource('EMAIL')), 'portal')
  assert.equal(orderSourceOf(withSource('')), 'portal')
})

test('every source has a label', () => {
  assert.deepEqual(Object.keys(ORDER_SOURCE_LABEL).sort(), ['email', 'portal', 'website'])
})
