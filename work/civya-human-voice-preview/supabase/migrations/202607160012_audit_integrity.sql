-- Tamper-evident audit chain and durable WORM-archive checkpoints.
-- Existing rows are deterministically backfilled before immutability is
-- enforced. Production audit rows cannot be updated or deleted.

create table private.audit_chain_heads (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  last_event_hash text not null default repeat('0', 64)
    check (last_event_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

alter table public.audit_events
  add column sequence_number bigint,
  add column previous_event_hash text,
  add column event_hash text,
  add column integrity_version text;

create or replace function private.civya_compute_audit_hash(
  p_tenant_id uuid,
  p_sequence_number bigint,
  p_previous_event_hash text,
  p_event_id uuid,
  p_resident_id uuid,
  p_case_id uuid,
  p_actor_user_id uuid,
  p_event_type text,
  p_redacted_payload jsonb,
  p_source text,
  p_request_id text,
  p_created_at timestamptz
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'integrityVersion', 'sha256-v1',
    'tenantId', p_tenant_id,
    'sequenceNumber', p_sequence_number,
    'previousEventHash', p_previous_event_hash,
    'eventId', p_event_id,
    'residentId', p_resident_id,
    'caseId', p_case_id,
    'actorUserId', p_actor_user_id,
    'eventType', p_event_type,
    'redactedPayload', coalesce(p_redacted_payload, '{}'::jsonb),
    'source', p_source,
    'requestId', p_request_id,
    'createdAtUtc', to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )::text, 'UTF8')), 'hex')
$$;

revoke all on function private.civya_compute_audit_hash(
  uuid, bigint, text, uuid, uuid, uuid, uuid, text, jsonb, text, text, timestamptz
) from public, anon, authenticated, service_role;

do $$
declare
  v_tenant record;
  v_event public.audit_events%rowtype;
  v_sequence bigint;
  v_previous text;
  v_hash text;
begin
  for v_tenant in select id from public.tenants order by id loop
    v_sequence := 0;
    v_previous := repeat('0', 64);
    for v_event in
      select * from public.audit_events
      where tenant_id = v_tenant.id
      order by created_at, id
    loop
      v_sequence := v_sequence + 1;
      v_hash := private.civya_compute_audit_hash(
        v_event.tenant_id, v_sequence, v_previous, v_event.id,
        v_event.resident_id, v_event.case_id, v_event.actor_user_id,
        v_event.event_type, v_event.redacted_payload, v_event.source,
        v_event.request_id, v_event.created_at
      );
      update public.audit_events
      set sequence_number = v_sequence,
          previous_event_hash = v_previous,
          event_hash = v_hash,
          integrity_version = 'sha256-v1'
      where id = v_event.id;
      v_previous := v_hash;
    end loop;
    if v_sequence > 0 then
      insert into private.audit_chain_heads (tenant_id, last_sequence, last_event_hash)
      values (v_tenant.id, v_sequence, v_previous);
    end if;
  end loop;
end;
$$;

alter table public.audit_events
  alter column sequence_number set not null,
  alter column previous_event_hash set not null,
  alter column event_hash set not null,
  alter column integrity_version set not null,
  add constraint audit_events_sequence_positive_check check (sequence_number > 0),
  add constraint audit_events_previous_hash_check check (previous_event_hash ~ '^[0-9a-f]{64}$'),
  add constraint audit_events_hash_check check (event_hash ~ '^[0-9a-f]{64}$'),
  add constraint audit_events_integrity_version_check check (integrity_version = 'sha256-v1'),
  add constraint audit_events_tenant_sequence_unique unique (tenant_id, sequence_number);

create unique index audit_events_tenant_hash_idx
  on public.audit_events (tenant_id, event_hash);

create or replace function private.civya_chain_audit_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_head private.audit_chain_heads%rowtype;
begin
  insert into private.audit_chain_heads (tenant_id)
  values (new.tenant_id)
  on conflict (tenant_id) do nothing;

  select * into strict v_head
  from private.audit_chain_heads
  where tenant_id = new.tenant_id
  for update;

  new.sequence_number := v_head.last_sequence + 1;
  new.previous_event_hash := v_head.last_event_hash;
  new.integrity_version := 'sha256-v1';
  new.event_hash := private.civya_compute_audit_hash(
    new.tenant_id, new.sequence_number, new.previous_event_hash, new.id,
    new.resident_id, new.case_id, new.actor_user_id, new.event_type,
    new.redacted_payload, new.source, new.request_id, new.created_at
  );

  update private.audit_chain_heads
  set last_sequence = new.sequence_number,
      last_event_hash = new.event_hash,
      updated_at = now()
  where tenant_id = new.tenant_id;
  return new;
end;
$$;

create or replace function private.civya_reject_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE')
     and current_setting('civya.authorized_audit_purge', true) = 'sandbox_retention'
     and exists (
       select 1 from public.tenants t
       where t.id = old.tenant_id and t.environment = 'sandbox' and t.fictional
     ) then
    return old;
  end if;
  raise exception 'audit history is append-only' using errcode = '55000';
end;
$$;

create or replace function private.civya_rebuild_sandbox_audit_chains(p_tenant_id uuid default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_tenant record;
  v_event public.audit_events%rowtype;
  v_sequence bigint;
  v_previous text;
  v_hash text;
begin
  if current_setting('civya.authorized_audit_purge', true) <> 'sandbox_retention' then
    raise exception 'sandbox audit rebuild authorization required' using errcode = '42501';
  end if;
  for v_tenant in
    select id from public.tenants
    where environment = 'sandbox' and fictional
      and (p_tenant_id is null or id = p_tenant_id)
    order by id
  loop
    v_sequence := 0;
    v_previous := repeat('0', 64);
    for v_event in
      select * from public.audit_events
      where tenant_id = v_tenant.id
      order by created_at, id
    loop
      v_sequence := v_sequence + 1;
      v_hash := private.civya_compute_audit_hash(
        v_event.tenant_id, v_sequence, v_previous, v_event.id,
        v_event.resident_id, v_event.case_id, v_event.actor_user_id,
        v_event.event_type, v_event.redacted_payload, v_event.source,
        v_event.request_id, v_event.created_at
      );
      update public.audit_events
      set sequence_number = v_sequence,
          previous_event_hash = v_previous,
          event_hash = v_hash,
          integrity_version = 'sha256-v1'
      where id = v_event.id;
      v_previous := v_hash;
    end loop;
    insert into private.audit_chain_heads (tenant_id, last_sequence, last_event_hash, updated_at)
    values (v_tenant.id, v_sequence, v_previous, now())
    on conflict (tenant_id) do update
      set last_sequence = excluded.last_sequence,
          last_event_hash = excluded.last_event_hash,
          updated_at = excluded.updated_at;
  end loop;
end;
$$;

revoke all on function private.civya_chain_audit_event()
  from public, anon, authenticated, service_role;
revoke all on function private.civya_reject_audit_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.civya_rebuild_sandbox_audit_chains(uuid)
  from public, anon, authenticated, service_role;

create trigger audit_events_chain_before_insert
  before insert on public.audit_events
  for each row execute function private.civya_chain_audit_event();
create trigger audit_events_immutable
  before update or delete on public.audit_events
  for each row execute function private.civya_reject_audit_mutation();

create or replace function private.civya_audit_foundation_config_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb;
  v_tenant_id uuid;
  v_record_reference text;
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
    v_tenant_id := old.tenant_id;
  else
    v_row := to_jsonb(new);
    v_tenant_id := new.tenant_id;
  end if;
  v_record_reference := coalesce(
    v_row ->> 'id',
    v_row ->> 'control_key',
    v_row ->> 'program_key',
    v_row ->> 'record_series_key',
    v_row ->> 'hold_key'
  );
  insert into public.audit_events (
    tenant_id, actor_user_id, event_type, redacted_payload, source
  ) values (
    v_tenant_id,
    auth.uid(),
    'foundation_config_' || lower(tg_op),
    jsonb_build_object(
      'table', tg_table_name,
      'operation', lower(tg_op),
      'recordReference', v_record_reference,
      'status', v_row ->> 'status'
    ),
    case when auth.uid() is null then 'system' else 'admin' end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.civya_audit_foundation_config_change()
  from public, anon, authenticated, service_role;

create trigger tenant_domains_audit
  after insert or update or delete on public.tenant_domains
  for each row execute function private.civya_audit_foundation_config_change();
create trigger tenant_program_config_versions_audit
  after insert or update or delete on public.tenant_program_config_versions
  for each row execute function private.civya_audit_foundation_config_change();
create trigger tenant_runtime_controls_audit
  after insert or update or delete on public.tenant_runtime_controls
  for each row execute function private.civya_audit_foundation_config_change();
create trigger record_series_schedules_audit
  after insert or update or delete on public.record_series_schedules
  for each row execute function private.civya_audit_foundation_config_change();
create trigger legal_holds_audit
  after insert or update or delete on public.legal_holds
  for each row execute function private.civya_audit_foundation_config_change();

-- Rebuild the remaining synthetic chain after the sandbox-only retention
-- function removes expired history. Production chains are never rebuilt.
alter function public.civya_prepare_retention_cleanup()
  rename to civya_prepare_retention_cleanup_pre_audit_integrity;
revoke all on function public.civya_prepare_retention_cleanup_pre_audit_integrity()
  from public, anon, authenticated, service_role;

create or replace function public.civya_prepare_retention_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_result jsonb;
begin
  perform private.civya_service_required();
  perform set_config('civya.authorized_audit_purge', 'sandbox_retention', true);
  v_result := public.civya_prepare_retention_cleanup_pre_audit_integrity();
  perform private.civya_rebuild_sandbox_audit_chains();
  return v_result;
end;
$$;

revoke all on function public.civya_prepare_retention_cleanup()
  from public, anon, authenticated;
grant execute on function public.civya_prepare_retention_cleanup() to service_role;

-- Keep sandbox reset functional without creating any production deletion path.
alter function public.civya_reset_tenant_sandbox(text)
  rename to civya_reset_tenant_sandbox_pre_audit_integrity;
revoke all on function public.civya_reset_tenant_sandbox_pre_audit_integrity(text)
  from public, anon, authenticated, service_role;

create or replace function public.civya_reset_tenant_sandbox(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_result jsonb;
begin
  if not exists (
    select 1 from public.tenants
    where slug = p_tenant_slug and environment = 'sandbox' and fictional
  ) then
    raise exception 'fictional sandbox tenant not found' using errcode = 'P0002';
  end if;
  perform set_config('civya.authorized_audit_purge', 'sandbox_retention', true);
  v_result := public.civya_reset_tenant_sandbox_pre_audit_integrity(p_tenant_slug);
  perform private.civya_rebuild_sandbox_audit_chains((
    select id from public.tenants where slug = p_tenant_slug
  ));
  return v_result;
end;
$$;

revoke all on function public.civya_reset_tenant_sandbox(text) from public, anon;
grant execute on function public.civya_reset_tenant_sandbox(text) to authenticated, service_role;

create table private.audit_archive_checkpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  from_sequence bigint not null check (from_sequence > 0),
  through_sequence bigint not null check (through_sequence >= from_sequence),
  through_event_hash text not null check (through_event_hash ~ '^[0-9a-f]{64}$'),
  event_count integer not null check (event_count > 0),
  state text not null default 'queued'
    check (state in ('queued', 'verified', 'failed')),
  idempotency_key text not null,
  job_id uuid references private.jobs(id) on delete restrict,
  object_reference text,
  object_sha256 text check (object_sha256 is null or object_sha256 ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz not null default now(),
  verified_at timestamptz,
  last_error_code text,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, through_sequence),
  check (
    (state = 'verified' and object_reference is not null and object_sha256 is not null and verified_at is not null)
    or state in ('queued', 'failed')
  )
);

create index audit_archive_pending_idx
  on private.audit_archive_checkpoints (requested_at)
  where state in ('queued', 'failed');

alter table private.audit_chain_heads enable row level security;
alter table private.audit_archive_checkpoints enable row level security;
revoke all on private.audit_chain_heads from public, anon, authenticated, service_role;
revoke all on private.audit_archive_checkpoints from public, anon, authenticated, service_role;

create or replace function public.civya_service_verify_audit_chain(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_event public.audit_events%rowtype;
  v_head private.audit_chain_heads%rowtype;
  v_sequence bigint := 0;
  v_previous text := repeat('0', 64);
  v_expected text;
begin
  perform private.civya_service_required();
  for v_event in
    select * from public.audit_events
    where tenant_id = p_tenant_id
    order by sequence_number
  loop
    v_sequence := v_sequence + 1;
    v_expected := private.civya_compute_audit_hash(
      v_event.tenant_id, v_sequence, v_previous, v_event.id,
      v_event.resident_id, v_event.case_id, v_event.actor_user_id,
      v_event.event_type, v_event.redacted_payload, v_event.source,
      v_event.request_id, v_event.created_at
    );
    if v_event.sequence_number <> v_sequence
       or v_event.previous_event_hash <> v_previous
       or v_event.event_hash <> v_expected
       or v_event.integrity_version <> 'sha256-v1' then
      return jsonb_build_object(
        'valid', false,
        'checkedEvents', v_sequence,
        'brokenAtSequence', v_event.sequence_number,
        'expectedHash', v_expected,
        'actualHash', v_event.event_hash
      );
    end if;
    v_previous := v_event.event_hash;
  end loop;

  select * into v_head from private.audit_chain_heads where tenant_id = p_tenant_id;
  if v_sequence = 0 then
    return jsonb_build_object('valid', not found or v_head.last_sequence = 0, 'checkedEvents', 0);
  end if;
  return jsonb_build_object(
    'valid', found and v_head.last_sequence = v_sequence and v_head.last_event_hash = v_previous,
    'checkedEvents', v_sequence,
    'headSequence', case when found then v_head.last_sequence else null end,
    'headHash', case when found then v_head.last_event_hash else null end
  );
end;
$$;

create or replace function public.civya_service_request_audit_archive(
  p_tenant_id uuid,
  p_through_sequence bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_checkpoint private.audit_archive_checkpoints%rowtype;
  v_job private.jobs%rowtype;
  v_through bigint;
  v_from bigint;
  v_hash text;
  v_count integer;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  select * into v_checkpoint from private.audit_archive_checkpoints
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('duplicate', true, 'checkpointId', v_checkpoint.id,
      'jobId', v_checkpoint.job_id, 'state', v_checkpoint.state);
  end if;
  select coalesce(p_through_sequence, h.last_sequence) into v_through
  from private.audit_chain_heads h where h.tenant_id = p_tenant_id;
  if v_through is null or v_through < 1 then
    raise exception 'no audit events available for archive' using errcode = '22023';
  end if;
  select event_hash into v_hash from public.audit_events
  where tenant_id = p_tenant_id and sequence_number = v_through;
  if not found then raise exception 'archive sequence not found' using errcode = 'P0002'; end if;
  select coalesce(max(through_sequence), 0) + 1 into v_from
  from private.audit_archive_checkpoints
  where tenant_id = p_tenant_id and state = 'verified';
  if v_from > v_through then raise exception 'audit range already archived' using errcode = '55000'; end if;
  select count(*)::integer into v_count from public.audit_events
  where tenant_id = p_tenant_id and sequence_number between v_from and v_through;

  insert into private.audit_archive_checkpoints (
    tenant_id, from_sequence, through_sequence, through_event_hash, event_count, idempotency_key
  ) values (p_tenant_id, v_from, v_through, v_hash, v_count, p_idempotency_key)
  on conflict (tenant_id, idempotency_key) do nothing returning * into v_checkpoint;
  if not found then
    v_duplicate := true;
    select * into strict v_checkpoint from private.audit_archive_checkpoints
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    return jsonb_build_object('duplicate', true, 'checkpointId', v_checkpoint.id,
      'jobId', v_checkpoint.job_id, 'state', v_checkpoint.state);
  end if;

  insert into private.jobs (
    tenant_id, job_type, schema_version, payload, idempotency_key,
    source_type, source_id, priority, max_attempts, timeout_seconds
  ) values (
    p_tenant_id, 'audit.archive', '1', jsonb_build_object(
      'checkpointId', v_checkpoint.id,
      'fromSequence', v_checkpoint.from_sequence,
      'throughSequence', v_checkpoint.through_sequence,
      'throughEventHash', v_checkpoint.through_event_hash,
      'eventCount', v_checkpoint.event_count
    ), 'audit-archive:' || v_checkpoint.id::text,
    'audit_archive_checkpoint', v_checkpoint.id, 90, 12, 1800
  ) returning * into v_job;
  update private.audit_archive_checkpoints set job_id = v_job.id where id = v_checkpoint.id;
  insert into public.audit_events (tenant_id, event_type, redacted_payload, source)
  values (p_tenant_id, 'audit_archive_requested', jsonb_build_object(
    'checkpointId', v_checkpoint.id, 'fromSequence', v_from,
    'throughSequence', v_through, 'throughEventHash', v_hash
  ), 'system');
  return jsonb_build_object('duplicate', v_duplicate, 'checkpointId', v_checkpoint.id,
    'jobId', v_job.id, 'state', 'queued');
end;
$$;

create or replace function public.civya_service_complete_audit_archive(
  p_checkpoint_id uuid,
  p_object_reference text,
  p_object_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_checkpoint private.audit_archive_checkpoints%rowtype;
begin
  perform private.civya_service_required();
  select * into v_checkpoint from private.audit_archive_checkpoints
  where id = p_checkpoint_id for update;
  if not found then raise exception 'audit archive checkpoint not found' using errcode = 'P0002'; end if;
  if v_checkpoint.state = 'verified' then
    if v_checkpoint.object_reference = p_object_reference
       and v_checkpoint.object_sha256 = p_object_sha256 then
      return jsonb_build_object('checkpointId', v_checkpoint.id, 'state', v_checkpoint.state,
        'throughSequence', v_checkpoint.through_sequence,
        'throughEventHash', v_checkpoint.through_event_hash);
    end if;
    raise exception 'verified audit archive cannot change' using errcode = '55000';
  end if;
  update private.audit_archive_checkpoints
  set state = 'verified', object_reference = p_object_reference,
      object_sha256 = p_object_sha256, verified_at = now(), last_error_code = null
  where id = p_checkpoint_id and state in ('queued', 'failed')
  returning * into v_checkpoint;
  if not found then raise exception 'mutable audit archive checkpoint not found' using errcode = '55000'; end if;
  insert into public.audit_events (tenant_id, event_type, redacted_payload, source)
  values (v_checkpoint.tenant_id, 'audit_archive_verified', jsonb_build_object(
    'checkpointId', v_checkpoint.id,
    'throughSequence', v_checkpoint.through_sequence,
    'throughEventHash', v_checkpoint.through_event_hash,
    'objectSha256', v_checkpoint.object_sha256
  ), 'system');
  return jsonb_build_object('checkpointId', v_checkpoint.id, 'state', v_checkpoint.state,
    'throughSequence', v_checkpoint.through_sequence,
    'throughEventHash', v_checkpoint.through_event_hash);
end;
$$;

revoke insert, update, delete on public.audit_events from public, anon, authenticated, service_role;
revoke all on function public.civya_service_verify_audit_chain(uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_request_audit_archive(uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_complete_audit_archive(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.civya_service_verify_audit_chain(uuid) to service_role;
grant execute on function public.civya_service_request_audit_archive(uuid, bigint, text) to service_role;
grant execute on function public.civya_service_complete_audit_archive(uuid, text, text) to service_role;
