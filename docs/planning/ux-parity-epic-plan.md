# Plan — Qualia-parity UX · second QC stage · admin/client enhancements

Status: **proposed** · 2026-10-21 · delivered as **incremental, independently-tested PRs**
(confirmed) in the priority order below. Nothing here integrates with Qualia —
this portal *replaces* it (`CLAUDE.md`); we match its **look and workflow** only.

## Guardrails (apply to every phase)
- **Backward-compatible.** No existing order/flow breaks; new behaviour is additive
  or behind the stage plan.
- **Billing stays a ledger**, never a gateway (`CLAUDE.md`). No in-app payment.
- **Client-PII model preserved** — non-super-admins/production see codes, not names
  (`displayClient`); contacts follow the same rule.
- **Every PR green** (lint · tests · build · db-integrity) before merge; **DB
  migrations applied to live Supabase before the matching frontend merges**.
- One workstream per PR; small and reviewable.

## Decisions locked (from Q&A)
- **G1** "Submit for Admin Approval" → **"Submit"** on **every** production submit/return button.
- **O1** Qualia filter tabs with this status→tab map: **Pending** = Awaiting Approval ·
  **Open** = in production (Screening→Delivery incl. both QCs) · **Submitted** = Out for Delivery ·
  **Complete** = Delivered · **Cancelled** = Cancelled. Plus **search**, **date-range**
  ("Ordered within"), **server-side pagination**.
- **O2** Adopt Qualia columns. Admin: Order·Status·Customer·Customer File·Product·
  Property·Total Price·Ordered On·Due By·Assignee. Client: same **minus Customer and
  Assignee**.
- **O3** **One** status badge per order (current stage) + assignee; payment moves to its
  own **Pay** column; **On Hold** is a modifier on the badge; drop New/Assigned/
  Awaiting-confirm from the status cell. One clean colour per stage (map in Phase 1).
- **Q1/Q2** Pipeline becomes **Screener → Search QC → Examiner → Typer → Typing QC →
  Delivery**; both QCs **optional + independently assigned**. Reject: **Search QC → Screener**,
  **Typing QC → Typer**. Rename current "Quality Check" → **"Typing QC"**; add **"Search QC"**.
- **A1** Admin can **place an order** via the client intake form, selecting the client;
  it enters the normal initial Admin state; admin prices it + sets the stage plan.
- **A2** Read notifications leave the **unread** list; a **read/all** view keeps history;
  same system **for all staff**.
- **C1** Hide the company/customer name on the **client's own** orders; add a **Company
  Settings** page (admin still sees the client).
- **C2** Scope of "Qualia-like" = **orders layout/filters/columns parity** (ease of
  access), not a full visual rebrand.
- **#13** Company Settings = **hybrid**: client-editable profile/people/prefs; admin-only
  (read-only to client) code/terms/billing/status.
- **#14** Client billing = **branded invoice PDFs** + a **view-only billing dashboard**
  (Due / Paid / In-progress).
- **Contacts (12-ext)** a per-company **people directory** (LOCKED): each record holds
  **name · email · phone · title · marketing_opt_in**; managed by **client + admin**;
  intake **requires** picking the placer with **add-new inline**; directory PII is visible
  **only to the owning company + admins — production users never see it** (`displayClient`
  rule, extended to people).

---

## Phased roadmap

### Phase 1 — "Submit" rename + Status column simplify (G1 · O3)
Smallest, highest-visibility, lowest-risk — ships first.
- **Frontend only.** Rename every production submit/return button to **Submit**
  (`OperatorDashboard.jsx`, `FulfillmentScreen.jsx` finalize, any screener/examiner/QC
  action). Simplify the helper copy to be stage-agnostic.
- **Status column:** a single `<StatusBadge>` (stage, colour-coded) + assignee; move
  payment to the existing **Pay** column; render **On Hold** as a small modifier.
  Touch `OrdersTable.jsx` (`STATUS_STYLES`/`STEP_*`), `AdminDashboard.jsx` (`STATUS_MAP`),
  `mockData.js` (`STATUS_COLORS`). **Proposed stage→colour map** (for sign-off):
  received·slate / screening·blue / **search-qc·violet** / examining·indigo / typing·cyan /
  **typing-qc·purple** / delivery·amber / delivered·green / on-hold·red / cancelled·grey.
- **Tests:** snapshot the badge mapping; status→label unit coverage.

### Phase 2 — Qualia orders UI (O1 · O2 · C1 remove-name)
The big list UX phase; shared component for admin + client.
- A reusable **OrdersView**: Qualia filter tabs (status→tab map above), a
  **date-range** control, **search**, and **pagination**.
- **Pagination:** server-side via Supabase `.range()` + a `count` — new `fetchOrdersPage({ tab, range, q, page })` in the backend seam (keeps the provider seam intact).
- **Columns:** admin vs client column sets (client drops Customer + Assignee — this is
  C1's "remove company name").
- **Files:** `OrdersTable.jsx` → generalized; admin Orders page + `ClientDashboard` orders
  list consume it; `backend.js` gains the paged query.
- **Risk:** large list perf — pagination + count must be efficient; verify against the
  live ~3k orders. **Tests:** tab→status filter mapping; client column masking.

### Phase 3 — Second QC stage (Q1 · Q2 · Q9)
Extends exactly the pattern we shipped for Typing QC.
- **Domain:** `ROLE_SEQUENCE = [screener, searchqc, examiner, typer, typingqc, delivery]`;
  `OPTIONAL_STAGES = [searchqc, typingqc]`; rename the `qc` role/status → `typingqc`,
  add `searchqc`. `stageSequence`/`roleAfterFor` already skip optional stages — they
  generalise for free. Add `applyQcReject` variants: Search QC → screener, Typing QC → typer
  (parameterise the existing one by stage).
- **DB migration:** `order_status += 'searchqc'` (+ rename/keep `qc`→`typingqc`); extend
  `guard_order_handoff` v_seq + status case + the reject allowance to both QC stages
  (mirror the domain). Dashboard-safe, additive.
- **UI:** `StagePlanModal` gains a **Search QC** row; `OperatorDashboard` QC panel handles
  both stages (same Pass/Reject, reject target depends on stage); status tables.
- **Tests:** +domain cases (both QCs skip/route/reject); db-integrity validates the guard.
- **Deploy:** migration first, then frontend.

### Phase 4 — Contacts directory + Admin place-order (A1 · contacts)
- **Contacts store:** new `client_contacts` table (client_code, name, email, phone, title,
  marketing_opt_in, created_by) + RLS (client sees own; admins see all; production users
  **cannot** read — PII). Backend CRUD in the seam.
- **Intake capture:** the client intake form gains a **"Placed by"** selector (pick a saved
  contact or **add new inline** → saved to the directory). Stored on the order
  (`workflow.intake.placedBy`).
- **Admin place-order:** reuse the client intake form in the admin portal with a **client
  picker**; on submit it runs the same `createOrder`/intake path → normal initial Admin
  state; admin then prices + sets the stage plan.
- **Tests:** contact CRUD + RLS; intake writes placedBy; admin-placed order enters the
  pipeline identically.
- _Design LOCKED (see "Contacts (12-ext)" above): fields name/email/phone/title/
  marketing_opt_in; client+admin manage; required pick + add-new inline; PII RLS = owning
  company + admins only (production denied)._

### Phase 5 — Notifications: read/all (A2)
- Reading (opening) a notification removes it from the **unread** list; add an **All /
  Read** view so nothing is lost; same mechanism for all staff. Extend the existing
  seen-set in `Layout.jsx` into a two-view model (unread vs all), persisted per user.
- **Tests:** mark-read moves an item unread→all; badge count reflects unread only.

### Phase 6 — Company Settings page (C1 · #13 · contacts UI)
- New **Company Settings** route in the client portal: **client-editable** profile
  (address, logo, notification prefs) + **People** (manage the contacts directory from
  Phase 4) + **portal users**; **read-only** panel for code, payment terms, status.
- **Tests:** client edits profile/contacts; read-only fields reject client writes (RLS).

### Phase 7 — Client Billing dashboard + invoices (C3 · #14)
- **Invoice PDF** per delivered order (reuse the pdfmake engine from `commitmentPdf.js`):
  branded, with amount/dates/payment status/remit-to.
- **Billing dashboard** (client): tiles (Outstanding · Paid · In-progress) + sections
  **Due / Paid / In-progress**, each row linking its invoice. Status derives from the
  order's payment state; view-only (ledger).
- **Files:** `ClientBilling.jsx`, a new `invoicePdf.js`, `src/lib/billing.js`.
- **Tests:** invoice amounts/status derive correctly; dashboard buckets by payment state.

---

## Cross-cutting deliverables
- Each phase: its own PR, green CI, live-deploy note (migration-before-frontend where a
  migration exists), and a short addition to the test plan
  (`docs/testing/user-lifecycle-test-plan.md`).
- A running changelog of the stage→tab and stage→colour maps, so admin/client/status
  stay in lockstep.

## Open items
- _All resolved._ Contacts design locked (2026-10-21). The **stage→colour map** (Phase 1)
  and **status→tab map** (Phase 2) are the proposed defaults above; adjust on review if
  desired — not blocking.
