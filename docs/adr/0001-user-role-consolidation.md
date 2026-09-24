# ADR 0001 — Consolidate the production desks into one `user` role

Status: **accepted — complete** · 2026-09-22 · Workstream D of the roadmap
· D1 + D2 + D3 shipped

## Context

Today staff production work is split across five roles: four pipeline-stage
roles (`screener`, `examiner`, `typer`, `delivery`) that each log into their own
portal and see only orders on their own desk, plus `operator` — the "Single
Seating" desk that already works an order end-to-end through every stage with
Admin approval between phases.

The business wants **one production login**: a staff member should be able to
pick up an order at whatever stage it is in, rather than there being separate
screener / examiner / typer / delivery accounts. This is exactly the existing
Single Seating model, generalized and made the default.

## Decision

- Introduce a single production role, **`user`**, that is the generalized Single
  Seating desk. The **Admin approval gate between every stage is kept**.
- The four stage names (`screener` → `examiner` → `typer` → `delivery`) survive
  **only as pipeline-stage identifiers** (`ROLE_SEQUENCE`, `statusForRole`,
  `roleAfter`) — the position an order is at — **not as login roles**.
- Login roles become: `admin`, super-admin (the `super_admin` flag on `admin`),
  `user`, `client`.
- The pipeline, the state machine, and the money core are unchanged — a `user`
  works the current stage exactly as the operator does today (`nextRoleFor`
  drives which stage view is shown; `returnToAdmin` keeps the gate).

## Increments

- **D1 — rename `operator` → `user`** (done). A mechanical, backward-compatible
  rename establishing the `user` role and the `/user` workspace. The four stage
  roles keep working, so nothing breaks; RLS is untouched (it is generic:
  `is_staff()` = `role <> 'client'`, and `orders_update_assigned` keys on
  `assigned_to = my_role()`). The enum value is renamed in place
  (`ALTER TYPE user_role RENAME VALUE 'operator' TO 'user'`), and the one DB
  function that hardcodes the role list (`notify_on_order_event`) is re-created to
  recognise `user`.
- **D2 — make `user` the standard production workspace** (done). The `/user`
  workspace — which already shows the current stage view and works an order
  end-to-end with the approval gate — is reframed as the standard **Production
  Desk** (no longer a special "Single Seating" mode): renamed in the workspace
  header, the staff login picker, and Admin's assignment surfaces. Admin now
  routes into the `user` pool **by default** — the Assign modal pre-selects the
  Production Desk and presents it first; the four stage desks drop to a secondary
  "specific stage desk" group, kept working for accounts not yet migrated
  (retired in D3). No schema or RLS change — those land in D3.
- **D3 — retire the stage *login* roles + migrate accounts** (done). A migration
  re-roles every existing `screener`/`examiner`/`typer`/`delivery` profile to
  `user` and re-points any in-flight order still on a stage desk into the `user`
  pool. The RLS capability is tightened from `orders_update_assigned`'s
  `assigned_to = my_role()` (login-role == queue-name coupling) to an explicit
  production-capability check — `can_work_production()` (`my_role() = 'user'`)
  `and assigned_to = 'user'` — so a `user` may act on any order in the production
  pool. The four stage portals, routes, and login-picker entries are removed; the
  Admin surfaces and `api/admin/users.js` no longer mint stage roles. Left
  untouched by design: `orders_write_admin`, the Vivek `can_confirm_payments`
  money controls, the `guard_order_handoff` gate (role-agnostic — still enforces
  the Admin gate for `user`), and the `support_admin_reply` client-reply split.
  The `user_role` enum keeps the stage labels (Postgres can't drop enum values;
  they remain valid as pipeline identifiers / historical `assigned_to`).

## Consequences

- D1 alone does not merge the four logins yet; it lays the role down. The visible
  consolidation lands in D2/D3.
- Because the enum value is renamed in place, existing `operator` profiles become
  `user` automatically. A deploy applies the migration and ships the matching
  frontend together; the rename is atomic, and there are effectively no live
  `operator` end users to strand.
- This ADR supersedes nothing; it records the direction so the auth-critical
  changes in D2/D3 are reviewable against a stated target.
