# Notifications

The whole cycle: an event happens → the database fans it out to one outbox row
per recipient → a sender drains the outbox and mails it.

```
order_events / support_messages          (app writes these already)
        │  trigger
        ▼
enqueue_notification()                   role + per-user preference → recipients
        │
        ▼
notification_outbox                      one row per recipient, deduped
        │  claim_notifications()
        ▼
runNotifications({ mode })               render → provider.send → mark
```

Nothing in `services/notify/` knows where it runs. That is the point: the
Vercel→AWS move replaces the caller, not the code.

## Running it

```bash
node scripts/preview-notifications.mjs   # render samples to preview/, sends nothing
node scripts/send-notifications.mjs immediate
node scripts/send-notifications.mjs digest
```

`preview-notifications.mjs` needs no credentials at all — it exists so the
templates can be reviewed before SES or DNS are ready.

## Environment

| Variable | Needed by | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | the drain | Same project the app uses |
| `SUPABASE_SERVICE_ROLE_KEY` | the drain | **Server only.** The outbox has RLS on with no policies; nothing else can read it |
| `PORTAL_URL` | templates | Base for deep links, e.g. `https://portal.resolutetitleservices.com` |
| `NOTIFY_PROVIDER` | sending | `preview` (default), `console`, or `ses` |
| `NOTIFY_FROM` | SES | `Resolute Portal <notifications@resolutetitleservices.com>` |
| `NOTIFY_REPLY_TO` | SES | Optional. Without it, replies go to a mailbox nobody reads |
| `SES_REGION` | SES | Must match the region the SES identity was verified in |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | SES | On Lambda these are injected from the role — nothing to set |
| `SES_CONFIGURATION_SET` | SES | Optional, for bounce/complaint tracking |

The default is `preview` on purpose. An unconfigured deploy writes files instead
of mailing real colleagues.

## Who chooses what

Two layers, and the order matters:

- **`notification_types`** is the catalogue. `default_roles` says which roles a
  type can reach; `default_mode` (`immediate` / `digest` / `off`) is what a
  recipient gets when they have expressed no preference.
- **`notification_preferences`** holds one row per person per type, and *only*
  when that person has chosen something. No row means "follow the default", so
  changing a default moves everyone who never chose.

`enqueue_notification()` reads `coalesce(np.mode, default_mode)` and skips
anyone whose effective mode is `off`, so a preference decides delivery before an
outbox row is ever written.

Staff set their own under **Notifications** in their portal
(`src/components/NotificationSettings.jsx`, mounted at `/<role>/notifications`
in all six staff portals). RLS is per-user: `notif_pref_own_*` keys on
`auth.uid()`, so nobody — super admins included — can write another person's
row; admins may only read them. Clients never appear: client contact is
portal-only, so no client account is ever a recipient.

A dynamically routed type lists every role that could receive it in
`default_roles` and is narrowed per event by the caller's `p_roles`
(`order.assigned` is the one that does this). That keeps the settings screen
able to ask one question — "what can reach me?" — without restating the routing
rules in the UI.

## Adding an event type

1. Insert a row in `notification_types` (key, label, `default_roles`,
   `default_mode`) — this decides *who* and *how often*, and makes the type
   appear on the Notifications screen of every role in `default_roles`.
2. Add a matching entry to `TYPES` in `types.js` — this decides *how it reads*.
3. Raise it: either extend the classifier in `notify_on_order_event()`, or call
   `enqueue_notification()` directly from a new trigger.

Routing lives in the database and wording lives in code, so changing who gets
notified never needs a deploy and changing a subject line never needs a
migration.

## Rules this respects

- **Client identity masking.** `recipient_role` rides on every outbox row, and
  templates show client *names* only to admins — everyone else sees the code,
  same as `displayClient` in the app.
- **Nobody is notified about their own action.** `order_events.actor_email` is
  excluded during fan-out.
- **Internal notes are not client contact.** The `support_messages` trigger
  fires only for `sender = 'client'`.
- **The outbox is unreachable from a browser.** RLS on, zero policies, and
  `revoke all` from `anon` and `authenticated`.

## Failure behaviour

A send error returns the row to `pending` and increments `attempts`. After five
attempts it becomes `failed`, stops being claimed, and keeps `last_error`. A
message is never dropped silently — it ends up `sent` or `failed`.

`claim_notifications()` moves rows to `sending` as it claims them. `for update
skip locked` alone would not be enough: it only holds rows for the life of the
transaction, so once the claim committed an overlapping run would see them as
pending and send them twice. Rows left in `sending` for over 15 minutes are
reclaimed, which covers a run that died mid-drain.

The unique `dedupe_key` stops a replayed trigger enqueueing twice. `order.new`
and `order.delivered` key on the *order* rather than the event, because placing
an order writes two `type='new'` rows — one from `log_order_created()` in the
database, one from `OrderContext`. Both belong in the audit trail; they are one
piece of news.

Digest rows are marked sent only after the roll-up that covered them goes out —
otherwise tomorrow's digest repeats today's news.
