-- =====================================================================
-- A1 + A2 — owner-scoped order writes and the single-seating bypass.
-- =====================================================================
-- Builds on F1 (orders.assigned_user_id). Two coupled changes:
--
-- A2 (RLS) — a production user may now update only orders in the pool that are
--   assigned to THEM (assigned_user_id = auth.uid()), not any pooled order.
--   Admin still assigns/reassigns freely (orders_write_admin).
--
-- A1 (guard) — single-seating is honoured: the OWNER of a single-seated order may
--   advance it through consecutive stages IN-SEAT, with no return-to-Admin
--   between stages. Approval re-enters only when work changes hands (a partial
--   handoff sets assigned_to='admin' — the existing legitimate target — carrying
--   an internal note in workflow.handoff). For a NON-single-seated order the
--   every-stage Admin gate is unchanged.
--
-- Everything else in guard_order_handoff is byte-for-byte the 20260924000000
-- (D3) version. Deliberately UNCHANGED / never weakened:
--   • cross-client moves refused;
--   • ordered one-stage-at-a-time stamping (no back-fill, skips, junk dates, or
--     clearing an earlier date);
--   • delivery-completion is the only desk-clear, and must stamp delivery;
--   • status is derived from the pipeline; completed only when delivered;
--   • admin / service / migration writes still short-circuit;
--   • the Vivek-only money controls and the client-reply split are untouched.
--
-- NEW guard rule (A2 companion): a non-admin user can never reassign an order to
--   a DIFFERENT user directly — assigned_user_id may only stay the same or be
--   cleared (a real reassignment goes back to Admin, who is short-circuited).
--
-- NOTE: existing pooled orders carry assigned_user_id = null after F1, so no user
--   can act on them until an Admin assigns an owner — the intended admin-directed
--   model. The D3-migrated in-flight orders therefore need an owner set by Admin
--   (or a data backfill) before a user picks them up.
--
-- Idempotent. Safe to re-run.
-- =====================================================================

-- ── A2: owner-scoped update policy ───────────────────────────────────────────
-- USING is evaluated on the STORED row: a production user may target only an
-- order in the pool that is theirs. WITH CHECK stays is_staff() (as before):
-- legitimate handoffs move assigned_to/assigned_user_id away from the owner, so a
-- strict new-row owner test would break every handoff — guard_order_handoff()
-- constrains the shape of the write.
drop policy if exists orders_update_assigned on public.orders;
create policy orders_update_assigned on public.orders for update
  using (
    public.can_work_production()
    and assigned_to = 'user'::public.user_role
    and assigned_user_id = auth.uid()
  )
  with check (public.is_staff());

-- ── A1: single-seating bypass in the handoff guard ───────────────────────────
create or replace function public.guard_order_handoff()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_seq      text[] := array['screener', 'examiner', 'typer', 'delivery'];
  v_old      jsonb  := coalesce(old.completed_dates, '{}'::jsonb);
  v_new      jsonb  := coalesce(new.completed_dates, '{}'::jsonb);
  v_single   boolean := coalesce(old.workflow ->> 'singleSeating', 'false') = 'true';
  v_next     text;   -- next stage due on the STORED row (nextRoleFor of old)
  v_after    text;   -- next stage due on the NEW row (nextRoleFor of new)
  v_expected text;   -- the status derived from v_after (statusForRole)
  k          text;
begin
  -- Only guard direct end-user REST writes; RPCs (owner), service role and
  -- migrations/seed are trusted and pass through.
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Admins may reassign/route freely; their writes use orders_write_admin.
  if public.is_admin() then
    return new;
  end if;

  -- From here: a non-admin production user updating an order they own in the pool.

  -- 1. An order can never be moved to another client.
  if new.client_code is distinct from old.client_code then
    raise exception 'an order cannot be reassigned to a different client';
  end if;

  -- 1b. A production user cannot hand an order to a DIFFERENT user directly. The
  --     owner may keep it (unchanged) or release it (cleared, on handoff/delivery);
  --     a real reassignment to someone else goes back to Admin, who is
  --     short-circuited above. (Blocks user->user ownership transfer.)
  if new.assigned_user_id is distinct from old.assigned_user_id
     and new.assigned_user_id is not null then
    raise exception
      'a production user cannot reassign an order to another user — hand it back to Admin';
  end if;

  -- 2. Legitimate handoff targets only: back to Admin ('admin'), completed /
  --    unassigned (null, delivery completion), or the same desk (single-seating
  --    in-seat work / mid-stage save). Handing directly to any OTHER live desk is
  --    refused — that skips the gate.
  if new.assigned_to is not null
     and new.assigned_to <> 'admin'
     and new.assigned_to is distinct from old.assigned_to then
    raise exception
      'a stage hands an order back to Admin, not directly to another desk (assigned_to must be admin, unchanged, or cleared)';
  end if;

  -- 3. The pipeline advances ONE stage at a time, in order. completed_dates may
  --    gain at most the single NEXT-stage date and must never lose or rewrite an
  --    earlier one.
  if v_new is distinct from v_old then
    select s into v_next
      from unnest(v_seq) with ordinality as t(s, ord)
     where v_old ->> s is null
     order by ord limit 1;
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
    -- Stamping a stage completes it. Where it must go next depends on seating:
    --   • delivery (final): terminal completion — desk cleared (checked in 4).
    --   • non-final, SINGLE-SEATING owner staying in-seat: allowed with no Admin
    --     gate (assigned_to stays 'user', same owner) — the client's single-seating
    --     bypass. Approval re-enters only at a change of hands (back to Admin).
    --   • non-final, otherwise: must return to Admin ('admin') for approval — the
    --     every-stage gate for non-single-seated orders is unchanged.
    if v_next is not null and (v_new ? v_next) and not (v_old ? v_next) then
      -- The stamp must be a real ISO date (YYYY-MM-DD), not '' or arbitrary text.
      if (v_new ->> v_next) !~ '^\d{4}-\d{2}-\d{2}' then
        raise exception 'a stage completion date must be a valid date (got %)', coalesce(v_new ->> v_next, 'null');
      end if;
      if v_next = 'delivery' then
        if new.assigned_to is not null then
          raise exception 'completing delivery clears the desk (assigned_to must be null)';
        end if;
      elsif v_single
            and new.assigned_to = 'user'::public.user_role
            and new.assigned_user_id is not distinct from old.assigned_user_id then
        -- single-seating in-seat advance: allowed, no Admin gate. (Ordered
        -- stamping, valid date and derived status are still enforced.)
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
  select s into v_after
    from unnest(v_seq) with ordinality as t(s, ord)
   where v_new ->> s is null
   order by ord limit 1;
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
