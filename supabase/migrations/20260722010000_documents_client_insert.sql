-- BUG_004 (Supabase mode): clients can attach reference documents when placing
-- an order, but storage had only a staff INSERT policy (documents_staff_all) and
-- a client READ policy — so a client upload to documents/orders/<id>/… was
-- rejected by storage RLS (HTTP 400) and the file never persisted (the UI only
-- kept an in-session object URL). Add a client INSERT policy scoped to the
-- client's own orders, mirroring documents_client_read.
drop policy if exists documents_client_insert on storage.objects;
create policy documents_client_insert on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and exists (
      select 1 from public.orders o
      where o.client_code = public.my_client_code()
        and storage.objects.name like 'orders/' || o.id || '/%'
    )
  );
