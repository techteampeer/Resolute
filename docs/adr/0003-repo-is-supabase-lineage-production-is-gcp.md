# ADR 0003 — The repo is the Supabase lineage; production is on GCP ahead of it

Status: **accepted** · 2026-11-19 · Workstream B (GCP migration)
· records the state the 18 Nov 2026 integration review surfaced. It changes no
runtime behaviour (one stub is made fail-safe); it documents the gap so feature
work stops assuming this repo is what production runs.

## Context

ADR 0002 *proposed* re-platforming off Supabase onto Cloud SQL + Firebase Auth +
Cloud Run. Since then that move was **executed for production**: per the
18 Nov 2026 integration review
(`Resolute_GCP_Ashly_Integration_Review_2026-11-18.md`), the live portal serves
from Cloud Run revision `resolute-portal-00010-jay` (`us-central1`), backed by
Cloud SQL (`resolute_live`), Firebase Auth and private GCS. The review assessed
the GitHub `main` tree (HEAD `3d7aeed`) against that deployed GCP system.

The repository did **not** move with production. `main` here is still the
**Vercel/Supabase lineage**:

- the browser talks to Supabase (PostgREST + RLS); features are built as Postgres
  RPCs + `supabase/migrations/*` plus the Vercel `api/` layer;
- `src/lib/backends/gcp.js` is a **stub** (`isSupabaseConfigured = false`, so a
  `VITE_BACKEND=gcp` build runs as mock data, not against GCP) and
  `services/api/src/routes/` holds only `orders.js`;
- the real GCP backend — the Firebase/Cloud SQL provider and the full
  `services/api` (charge/company/document routes the review describes) — lives in
  the **deployed GCP snapshot, not in this repo**.

So a feature merged here works on the Supabase/mock path (where CI is green) and
is a no-op on GCP. CI's green `db-integrity` lane validates Supabase SQL, not GCP.

## Decision

1. **Do not deploy the GitHub tree to GCP production.** (Per the review; the live
   revision is unchanged and nothing was deployed.)
2. A feature is **not production-real** until it has a **GCP-native backend** — an
   authenticated `services/api` route + a Cloud SQL transaction with
   role/ownership checks and tests — AND that backend is **committed to this
   repo**. Until then it exists only on the Supabase provider.
3. On the GCP provider, unsupported new writes must **fail safe** (surface a clear
   not-wired error), never fake success. This ADR flips the `createAdminClient`
   stub from a silent `null` to the same not-wired throw its siblings use.
4. **Never** run `supabase/migrations/*` against the live Cloud SQL
   (`resolute_live`). Port the behaviour as GCP-native code + migrations,
   reviewed against the real schema.
5. Close the process gap: **commit the deployed GCP backend and its CI pipeline to
   this repo** (review item #5) so future releases cannot silently revert to the
   Supabase/Vercel code.

## Parity backlog (from the review — blocks a GCP merge)

These are the Supabase-lineage features already on `main`, each needing a
GCP-native backend before it reaches customers:

- **B1 — Additional fee lifecycle.** Raise + owner approve/decline as
  authenticated `services/api` routes + Cloud SQL transactions; approved charges
  hit the invoice **exactly once**; approval is consent-to-bill, **not** payment;
  GCP-native order events/notifications (do **not** transplant the Supabase
  trigger). Repo side today: PRs #148 (approval) and #153 (resolution
  notifications) — Supabase `resolve_order_charge`.
- **B2 — Client company creation.** Admin-only match-or-create company endpoint +
  Cloud SQL transaction returning `created|matched|ambiguous`; no client-code
  race; client denied. Repo side: PR #146 — `admin_create_client`.
- **B3 — Order documents & access control.** Map the new workflow keys
  (`titleSearchDoc`, `supplementaryDocs`, `deliveryDocs`) to GCS `documentId`
  stage kinds and the GCP document guards the review names
  (`document_referenced()` / `guard_order_documents()` — these live in the GCP
  snapshot, not this repo); delivery-only release to clients; no public bucket or
  `blob:` URLs persisted. Repo side: PR #147 — `src/lib/orderDocs.js`.
- **B4 — Vercel/migration reconciliation.** Port `api/admin/users.js` and the four
  new `supabase/migrations/*` as GCP-native code; reconcile
  `20261105010000_profile_client_code_fk.sql` against the real `resolute_live`
  schema rather than applying it blindly.

Acceptance checks, **Claudio's cost approval** for Cloud builds / Cloud SQL
migrations, and zero-traffic-preview verification before any cutover are per the
review's "Required acceptance checks" and are unchanged here.

## Consequences

- Feature PRs in this repo are Supabase-lineage work. They are safe (nothing is
  deployed) but do not reach customers until B1–B4 land and the GCP backend is in
  the repo.
- `CLAUDE.md` gains a "Deployment reality" note pointing here, so the next feature
  round starts from this truth instead of rediscovering it.
