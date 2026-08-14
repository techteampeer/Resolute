-- Email teardown.
--
-- Both halves of the email system have been removed from the app — outbound
-- notifications and the inbound email→order ingest — so the tables that only
-- served the ingest go with them. The feature will be rebuilt from scratch.
--
-- Deliberately NOT touched:
--   • order_events.audience — added for notification routing, but it also
--     gates order_events_client_read. Dropping it would hide every client's
--     own order history from them again.
--   • support_messages and its policies — portal messaging is the client
--     communication channel and is unrelated to email.
--
-- Idempotent.

-- email_review_queue references email_ingest_log, so it goes first.
drop table if exists public.email_review_queue;
drop table if exists public.email_ingest_log;
