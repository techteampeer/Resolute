# Supabase backend — go-live runbook

The app is **fully wired for Supabase**: auth, orders, fulfillment documents,
file storage, client payment terms, vendors & payout ledger, subscriptions, and
an append-only audit trail. It falls back to mock data whenever the two `VITE_`
env vars are absent, so nothing breaks while you set this up.

> Architecture: **Vercel** hosts the static SPA; **Supabase** is the backend
> (Postgres + Auth + Storage + Realtime), called from the browser with the
> **anon key + Row-Level Security**. The whole schema is portable Postgres, so
> the later AWS move is a `pg_dump` → RDS restore plus swapping Auth/Storage
> behind `src/lib/backend.js`.

## Go-live checklist (~15 minutes)

1. **Create a project** at [supabase.com](https://supabase.com) (pick a region
   near your users; note the database password somewhere safe).

2. **Run the SQL.** All schema lives in `supabase/migrations/` as timestamped
   files the Supabase CLI applies automatically **in filename order**:

   | File | Contents |
   |---|---|
   | `20260601000000_init.sql` | tables, enums, RLS, storage bucket, profile trigger |
   | `20260615000000_operator_portal.sql` | operator role + workflow column |
   | `20260620000000_payment_system.sql` | client payment terms |
   | `20260625000000_email_ingest.sql` | inbound-email draft orders support |
   | `20260713000000_vendor_payouts_billing.sql` | vendors, payout ledger, subscriptions, audit trail, order-ID sequence |

   **Migrations are schema only**, so `db push` produces a clean, empty
   production database. Demo/sample data (clients, orders, vendors,
   subscriptions) and the ten demo logins live in `supabase/seed.sql`, which
   the CLI applies on local `supabase db reset` **only** — never on `db push`.
   Production has no default accounts.

   **Via CLI (preferred):** `supabase link --project-ref <ref>` then
   `supabase db push` — applies anything not yet applied, tracked in the
   `supabase_migrations` table.

   **Via dashboard (no CLI):** SQL Editor → paste + Run each file in the
   filename order above. All files are idempotent.

3. **Create your first admin** (production has no seeded accounts).
   Authentication → Users → Add user → email + password, tick **Auto
   Confirm**. The `handle_new_user` trigger creates the profile automatically
   (default role `client`); promote it in the SQL Editor:
   ```sql
   update public.profiles set role='admin', super_admin=true
   where email='you@yourfirm.com';
   ```
   Add the rest of your staff the same way — set each profile's `role`, and
   `super_admin=true` only for the billing/super admins. No default passwords
   ever exist in production.

4. **Set env vars** (values from Project Settings → API):
   - Local: copy `.env.example` → `.env.local`, fill
     `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
   - Vercel: Project → Settings → Environment Variables → add the same two →
     redeploy.

5. **Verify** (with the accounts you created in step 3): place a client order
   (ID should come from the DB sequence); screen one to ABS; enter a vendor
   fee as a super admin; mark it paid as the billing admin; refresh —
   everything must survive. Open a second browser as another role and watch
   realtime updates land.

## Local development (Supabase CLI)

```bash
supabase start      # boots local Postgres/Auth/Storage in Docker
supabase db reset   # (re)applies every migration + seeds — full Resolute schema
```

- `supabase start` prints a local URL + anon key. **These are the CLI's public
  demo defaults, identical on every machine — not secrets.** Put them in
  `.env.local` (`VITE_SUPABASE_URL=http://127.0.0.1:54321`,
  `VITE_SUPABASE_ANON_KEY=<printed anon key>`) to run the app against the
  local stack; never reuse them for the cloud project.
- The local MCP endpoint (`http://localhost:54321/mcp`, registered in
  `.mcp.json` as `supabase`) lets Claude Code query the local database
  directly. `supabase-cloud` is the hosted MCP for the real project.
- Demo logins + sample data are seeded locally by `supabase/seed.sql`
  (applied on `supabase db reset`, never on `db push`).

## Operational practices

- **Backups**: Database → Backups → enable Point-in-Time Recovery on the
  production project. Take a manual `pg_dump` before running any migration.
- **Two projects**: create a second (free) project as dev/staging; run the same
  SQL there and point `.env.local` at it, so testing never touches prod data.
- **New migrations**: never edit an already-applied migration — add a new
  timestamped file under `supabase/migrations/`
  (`supabase migration new <name>` generates one) and `supabase db push`.
- **Service-role key**: only the **anon** key goes in the browser (`VITE_*`).
  The service-role key is used solely by `api/webhooks/inbound-email.js`
  (set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` as Vercel server env vars,
  never `VITE_`-prefixed).

## What lives where

| Data | Store |
|---|---|
| Orders (incl. payments & abstractor fees in `workflow` JSONB) | `orders` table, realtime-subscribed |
| Vendor payout financial record | `vendor_payouts` table (constrained mirror of `workflow.abstractorFee`) |
| Vendors + payout cycles | `vendors` table |
| Subscriptions | `subscriptions` table |
| Client payment terms | `clients.payment_terms` |
| Audit trail (who did what, when) | `order_events` (append-only: no update/delete policies) |
| Fulfillment documents | `fulfillments` JSONB |
| Uploaded files | private `documents` storage bucket (paths stored, signed URLs generated on demand) |
| Users/roles | Supabase Auth + `profiles` (role, super_admin, client_code) |

## Security notes

- RLS is **on** for every table (default-deny). Staff read all orders; clients
  read only rows matching their `client_code`; role users may update only
  orders in their own queue; `order_events` accepts inserts but never
  updates/deletes.
- Fine-grained business rules (only Vivek confirms/pays, Single Seating
  claiming) are enforced in the app layer by design — they move to the API
  layer in the AWS migration rather than living in RLS.
- Member-admin "client code only" is enforced in the app (`displayClient`);
  a column-masked view can harden this at the DB level later.
