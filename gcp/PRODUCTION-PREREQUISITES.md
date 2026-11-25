# Production prerequisites — GCP migration 20261124000000

What must be true, and what must be done, before
`gcp/migrations/20261124000000_charge_and_client_functions.sql` runs against
**resolute_live** (Cloud SQL, PostgreSQL 15). Nothing in this repository runs
it there: this change was built and tested only on disposable PostgreSQL 15
containers (`gcp/test/run.sh`). Everything below is for the approved operator.

## What the migration does

Adds the four functions resolute_live is missing (per the verified production
findings) and the two notification types they fan out to:

| Function | Kind | Purpose |
| --- | --- | --- |
| `resolve_order_charge(text,text,text)` → void | SECURITY DEFINER | owner client approves/declines one pending fee (verbatim port of Supabase `20261117000000`) |
| `admin_create_client(text,text,text)` → jsonb | SECURITY DEFINER | admin match-or-create a client company by name (verbatim port of `20261104000000`) |
| `gcp_raise_order_charge(text,text,numeric)` → jsonb | SECURITY INVOKER | staff raise a pending fee in one call; RLS is the guard |
| `gcp_resolve_order_charge(text,text,text)` → jsonb | SECURITY DEFINER | resolve via `resolve_order_charge`, then enqueue `charge.approved`/`charge.declined` for the admin tier **explicitly** (spec B1 §6) |

plus `notification_types` rows `charge.approved` / `charge.declined`
(`ON CONFLICT DO NOTHING`). It changes **no existing row** — verified in the
harness by fingerprinting every customer table before and after.

It does **not** port the `notify_on_order_event` classifier change
(`20261117000000` part 2) or the `profiles.client_code` FK (`20261105010000`).

## 1. Approvals and change control (ADR 0003, spec B1 §11)

- [ ] **Claudio's cost approval** for a Cloud SQL migration, recorded with a
      reference you will pass as `RESOLUTE_CHANGE_APPROVAL`.
- [ ] Capture, before the change: the serving Cloud Run revision (currently
      `resolute-portal-00010-jay`) and image digest, and the preflight output.
- [ ] An on-demand Cloud SQL backup taken immediately before the apply, and
      point-in-time recovery confirmed enabled on the instance.
- [ ] **Contract sign-off for the two `gcp_*` functions (blocker).** Their
      signatures and error codes were reconstructed from spec B1 because the
      deployed GCP backend that would call them is not in this repository.
      Confirm the deployed `services/api` snapshot calls exactly
      `gcp_raise_order_charge(order_id text, label text, amount numeric) → jsonb`
      and `gcp_resolve_order_charge(order_id text, charge_id text, decision text) → jsonb`,
      mapping SQLSTATE `42501`→403, `22023`→422, `P0002`→404, `P0001`→409
      (see the function comments). If it expects anything else, revise the
      migration first — it refuses to add a second signature next to an
      existing one.

## 2. Access

- [ ] Connect through the **Cloud SQL Auth Proxy** (no public IP), e.g.
      `cloud-sql-proxy <PROJECT>:us-central1:<INSTANCE> --port 5432`.
- [ ] Password from Secret Manager into `~/.pgpass` or `PGPASSWORD` — never on
      a command line or in shell history.
- [ ] `psql` client **15 or newer** (the scripts use `\if` and `:{?var}`).
      Tested: psql 16 against server 15.
- [ ] A **migration runner** role that:
  - is a member of the role that **owns `public.orders`** (the functions are
    given to that owner — on Cloud SQL there is no superuser, and only the
    table owner bypasses RLS, so owned by anyone else the definer functions
    would silently update zero rows);
  - has `CREATE` on database `resolute_live` (for a schema that exists only
    inside the migration's transaction) and on schema `public`.
  Preflight row `owner / this role can run the migration` must be `OK`.
- [ ] The read-only preflight can run as any role, including a reviewer with no
      table privileges; it then marks data counts `UNVERIFIED` rather than
      reporting RLS-filtered zeros.

## 3. Schema prerequisites — all checked by `gcp/preflight.sh` (FAIL blocks)

- PostgreSQL ≥ 15.
- 39 columns with exact types on `orders`, `clients`, `profiles`,
  `order_events`, `notification_types`, `notification_outbox`, `auth.users`
  (listed in `gcp/preflight.sql`, `req_cols`).
- Functions, by exact signature: `auth.uid()`, `public.my_client_code()`,
  `public.is_admin()`, `public.is_staff()`, `public.client_name_key(text)`,
  `public.next_client_code()`, `public.intake_resolve_client(text,text,text)`,
  `public.enqueue_notification(text,text,jsonb,text,text,public.user_role[])`.
  The 18 Nov review confirmed only the first three intake functions; the rest
  must be confirmed by the preflight.
- Roles `authenticated` and `anon` exist.
- `orders`, `clients`, `profiles`, `order_events`, `notification_types`,
  `notification_outbox`, `notification_preferences` share one owner (or that
  owner has BYPASSRLS), and none has `FORCE ROW LEVEL SECURITY`.
- That owner can `EXECUTE` the dependency functions and has `CREATE` on `public`.
- No same-named function with a different signature. A same-signature copy must
  be **identical** to the reviewed definition (source, return type, defaults,
  SECURITY DEFINER, config, volatility) — otherwise the run aborts and changes
  nothing.

## 4. Review these WARN/INFO rows before applying

| Preflight row | Why it matters |
| --- | --- |
| `data / orders` | Must be non-zero. Exact only when the runner owns `orders`. |
| `notify / active admins with an email` | Zero means `charge.*` mail reaches nobody. |
| `notify / trigger notify_on_order_event` | If its classifier already knows charge events, the trigger and `gcp_resolve_order_charge` share the same dedupe seed, so each admin still gets **one** row. Spec B1 §6 prefers disabling the trigger for charge events and relying on the explicit enqueue. |
| `roles / service_role` + `app role …` | `services/api` needs the app login NOINHERIT, never superuser/BYPASSRLS, able to `SET ROLE authenticated` and `SET ROLE service_role` (BYPASSRLS). PostgreSQL 15 lets only a superuser create a BYPASSRLS role and Cloud SQL has none — if `service_role` is missing in production, sign-in cannot work and needs a separate decision. |
| `schema / reported on resolute_live: …` | `activity_record`, `document_referenced`, `guard_order_documents` exist only in the deployed snapshot; their definitions are not in this repo. |
| `data / profiles whose client_code has no client` | Must be 0 before the deferred `20261105010000` FK can be validated. |

## 5. Exact sequence (approved operator only)

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=resolute_live PGUSER=<migration runner>
gcp/preflight.sh --app-user <production app login>           # read-only; must print PREFLIGHT_RESULT=PASS
gcp/migrate.sh gcp/migrations/20261124000000_charge_and_client_functions.sql   # preflight + dry run, rolled back
CONFIRM_DATABASE=resolute_live RESOLUTE_CHANGE_APPROVAL=<approval ref> \
  gcp/migrate.sh --apply --app-user <production app login> \
  gcp/migrations/20261124000000_charge_and_client_functions.sql
```

`migrate.sh --apply` runs preflight → dry run → apply (one transaction) →
`preflight.sh --post`, and stops at the first failure. Keep the full output with
the change record; the `post-conditions ok:` line lists, per function, whether
it was `create`d or found `identical`.

## 6. After applying

- [ ] `gcp/preflight.sh --post` passed (migrate.sh runs it).
- [ ] Switch `services/api` `resolveCharge()` from `resolve_order_charge` to
      `gcp_resolve_order_charge` before cutover. On a resolute_live-shaped
      database the current call resolves the fee but **mails no admin** — the
      harness proves it, and the unmodified `charges.integration.mjs` fails
      exactly its two mail assertions there. (Code change — separate PR.)
- [ ] Zero-traffic Cloud Run preview verification (spec B1 §11.3) before
      promoting.

## 7. Rollback (forward-safe)

Only functions and two reference rows are added, so the safe rollback is to
stop calling them. If they must go, drop **only** the functions the apply
output listed as `create`:

```sql
begin;
drop function if exists public.gcp_resolve_order_charge(text,text,text);
drop function if exists public.gcp_raise_order_charge(text,text,numeric);
drop function if exists public.admin_create_client(text,text,text);   -- only if it was created
drop function if exists public.resolve_order_charge(text,text,text);  -- only if it was created
-- notification_types rows: keep them if any outbox row references them.
delete from public.notification_types t
 where t.key in ('charge.approved', 'charge.declined')
   and not exists (select 1 from public.notification_outbox o where o.type_key = t.key);
commit;
```

## 8. Recommended hardening (not applied by this change)

- `20260722000000_api_role_grants.sql` gives `service_role` ALL on every public
  table, and the app login can `SET ROLE service_role` (BYPASSRLS). The API
  uses it only for identity lookup and profile edits: `SELECT` on `auth.users`,
  `profiles`, `clients` and `UPDATE (name, role, client_code, super_admin,
  can_confirm_payments, permissions)` on `profiles`. Narrowing it to that
  limits what a compromised API connection can do.
- `CONNECT` on a new database is granted to `PUBLIC` by default. Consider
  `REVOKE CONNECT ON DATABASE resolute_live FROM PUBLIC` and granting it to the
  app and operator roles only. (The harness verified the app login cannot read
  or create tables elsewhere, but it can open a session and read the catalog.)
