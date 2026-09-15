# Moving the portal to GCP

Supabase is gone from the application: no `@supabase/supabase-js`, no
`src/lib/supabase.js`, no `api/`. Auth is Google Cloud Identity Platform,
storage is Cloud Storage, and the database is Cloud SQL reached through `pg`.

> **Do not merge this to `main` until you are ready to leave Vercel.**
> `main` deploys to Vercel and is serving real staff and a pilot client today.
> The SPA now expects an API at `/api/*` that only the container in this branch
> provides, so on Vercel every screen would fail. This is a cutover, not a
> rolling change.

## Why there is now a server

The four changes all need one, and the repo had none. A browser cannot open a
Postgres socket, cannot hold database credentials, cannot verify a Firebase
session cookie, and cannot sign a Cloud Storage URL without publishing the
signing credential to every visitor. `server/` holds all of it; the SPA talks to
it over HTTP with an httpOnly cookie.

The previous `Dockerfile` served `dist/` from nginx. That could not host any of
this — and it silently dropped `api/admin/users.js`, so Admin's user management
would have broken on Cloud Run, answering with `index.html` rather than a 404.

## What replaced what

| Was | Is | Where |
| --- | --- | --- |
| `supabase.auth.signInWithPassword` | Identity Toolkit REST, server-side | `server/lib/auth.js` |
| Supabase session (token in JS) | httpOnly session cookie | `server/routes/auth.js` |
| `supabase.from(...)` ×42 | SQL through `pg` | `server/routes/data.js` |
| Supabase Storage | `@google-cloud/storage` | `server/lib/storage.js` |
| Supabase Realtime | `LISTEN/NOTIFY` → SSE | `server/routes/events.js`, `gcp/03_realtime.sql` |
| `api/admin/users.js` + service-role key | Firebase Admin + RLS | `server/routes/admin.js` |

The Firebase **client** SDK is deliberately not installed: it would put a bearer
token in reachable JavaScript and add ~150 KB to an already large bundle.

## How RLS still applies

`auth.uid()` reads `request.jwt.claims`. Every query on a user's behalf goes
through `withUser()`, which opens a transaction, sets that claim to the caller's
**`profiles.id`**, and does `set local role authenticated`.

Two properties, both measured against a real Postgres carrying the real
migrations:

| Session | orders | with client name (PII) | `clients` | directory |
| --- | --- | --- | --- | --- |
| client | own only | own only | own only | own only |
| screener | all | **0** | **0** | all |
| plain admin | all | **0** | **0** | all |
| super admin | all | all | all | all |

- **`set local role authenticated` re-imposes RLS even on an over-privileged
  connection.** The test connected as `postgres`, a superuser that bypasses RLS
  outright — a no-user query saw every order — yet inside `withUser` the role is
  `authenticated` and the policies apply. That is a deliberate belt-and-braces:
  connect as a non-owner anyway (see below), but a mistake there is not fatal.
- **Claims do not leak between pooled checkouts.** The setting is
  transaction-local, so it is discarded at COMMIT or ROLLBACK. Without that, the
  next request to borrow the same connection would read the previous user's rows.

## The Firebase UID is not the portal's user ID

Firebase issues 28-character strings. `profiles.id` is a **uuid**, it is a
foreign key to `auth.users`, and every RLS policy is built on `auth.uid()`
returning that uuid. `auth.users` maps one to the other; what gets injected is
always the portal uuid. Injecting a raw Firebase UID makes `auth.uid()` throw on
the cast, and every policy with it.

Binding is deliberate — `scripts/link-firebase-users.mjs`, dry-run by default —
never automatic on a matching email. Auto-binding would mean anyone who can
create an Identity Platform account with a Resolute address inherits that
person's profile, their orders and their clients' data.

## Before this can run

1. **Cloud SQL** — `gcp/bootstrap.sh`, then `gcp/02_post_migrate.sql` and
   `gcp/03_realtime.sql`. Create the runtime role and set its password out of
   band, then store it as `DB_PASS`:
   ```
   gcloud sql users create resolute_app --instance=resolute-db-instance --prompt-for-password
   ```
   **Do not point `DB_USER` at the role that ran the migrations.** Postgres
   exempts a table's owner from that table's RLS, so the app would silently lose
   every access rule in the schema.
2. **Identity Platform** — enable email/password, and grant the Cloud Run runtime
   service account **Service Account Token Creator on itself**. Without it
   `createSessionCookie` fails *after* the password was accepted, which reads as
   a login bug rather than a permissions one. The same role is needed for V4
   signing, which goes through IAM when there is no local key.
3. **Cloud Storage** — object read/write on `$BUCKET_NAME` for that account.
4. **Secrets** — `DB_USER`, `DB_PASS`, `BUCKET_NAME`, `FIREBASE_API_KEY`,
   `GCP_CREDENTIALS`.
5. **Link the accounts** — `node scripts/link-firebase-users.mjs` (dry run),
   then `--apply`. Each person sets a password from the reset link in
   Admin → Users. Passwords do not transfer: Firebase cannot import Supabase's
   hashes.

## Still to do before cutover

- Migrate the data: `orders`, `profiles`, `clients`, `fulfillments`,
  `support_messages`, `order_events`, `vendors`, `vendor_payouts`,
  `subscriptions`, `notification_*`.
- Copy the `documents` bucket to `$BUCKET_NAME`, preserving the `path` values
  already recorded in `orders.workflow` — those are what re-signing uses.
- Point DNS at Cloud Run and retire the Vercel project.
