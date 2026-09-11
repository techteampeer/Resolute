# Pre-handover verification prompt

Paste everything below the line into a fresh Claude Code session opened on this
repository, on branch `claude/resolute-e2e-testing-38ipu6`.

It is written for the pass immediately before real Resolute staff and the pilot
client start using the portal. Everything in it is scoped to what already exists;
it asks for nothing new to be invented.

---

You are the Senior Lead Architect on the Resolute title-search portal.

Read `CLAUDE.md` first, in full. Every constraint in it is binding, including the
ones that look like preferences. Then read `SUPABASE.md` and `DEPLOY.md`, and
`services/notify/README.md`.

**The situation.** Real Resolute staff — screeners, examiners, typers, the
delivery desk, the Single Seating operator, and the three super admins — are
about to start working live orders in this portal, and a pilot client is about to
place real ones. Nothing here is a demo any more. A silent failure that loses an
hour of a typer's work, a commitment document with a placeholder token in it, an
invoice that says one number to the client and another to Vivek, or a client who
can read another client's order, is a business incident and not a bug report.

**Your job is to find whatever is still wrong — frontend, backend, database,
build, deploy, data — and fix it.** Assume nothing is sound because it was
recently touched. Several of the worst defects already found in this codebase
were in code that had just been changed and looked correct.

---

## 1. Method — this is the part that matters most

**Drive the real application. Do not audit by reading code.**

Every single finding you report must come from something you actually observed:
a page you loaded, a button you clicked, a row you read back out of Postgres, an
HTTP status you saw. Reading a function and concluding it is wrong is not a
finding. Reading a function and then making it misbehave in a browser is.

Concretely, for every claim you make:

- **Operate as each role.** `admin`, `client`, `screener`, `examiner`, `typer`,
  `delivery`, `operator` — seven portals, and within admin the difference between
  a super admin (Rajni, Saravanan, Vivek) and a plain admin (Alex Morrison)
  matters. Credentials are in `src/context/AuthContext.jsx` (`MOCK_USERS`), and
  the same addresses/passwords exist in `supabase/seed.sql` for the real backend.
- **Check the database after every step.** A green toast means nothing if the row
  did not change. This is not a stylistic preference — it is how nearly every
  real defect in this codebase was found, and how three "fixed" things turned out
  not to be.
- **Check access control in the database, not in the interface.** A hidden button
  is not a control. Attack every write from the wrong role over PostgREST with a
  real user JWT and confirm the row did not move.
- **When you fix something, re-drive the thing that proved it broken**, and paste
  the before/after into the commit message.

### The traps that have already cost hours

Read these before you write a line of test code.

- **PostgREST returns HTTP 200 with zero rows for an RLS-filtered UPDATE.** Not
  an error. Not a 403. This is the single largest source of silent failure in
  this app. Any code path that writes and does not check the affected row count
  is suspect.
- **There is no outbound network egress.** Playwright will hang for the full
  timeout on Google Fonts and anything else external. Abort every request that is
  not localhost (see the harness sketch below) or nothing will ever load.
- **Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.**
  `chromium.executablePath()` returns a different, non-existent path. Always pass
  `executablePath` explicitly. Do not run `playwright install`.
- **`.first()` on a row action grabs the wrong order.** Scope to the row:
  `page.locator('tr', { hasText: ID })`, then assert the modal text contains the
  ID before acting on it. A test that silently operated on the top row produced a
  completely wrong conclusion once already.
- **`button:has-text("Deliver")` matches the "Delivered" sidebar tab.** Use
  `getByRole('button', { name: /Deliver & Submit to Admin/ })`. Several nav
  labels collide with action labels; check what you actually clicked.
- **Two un-awaited writes to the same row is a real bug pattern here**, not a
  theoretical one. `updateOrder()` followed by `completeStep()`/`returnToAdmin()`
  raced, and the stale write won — but only for accounts whose RLS policy let it
  through, so it looked fine for every production desk and silently undid Admin's
  work. Three call sites had it. **Go looking for more.** Any place that calls two
  context mutators in sequence for one user action deserves a hard look.
- **In demo/mock mode a hard navigation loses the session** (there is nothing to
  restore), so deep links only work against the real backend. Navigate in-app
  when testing mock mode.
- **Do not run `supabase db reset`.** It destroys the working local database.
  Rebuild into a scratch database instead (recipe below).
- **`at` is a reserved word in Postgres** and will break a `select … as at` alias
  in your check queries.

### Environment bring-up

```bash
# Supabase (Postgres 17, PostgREST, GoTrue, Storage) — usually already running
supabase start            # takes a few minutes on a cold container
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c '\dt'   # PGPASSWORD=postgres

# App
npm install
npm run dev               # http://127.0.0.1:5173
```

Build a small shared Playwright + psql harness in a gitignored directory
(`.audit/` is already in `.gitignore`) rather than repeating boilerplate in every
script. It needs, at minimum:

```js
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'

export const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
export const BASE = 'http://127.0.0.1:5173'

export const sql = (q) => execFileSync('psql',
  ['-h','127.0.0.1','-p','54322','-U','postgres','-d','postgres','-X','-A','-c',q],
  { env: { ...process.env, PGPASSWORD: 'postgres' }, encoding: 'utf8' })

export async function login(b, who) {
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 } })
  // Without this, every page hangs on external requests.
  await ctx.route('**/*', r => {
    const u = r.request().url()
    return (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')
         || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort()
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"], input[name="email"]', EMAIL[who])
  await page.fill('input[type="password"]', PASSWORD[who])
  await page.click('button[type="submit"]')
  await page.waitForTimeout(2500)
  return { page, ctx, errors }
}
```

You also want an `as(who, path, opts)` helper that signs in over GoTrue
(`POST /auth/v1/token?grant_type=password`) and issues PostgREST requests with
that user's JWT. **That is the only honest way to test RLS** — a service-role key
bypasses it entirely and will tell you everything is fine.

**Collect page errors on every single page you visit.** An uncaught
`ReferenceError` unmounts the React tree and leaves a blank white page; that is
exactly how the typer's commitment form was found to be completely dead.

---

## 2. What has already been fixed — re-verify, do not trust

These are the twelve commits on this branch. Each was driven and checked in the
database when it was made. **Spot-check every one of them again**, because
subsequent commits touched shared code and because a fix that was proven in
isolation is not proven in combination.

| Commit | What it claims |
| --- | --- |
| `ea06dfa` | The typer commitment form no longer crashes; delivery on an un-typed order no longer sends the row backwards |
| `4bb7ac6` | Two migrations that existed only in production are now in the repo |
| `967dd23` | Client-code masking derives from the order row and never falls back to the name |
| `29ae333` | Admin can open the fulfillment form; session survives reload; staff rosters come from `profiles`, not a fixture |
| `dd155d3` | State stored as two-letter codes everywhere; client file number surfaced across the app |
| `e22db9d` | Orders get a price and a committed date at confirm; only Vivek can confirm money, enforced by DB triggers |
| `f7b1a5b` | Assignment notifies the desk that received the work; hold and clarification are visible to the person working the order |
| `12c2e0e` | A refused write is reported rather than shown as saved; fulfillment writes are scoped to the owning desk; a partial fulfillment row no longer blanks the form |
| `9398fae` | No `‹placeholder›` tokens in the client's document; per-role mail links; schema housekeeping and the advisor items |
| `4a33c8e` | The agreed price carries into the invoice; the Assign modal says when an order has no price or date |
| `bf171bc` | A per-user Notifications screen in all six staff portals, wired to `notification_preferences` |
| `ffa26e8` | One write per stage completion (the race above); Finalize wording that fits whoever is reading it |

For each: reproduce the original failure condition if you can, then confirm the
current behaviour. If any claim does not hold, that is a high-severity finding —
say so plainly and do not soften it.

## 3. Known-open, deliberately

Do not report these as new findings. Do confirm they are still true and still
harmless.

- **Staff can read every order row.** `orders_read` is `is_staff()`. The per-desk
  queues are filters, not boundaries. This was a deliberate decision; the fix is
  documented rather than enforced. Writes *are* scoped
  (`orders_update_assigned`, `fulfillments_write_owner`).
- **Admins can read everyone's notification preferences but cannot edit them.**
  A "manage staff notifications" feature would need a policy change.
- **`/admin/settings` is a stub.** It points at Notifications.
- **Commissions are not implemented.** Rules are TBD (CLAUDE.md).
- **Inbound email→order ingest is removed and stays removed.** Do not rebuild it.
- **`NOTIFY_PROVIDER` is `preview`.** Nothing mails anyone. Keep it that way for
  the whole of this pass.

---

## 4. Scope — go through all of it

### A. Frontend: every portal, every screen, every state

Seven portals. Visit **every route**, as **every role that can reach it**, and in
each case check: the page renders, the console is clean, the data on screen came
from the database and not a fixture, and the empty / loading / error states are
right.

```
/admin       dashboard, orders, orders/:id, order/:id (fulfillment),
             users, billing, support, map, reports, notifications, settings
/screener    dashboard, queue, completed, order/:id, notifications
/examiner    dashboard, examine, completed, order/:id, notifications
/typer       dashboard, queue, completed, order/:id, notifications
/delivery    dashboard, queue, sent, order/:id, notifications
/operator    dashboard, completed, order/:id, orders/:id, notifications
/client      dashboard, order (place), orders, orders/:id, messages,
             billing, support
/login  /staff  /  (role redirect)  and an unknown path
```

For each screen specifically:

1. **Is every number and every table row real?** **Start here — this is a known,
   unfixed, pervasive defect.** Four dashboards and the client dashboard render
   entirely fabricated stat tiles, and four sidebars render fabricated queue
   badges. They do not move when the data moves:

   ```
   src/pages/client/ClientDashboard.jsx:841-844    Active Orders 2, Completed (YTD) 12,
                                                   Avg Turnaround 1.9d, Rush Orders 1
   src/pages/delivery/DeliveryDashboard.jsx:144-147 Ready to Deliver 2, Sent Today 3,
                                                   Delivered (MTD) 79, Avg Delivery 22m
   src/pages/examiner/ExaminerDashboard.jsx:149-152 Awaiting Exam 2, In Progress 1,
                                                   Completed Today 4, Issues Found 1
   src/pages/typer/TyperDashboard.jsx:34-37        Awaiting Typing 2, In Progress 1,
                                                   Typed Today 6, Avg Type Time 24m
   nav badges: screener/queue 3, examiner/examine 2, typer/queue 2, delivery/queue 2
   ```

   A screener's sidebar says "Screening Queue 3" with an empty queue. A client is
   shown "Completed (YTD) 12" on their first day. **Every one of these must be
   derived from the orders the signed-in user can actually see, or removed.**
   Decide per tile: some (Avg Turnaround, Avg Delivery, Issues Found) need a real
   definition before they can be computed — if the data does not support an
   honest number, take the tile out rather than invent one. Then sweep the rest
   of the app for the same pattern; assume there are more.
2. **Empty state.** What does the screen do with zero rows? A client with no
   orders, a desk with an empty queue, an order with no messages, no documents,
   no activity. Blank panels and bare labels with nothing after them are defects.
3. **Loading state.** What renders between mount and the first fetch? A flash of
   "no orders" before the real ones arrive is a defect.
4. **Error state.** Break the network (abort `/rest/v1/**` in Playwright) and
   reload. Does the screen say something true, or silently show nothing?
5. **Deep link and reload.** Load every `:id` route directly and refresh mid-way
   through a form. The session must survive; the route must not bounce to login.
6. **Browser back** after a submit. Does it show a stale screen that invites a
   double submission?
7. **Double-click every submit button.** Does it fire twice? Is there a duplicate
   row, a duplicate event, a duplicate notification?
8. **Every form**: required-field validation, what happens on submit with the
   bare minimum filled in, what happens with the maximum, paste of a very long
   string, leading/trailing whitespace, an emoji, an apostrophe in a name
   (`O'Brien`), a 5,000-character note.
9. **Every file upload**: a real PDF, a `.docx`, a disallowed type (`.exe`,
   `.zip`), a 0-byte file, a very large file, two files at once, and cancelling
   the picker. Confirm what reached Storage and what the row says.
10. **Narrow viewport.** 1280, 1024, and 390 wide. Tables must scroll inside
    their own container; the page body must not scroll horizontally. Check the
    fulfillment form and the admin orders table in particular.
11. **Client-identity masking.** Anywhere a non-super-admin can see a client name
    instead of a code is a confidentiality defect. Check every table, every
    modal, every CSV export, every PDF, every email template, every activity feed
    entry, and the notification bell.

### B. The order lifecycle, exhaustively

The pipeline is `screener → examiner → typer → delivery`, with the order parking
with Admin between every stage. Single Seating (`operator`) works an order
end-to-end with Admin approval after each phase.

Carry at least these through, checking the row after every transition:

- **A full happy path**, client placement to delivered, using the portals — not
  SQL. Confirm at the end: `status='delivered'`, `assigned_to=null`,
  `progress=100`, `completed` set, `completed_dates` and `completed_by` populated
  for all four stages with the right names, the commitment PDF attached, the
  invoice amount equal to the agreed price, and the `order_events` trail in the
  right order with no gaps and no duplicates.
- **One order cancelled mid-pipeline** by the client, and one cancellation
  *requested* and then approved by Admin. Where does the money land? What does
  the client see? Is `chargeOnCancel` honoured?
- **One order through Single Seating**, all four phases.
- **One order put on hold** and resumed; one with a clarification requested,
  answered by the client, and resolved.
- **Rework**: Admin sends an order *back* to an earlier stage. Does the status,
  progress, and `completed_dates` behave sanely, or does the row end up in a
  state the UI cannot represent?
- **Every assignment gate.** The Assign modal blocks skipping ahead of the due
  stage. Try to skip anyway, from the modal and by any other route you can find.
- **Two people acting on the same order at once.** Open the same order in two
  contexts as two roles and act simultaneously. Who wins, and does the loser
  find out?

### C. The Title Commitment — the client's legal document

This and the tables are what the client and the staff will judge. Generate it
from:

- a **fully populated** fulfillment,
- a **sparse** one (only the required sections),
- an **untouched** one (exactly what the form seeds),
- a **partial row** (a fulfillment whose JSON is missing whole sections).

For each, confirm:

1. It is a real PDF with **selectable, extractable text** — not an image, not
   mojibake. Extract the text and read it.
2. **Every section renders in the right order**, with the right heading, and
   nothing is wrongly blank.
3. **No `‹token›` placeholders anywhere** — not in the PDF, not in the HTML
   preview, not in the print view, not in the `.doc` export.
4. **No table of headers over an all-em-dash row.** An empty section must say so
   in words.
5. Schedule B-I and B-II read as legal prose, with blanks where a title document
   would rule one.
6. The **invoice total equals the sum of the charges** the typer entered, and
   equals what the client is shown on their Billing page, and equals
   `workflow.invoiceAmount` on the row. Check rush surcharges and discounts.
7. Long values do not overflow: a 400-character legal description, a party name
   with an apostrophe, twelve deeds, six judgments, ten plat maps.
8. The client can actually **download it** from their portal, and a non-owning
   client cannot.

### D. Billing, payouts, and money

From `CLAUDE.md`, and every one of these must be attacked from the wrong role:

- **Check payments are two steps.** A client uploading a check scan is *not*
  payment. Prove that no UI path and no API call can collapse "uploaded" into
  "paid".
- **Only Vivek confirms.** Payments, vendor payouts, and subscriptions. There are
  DB triggers for this — try to get round them as Rajni and as Saravanan, over
  PostgREST, not just in the UI.
- **ABS / Both routing owes a vendor fee.** Confirm the obligation surfaces to
  super admins, that entering a vendor and fee writes `vendor_payouts`, and that
  an In-House order does not create one.
- **Cycles.** Weekly / 15 days / 30 days per vendor and per client, plus
  per-order for clients. Do the groupings and totals actually compute, or is the
  selector cosmetic?
- **Arithmetic.** Rounding on a discount, a multi-unit line, a rush surcharge.
  Cents must not drift.
- **What the client sees.** `invoiceVisibleToClient`, and whether a client can
  see an invoice before it is released.

### E. Access control, proven in the database

Build a **matrix** and run it: every table × every role × select / insert /
update / delete, over PostgREST with a real user JWT, plus `anon` with no JWT.

Tables: `orders`, `fulfillments`, `order_events`, `support_messages`, `clients`,
`profiles`, `vendors`, `vendor_payouts`, `subscriptions`, `notification_types`,
`notification_preferences`, `notification_outbox`, and Storage (`documents`).

Specific things to try to break:

- A client reading, updating, or inserting **another client's** order, messages,
  fulfillment, events, or documents.
- A production desk writing an order or fulfillment **not on its desk**.
- Anyone at all escalating their own `profiles.role`, `super_admin`, or
  `can_confirm_payments`. (There is a guard trigger — try to get round it,
  including via signup metadata.)
- Anyone but an admin replying to a client in `support_messages`
  (`support_admin_reply` — **never weaken this to `is_staff()`**), and whether a
  client can read a staff `visibility:'internal'` note.
- Reading `notification_outbox` as anything but the service role.
- Fetching a Storage object belonging to another client's order by guessing or
  reusing a URL. Check signed-URL expiry too.

Then run the **Supabase security and performance advisors** and act on what they
say — or, where an item is a false positive, say so in the migration with the
evidence. (One already is: revoking `anon`'s EXECUTE on the RLS helper functions
turns every anonymous read into a 401 instead of an empty set, because Postgres
checks EXECUTE on functions inside policy expressions against the querying role.
Do not "fix" that one.)

### F. Backend and services

- **`services/notify/`** — run both modes end to end against a drained outbox.
  `immediate` and `digest`. Confirm: one row per recipient, dedupe actually
  dedupes, `order.assigned` reaches only the desk that got the work, client names
  are masked for non-admin recipients, every message has both an HTML and a text
  part, both carry the footer, and every deep link in every template resolves to
  a real route for that role (they are not the same path in every portal).
  Confirm a preference of `off` stops a message being queued at all, and that
  `digest` lands in the digest and not the immediate run.
- **`providers/ses.js`** — do not send anything, but confirm the SigV4 signing is
  exercised by a unit-level check, since nobody will find out it is wrong until
  the day it goes live.
- **`api/admin/users.js` and `api/_lib/`** — the only serverless functions. Call
  them with no auth, with a client's token, and with an admin's. Confirm the
  service-role key cannot leak to the browser bundle (grep `dist/` for it).
- **Portability.** CLAUDE.md requires handlers to be thin adapters over
  `services/` and `api/_lib/`. Flag anything Vercel-shaped that has crept into
  core logic, because the AWS move is imminent.

### G. Database

- **Rebuild the migration history from nothing.** Create a scratch database,
  apply all 29 files in order with `ON_ERROR_STOP=1`, and diff the resulting
  `public` schema against the running one — columns, policies, function bodies,
  triggers, indexes, constraints, RLS flags, column comments, and the
  `notification_types` seed rows. They must match. This has caught a broken
  history twice; do not skip it because it passed last time.
- **Idempotency.** Apply every migration twice. `create policy` without a
  preceding `drop policy if exists` will abort the run.
- **`supabase/seed.sql`** — confirm all ten demo logins still resolve to the
  right role and land on the right portal. A migration once silently turned every
  account into a client.
- **Drift.** Compare the repo's migrations against the production project.
  Anything in production that is not in the repo is a landmine.
- **Constraints and integrity.** Orphan rows, nullable columns that should not
  be, enum values the UI can produce that the CHECK constraint rejects, duplicate
  constraints, foreign keys with no covering index, and any `jsonb` blob the UI
  reads with a required shape but the DB does not guarantee.
- **Dates and money.** Timezone handling on `created`, `eta`, `completed`, and
  the digest's day boundary. `numeric` vs float anywhere money is stored.

### H. The twelve tables must be correctly populated

For each of `orders`, `fulfillments`, `order_events`, `support_messages`,
`clients`, `profiles`, `vendors`, `vendor_payouts`, `subscriptions`,
`notification_types`, `notification_preferences`, `notification_outbox`:

- Name the **user flow that writes it**. If no flow writes it, say so — that is a
  finding, not a footnote.
- Confirm every column the UI reads is actually populated by that flow.
- Confirm no screen anywhere still reads `src/data/mockData.js` or
  `src/data/demoData.js` while Supabase is configured.

### I. Build, deploy, config

- `npm run build` must pass. Check the bundle for secrets and for anything that
  should not ship.
- `vercel.json` is **schema-validated by Vercel before the build** and takes no
  comments. If you touch it, validate against
  `https://openapi.vercel.sh/vercel.json`.
- Every environment variable the app needs is documented in `DEPLOY.md` and
  `.env.example`, and the app fails loudly rather than silently when one is
  missing.
- `NOTIFY_PROVIDER` stays `preview`.

### J. What a real person does that a test never does

Spend real time on this. It is where the remaining defects are.

Refresh in the middle of the fulfillment form. Open the same order in two tabs
and edit both. Leave a form open for twenty minutes and then submit. Click
submit, then immediately click back. Upload a document and navigate away before
it finishes. Sign out in one tab while working in another. Use the browser's
autofill. Paste a table from Excel into a textarea. Zoom the browser to 150%.
Work an order on a slow connection (throttle the route handler).

---

## 5. Hard constraints

- Develop, commit and push **only** on `claude/resolute-e2e-testing-38ipu6`.
  Never push to `main`.
- **Do not open a pull request** unless explicitly asked.
- **No AI/LLM logic and no new AI libraries.** Blocked until after the AWS move.
- **Do not rebuild the inbound email→order ingest.** It stays removed.
- **Do not build Qualia integrations.** This portal replaces Qualia.
- **Never weaken `support_admin_reply` to `is_staff()`.**
- **`npm run build` must pass before every push.**
- Keep logic in portable modules under `services/` and `api/_lib/` — the AWS
  migration is imminent, so do not build Vercel-shaped throwaway work.
- No model identifier in commit messages, PR text, code comments, or anything
  else pushed to the repository.
- Keep `NOTIFY_PROVIDER=preview` throughout. It must not mail real colleagues
  during testing.

---

## 6. What to hand back

**First, a findings report. Do not fix anything before I have seen it.**

One table, ordered by severity (Blocker, Major, Minor), with these columns:

```
| # | Severity | Area | What I did | What happened | What should happen | Evidence |
```

"What I did" is the click path or the query. "Evidence" is the row, the status
code, the screenshot filename, or the extracted PDF text — something checkable.

Then three plain-sentence lists, no table:

1. What you believe is broken but could not prove.
2. What you deliberately did not test, and why.
3. Where a proper fix is bigger than a pilot needs, with the smaller fix you
   would make instead.

**Then wait.** I will tell you what to fix and in what order.

When you do fix: one concern per commit, the verification pasted into the commit
message as before/after, `npm run build` green, and the thing that proved it
broken re-driven afterwards.

## 7. Definition of done

- Every route in section A loads, for every role that can reach it, with a clean
  console and real data.
- A full lifecycle, a cancellation, and a Single Seating run all complete with
  the database in the expected state after every transition.
- The commitment document is correct from a full, a sparse, an untouched, and a
  partial fulfillment.
- Every write in the access-control matrix behaves correctly **in the database**.
- The migration history rebuilds from nothing into a schema identical to
  production.
- The notification cycle delivers to the right people, at the right frequency,
  with correct links and correct masking — and mails nobody.
- `npm run build` passes and the branch is pushed.
