# Spec — B2: Client company creation on GCP (Cloud Run + Cloud SQL)

Status: **implemented in repo** · 2026-11-20 · parent: ADR 0003 (blocker B2) ·
Supabase reference: `admin_create_client` (migration `20261104000000`),
`createAdminClient` in `src/lib/backends/supabase.js`, `useClients.js`.

Goal: make admin client-company creation production-real on GCP — an
authenticated `services/api` route over a transactional, RLS/`is_admin()`-guarded
Cloud SQL write that reuses the exact match-or-create discipline the email/website
intake already uses. Nothing here deploys.

## What the feature is
At intake (the admin Place Order wizard), Admin can turn a typed company name
into a real `clients` row. One operation, name-only, never a code and never fuzzy:
- **exactly one** existing client matches the normalised name → `matched` (idempotent);
- **several** match → `ambiguous` (the UI asks Admin to pick, nothing is created);
- **none** match → a new `CL`-numbered client, created under a per-name advisory lock.

## Design — reuse the tested resolver
`admin_create_client(p_company, p_contact, p_email)` is a `SECURITY DEFINER`
wrapper that re-checks `is_admin()` on the caller's `auth.uid()` and delegates to
`intake_resolve_client` (normalised `client_name_key` match under
`pg_advisory_xact_lock`, `next_client_code` allocation). The GCP path calls it
verbatim through `withUserClaims`, so behaviour is byte-for-byte the Supabase
path — the same reuse strategy as B1's `resolve_order_charge`.

## API surface
`POST /api/clients` — body `{ company, contact?, email? }`:
- `created`   → **201** `{ status, code, name }`
- `matched`   → **200** `{ status, code, name }` (idempotent)
- `ambiguous` → **200** `{ status, codes }` — stays **2xx on purpose** so the
  client provider returns the body and the UI branches on `status`; an ambiguous
  result must not read as a thrown error.
- non-admin → **403** (route pre-check + the DB's `is_admin()` guard, `42501`)
- empty/blank/punctuation-only company → **422** (route validation + the DB's `22023`)

## What landed
- `services/api/src/clients.js` — pure request validation (`validateCompanyCreate`).
- `services/api/src/repositories/clients.js` — `createAdminClient` (calls the
  wrapper; maps `42501`→403, `22023`→422).
- `services/api/src/routes/clients.js` + mount in `server.js`.
- `src/lib/backends/gcp.js` — `createAdminClient` wired (was `notImpl`) via the
  fail-safe `apiFetch`. The `backend.js` contract already exported it, so no
  contract change; inert on a mock build (`useClients` guards on `isSupabaseConfigured`).
- Tests: `__tests__/clients.test.js` (pure, CI build job) + `__tests__/clients.integration.mjs`
  — supertest → the real router → `withUserClaims` → `admin_create_client`, over a
  live Postgres: authorization (403 for user/client), validation (422), create /
  idempotent match / case-&-punctuation normalisation, contact+email persistence,
  ambiguous (200 + codes, nothing created), and concurrency (two parallel creates
  → exactly one `created`, one `matched`, one row). Wired into the `db-integrity`
  CI lane alongside B1.

## Still open (unchanged, env-gated)
Same as the ADR-0003 deploy gate: the reviewed `resolute_live` migration parity,
the zero-traffic Cloud Run preview, and the promotion gate (Claudio's cost
approval). Not in-repo code.
