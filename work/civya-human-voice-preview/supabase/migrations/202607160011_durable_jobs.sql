-- Durable jobs, transactional outbox, provider-event deduplication, and
-- external-operation idempotency. All mutable work state is private and every
-- application/worker mutation crosses a service-only security-definer RPC.

create table private.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  job_type text not null check (job_type ~ '^[a-z0-9][a-z0-9._-]*$'),
  schema_version text not null default '1',
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  idempotency_key text not null,
  source_type text,
  source_id uuid,
  priority smallint not null default 0 check (priority between -100 and 100),
  deadline_at timestamptz,
  state text not null default 'queued'
    check (state in ('queued', 'leased', 'retry_wait', 'succeeded', 'dead_letter', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 100),
  timeout_seconds integer not null default 300 check (timeout_seconds between 1 and 86400),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  last_error_code text,
  last_error_redacted text,
  replay_of_job_id uuid references private.jobs(id) on delete restrict,
  replay_authorized_by_auth_user_id uuid references auth.users(id) on delete set null,
  replay_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, job_type, idempotency_key),
  check (
    (state = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'leased' and lease_owner is null and lease_expires_at is null)
  ),
  check (
    replay_of_job_id is null
    or (replay_authorized_by_auth_user_id is not null and nullif(replay_reason, '') is not null)
  )
);

create table private.job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references private.jobs(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  worker_id text not null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('succeeded', 'retry', 'dead_letter', 'cancelled', 'lease_expired')),
  error_code text,
  error_redacted text,
  unique (job_id, attempt_number),
  check ((finished_at is null and outcome is null) or (finished_at is not null and outcome is not null))
);

create table private.outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  aggregate_type text not null,
  aggregate_id uuid,
  event_type text not null check (event_type ~ '^[a-z0-9][a-z0-9._-]*$'),
  schema_version text not null default '1',
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  idempotency_key text not null,
  state text not null default 'pending' check (state in ('pending', 'enqueued', 'failed')),
  job_id uuid references private.jobs(id) on delete restrict,
  dispatch_attempts integer not null default 0 check (dispatch_attempts >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  enqueued_at timestamptz,
  unique (tenant_id, idempotency_key)
);

create table private.external_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  provider_key text not null check (provider_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  operation_kind text not null check (operation_kind ~ '^[a-z0-9][a-z0-9._-]*$'),
  idempotency_key text not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  request_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(request_metadata) = 'object'),
  state text not null default 'planned'
    check (state in ('planned', 'in_flight', 'succeeded', 'failed_unknown', 'failed_terminal')),
  external_reference text,
  response_metadata jsonb check (response_metadata is null or jsonb_typeof(response_metadata) = 'object'),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, provider_key, operation_kind, idempotency_key)
);

create table private.provider_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  provider_key text not null check (provider_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  external_event_id text not null,
  event_type text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_payload) = 'object'),
  signature_verified boolean not null,
  state text not null check (state in ('received', 'rejected', 'processed', 'failed')),
  job_id uuid references private.jobs(id) on delete restrict,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_code text,
  unique (tenant_id, provider_key, external_event_id)
);

create index jobs_claim_idx
  on private.jobs (priority desc, deadline_at, available_at, created_at)
  where state in ('queued', 'retry_wait', 'leased');
create index jobs_tenant_state_idx
  on private.jobs (tenant_id, state, created_at);
create index jobs_dead_letter_idx
  on private.jobs (tenant_id, completed_at desc)
  where state = 'dead_letter';
create index outbox_pending_idx
  on private.outbox_events (created_at)
  where state = 'pending';
create index provider_events_state_idx
  on private.provider_events (tenant_id, provider_key, state, received_at);

create trigger set_updated_at before update on private.jobs
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on private.external_operations
  for each row execute function private.set_updated_at();

alter table private.jobs enable row level security;
alter table private.job_attempts enable row level security;
alter table private.outbox_events enable row level security;
alter table private.external_operations enable row level security;
alter table private.provider_events enable row level security;

revoke all on private.jobs from public, anon, authenticated, service_role;
revoke all on private.job_attempts from public, anon, authenticated, service_role;
revoke all on private.outbox_events from public, anon, authenticated, service_role;
revoke all on private.external_operations from public, anon, authenticated, service_role;
revoke all on private.provider_events from public, anon, authenticated, service_role;

create or replace function private.civya_job_to_json(p_job private.jobs)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select jsonb_build_object(
    'id', p_job.id,
    'tenantId', p_job.tenant_id,
    'type', p_job.job_type,
    'schemaVersion', p_job.schema_version,
    'payload', p_job.payload,
    'idempotencyKey', p_job.idempotency_key,
    'sourceType', p_job.source_type,
    'sourceId', p_job.source_id,
    'priority', p_job.priority,
    'deadlineAt', p_job.deadline_at,
    'state', p_job.state,
    'attempt', p_job.attempt_count,
    'maxAttempts', p_job.max_attempts,
    'timeoutSeconds', p_job.timeout_seconds,
    'availableAt', p_job.available_at,
    'leaseOwner', p_job.lease_owner,
    'leaseExpiresAt', p_job.lease_expires_at,
    'createdAt', p_job.created_at
  )
$$;

revoke all on function private.civya_job_to_json(private.jobs)
  from public, anon, authenticated, service_role;

create or replace function public.civya_service_enqueue_job(
  p_tenant_id uuid,
  p_job_type text,
  p_schema_version text,
  p_payload jsonb,
  p_idempotency_key text,
  p_priority integer default 0,
  p_deadline_at timestamptz default null,
  p_max_attempts integer default 8,
  p_timeout_seconds integer default 300,
  p_available_at timestamptz default now(),
  p_source_type text default null,
  p_source_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_job private.jobs%rowtype; v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  if jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then
    raise exception 'job payload must be an object' using errcode = '22023';
  end if;
  insert into private.jobs (
    tenant_id, job_type, schema_version, payload, idempotency_key,
    priority, deadline_at, max_attempts, timeout_seconds, available_at,
    source_type, source_id
  ) values (
    p_tenant_id, p_job_type, p_schema_version, coalesce(p_payload, '{}'::jsonb),
    p_idempotency_key, p_priority, p_deadline_at, p_max_attempts,
    p_timeout_seconds, coalesce(p_available_at, now()), p_source_type, p_source_id
  ) on conflict (tenant_id, job_type, idempotency_key) do nothing
  returning * into v_job;
  if not found then
    v_duplicate := true;
    select * into strict v_job from private.jobs
    where tenant_id = p_tenant_id
      and job_type = p_job_type
      and idempotency_key = p_idempotency_key;
  end if;
  return jsonb_build_object('duplicate', v_duplicate, 'job', private.civya_job_to_json(v_job));
end;
$$;

create or replace function public.civya_service_claim_jobs(
  p_worker_id text,
  p_capabilities text[],
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_job private.jobs%rowtype; v_jobs jsonb := '[]'::jsonb;
begin
  perform private.civya_service_required();
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'worker id is required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_capabilities, 1), 0) = 0 then return v_jobs; end if;
  p_limit := least(greatest(p_limit, 1), 100);
  p_lease_seconds := least(greatest(p_lease_seconds, 10), 3600);

  update private.job_attempts a
  set finished_at = now(), outcome = 'lease_expired', error_code = 'worker_lease_expired'
  from private.jobs j
  where j.id = a.job_id
    and j.state = 'leased'
    and j.lease_expires_at <= now()
    and a.attempt_number = j.attempt_count
    and a.finished_at is null;

  update private.jobs
  set state = 'dead_letter',
      lease_owner = null,
      lease_expires_at = null,
      heartbeat_at = null,
      completed_at = now(),
      last_error_code = 'worker_lease_expired',
      last_error_redacted = 'Worker lease expired after the final allowed attempt.'
  where state = 'leased'
    and lease_expires_at <= now()
    and attempt_count >= max_attempts;

  for v_job in
    select *
    from private.jobs j
    where j.job_type = any(p_capabilities)
      and j.attempt_count < j.max_attempts
      and (
        (j.state in ('queued', 'retry_wait') and j.available_at <= now())
        or (j.state = 'leased' and j.lease_expires_at <= now())
      )
    order by j.priority desc, j.deadline_at asc nulls last, j.available_at, j.created_at
    for update skip locked
    limit p_limit
  loop
    update private.jobs
    set state = 'leased',
        attempt_count = attempt_count + 1,
        lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        heartbeat_at = now(),
        last_error_code = null,
        last_error_redacted = null
    where id = v_job.id
    returning * into v_job;

    insert into private.job_attempts (job_id, attempt_number, worker_id)
    values (v_job.id, v_job.attempt_count, p_worker_id);
    v_jobs := v_jobs || jsonb_build_array(private.civya_job_to_json(v_job));
  end loop;
  return v_jobs;
end;
$$;

create or replace function public.civya_service_heartbeat_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_attempt integer;
begin
  perform private.civya_service_required();
  p_lease_seconds := least(greatest(p_lease_seconds, 10), 3600);
  update private.jobs
  set heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_job_id
    and state = 'leased'
    and lease_owner = p_worker_id
    and lease_expires_at > now()
  returning attempt_count into v_attempt;
  if not found then return false; end if;
  update private.job_attempts set heartbeat_at = now()
  where job_id = p_job_id and attempt_number = v_attempt and finished_at is null;
  return true;
end;
$$;

create or replace function public.civya_service_complete_job(
  p_job_id uuid,
  p_worker_id text,
  p_result jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_job private.jobs%rowtype;
begin
  perform private.civya_service_required();
  if jsonb_typeof(coalesce(p_result, '{}'::jsonb)) <> 'object' then
    raise exception 'job result must be an object' using errcode = '22023';
  end if;
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.state <> 'leased' or v_job.lease_owner <> p_worker_id
     or v_job.lease_expires_at <= now() then
    raise exception 'active job lease not found' using errcode = '55000';
  end if;
  update private.jobs
  set state = 'succeeded', result = coalesce(p_result, '{}'::jsonb), completed_at = now(),
      lease_owner = null, lease_expires_at = null, heartbeat_at = null
  where id = p_job_id returning * into v_job;
  update private.job_attempts
  set heartbeat_at = now(), finished_at = now(), outcome = 'succeeded'
  where job_id = p_job_id and attempt_number = v_job.attempt_count and finished_at is null;
  return private.civya_job_to_json(v_job);
end;
$$;

create or replace function public.civya_service_fail_job(
  p_job_id uuid,
  p_worker_id text,
  p_retryable boolean,
  p_error_code text,
  p_error_redacted text,
  p_retry_delay_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_job private.jobs%rowtype; v_next_state text; v_outcome text;
begin
  perform private.civya_service_required();
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.state <> 'leased' or v_job.lease_owner <> p_worker_id
     or v_job.lease_expires_at <= now() then
    raise exception 'active job lease not found' using errcode = '55000';
  end if;
  if p_retryable and v_job.attempt_count < v_job.max_attempts then
    v_next_state := 'retry_wait'; v_outcome := 'retry';
  else
    v_next_state := 'dead_letter'; v_outcome := 'dead_letter';
  end if;
  update private.jobs
  set state = v_next_state,
      available_at = case when v_next_state = 'retry_wait'
        then now() + make_interval(secs => least(greatest(p_retry_delay_seconds, 0), 86400))
        else available_at end,
      last_error_code = left(coalesce(p_error_code, 'job_failed'), 120),
      last_error_redacted = left(coalesce(p_error_redacted, 'Job failed.'), 1000),
      completed_at = case when v_next_state = 'dead_letter' then now() else null end,
      lease_owner = null, lease_expires_at = null, heartbeat_at = null
  where id = p_job_id returning * into v_job;
  update private.job_attempts
  set heartbeat_at = now(), finished_at = now(), outcome = v_outcome,
      error_code = v_job.last_error_code, error_redacted = v_job.last_error_redacted
  where job_id = p_job_id and attempt_number = v_job.attempt_count and finished_at is null;
  return private.civya_job_to_json(v_job);
end;
$$;

create or replace function public.civya_service_cancel_job(
  p_job_id uuid,
  p_actor_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_job private.jobs%rowtype;
begin
  perform private.civya_service_required();
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if not private.civya_actor_is_staff(p_actor_user_id, v_job.tenant_id, 'admin') then
    raise exception 'tenant admin required' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'cancellation reason is required' using errcode = '22023';
  end if;
  if v_job.state in ('succeeded', 'dead_letter', 'cancelled') then
    raise exception 'terminal job cannot be cancelled' using errcode = '55000';
  end if;
  update private.job_attempts
  set heartbeat_at = now(), finished_at = now(), outcome = 'cancelled'
  where job_id = v_job.id and attempt_number = v_job.attempt_count and finished_at is null;
  update private.jobs
  set state = 'cancelled', completed_at = now(), lease_owner = null,
      lease_expires_at = null, heartbeat_at = null,
      last_error_code = 'cancelled_by_admin', last_error_redacted = left(p_reason, 1000)
  where id = v_job.id returning * into v_job;
  insert into public.audit_events (tenant_id, actor_user_id, event_type, redacted_payload, source)
  values (v_job.tenant_id, p_actor_user_id, 'durable_job_cancelled',
    jsonb_build_object('jobId', v_job.id, 'jobType', v_job.job_type, 'reason', left(p_reason, 500)), 'admin');
  return private.civya_job_to_json(v_job);
end;
$$;

create or replace function public.civya_service_replay_job(
  p_job_id uuid,
  p_new_idempotency_key text,
  p_actor_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_original private.jobs%rowtype; v_job private.jobs%rowtype;
begin
  perform private.civya_service_required();
  select * into v_original from private.jobs where id = p_job_id for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  if v_original.state not in ('dead_letter', 'cancelled') then
    raise exception 'only dead-letter or cancelled jobs may be replayed' using errcode = '55000';
  end if;
  if not private.civya_actor_is_staff(p_actor_user_id, v_original.tenant_id, 'admin') then
    raise exception 'tenant admin required' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'replay reason is required' using errcode = '22023'; end if;
  insert into private.jobs (
    tenant_id, job_type, schema_version, payload, idempotency_key, source_type,
    source_id, priority, deadline_at, max_attempts, timeout_seconds,
    replay_of_job_id, replay_authorized_by_auth_user_id, replay_reason
  ) values (
    v_original.tenant_id, v_original.job_type, v_original.schema_version,
    v_original.payload, p_new_idempotency_key, v_original.source_type,
    v_original.source_id, v_original.priority, v_original.deadline_at,
    v_original.max_attempts, v_original.timeout_seconds, v_original.id,
    p_actor_user_id, left(p_reason, 1000)
  ) returning * into v_job;
  insert into public.audit_events (tenant_id, actor_user_id, event_type, redacted_payload, source)
  values (v_job.tenant_id, p_actor_user_id, 'durable_job_replayed',
    jsonb_build_object('originalJobId', v_original.id, 'newJobId', v_job.id,
      'jobType', v_job.job_type, 'reason', left(p_reason, 500)), 'admin');
  return private.civya_job_to_json(v_job);
end;
$$;

create or replace function public.civya_service_append_outbox_event(
  p_tenant_id uuid,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_schema_version text,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_event private.outbox_events%rowtype; v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  insert into private.outbox_events (
    tenant_id, aggregate_type, aggregate_id, event_type, schema_version, payload, idempotency_key
  ) values (
    p_tenant_id, p_aggregate_type, p_aggregate_id, p_event_type, p_schema_version,
    coalesce(p_payload, '{}'::jsonb), p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_event;
  if not found then
    v_duplicate := true;
    select * into strict v_event from private.outbox_events
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  end if;
  return jsonb_build_object('id', v_event.id, 'state', v_event.state, 'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_dispatch_outbox(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_event private.outbox_events%rowtype; v_job private.jobs%rowtype; v_jobs jsonb := '[]'::jsonb;
begin
  perform private.civya_service_required();
  p_limit := least(greatest(p_limit, 1), 1000);
  for v_event in
    select * from private.outbox_events
    where state = 'pending'
    order by created_at
    for update skip locked
    limit p_limit
  loop
    insert into private.jobs (
      tenant_id, job_type, schema_version, payload, idempotency_key, source_type, source_id
    ) values (
      v_event.tenant_id, 'outbox.' || v_event.event_type, v_event.schema_version,
      v_event.payload || jsonb_build_object('outboxEventId', v_event.id),
      'outbox:' || v_event.id::text, 'outbox_event', v_event.id
    ) on conflict (tenant_id, job_type, idempotency_key) do update
      set updated_at = private.jobs.updated_at
    returning * into v_job;
    update private.outbox_events
    set state = 'enqueued', job_id = v_job.id, enqueued_at = now(), dispatch_attempts = dispatch_attempts + 1
    where id = v_event.id;
    v_jobs := v_jobs || jsonb_build_array(private.civya_job_to_json(v_job));
  end loop;
  return v_jobs;
end;
$$;

create or replace function public.civya_service_reserve_external_operation(
  p_tenant_id uuid,
  p_provider_key text,
  p_operation_kind text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_request_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_operation private.external_operations%rowtype; v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  insert into private.external_operations (
    tenant_id, provider_key, operation_kind, idempotency_key, request_sha256, request_metadata
  ) values (
    p_tenant_id, p_provider_key, p_operation_kind, p_idempotency_key,
    p_request_sha256, coalesce(p_request_metadata, '{}'::jsonb)
  ) on conflict (tenant_id, provider_key, operation_kind, idempotency_key) do nothing
  returning * into v_operation;
  if not found then
    v_duplicate := true;
    select * into strict v_operation from private.external_operations
    where tenant_id = p_tenant_id and provider_key = p_provider_key
      and operation_kind = p_operation_kind and idempotency_key = p_idempotency_key;
    if v_operation.request_sha256 <> p_request_sha256 then
      raise exception 'idempotency key reused with different request' using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object('id', v_operation.id, 'state', v_operation.state,
    'externalReference', v_operation.external_reference, 'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_finish_external_operation(
  p_operation_id uuid,
  p_state text,
  p_external_reference text default null,
  p_response_metadata jsonb default '{}'::jsonb,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_operation private.external_operations%rowtype;
begin
  perform private.civya_service_required();
  select * into v_operation from private.external_operations
  where id = p_operation_id for update;
  if not found then raise exception 'external operation not found' using errcode = 'P0002'; end if;
  if v_operation.state in ('succeeded', 'failed_terminal') then
    if v_operation.state = p_state
       and v_operation.external_reference is not distinct from coalesce(p_external_reference, v_operation.external_reference) then
      return jsonb_build_object('id', v_operation.id, 'state', v_operation.state,
        'externalReference', v_operation.external_reference);
    end if;
    raise exception 'terminal external operation cannot change' using errcode = '55000';
  end if;
  if p_state not in ('in_flight', 'succeeded', 'failed_unknown', 'failed_terminal') then
    raise exception 'invalid external operation state' using errcode = '22023';
  end if;
  update private.external_operations
  set state = p_state,
      external_reference = coalesce(p_external_reference, external_reference),
      response_metadata = coalesce(p_response_metadata, '{}'::jsonb),
      last_error_code = p_error_code,
      completed_at = case when p_state in ('succeeded', 'failed_unknown', 'failed_terminal') then now() else null end
  where id = p_operation_id
  returning * into v_operation;
  return jsonb_build_object('id', v_operation.id, 'state', v_operation.state,
    'externalReference', v_operation.external_reference);
end;
$$;

create or replace function public.civya_service_record_provider_event(
  p_tenant_id uuid,
  p_provider_key text,
  p_external_event_id text,
  p_event_type text,
  p_payload_sha256 text,
  p_redacted_payload jsonb,
  p_signature_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_event private.provider_events%rowtype; v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  insert into private.provider_events (
    tenant_id, provider_key, external_event_id, event_type, payload_sha256,
    redacted_payload, signature_verified, state
  ) values (
    p_tenant_id, p_provider_key, p_external_event_id, p_event_type,
    p_payload_sha256, coalesce(p_redacted_payload, '{}'::jsonb),
    p_signature_verified, case when p_signature_verified then 'received' else 'rejected' end
  ) on conflict (tenant_id, provider_key, external_event_id) do nothing returning * into v_event;
  if not found then
    v_duplicate := true;
    select * into strict v_event from private.provider_events
    where tenant_id = p_tenant_id and provider_key = p_provider_key
      and external_event_id = p_external_event_id;
    if v_event.payload_sha256 <> p_payload_sha256 or v_event.event_type <> p_event_type then
      raise exception 'provider event id reused with different payload' using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object('id', v_event.id, 'state', v_event.state, 'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_mark_provider_event(
  p_event_id uuid,
  p_state text,
  p_job_id uuid default null,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  perform private.civya_service_required();
  if p_state not in ('processed', 'failed') then raise exception 'invalid provider event state' using errcode = '22023'; end if;
  update private.provider_events
  set state = p_state, job_id = coalesce(p_job_id, job_id), last_error_code = p_error_code,
      processed_at = case when p_state = 'processed' then now() else processed_at end
  where id = p_event_id and state = 'received';
  return found;
end;
$$;

create or replace function public.civya_service_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_result jsonb;
begin
  perform private.civya_service_required();
  select jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(state, count) from (
      select state, count(*)::integer as count from private.jobs group by state
    ) counts), '{}'::jsonb),
    'oldestReadyAgeSeconds', coalesce((select extract(epoch from (now() - min(created_at)))::integer
      from private.jobs where state in ('queued', 'retry_wait') and available_at <= now()), 0),
    'expiredLeases', (select count(*)::integer from private.jobs where state = 'leased' and lease_expires_at <= now()),
    'unprocessedProviderEvents', (select count(*)::integer from private.provider_events where state = 'received'),
    'pendingOutbox', (select count(*)::integer from private.outbox_events where state = 'pending')
  ) into v_result;
  return v_result;
end;
$$;

-- Bridge the existing sandbox retention outbox into the generic durable queue.
create or replace function private.civya_enqueue_retention_deletion_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  insert into private.jobs (
    tenant_id, job_type, schema_version, payload, idempotency_key,
    source_type, source_id, priority, max_attempts, timeout_seconds
  ) values (
    new.tenant_id, 'retention.external_delete', '1',
    jsonb_build_object('deletionId', new.id, 'kind', new.kind, 'reference', new.reference),
    'retention:' || new.id::text, 'retention_deletion', new.id, 50, 10, 300
  ) on conflict (tenant_id, job_type, idempotency_key) do nothing;
  return new;
end;
$$;

revoke all on function private.civya_enqueue_retention_deletion_job()
  from public, anon, authenticated, service_role;
create trigger retention_deletion_enqueue_job
  after insert on private.retention_deletion_queue
  for each row execute function private.civya_enqueue_retention_deletion_job();

insert into private.jobs (
  tenant_id, job_type, schema_version, payload, idempotency_key,
  source_type, source_id, priority, max_attempts, timeout_seconds
)
select q.tenant_id, 'retention.external_delete', '1',
  jsonb_build_object('deletionId', q.id, 'kind', q.kind, 'reference', q.reference),
  'retention:' || q.id::text, 'retention_deletion', q.id, 50, 10, 300
from private.retention_deletion_queue q
where q.completed_at is null and q.attempts < 10
on conflict (tenant_id, job_type, idempotency_key) do nothing;

revoke all on function public.civya_service_enqueue_job(uuid, text, text, jsonb, text, integer, timestamptz, integer, integer, timestamptz, text, uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_claim_jobs(text, text[], integer, integer)
  from public, anon, authenticated;
revoke all on function public.civya_service_heartbeat_job(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.civya_service_complete_job(uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.civya_service_fail_job(uuid, text, boolean, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.civya_service_cancel_job(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_replay_job(uuid, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_append_outbox_event(uuid, text, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_dispatch_outbox(integer)
  from public, anon, authenticated;
revoke all on function public.civya_service_reserve_external_operation(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.civya_service_finish_external_operation(uuid, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_record_provider_event(uuid, text, text, text, text, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function public.civya_service_mark_provider_event(uuid, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_job_health()
  from public, anon, authenticated;

grant execute on function public.civya_service_enqueue_job(uuid, text, text, jsonb, text, integer, timestamptz, integer, integer, timestamptz, text, uuid) to service_role;
grant execute on function public.civya_service_claim_jobs(text, text[], integer, integer) to service_role;
grant execute on function public.civya_service_heartbeat_job(uuid, text, integer) to service_role;
grant execute on function public.civya_service_complete_job(uuid, text, jsonb) to service_role;
grant execute on function public.civya_service_fail_job(uuid, text, boolean, text, text, integer) to service_role;
grant execute on function public.civya_service_cancel_job(uuid, uuid, text) to service_role;
grant execute on function public.civya_service_replay_job(uuid, text, uuid, text) to service_role;
grant execute on function public.civya_service_append_outbox_event(uuid, text, uuid, text, text, jsonb, text) to service_role;
grant execute on function public.civya_service_dispatch_outbox(integer) to service_role;
grant execute on function public.civya_service_reserve_external_operation(uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.civya_service_finish_external_operation(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.civya_service_record_provider_event(uuid, text, text, text, text, jsonb, boolean) to service_role;
grant execute on function public.civya_service_mark_provider_event(uuid, text, uuid, text) to service_role;
grant execute on function public.civya_service_job_health() to service_role;
