# Resolute Portal — Architecture Roadmap

Status: **living plan** · Started 2026-09-21 · Owners: Ashly, Sagar

This is the agreed program to take Resolute from a well-built-but-risky
SPA + Supabase-RLS system to a strong, best-in-class platform. It is the
canonical backlog; work is tracked against the workstreams and phases below.

> We are **not** rebuilding. The backend correctness work (RLS, triggers,
> ownership-checked RPCs, the notification outbox) is genuinely good and is the
> asset we build on. This program **hardens and restructures** what exists.

## North star

**Three front doors, two deployables, one backend, a server-authoritative
money/transition core.**

- **Client app** (external, public) → becomes the PWA.
- **Ops app** (internal) → one unified **Production workspace** (the four
  pipeline desks — screener, examiner, typer, delivery — in a single login,
  a generalized Single Seating with the **Admin approval gate kept**), plus
  **Admin** and **Super-admin**, gated by role.
- **One data plane**: Supabase today → GCP (Cloud SQL + Firebase Auth +
  Cloud Storage + an API tier) later, behind thin adapters.
- **Integrity core**: order state transitions, invoice/payout amounts, and
  payment confirmation are **server-authoritative**, never trusted from the
  browser.

## Locked decisions (2026-09-21)

1. Pipeline stays four stages: screener → examiner → typer → delivery.
   ("Searcher" was a mistype; there is no fifth stage.)
2. Consolidate the production desks into **one role named `user`** — a
   generalized Single Seating desk that works an order across all stages, with
   **Admin approval between every stage preserved**.
3. Persistence: collapse the mock/Supabase dual path onto **one backend
   interface**. Standardize dev/demo on the **local Supabase stack**; keep only
   the isolated public "Try demo" guest as a thin in-memory adapter that never
   touches the backend.
4. Adopt **TypeScript** for the extracted domain core (`packages/domain`).
5. Team: Ashly + Sagar.

## Cloud target correction

CLAUDE.md still says the target is **AWS**; the newest committed work
(`gcp/`, the Cloud Run Action, the Cloud SQL bootstrap) targets **GCP**
(Cloud SQL + Firebase Auth + Cloud Storage). Treat **GCP as the target** and
update CLAUDE.md accordingly (workstream N). The SES notification provider is
the one AWS touch-point and can stay or be swapped for a GCP mail provider.

---

## Workstreams

Priorities: **P0** safety-critical / now → **P3** later.

### A. Security & authorization hardening — P0
- [x] **F1** add `can_confirm_payments` to `profiles_guard_privilege_columns()`
      (currently self-grantable via `PATCH /profiles`). **(done — PR #80)**
- [x] **F2** transition-guard trigger on `orders`: block cross-client moves and
      arbitrary desk reassignment for direct staff writes; enforce the admin
      gate server-side. **(done — PR #80; `orders_guard_handoff`)**
- [x] **F3** validate money **amounts** server-side: a bounds guard on
      `orders.workflow` (invoice + abstractor fee: numeric, 0..ceiling), ceilings
      on the ledger tables, and a server-side `product_prices` catalogue (super
      -admin write). Custom quotes preserved. **(done — money-integrity PR)**
- [x] Tighten sequence grants (`order_id_seq` — clients can `setval` today). **(done — PR #80)**
- [ ] MFA for super-admins + the billing owner; session/password policy;
      failed-login backoff; rotate seed/demo credentials.
- [ ] Rate limiting / bot protection on the public client app + auth; decide
      whether client self-registration is enabled.
- [ ] Secrets → GCP Secret Manager; verify only `VITE_*` public values ship to
      the browser.
- [ ] Storage-authorization plan for the GCP move (Cloud Storage bypasses RLS).

### B. Server-authoritative domain core — P0/P1
- [x] Extract the order state machine from `OrderContext.jsx` into a pure,
      portable TypeScript module (`packages/domain`), no React dependency.
      Unit-tested (15 tests). **(done — domain-extraction PR)**
- [x] Move billing/payout math behind the same seam (`@domain/money.ts`);
      unit-tested (20 tests). I/O (localStorage/Supabase) stays in the lib.
      **(done — money-integrity PR)**
- [ ] Integrity ops (advance-stage, confirm-payment, mark-payout-paid,
      set-invoice) as SECURITY DEFINER RPCs now → API endpoints at the GCP move.
- [ ] Explicit state-transition table shared by enforcement + UI.
- [ ] Optimistic-locking on order writes (version/updated_at) — no silent
      last-writer-wins.

### C. Persistence unification — P1
- [ ] One `Backend` interface; `SupabaseBackend` + thin `MockBackend`.
- [ ] Remove the ~67 scattered `isSupabaseConfigured` branches.
- [ ] Kill double-implemented rules (cancel policy, ID scheme, terms/subs).
- [ ] localStorage caches become read-through, not authoritative.

### D. App restructure (three front doors) — P1
- [x] Level-1 hygiene: remove the client→staff cross-link; code-split so clients
      never download staff chunks (main bundle 1,339→553 kB). **(done — PR #80)**
- [ ] Monorepo-lite: `apps/client`, `apps/ops`, shared `packages/*`.
- [~] Production-login consolidation → the `user` role (generalized Single
      Seating, admin gate kept). **D1 done** (rename `operator`→`user`, ADR 0001);
      D2 = one workspace replacing the four stage portals; D3 = retire the stage
      *login* roles + migrate accounts.
- [ ] Authorization refactor: RLS from `assigned_to = my_role()` to a
      production-capability check (D3). **Depends on F2.**
- [ ] Admin/super-admin as a gated section of the ops app.
- [ ] Edge access controls on the ops subdomain.

### E. Data layer & realtime at scale — P1 (100 concurrent)
- [ ] Introduce react-query (fetch/cache/dedup/retry/invalidate).
- [ ] Delta realtime — apply the changed row, not a full `fetchOrders()`.
- [ ] Memoize context values / move to the query cache.
- [ ] Pagination + server-side filtering + covering indexes.
- [ ] Plan the Realtime replacement for Cloud SQL (no Realtime there).

### F. Frontend quality & UX — P1/P2
- [x] Remove dead deps (three.js / @react-three trio — unused). **(done — PR #80)**
- [x] Code-split dashboards; scope `import * as d3`. Further vendor chunking
      (recharts/USAMap into admin) still open. **(done — PR #80)**
- [ ] Bundle-size budget in CI.
- [ ] Accessibility (keyboard, focus, ARIA, contrast, reduced-motion).
- [ ] Design-system extraction (tokens/components) shared across apps.

### G. Notifications productionization — P1
- [ ] Scheduled drain (immediate frequent, digest daily) — nothing runs it today.
- [ ] SES identity + DKIM/SPF/DMARC; flip `NOTIFY_PROVIDER=ses`.
- [ ] At-least-once → effectively-once (idempotency key to SES).
- [ ] Delivery observability + backlog alerting.

### H. Testing & QA — P0/P1
- [x] `npm test` (vitest) + exit-code integrity audit; domain unit tests (15).
      Converting the rest of the `.audit` probes is ongoing. **(started)**
- [ ] RLS allow-and-deny suite (the real-JWT `as(role)` pattern).
- [ ] Test pyramid: unit (domain) / integration (RPCs) / E2E (Playwright).
- [ ] Coverage gate on the integrity core.
- [ ] De-couple audits from the single hardcoded machine; load test at 100 concurrent.

### I. CI/CD, environments & IaC — P0/P1
- [x] PR gate: build + unit tests + from-scratch migration apply (`.github/
      workflows/ci.yml`). Lint/typecheck still to add. Mark required in branch
      protection. **(done — PR #80)**
- [ ] Migration integrity: repo is the only source of truth; from-scratch apply
      verified in CI; drift detection. (A prod-only migration already drifted once.)
- [ ] dev → staging → prod environments; PR preview deploys.
- [ ] Automated deploy on merge + one-click rollback (replace manual dispatch).
- [ ] IaC (Terraform) for the GCP resources.
- [ ] ESLint + Prettier; TypeScript for the domain core.

### J. Observability & operations — P1
- [ ] Error tracking (Sentry) in both apps + functions.
- [ ] Structured logging + correlation IDs server-side.
- [ ] Metrics/dashboards + alerting (failed payments, outbox backlog, errors).
- [ ] Audit-trail completeness; keep it append-only/tamper-evident.
- [ ] Uptime/synthetic checks on login / place-order / confirm-payment.

### K. Data governance, compliance & DR — P1
- [ ] Backups + tested restore; documented RPO/RTO; PITR.
- [ ] PII / GLBA-NPI posture: data-flow map, encryption, access logging on PII.
- [ ] Data retention & deletion policy.
- [ ] Legal work-product integrity (F8): server-generate + store + hash the
      commitment/report PDF at delivery.
- [ ] Upload malware scan + content-type validation on client documents.
- [ ] Compliance roadmap (SOC 2 controls / ALTA Best Practices) if clients require.

### L. GCP migration — P2 (behind thin adapters, after the base is hardened)
- [ ] Update CLAUDE.md + handover docs to GCP.
- [ ] Validate Cloud SQL bootstrap end-to-end; fix the service-role GUC mismatch
      (`request.jwt.claim.role` vs `request.jwt.claims`).
- [ ] API tier (Cloud Run): Firebase token verify, per-txn claims with pooling
      isolation, non-superuser connection, hosts the integrity RPCs.
- [ ] Storage authorization in the API — **must exist before go-live**.
- [ ] Realtime replacement (hard blocker).
- [ ] Auth migration GoTrue → Firebase (+ UID→profiles mapping).
- [ ] Cutover: pg_dump → restore, dual-run/verify with the audit suite, rollback.

### M. Mobile / client PWA — P2/P3
- [ ] Client PWA (manifest, service worker, installable) on `apps/client`.
- [ ] Push notifications for clients (depends on G).
- [ ] Native (Expo/RN) client app only if native push/store/camera become hard
      requirements; reuse `packages/domain`; staff stay web-only.

### N. Documentation, ADRs & governance — P1/P2
- [ ] Update CLAUDE.md (GCP target; three-app structure; integrity-core rule).
- [ ] ADRs for the big calls.
- [ ] Runbooks (deploy, rollback, incident, notification drain, DB restore).
- [ ] Monorepo onboarding README.

### O. Post-migration AI seam — P3 (blocked until off Vercel/Supabase)
- [ ] Rebuild email→order ingest + attachment extraction behind one
      provider-agnostic seam, cloud-native AI. No AI on the current deployment.

---

### P. Client order intake (Place-Order form) — P1, client-side
Business-requested form features. Independent of D (staff-side); routed through
the `createOrder` domain seam and `workflow.intake` JSONB (no migration for P-A).
- [x] **P-A — form fields** (this PR): party fields → single name + add
      buyers/sellers (`workflow.intake.parties[]`); property type select +
      manual entry; custom (non-catalogue) search field; free-cancellation clause
      on the review step; Resolute file # surfaced on confirmation. Multiple
      attachments and auto RTS file numbers were already supported. **(done)**
- [x] **P-B — county dropdown** cascading from state: `public/us-counties.json`
      (us-atlas, 3,136 counties, 32 KB, fetched on demand) + a datalist-backed
      county field; regen via `scripts/gen-counties.mjs`. **(done)**
- [x] **P-C — bulk / Excel import**: `.xlsx`/`.csv` upload (SheetJS, lazy-loaded
      into its own chunk) → parse → preview + per-row validation → **one order per
      property row**; downloadable CSV template. `components` in
      `src/pages/client/BulkImport.jsx`. **(done)** — workstream P complete.

## Phases

- **Phase 0 — Stabilize & make safe (wks 1–3, P0):** A (F1/F2 + grants),
  H (CI test gate + RLS suite), I (PR gate + migration integrity),
  D-Level-1 hygiene, F dead-deps + code-split.
- **Phase 1 — Foundation (wks 3–8, P1):** B, C, E, G, J, N.
- **Phase 2 — Restructure (wks 6–12, P1):** D, F, K.
- **Phase 3 — Cloud (P2):** L + full IaC + staging/prod parity.
- **Phase 4 — Reach (P3):** M, O, compliance hardening.

**Sequencing rules:** F2 before D's role-widening; B before C's collapse;
E before/with D; everything before L.

## Quality bars ("done")
- Every money/status mutation is server-authoritative and covered by an
  allow-and-deny RLS test.
- No PR merges without green build + lint + typecheck + tests.
- Migrations only via pipeline; from-scratch apply verified in CI.
- Zero secrets in the client bundle.
- Backups restore-tested; RPO/RTO documented.
- Errors tracked, key paths alerted, audit trail complete.
- Client bundle under budget; a11y AA on core flows.
