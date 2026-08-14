# Serverless API (`/api`)

Vercel serverless functions. The SPA rewrite in `vercel.json` excludes `/api`,
so these resolve to functions (not `index.html`). Files under `_lib/` are
shared modules, not routes.

## `POST /api/admin/users`

Admin User Management (CRUD). Gated: the caller's bearer token must resolve to a
profile with `role = 'admin'`. Uses the service-role client. Actions: `create`
(invite), `update`, `setActive` (activate/deactivate via auth ban),
`resetPassword` (recovery link), `remove` (hard delete). `GET` lists users.

### Environment variables (Vercel → Project → Settings → Environment Variables)
| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (falls back to `VITE_SUPABASE_URL`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only** service-role key (bypasses RLS). Never expose to the client. |

## Email — removed

Both halves of the email system have been removed and will be rebuilt from
scratch:

- **Outbound notifications** — `notify.js`, `_lib/mailer.js` and their tests.
  Nothing in the portal sends email today, and no Supabase Database Webhooks
  should point at this app.
- **Inbound email → draft order** — `webhooks/inbound-email.js`,
  `_lib/extractOrder.js`, `_lib/ordersRepo.js` and the `services/email_ingest`
  IMAP poller.

Client communication is portal-only in the meantime: clients converse in
`support_messages`, and only admins reply (enforced in RLS — see
`supabase/migrations/20260807000000_message_access_control.sql`). The previous
implementation is recoverable from git history if any of it is worth reusing.
