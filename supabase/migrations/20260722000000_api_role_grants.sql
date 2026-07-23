-- API-role table grants. PostgREST talks to the DB as the `anon` (logged-out)
-- and `authenticated` (logged-in) roles; those roles need table-level DML
-- privileges or every request fails with "permission denied for table …",
-- regardless of RLS. Supabase's hosted platform auto-grants these, but a local
-- `supabase db reset` does not reliably reproduce it, so make it explicit and
-- deploy-agnostic. Row visibility is still enforced entirely by the RLS
-- policies defined in the earlier migrations — these grants only open the door;
-- the policies decide what each role actually sees.
grant usage on schema public to anon, authenticated, service_role;

grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;

-- Cover tables/sequences/functions created by later migrations too.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
