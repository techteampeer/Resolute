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

## `POST /api/orders/email-intake`

Order intake for orders that arrive by email. Machine-to-machine: Google Apps
Script reads the intake inbox, sends the message to Vertex AI / Gemini, and
POSTs the already-extracted JSON here. This app reads no mail and runs no
extraction. Gated by a shared secret in the `x-intake-secret` header; an unset
secret disables the endpoint (503) rather than opening it. Creates one normal
order in the existing initial Admin state, deduplicated on the source
`Message-ID`. Logic lives in `services/email_intake/` — see its README for the
payload, the response table and the manual curl.

### Environment variables
| Var | Purpose |
|---|---|
| `EMAIL_INTAKE_API_SECRET` | **Server-only** shared secret for `x-intake-secret`. Unset ⇒ endpoint disabled. |

There is no intake-mailbox variable: the queue is a Gmail label configured in
the Apps Script project, and this app never reads mail.

## Email — the inbound mail reader is still removed

- **Outbound notifications** — rebuilt as one cycle in `services/notify/`; still
  no Vercel adapter, and no Supabase Database Webhooks should point at this app.
- **The old inbound reader** — `webhooks/inbound-email.js`, `_lib/extractOrder.js`,
  `_lib/ordersRepo.js` and the `services/email_ingest` IMAP poller are gone and
  stay gone. They carried the on-Vercel AI extraction seam, which is what
  `/api/orders/email-intake` avoids by taking already-extracted JSON.

Client communication is portal-only in the meantime: clients converse in
`support_messages`, and only admins reply (enforced in RLS — see
`supabase/migrations/20260807000000_message_access_control.sql`). The previous
implementation is recoverable from git history if any of it is worth reusing.
