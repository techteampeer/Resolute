# Spec — B3: Order documents & access control on GCP

Status: **partially implemented in repo (access-control slice)** · 2026-11-20 ·
parent: ADR 0003 (blocker B3) · Supabase reference: `src/lib/orderDocs.js`
(PR #147), `uploadDocument`/`openDocument` in `src/lib/backends/supabase.js`.

B3 is "map the new workflow keys (`titleSearchDoc`, `supplementaryDocs`,
`deliveryDocs`) to GCS document kinds and the document guards the review names;
**delivery-only release to clients**; no public bucket or `blob:` URLs persisted."

## What splits in-repo vs. env-gated
Today document access control is enforced **only client-side** (`collectOrderDocs`
/ `clientVisibleDocs` filter in `AttachedDocs.jsx`); the bytes live in Supabase
Storage, and the client mints its own signed URL. The two halves:
- **Access control / delivery-only release** — "which documents may *this* caller
  see?" — is a pure decision over `order.workflow` + the caller's role/ownership.
  **Buildable + verifiable in-repo** (RLS + pure logic, like B1/B2).
- **Storage** — GCS upload, short-lived signed-URL generation, and the document
  guards the review names (`document_referenced()` / `guard_order_documents()`)
  — lives in the deployed snapshot. **Env-gated.**

## What landed (the access-control slice)
- `services/api/src/orderDocs.js` — mirror of `src/lib/orderDocs.js`
  (`collectOrderDocs` / `docIsShared` / `clientVisibleDocs`) plus
  `authorizedDocs(order, { isStaff })` (staff see all, client sees released only)
  and `isPersistableRef` (the "no public/`blob:` URL persisted" guard: a stored
  ref must carry a GCS path, never a transient/public URL). Pure, unit-tested.
- `services/api/src/routes/documents.js` + mount at
  `/api/orders/:orderId/documents`:
  - `GET …/documents` → the documents the caller may view. The order read is
    RLS-scoped, so a client only reaches docs on an order they own (else 404);
    staff get the whole trail, a client only Delivery's released subset.
  - `POST …/documents/:docId/open` → **authorizes** the open: 404 (order/doc not
    found), 403 (a client asking for a doc Delivery did not release), or — once
    authorized — **501** (GCS signing env-gated), never a public/stored URL.

### Tests
`__tests__/documents.integration.mjs` — supertest → the real router →
`withUserClaims` → RLS, over a live Postgres. Seeds an order with
titleSearch/screener/delivery docs and a `docShare` override in both directions,
and asserts: staff see all 4; the owner client sees only the released 2 (and the
override flips screener in, a delivery doc out); a non-owner client gets 404; and
the per-doc open is 403 (un-released) vs 501 (authorized) vs 404 (unknown /
non-owner). Plus `__tests__/orderDocs.test.js` (pure). Wired into the
`db-integrity` lane (`test:integration` now runs B1 + B2 + B4 + B3).

## Still open (env-gated / needs the deployed snapshot)
1. **GCS storage** — upload + short-lived signed-url generation served by
   `services/api` (so the client never holds storage credentials); `gcp.js`
   `uploadDocument`/`openDocument`/`removeDocument` stay stubbed until then.
2. The DB document guards (`document_referenced()` / `guard_order_documents()`)
   land on `resolute_live` as reviewed GCP migrations — Claudio's cost approval.
