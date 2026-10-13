# Cloud SQL / GCP bootstrap

Scaffolding for moving the portal off Supabase onto Cloud SQL, Firebase Auth and
Cloud Storage. **Nothing here is wired into the running application yet** — the
portal in `src/` still talks to Supabase, and this directory does not change
that. It is the database half of the move, proven against a real Postgres.

## Order

```bash
export DB_USER=… DB_PASS=… DB_NAME=resolute_prod BUCKET_NAME=…
cloud-sql-proxy "$PROJECT:$REGION:resolute-db-instance" --port 5432 &
./gcp/bootstrap.sh
psql -f gcp/02_post_migrate.sql "$DB_NAME"     # bootstrap.sh does not run this
```

1. `01_bootstrap.sql` — the `anon` / `authenticated` / `service_role` roles the
   existing GRANTs name, the `auth.uid()` shim the policies call, the
   `auth.users` identity-mapping table, and the app role.
2. `supabase/migrations/*.sql` — unchanged, in version order.
3. `02_post_migrate.sql` — drops what only made sense on Supabase.

## What was actually verified

Against a scratch Postgres 17 database with no `auth` or `storage` schema — the
same shape as a fresh Cloud SQL instance:

- All 30 migrations apply: **12 tables, 36 policies, 60 functions**, zero errors.
- Without the shim, 2 of 30 fail, both only on `storage.buckets` /
  `storage.objects`. Every one of the 32 `auth.uid()` policies applies fine.
- RLS enforces correctly through injected claims:

  | session | profiles | clients (PII) | directory |
  | --- | --- | --- | --- |
  | client | 1 (own) | 1 (own) | — |
  | screener | 2 (roster) | **0** | 2 |
  | superuser, same claims | 2 | **2** | — |

## Two things that will bite

**Never connect the app as a superuser.** That last row is not hypothetical — it
is the measured result. Postgres skips RLS entirely for superusers and for any
role with `BYPASSRLS`, so an app connecting as Cloud SQL's built-in `postgres`
user loses client PII masking, the billing-owner guard, message visibility and
fulfillment scoping **all at once, silently** — no error, queries just start
returning everything. Connect as `$DB_USER`, created here without superuser.

**`auth.uid()` must return the portal's `profiles.id`, not the Firebase UID.**
Firebase issues 28-character strings; `profiles.id` is a `uuid` and every policy
and foreign key is built on it. `auth.users` maps one to the other. Injecting a
raw Firebase UID makes `auth.uid()` throw on the cast, and every policy with it.

## Storage has no equivalent

Nine policies protected `storage.objects`. Cloud Storage does not consult
Postgres, so `02_post_migrate.sql` removes them rather than leave rules that
read as protection but enforce nothing. **That check has to be re-implemented in
the API, at the point a signed URL is minted** — and nothing else may mint one.
Until that exists, document access is unprotected.

## Connection pooling

The API must set the claims per transaction (`set_config(..., true)`, which is
transaction-local) and must not leak them between pooled checkouts. A pooled
connection that keeps the previous request's claims serves one user's rows to
the next.
