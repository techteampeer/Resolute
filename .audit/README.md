# Audit harness

Scripts that drive the real portal in a real browser against a real database, so
a claim about the app can be checked rather than asserted. Not part of the
build, not shipped, not run by CI — they are for a person or an agent verifying
behaviour before a release.

Everything here needs the local stack running:

```bash
supabase start          # Postgres on 54322, PostgREST/GoTrue on 54321
npm run dev             # the app on 5173
node .audit/verify-smoke7.mjs
```

Screenshots and generated evidence go to `.audit/out/` (gitignored). Override
with `AUDIT_OUT=/some/path`.

## The harness

`harness.mjs` is the only file the others depend on.

| Export | What it does |
| --- | --- |
| `browser()` | Chromium with the right `executablePath` — `chromium.executablePath()` points at a build that is not installed |
| `login(b, who)` | Signs in through the real form and returns `{ page, ctx, errors }`; `errors` collects page errors and console errors |
| `sql(q)` / `sqlJson(q)` | psql as superuser — **bypasses RLS**, so use it to check state, never to test access |
| `as(who, path, opts)` | PostgREST as a real signed-in user, with their JWT — **this is the only honest way to test RLS** |
| `token(who)` / `rpc(...)` | The pieces behind `as()` |
| `shot(page, name)` | Full-page screenshot into `SHOTS` |
| `text(page)` / `watchNetwork(page)` | Page text; every failed or non-2xx request |
| `CREDS` | The ten seeded accounts |
| `SAMPLE_PDF` | A tiny valid PDF, written on demand, for upload steps |

`login()` aborts every request that is not localhost. Without that, pages hang
for the full timeout on Google Fonts — this container has no outbound egress.

## What each script proves

**End to end**

| Script | What it drives |
| --- | --- |
| `e2e-single.mjs` | A client places an order and the Production Desk (`/user`) carries it to delivered through all four pipeline phases with Admin approval between each; checks the row after every transition, then the events, fulfillment, commitment PDF, invoice, payout obligation and notification fan-out. (Post-D3 this is THE production flow — the former four-desk `e2e.mjs` was retired with the stage portals.) |
| `verify-smoke7.mjs` | Every portal and every sidebar entry, for nine accounts, collecting page errors |

**Writes that must not fail silently**

| Script | What it proves |
| --- | --- |
| `verify-silent.mjs` | A fulfillment write refused by RLS shows "Not saved" and does not persist |
| `verify-legit-save.mjs` | The production `user`'s and Admin's legitimate saves do persist, with `updated_by` stamped |
| `verify-order-legit.mjs` | A stage action on an order in the `user` pool succeeds silently and moves the row (the cross-desk-refusal check, `verify-order-refusal.mjs`, was retired with the stage portals; its DB-level equivalent — a user cannot write an order outside the pool — is now asserted in `verify-order-integrity.mjs`) |

**Admin's access to fulfillment**

| Script | What it proves |
| --- | --- |
| `verify-admin-fulfillment.mjs` | A super admin and a plain admin can open and edit the form on another desk's order |
| `verify-admin-finalize.mjs` | What the Finalize block offers Admin, and that opening the form changes nothing |
| `verify-admin-submit2.mjs` | Admin submitting actually moves the row (this caught a two-write race) |

**Pricing, dates, money**

| Script | What it proves |
| --- | --- |
| `verify-confirm-framing.mjs` | "Confirm & price" for a new order, "Set price & date" for one already in flight |
| `verify-confirm-apply.mjs` | Both paths write the row and send the right client message |
| `verify-assign-warning.mjs` | The Assign modal warns when an order has no price or no committed date |
| `verify-payout-pending.mjs` | An ABS-routed order surfaces to Vivek as a payout awaiting a fee |

**Dashboard figures**

| Script | What it proves |
| --- | --- |
| `verify-real-numbers.mjs` | Every stat tile and queue badge on every dashboard equals the database |
| `verify-numbers-move.mjs` | They change when the data changes, and the greeting is the session's person |

**Notifications**

| Script | What it proves |
| --- | --- |
| `verify-notif-prefs.mjs` | Each portal offers exactly the types that can reach it |
| `verify-notif-writes.mjs` | Every choice lands in `notification_preferences`; "Default" deletes the row |
| `verify-notif-effect.mjs` | A saved preference decides what gets queued, and at what frequency |
| `verify-notif-rls.mjs` | Nobody, super admins included, can write another person's preferences |
| `verify-notif-refusal.mjs` | The refusal path in the UI (adds a restrictive policy, then removes it) |
| `verify-notif-mock.mjs` | Demo mode says nothing is saved and toggles locally — needs a second dev server on 5174 with the Supabase env blanked |
| `verify-client-notif.mjs` | `/client/notifications` explains itself and has no nav entry |
| `verify-maillinks.mjs` | Every role's "open the order" mail link resolves to a real page |

**Database and document**

| Script | What it proves |
| --- | --- |
| `verify-housekeeping.mjs` | anon reads stay empty rather than erroring; every role still reads; constraints, indexes and policies are as intended |
| `pdf-build.mjs` → `pdf-run.mjs` | Builds the app's own commitment generator into a bundle and runs it in Chromium against full, sparse, untouched and empty fulfillments, then scans the output for placeholder tokens |

## Writing a new one

Two rules, both learned the hard way:

1. **Check the row, not the toast.** PostgREST answers an RLS-filtered UPDATE
   with HTTP 200 and zero rows. A green indicator proves nothing.
2. **Scope every locator.** `.first()` on a row action grabs whatever is at the
   top of the table, and several nav labels collide with action labels
   (`Deliver` matches the `Delivered` tab). Use
   `page.locator('tr', { hasText: ID })` and assert the modal names the order
   before acting on it.

Ad-hoc probe scripts are welcome in this directory — git ignores everything here
except the harness, the `verify-*` scripts, the two end-to-end runs and the PDF
tooling.
