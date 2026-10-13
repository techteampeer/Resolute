-- =====================================================================
-- Make notification_types.default_roles say who a type can reach
-- =====================================================================
-- The new per-user Notifications screen has to answer one question for the
-- signed-in person: which kinds of mail can ever reach me? The only column that
-- could answer it was default_roles, and order.assigned carried '{}' — its
-- audience is decided per event by notify_on_order_event(), which parses the
-- target desk out of the event action and passes it as p_roles. Left as '{}',
-- the one notification a screener, examiner, typer, delivery or Single Seating
-- account actually receives would not have appeared on their own settings page,
-- and hardcoding the five role keys into the UI instead would have put the
-- routing rules in two places.
--
-- So default_roles now means "the roles this type can reach", and dynamic
-- routing narrows it: enqueue_notification() takes v_roles := coalesce(p_roles,
-- default_roles), so the classifier still fans an assignment out to exactly the
-- one desk that received the work. The only path that raises order.assigned is
-- that classifier, and it returns early when it cannot parse a target, so the
-- wider list is never used as an audience.
update public.notification_types
set default_roles = '{screener,examiner,typer,delivery,operator}'::user_role[]
where key = 'order.assigned';

comment on column public.notification_types.default_roles is
  'Roles this type can reach, and the audience used when a caller does not pass '
  'p_roles. A dynamically routed type (order.assigned) lists every role that '
  'could receive it; enqueue_notification narrows it per event.';

comment on column public.notification_types.default_mode is
  'Delivery mode for a recipient with no row in notification_preferences: '
  'immediate, digest, or off.';
