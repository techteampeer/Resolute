// Pure unit tests for the B3 document access-control helpers (no DB). Runs in the
// root vitest (CI build job).
import { describe, it, expect } from 'vitest'
import { collectOrderDocs, docIsShared, clientVisibleDocs, authorizedDocs, isPersistableRef } from '../src/orderDocs.js'

const order = () => ({
  workflow: {
    titleSearchDoc: { name: 'search.pdf', type: 'application/pdf', path: 'orders/o/ts.pdf' }, // default share: true
    screenerDoc: { name: 'scr.pdf', type: 'application/pdf', path: 'orders/o/scr.pdf' },       // default share: false
    deliveryDocs: [
      { id: 'd1', name: 'final.pdf', type: 'application/pdf', path: 'orders/o/d1.pdf', sendToCustomer: true },
      { id: 'd2', name: 'notes.pdf', type: 'application/pdf', path: 'orders/o/d2.pdf', sendToCustomer: false },
    ],
    docShare: { screener: true, 'delivery:d1': false }, // overrides both directions
  },
})

describe('collectOrderDocs / docIsShared', () => {
  it('collects every referenced doc with a stable id', () => {
    expect(collectOrderDocs(order()).map((d) => d.id).sort())
      .toEqual(['delivery:d1', 'delivery:d2', 'screener', 'titleSearch'])
  })
  it('skips refs with no openable file, and is safe on empty input', () => {
    expect(collectOrderDocs({ workflow: { screenerDoc: { name: 'x' } } })).toEqual([])
    expect(collectOrderDocs(null)).toEqual([])
  })
  it('lets docShare override the default in both directions', () => {
    const o = order()
    const by = Object.fromEntries(collectOrderDocs(o).map((d) => [d.id, d]))
    expect(docIsShared(o, by.titleSearch)).toBe(true)        // default true, no override
    expect(docIsShared(o, by.screener)).toBe(true)           // default false → overridden true
    expect(docIsShared(o, by['delivery:d1'])).toBe(false)    // default true → overridden false
    expect(docIsShared(o, by['delivery:d2'])).toBe(false)    // default false
  })
})

describe('authorizedDocs (delivery-only release)', () => {
  it('staff see everything; a client sees only released docs', () => {
    expect(authorizedDocs(order(), { isStaff: true }).length).toBe(4)
    expect(clientVisibleDocs(order()).map((d) => d.id).sort()).toEqual(['screener', 'titleSearch'])
    expect(authorizedDocs(order(), { isStaff: false }).map((d) => d.id).sort()).toEqual(['screener', 'titleSearch'])
  })
})

describe('isPersistableRef (no public/blob urls persisted)', () => {
  it('accepts a storage path with no url, or a non-public url', () => {
    expect(isPersistableRef({ path: 'orders/o/x.pdf' })).toBe(true)
    expect(isPersistableRef({ path: 'orders/o/x.pdf', url: null })).toBe(true)
  })
  it('rejects a missing path, or a blob:/data:/public http url', () => {
    expect(isPersistableRef({ url: 'https://example.com/x.pdf' })).toBe(false)
    expect(isPersistableRef({ path: 'orders/o/x.pdf', url: 'blob:abc' })).toBe(false)
    expect(isPersistableRef({ path: 'orders/o/x.pdf', url: 'data:application/pdf;base64,AAA' })).toBe(false)
    expect(isPersistableRef({ path: 'orders/o/x.pdf', url: 'https://signed.example/x' })).toBe(false)
    expect(isPersistableRef(null)).toBe(false)
  })
})
