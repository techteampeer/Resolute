# Email order intake (`services/email_intake`)

A second way for a client to place an order: they email it. The extraction
happens entirely **outside this repo** — Google Apps Script reads the intake
inbox, sends the message to Vertex AI / Gemini, and POSTs the structured result
to this app. Nothing here reads Gmail, and no AI library is added to the Vercel
deployment.

```
client email → Gmail → Apps Script → Vertex AI / Gemini
                                          ↓ structured JSON
                          POST /api/orders/email-intake   (x-intake-secret)
                                          ↓
             validate → deduplicate → resolve client → insert order
                                          ↓
                     one normal Resolute order, parked with Admin
```

## The order is a normal order

There is no email-only lifecycle. `buildOrderRow()` writes the same column set
as `insertOrder()` in `src/lib/backend.js`, with the same defaults `createOrder()`
in `src/context/OrderContext.jsx` applies: `status 'received'`,
`assigned_to 'admin'`, `progress 5`, `payment 'Check'`, no pipeline role
assigned, no ETA. The only difference is `workflow.intake.source`, which is
`'email'` instead of `'web'` — a value the portal already understands
(`FulfillmentScreen` renders a "via email" marker and the From/Subject block for
it, and Admin's confirm step asks for a negotiated price on any non-`'web'`
order).

Because the order is a plain `orders` insert, the audit trail and notifications
come for free: the `orders_log_created` trigger writes the `order_events` row,
which the `order_event_notify` trigger turns into an `order.new` notification to
Admin. Nothing in this module knows about either. Clients are never emailed.

## Client identity

`client_identifier` must be a **`clients.code`** (`CL01`, …). That is the repo's
only deterministic client mapping: `clients.code` is the primary key and
`orders.client_code` is its foreign key. An unresolvable code is rejected (422)
and no order is created.

The sender address is recorded at `workflow.intake.from` for reference and is
**never** used to establish identity. There is no reliable address→client
mapping in the schema — `clients.email` is a single contact field with no
uniqueness constraint — and trusting a sender address would also mean trusting
a spoofable one.

## Layout

| File | Responsibility |
|---|---|
| `schema.js` | Validate + normalise the payload. Pure; no Supabase, no env. Owns `SEARCH_CATALOG`, derived from `src/data/products.js`. |
| `intake.js` | `processIntake(payload, deps)` — the pipeline. Pure; every side effect is injected. Also exports `buildOrderRow()`. |
| `store.js` | `createDeps()` — the only file that touches Supabase (service-role client). |
| `apps-script-example.gs` | Reference only. The Google-side half, ~40 lines. Not deployed from here. |
| `__tests__/intake.test.js` | `node:test`. Runs with no database and no network. |

Nothing in `services/email_intake/` knows it runs on Vercel — `api/orders/email-intake.js`
is a ~60-line adapter, so the AWS move replaces the adapter and not the logic.

## Payload

Required: `email_message_id`, `client_identifier`, `search_type`,
`property_address`, `county`.
Optional: `state` (2-letter), `parcel_apn`, `parties`, `instructions`,
`source_email`, `subject`, `client_file_no`, `priority` (`normal`|`rush`),
`received_at`. Unknown keys are ignored.

`search_type` must be exactly one of the portal's catalog names. An off-catalog
value is **rejected, never defaulted** — a guessed search type is a mispriced,
mis-scoped order. `parties` accepts `["Jane Doe"]` or
`[{ "role": "buyer", "name": "Jane Doe" }]`; recognised roles fill
`intake.buyer` / `intake.seller` / `intake.borrowerName`, and anything else is
appended to `intake.specialInstructions` so Admin still sees it.

## Responses

| Outcome | Status | Body |
|---|---|---|
| Order created | `201` | `{ ok: true, duplicate: false, orderId, status, assignedTo, clientCode }` |
| Already processed | `200` | `{ ok: true, duplicate: true, orderId, … }` |
| Bad/missing fields | `400` | `{ error, code: 'invalid_payload', field }` |
| Missing/wrong secret | `401` | `{ error: 'Unauthorized' }` |
| Not a POST | `405` | `{ error: 'Method not allowed' }` |
| Unknown client | `422` | `{ error, code: 'unknown_client', field }` |
| Secret not configured | `503` | `{ error: 'Email intake is not configured' }` |
| Server/DB failure | `500` | `{ error: 'Intake failed' }` |

`4xx` means the payload is wrong — do not retry. `5xx` is ours and is safe to
retry, because `email_message_id` makes a retry idempotent.

## Idempotency

Apps Script retries, and so does the network. The same email must only ever
become one order:

1. `findByMessageId()` checks `workflow->intake->>messageId` before anything
   with a side effect.
2. `20260902000000_email_intake_idempotency.sql` adds a **partial** unique index
   on that expression, so two simultaneous retries cannot both pass the check —
   one insert wins and the loser's `23505` is turned back into "here is the
   order that already exists".

The index is partial because website- and admin-placed orders never set
`messageId`; they are not in the index and the Place Order flow is untouched.

`<abc@host>` and `abc@host` dedupe to the same key. Case is preserved — the
local part of a Message-ID is case-sensitive, and folding it could collapse two
genuinely different messages into one order.

## Environment

| Var | Purpose |
|---|---|
| `EMAIL_INTAKE_API_SECRET` | Shared secret for the `x-intake-secret` header. **Server-only.** Unset ⇒ the endpoint is disabled (503), never open. |
| `TEST_INTAKE_EMAIL` | The temporary inbox Apps Script watches during the pilot. Read by the Google side only; this app never reads it. Replaced by the real intake address later. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Existing server-only vars; the service-role client bypasses RLS. |

## Manual test

```sh
curl -sS -X POST "$PORTAL_URL/api/orders/email-intake" \
  -H 'content-type: application/json' \
  -H "x-intake-secret: $EMAIL_INTAKE_API_SECRET" \
  -d '{
    "email_message_id": "<CAB-1234@mail.gmail.com>",
    "source_email":     "dana@lakewoodtitle.com",
    "client_identifier":"CL01",
    "search_type":      "Full Search",
    "property_address": "880 Main St, Houston, TX 77002",
    "county":           "Harris",
    "state":            "TX",
    "parcel_apn":       "0660110000021",
    "parties":          [{"role":"buyer","name":"Taylor Brooks"}],
    "instructions":     "Closing is tight."
  }'
```

First call → `201 {"ok":true,"duplicate":false,"orderId":"RTS-…","status":"received","assignedTo":"admin"}`.
Re-run the identical command → `200` with `"duplicate":true` and the same
`orderId`. The order appears in Admin's **Awaiting Approval** tab.
