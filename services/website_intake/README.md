# Website order intake

`POST /api/orders/website-intake` turns a submission of the public website's
order form (resolutetitleservices.com/order) into one normal portal order in
**Admin → Awaiting Approval**, with **Source = Website**. No AI.

```
website form ──JSON──▶ Google Apps Script doPost ──▶ Google Sheet row      (unchanged)
                                                 ├─▶ team + customer emails (unchanged)
                                                 └─▶ POST /api/orders/website-intake
                                                       x-intake-secret
                                                       validate → dedupe → intake_create_order
```

The website itself is unchanged and never sees the secret. The Apps Script
reference is `apps-script/order-intake.gs` in the `resolute-website` repo.

## Files

| File | Role |
|---|---|
| `api/orders/website-intake.js` | Thin Vercel adapter: method, secret, JSON, status codes. |
| `schema.js` | Validation + normalisation, the website product table. Pure. |
| `intake.js` | Validate → dedupe → build the row → create. Pure, DI. |
| `../email_intake/store.js` | **Reused unchanged**: `findByMessageId`, `createIntakeOrder` (→ `intake_create_order`). |

Nothing in `services/email_intake/` is modified; this module imports
`normalizeCompanyName`, `normalizeTurnaround`, `SEARCH_CATALOG` and the store.
No database migration: the order, client resolution and idempotency all use
what email intake already deployed.

## Payload

The website's own keys (`src/routes/order.tsx` `payload`) plus `submissionId`:

| Key | Rule |
|---|---|
| `submissionId` | **Required.** UUID (`Utilities.getUuid()`), case-insensitive. Idempotency key `website:<id>`. |
| `businessName` | **Required.** The client key — matched by the existing rules (exact normalised name; several → 422; none → new `CL` client). |
| `contactName` | **Required.** Split on the first space into first/last; the full name is kept verbatim. |
| `workEmail` | **Required.** An address. |
| `propertyState` | **Required.** Full name (`Florida`) or code → `FL`. |
| `county` | **Required.** |
| `priority` | **Required.** `Standard` → `normal`, `Rush` → `rush`. |
| `product` / `customSearch` | **One required.** `product` must be one of the seven website products. |
| `address`, `city`, `zip`, `parcelApn`, `yourFileRef`, `propertyType`, `parties`, `specialInstructions`, `searchType`, `submittedAt` | Optional. |
| `website` | Honeypot — must be empty. |

Any other key is ignored — in particular a client code: public input never
chooses a client. Every field is length-capped and stripped of control
characters.

## Products

None of the website's seven products has a confirmed equivalent in the portal
catalog (`src/data/products.js`), so `WEBSITE_PRODUCTS[].portalType` is `null`
for all of them. Such an order keeps the website's product name as its `type`
(a custom search is `Custom search`). Confirm & price treats a type with no
catalogue price as quote-only, so **Admin agrees the service and sets the price
before any work starts** — the same gate every non-portal order already passes.
To map a product once the business confirms an equivalent, set its
`portalType` to the catalog name; an unknown catalog name fails at import.

The customer's selections are kept verbatim in `workflow.intake.website`
(`product`, `productMapped`, `customSearch`, `searchType`, `parties`,
`submissionId`, `submittedAt`).

## What Admin sees

- Orders list: **Source** column (Website / Email / Portal), **Awaiting
  Approval**, **Awaiting confirm**.
- Order view: Source; the usual intake details; **Check before approving** —
  `workflow.intake.reviewNotes`, Admin-only (unmapped product, custom search,
  missing address/city, odd ZIP, unparsed parties). Review notes never go into
  special instructions.

The client hold and the clarification request are not used for review: both
are shown to the client.

## Responses

| Status | Body | Apps Script records |
|---|---|---|
| 201 | `{ ok, duplicate:false, orderId, status, assignedTo, clientCode, clientMatch, needsReview }` | `delivered` |
| 200 | `{ ok, duplicate:true, orderId, … }` — the first order; nothing written | `delivered` |
| 400 | `{ error, code:'invalid_payload', field }` | `rejected` (manual review) |
| 422 | `{ error, code:'ambiguous_client', field:'businessName' }` | `rejected` (manual review) |
| 401 / 503 | wrong / unset secret | `failed` (fix config, retry) |
| 500 | `{ error:'Intake failed' }` — never the exception | `failed` (retry; idempotent) |

## Manual test (preview deployment only)

```bash
curl -sS -X POST "$PREVIEW_URL/api/orders/website-intake" \
  -H 'content-type: application/json' \
  -H "x-intake-secret: $WEBSITE_INTAKE_API_SECRET" \
  -d '{"submissionId":"'"$(uuidgen)"'","businessName":"Test Escrow Co",
       "contactName":"Test Person","workEmail":"test@example.com",
       "propertyState":"Florida","county":"Miami-Dade","address":"1 Test St",
       "city":"Miami","product":"Municipal Lien Search","priority":"Standard"}'
```

Sending the same body again returns `200` with `duplicate: true` and the same
`orderId`.
