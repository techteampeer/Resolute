# Spec — B4: Vercel/migration reconciliation on GCP

Status: **partially implemented in repo (verifiable slice)** · 2026-11-20 ·
parent: ADR 0003 (blocker B4) · Vercel reference: `api/admin/users.js`,
`api/_lib/supabaseAdmin.js`.

B4 is "port `api/admin/users.js` and the four new migrations as GCP-native code;
reconcile `20261105010000_profile_client_code_fk.sql` against the real
`resolute_live` schema." Unlike B1/B2, B4's core is **not fully buildable in this
repo**, and the reason is structural — recorded here so it isn't rediscovered.

## Why most of B4 is env-gated
`api/admin/users.js` is mostly **Supabase Auth Admin** operations (createUser,
generateLink, ban, listUsers, deleteUser). The GCP equivalent is **Firebase Auth
Admin**, and user provisioning also needs the GCP `auth.users`/`firebase_uid`
mapping that `services/api/src/auth.js` already assumes (`where u.firebase_uid =
$1`). **Neither is in this repo:** the repo's `auth.users` is Supabase Auth's
table (it has `encrypted_password`/`instance_id`, no `firebase_uid`), and there is
no Firebase emulator in CI. So create / remove / setActive / resetPassword and the
user listing cannot be faithfully built or verified here — they belong to
committing the deployed Firebase auth backend (ADR 0003 B3 / decision #5).

## What landed (the verifiable in-repo slice)
- **Portable logic** — `services/api/src/adminUsers.js`: `cleanPermissions`,
  `touchesElevated`, `buildProfilePatch`, `ROLES`, `ELEVATED`, `genPassword`,
  lifted verbatim from the Vercel handler so a route is a thin adapter (CLAUDE.md).
  Pure, unit-tested (`__tests__/adminUsers.test.js`, CI build job).
- **Profile-edit path** — `repositories/adminUsers.js` (`getProfilePrivilege`,
  `badClientLink`, `updateProfile`) + `routes/adminUsers.js` mounted at
  `/api/admin/users` (the admin UI calls this path directly, so the same URL
  serves both backends). The `update` action is fully wired:
  - **Authorization is the route's code gate** (admin; super-admin for elevated
    grants), because the write runs under `withServiceRole`. That is required:
    the `profiles_guard_privilege_columns` trigger (migration 20260901220000)
    rejects any role/super_admin/client_code/status change unless the caller has
    no `auth.uid()`, i.e. the service role — the same choice the Vercel handler
    makes. The gate is therefore the ONLY guard; keep it airtight.
  - Carries the **`badClientLink` FK guard** (a client user must point at a real
    `clients` row — the "newly created client can't place orders" bug) and the
    demotion-clears-elevated rule.
- **Fail-safe for the env-gated actions** — create/remove/setActive/resetPassword
  and GET listing return a clear **501** ("needs the Firebase Auth admin
  backend"), never a fake success.

### Tests
`__tests__/adminUsers.integration.mjs` — supertest → the real router →
`withServiceRole` → the privilege-guard trigger, over a live Postgres: non-admin
403, plain-admin edit, the `badClientLink` 400s, the valid-client link, the
super-admin-only elevated grant (plain admin → 403), demotion clearing, the id/
unknown-id/unknown-action 400s, and the 501s for the env-gated actions. It edits a
spare demo `user` and restores it in `finally`. Wired into the `db-integrity`
lane (`test:integration` now runs B1 + B2 + B4).

## Still open (env-gated / needs the deployed snapshot)
1. **User provisioning** (create/remove/setActive/resetPassword/list) on Firebase
   Auth Admin + the GCP `auth.users`/`firebase_uid` schema — part of committing
   the deployed auth backend (ADR 0003 B3 / #5).
2. **Migration reconciliation** — the four recent migrations
   (`20261104000000` admin_create_client, `20261105000000` resolve_order_charge,
   `20261117000000` charge_notifications, `20261105010000` profile_client_code_fk).
   B1/B2 already REUSE the charge + client functions as GCP routes; what remains is
   landing them (esp. the `profile_client_code_fk` FK) on `resolute_live` as a
   reviewed GCP migration — env-gated, Claudio's cost approval.
   **Prepared, not applied (2026-11-24):** `gcp/migrations/20261124000000_charge_and_client_functions.sql`
   ports `admin_create_client` + `resolve_order_charge` (+ the `charge.*`
   notification types) and adds `gcp_raise_order_charge` / `gcp_resolve_order_charge`,
   behind `gcp/preflight.sh` (read-only) and `gcp/migrate.sh`, verified on
   disposable PostgreSQL 15 over populated data (`gcp/test/run.sh`). The FK is
   still separate. Steps and sign-offs: `gcp/PRODUCTION-PREREQUISITES.md`.
