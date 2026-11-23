// Pure unit tests for the B2 request validation (no DB). Runs in the root vitest
// (CI build job); the DB-backed match-or-create behaviour lives in
// __tests__/clients.integration.mjs (db-integrity lane).
import { describe, it, expect } from 'vitest'
import { validateCompanyCreate } from '../src/clients.js'

describe('validateCompanyCreate', () => {
  it('accepts and trims a company, coercing blank contact/email to null', () => {
    expect(validateCompanyCreate({ company: '  Harborline Title Co  ', contact: ' ', email: '' }))
      .toEqual({ ok: true, company: 'Harborline Title Co', contact: null, email: null })
  })
  it('keeps contact + email when present (trimmed)', () => {
    expect(validateCompanyCreate({ company: 'Acme', contact: ' Jo ', email: ' jo@acme.com ' }))
      .toEqual({ ok: true, company: 'Acme', contact: 'Jo', email: 'jo@acme.com' })
  })
  it('rejects a missing/blank/non-string company (422)', () => {
    expect(validateCompanyCreate({ company: '' }).ok).toBe(false)
    expect(validateCompanyCreate({ company: '   ' }).ok).toBe(false)
    expect(validateCompanyCreate({}).ok).toBe(false)
    expect(validateCompanyCreate({ company: 42 }).ok).toBe(false)
  })
  it('rejects an absurdly long company name', () => {
    expect(validateCompanyCreate({ company: 'x'.repeat(201) }).ok).toBe(false)
    expect(validateCompanyCreate({ company: 'x'.repeat(200) }).ok).toBe(true)
  })
})
