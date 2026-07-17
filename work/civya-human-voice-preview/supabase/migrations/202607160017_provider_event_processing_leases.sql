-- Crash-safe provider event processing.
--
-- Recording an event and beginning its external effect must be one atomic
-- database operation. A duplicate is acknowledged only after the event is
-- terminally processed. In-flight work has a short lease so a delivery can be
-- retried after a process crash without allowing concurrent execution.

alter table private.provider_events
  add column if not exists processing_owner text,
  add column if not exists processing_token uuid,
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_lease_expires_at timestamptz,
  add column if not exists processing_attempts integer not null default 0,
  add column if not exists max_processing_attempts integer not null default 8,
  add column if not exists available_at timestamptz not null default now();

alter table private.provider_events
  drop constraint if exists provider_events_state_check;
alter table private.provider_events
  add constraint provider_events_state_check
  check (state in ('received', 'processing', 'rejected', 'processed', 'failed'));
alter table private.provider_events
  add constraint provider_events_processing_attempts_check
  check (processing_attempts >= 0 and max_processing_attempts between 1 and 100);
alter table private.provider_events
  add constraint provider_events_processing_lease_check
  check (
    (state = 'processing'
      and processing_owner is not null
      and processing_token is not null
      and processing_started_at is not null
      and processing_lease_expires_at is not null
      and processing_lease_expires_at > processing_started_at)
    or (state <> 'processing'
      and processing_owner is null
      and processing_token is null
      and processing_started_at is null
      and processing_lease_expires_at is null)
  );

create index provider_events_reclaim_idx
  on private.provider_events (processing_lease_expires_at, received_at)
  where state = 'processing';

create or replace function public.civya_service_claim_provider_event(
  p_tenant_id uuid,
  p_provider_key text,
  p_external_event_id text,
  p_event_type text,
  p_payload_sha256 text,
  p_redacted_payload jsonb,
  p_signature_verified boolean,
  p_processing_owner text,
  p_lease_seconds integer default 30,
  p_max_attempts integer default 8
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_event private.provider_events%rowtype;
  v_duplicate boolean := false;
  v_retry_after integer := 0;
begin
  perform private.civya_service_required();
  if nullif(trim(p_processing_owner), '') is null or length(p_processing_owner) > 200 then
    raise exception 'provider event processing owner is required' using errcode = '22023';
  end if;
  if p_lease_seconds < 5 or p_lease_seconds > 300 then
    raise exception 'provider event lease must be between 5 and 300 seconds'
      using errcode = '22023';
  end if;
  if p_max_attempts < 1 or p_max_attempts > 100 then
    raise exception 'provider event max attempts must be between 1 and 100'
      using errcode = '22023';
  end if;

  insert into private.provider_events (
    tenant_id, provider_key, external_event_id, event_type, payload_sha256,
    redacted_payload, signature_verified, state, processing_owner,
    processing_token, processing_started_at, processing_lease_expires_at,
    processing_attempts, max_processing_attempts, available_at
  ) values (
    p_tenant_id, p_provider_key, p_external_event_id, p_event_type,
    p_payload_sha256, coalesce(p_redacted_payload, '{}'::jsonb),
    p_signature_verified,
    case when p_signature_verified then 'processing' else 'rejected' end,
    case when p_signature_verified then p_processing_owner else null end,
    case when p_signature_verified then gen_random_uuid() else null end,
    case when p_signature_verified then now() else null end,
    case when p_signature_verified then now() + make_interval(secs => p_lease_seconds) else null end,
    case when p_signature_verified then 1 else 0 end,
    p_max_attempts,
    now()
  ) on conflict (tenant_id, provider_key, external_event_id) do nothing
  returning * into v_event;

  if found then
    return jsonb_build_object(
      'id', v_event.id,
      'state', v_event.state,
      'claimed', v_event.state = 'processing',
      'duplicate', false,
      'busy', false,
      'attempt', v_event.processing_attempts,
      'maxAttempts', v_event.max_processing_attempts,
      'processingToken', v_event.processing_token,
      'leaseExpiresAt', v_event.processing_lease_expires_at
    );
  end if;

  v_duplicate := true;
  select * into strict v_event
  from private.provider_events
  where tenant_id = p_tenant_id
    and provider_key = p_provider_key
    and external_event_id = p_external_event_id
  for update;

  if v_event.payload_sha256 <> p_payload_sha256
     or v_event.event_type <> p_event_type
     or v_event.signature_verified <> p_signature_verified then
    raise exception 'provider event id reused with different payload or verification state'
      using errcode = '23505';
  end if;

  if v_event.state in ('processed', 'rejected', 'failed') then
    return jsonb_build_object(
      'id', v_event.id,
      'state', v_event.state,
      'claimed', false,
      'duplicate', true,
      'busy', false,
      'attempt', v_event.processing_attempts,
      'maxAttempts', v_event.max_processing_attempts,
      'processingToken', null,
      'leaseExpiresAt', null
    );
  end if;

  if v_event.state = 'processing' and v_event.processing_lease_expires_at > now() then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_event.processing_lease_expires_at - now())))::integer
    );
    return jsonb_build_object(
      'id', v_event.id,
      'state', v_event.state,
      'claimed', false,
      'duplicate', true,
      'busy', true,
      'retryAfterSeconds', v_retry_after,
      'attempt', v_event.processing_attempts,
      'maxAttempts', v_event.max_processing_attempts,
      'processingToken', null,
      'leaseExpiresAt', v_event.processing_lease_expires_at
    );
  end if;

  if v_event.state = 'received' and v_event.available_at > now() then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_event.available_at - now())))::integer
    );
    return jsonb_build_object(
      'id', v_event.id,
      'state', v_event.state,
      'claimed', false,
      'duplicate', true,
      'busy', true,
      'retryAfterSeconds', v_retry_after,
      'attempt', v_event.processing_attempts,
      'maxAttempts', v_event.max_processing_attempts,
      'processingToken', null,
      'leaseExpiresAt', null
    );
  end if;

  if v_event.processing_attempts >= v_event.max_processing_attempts then
    update private.provider_events
    set state = 'failed',
        processing_owner = null,
        processing_token = null,
        processing_started_at = null,
        processing_lease_expires_at = null,
        last_error_code = 'processing_attempts_exhausted'
    where id = v_event.id
    returning * into v_event;
    return jsonb_build_object(
      'id', v_event.id,
      'state', v_event.state,
      'claimed', false,
      'duplicate', true,
      'busy', false,
      'attempt', v_event.processing_attempts,
      'maxAttempts', v_event.max_processing_attempts,
      'processingToken', null,
      'leaseExpiresAt', null
    );
  end if;

  update private.provider_events
  set state = 'processing',
      processing_owner = p_processing_owner,
      processing_token = gen_random_uuid(),
      processing_started_at = now(),
      processing_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      processing_attempts = processing_attempts + 1,
      processed_at = null,
      last_error_code = null
  where id = v_event.id
  returning * into v_event;

  return jsonb_build_object(
    'id', v_event.id,
    'state', v_event.state,
    'claimed', true,
    'duplicate', v_duplicate,
    'busy', false,
    'attempt', v_event.processing_attempts,
    'maxAttempts', v_event.max_processing_attempts,
    'processingToken', v_event.processing_token,
    'leaseExpiresAt', v_event.processing_lease_expires_at
  );
end;
$$;

create or replace function public.civya_service_finish_provider_event_claim(
  p_event_id uuid,
  p_processing_owner text,
  p_processing_token uuid,
  p_outcome text,
  p_error_code text default null,
  p_retry_delay_seconds integer default 15
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  perform private.civya_service_required();
  if p_outcome not in ('processed', 'retry', 'failed') then
    raise exception 'invalid provider event completion outcome' using errcode = '22023';
  end if;
  if p_retry_delay_seconds < 0 or p_retry_delay_seconds > 3600 then
    raise exception 'provider event retry delay must be between 0 and 3600 seconds'
      using errcode = '22023';
  end if;
  update private.provider_events
  set state = case
        when p_outcome = 'processed' then 'processed'
        when p_outcome = 'retry' and processing_attempts < max_processing_attempts then 'received'
        else 'failed'
      end,
      processed_at = case when p_outcome = 'processed' then now() else null end,
      available_at = case
        when p_outcome = 'retry' and processing_attempts < max_processing_attempts
          then now() + make_interval(secs => p_retry_delay_seconds)
        else available_at
      end,
      last_error_code = case
        when p_outcome = 'processed' then null
        when p_outcome = 'retry' and processing_attempts >= max_processing_attempts
          then 'processing_attempts_exhausted'
        else p_error_code
      end,
      processing_owner = null,
      processing_token = null,
      processing_started_at = null,
      processing_lease_expires_at = null
  where id = p_event_id
    and state = 'processing'
    and processing_owner = p_processing_owner
    and processing_token = p_processing_token
    and processing_lease_expires_at > now();
  return found;
end;
$$;

-- Include failed and expired in-flight events in the readiness/operations debt
-- count. The original function counted only never-claimed receipts.
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
    'unprocessedProviderEvents', (
      select count(*)::integer from private.provider_events
      where state = 'received'
        or (state = 'processing' and processing_lease_expires_at <= now())
    ),
    'leasedProviderEvents', (
      select count(*)::integer from private.provider_events
      where state = 'processing' and processing_lease_expires_at > now()
    ),
    'pendingOutbox', (select count(*)::integer from private.outbox_events where state = 'pending')
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.civya_service_claim_provider_event(
  uuid, text, text, text, text, jsonb, boolean, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.civya_service_finish_provider_event_claim(uuid, text, uuid, text, text, integer)
  from public, anon, authenticated;
-- Existing non-call provider repositories retain the original record/mark
-- API. OpenAI and Twilio webhook entry points use the claim/finish API below,
-- so duplicate call effects are fenced without breaking independent payment
-- and reconciliation streams during their later repository migrations.

grant execute on function public.civya_service_claim_provider_event(
  uuid, text, text, text, text, jsonb, boolean, text, integer, integer
) to service_role;
grant execute on function public.civya_service_finish_provider_event_claim(uuid, text, uuid, text, text, integer)
  to service_role;

comment on function public.civya_service_claim_provider_event(
  uuid, text, text, text, text, jsonb, boolean, text, integer, integer
) is 'Atomically records and leases one verified provider event. Active duplicates retry; expired leases are fenced by a rotated database token.';
