-- Email-intake idempotency.
--
-- POST /api/orders/email-intake records the source message id at
-- workflow.intake.messageId. Google Apps Script retries, and so does the
-- network, so the same email can be POSTed more than once. The API checks for
-- an existing order first, but a check followed by an insert is a race: two
-- simultaneous retries can both pass the check. This index closes it — exactly
-- one insert wins and the loser gets 23505, which the API turns back into
-- "here is the order that already exists".
--
-- Partial by design. Website- and admin-placed orders never set
-- workflow.intake.messageId, so they are not in the index at all and the
-- existing Place Order flow is completely unaffected. Nothing else about the
-- orders table changes: no new column, no new table, no policy change.
--
-- Idempotent.
create unique index if not exists orders_intake_message_id_uidx
  on public.orders ((workflow -> 'intake' ->> 'messageId'))
  where workflow -> 'intake' ->> 'messageId' is not null;
