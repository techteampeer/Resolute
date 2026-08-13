# Serverless API (`/api`)

Vercel serverless functions. The SPA rewrite in `vercel.json` excludes `/api`,
so these resolve to functions (not `index.html`). Files under `_lib/` are
shared modules, not routes.

## `POST /api/admin/users`

Admin User Management (CRUD). Gated: the caller's bearer token must resolve to a
profile with `role = 'admin'`. Uses the service-role client. Actions: `create`
(invite), `update`, `setActive` (activate/deactivate via auth ban),
`resetPassword` (recovery link), `remove` (hard delete). `GET` lists users.
Requires `SUPABASE_SERVICE_ROLE_KEY`.

## `POST /api/notify` — email notifications

Sends templated emails for portal activity (new order, status change,
clarification, new message). Driven by **Supabase Database Webhooks** on inserts
into `public.order_events` and `public.support_messages`, so every event already
written to those tables produces an email — no client wiring, full coverage of
server-side events.

### Routing (role-based defaults, in code — no per-user preferences)

| Event | Recipients |
|---|---|
| New order placed | Admins |
| Order assigned / handed to a stage | The staff on that stage |
| Stage completed, returned for assignment | Admins |
| Order delivered | The client + the owning staff |
| Cancellation requested | Admins |
| Cancellation approved / declined | The client |
| Clarification, hold, payment, status change | The client |
| Client sends a message | Admins |
| Admin replies to a client | The client |
| Internal staff note | Admins |

`order_events.audience` (`staff` / `client` / `all`) selects the groups. For
staff-facing events the recipient is whichever role currently owns the order
(`orders.assigned_to`), read at send time so it is always accurate; inactive
profiles are skipped. One event can notify several groups — each is sent
independently, so one failure can't drop the others.

The routing table is asserted in `api/__tests__/notify.test.js` (`npm test`),
which runs without a database or SMTP.

### Environment variables
| Var | Purpose |
|---|---|
| `SMTP_HOST` | e.g. `smtp.gmail.com`. **If unset, emails are composed but not sent** (dev/test). |
| `SMTP_PORT` | e.g. `465` |
| `SMTP_USER` | the Gmail address (also the default From) |
| `SMTP_PASS` | the Gmail **app password** (the same one the IMAP ingest uses) |
| `MAIL_FROM` | optional From override |
| `NOTIFY_SECRET` | shared secret; the webhook must send it as header `x-notify-secret` |
| `NOTIFY_ADMIN_EMAIL` | optional; comma-separated admin recipients (else all `admin` profiles) |

### Configure the two webhooks (Supabase → Database → Webhooks → *Create*)
For **each** table `public.order_events` and `public.support_messages`:
- Events: **Insert**
- Type: **HTTP Request** → `POST https://<your-app>.vercel.app/api/notify`
- HTTP Headers: add `x-notify-secret: <your NOTIFY_SECRET>`

The webhook body Supabase sends (`{ type, table, record, ... }`) is exactly what
`/api/notify` expects. To send via SMTP you must set the `SMTP_*` vars; without
them the endpoint returns `sent:true, live:false` (composed only).

## `POST /api/webhooks/inbound-email`

Inbound email → draft order pipeline:
1. Accepts an inbound-email JSON payload (`{ from, subject, text, attachments[] }`;
   also tolerates SendGrid/Postmark/Mailgun field names).
2. Extracts `propertyAddress`, `parcelNumberAPN`, `borrowerName`, `orderType`
   via the LLM service (`_lib/extractOrder.js`) using a **forced Claude tool
   call** for strict JSON structured output.
3. Inserts a draft order via `_lib/ordersRepo.js` — status **`received`**,
   `assigned_to: 'screener'` (the draft/pending-review equivalent; lands in the
   Screener intake queue). Extracted fields are stored on `orders.workflow.intake`.
4. Returns **200** on receipt (even if a downstream step fails — logged
   server-side — so the provider doesn't retry-storm; `400` only for malformed JSON).

### Environment variables (Vercel → Project → Settings → Environment Variables)
| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (falls back to `VITE_SUPABASE_URL`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only** service-role key (bypasses RLS). Never expose to the client. |
| `ANTHROPIC_API_KEY` | Enables LLM extraction. If absent, a regex heuristic fallback runs. |
| `ANTHROPIC_MODEL` | Optional; defaults to `claude-sonnet-5`. |
| `INBOUND_WEBHOOK_SECRET` | Optional; if set, requests must send header `x-webhook-secret`. |

### Test
```bash
curl -X POST https://<your-app>.vercel.app/api/webhooks/inbound-email \
  -H 'content-type: application/json' \
  -d '{
    "from":"casey@apexlending.com",
    "subject":"New lien search order",
    "text":"Please open a Lien Search for borrower Jordan Miller at 123 Oak St, Miami, FL 33101. APN 01-2345-678-9012."
  }'
# → { "received": true, "orderId": "RTS-10049", "status": "received", "extraction": "llm", "fields": {...} }
```

> Note: attachment **text** is used for extraction. Binary PDFs are not OCR'd
> here — pass `attachments[].text` (most providers include parsed text) or add
> an OCR step later.
