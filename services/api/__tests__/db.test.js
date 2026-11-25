// withIdentityLookup (services/api/src/db.js) with `pg` mocked: the sign-in
// lookup runs as the restricted login itself -- no SET ROLE (production's
// service_role has no BYPASSRLS and the login cannot assume it) -- with claims
// cleared, inside one transaction that always releases its connection.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  process.env.DB_USER ??= 'test'
  process.env.DB_PASSWORD ??= 'test'
  process.env.DB_NAME ??= 'test'
  return { sql: [], released: 0 }
})

vi.mock('pg', () => ({
  default: {
    Pool: class {
      async connect() {
        return {
          query: async (sql) => { h.sql.push(sql); if (sql === 'boom') throw new Error('boom'); return { rows: [] } },
          release: () => { h.released++ },
        }
      }
    },
  },
}))

const { withIdentityLookup } = await import('../src/db.js')

beforeEach(() => { h.sql = []; h.released = 0 })

describe('withIdentityLookup', () => {
  it('BEGIN, clear claims, the work, COMMIT -- and never SET ROLE', async () => {
    await withIdentityLookup((c) => c.query('select 1'))
    expect(h.sql).toEqual(['BEGIN', "SELECT set_config('request.jwt.claims', '', true)", 'select 1', 'COMMIT'])
    expect(h.sql.some((s) => /set\s+(local\s+)?role/i.test(s))).toBe(false)
    expect(h.released).toBe(1)
  })
  it('rolls back and releases on error', async () => {
    await expect(withIdentityLookup((c) => c.query('boom'))).rejects.toThrow('boom')
    expect(h.sql.at(-1)).toBe('ROLLBACK')
    expect(h.released).toBe(1)
  })
})
