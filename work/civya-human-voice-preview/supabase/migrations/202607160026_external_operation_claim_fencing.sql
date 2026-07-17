-- Atomically claim non-idempotent outbound provider operations before the
-- network boundary. The original reserve/finish RPCs remain available for
-- legacy operation kinds, but cannot finish an operation that has ever entered
-- the fenced claim protocol. An expired outbound claim is deliberately
-- failed-unknown: the
-- provider may have accepted the request before the worker disappeared, so a
-- new owner must never issue a blind retry.

alter table private.external_operations
  add column claim_owner text,
  add column claim_token uuid,
  add column claim_expires_at timestamptz,
  add column claim_attempts integer not null default 0
    check (claim_attempts >= 0);

alter table private.external_operations
  add constraint external_operations_claim_shape_check check (
    (claim_owner is null and claim_token is null and claim_expires_at is null)
    or
    (claim_owner is not null and claim_token is not null and claim_expires_at is not null)
  );

create index external_operations_expired_claim_idx
  on private.external_operations (claim_expires_at)
  where state = 'in_flight' and claim_token is not null;

create or replace function public.civya_service_claim_external_operation(
  p_tenant_id uuid,
  p_provider_key text,
  p_operation_kind text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_request_metadata jsonb,
  p_claim_owner text,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_operation private.external_operations%rowtype;
  v_duplicate boolean := false;
  v_claim_token uuid;
  v_claim_expires_at timestamptz;
  v_retry_after integer;
begin
  perform private.civya_service_required();
  if p_claim_owner is null or length(trim(p_claim_owner)) < 8
     or length(trim(p_claim_owner)) > 180 then
    raise exception 'valid external operation claim owner required' using errcode = '22023';
  end if;
  if p_lease_seconds < 10 or p_lease_seconds > 300 then
    raise exception 'external operation lease must be between 10 and 300 seconds'
      using errcode = '22023';
  end if;
  if p_request_metadata is null or jsonb_typeof(p_request_metadata) <> 'object' then
    raise exception 'external operation request metadata must be an object'
      using errcode = '22023';
  end if;

  insert into private.external_operations (
    tenant_id, provider_key, operation_kind, idempotency_key,
    request_sha256, request_metadata
  ) values (
    p_tenant_id, p_provider_key, p_operation_kind, p_idempotency_key,
    p_request_sha256, p_request_metadata
  ) on conflict (tenant_id, provider_key, operation_kind, idempotency_key) do nothing;
  if not found then v_duplicate := true; end if;

  select * into strict v_operation
  from private.external_operations
  where tenant_id = p_tenant_id
    and provider_key = p_provider_key
    and operation_kind = p_operation_kind
    and idempotency_key = p_idempotency_key
  for update;

  if v_operation.request_sha256 <> p_request_sha256 then
    raise exception 'idempotency key reused with different request' using errcode = '23505';
  end if;

  if v_operation.state = 'planned' then
    v_claim_token := gen_random_uuid();
    v_claim_expires_at := now() + make_interval(secs => p_lease_seconds);
    update private.external_operations
    set state = 'in_flight',
        claim_owner = trim(p_claim_owner),
        claim_token = v_claim_token,
        claim_expires_at = v_claim_expires_at,
        claim_attempts = claim_attempts + 1,
        completed_at = null,
        last_error_code = null
    where id = v_operation.id
    returning * into v_operation;
    return jsonb_build_object(
      'id', v_operation.id,
      'state', v_operation.state,
      'externalReference', v_operation.external_reference,
      'duplicate', v_duplicate,
      'acquired', true,
      'claimToken', v_claim_token,
      'leaseExpiresAt', v_claim_expires_at,
      'attempt', v_operation.claim_attempts,
      'busy', false
    );
  end if;

  if v_operation.state = 'in_flight' then
    if v_operation.claim_token is null
       or v_operation.claim_expires_at is null
       or v_operation.claim_expires_at <= now() then
      update private.external_operations
      set state = 'failed_unknown',
          claim_owner = null,
          claim_token = null,
          claim_expires_at = null,
          completed_at = now(),
          last_error_code = case
            when v_operation.claim_token is null then 'external_claim_missing'
            else 'external_claim_lease_expired'
          end,
          response_metadata = coalesce(response_metadata, '{}'::jsonb)
            || jsonb_build_object('reconciliationRequired', true)
      where id = v_operation.id
      returning * into v_operation;
      return jsonb_build_object(
        'id', v_operation.id,
        'state', v_operation.state,
        'externalReference', v_operation.external_reference,
        'duplicate', true,
        'acquired', false,
        'claimToken', null,
        'leaseExpiresAt', null,
        'attempt', v_operation.claim_attempts,
        'busy', false,
        'stale', true,
        'reconciliationRequired', true
      );
    end if;
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_operation.claim_expires_at - now())))::integer
    );
    return jsonb_build_object(
      'id', v_operation.id,
      'state', v_operation.state,
      'externalReference', v_operation.external_reference,
      'duplicate', true,
      'acquired', false,
      'claimToken', null,
      'leaseExpiresAt', v_operation.claim_expires_at,
      'attempt', v_operation.claim_attempts,
      'busy', true,
      'retryAfterSeconds', v_retry_after
    );
  end if;

  return jsonb_build_object(
    'id', v_operation.id,
    'state', v_operation.state,
    'externalReference', v_operation.external_reference,
    'duplicate', true,
    'acquired', false,
    'claimToken', null,
    'leaseExpiresAt', null,
    'attempt', v_operation.claim_attempts,
    'busy', false,
    'reconciliationRequired', v_operation.state = 'failed_unknown'
  );
end;
$$;

create or replace function public.civya_service_finish_external_operation_claim(
  p_operation_id uuid,
  p_claim_owner text,
  p_claim_token uuid,
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
  if p_state not in ('succeeded', 'failed_unknown', 'failed_terminal') then
    raise exception 'invalid claimed external operation state' using errcode = '22023';
  end if;
  if p_response_metadata is null or jsonb_typeof(p_response_metadata) <> 'object' then
    raise exception 'external operation response metadata must be an object'
      using errcode = '22023';
  end if;
  select * into v_operation
  from private.external_operations
  where id = p_operation_id
  for update;
  if not found then
    raise exception 'external operation not found' using errcode = 'P0002';
  end if;
  if v_operation.state <> 'in_flight'
     or v_operation.claim_owner is distinct from trim(p_claim_owner)
     or v_operation.claim_token is distinct from p_claim_token then
    return jsonb_build_object(
      'id', v_operation.id,
      'state', v_operation.state,
      'externalReference', v_operation.external_reference,
      'finished', false,
      'stale', true
    );
  end if;
  if v_operation.claim_expires_at <= now() then
    update private.external_operations
    set state = 'failed_unknown',
        claim_owner = null,
        claim_token = null,
        claim_expires_at = null,
        completed_at = now(),
        last_error_code = 'external_claim_lease_expired',
        response_metadata = coalesce(p_response_metadata, '{}'::jsonb)
          || jsonb_build_object('reconciliationRequired', true)
    where id = v_operation.id
    returning * into v_operation;
    return jsonb_build_object(
      'id', v_operation.id,
      'state', v_operation.state,
      'externalReference', v_operation.external_reference,
      'finished', false,
      'stale', true,
      'reconciliationRequired', true
    );
  end if;

  update private.external_operations
  set state = p_state,
      external_reference = coalesce(p_external_reference, external_reference),
      response_metadata = p_response_metadata,
      last_error_code = p_error_code,
      claim_owner = null,
      claim_token = null,
      claim_expires_at = null,
      completed_at = now()
  where id = v_operation.id
  returning * into v_operation;
  return jsonb_build_object(
    'id', v_operation.id,
    'state', v_operation.state,
    'externalReference', v_operation.external_reference,
    'finished', true,
    'stale', false
  );
end;
$$;

-- Preserve the legacy API for existing operation kinds, but make it
-- impossible to bypass the owner/token check on a claimed row.
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
  if v_operation.claim_attempts > 0 then
    raise exception 'claimed external operation requires token-fenced completion'
      using errcode = '55000';
  end if;
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

revoke all on function public.civya_service_claim_external_operation(
  uuid, text, text, text, text, jsonb, text, integer
) from public, anon, authenticated;
revoke all on function public.civya_service_finish_external_operation_claim(
  uuid, text, uuid, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.civya_service_claim_external_operation(
  uuid, text, text, text, text, jsonb, text, integer
) to service_role;
grant execute on function public.civya_service_finish_external_operation_claim(
  uuid, text, uuid, text, text, jsonb, text
) to service_role;

comment on function public.civya_service_claim_external_operation(
  uuid, text, text, text, text, jsonb, text, integer
) is 'Atomically creates or claims one outbound provider operation. Expired non-idempotent claims become failed-unknown and are never reassigned.';
comment on function public.civya_service_finish_external_operation_claim(
  uuid, text, uuid, text, text, jsonb, text
) is 'Token-fenced completion for an outbound provider operation claim.';
