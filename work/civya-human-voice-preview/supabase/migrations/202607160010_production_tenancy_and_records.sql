-- Production tenancy, governed configuration, and records controls.
--
-- IMPORTANT: the sandbox-only retention implementation is installed before
-- the tenant constraints are relaxed. Migration 007's broad cleanup function
-- was safe only while every tenant was forced to be fictional/sandbox. It must
-- never be reachable after a production tenant can exist.

create or replace function public.civya_prepare_retention_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_cases bigint := 0;
  v_residents bigint := 0;
  v_deletions jsonb;
  v_deleted record;
  v_deleted_count integer;
  v_expired_record_ids uuid[] := '{}'::uuid[];
  v_expired_batch_ids uuid[] := '{}'::uuid[];
begin
  perform private.civya_service_required();

  -- These transaction-local markers permit only the explicit sandbox purge
  -- paths guarded by immutable-history triggers.
  perform set_config('civya.authorized_outcome_purge', 'synthetic_retention', true);
  perform set_config('civya.authorized_audit_purge', 'sandbox_retention', true);

  select coalesce(array_agg(distinct m.source_record_id), '{}'::uuid[])
    into v_expired_record_ids
  from public.case_source_match_decisions m
  join public.cases c on c.id = m.case_id
  join public.tenants t on t.id = c.tenant_id
  where t.environment = 'sandbox'
    and t.fictional
    and c.updated_at < now() - make_interval(days => t.retention_days);

  select coalesce(array_agg(distinct r.source_batch_id), '{}'::uuid[])
    into v_expired_batch_ids
  from public.authoritative_source_records r
  where r.id = any(v_expired_record_ids);

  insert into private.retention_deletion_queue (tenant_id, kind, reference)
  select distinct d.tenant_id, 'storage_object', d.storage_path
  from public.documents d
  join public.cases c on c.id = d.case_id
  join public.tenants t on t.id = d.tenant_id
  where t.environment = 'sandbox'
    and t.fictional
    and c.updated_at < now() - make_interval(days => t.retention_days)
  on conflict (kind, reference) do nothing;

  -- Remove expiring sandbox audit rows before deleting their referenced case
  -- or resident. Once audit integrity is active, FK-driven SET NULL updates are
  -- intentionally rejected because they would invalidate the hash chain.
  delete from public.audit_events a
  using public.cases c, public.tenants t
  where a.case_id = c.id
    and c.tenant_id = t.id
    and t.environment = 'sandbox'
    and t.fictional
    and c.updated_at < now() - make_interval(days => t.retention_days);

  delete from public.audit_events a
  using public.residents r, public.tenants t
  where a.resident_id = r.id
    and r.tenant_id = t.id
    and t.environment = 'sandbox'
    and t.fictional
    and r.updated_at < now() - make_interval(days => t.retention_days)
    and not exists (
      select 1 from public.cases c
      where c.resident_id = r.id
        and c.updated_at >= now() - make_interval(days => t.retention_days)
    );

  delete from public.audit_events a
  using public.tenants t
  where a.tenant_id = t.id
    and t.environment = 'sandbox'
    and t.fictional
    and a.created_at < now() - make_interval(days => t.retention_days);

  with deleted as (
    delete from public.cases c
    using public.tenants t
    where c.tenant_id = t.id
      and t.environment = 'sandbox'
      and t.fictional
      and c.updated_at < now() - make_interval(days => t.retention_days)
    returning c.id
  ) select count(*) into v_cases from deleted;

  for v_deleted in
    delete from public.residents r
    using public.tenants t
    where r.tenant_id = t.id
      and t.environment = 'sandbox'
      and t.fictional
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

  delete from private.rate_limits where window_started_at < now() - interval '2 days';

  -- Source snapshots are case-independent. Remove only synthetic sandbox
  -- records captured by the expired cases, or old unreferenced sandbox orphans.
  loop
    with deleted as (
      delete from public.authoritative_source_records r
      using public.authoritative_source_systems s, public.tenants t
      where r.source_system_id = s.id
        and r.tenant_id = t.id
        and s.fictional
        and t.fictional
        and t.environment = 'sandbox'
        and (
          r.id = any(v_expired_record_ids)
          or r.created_at < now() - make_interval(days => t.retention_days)
        )
        and not exists (
          select 1 from public.case_source_match_decisions m where m.source_record_id = r.id
        )
        and not exists (
          select 1 from public.authoritative_source_records child where child.supersedes_record_id = r.id
        )
      returning 1
    ) select count(*)::integer into v_deleted_count from deleted;
    exit when v_deleted_count = 0;
  end loop;

  delete from public.authoritative_source_batches b
  using public.authoritative_source_systems s, public.tenants t
  where b.source_system_id = s.id
    and b.tenant_id = t.id
    and s.fictional
    and t.fictional
    and t.environment = 'sandbox'
    and (
      b.id = any(v_expired_batch_ids)
      or b.created_at < now() - make_interval(days => t.retention_days)
    )
    and not exists (
      select 1 from public.authoritative_source_records r where r.source_batch_id = b.id
    );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id,
    'tenantId', q.tenant_id,
    'kind', q.kind,
    'reference', q.reference,
    'attempts', q.attempts
  ) order by q.created_at), '[]'::jsonb)
  into v_deletions
  from (
    select *
    from private.retention_deletion_queue
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

revoke all on function public.civya_prepare_retention_cleanup()
  from public, anon, authenticated;
grant execute on function public.civya_prepare_retention_cleanup()
  to service_role;

-- The safe cleanup body now exists. Production-shaped tenants may be added.
alter table public.tenants drop constraint if exists tenants_environment_check;
alter table public.tenants drop constraint if exists tenants_fictional_check;
alter table public.tenants drop constraint if exists tenants_retention_days_check;

alter table public.tenants
  add constraint tenants_environment_check
    check (environment in ('sandbox', 'development', 'staging', 'production')),
  add constraint tenants_environment_fictional_check
    check (
      (environment = 'sandbox' and fictional)
      or (environment = 'production' and not fictional)
      or environment in ('development', 'staging')
    ),
  add constraint tenants_retention_days_check
    check (retention_days between 1 and 3650);

create table public.tenant_domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  hostname text not null,
  purpose text not null check (purpose in ('resident', 'staff', 'api', 'webhook')),
  verification_state text not null default 'pending'
    check (verification_state in ('pending', 'verified', 'failed', 'disabled')),
  is_primary boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hostname),
  check (
    hostname = lower(hostname)
    and char_length(hostname) between 3 and 253
    and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  check ((verification_state = 'verified') = (verified_at is not null))
);

create unique index tenant_domains_one_primary_idx
  on public.tenant_domains (tenant_id, purpose)
  where is_primary and verification_state = 'verified';

create table public.tenant_program_config_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  program_key text not null check (program_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version text not null,
  schema_version text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'active', 'retired')),
  configuration jsonb not null default '{}'::jsonb
    check (jsonb_typeof(configuration) = 'object'),
  effective_from timestamptz,
  effective_to timestamptz,
  approved_by_auth_user_id uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by_auth_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, program_key, version),
  check (effective_to is null or (effective_from is not null and effective_to > effective_from)),
  check (
    status = 'draft'
    or (approved_by_auth_user_id is not null and approved_at is not null)
  )
);

create unique index tenant_program_config_one_active_idx
  on public.tenant_program_config_versions (tenant_id, program_key)
  where status = 'active';

create table public.tenant_runtime_controls (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  control_key text not null check (control_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  enabled boolean not null default false,
  cohort_limit integer check (cohort_limit is null or cohort_limit >= 0),
  reason text not null default '',
  row_version bigint not null default 1,
  changed_by_auth_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, control_key)
);

create table public.record_series_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  record_series_key text not null check (record_series_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'active', 'retired')),
  retention_days integer not null check (retention_days between 1 and 36500),
  disposition_action text not null
    check (disposition_action in ('review', 'archive', 'delete')),
  legal_basis text not null,
  export_required boolean not null default true,
  effective_from timestamptz,
  effective_to timestamptz,
  approved_by_auth_user_id uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, record_series_key, version),
  check (effective_to is null or (effective_from is not null and effective_to > effective_from)),
  check (
    status = 'draft'
    or (approved_by_auth_user_id is not null and approved_at is not null)
  )
);

create unique index record_series_one_active_idx
  on public.record_series_schedules (tenant_id, record_series_key)
  where status = 'active';

create table public.legal_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  hold_key text not null,
  status text not null default 'active' check (status in ('active', 'released')),
  scope jsonb not null check (jsonb_typeof(scope) = 'object'),
  reason text not null,
  authority_reference text not null,
  opened_by_auth_user_id uuid not null references auth.users(id) on delete restrict,
  opened_at timestamptz not null default now(),
  released_by_auth_user_id uuid references auth.users(id) on delete restrict,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, hold_key),
  check (
    (status = 'active' and released_by_auth_user_id is null and released_at is null)
    or (status = 'released' and released_by_auth_user_id is not null and released_at is not null and release_reason is not null)
  )
);

create index tenant_domains_lookup_idx
  on public.tenant_domains (hostname, verification_state);
create index tenant_program_config_effective_idx
  on public.tenant_program_config_versions (tenant_id, program_key, status, effective_from desc);
create index legal_holds_active_idx
  on public.legal_holds (tenant_id, opened_at)
  where status = 'active';

create trigger set_updated_at before update on public.tenant_domains
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.tenant_runtime_controls
  for each row execute function private.set_updated_at();

alter table public.tenant_domains enable row level security;
alter table public.tenant_program_config_versions enable row level security;
alter table public.tenant_runtime_controls enable row level security;
alter table public.record_series_schedules enable row level security;
alter table public.legal_holds enable row level security;

create or replace function private.civya_foundation_admin_read_allowed(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select private.civya_actor_is_staff(auth.uid(), p_tenant_id, 'admin')
$$;

revoke all on function private.civya_foundation_admin_read_allowed(uuid)
  from public, anon, authenticated;
grant execute on function private.civya_foundation_admin_read_allowed(uuid)
  to authenticated;

create policy tenant_domains_admin_read on public.tenant_domains
  for select to authenticated using (private.civya_foundation_admin_read_allowed(tenant_id));
create policy tenant_program_config_admin_read on public.tenant_program_config_versions
  for select to authenticated using (private.civya_foundation_admin_read_allowed(tenant_id));
create policy tenant_runtime_controls_admin_read on public.tenant_runtime_controls
  for select to authenticated using (private.civya_foundation_admin_read_allowed(tenant_id));
create policy record_series_schedules_admin_read on public.record_series_schedules
  for select to authenticated using (private.civya_foundation_admin_read_allowed(tenant_id));
create policy legal_holds_admin_read on public.legal_holds
  for select to authenticated using (private.civya_foundation_admin_read_allowed(tenant_id));

revoke all on public.tenant_domains from public, anon, authenticated;
revoke all on public.tenant_program_config_versions from public, anon, authenticated;
revoke all on public.tenant_runtime_controls from public, anon, authenticated;
revoke all on public.record_series_schedules from public, anon, authenticated;
revoke all on public.legal_holds from public, anon, authenticated;

grant select on public.tenant_domains to authenticated;
grant select on public.tenant_program_config_versions to authenticated;
grant select on public.tenant_runtime_controls to authenticated;
grant select on public.record_series_schedules to authenticated;
grant select on public.legal_holds to authenticated;

grant select, insert, update, delete on public.tenant_domains to service_role;
grant select, insert, update, delete on public.tenant_program_config_versions to service_role;
grant select, insert, update, delete on public.tenant_runtime_controls to service_role;
grant select, insert, update, delete on public.record_series_schedules to service_role;
grant select, insert, update, delete on public.legal_holds to service_role;

create or replace function public.civya_service_resolve_tenant(p_hostname text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tenant public.tenants%rowtype;
  v_domain public.tenant_domains%rowtype;
begin
  perform private.civya_service_required();
  select * into v_domain
  from public.tenant_domains d
  where d.hostname = lower(trim(trailing '.' from p_hostname))
    and d.verification_state = 'verified';
  if not found then
    raise exception 'verified tenant domain not found' using errcode = 'P0002';
  end if;
  select * into v_tenant from public.tenants
  where id = v_domain.tenant_id and status = 'active';
  if not found then
    raise exception 'active tenant not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'slug', v_tenant.slug,
    'name', v_tenant.name,
    'environment', v_tenant.environment,
    'fictional', v_tenant.fictional,
    'purpose', v_domain.purpose
  );
end;
$$;

create or replace function public.civya_service_get_program_config(
  p_tenant_id uuid,
  p_program_key text,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare v_config public.tenant_program_config_versions%rowtype;
begin
  perform private.civya_service_required();
  select * into v_config
  from public.tenant_program_config_versions c
  where c.tenant_id = p_tenant_id
    and c.program_key = p_program_key
    and c.status = 'active'
    and (c.effective_from is null or c.effective_from <= p_at)
    and (c.effective_to is null or c.effective_to > p_at);
  if not found then
    raise exception 'active program configuration not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'id', v_config.id,
    'programKey', v_config.program_key,
    'version', v_config.version,
    'schemaVersion', v_config.schema_version,
    'configuration', v_config.configuration,
    'effectiveFrom', v_config.effective_from,
    'effectiveTo', v_config.effective_to
  );
end;
$$;

revoke all on function public.civya_service_resolve_tenant(text)
  from public, anon, authenticated;
revoke all on function public.civya_service_get_program_config(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.civya_service_resolve_tenant(text) to service_role;
grant execute on function public.civya_service_get_program_config(uuid, text, timestamptz) to service_role;
