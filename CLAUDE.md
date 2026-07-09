# Resolute Portal — Architect Constraints

Role: act as Senior Lead Architect. Focus: high-quality, modular, AWS-native code.
Verify every new feature against these constraints before implementing.

## Architecture transition

- **Current:** Vercel (static Vite SPA + serverless functions in `api/`).
- **Target:** AWS (full server). Abstract Vercel-specific code (request/response
  handlers, `waitUntil`, rewrites) away from core logic so handlers are thin
  adapters over portable modules (`api/_lib/`, `services/`).

## AI & automation — BLOCKED until post-AWS migration

- Do NOT add or extend AI/LLM logic that runs on Vercel. No new AI libraries in
  `package.json` for the Vercel deployment.
- Existing state (allowed to remain, dormant): `api/webhooks/inbound-email.js`
  falls back to regex heuristics when `ANTHROPIC_API_KEY` is unset — do not set
  that key on Vercel. `services/email_ingest/` is a local/offline service.
- Post-migration goal: email stream → parse attachments (invoices / search
  packages) with AWS-native AI (Textract / Comprehend / Bedrock) → auto-draft
  order in the portal. Keep `extractOrderFields()` as the provider-agnostic seam.

## Billing & payment logic

- **ACH:** direct transfer.
- **Checks:** strict 2-step process — the states must stay separate:
  1. *Upload/marked:* client uploads a check scan (PDF/image) to the portal for
     reference. This is NOT payment.
  2. *Confirmed:* only Vivek (super admin, `canConfirmPayments` in
     `src/lib/billing.js`) confirms funds after physical receipt/deposit.
- Never collapse "uploaded" into "paid"; guard confirmation behind the Vivek
  role check.
- **Vendor payouts (money OUT):** searches the screener routes to ABS or Both
  owe the abstractor vendor a fee (`src/lib/payouts.js`). Super admins
  (Rajni/Saravanan/Vivek) view payouts and enter vendor + fee per order; ONLY
  Vivek marks payouts and subscriptions paid (he executes transfers from the
  Chase account outside the app — the portal is a ledger, never a gateway).
- Payout/billing cycles are selectable per vendor and per client:
  weekly / 15 days / 30 days (clients also have per-order mode).
- Commissions: intentionally not implemented yet — rules TBD.
- This portal is being built to REPLACE Qualia; do not build Qualia
  integrations.

## Domain model (quick reference)

- Pipeline roles in fixed order: screener → examiner → typer → delivery
  (`ROLE_SEQUENCE` in `src/data/mockData.js`). Status derives from the owning
  role (`statusForRole`).
- Between stages, orders park with Admin for approval
  (`returnToAdmin` in `src/context/OrderContext.jsx`, `assignedTo: 'admin'`).
- **Single Seating** desk (role key `operator`): works orders end-to-end, but
  only orders Admin explicitly assigns to it (`workflow.singleSeating`), with
  Admin approval after every phase.
- Client identities: non-super-admins see client codes, not names
  (`displayClient`).

## Coding standards

- Concise, performance-optimized React/Node patterns; minimize boilerplate.
- Match the existing style: functional components, inline style objects with
  role color constants, mock-data-first with optional Supabase persistence
  (`isSupabaseConfigured` guards).
- Build check: `npm run build` must pass before pushing.
