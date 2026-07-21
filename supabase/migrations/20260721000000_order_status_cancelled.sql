-- BUG_003: clients can cancel an order (free while still queued, otherwise a
-- request Admin approves). A cancelled order needs its own terminal status so
-- it drops out of the role queues and the Active count. Extend the enum.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block that later
-- uses the new value, so it stands alone here (idempotent via IF NOT EXISTS).
alter type order_status add value if not exists 'cancelled';
