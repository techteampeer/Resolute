-- =====================================================================
-- QC stage — optional Quality Check between typer and delivery.
-- =====================================================================
-- 1. Add the 'qc' order status.
-- 2. Re-create guard_order_handoff() so it:
--    - builds the stage sequence DYNAMICALLY, inserting 'qc' only when the
--      order's plan assigns a QC owner — so a QC-less order still routes
--      typer -> delivery unchanged (QC is optional / skippable, it does NOT
--      park with Admin);
--    - derives the 'qc' status;
--    - PERMITS the QC rejection (the qc reviewer returns the order to the
--      plan's typer, clearing the typer+qc stamps) — the forward-only rule
--      would otherwise block it. Tightly shaped so it cannot change the plan
--      or pick an arbitrary owner.
--
-- Mirrors stageSequence()/applyQcReject() in packages/domain exactly, so the
-- client and the guard agree on where every completed stage routes next.
--
-- Dashboard-safe: no `SELECT … INTO` (scalar-subquery assignment only), ASCII,
-- create-or-replace, idempotent. Supersedes 20261012010000 with the same logic
-- plus the qc handling.
-- =====================================================================

alter type public.order_status add value if not exists 'qc';

create or replace function public.guard_order_handoff()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_old        jsonb  := coalesce(old.completed_dates, '{}'::jsonb);
  v_new        jsonb  := coalesce(new.completed_dates, '{}'::jsonb);
  v_stamped    boolean := (coalesce(new.completed_dates, '{}'::jsonb)
                           is distinct from coalesce(old.completed_dates, '{}'::jsonb));
  v_single     boolean := coalesce(old.workflow ->> 'singleSeating', 'false') = 'true';
  v_plan       jsonb  := old.workflow -> 'stagePlan';
  v_has_plan   boolean := v_plan is not null
                          and jsonb_typeof(v_plan) = 'object'
                          and v_plan <> '{}'::jsonb;
  v_seq        text[];  -- the order's EFFECTIVE sequence (qc present only when assigned)
  v_next       text;    -- next stage due on the STORED row
  v_after      text;    -- next stage due on the NEW row
  v_expected   text;    -- the status derived from v_after
  v_plan_owner uuid;    -- the plan's owner for the stage the NEW row now awaits
  k            text;
begin
  -- Only guard direct end-user REST writes; RPCs, service role and migrations pass through.
  if current_user <> 'authenticated' then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;

  -- From here: a non-admin production user updating an order they own in the pool.

  -- QC REJECTION (corrections required). The QC reviewer returns the order to the
  -- plan's TYPER owner for re-work. Permitted ONLY in this exact shape, so it can
  -- neither change the plan nor pick an arbitrary owner:
  --   * the order is at the qc stage (typer stamped, qc not, and qc has an owner),
  --   * the acting owner is the qc owner,
  --   * it routes to the plan's OWN typer owner with status 'typing',
  --   * it clears exactly the qc + typer stamps, touching no earlier stage,
  --   * client, plan and single-seating are unchanged, and completed stays null.
  if v_has_plan
     and new.client_code is not distinct from old.client_code
     and (new.workflow -> 'stagePlan') is not distinct from (old.workflow -> 'stagePlan')
     and coalesce(new.workflow ->> 'singleSeating', 'false')
         is not distinct from coalesce(old.workflow ->> 'singleSeating', 'false')
     and (v_old ->> 'typer') is not null
     and (v_old ->> 'qc') is null
     and nullif(v_plan ->> 'qc', '') is not null
     and old.assigned_user_id is not distinct from nullif(v_plan ->> 'qc', '')::uuid
     and new.status::text = 'typing'
     and new.assigned_to = 'user'::public.user_role
     and new.assigned_user_id is not distinct from nullif(v_plan ->> 'typer', '')::uuid
     and (v_new ->> 'typer') is null
     and (v_new ->> 'qc') is null
     and (v_new - 'qc' - 'typer') is not distinct from (v_old - 'qc' - 'typer')
     and new.completed is null
  then
    return new;
  end if;

  -- The order's EFFECTIVE stage sequence. QC is OPTIONAL: it belongs to the flow
  -- only when the plan assigns a QC owner; otherwise the order skips from typer
  -- straight to delivery. Mirrors stageSequence() in packages/domain.
  v_seq := case
    when nullif(v_plan ->> 'qc', '') is not null
      then array['screener', 'examiner', 'typer', 'qc', 'delivery']
    else array['screener', 'examiner', 'typer', 'delivery']
  end;

  v_next := (
    select s from unnest(v_seq) with ordinality as t(s, ord)
     where v_old ->> s is null order by ord limit 1);
  v_after := (
    select s from unnest(v_seq) with ordinality as t(s, ord)
     where v_new ->> s is null order by ord limit 1);
  v_plan_owner := case when v_has_plan then nullif(v_plan ->> v_after, '')::uuid end;

  -- 1. An order can never be moved to another client.
  if new.client_code is distinct from old.client_code then
    raise exception 'an order cannot be reassigned to a different client';
  end if;

  -- 1a. The stage plan and the single-seating flag are the ADMIN's decision only.
  if (new.workflow -> 'stagePlan') is distinct from (old.workflow -> 'stagePlan') then
    raise exception 'the stage plan is set by Admin and cannot be changed by a production user';
  end if;
  if coalesce(new.workflow ->> 'singleSeating', 'false')
     is distinct from coalesce(old.workflow ->> 'singleSeating', 'false') then
    raise exception 'single-seating is set by Admin and cannot be changed by a production user';
  end if;

  -- 1b. Ownership may never move to a user of the production worker's choosing.
  if new.assigned_user_id is distinct from old.assigned_user_id
     and new.assigned_user_id is not null then
    if not (v_has_plan and v_stamped
            and new.assigned_user_id is not distinct from v_plan_owner) then
      raise exception
        'a production user cannot choose who gets the order next — it flows to the pre-assigned owner (or back to Admin)';
    end if;
  end if;

  -- 2. Legitimate assigned_to targets only: stays 'user', goes to 'admin', or clears.
  if new.assigned_to is not null
     and new.assigned_to <> 'admin'
     and new.assigned_to is distinct from old.assigned_to then
    raise exception
      'a stage cannot route an order to another desk role directly (assigned_to must stay user, go to admin, or clear)';
  end if;

  -- 3. The pipeline advances ONE stage at a time, in order.
  if v_stamped then
    for k in select jsonb_object_keys(v_old) loop
      if not (v_new ? k) or (v_new ->> k) is distinct from (v_old ->> k) then
        raise exception 'a completed stage date cannot be changed or cleared';
      end if;
    end loop;
    for k in select jsonb_object_keys(v_new) loop
      if not (v_old ? k) and k is distinct from v_next then
        raise exception
          'stages complete in order — only the current stage (%) may be stamped', coalesce(v_next, 'none');
      end if;
    end loop;
    if v_next is not null and (v_new ? v_next) and not (v_old ? v_next) then
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
        null;
      elsif new.assigned_to is distinct from 'admin' then
        raise exception
          'completing the % stage returns the order to Admin for approval (assigned_to must be admin)', v_next;
      end if;
    end if;
  end if;

  -- 4. Clearing the desk => null is the delivery-completion transition and nothing else.
  if new.assigned_to is null and old.assigned_to is not null then
    if new.status is distinct from 'delivered' then
      raise exception
        'clearing an order''s desk is only valid on delivery completion (status must be delivered)';
    end if;
    if v_new ->> 'delivery' is null then
      raise exception 'delivery completion must stamp the delivery date in completed_dates';
    end if;
  end if;

  -- 5. Status is DERIVED from the pipeline position (statusForRole · nextRoleFor).
  v_expected := case v_after
    when 'screener' then 'screening'
    when 'examiner' then 'examining'
    when 'typer'    then 'typing'
    when 'qc'       then 'qc'
    when 'delivery' then 'delivery'
    else 'delivered'
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
