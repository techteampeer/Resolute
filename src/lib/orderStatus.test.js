import { test } from 'vitest'
import assert from 'node:assert/strict'
import { STATUS_META, AWAITING_META, HOLD_META, CLARIFY_META, statusMeta } from './orderStatus.js'

// Every pipeline status the app can emit must have a badge. These are the values
// `statusForRole` / the DB `order_status` enum produce today (pre-Phase-3, so one
// 'qc'; Phase 3 adds 'searchqc' + renames to 'typingqc' and extends this map).
const PIPELINE_STATUSES = [
  'received', 'screening', 'searching', 'examining', 'typing', 'qc',
  'delivery', 'delivered', 'cancelled',
]

test('every pipeline status has a badge with a label and distinct colour', () => {
  for (const s of PIPELINE_STATUSES) {
    const m = STATUS_META[s]
    assert.ok(m, `missing STATUS_META for "${s}"`)
    assert.ok(m.label && m.color && m.bg, `"${s}" badge is missing label/color/bg`)
  }
})

test('one clean colour per stage — no two stages share a colour', () => {
  const colours = Object.values(STATUS_META).map(m => m.color)
  assert.equal(new Set(colours).size, colours.length, 'stage colours must be unique')
})

test('statusMeta falls back to "received" for an unknown status', () => {
  assert.equal(statusMeta('not-a-real-status'), STATUS_META.received)
  assert.equal(statusMeta(undefined), STATUS_META.received)
  assert.equal(statusMeta('typing'), STATUS_META.typing)
})

test('the parked-with-Admin state reads "Awaiting Approval", not a raw stage', () => {
  assert.equal(AWAITING_META.label, 'Awaiting Approval')
})

test('hold and clarification are modifiers with their own ring colour', () => {
  for (const m of [HOLD_META, CLARIFY_META]) {
    assert.ok(m.label && m.color && m.bg && m.ring, 'a modifier needs label/color/bg/ring')
  }
  // Hold wins over clarification when both apply, so they must be visually distinct.
  assert.notEqual(HOLD_META.color, CLARIFY_META.color)
})
