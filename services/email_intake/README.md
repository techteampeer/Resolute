# Email order intake (`services/email_intake`)

A second way for a client to place an order: they email it. The extraction
happens entirely **outside this repo** — Google Apps Script reads the intake
inbox, sends the message to Vertex AI / Gemini, and POSTs the structured result
to this app. Nothing here reads Gmail, and no AI library is added to the Vercel
deployment.

```
client email → Gmail (label:resolute is:unread — every message, no subject filter)
             → Vertex AI / Gemini → CLIENT_CODE_MAP → [optional Sheet test log]
                                          ↓ structured JSON
                          POST /api/orders/email-intake   (x-intake-secret)
                                          ↓
             validate → deduplicate → resolve client → insert order
                                          ↓
                     one normal Resolute order, parked with Admin
```

The Gmail and Vertex half is the project-lead Apps Script, unchanged: the
`label:resolute is:unread` queue, both the plain and HTML bodies sent to the
model so `customerLink` survives as a real href, the OAuth-token Vertex call,
and the 5-minute time-driven trigger. There is **no subject gate**: clients send
unstructured emails, so every unread message under the label goes to Vertex AI.
A `RES-` number in the subject is read as optional metadata when present and is
never required.

The Google Sheet is a **testing aid only** — it records what was extracted and
what the API answered so a pilot run can be eyeballed. Nothing is read back out
of it to make a decision and a logging failure changes nothing; there is no
Sheet in the production path.

Columns: Processing Timestamp · Gmail Message ID · Order Number · Customer ·
Client Email · Customer File · Customer Link · Property Address ·
API Result / Detail. **Client Email is the extracted `contactEmail`, never
`message.getFrom()`** — a forwarded order carries the forwarder's address, not
the client's.

The sheet keeps one row per Gmail message: a message logged again (an API
failure then a later success, or a re-run of the trigger) updates its existing
row in place rather than appending a second. That is the *sheet's* duplicate
protection and is entirely separate from the API's Postgres unique index —
neither affects the other, and order creation is never decided by anything in
the sheet. Note the layout adds two columns to the original six, so an existing
pilot sheet should get a fresh tab rather than mixing layouts.

Unread mail is the work queue. Apps Script marks a message read **only** after
the API returns `201 created` or `200 duplicate`. An extraction failure, an
unmapped customer, a validation rejection or a transport error all leave it
unread, so nothing is silently lost. (The lead script marked every message read
unconditionally; that is the one behaviour deliberately changed, because it
dropped anything that failed.)

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

`client_identifier` must be a **`clients.code`** (`CL01`, …), matched exactly.
That is the repo's only deterministic client mapping: `clients.code` is the
primary key and `orders.client_code` is its foreign key. An unresolvable code is
rejected (422) and no order is created.

**Gemini never produces a client code.** It has no way to know that "Lakewood
Title Group" is `CL01`, and a hallucinated code would attach a real order to the
wrong client's billing. The model returns the company/customer name it read, and
Apps Script maps that to a code through an explicit, operator-maintained
`CLIENT_CODE_MAP` script property. An unmapped company is **not posted at all**
and its email is left unread for a human to map.

The company name (`workflow.intake.company`) and the sender address
(`workflow.intake.sourceEmail`) are recorded for reference and are **never**
consulted for identity — `clients.email` has no uniqueness constraint, and a
sender address is spoofable.

## Layout

| File | Responsibility |
|---|---|
| `schema.js` | Validate + normalise the payload. Pure; no Supabase, no env. Owns `SEARCH_CATALOG`, derived from `src/data/products.js`. |
| `intake.js` | `processIntake(payload, deps)` — the pipeline. Pure; every side effect is injected. Also exports `buildOrderRow()`. |
| `store.js` | `createDeps()` — the only file that touches Supabase (service-role client). |
| `apps-script-example.gs` | Reference only. The Google-side half: poll → extract → map company to code → post → mark read. Not deployed from here. |
| `__tests__/intake.test.js` | `node:test`. Runs with no database and no network. |

Nothing in `services/email_intake/` knows it runs on Vercel — `api/orders/email-intake.js`
is a ~60-line adapter, so the AWS move replaces the adapter and not the logic.

## Payload → existing schema

No column was added to mirror an intake field name. Everything lands on the
columns and the `workflow.intake` keys the portal already writes and renders.

**Required**

| Field | Lands on |
|---|---|
| `property_state` | `orders.state` — 2-letter code, upper-cased; anything else is rejected |
| `county` | `orders.county` |
| `property_address` | `intake.propertyAddress`, composed with the three fields below |
| `city` | part of `intake.propertyAddress` |
| `search_type` | `orders.type` + `intake.orderType` (see below) |
| `turnaround` | `orders.priority` (see below); wording kept at `intake.requestedTurnaround` |
| `contact_first_name` | `intake.from`, as `"First Last <email>"` |
| `contact_last_name` | `intake.from` |
| `contact_email` | `intake.from`; validated with the same rule the Place Order form uses |
| `client_identifier` | `orders.client_code` — an exact `clients.code` |
| `email_message_id` | `intake.messageId` (the idempotency key) |

**Optional**

| Field | Lands on |
|---|---|
| `zip` | part of `intake.propertyAddress` |
| `parcel_apn` | `intake.parcelNumberAPN` |
| `client_file_number` | `orders.client_file_no` |
| `buyer` | `intake.buyer` |
| `borrower` | `intake.borrowerName` |
| `seller` | `intake.seller` |
| `special_instructions` | `intake.specialInstructions` |
| `company` | `intake.company` (falls back to the resolved client's name) |
| `order_number` | `intake.orderNumber`, **and** appended to `intake.specialInstructions` |
| `customer_link` | `intake.customerLink`, **and** appended to `intake.specialInstructions` |
| `email_subject` | `intake.subject` |
| `source_email` | `intake.sourceEmail` (provenance only) |

Unknown keys are ignored, so a later Gemini revision adding a field cannot break
intake. The four address parts are joined into one line exactly as the Place
Order form joins its own — city and zip are therefore preserved inside
`intake.propertyAddress` rather than in columns of their own.

`order_number` and `customer_link` also ride along in `specialInstructions`
because no portal screen renders them; surfacing them in a field Admin already
reads is what keeps this feature free of frontend changes.

### Turnaround → the existing priority enum

The portal has exactly two priorities, so the client's two options map straight
onto them — no new column, no new enum value:

| `turnaround` | `orders.priority` |
|---|---|
| `Standard (48 hours)` | `normal` |
| `Rush (24 hours)` | `rush` |

Common variants (`standard`, `48 hours`, `rush`, `24 hrs`, …) are normalised.
Anything else — `same day`, `72 hours`, `ASAP` — is **rejected**, never
defaulted to standard.

### Search type → an existing product

`search_type` must resolve to a real Resolute product. Resolution is an explicit
three-step lookup on a folded key (case, punctuation and spacing ignored):

1. the current catalog — the products the Place Order form offers
2. a hand-checked alias table (`full`, `bringdown`, `ofac`, `doc retrieval`, …)
3. legacy short names, for products that only exist under one

Because folding punctuation makes the legacy `Two-Owner` and the current
`Two Owner Search` one key, steps 1 and 2 outrank step 3: a legacy spelling
normalises *forward* to the name the website would write today — the same
product at the same price. Legacy-only products (`Lien Search`,
`Tax Certificate`, `HOA Estoppel`) still resolve to themselves.

An unlisted wording is **rejected, never guessed at** — a guessed search type is
a mispriced, mis-scoped order. A typo in the alias table fails at import rather
than accepting a product the portal cannot price.

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
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Existing server-only vars; the service-role client bypasses RLS. |

On the Google side, the portal connection lives in **script properties**, so
rotating the secret or repointing the API is never a code change:
`INTAKE_API_URL`, `EMAIL_INTAKE_API_SECRET`, and `CLIENT_CODE_MAP`. The secret
is sent as a header and is never logged or written to the sheet.

Gmail, Vertex and the test sheet stay as top-level constants in the lead
script's own style — `GCP_PROJECT_ID`, `GCP_REGION`, `VERTEX_AI_MODEL`,
`GMAIL_SEARCH_QUERY`, and `SPREADSHEET_ID` /
`TARGET_SHEET_NAME` (set `SPREADSHEET_ID` to `""` to disable logging).

## Manual test

```sh
curl -sS -X POST "$PORTAL_URL/api/orders/email-intake" \
  -H 'content-type: application/json' \
  -H "x-intake-secret: $EMAIL_INTAKE_API_SECRET" \
  -d '{
    "property_state":     "TX",
    "county":             "Harris",
    "property_address":   "880 Main St",
    "city":               "Houston",
    "search_type":        "Full Search",
    "turnaround":         "Standard (48 hours)",
    "contact_first_name": "Dana",
    "contact_last_name":  "Whitfield",
    "contact_email":      "dana@lakewoodtitle.com",
    "client_identifier":  "CL01",
    "email_message_id":   "18f2c9a4b1d0e5f7",

    "zip":                "77002",
    "parcel_apn":         "0660110000021",
    "client_file_number": "LOAN-42",
    "buyer":              "Taylor Brooks",
    "borrower":           "Jordan Reyes",
    "seller":             "Avery Banks",
    "special_instructions": "Closing is tight.",
    "company":            "Lakewood Title Group",
    "order_number":       "ORD-9911",
    "customer_link":      "https://client.example/orders/9911",
    "email_subject":      "Title search request — 880 Main St",
    "source_email":       "Dana Whitfield <dana@lakewoodtitle.com>"
  }'
```

First call → `201 {"ok":true,"duplicate":false,"orderId":"RTS-…","status":"received","assignedTo":"admin"}`.
Re-run the identical command → `200` with `"duplicate":true` and the same
`orderId`. The order appears in Admin's **Awaiting Approval** tab.

## Open items

- **Attachments.** Not handled. Gemini sees the message body only, and moving a
  client's PDFs onto the order (the private `documents` bucket, path
  `orders/<id>/…`) is still to be built.
- **The Gemini prompt.** `extractWithGemini()` in the Apps Script reference is
  deliberately unimplemented; it must emit exactly the official field names and
  must never produce a client code.
- **The production mail queue.** The pilot watches the `resolute` Gmail label.
  Moving to a dedicated intake mailbox is an Apps Script config change
  (`GMAIL_SEARCH_QUERY`) — there is no portal-side variable for it.
