-- The remote project recorded the original phone-turn migration without its
-- objects. Recreate the transcript-free ledger before enabling PSTN traffic.

create table if not exists private.phone_turn_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  call_reference_digest text not null check (call_reference_digest ~ '^[0-9a-f]{64}$'),
  provider_item_id text not null check (provider_item_id ~ '^[A-Za-z0-9_-]{6,200}$'),
  idempotency_key text not null check (idempotency_key ~ '^phone_turn_[0-9a-f]{64}_[A-Za-z0-9_-]{6,200}$'),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'processing' check (state in ('processing', 'completed', 'failed')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 8),
  processing_owner text,
  processing_token uuid,
  processing_lease_expires_at timestamptz,
  response_payload jsonb,
  response_sha256 text check (response_sha256 is null or response_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, call_reference_digest, provider_item_id),
  check (response_payload is null or jsonb_typeof(response_payload) = 'object'),
  check (response_payload is null or octet_length(response_payload::text) <= 16000),
  check (
    (state = 'processing' and processing_owner is not null and processing_token is not null
      and processing_lease_expires_at is not null and response_payload is null)
    or (state = 'completed' and processing_owner is null and processing_token is null
      and processing_lease_expires_at is null and response_payload is not null and response_sha256 is not null)
    or (state = 'failed' and processing_owner is null and processing_token is null
      and processing_lease_expires_at is null and response_payload is null and error_code is not null)
  )
);

create index if not exists phone_turn_results_lease_idx
  on private.phone_turn_results (processing_lease_expires_at)
  where state = 'processing';

create or replace function public.civya_service_claim_phone_turn(
  p_tenant_id uuid,
  p_call_reference_digest text,
  p_provider_item_id text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_processing_owner text,
  p_lease_seconds integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_turn private.phone_turn_results%rowtype;
  v_token uuid := gen_random_uuid();
begin
  perform private.civya_service_required();
  if p_lease_seconds < 5 or p_lease_seconds > 60 then
    raise exception 'phone turn lease must be between 5 and 60 seconds' using errcode = '22023';
  end if;
  if nullif(trim(p_processing_owner), '') is null then
    raise exception 'phone turn processing owner required' using errcode = '22023';
  end if;

  insert into private.phone_turn_results (
    tenant_id, call_reference_digest, provider_item_id, idempotency_key,
    request_sha256, processing_owner, processing_token, processing_lease_expires_at
  ) values (
    p_tenant_id, p_call_reference_digest, p_provider_item_id, p_idempotency_key,
    p_request_sha256, p_processing_owner, v_token,
    now() + make_interval(secs => p_lease_seconds)
  ) on conflict (tenant_id, idempotency_key) do nothing
  returning * into v_turn;

  if found then
    return jsonb_build_object(
      'id', v_turn.id, 'state', v_turn.state, 'claimed', true,
      'duplicate', false, 'busy', false, 'attempt', v_turn.attempt_count,
      'processingToken', v_turn.processing_token,
      'leaseExpiresAt', v_turn.processing_lease_expires_at
    );
  end if;

  select * into strict v_turn from private.phone_turn_results
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
  for update;

  if v_turn.call_reference_digest <> p_call_reference_digest
     or v_turn.provider_item_id <> p_provider_item_id
     or v_turn.request_sha256 <> p_request_sha256 then
    raise exception 'phone turn idempotency key reused with different input' using errcode = '23505';
  end if;
  if v_turn.state = 'completed' then
    return jsonb_build_object(
      'id', v_turn.id, 'state', v_turn.state, 'claimed', false,
      'duplicate', true, 'busy', false, 'attempt', v_turn.attempt_count,
      'processingToken', null, 'leaseExpiresAt', null,
      'responsePayload', v_turn.response_payload,
      'responseSha256', v_turn.response_sha256
    );
  end if;
  if v_turn.state = 'processing' and v_turn.processing_lease_expires_at > now() then
    return jsonb_build_object(
      'id', v_turn.id, 'state', v_turn.state, 'claimed', false,
      'duplicate', true, 'busy', true, 'attempt', v_turn.attempt_count,
      'processingToken', null, 'leaseExpiresAt', v_turn.processing_lease_expires_at,
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_turn.processing_lease_expires_at - now())))::integer)
    );
  end if;
  if v_turn.attempt_count >= 8 then
    update private.phone_turn_results set
      state = 'failed', processing_owner = null, processing_token = null,
      processing_lease_expires_at = null, error_code = 'phone_turn_attempts_exhausted', updated_at = now()
    where id = v_turn.id returning * into v_turn;
    return jsonb_build_object(
      'id', v_turn.id, 'state', v_turn.state, 'claimed', false,
      'duplicate', true, 'busy', false, 'attempt', v_turn.attempt_count,
      'processingToken', null, 'leaseExpiresAt', null
    );
  end if;

  update private.phone_turn_results set
    state = 'processing', attempt_count = attempt_count + 1,
    processing_owner = p_processing_owner, processing_token = v_token,
    processing_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    error_code = null, updated_at = now()
  where id = v_turn.id returning * into v_turn;
  return jsonb_build_object(
    'id', v_turn.id, 'state', v_turn.state, 'claimed', true,
    'duplicate', true, 'busy', false, 'attempt', v_turn.attempt_count,
    'processingToken', v_turn.processing_token, 'leaseExpiresAt', v_turn.processing_lease_expires_at
  );
end;
$$;

create or replace function public.civya_service_finish_phone_turn(
  p_turn_id uuid, p_processing_owner text, p_processing_token uuid, p_response_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_count integer;
begin
  perform private.civya_service_required();
  if jsonb_typeof(p_response_payload) <> 'object' or octet_length(p_response_payload::text) > 16000 then
    raise exception 'phone turn response payload is invalid' using errcode = '22023';
  end if;
  update private.phone_turn_results set
    state = 'completed', response_payload = p_response_payload,
    response_sha256 = encode(sha256(convert_to(p_response_payload::text, 'UTF8')), 'hex'),
    processing_owner = null, processing_token = null, processing_lease_expires_at = null,
    error_code = null, updated_at = now()
  where id = p_turn_id and state = 'processing' and processing_owner = p_processing_owner
    and processing_token = p_processing_token and processing_lease_expires_at > now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.civya_service_fail_phone_turn(
  p_turn_id uuid, p_processing_owner text, p_processing_token uuid, p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_count integer;
begin
  perform private.civya_service_required();
  update private.phone_turn_results set
    state = 'failed', error_code = left(coalesce(nullif(p_error_code, ''), 'phone_turn_failed'), 100),
    processing_owner = null, processing_token = null, processing_lease_expires_at = null, updated_at = now()
  where id = p_turn_id and state = 'processing' and processing_owner = p_processing_owner
    and processing_token = p_processing_token;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on table private.phone_turn_results from public, anon, authenticated;
revoke all on function public.civya_service_claim_phone_turn(uuid, text, text, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.civya_service_finish_phone_turn(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.civya_service_fail_phone_turn(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.civya_service_claim_phone_turn(uuid, text, text, text, text, text, integer) to service_role;
grant execute on function public.civya_service_finish_phone_turn(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.civya_service_fail_phone_turn(uuid, text, uuid, text) to service_role;
