# Cloud SQL / GCP database

The database half of the move off Supabase onto Cloud SQL (PostgreSQL 15),
Firebase Auth and Cloud Storage. **Nothing here is wired into the running
application, and nothing here has been run against production** — `main` is
the Supabase lineage (ADR 0003). Production (`resolute_live`) already exists,
so it is only ever *inspected* (`preflight.sh`) and changed through *guarded*
migrations (`migrations/`, `migrate.sh`) — never rebuilt.

| File | What it is | Safe against resolute_live? |
| --- | --- | --- |
| `01_bootstrap.sql` | roles, `auth.uid()` shim, identity map, storage stand-in, app role | **No** — new databases only |
| `02_post_migrate.sql` | drops the Supabase-only parts; asserts the API's roles work | **No** — new databases only |
| `bootstrap.sh` | 01 → `supabase/migrations/*` → 02, for a NEW database; refuses `resolute_live` | **No** (refuses it) |
| `preflight.sh` / `preflight.sql` | read-only report: schema, ownership, grants, roles, aggregate counts | **Yes** — read-only by construction |
| `migrations/20261124000000_…sql` | guarded migration: the missing charge + client-company functions | Only via `migrate.sh`, with approval |
| `migrate.sh` | preflight → dry run → apply → post-check | Yes, with `PRODUCTION-PREREQUISITES.md` |
| `test/run.sh` | disposable PostgreSQL 15 verification of all of the above | Never connects anywhere else |
| `PRODUCTION-PREREQUISITES.md` | exact production prerequisites and steps | — |

## Building a new database

```bash
export DB_USER=resolute_app DB_PASS=… DB_NAME=<new database> BUCKET_NAME=…
export PGPASSWORD=…                   # for ADMIN_USER (default: postgres)
cloud-sql-proxy "$PROJECT:$REGION:resolute-db-instance" --port 5432 &
./gcp/bootstrap.sh                    # 01 + every migration + 02, stops at the first error
```

Three defects in the previous version each stopped this before it finished,
all reproduced on PostgreSQL 15 and fixed:

1. **No storage schema.** The first migration inserts into `storage.buckets`;
   Cloud SQL has no `storage` schema, so 2 of 51 migrations failed and the
   script aborted at the first. `01_bootstrap.sql` now creates a stand-in that
   `02_post_migrate.sql` drops again (its policies could enforce nothing).
2. **The app role could not act as `service_role`.** It was granted
   `authenticated, anon` but not `service_role`, so `SET LOCAL ROLE
   service_role` — every Firebase sign-in (`resolveAppUser`) and the admin
   user route — failed with "permission denied to set role". It now holds
   exactly `authenticated` + `service_role`, stays NOINHERIT/non-superuser/no
   BYPASSRLS (asserted, also for a pre-existing role), and `auth.users` (every
   Firebase UID and email, no RLS) is no longer readable by `authenticated`.
3. **The password step never ran.** psql does not interpolate `:'var'` in `-c`,
   so `alter role :"user" …` reached the server verbatim and failed. It is now
   fed on stdin, which also keeps a quote in the password safe.

`02_post_migrate.sql` now runs as part of `bootstrap.sh` and fails the build if
any property the API depends on is missing.

**Cloud SQL caveat:** PostgreSQL 15 lets only a superuser create a BYPASSRLS
role, and Cloud SQL has no superuser. Run as Cloud SQL's built-in user, the
bootstrap stops with that prerequisite spelled out unless `service_role`
already exists (see `PRODUCTION-PREREQUISITES.md`).

## Checking and changing production

```bash
gcp/preflight.sh                      # read-only; exit 0 ok, 2 FAIL, 1 could not run
gcp/migrate.sh gcp/migrations/20261124000000_charge_and_client_functions.sql   # dry run
```

The preflight runs in a READ ONLY transaction on a session opened with
`default_transaction_read_only=on`, reads the catalog plus aggregate counts
(never a row, name or email), and rolls back. It resolves every object through
`pg_catalog`, so a reviewer account without schema privileges still gets a full
report, and it reports data counts as `UNVERIFIED` when RLS would filter them
for the connecting role instead of printing a misleading zero.

The migration is one transaction that commits only with `-v apply=true -v
confirm_db=<connected database>`. It checks every prerequisite first, compiles
its definitions in a transaction-local schema and **aborts if an existing copy
differs** (no silent replacement of drifted production code), gives the
functions to the owner of `public.orders`, sets EXECUTE to exactly
`{authenticated}`, and asserts all of that before committing.

## Verification: `gcp/test/run.sh`

```bash
npm ci --prefix services/api && npm run test:gcp-db     # needs docker + psql
```

One throwaway `postgres:15` container on 127.0.0.1 with random passwords; every
inherited `PG*` variable is unset first. It emulates Cloud SQL where it matters
— the schema owner has Cloud SQL's built-in-user attributes (CREATEROLE
CREATEDB, **not** superuser) and the API connects as its NOINHERIT login — and
builds two shapes with the real `bootstrap.sh`:

- **prod**: every migration except the four resolute_live lacks
  (`20261104000000`, `20261105000000`, `20261105010000`, `20261117000000`);
- **lineage**: every migration (what `main` would build).

**Populated data goes in first.** `supabase start` and `bootstrap.sh` run every
migration against empty tables and seed afterwards, so a check about existing
orders passes vacuously. The harness loads production-shaped orders
(`test/fixtures.sql`: fees pending/approved/declined/legacy, payments, two
clients, an ambiguous company pair) and Firebase-shaped identities
(`test/identities.sql`) **before** migrating, fingerprints every customer table
before and after, and the suite exits 2 on an empty orders table — which the
harness proves on an empty copy that migrates "successfully".

It then runs, as the app login through `services/api/src/db.js`:
`services/api/__tests__/gcp-migration.integration.mjs` (roles, ownership,
grants, identity resolution, row isolation, the raise/resolve matrix with
concurrency, notification fan-out and dedupe, invoice/payment invariants,
client creation) on both shapes, and the existing B1–B4 integration suites,
unmodified. Every refusal path (drift, overload, missing dependency, FORCE RLS,
non-owner runner, missing confirmation, protected database) must exit nonzero
and change nothing. CI runs it as the `gcp-db` job.

## Two things that will bite

**Never connect the app as a superuser or the schema owner.** Postgres skips
RLS for superusers, BYPASSRLS roles and a table's owner, so the app would lose
client PII masking, the billing-owner guard, message visibility and
fulfillment scoping **all at once, silently** — no error, queries just return
everything. Connect as `$DB_USER`.

**`auth.uid()` must return the portal's `profiles.id`, not the Firebase UID.**
Firebase issues 28-character strings; `profiles.id` is a `uuid` and every policy
and foreign key is built on it. `auth.users` maps one to the other. Injecting a
raw Firebase UID makes `auth.uid()` throw on the cast, and every policy with it.

## Storage has no equivalent

Policies protected `storage.objects`. Cloud Storage does not consult Postgres,
so `02_post_migrate.sql` removes them rather than leave rules that read as
protection but enforce nothing. Document access is enforced in the API at the
point a signed URL is minted (spec B3), and nothing else may mint one.

## Connection pooling

The API sets the claims per transaction (`set_config(..., true)`, which is
transaction-local) and must not leak them between pooled checkouts. A pooled
connection that keeps the previous request's claims serves one user's rows to
the next.
