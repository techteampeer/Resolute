# ADR 0001 — Consolidate the production desks into one `user` role

Status: **accepted (in progress)** · 2026-09-22 · Workstream D of the roadmap
· D1 + D2 shipped; D3 remaining

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

- **D1 — rename `operator` → `user`** (this PR). A mechanical, backward-compatible
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
- **D3 — retire the stage *login* roles + migrate accounts.** Re-role existing
  `screener`/`examiner`/`typer`/`delivery` accounts to `user`; tighten the RLS
  capability so a `user` may act on any order in a production stage assigned to
  the user pool; remove the stage portals. (This is where the account-migration
  and RLS-capability decisions land — done as its own reviewed PR.)

## Consequences

- D1 alone does not merge the four logins yet; it lays the role down. The visible
  consolidation lands in D2/D3.
- Because the enum value is renamed in place, existing `operator` profiles become
  `user` automatically. A deploy applies the migration and ships the matching
  frontend together; the rename is atomic, and there are effectively no live
  `operator` end users to strand.
- This ADR supersedes nothing; it records the direction so the auth-critical
  changes in D2/D3 are reviewable against a stated target.
