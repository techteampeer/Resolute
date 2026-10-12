-- =====================================================================
-- E2 (follow-up) — re-create guard_order_handoff() in a DASHBOARD-SAFE form.
-- =====================================================================
-- Identical in behaviour to 20261012000000. The only change: the two
-- "next stage due" lookups no longer use `select … into v_next/v_after`.
--
-- Why: the Supabase SQL editor has an "auto-enable RLS on new tables" helper
-- that naively scans pasted SQL for table creation. `SELECT … INTO <name>` is
-- CREATE-TABLE-AS in top-level SQL, so the editor mistook the PL/pgSQL locals
-- `v_next` / `v_after` for new tables and injected
-- `ALTER TABLE v_next ENABLE ROW LEVEL SECURITY;` INTO the middle of the function
-- body — which breaks the $$-quoted string ("unterminated dollar-quoted string").
-- The CLI / CI apply the original fine; this only bit a human pasting it into the
-- dashboard. Assigning each local from a scalar subquery (`v_next := (select …)`)
-- removes the `INTO` token the helper trips on, so the function pastes cleanly.
--
-- `create or replace`, idempotent, safe to re-run. No RLS, data or behaviour
-- change — this supersedes the previous definition with byte-identical logic.
-- =====================================================================

create or replace function public.guard_order_handoff()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_seq        text[] := array['screener', 'examiner', 'typer', 'delivery'];
  v_old        jsonb  := coalesce(old.completed_dates, '{}'::jsonb);
  v_new        jsonb  := coalesce(new.completed_dates, '{}'::jsonb);
  v_stamped    boolean := (coalesce(new.completed_dates, '{}'::jsonb)
                           is distinct from coalesce(old.completed_dates, '{}'::jsonb));
  v_single     boolean := coalesce(old.workflow ->> 'singleSeating', 'false') = 'true';
  v_plan       jsonb  := old.workflow -> 'stagePlan';
  v_has_plan   boolean := v_plan is not null
                          and jsonb_typeof(v_plan) = 'object'
                          and v_plan <> '{}'::jsonb;
  v_next       text;   -- next stage due on the STORED row (nextRoleFor of old)
  v_after      text;   -- next stage due on the NEW row  (nextRoleFor of new)
  v_expected   text;   -- the status derived from v_after (statusForRole)
  v_plan_owner uuid;   -- the plan's owner for the stage the NEW row now awaits
  k            text;
begin
  -- Only guard direct end-user REST writes; RPCs (owner), service role and
  -- migrations/seed are trusted and pass through.
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Admins may reassign/route/plan freely; their writes use orders_write_admin.
  if public.is_admin() then
    return new;
  end if;

  -- From here: a non-admin production user updating an order they own in the pool.

  -- Next stage due on the stored row and on the proposed row, computed up front
  -- so the routing and status rules below can lean on them. (Scalar-subquery
  -- assignment, not `select … into`, so the Supabase dashboard does not mistake
  -- these locals for new tables — see the migration header.)
  v_next := (
    select s from unnest(v_seq) with ordinality as t(s, ord)
     where v_old ->> s is null order by ord limit 1);
  v_after := (
    select s from unnest(v_seq) with ordinality as t(s, ord)
     where v_new ->> s is null order by ord limit 1);
  -- The person the admin pre-assigned to the stage the order is about to await.
  v_plan_owner := case when v_has_plan then nullif(v_plan ->> v_after, '')::uuid end;

  -- 1. An order can never be moved to another client.
  if new.client_code is distinct from old.client_code then
    raise exception 'an order cannot be reassigned to a different client';
  end if;

  -- 1a. The stage plan and the single-seating flag are the ADMIN's decision
  --     only. A non-admin can neither set, change nor clear either — this is
  --     what makes the routing below unforgeable (a user cannot rewrite the
  --     plan to send the order to a friend, nor flip singleSeating to dodge a
  --     gate).
  if (new.workflow -> 'stagePlan') is distinct from (old.workflow -> 'stagePlan') then
    raise exception 'the stage plan is set by Admin and cannot be changed by a production user';
  end if;
  if coalesce(new.workflow ->> 'singleSeating', 'false')
     is distinct from coalesce(old.workflow ->> 'singleSeating', 'false') then
    raise exception 'single-seating is set by Admin and cannot be changed by a production user';
  end if;

  -- 1b. Ownership may never move to a user of the production worker's choosing.
  --     It may only: stay the same (in-seat / mid-stage save), be cleared (null,
  --     on delivery completion), or — when a plan exists AND the current stage
  --     is being completed — pass to the plan's pre-assigned NEXT-stage owner.
  --     Any other change of owner (an arbitrary user, or the right user without
  --     completing the stage) is refused. This is the anti-bias rule: a stage
  --     cannot pick who works the order next.
  if new.assigned_user_id is distinct from old.assigned_user_id
     and new.assigned_user_id is not null then
    if not (v_has_plan and v_stamped
            and new.assigned_user_id is not distinct from v_plan_owner) then
      raise exception
        'a production user cannot choose who gets the order next — it flows to the pre-assigned owner (or back to Admin)';
    end if;
  end if;

  -- 2. Legitimate assigned_to targets only: stays in the production pool
  --    ('user', unchanged — the normal routed flow), back to Admin ('admin',
  --    the escalation / query path), or cleared (null, delivery completion).
  --    Handing directly to any other live desk role is refused.
  if new.assigned_to is not null
     and new.assigned_to <> 'admin'
     and new.assigned_to is distinct from old.assigned_to then
    raise exception
      'a stage cannot route an order to another desk role directly (assigned_to must stay user, go to admin, or clear)';
  end if;

  -- 3. The pipeline advances ONE stage at a time, in order. completed_dates may
  --    gain at most the single NEXT-stage date and must never lose or rewrite an
  --    earlier one.
  if v_stamped then
    -- No earlier stage date may be cleared or changed.
    for k in select jsonb_object_keys(v_old) loop
      if not (v_new ? k) or (v_new ->> k) is distinct from (v_old ->> k) then
        raise exception 'a completed stage date cannot be changed or cleared';
      end if;
    end loop;
    -- Any newly added date must be exactly the next stage due.
    for k in select jsonb_object_keys(v_new) loop
      if not (v_old ? k) and k is distinct from v_next then
        raise exception
          'stages complete in order — only the current stage (%) may be stamped', coalesce(v_next, 'none');
      end if;
    end loop;
    -- Stamping a stage completes it. Where it must go next depends on the plan:
    --   • delivery (final): terminal completion — desk cleared (checked in 4).
    --   • a plan exists, next stage HAS an owner: route in-pool to that owner
    --     (assigned_to stays 'user', assigned_user_id = the planned owner). When
    --     the same person owns consecutive stages this is a same-owner in-seat
    --     advance; otherwise it is the automatic handoff to the next person. No
    --     Admin gate.
    --   • a plan exists but the next stage has NO owner: park with Admin, who
    --     assigns it — the order cannot sit in the pool ownerless.
    --   • no plan, legacy SINGLE-SEATING owner staying in-seat: allowed, no gate
    --     (the A1 bypass, preserved for orders created before plans existed).
    --   • no plan, otherwise: return to Admin for approval (the A1 every-stage
    --     gate, unchanged).
    if v_next is not null and (v_new ? v_next) and not (v_old ? v_next) then
      -- The stamp must be a real ISO date (YYYY-MM-DD), not '' or arbitrary text.
      if (v_new ->> v_next) !~ '^\d{4}-\d{2}-\d{2}' then
        raise exception 'a stage completion date must be a valid date (got %)', coalesce(v_new ->> v_next, 'null');
      end if;
      if v_next = 'delivery' then
        if new.assigned_to is not null then
          raise exception 'completing delivery clears the desk (assigned_to must be null)';
        end if;
      elsif v_has_plan then
        if v_plan_owner is not null then
          if not (new.assigned_to = 'user'::public.user_role
                  and new.assigned_user_id is not distinct from v_plan_owner) then
            raise exception
              'completing the % stage routes the order to the pre-assigned % owner (assigned_to must stay user)', v_next, v_after;
          end if;
        elsif new.assigned_to is distinct from 'admin' then
          raise exception
            'no production user is assigned to the % stage — the order returns to Admin', v_after;
        end if;
      elsif v_single
            and new.assigned_to = 'user'::public.user_role
            and new.assigned_user_id is not distinct from old.assigned_user_id then
        -- legacy single-seating in-seat advance: allowed, no Admin gate.
        null;
      elsif new.assigned_to is distinct from 'admin' then
        raise exception
          'completing the % stage returns the order to Admin for approval (assigned_to must be admin)', v_next;
      end if;
    end if;
  end if;

  -- 4. Clearing the desk (assigned_to => null) is the delivery-completion
  --    transition and nothing else for a production user.
  if new.assigned_to is null and old.assigned_to is not null then
    if new.status is distinct from 'delivered' then
      raise exception
        'clearing an order''s desk is only valid on delivery completion (status must be delivered)';
    end if;
    if v_new ->> 'delivery' is null then
      raise exception 'delivery completion must stamp the delivery date in completed_dates';
    end if;
  end if;

  -- 5. Status is DERIVED from the pipeline position (statusForRole · nextRoleFor),
  --    never set freely. It must equal the status of the stage the NEW row is
  --    waiting on; `completed` is set only once delivered.
  v_expected := case v_after
    when 'screener' then 'screening'
    when 'examiner' then 'examining'
    when 'typer'    then 'typing'
    when 'delivery' then 'delivery'
    else 'delivered'                       -- all four stamped
  end;
  if new.status::text is distinct from v_expected then
    raise exception 'order status is derived from the pipeline (expected %, got %)', v_expected, new.status;
  end if;
  if new.completed is not null and new.status::text is distinct from 'delivered' then
    raise exception 'completed is set only on delivery';
  end if;

  return new;
end $$;

revoke execute on function public.guard_order_handoff() from public, anon, authenticated;
