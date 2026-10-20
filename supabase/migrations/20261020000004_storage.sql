-- Private bucket for contractor photos. Signed URLs are generated server-side.
insert into storage.buckets (id, name, public)
values ('contractor-photos', 'contractor-photos', false)
on conflict (id) do nothing;

create policy contractor_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'contractor-photos');
create policy contractor_photos_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'contractor-photos' and public.is_admin());
create policy contractor_photos_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'contractor-photos' and public.is_admin())
  with check (bucket_id = 'contractor-photos' and public.is_admin());
create policy contractor_photos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'contractor-photos' and public.is_admin());
