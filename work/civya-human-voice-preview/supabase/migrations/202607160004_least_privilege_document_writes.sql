-- Browser sessions may read their own records, but workflow state changes are
-- committed only through the transactional RPCs. Document uploads require a
-- verified identity and enter a mandatory pending-review state.

revoke all on all tables in schema public from anon;
revoke insert, update, delete on all tables in schema public from authenticated;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

grant insert on public.documents, public.consent to authenticated;
grant insert, update, delete on public.review_tasks, public.staff_roles, public.demo_invitations to authenticated;
grant update on public.documents to authenticated;

drop policy if exists documents_member_insert on public.documents;
drop policy if exists documents_member_update on public.documents;
create policy documents_verified_resident_insert on public.documents for insert to authenticated
  with check (
    public.civya_owns_resident(documents.resident_id)
    and exists (
      select 1 from public.cases c
      where c.id = documents.case_id
        and c.tenant_id = documents.tenant_id
        and c.resident_id = documents.resident_id
    )
    and documents.storage_path like documents.tenant_id::text || '/' || documents.resident_id::text || '/' || documents.case_id::text || '/%'
    and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true)
    and scan_status = 'pending'
    and review_required
    and classification_confidence is null
    and extraction_confidence is null
    and redacted_extraction is null
  );
create policy documents_staff_insert on public.documents for insert to authenticated
  with check (
    public.civya_is_staff(documents.tenant_id)
    and exists (
      select 1 from public.cases c
      where c.id = documents.case_id
        and c.tenant_id = documents.tenant_id
        and c.resident_id = documents.resident_id
    )
    and documents.storage_path like documents.tenant_id::text || '/' || documents.resident_id::text || '/' || documents.case_id::text || '/%'
  );
create policy documents_staff_update on public.documents for update to authenticated
  using (public.civya_is_staff(documents.tenant_id))
  with check (
    public.civya_is_staff(documents.tenant_id)
    and exists (
      select 1 from public.cases c
      where c.id = documents.case_id
        and c.tenant_id = documents.tenant_id
        and c.resident_id = documents.resident_id
    )
    and documents.storage_path like documents.tenant_id::text || '/' || documents.resident_id::text || '/' || documents.case_id::text || '/%'
  );

drop policy if exists consent_owner_insert on public.consent;
create policy consent_owner_insert on public.consent for insert to authenticated
  with check (
    public.civya_owns_resident(consent.resident_id)
    and exists (
      select 1 from public.residents r
      where r.id = consent.resident_id and r.tenant_id = consent.tenant_id
    )
    and (
      consent.case_id is null
      or exists (
        select 1 from public.cases c
        where c.id = consent.case_id
          and c.tenant_id = consent.tenant_id
          and c.resident_id = consent.resident_id
      )
    )
  );

drop policy if exists reviews_staff_all on public.review_tasks;
create policy reviews_staff_all on public.review_tasks for all to authenticated
  using (public.civya_is_staff(review_tasks.tenant_id))
  with check (
    public.civya_is_staff(review_tasks.tenant_id)
    and exists (
      select 1 from public.cases c
      where c.id = review_tasks.case_id and c.tenant_id = review_tasks.tenant_id
        and (review_tasks.resident_id is null or c.resident_id = review_tasks.resident_id)
    )
  );

drop policy if exists civya_storage_member_insert on storage.objects;
create policy civya_storage_verified_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'civya-private-documents'
    and public.civya_can_access_storage_object(name)
    and (
      not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true)
      or public.civya_is_staff(
        substring(name from '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/')::uuid
      )
    )
  );
