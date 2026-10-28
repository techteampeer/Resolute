# Resolute Portal — Enhancements Implementation Plan

Approved plan for a batch of client/admin portal enhancements. Mostly
frontend + `packages/domain`; no DB migrations expected (one verification).
Delivered as phased PRs on top of the Qualia-parity epic.

## Decisions locked (from Q&A)
- **Company name:** remove from the client Review step + client order-detail;
  identity stays implicit via login (`order.client`). Admin views unchanged.
- **Client Dashboard:** redesign into a full orders hub that **replaces** the
  separate "My Orders" page. Top of page: **summary stat tiles** + a
  **recent-activity** panel; then the orders hub (tabs/search/date/sort).
- **Sorting:** asc/desc column sort (Status, Due By, Ordered On, Total) across
  **all three** order tables — client, admin, production desk.
- **Billing labels:** canonical set **Outstanding / Overdue / Awaiting
  confirmation / Paid / Bounced** (Overdue overrides Outstanding when past due).
- **Admin Place Order:** rebuild as the client 4-step wizard **+ a Client/Company
  step** that picks an **existing client only**; fixes the county dropdown by
  construction (wires `us-counties.json`).
- **Product types:** add **Plus / Non-Plus** variants of **Current Owner, Two
  Owner, Full Search, Update Search** to every order form, **quote-only** (no
  fixed price yet). The 8-vs-3 fulfillment-section formatting is **Phase 2**.

## DB / backend
Expected migrations: **none**. Billing labels are presentation-only (stored keys
`unpaid/marked/confirmed/bounced` unchanged); new products are quote-only names
in `products.js`. One verification: `orders.type` is free-text with no FK to
`product_prices` (true today) — if a constraint exists, add a dashboard-safe
migration seeding the 8 names as quote-only, surfaced before any live step.

## Workstreams / PRs
Each PR: build → `lint` + unit tests + `build` (+ real-stack integrity audit as a
regression guard) → PR → merge green. Branch `claude/wizardly-fermat-ksyvj2`.

### PR-1 — Sortable order columns (WS3) [foundation]
- `src/lib/ordersView.js`: `SORTABLE` defs + `sortOrders(orders,{key,dir})`
  comparators — status (pipeline position), dueBy (`dueDate`), orderedOn
  (`created`), total (`invoiceAmount`); null-safe, stable.
- `OrdersTableView.jsx` (client), `AdminOrders` (admin), `OperatorDashboard`
  (production): clickable sortable headers (asc→desc→none) + caret indicators.
- No DB. Tests: comparator units + E2E click-to-sort.

### PR-2 — Client Dashboard redesign + remove company name (WS2+WS1-removal)
- `ClientDashboard.jsx` `ClientHome`: stat tiles (Active / Completed / Rush /
  Outstanding $) + recent-activity panel (latest replies + status changes) +
  orders hub (`OrdersTableView`). Remove "My Orders" nav/route; redirect
  `/client/orders` → `/client`. Keep New Order CTA; order-detail route stays.
- Remove the Review-step "Business name" row and client order-detail "Business"
  row. No DB. Tests: E2E.

### PR-3 — Billing status standardization (WS4)
- `packages/domain/src/money.ts`: relabel `PAY_STATUS`
  (unpaid→Outstanding, marked→Awaiting confirmation, confirmed→Paid,
  bounced→Bounced) + `payStatusLabel(order, termKey)` → Overdue when past due.
- Consumers (`ClientBilling`, `AdminBilling`, My-Orders/dashboard chip,
  `invoicePdf`) route through it; drop the redundant double Overdue badge.
- No DB. Tests: domain unit + visual.

### PR-4 — Admin Place Order 4-step wizard + county fix (WS5+WS6)
- Extract shared `<OrderWizard mode>` from the client `PlaceOrderPage`
  (Property → Search → Contact → Review). Client mode: company implicit. Admin
  mode: leading Client/Company step (existing clients only; loads contacts +
  terms). County uses the `us-counties.json` state-keyed datalist.
- `AdminPlaceOrder.jsx` becomes a thin `<OrderWizard mode="admin">` wrapper.
- No DB. Tests: E2E 4-step admin flow; county populates after state.

### PR-5 — Product Plus/Non-Plus variants (WS7)
- `src/data/products.js`: 8 quote-only variants (Current Owner / Two Owner /
  Full Search / Update, each Plus / Non-Plus). Surface in all forms (client +
  admin wizard + BulkImport). Keep base names as legacy types for existing
  orders. Verify no `product_prices` FK; no migration expected.
- Phase 2 (separate): `FulfillmentScreen` 8-section Plus vs 3-section Non-Plus.

## Deferred
- Plus/Non-Plus pricing (quote-only now; rate card later).
- Phase 2: fulfillment 8-vs-3 section formatting.
