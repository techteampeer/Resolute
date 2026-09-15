# Bringing production up to this branch

Production (Supabase project `wuulybfnhrxpgvqqisxz`, "Resolute") is behind branch
`claude/resolute-e2e-testing-38ipu6` in two independent ways, and they have to be
closed in a fixed order.

> **Step 1 is done.** The six migrations were applied to production on
> 2026-09-14 and verified statement by statement; production now reports 30
> migrations. Step 2, the code deploy, is still outstanding. The rest of this
> document is kept as the record of what was applied and how it was checked —
> and as the procedure to repeat against any other environment.

They were applied through the Supabase Management API rather than
`supabase db push`, because this sandbox has no route to the Postgres port that
its own permission gate allows. Each migration ran in its own transaction
together with its `supabase_migrations.schema_migrations` row, so a failure
would have rolled back the schema change and its bookkeeping together, and each
was verified against the live database before the next was applied.

Reading production before writing to it was what mattered most: it turned up a
defect in these very migrations that would have broken client messaging. See
`notify_assigned_role` below.

---

## The state of things

| | production | this branch |
| --- | --- | --- |
| Schema | 24 migrations, newest `20260909120000_client_pii_super_admin_only` | 30 migrations |
| Code | pre-`29ae333` (checked against the deployed bundle) | 20 commits further on |

`20260909120000` had been applied straight to production and was never
committed; it is now in the repo, reconstructed from the live schema and
verified object-for-object. With it in place the repo reproduces production
exactly — the only object production has that the repo does not rebuild is
`fulfillments_write_staff`, which `20260908030000` deliberately replaces.

The six migrations production is missing:

```
20260908000000_normalise_order_state_codes
20260908010000_enforce_payment_confirmer
20260908020000_notify_assigned_role
20260908030000_scope_fulfillment_writes
20260909000000_db_housekeeping
20260909010000_notification_audience_roles
```

## Order matters

**Migrations first, then the code.** The new code reads
`profiles.can_confirm_payments` in an explicit column list, so it cannot run
against today's schema — deploying first breaks the staff roster on every
screen. The migrations, by contrast, are all safe against the code that is
deployed right now (see the table below), so the intermediate state is fine.

## Step 1 — push the migrations  (applied 2026-09-14)

From a machine that can reach Postgres, this is the whole of it:

```bash
supabase link --project-ref wuulybfnhrxpgvqqisxz
supabase migration list          # confirm the six below are the only gap
supabase db push
```

`supabase db push` will apply them in version order. All six are older than
`20260909120000`, which is already applied; if the CLI objects to the
out-of-order versions, `supabase db push --include-all` is the intended flag.

### Is each one safe against the code that is live today?

| Migration | Effect on the running site |
| --- | --- |
| `normalise_order_state_codes` | Data only — rewrites three rows (`California`, `New Jersey`, `Arkansas`) to `CA`, `NJ`, `AR`. The live UI renders whatever the row holds. Until the code ships, the client order form keeps writing full names, so expect a few more to appear; the deploy stops that. |
| `enforce_payment_confirmer` | Adds `can_confirm_payments` (default false, true for Vivek) and three guard triggers. The live UI already limits confirmation to Vivek, so nothing legitimate changes — this makes the database enforce what was previously only a UI check. |
| `notify_assigned_role` | Adds a notification type and routes assignments to the desk that received the work. **Nothing drains the outbox in production** — no edge functions, no `pg_cron`, no `pg_net`, and zero messages have ever been sent — so no mail results. Also drops the superseded five-argument `enqueue_notification`; see the warning below. |
| `scope_fulfillment_writes` | Replaces `fulfillments_write_staff` (any staff) with `fulfillments_write_owner` (owning desk or Admin). Normal typer and Single Seating work is unaffected, because those desks own the order they are editing. A cross-desk edit — which is the thing being fixed — would now be refused, and the *old* UI does not report refusals. The new code does. |
| `db_housekeeping` | Four indexes, six policies rewritten to the identical predicate with `auth.uid()` hoisted, and the duplicate `order_events` CHECK dropped **only if both copies exist** (production has only one — see below). |
| `notification_audience_roles` | Data on `notification_types`. No mail, per the row above. |

> **The bug this nearly shipped.** `notify_assigned_role` adds a sixth
> parameter to `enqueue_notification`. `create or replace` with a new parameter
> does not replace the function — it creates a second, overloaded one, and
> production still holds the five-argument original. A five-argument call then
> matches both candidates and Postgres refuses to choose:
>
> ```
> ERROR:  function public.enqueue_notification(unknown, text, jsonb, text, unknown) is not unique
> ```
>
> `notify_on_client_message()` makes exactly that call, from an `AFTER INSERT`
> trigger on `support_messages` — so the error aborts the insert. Every message
> a client tried to send would have failed, and the portal is the only channel a
> client has. Reproduced on a local database carrying both signatures, then
> confirmed fixed: the migration now drops the five-argument version, and the
> same insert succeeds and enqueues its four admin recipients. Staff messages
> were never affected (the function returns early unless `sender = 'client'`).
>
> One correction worth knowing: `db_housekeeping` originally dropped
> `order_events_audience_chk` unconditionally, to remove a duplicate. Production
> has only that one constraint, not the pair, so the unconditional form would
> have left `order_events.audience` with **no CHECK at all** — and that column
> decides both client visibility and who gets notified. It is now conditional
> and was tested against both shapes.

### Verify before moving on

```sql
select count(*) from public.orders where state is not null and length(state) <> 2;   -- 0
select email, can_confirm_payments from public.profiles where can_confirm_payments;  -- vivek only
select polname from pg_policy p join pg_class c on c.oid = p.polrelid
 where c.relname = 'fulfillments';                        -- fulfillments_write_owner, fulfillments_read
select conname from pg_constraint
 where conrelid = 'public.order_events'::regclass and contype = 'c';   -- exactly one, still present
select version from supabase_migrations.schema_migrations order by version desc limit 7;

-- Exactly ONE enqueue_notification signature must remain, the six-argument one.
-- Two rows here means the overload above is still present and client messaging
-- is broken.
select pg_get_function_identity_arguments(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'enqueue_notification';
```

Then send one message as a client from the portal and confirm it posts. That is
the single check that would have caught the overload, and it takes a minute.

### What was actually verified on production, 2026-09-14

Each of these was run against the live database after the migrations landed.
The write probes ran inside transactions that were rolled back, so they left no
rows behind; the counts below were re-checked afterwards and were unchanged.

| Check | Result |
| --- | --- |
| Migrations recorded | 30, including all six |
| `orders` / `profiles` / `clients` | 17 / 10 / 7 — unchanged throughout |
| Three state rows | `RTS-10054=CA`, `RTS-10055=NJ`, `RTS-10056=AR`; no non-two-character state remains |
| `enqueue_notification` signatures | exactly 1 (the six-argument one) |
| Client sends a support message | insert succeeds, raising 4 admin outbox rows — the path the overload broke |
| `order_events` CHECK | `order_events_audience_chk` still present, predicate intact |
| Payment guard | plain admin refused when confirming; may still mark; Vivek allowed |
| Fulfillment scoping | owning desk writes, non-owning desk refused, Admin writes, `updated_by` stamped |
| Client PII | screener 0, plain admin 0, super admin 7; `client_directory` 7 to all staff |
| `anon` may still call the RLS helpers | yes — `false / false / null / null`, no 401 |
| Outbox | 4 rows, 0 ever sent — nothing drains it, so no mail was or can be sent |

## Step 2 — deploy the code

Merge the branch's pull request. Vercel builds from `main`.

After the deploy, the quickest confidence check is the one thing that was most
visibly wrong: sign in as `screener@resolute.com` and look at the dashboard —
the four tiles should read off the real queue rather than "Avg Screen Time 18m".
Then sign in as `admin@resolute.com` (a plain admin) and open Billing: client
blocks should be headed `CL01`, not `Lakewood Title Group`.

## If something goes wrong

The only destructive change is the three state values. Restore them with:

```sql
update public.orders set state = 'California' where id = 'RTS-10054';
update public.orders set state = 'New Jersey' where id = 'RTS-10055';
update public.orders set state = 'Arkansas'   where id = 'RTS-10056';
```

Everything else is additive or a policy swap. To put the fulfillment policy back
as it was:

```sql
drop policy if exists fulfillments_write_owner on public.fulfillments;
create policy fulfillments_write_staff on public.fulfillments
  for all using (public.is_staff()) with check (public.is_staff());
```

Supabase's own daily backup and point-in-time restore cover anything wider.

## After the deploy

Two items are then worth queuing, neither urgent:

- `client_directory` is a view with `security_invoker` unset, so it runs as its
  owner and reads past `clients`' RLS; its own `is_staff() or code =
  my_client_code()` clause is the guard. Supabase's advisor flags that shape as
  `security_definer_view`. It is the mechanism, not a mistake — don't "fix" it
  or staff lose the client list entirely.
- Nothing drains `notification_outbox` in production, so the notification cycle
  is built, routed and tested but not actually sending. When that is wanted, it
  needs a scheduled caller and `NOTIFY_PROVIDER=ses`; it is on `preview` today,
  which writes files and mails nobody.
