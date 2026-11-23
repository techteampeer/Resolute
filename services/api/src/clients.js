// Client-company creation domain, server side (B2). The authoritative name
// normalisation, matching and CL-code allocation all live in the database
// (client_name_key / intake_resolve_client), reused verbatim, so this file only
// guards the REQUEST shape. Pure + dependency-free, so it unit-tests without a DB.

// Validate the admin create-company request. Company is required (the DB's
// client_name_key has the final say on "nothing but punctuation" → 422 there);
// contact/email are optional free text written onto a newly created client.
export const validateCompanyCreate = (body) => {
  const company = typeof body?.company === 'string' ? body.company.trim() : ''
  if (!company) return { ok: false, message: 'company is required' }
  if (company.length > 200) return { ok: false, message: 'company must be 200 characters or fewer' }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return { ok: true, company, contact: str(body?.contact), email: str(body?.email) }
}
