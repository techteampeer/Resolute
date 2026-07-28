-- Per-message file attachments (Qualia-style order Inbox). A message may carry a
-- single document ref { name, type, path } stored in the existing documents
-- bucket (client uploads to their own order path are already allowed by
-- documents_client_insert; staff by documents_staff_all). No RLS change needed
-- — the attachment travels on the message row, which is already RLS-scoped.
alter table public.support_messages
  add column if not exists attachment jsonb;
