-- =====================================================================
-- F3 — server-side validation of money amounts.
-- =====================================================================
-- Invoice and payout amounts are authored in the browser and written into
-- orders.workflow (a JSONB blob) and the vendor_payouts / subscriptions tables.
-- The confirm-payment guard (20260908010000) gates WHO can confirm and the
-- status transition, but nothing validated the NUMBERS themselves: a typo, or a
-- tampered request, could write any amount.
--
-- Pricing in this business is a human quote (Admin can set a custom price, the
-- typer stamps the final invoice), so the server cannot force an exact figure.
-- What it CAN enforce, and does here, is that every stored amount is a real,
-- non-negative number within a sane ceiling — catching fat-finger errors and
-- absurd tampering without breaking legitimate custom quotes. It also stands up
-- a server-side price catalogue (public.product_prices) as the authoritative
-- reference the UI can migrate onto (today the UI reads a JS constant).
--
-- Idempotent. Safe to re-run.
-- =====================================================================

-- ── Bounds guard on order amounts (invoice + abstractor fee, in workflow) ────
-- A pure numeric sanity check, so it needs no role logic. Two deliberate
-- choices, both from review:
--   * The bound is on MAGNITUDE (|amount| <= ceiling), not sign: the typer's
--     Finalize can produce a negative invoice via a credit/discount line, and
--     that is legitimate — the guard only rejects non-numbers and absurd values.
--   * It validates ONLY when the amount actually changes (or on INSERT). Without
--     this, an unrelated UPDATE (a status change, a cancel request) would
--     re-validate a pre-existing/legacy amount and could brick the row forever.
-- The ceiling mirrors AMOUNT_LIMIT in packages/domain/src/money.ts — keep the two
-- in step.
create or replace function public.guard_order_amounts()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  inv     text := new.workflow ->> 'invoiceAmount';
  old_inv text := case when tg_op = 'UPDATE' then old.workflow ->> 'invoiceAmount' end;
  fee     text := new.workflow -> 'abstractorFee' ->> 'amount';
  old_fee text := case when tg_op = 'UPDATE' then old.workflow -> 'abstractorFee' ->> 'amount' end;
  n       numeric;
begin
  if inv is not null and inv <> '' and (tg_op = 'INSERT' or inv is distinct from old_inv) then
    begin n := inv::numeric; exception when others then
      raise exception 'invoiceAmount must be a number (got %)', inv; end;
    if abs(n) > 1000000 then
      raise exception 'invoiceAmount out of range (magnitude <= 1,000,000): %', n; end if;
  end if;
  if fee is not null and fee <> '' and (tg_op = 'INSERT' or fee is distinct from old_fee) then
    begin n := fee::numeric; exception when others then
      raise exception 'abstractorFee.amount must be a number (got %)', fee; end;
    if abs(n) > 1000000 then
      raise exception 'abstractorFee.amount out of range (magnitude <= 1,000,000): %', n; end if;
  end if;
  return new;
end $$;

drop trigger if exists orders_guard_amounts on public.orders;
create trigger orders_guard_amounts
  before insert or update on public.orders
  for each row execute function public.guard_order_amounts();

revoke execute on function public.guard_order_amounts() from public, anon, authenticated;

-- ── Ceiling on the ledger tables (they already enforce amount >= 0) ─────────
-- NOT VALID: enforce on new/changed rows only, never scan existing data — a
-- single legacy row over the ceiling must not abort this whole migration.
do $$ begin
  alter table public.vendor_payouts add constraint vendor_payouts_amount_ceiling check (amount <= 1000000) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.subscriptions add constraint subscriptions_amount_ceiling check (amount <= 1000000) not valid;
exception when duplicate_object then null; end $$;

-- ── Server-side price catalogue (authoritative reference) ────────────────────
-- Mirrors src/data/products.js. The DB is the source of truth going forward; the
-- UI should migrate to reading this instead of the JS constant (roadmap C/E).
create table if not exists public.product_prices (
  type       text primary key,
  price      numeric(10,2) not null check (price >= 0 and price <= 1000000),
  updated_at timestamptz not null default now()
);

alter table public.product_prices enable row level security;

-- Prices are shown to clients on the order form, so any signed-in user may read;
-- only super admins may change the catalogue.
drop policy if exists product_prices_read on public.product_prices;
create policy product_prices_read on public.product_prices for select
  using (auth.uid() is not null);

drop policy if exists product_prices_write on public.product_prices;
create policy product_prices_write on public.product_prices for all
  using (public.is_super_admin()) with check (public.is_super_admin());

-- Seed / refresh from the catalogue (fixed-price products only; quote-only
-- products intentionally carry no row).
insert into public.product_prices (type, price) values
  ('Current Owner Search', 75),
  ('Two Owner Search', 100),
  ('Full Search', 150),
  ('Update / Bringdown', 45),
  ('Commercial Search', 250),
  ('Energy / Infrastructure', 350),
  ('Two-Owner', 100),
  ('Current Owner', 75),
  ('Lien Search', 110),
  ('Tax Certificate', 95),
  ('HOA Estoppel', 120)
on conflict (type) do update set price = excluded.price, updated_at = now();
