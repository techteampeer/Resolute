# Critical Test Plan — User lifecycle + task flow (incl. QC)

**Goal:** prove that an admin can create a production user, that the user can log
in and reach their own dashboard, that they appear for the admin to assign work,
and that work flows **to** them and **on** from them through the pipeline —
including the new **Quality Check** stage.

**Environment:** live site `https://resolute-kappa.vercel.app` (Supabase-backed).
**Tester:** team lead (admin / super-admin) + a second browser/incognito window
to act as the newly-created production user.

> Record each case as **PASS / FAIL / BLOCKED** with a note. A FAIL in the
> **Pre-flight** section usually explains later failures — do those first.

---

## 0. Pre-flight — configuration (do these FIRST)

| # | Check | How | Expected |
|---|---|---|---|
| P1 | Latest build is live | Hard refresh (Ctrl/Cmd+Shift+R) on the site | Stage plan shows a **Quality Check** row |
| P2 | Service-role key present | (verified from CI/probe) `/api/admin/users` returns **401**, not 500 | ✅ already confirmed |
| P3 | **Auth redirect URL** | Supabase → Authentication → **URL Configuration** → Site URL **and** Redirect URLs | Must be `https://resolute-kappa.vercel.app` (NOT `localhost:3000`). This is the #1 cause of "invite link doesn't let me set a password." |
| P4 | Admin can open Users | Admin portal → Users / Team | The user list loads |

---

## A. Create a user (admin portal)

| # | Steps | Expected |
|---|---|---|
| A1 | As **super-admin**, Users → Add user: name, email, role = **Production** | Success; the panel shows a **secure invite link** (not a password) to copy |
| A2 | Add user with an email that already exists | Clear error, no duplicate created |
| A3 | As a **plain admin** (not super), try to create an admin / toggle super-admin / billing | Blocked — "Only a super admin can grant super-admin, billing, or elevated permissions." |
| A4 | After A1, look at the Users list | The new user appears, marked **active** |
| A5 | (If used) set stage-scope permissions on create | They persist on re-open |

**Watch for:** if A1 errors with "Server not configured", the service-role key is
missing (P2). If it succeeds but there's **no invite link**, the admin can still
use **Reset password** to regenerate one.

---

## B. New user activates + logs in (second window)

| # | Steps | Expected |
|---|---|---|
| B1 | Open the invite link from A1 | Lands on **Set your password**; set a password ≥ 8 chars → continues to **their** dashboard |
| B2 | Production user lands on | `/user` (Production Workspace) |
| B3 | Sign out → sign in with the email + the password just set | Signs in, back to `/user` |
| B4 | (Admin) Deactivate the user, then have them try to sign in | Sign-in refused (account banned) |
| B5 | (Admin) Reactivate → user can sign in again | Works |

**Watch for:** if B1 opens the link but drops you on a login page or a blank/404
instead of Set-password → **P3 (redirect URL)** is wrong, or the link expired
(they're short-lived — regenerate with Reset password and use it promptly).

---

## C. Reflected for the admin to assign

| # | Steps | Expected |
|---|---|---|
| C1 | As admin, open any order → **Stage plan** → stage-by-stage | The new production user appears in every stage's person picker, with a live "N active" load (0 for a fresh user) |
| C2 | Does the new user show up without a full reload? | If not visible immediately, reload the admin page — then they appear |
| C3 | Assign the new user to a stage (e.g., **Screener**, or **Quality Check**) and Set plan | Plan saves; the order routes to them (or parks with Admin if the *currently-due* stage has no owner) |

**Watch for:** the picker lists **role = Production (`user`) + active** accounts
only. A user who doesn't appear is usually not active, not role=Production, or the
admin page needs a reload.

---

## D. New user's portal works + task passing

| # | Steps | Expected |
|---|---|---|
| D1 | New user opens `/user` with no orders | Dashboard loads; "No orders assigned to your desk" (empty but correct) |
| D2 | Admin plans an order with the new user on the **first** stage (Screener) | Order appears in the new user's **Active Orders** with the stage badge |
| D3 | New user opens the order → completes the stage | Routes to the **next** stage's pre-assigned owner, **no Admin gate** (for a planned order) |
| D4 | The previous owner tries to edit the order after it moved | Refused (RLS owner-scope) — read-only |
| D5 | New user who is **not** on an order's plan opens it by URL | Read-only ("not assigned to the Production Desk") |
| D6 | New user hits a problem → **Escalate to Admin** with a note | Order parks with Admin, note recorded |

---

## E. Guard / negative tests (should all be REFUSED)

| # | Attempt | Expected |
|---|---|---|
| E1 | Production user tries to change who owns a later stage | Refused — the plan is admin-only |
| E2 | Route an order to an arbitrary user (not the plan's next owner) | Refused |
| E3 | Hand the order on without completing the stage | Refused |
| E4 | Skip a stage | Refused |

---

## F. Quality Check (the new stage)

| # | Steps | Expected |
|---|---|---|
| F1 | Plan an order with the **QC slot empty**; complete Typing | Order routes **straight to Delivery** (QC skipped) |
| F2 | Plan an order with a **QC reviewer** assigned; complete Typing | Order routes to the **QC reviewer** (status "Quality Check") |
| F3 | QC reviewer opens the order → **Pass → Delivery** | Routes to the Delivery owner |
| F4 | On another order, QC reviewer → **Reject — Corrections Required** (with a note) | Returns to the **Typer** for corrections; note recorded |
| F5 | Typer re-submits the corrected order | Returns to the **QC reviewer** for re-review |
| F6 | Admin dashboard + the production desk | Show an **"In Quality Check"** count and a purple **Quality Check** badge on QC orders |
| F7 | Single-seating plan | QC is **skipped** (single seating is one person straight through) |

---

## Known risks to watch (from the code audit)

> _(filled in from the lifecycle code audit — see the chat summary)_

- **P3 redirect URL** is the single most likely blocker for B1.
- A brand-new user may need an **admin-page reload** before showing in the assign
  picker (C2) if realtime isn't re-fetching the roster.
- _(additional findings appended after the audit)_
