# Spec — B1: Additional-fee lifecycle on GCP (Cloud Run + Cloud SQL)

Status: **draft for implementation** · 2026-11-19 · parent: ADR 0003 · review:
`Resolute_GCP_Ashly_Integration_Review_2026-11-18.md` (blocker B1)

Goal: make the additional-fee feature — already live on the Supabase provider
(PRs #148, #153) — **production-real on GCP**, with an authenticated API, a
transactional Cloud SQL write, GCP-native events/notifications, and the test
matrix the review requires. Nothing here deploys; it is the build sheet.

---

## 0. Current state (what exists, what's missing)

**Portable, already done (no backend coupling):**
- Domain math in `packages/domain/src/money.ts`: `buildCharge`, `chargesOf`,
  `pendingChargesOf`, `approvedChargesTotal`, `resolveChargeIn`, and
  `invoiceTotal` (which *derives* the total: base + rush + approved charges).
- UI: `src/components/OrderCharges.jsx` (raise form / approve-decline),
  `ChargeApprovalChip`, the client Activity line.
- Data shape: charges live in `orders.workflow.pendingCharges[]` (JSONB) —
  `{ id, label, amount, raisedBy, raisedByRole, raisedAt, status, resolvedAt }`.

**Supabase-only today (the gap):**
- Raise = a plain `orders` UPDATE via `saveOrder` (RLS `orders_update_assigned` /
  admin). Resolve = RPC `resolve_order_charge()` (`20261105000000`, extended by
  `20261117000000`). Notifications = `order_events` INSERT → trigger
  `notify_on_order_event` → `enqueue_notification` → `notification_outbox` →
  `services/notify` sender.
- The GCP API (`services/api`) has **no charge routes**; the GCP provider
  (`src/lib/backends/gcp.js`) `resolveOrderCharge` is `notImpl` and raise has no
  path (`saveOrder` returns a not-wired error). So on GCP the feature is inert.

**Architecture we build on** (`services/api/src`):
- `server.js` — Firebase-auth gate → `req.user = { id: profiles.id (uuid), role, email }`.
- `db.js::withUserClaims(user, fn)` — runs `fn(client)` in a transaction as DB
  role `authenticated` with `request.jwt.claims` set (`sub = profiles.id`). **RLS
  and `SECURITY DEFINER` functions behave exactly as on Supabase/PostgREST.**
- `routes/orders.js` + `repositories/orders.js` + `mappers.js::toAppOrder` — the
  thin-adapter pattern every new route follows.

---

## 1. Design principles / invariants

1. **Approval is consent-to-bill, never a payment.** Resolving a charge changes
   only `workflow.pendingCharges[i].status`; it never touches `workflow.payment`.
   The invoice total rises (derived) but pay-status stays Outstanding until the
   billing owner (Vivek) confirms on the untouched payment path.
2. **Invoice counts each approved charge exactly once — by construction.** The
   total is *derived* (`approvedChargesTotal` sums `status==='approved'`), not an
   accumulator. A charge has one immutable transition (`pending → approved|declined`);
   re-resolution is rejected. So "exactly once" needs no ledger — only that the
   status transition is single and final.
3. **Declining is non-blocking.** The order proceeds; the charge never bills.
4. **RLS is the authority, re-checked server-side.** The API gates by role for a
   fast, clear error, but every write runs under `withUserClaims`, so the DB
   policies are the real guard (defense in depth). Never trust a client-supplied
   charge id as authorization.
5. **Fail safe.** Unsupported/al­ready-resolved/forbidden → an explicit 4xx and a
   fresh order read; never an optimistic client write that outlives a server
   rejection (ADR 0003 §3).

---

## 2. Data model (unchanged, portable)

No schema change for the charge data. A charge object:

```
{ id: "chg_<rand>",        // server-generated; never trust a client id
  label: string(1..120),
  amount: number(>0, <= 1_000_000),   // AMOUNT_LIMIT, matches money.ts + F3 guard
  raisedBy: string,        // display name
  raisedByRole: 'admin' | 'user',
  raisedAt: 'YYYY-MM-DD',
  status: 'pending' | 'approved' | 'declined',
  resolvedAt: 'YYYY-MM-DD' | null }
```

Prerequisite (verify, do not assume): confirm whether `resolute_live` already has
the charge SQL (`resolve_order_charge`) and the `charge.approved` / `charge.declined`
`notification_types` from migrations `20261105000000` / `20261117000000`. If the
Cloud SQL schema is a frozen snapshot predating them, port them as GCP-reviewed
migrations (B4), reconciled against the real schema — **never** run the Supabase
SQL blindly on `resolute_live`.

---

## 3. API surface

A `charges` sub-resource under an order. New file `routes/charges.js`, mounted
`app.use('/api/orders/:orderId/charges', chargesRouter)` (mergeParams).

### 3.1 Raise — `POST /api/orders/:orderId/charges`  (staff)
Body: `{ label, amount }`. Server generates `id`, stamps `raisedBy/Role/At`,
`status:'pending'`.
- **403** if caller is not admin and not the production `user` who owns the order
  at the typer stage.
- **404** if the order isn't visible to the caller (RLS).
- **422** on validation failure (§8).
- **201** `{ order }` — the fresh, app-shaped order (via `toAppOrder`), so the
  client replaces local state rather than guessing.

### 3.2 Resolve — `POST /api/orders/:orderId/charges/:chargeId/resolve`  (owner client)
Body: `{ decision: 'approved' | 'declined' }`.
- **403** if caller's `my_client_code()` ≠ the order's `client_code` (not owner),
  or caller is staff (staff cannot approve on a client's behalf — by design).
- **404** order not found / not owned.
- **409** the charge is not `pending` (already resolved, or no such id) — the
  replay/duplicate guard.
- **422** `decision` not in the allowed set.
- **200** `{ order }` — fresh order (chip cleared if none pending, invoice updated).

### 3.3 (optional) List — `GET /api/orders/:orderId/charges`
Not required: `GET /api/orders/:id` already returns `workflow.pendingCharges`.
Add only if a charges-only poll is wanted.

All responses: app-shaped order JSON identical to the Supabase provider, so the
frontend can't tell which backend served it.

---

## 4. Authorization matrix

| Action | admin | super admin / billing | production `user` (owns order, typer stage) | production `user` (other) | owner client | other client |
|---|---|---|---|---|---|---|
| Raise | ✅ | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Approve / Decline | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ✅ | ❌ 403 |

Enforced twice: a role pre-check in the route (fast 403), and RLS inside the
transaction (the real guard — `my_client_code()` for resolve; `can_work_production()`
+ owner scope / `is_admin()` for raise).

---

## 5. Transaction & concurrency

Both writes take a **row lock** to serialize concurrent charge mutations on one
order, then mutate only the intended charge, then emit the event — all in one
`withUserClaims` transaction (so RLS is in force and it's atomic).

### 5.1 Resolve — recommended: **reuse the tested SQL function**
```js
// repositories/charges.js
export async function resolveCharge(client, orderId, chargeId, decision) {
  // resolve_order_charge: SECURITY DEFINER, scoped to my_client_code() from the
  // injected claims; atomic single-statement UPDATE whose `exists(... pending)`
  // guard + row lock make a second concurrent/duplicate resolve raise -> 409.
  // It also inserts the order_events audit row (see §6).
  await client.query('select public.resolve_order_charge($1,$2,$3)', [orderId, chargeId, decision])
  return getOrder(client, orderId)            // fresh state in the same txn
}
```
Map the function's `raise exception` to HTTP: message `… no pending charge` →
**409**; `… not found, not owned` → **404/403**; decision guard → **422**. (The
route wraps these; keep internals out of the client body per `server.js`.)

*Alternative (Option B, fully explicit — no SECURITY-DEFINER reliance):* in Node,
`SELECT workflow FROM orders WHERE id=$1 FOR UPDATE`, confirm the charge is
`pending` and the caller owns the order, compute the new array with
`resolveChargeIn` (reuse the domain fn), `UPDATE … SET workflow = $2`, insert the
event. More code; identical guarantees. Pick one; §5 assumes Option A.

### 5.2 Raise — explicit (no SQL function exists for raise)
```js
export async function raiseCharge(client, orderId, charge) {
  const { rows } = await client.query(
    'select workflow from public.orders where id=$1 for update', [orderId]) // RLS + lock
  if (!rows.length) return null                       // -> 404 (not visible)
  const wf = rows[0].workflow || {}
  const pending = Array.isArray(wf.pendingCharges) ? wf.pendingCharges : []
  const next = { ...wf, pendingCharges: [...pending, charge] }
  await client.query('update public.orders set workflow=$2 where id=$1', [orderId, next])
  await emitChargeRaised(client, orderId, charge)     // §6 (optional staff event)
  return getOrder(client, orderId)
}
```
The `FOR UPDATE` lock means two concurrent raises append in series (no lost
update). The F3 amount guard (`guard_order_amounts`) does not watch
`pendingCharges`, so a bounded amount is enforced in §8, not the DB — keep the
§8 validation authoritative.

---

## 6. Events & notifications (GCP-native)

The review's rule: *durable, structured events + notifications, but do not
transplant the Supabase trigger blindly.* Decision:

- **Keep the portable DB pieces** — `order_events` (audit/activity source the GCP
  provider's `fetchActivity` already reads), `enqueue_notification`,
  `notification_outbox`, `notification_types`. These are plain plpgsql; they run
  on Cloud SQL unchanged.
- **Replace the *trigger* with an *explicit* enqueue from the API.** On Supabase
  the `order_events` INSERT auto-fires `notify_on_order_event`. On GCP, make the
  resolve/raise repo **call `enqueue_notification` explicitly** (and keep the
  trigger *disabled* on `resolute_live` to avoid a double enqueue) so the fan-out
  is visible, testable, and decoupled from an INSERT side effect:
  ```js
  await client.query(
    `select public.enqueue_notification($1,$2,$3,$4,$5)`,
    [decision === 'approved' ? 'charge.approved' : 'charge.declined',
     orderId, payloadJson, eventId, null /* actor_email: client not a recipient */])
  ```
  `enqueue_notification` resolves recipients from `notification_types.default_roles`
  (`{admin}` for charge.*) + per-user `notification_preferences` — the admin-tier
  fan-out, unchanged and already tested.
- **Drain the outbox with a GCP-native sender.** The `services/notify` runner
  (`runNotifications({ mode })`) is already provider-agnostic (SES SigV4 over
  `node:crypto`, or `preview`). Deploy it as a **Cloud Run Job on Cloud Scheduler**:
  `immediate` every 1–2 min, `digest` daily. This is the "caller the GCP move
  replaces" (CLAUDE.md, Email). `NOTIFY_PROVIDER` stays `preview` until SES creds
  are set, so an unconfigured deploy mails no one.

Net GCP-native event flow for a resolve: `resolve_order_charge` writes the
`order_events` row (in-app Activity/bell, client + admin) → the API explicitly
enqueues `charge.approved|declined` → the scheduled sender delivers to the admin
tier by preference. Client is never a mail recipient.

---

## 7. Invoice & payment (invariants to prove)

- Invoice: `invoiceTotal` already adds `approvedChargesTotal`; no endpoint touches
  a stored total. Test: approve → invoice +amount once; approve-again blocked →
  no change; decline → no change.
- Payment: assert `workflow.payment` is byte-identical before/after any resolve,
  and `payStatusOf` stays `unpaid`/overdue (never `confirmed`) across approval.
  The Vivek confirm path (`client_mark_payment` / staff confirm) is out of scope
  and untouched.

---

## 8. Validation (authoritative in the API)

| Field | Rule | Fail |
|---|---|---|
| label | trim, 1..120 chars | 422 |
| amount | finite number, `0 < amount <= 1_000_000` (`isAmountInRange` + `>0`) | 422 |
| decision | ∈ `{approved, declined}` | 422 |
| chargeId (resolve) | references a `pending` charge on the order | 409 |
| id (raise) | **ignored if supplied** — server generates it | — |
| order | visible to caller under RLS | 404 |

Reuse `packages/domain`: `buildCharge` (coerces + bounds + stamps), `isAmountInRange`.

---

## 9. Frontend seam changes

- `src/lib/backends/gcp.js`: implement
  - `resolveOrderCharge(orderId, chargeId, decision)` → `POST …/charges/:id/resolve`, returns the fresh order.
  - new `raiseOrderCharge(orderId, charge)` → `POST …/charges`.
  Both `throw` on a non-2xx (fail safe), returning the error body's message.
- `src/lib/backend.js`: add `raiseOrderCharge` to the exported contract; add the
  matching Supabase impl (thin: it can keep the current `saveOrder` raise, or add
  a parallel RPC — provider's choice, same signature).
- `src/context/OrderContext.jsx`:
  - `resolveCharge` — on success replace the order with the server's fresh copy
    (drop the optimistic-only branch for the wired backend); on failure roll back
    and `setWriteError`.
  - `raiseCharge` — call `raiseOrderCharge` on a wired backend instead of
    `persist(saveOrder)`, replacing local state with the returned order.
  - Keep the mock-mode local paths behind `!isSupabaseConfigured` (demo).

No UI change — `OrderCharges.jsx` already calls `raiseCharge` / `resolveCharge`.

---

## 10. Test matrix (the review requires all of these)

Unit (no DB): `money.ts` charge math (done); `claimsForUser`/mappers (done);
route validation with a mocked repo.

Integration — `services/api/__tests__/charges.test.js`, **supertest** against the
Express app wired to a **disposable schema-equivalent Postgres** (the gcp/ shim,
not `resolute_live`), seeding Firebase-less users via `withServiceRole`:

- **Roles:** client cannot raise (403); non-owner `user` cannot raise (403);
  admin raises (201); owner client approves/declines (200); staff cannot resolve
  (403); non-owner client cannot resolve (403/404).
- **Ownership:** resolve only mutates the caller's own order.
- **Replay / duplicate:** resolve an already-resolved charge → 409; invoice
  unchanged on the second call.
- **Concurrency:** two parallel approvals of the same charge → exactly one 200,
  one 409; `approvedChargesTotal` counts it once.
- **Validation:** amount ≤ 0 / > limit / non-numeric → 422; empty label → 422;
  unknown chargeId → 409; unknown order → 404.
- **Invoice-exactly-once & payment-untouched:** §7 assertions.
- **Notifications:** approve enqueues `charge.approved` to `recipient_role=admin`
  only (never `client`); decline → `charge.declined`; then `runNotifications`
  drains the row (assert against the `preview` provider's output).

Port the assertions already proven in `.audit/verify-charges.mjs` — they map 1:1.

---

## 11. Acceptance criteria (maps to the review's checklist)

1. Clean install + build + all new tests green in a disposable CI env.
2. Charge workflow verified end-to-end on a schema-equivalent Postgres: spoofed
   approvals denied, negative/duplicate charges denied, invoice math + payment
   invariant + notifications correct.
3. Run against the GCP API in a **zero-traffic Cloud Run preview** with isolated
   data — not a live mutation test.
4. Capture current revision/image/digest + migration version before any cutover;
   **Claudio's cost approval** for Cloud builds / Cloud SQL migrations.
5. Promote only after signoff; keep the previous revision; DB rollback is
   forward-safe migrations, not a traffic flip.

---

## 12. Work breakdown

1. (prereq) Confirm/port the charge SQL + `notification_types` into `resolute_live`
   as a reviewed GCP migration; **disable** `notify_on_order_event` for charge
   events there (explicit enqueue instead).
2. `repositories/charges.js` (raise + resolve, §5) + `routes/charges.js` (§3) +
   mount in `server.js`; role pre-checks (§4); error→status mapping.
3. `gcp.js` + `backend.js` + `OrderContext` seam (§9); fail-safe on non-2xx.
4. Outbox drainer: `runNotifications` as a Cloud Run Job + Scheduler (§6).
5. `charges.test.js` integration suite (§10); wire into CI's API test lane.
6. Zero-traffic preview verification (§11), then the ADR 0003 promotion gate.

Est. ~2–3 focused days for an engineer with the GCP codebase + a disposable DB;
the Supabase reference implementation (#148/#153, `verify-charges.mjs`) is the
oracle for behavior and tests.
