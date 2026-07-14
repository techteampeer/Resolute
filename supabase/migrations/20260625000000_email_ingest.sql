-- Email-to-order ingest: idempotency ledger + human review queue.
-- Idempotent; safe to run on top of the init migration.

-- Processed-message ledger. One row per inbound Message-ID we have handled,
-- so re-runs / provider retries never create duplicate orders.
create table if not exists public.email_ingest_log (
  message_id    text primary key,          -- RFC 822 Message-ID (dedup key)
  sender        text,
  subject       text,
  status        text not null,             -- created | queued | skipped
  order_id      text references public.orders(id),
  review_reason text,
  processed_at  timestamptz not null default now()
);
create index if not exists email_ingest_log_status_idx on public.email_ingest_log(status);

-- Human review queue. Low-confidence / unmatched messages land here with the
-- LLM's best-guess parse + attachment refs, for staff to confirm before an
-- order is created. NEVER auto-create on low confidence.
create table if not exists public.email_review_queue (
  id            bigint generated always as identity primary key,
  message_id    text unique references public.email_ingest_log(message_id),
  sender        text,
  subject       text,
  client_code   text references public.clients(code),  -- null when sender unmatched
  parsed        jsonb not null default '{}'::jsonb,     -- validated extraction result
  attachments   jsonb not null default '[]'::jsonb,     -- [{ path, url, filename }]
  review_reason text,
  resolved      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists email_review_queue_resolved_idx on public.email_review_queue(resolved);

-- RLS: these tables are written only by the ingest service (service-role key,
-- which bypasses RLS). Enable RLS and allow staff to read/triage the queue.
alter table public.email_ingest_log   enable row level security;
alter table public.email_review_queue enable row level security;

drop policy if exists email_ingest_log_staff on public.email_ingest_log;
create policy email_ingest_log_staff on public.email_ingest_log
  for select using (public.is_staff());

drop policy if exists email_review_queue_staff on public.email_review_queue;
create policy email_review_queue_staff on public.email_review_queue
  for all using (public.is_staff()) with check (public.is_staff());
