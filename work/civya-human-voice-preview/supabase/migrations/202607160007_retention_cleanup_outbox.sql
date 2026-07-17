-- Durable cleanup outbox. Database rows are deleted transactionally while
-- private Storage objects and orphaned Auth users are retried by a service-role
-- worker until confirmed removed.

create table if not exists private.retention_deletion_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('storage_object', 'auth_user')),
  reference text not null,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (kind, reference)
);

create index if not exists retention_deletion_queue_pending_idx
  on private.retention_deletion_queue (created_at) where completed_at is null;

create or replace function public.civya_prepare_retention_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_cases bigint := 0; v_residents bigint := 0; v_deletions jsonb; v_deleted record;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;

  insert into private.retention_deletion_queue (tenant_id, kind, reference)
  select distinct d.tenant_id, 'storage_object', d.storage_path
  from public.documents d
  join public.cases c on c.id = d.case_id
  join public.tenants t on t.id = d.tenant_id
  where c.updated_at < now() - make_interval(days => t.retention_days)
  on conflict (kind, reference) do nothing;

  with deleted as (
    delete from public.cases c
    using public.tenants t
    where c.tenant_id = t.id
      and c.updated_at < now() - make_interval(days => t.retention_days)
    returning c.id
  ) select count(*) into v_cases from deleted;

  for v_deleted in
    delete from public.residents r
    using public.tenants t
    where r.tenant_id = t.id
      and r.updated_at < now() - make_interval(days => t.retention_days)
      and not exists (select 1 from public.cases c where c.resident_id = r.id)
    returning r.tenant_id, r.auth_user_id
  loop
    v_residents := v_residents + 1;
    if not exists (select 1 from public.residents r where r.auth_user_id = v_deleted.auth_user_id)
       and not exists (select 1 from public.staff_roles s where s.auth_user_id = v_deleted.auth_user_id) then
      insert into private.retention_deletion_queue (tenant_id, kind, reference)
      values (v_deleted.tenant_id, 'auth_user', v_deleted.auth_user_id::text)
      on conflict (kind, reference) do nothing;
    end if;
  end loop;

  delete from public.audit_events a
  using public.tenants t
  where a.tenant_id = t.id
    and a.created_at < now() - make_interval(days => t.retention_days);
  delete from private.rate_limits where window_started_at < now() - interval '2 days';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'tenantId', q.tenant_id, 'kind', q.kind,
    'reference', q.reference, 'attempts', q.attempts
  ) order by q.created_at), '[]'::jsonb)
  into v_deletions
  from (
    select * from private.retention_deletion_queue
    where completed_at is null and attempts < 10
    order by created_at
    limit 1000
  ) q;

  return jsonb_build_object(
    'casesRemoved', v_cases,
    'residentsRemoved', v_residents,
    'deletions', v_deletions
  );
end;
$$;

create or replace function public.civya_complete_retention_deletions(
  p_ids uuid[],
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_error is null then
    update private.retention_deletion_queue
    set completed_at = now(), attempts = attempts + 1, last_error = null
    where id = any(p_ids) and completed_at is null;
  else
    update private.retention_deletion_queue
    set attempts = attempts + 1, last_error = left(p_error, 500)
    where id = any(p_ids) and completed_at is null;
  end if;
end;
$$;

-- Replaces the earlier reset body so a manual reset cannot orphan Storage or
-- Auth data. The queued external deletions are drained by the same worker.
create or replace function public.civya_reset_tenant_sandbox(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_tenant public.tenants%rowtype; v_residents bigint; v_cases bigint;
begin
  select * into v_tenant from public.tenants
    where slug = p_tenant_slug and environment = 'sandbox' and fictional
    for update;
  if not found then raise exception 'fictional sandbox tenant not found' using errcode = 'P0002'; end if;
  if auth.role() <> 'service_role' and not public.civya_is_staff(v_tenant.id, 'admin') then
    raise exception 'tenant admin required' using errcode = '42501';
  end if;

  select count(*) into v_residents from public.residents where tenant_id = v_tenant.id;
  select count(*) into v_cases from public.cases where tenant_id = v_tenant.id;
  insert into private.retention_deletion_queue (tenant_id, kind, reference)
    select v_tenant.id, 'storage_object', storage_path
    from public.documents where tenant_id = v_tenant.id
    on conflict (kind, reference) do nothing;
  insert into private.retention_deletion_queue (tenant_id, kind, reference)
    select distinct v_tenant.id, 'auth_user', r.auth_user_id::text
    from public.residents r
    where r.tenant_id = v_tenant.id
      and not exists (
        select 1 from public.residents other
        where other.auth_user_id = r.auth_user_id and other.tenant_id <> v_tenant.id
      )
      and not exists (select 1 from public.staff_roles s where s.auth_user_id = r.auth_user_id)
    on conflict (kind, reference) do nothing;

  delete from public.audit_events where tenant_id = v_tenant.id;
  delete from public.residents where tenant_id = v_tenant.id;
  delete from private.case_transfer_grants where tenant_id = v_tenant.id;
  insert into public.audit_events (
    tenant_id, actor_user_id, event_type, redacted_payload, source
  ) values (
    v_tenant.id, auth.uid(), 'fictional_tenant_reset',
    jsonb_build_object('residentsRemoved', v_residents, 'casesRemoved', v_cases), 'admin'
  );
  return jsonb_build_object(
    'tenantId', v_tenant.id, 'tenantSlug', v_tenant.slug,
    'residentsRemoved', v_residents, 'casesRemoved', v_cases
  );
end;
$$;

revoke all on function public.civya_prepare_retention_cleanup() from public;
revoke all on function public.civya_complete_retention_deletions(uuid[], text) from public;
grant execute on function public.civya_prepare_retention_cleanup() to service_role;
grant execute on function public.civya_complete_retention_deletions(uuid[], text) to service_role;

drop function if exists public.civya_delete_expired_demo_data();
