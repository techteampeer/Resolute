-- =====================================================================
-- Enforce "only the billing owner confirms money" in the database
-- =====================================================================
-- CLAUDE.md is emphatic: a client uploading a check scan marks an invoice
-- SUBMITTED, never PAID; only Vivek confirms funds after receipt/deposit; and
-- only Vivek marks vendor payouts and subscriptions paid. The portal is a
-- ledger, never a gateway.
--
-- Half of that held. client_mark_payment() is properly guarded — it accepts only
-- status 'marked', only on the caller's own order, and refuses to overwrite an
-- already-confirmed deposit. But the "only Vivek" half was a UI check and
-- nothing else: canConfirmPayments in src/lib/billing.js compares an email
-- address, and the policies behind it are plain `is_admin()`. Over PostgREST,
-- every admin account could do all three:
--
--   as admin@resolute.com (not even a super admin), rajni and saravanan:
--     PATCH /orders?id=eq.X  {"workflow":{"payment":{"status":"confirmed"}}}  -> 200, written
--     PATCH /vendor_payouts?order_id=eq.X  {"status":"paid"}                  -> 200, written
--     PATCH /subscriptions?id=eq.sub1  {"paid_by":"admin"}                    -> 200, written
--
-- The capability now lives on the profile rather than in a hardcoded email, so
-- the person who reconciles deposits can change without a code deploy, and it is
-- enforced by triggers. Triggers rather than policies because the client payment
-- state lives inside orders.workflow JSONB, which a row policy cannot inspect
-- per-field, and because the same rule has to hold for three different tables.
--
-- NOTE: the flag is seeded onto vivek@resolute.com, which is a placeholder
-- address. When the real @resolutetitleservices.com mailboxes land, re-point it:
--   update public.profiles set can_confirm_payments = (email = '<real address>');
-- =====================================================================

alter table public.profiles
  add column if not exists can_confirm_payments boolean not null default false;

comment on column public.profiles.can_confirm_payments is
  'Whether this account may confirm client payments and mark vendor payouts and subscriptions paid. Held by the billing owner only (CLAUDE.md).';

update public.profiles set can_confirm_payments = true where lower(email) = 'vivek@resolute.com';

-- Does the caller hold the capability? The service role always does: it is what
-- api/admin/users.js and the notification drain run as. A null auth.uid() means
-- there is no end user at all (psql, seeding, a migration), which must not be
-- blocked either.
create or replace function public.can_confirm_payments()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true) = 'service_role'
    or auth.uid() is null
    or (select p.can_confirm_payments from public.profiles p where p.id = auth.uid()),
    false)
$$;

revoke execute on function public.can_confirm_payments() from anon;

-- ── Vendor payouts: only the billing owner may mark one paid ────────────────
create or replace function public.guard_payout_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'paid'
     and (tg_op = 'INSERT' or old.status is distinct from 'paid')
     and not public.can_confirm_payments() then
    raise exception 'only the billing owner may mark a vendor payout paid';
  end if;
  return new;
end $$;

drop trigger if exists vendor_payouts_guard_paid on public.vendor_payouts;
create trigger vendor_payouts_guard_paid
  before insert or update on public.vendor_payouts
  for each row execute function public.guard_payout_paid();

-- ── Subscriptions: same rule ───────────────────────────────────────────────
create or replace function public.guard_subscription_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.last_paid_at is distinct from (case when tg_op = 'INSERT' then null else old.last_paid_at end)
      or new.paid_by is distinct from (case when tg_op = 'INSERT' then null else old.paid_by end))
     and (new.last_paid_at is not null or new.paid_by is not null)
     and not public.can_confirm_payments() then
    raise exception 'only the billing owner may mark a subscription paid';
  end if;
  return new;
end $$;

drop trigger if exists subscriptions_guard_paid on public.subscriptions;
create trigger subscriptions_guard_paid
  before insert or update on public.subscriptions
  for each row execute function public.guard_subscription_paid();

-- ── Client payments: marking is open, CONFIRMING is not ────────────────────
-- 'marked' is the client saying "I have sent it" (the check-upload step, which
-- must never read as paid). 'confirmed' and 'bounced' are reconciliation against
-- the bank, and belong to the billing owner alone.
create or replace function public.guard_payment_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_status text := old.workflow -> 'payment' ->> 'status';
  new_status text := new.workflow -> 'payment' ->> 'status';
begin
  if new_status is distinct from old_status
     and new_status in ('confirmed', 'bounced')
     and not public.can_confirm_payments() then
    raise exception 'only the billing owner may confirm or bounce a client payment';
  end if;
  return new;
end $$;

drop trigger if exists orders_guard_payment_confirmation on public.orders;
create trigger orders_guard_payment_confirmation
  before update on public.orders
  for each row execute function public.guard_payment_confirmation();
