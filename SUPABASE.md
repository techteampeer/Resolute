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

2. **Run the SQL** — SQL Editor → paste + Run each file **in this order**:
   1. `supabase/schema.sql` — tables, enums, RLS, storage bucket, seed clients/orders
   2. `supabase/migrations/operator_to_latest.sql` — operator role + workflow column
      (run PART 1 alone first if the editor complains about new enum values)
   3. `supabase/migrations/payment_system.sql` — client payment terms + Vivek account
   4. `supabase/migrations/email_ingest.sql` — inbound-email draft orders support
   5. `supabase/migrations/vendor_payouts_billing.sql` — vendors, payout ledger,
      subscriptions, audit trail, order-ID sequence, **and all demo user accounts**

3. **Users are seeded automatically** by step 2.5 with the same demo
   credentials the mock login uses (rajni/saravanan/vivek/admin/screener/
   examiner/typer/delivery/client/operator @resolute.com).
   **Change these passwords before real data enters the system** —
   Authentication → Users → each user → Reset password.

4. **Set env vars** (values from Project Settings → API):
   - Local: copy `.env.example` → `.env.local`, fill
     `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
   - Vercel: Project → Settings → Environment Variables → add the same two →
     redeploy.

5. **Verify**: log in as each role; place a client order (ID should come from
   the DB sequence); screen one to ABS; enter a fee as Rajni; mark it paid as
   Vivek; refresh — everything must survive. Open a second browser as another
   role and watch realtime updates land.

## Operational practices

- **Backups**: Database → Backups → enable Point-in-Time Recovery on the
  production project. Take a manual `pg_dump` before running any migration.
- **Two projects**: create a second (free) project as dev/staging; run the same
  SQL there and point `.env.local` at it, so testing never touches prod data.
- **New migrations**: never edit `schema.sql` after go-live — add a new
  numbered file under `supabase/migrations/` and run it in prod once.
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
