-- Admin manual client creation.
--
-- The Place Order wizard (admin mode) lets Admin place an order for a company
-- that is not yet in the client list. This gives Admin ONE function to turn a
-- typed company name into a real clients row, reusing the exact match-or-create
-- discipline the email intake already uses (intake_resolve_client): normalised
-- name match under a per-name advisory lock, a CL-numbered new client when
-- nothing matches, and 'ambiguous' when more than one existing client matches
-- (so the UI tells Admin to pick instead of creating a duplicate).
--
-- The intake internals (intake_resolve_client, next_client_code, the sequence)
-- stay revoked from browser sessions — only the service-role intake API may call
-- them directly. admin_create_client is a thin, SECURITY DEFINER wrapper that is
-- callable by a signed-in session but gates on is_admin() inside, and calls the
-- intake resolver as its owner. So only an admin can create a client this way,
-- and only by name (never a code, never fuzzy). Idempotent.

create or replace function public.admin_create_client(
  p_company text,
  p_contact text default null,
  p_email   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resolved jsonb;
begin
  -- Admins only. is_admin() reads the CALLER's auth.uid() even though this
  -- function runs as its owner, so a client or an unauthenticated caller is
  -- rejected here before any client row can be created.
  if not public.is_admin() then
    raise exception 'admin_create_client: admin only' using errcode = '42501';
  end if;

  if public.client_name_key(p_company) is null then
    raise exception 'admin_create_client: company name is required' using errcode = '22023';
  end if;

  -- Same resolver the email intake uses: match one existing client by normalised
  -- name, return 'ambiguous' when several match, or create a new CL client under
  -- the per-name lock. Returns { status: matched|created|ambiguous, code?, name?, codes? }.
  v_resolved := public.intake_resolve_client(p_company, p_contact, p_email);
  return v_resolved;
end;
$$;

-- Callable by a signed-in session (the gate is is_admin() inside); never by anon.
revoke all on function public.admin_create_client(text, text, text) from public, anon;
grant execute on function public.admin_create_client(text, text, text) to authenticated;

-- Verify:
-- select public.admin_create_client('Harborline Title Co');  -- created CL.. (as an admin)
