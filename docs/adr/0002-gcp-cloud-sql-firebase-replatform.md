# ADR 0002 — Re-platform off Supabase onto Cloud SQL + Firebase Auth + Cloud Run

Status: **proposed** · 2026-10-14 · Workstream B (GCP migration)
· supersedes nothing; records the direction so the auth-critical phases are
reviewable against a stated target (as 0001 framed D2/D3)

## Context

Today the portal is a static Vite SPA plus a thin `api/` serverless layer, on
**Supabase**: Postgres + Auth (GoTrue) + RLS + Realtime + Storage. The browser
talks **directly** to Supabase — PostgREST exposes the tables and RLS enforces
who may see what. Four things Supabase gives us for free are load-bearing:

| Supabase provides | Cloud SQL has no equivalent — we must build |
| --- | --- |
| **PostgREST** — auto REST API over every table | a data-API tier the browser calls |
| **GoTrue** — auth, sessions, invite/reset email | Firebase Auth + token verification |
| **Realtime** — live order deltas (the E-1 feed) | a push channel (SSE or polling) |
| **Storage** — file uploads governed by RLS | Cloud Storage + access checks in code |

The target in `CLAUDE.md` is GCP (Cloud Run) with the database on **Cloud SQL
for PostgreSQL**, keeping the relational schema, the RLS policies and
`guard_order_handoff` **as-is**, and abstracting the Vercel/Supabase coupling
(`auth.uid()` / JWT claims, request/response handlers, rewrites) behind thin
adapters over portable modules (`api/_lib/`, `services/`). The database half is
already proven in `gcp/`: all 30 migrations apply on a vanilla Postgres 17 with
an `auth.uid()`/roles shim — **12 tables, 36 policies, 60 functions, 0 errors**,
RLS verified through injected claims.

**Hard constraint:** the Vercel + Supabase environment is in active testing by
the team lead and must keep running, undisturbed, throughout. We build the GCP
stack **side-by-side**, prove it, and **cut over last**, with Vercel + Supabase
kept warm as instant rollback.

## Decision

- **Authorization stays in the database.** The relational schema, RLS policies
  and triggers remain the single source of truth. No Firestore / non-relational
  store (it would force the security model to be rewritten).
- **Replace the four Supabase services:**
  - PostgREST → a **data-API tier** on Cloud Run (authenticated; injects
    per-transaction claims; runs under RLS as a **non-superuser** role).
  - GoTrue → **Firebase Auth** (Identity Platform), behind the existing
    `src/lib/backend.js` auth seam. `auth.users` maps the Firebase UID →
    `profiles.id` (uuid).
  - Realtime → Postgres `LISTEN/NOTIFY` bridged to the browser via **SSE** from
    the API (polling as a fallback behind a flag).
  - Storage → **Cloud Storage**; the dropped storage policies re-implemented as
    an access check **at signed-URL minting** in the API.
- **Introduce a backend provider seam** in the app: `VITE_BACKEND = supabase |
  gcp`, **default `supabase`**. Vercel runs the Supabase path unchanged; the GCP
  path is dormant unless explicitly selected. This is the mechanism that keeps
  the test env untouched and gives a one-flag rollback.
- **Portable modules** live in `api/_lib/` and `services/`; Cloud Run handlers
  are thin adapters over them (per `CLAUDE.md`).

## Non-negotiable security invariants (proven failure modes — see `gcp/README`)

1. **Connect as a non-superuser DB role.** Postgres skips RLS entirely for
   superusers / `BYPASSRLS`. Connecting as Cloud SQL's built-in `postgres` would
   silently drop client-PII masking, the billing-owner guard, message visibility
   and fulfillment scoping **all at once, with no error**.
2. **`auth.uid()` must return `profiles.id` (uuid), not the Firebase UID.**
   Firebase issues 28-char strings; every policy and FK is built on the uuid.
   `auth.users` maps one to the other; a raw Firebase UID makes `auth.uid()`
   throw on the cast and every policy with it.
3. **Claims are transaction-local and must not leak.** The API sets the claim
   per transaction (`set_config(..., true)`); a pooled connection that keeps the
   previous request's claim serves one user's rows to the next.
4. **Storage is guarded at URL minting.** Cloud Storage does not consult
   Postgres, so the nine `storage.objects` policies become code at the point a
   signed URL is created, and nothing else may mint one. **Until that exists,
   document access is unprotected** — so real document handling on GCP is gated
   on phase B5.

## Increments (each independently shippable; the Supabase path never regresses)

- **B0 — Infra as code + access.** Terraform for Cloud SQL (PG17, private IP,
  non-superuser app role), Cloud Run (web + api), Firebase / Identity Platform,
  Cloud Storage, Secret Manager, VPC connector, Artifact Registry, IAM. Keyless
  deploys via the existing Workload Identity Federation. A migration runner.
  Nothing wired to the app. Output: a provisioned, empty GCP **staging** stack.
- **B1 — Backend provider seam (app-side, non-breaking).** Factor
  `backend.js` / `supabase.js` into a provider interface (auth · data · realtime
  · storage). The Supabase provider is today's behaviour and the default; the
  GCP provider is stubs. No runtime change on Vercel; guarded by build + tests +
  lint.
- **B2 — Data-API tier (the core build).** Cloud Run Node service: verify the
  Firebase token → check out a **non-superuser** pooled connection → inject the
  claim **per transaction** → run RLS-enforced queries. One endpoint surface
  mirroring every `supabase.from(...)` the app uses (orders, profiles,
  clients/directory, support messages, billing, payouts, notification prefs,
  fulfillment). Logic in `api/_lib/`; the handler is a thin adapter.
  **Contract-tested for RLS parity** — extend the `gcp/` harness that measures
  per-role row counts.
- **B3 — Firebase Auth.** Wire the GCP auth provider to Firebase (client SDK)
  and the Admin SDK server-side; populate `auth.users` on user create/invite;
  port `api/admin/users.js`; rebuild invite / reset / set-password.
- **B4 — Realtime.** `LISTEN/NOTIFY` → SSE from the API; the GCP realtime
  provider feeds `OrderContext` deltas. Polling fallback behind a flag.
- **B5 — Storage + the signed-URL guard.** Cloud Storage; the API mints guarded
  signed URLs enforcing the dropped policies; storage provider swap. Only after
  this may documents/check-scans live on GCP.
- **B6 — Notifications on GCP.** `services/notify` runs as a Cloud Run job +
  Cloud Scheduler for the digest; SES / preview via env. Low effort — already
  portable by design.
- **B7 — Data migration + parallel run.** One-time ETL Supabase → Cloud SQL; the
  GCP staging stack exercised end-to-end with `VITE_BACKEND=gcp`; RLS-parity and
  smoke tests. Vercel + Supabase untouched.
- **B8 — Cutover.** Point production at the GCP stack (DNS / Cloud Run domain
  mapping). Vercel + Supabase kept warm as instant rollback; decommission later,
  once stable.

## What stays unchanged

- The schema, RLS policies, `guard_order_handoff`, the domain/authz model
  (`packages/domain`), the money controls, and E2 stage routing. The migration
  **moves** them; it does not rewrite them.
- The Vercel test env (the Supabase path) across B0–B7.

## Open decisions (confirm as each phase is reached)

- **Invite / reset email:** Firebase action links vs. our own SES templates.
- **Realtime transport:** SSE vs. polling (cost / complexity trade-off).
- **Data:** migrate existing Supabase data vs. a fresh start; whether to keep
  the two in sync during the parallel run.
- **Infra ownership:** who runs `terraform apply` — WIF/CI vs. a local operator.

## Consequences

- The bulk of the effort is **B2–B5** (API tier, auth, realtime, storage guard)
  — multiple weeks of focused work. B0 / B1 / B6 are comparatively light; B7 /
  B8 are procedural but need care.
- Ongoing **cost and ops rise**: always-on Cloud SQL, Cloud Run, Firebase;
  connection-pool discipline; secrets to manage. This is the price of leaving
  Supabase's managed surface.
- The **provider seam is permanent value** beyond the move: it de-risks the
  migration (one-flag toggle + rollback) and leaves the app provider-agnostic.
- AI/automation remains blocked on Vercel per `CLAUDE.md`; the post-migration AI
  extraction goal rebuilds behind one provider-agnostic seam and is **out of
  scope for this ADR**.
