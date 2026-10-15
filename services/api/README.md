# Data-API service (Cloud Run) — ADR 0002 phase B2

Replaces Supabase PostgREST for the GCP stack. The browser can't reach Cloud SQL
directly, so this service sits in front of it: it **verifies the Firebase ID
token**, **injects per-transaction JWT claims**, and runs **RLS-enforced**
queries as the **non-superuser** app role. The RLS policies are unchanged — they
are still the source of truth for who sees what.

> **Status: skeleton.** The request → claims → RLS → response path is complete
> and the orders resource is implemented as the reference pattern. The remaining
> resources (support, fulfillment, billing, payouts, notifications, profiles,
> clients) replicate `routes/orders.js` + `repositories/orders.js`. Firebase
> project wiring and profile provisioning are B3; writes with the optimistic
> lock follow the same `withUserClaims` shape.

## The request path

```
Authorization: Bearer <firebase id token>
  → verifyBearer()            (auth.js)  verify the token
  → resolveAppUser()          (auth.js)  firebase_uid → profiles.id via auth.users (service_role, the one RLS bypass)
  → withUserClaims(user, fn)  (db.js)    BEGIN; SET LOCAL ROLE authenticated; set_config('request.jwt.claims', {sub: profiles.id}, true)
  → repository query          (RLS enforces via auth.uid())
  → toAppOrder()              (mappers.js) row → the exact shape the Supabase provider returns
```

## The invariants that keep it safe (from `gcp/README`)

1. **Non-superuser only.** The pool logs in as `resolute_app`; a request elevates
   to `authenticated` per transaction. Never `postgres` / `BYPASSRLS` (silent
   RLS bypass).
2. **`sub` is the profiles.id UUID**, never the Firebase UID — `claims.js`
   enforces this and rejects a non-UUID.
3. **Claims are transaction-local.** `SET LOCAL ROLE` + `set_config(..., true)`
   reset on COMMIT/ROLLBACK, so nothing leaks to the next pooled checkout. Every
   unit of work is wrapped in `withUserClaims` / `withServiceRole`, which always
   end the transaction before releasing the client.
4. **`service_role` is used once**, for identity resolution only (no user claims
   exist yet). Everything else is RLS-enforced.

## Run locally

```bash
# 1. Cloud SQL Auth Proxy to the instance (or any Postgres with the gcp/ bootstrap applied)
cloud-sql-proxy "$PROJECT:$REGION:resolute-db-instance" --port 5432 &

# 2. env
export DB_HOST=127.0.0.1 DB_USER=resolute_app DB_PASSWORD=... DB_NAME=resolute
export FIREBASE_PROJECT_ID=...   # for token verification

npm install && npm start   # listens on :8080 ; GET /healthz for a quick check
```

Unit tests for the pure pieces (`claims`, `mappers`) run in the repo's root
suite (`npm test`) — they need no database.

## Deploy

CI builds this `Dockerfile`, pushes to the Artifact Registry repo from B0, and
deploys the `resolute-api` Cloud Run service (which already carries the VPC
connector and the DB secret — see `gcp/terraform/cloudrun.tf`).
