import { describe, it, expect } from 'vitest'
import { PRODUCTS, PRODUCT_PRICE, PRODUCT_TIERS, tierOf } from './products'

const byName = (n) => PRODUCTS.find(p => p.name === n)
const BASES = ['Current Owner Search', 'Two Owner Search', 'Full Search', 'Update / Bringdown']

describe('product catalog — Plus / Non-Plus variants', () => {
  it('adds a Plus and a Non-Plus variant for each of the four core searches', () => {
    for (const base of BASES) {
      const plus = byName(`${base} — Plus`)
      const non = byName(`${base} — Non-Plus`)
      expect(plus, `${base} — Plus`).toBeTruthy()
      expect(non, `${base} — Non-Plus`).toBeTruthy()
      expect(plus.tier).toBe('plus')
      expect(non.tier).toBe('nonplus')
      expect(plus.base).toBe(base)
      expect(non.base).toBe(base)
    }
  })

  it('every variant is quote-only (no fixed price) and absent from PRODUCT_PRICE', () => {
    const variants = PRODUCTS.filter(p => p.tier)
    expect(variants).toHaveLength(8)
    for (const v of variants) {
      expect(v.price).toBeUndefined()
      expect(PRODUCT_PRICE[v.name]).toBeUndefined()
    }
  })

  it('keeps the standard base prices intact', () => {
    expect(PRODUCT_PRICE['Current Owner Search']).toBe(75)
    expect(PRODUCT_PRICE['Two Owner Search']).toBe(100)
    expect(PRODUCT_PRICE['Full Search']).toBe(150)
    expect(PRODUCT_PRICE['Update / Bringdown']).toBe(45)
  })

  it('every variant base points at a real catalog product', () => {
    for (const v of PRODUCTS.filter(p => p.tier)) {
      expect(byName(v.base), v.base).toBeTruthy()
    }
  })

  it('tierOf resolves a variant tier and is null for standard products', () => {
    expect(tierOf('Full Search — Plus')).toBe('plus')
    expect(tierOf('Full Search — Non-Plus')).toBe('nonplus')
    expect(tierOf('Full Search')).toBeNull()
    expect(tierOf('Tax Search')).toBeNull()
    expect(PRODUCT_TIERS.plus).toBe('Plus')
    expect(PRODUCT_TIERS.nonplus).toBe('Non-Plus')
  })
})
