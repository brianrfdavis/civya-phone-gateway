-- Close the proof-lifecycle and response-loss gaps at the production case
-- authorization boundary. This is deliberately a forward migration: estates
-- that already applied 013/016/021 receive the same hardened behavior as a
-- fresh database.

create or replace function private.civya_entitlement_has_current_proof(
  p_entitlement_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from public.case_entitlements e
    join public.identity_proof_challenges p on p.id = e.proof_challenge_id
    where e.id = p_entitlement_id
      and p.tenant_id = e.tenant_id
      and p.case_id = e.case_id
      and p.resident_id = e.resident_id
      and p.auth_user_id = e.auth_user_id
      and p.state = 'verified'
      and p.verified_at is not null
      and p.expires_at > now()
      and p.expires_at > p.verified_at
      and p.assurance_level in ('substantial', 'high')
      and e.assurance_level = p.assurance_level
      and p.evidence_digest is not null
      and p.evidence_digest ~ '^[0-9a-f]{64}$'
      and e.evidence_digest = p.evidence_digest
      and e.expires_at <= p.expires_at
  )
$$;

revoke all on function private.civya_entitlement_has_current_proof(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.civya_active_case_entitlement(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_scope text default 'case.read'
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select p_actor_user_id is not null and (
    exists (
      select 1 from public.case_entitlements e
      where e.case_id = p_case_id
        and e.auth_user_id = p_actor_user_id
        and e.state = 'active'
        and e.expires_at > now()
        and p_scope = any(e.scopes)
        and private.civya_entitlement_has_current_proof(e.id)
    )
    or exists (
      select 1
      from public.case_delegations d
      join public.case_entitlements e on e.id = d.principal_entitlement_id
      where d.case_id = p_case_id
        and d.delegate_auth_user_id = p_actor_user_id
        and d.state = 'active' and d.expires_at > now()
        and p_scope = any(d.scopes)
        and e.tenant_id = d.tenant_id
        and e.case_id = d.case_id
        and e.auth_user_id = d.principal_auth_user_id
        and e.state = 'active' and e.expires_at > now()
        and private.civya_entitlement_has_current_proof(e.id)
    )
  )
$$;

revoke all on function private.civya_active_case_entitlement(uuid, uuid, text)
  from public, anon, authenticated;

create or replace function private.civya_actor_has_tenant_access(
  p_actor_user_id uuid,
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select private.civya_actor_is_staff(p_actor_user_id, p_tenant_id)
    or private.civya_has_tenant_access(p_actor_user_id, p_tenant_id)
    or exists (
      select 1 from public.case_entitlements e
      where e.tenant_id = p_tenant_id and e.auth_user_id = p_actor_user_id
        and e.state = 'active' and e.expires_at > now()
        and private.civya_entitlement_has_current_proof(e.id)
    )
    or exists (
      select 1 from public.case_delegations d
      join public.case_entitlements e on e.id = d.principal_entitlement_id
      where d.tenant_id = p_tenant_id and d.delegate_auth_user_id = p_actor_user_id
        and d.state = 'active' and d.expires_at > now()
        and e.tenant_id = d.tenant_id and e.case_id = d.case_id
        and e.auth_user_id = d.principal_auth_user_id
        and e.state = 'active' and e.expires_at > now()
        and private.civya_entitlement_has_current_proof(e.id)
    )
$$;

revoke all on function private.civya_actor_has_tenant_access(uuid, uuid)
  from public, anon, authenticated;

drop policy if exists tenants_member_read on public.tenants;
create policy tenants_member_read on public.tenants for select to authenticated
  using (private.civya_actor_has_tenant_access(auth.uid(), id));

-- The generic grant boundary may not create an entitlement after its proof
-- expires, from a weak proof, or with a lifetime beyond that proof.
create or replace function public.civya_service_grant_case_entitlement(
  p_staff_actor_user_id uuid,
  p_challenge_id uuid,
  p_scopes text[],
  p_expires_at timestamptz,
  p_grant_reason_code text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_challenge public.identity_proof_challenges%rowtype;
  v_entitlement public.case_entitlements%rowtype;
  v_granted_by text;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  select * into v_challenge from public.identity_proof_challenges
  where id = p_challenge_id for update;
  if not found or v_challenge.state <> 'verified' or v_challenge.verified_at is null
     or v_challenge.expires_at <= now()
     or v_challenge.expires_at <= v_challenge.verified_at
     or v_challenge.assurance_level not in ('substantial', 'high')
     or v_challenge.evidence_digest is null
     or v_challenge.evidence_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'current verified identity proof required' using errcode = '28000';
  end if;
  v_granted_by := case when p_staff_actor_user_id is null then 'provider' else 'staff' end;
  if p_staff_actor_user_id is not null
     and not private.civya_actor_is_staff(p_staff_actor_user_id, v_challenge.tenant_id, 'admin') then
    raise exception 'tenant admin required' using errcode = '42501';
  end if;
  if p_expires_at <= now() or p_expires_at > v_challenge.expires_at then
    raise exception 'invalid entitlement lifetime' using errcode = '22023';
  end if;
  insert into public.case_entitlements (
    tenant_id, case_id, resident_id, auth_user_id, proof_challenge_id,
    scopes, assurance_level, granted_by_type, granted_by_auth_user_id,
    grant_reason_code, evidence_digest, expires_at, idempotency_key
  ) values (
    v_challenge.tenant_id, v_challenge.case_id, v_challenge.resident_id,
    v_challenge.auth_user_id, v_challenge.id, p_scopes, v_challenge.assurance_level,
    v_granted_by, p_staff_actor_user_id, p_grant_reason_code,
    v_challenge.evidence_digest, p_expires_at, p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_entitlement;
  if not found then
    v_duplicate := true;
    select * into strict v_entitlement from public.case_entitlements
    where tenant_id = v_challenge.tenant_id and idempotency_key = p_idempotency_key;
    if v_entitlement.case_id <> v_challenge.case_id
       or v_entitlement.auth_user_id <> v_challenge.auth_user_id
       or v_entitlement.proof_challenge_id <> v_challenge.id
       or v_entitlement.scopes <> p_scopes
       or v_entitlement.expires_at > v_challenge.expires_at
       or not private.civya_entitlement_has_current_proof(v_entitlement.id) then
      raise exception 'entitlement idempotency conflict' using errcode = '23505';
    end if;
  end if;
  insert into public.audit_events (tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source)
  values (v_entitlement.tenant_id, v_entitlement.resident_id, v_entitlement.case_id,
    coalesce(p_staff_actor_user_id, v_entitlement.auth_user_id),
    'case_entitlement_granted', jsonb_build_object('entitlementId', v_entitlement.id,
      'scopes', to_jsonb(v_entitlement.scopes), 'assuranceLevel', v_entitlement.assurance_level,
      'expiresAt', v_entitlement.expires_at),
    case when p_staff_actor_user_id is null then 'system' else 'admin' end);
  return jsonb_build_object('entitlementId', v_entitlement.id,
    'caseId', v_entitlement.case_id, 'state', v_entitlement.state,
    'expiresAt', v_entitlement.expires_at, 'duplicate', v_duplicate);
end;
$$;

revoke all on function public.civya_service_grant_case_entitlement(
  uuid, uuid, text[], timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.civya_service_grant_case_entitlement(
  uuid, uuid, text[], timestamptz, text, text
) to service_role;

-- A delegation is never allowed to originate from a stale proof, even when a
-- caller bypasses the grant RPC. Existing delegations are checked dynamically
-- by civya_active_case_entitlement above.
create or replace function private.civya_require_current_delegation_proof()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if new.state = 'active'
     and not private.civya_entitlement_has_current_proof(new.principal_entitlement_id) then
    raise exception 'delegation requires a current verified identity proof' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.civya_require_current_delegation_proof()
  from public, anon, authenticated, service_role;
drop trigger if exists case_delegation_current_proof_guard on public.case_delegations;
create trigger case_delegation_current_proof_guard
  before insert or update on public.case_delegations
  for each row execute function private.civya_require_current_delegation_proof();

-- Retain the exact tuple/sandbox checks from 016 behind a private service-only
-- implementation, and add the centralized proof lifecycle to its public RPC.
alter function public.civya_service_case_entitlement_cache_status(
  uuid, uuid, bigint, uuid, uuid, text, text[]
) rename to civya_service_case_entitlement_cache_status_unchecked;

revoke all on function public.civya_service_case_entitlement_cache_status_unchecked(
  uuid, uuid, bigint, uuid, uuid, text, text[]
) from public, anon, authenticated, service_role;

create or replace function public.civya_service_case_entitlement_cache_status(
  p_actor_user_id uuid,
  p_entitlement_id uuid,
  p_expected_row_version bigint,
  p_tenant_id uuid,
  p_case_id uuid,
  p_purpose text,
  p_required_scopes text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_result jsonb;
begin
  perform private.civya_service_required();
  v_result := public.civya_service_case_entitlement_cache_status_unchecked(
    p_actor_user_id, p_entitlement_id, p_expected_row_version,
    p_tenant_id, p_case_id, p_purpose, p_required_scopes
  );
  if coalesce((v_result ->> 'authorized')::boolean, false)
     and v_result ->> 'accessType' = 'case_entitlement'
     and (
       p_entitlement_id is null
       or v_result ->> 'entitlementId' <> p_entitlement_id::text
       or not private.civya_entitlement_has_current_proof(p_entitlement_id)
     ) then
    return jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required');
  end if;
  return v_result;
end;
$$;

revoke all on function public.civya_service_case_entitlement_cache_status(
  uuid, uuid, bigint, uuid, uuid, text, text[]
) from public, anon, authenticated;
grant execute on function public.civya_service_case_entitlement_cache_status(
  uuid, uuid, bigint, uuid, uuid, text, text[]
) to service_role;

-- Apply the same proof predicate to both candidates before a one-time choice
-- record can be exposed to the browser. A stale existing entitlement merely
-- disables that candidate; a stale attached entitlement rejects the handoff.
alter function public.civya_service_create_case_entitlement_selection(
  uuid, uuid, uuid, uuid, uuid, text, text, text[], timestamptz
) rename to civya_service_create_case_entitlement_selection_unchecked;

revoke all on function public.civya_service_create_case_entitlement_selection_unchecked(
  uuid, uuid, uuid, uuid, uuid, text, text, text[], timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.civya_service_create_case_entitlement_selection(
  p_actor_user_id uuid,
  p_selection_id uuid,
  p_attached_case_id uuid,
  p_attached_entitlement_id uuid,
  p_existing_case_id uuid,
  p_access_type text,
  p_purpose text,
  p_scopes text[],
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_result jsonb;
  v_selection private.case_entitlement_selections%rowtype;
begin
  perform private.civya_service_required();
  v_result := public.civya_service_create_case_entitlement_selection_unchecked(
    p_actor_user_id, p_selection_id, p_attached_case_id,
    p_attached_entitlement_id, p_existing_case_id, p_access_type,
    p_purpose, p_scopes, p_expires_at
  );
  select * into strict v_selection from private.case_entitlement_selections
  where id = p_selection_id and auth_user_id = p_actor_user_id
  for update;
  if v_selection.access_type = 'case_entitlement' then
    if not private.civya_entitlement_has_current_proof(v_selection.attached_entitlement_id) then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
    if v_selection.existing_entitlement_id is not null
       and not private.civya_entitlement_has_current_proof(v_selection.existing_entitlement_id) then
      update private.case_entitlement_selections
      set existing_entitlement_id = null
      where id = v_selection.id;
      v_result := v_result || jsonb_build_object('existingCaseAvailable', false);
    end if;
  end if;
  return v_result;
end;
$$;

revoke all on function public.civya_service_create_case_entitlement_selection(
  uuid, uuid, uuid, uuid, uuid, text, text, text[], timestamptz
) from public, anon, authenticated;
grant execute on function public.civya_service_create_case_entitlement_selection(
  uuid, uuid, uuid, uuid, uuid, text, text, text[], timestamptz
) to service_role;

-- Make the one-time selection retry-safe. Repeating the same choice after the
-- transaction committed but before the HTTP response arrived returns the same
-- currently authorized case; changing the choice remains forbidden.
alter function public.civya_service_select_entitled_case(uuid, uuid, uuid)
  rename to civya_service_select_entitled_case_unchecked;

revoke all on function public.civya_service_select_entitled_case_unchecked(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.civya_service_select_entitled_case(
  p_actor_user_id uuid,
  p_selection_id uuid,
  p_selected_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_selection private.case_entitlement_selections%rowtype;
  v_selected_entitlement_id uuid;
  v_entitlement public.case_entitlements%rowtype;
  v_result jsonb;
begin
  perform private.civya_service_required();
  select * into v_selection from private.case_entitlement_selections
  where id = p_selection_id and auth_user_id = p_actor_user_id
  for update;
  if not found or v_selection.expires_at <= now()
     or p_selected_case_id not in (
       v_selection.attached_case_id, v_selection.existing_case_id
     ) then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;
  v_selected_entitlement_id := case
    when p_selected_case_id = v_selection.attached_case_id
      then v_selection.attached_entitlement_id
    else v_selection.existing_entitlement_id
  end;

  if v_selection.used_at is not null then
    if v_selection.selected_case_id <> p_selected_case_id then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
    if v_selection.access_type = 'case_entitlement' then
      select * into v_entitlement from public.case_entitlements
      where id = v_selected_entitlement_id;
      if not found or not private.civya_entitlement_has_current_proof(v_entitlement.id) then
        raise exception 'case selection rejected' using errcode = '28000';
      end if;
      v_result := public.civya_service_case_entitlement_cache_status(
        p_actor_user_id, v_entitlement.id, v_entitlement.row_version,
        v_selection.tenant_id, p_selected_case_id,
        v_selection.purpose, v_selection.scopes
      );
    else
      v_result := public.civya_service_case_entitlement_cache_status(
        p_actor_user_id, null, 0, v_selection.tenant_id,
        p_selected_case_id, v_selection.purpose, v_selection.scopes
      );
    end if;
    if not coalesce((v_result ->> 'authorized')::boolean, false) then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
    return v_result || jsonb_build_object('casesMerged', false, 'duplicate', true);
  end if;

  if v_selection.access_type = 'case_entitlement'
     and not private.civya_entitlement_has_current_proof(v_selected_entitlement_id) then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;
  v_result := public.civya_service_select_entitled_case_unchecked(
    p_actor_user_id, p_selection_id, p_selected_case_id
  );
  return v_result || jsonb_build_object('duplicate', false);
end;
$$;

revoke all on function public.civya_service_select_entitled_case(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.civya_service_select_entitled_case(uuid, uuid, uuid)
  to service_role;

-- Reminder scheduling and dispatch are authorization surfaces too. Preserve
-- the detailed 021 controls behind wrappers that additionally require the
-- exact entitlement's proof to remain current at both moments.
alter function private.civya_exact_reminder_entitlement(uuid, uuid, uuid)
  rename to civya_exact_reminder_entitlement_unchecked;

revoke all on function private.civya_exact_reminder_entitlement_unchecked(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.civya_exact_reminder_entitlement(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_entitlement_id uuid
)
returns public.case_entitlements
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_entitlement public.case_entitlements%rowtype;
begin
  v_entitlement := private.civya_exact_reminder_entitlement_unchecked(
    p_actor_user_id, p_case_id, p_entitlement_id
  );
  if not private.civya_entitlement_has_current_proof(v_entitlement.id) then
    raise exception 'active exact reminder entitlement not found' using errcode = '42501';
  end if;
  return v_entitlement;
end;
$$;

revoke all on function private.civya_exact_reminder_entitlement(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

alter function public.civya_service_prepare_reminder_delivery(uuid)
  rename to civya_service_prepare_reminder_delivery_unchecked;

revoke all on function public.civya_service_prepare_reminder_delivery_unchecked(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.civya_service_prepare_reminder_delivery(
  p_reminder_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_reminder public.reminders%rowtype;
begin
  perform private.civya_service_required();
  select * into v_reminder from public.reminders
  where id = p_reminder_id for update;
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  if v_reminder.status in ('scheduled', 'queued') and not exists (
    select 1 from public.case_entitlements e
    where e.id = v_reminder.entitlement_id
      and e.tenant_id = v_reminder.tenant_id
      and e.case_id = v_reminder.case_id
      and e.resident_id = v_reminder.resident_id
      and e.state = 'active' and e.revoked_at is null
      and e.expires_at > now()
      and array['case.read', 'case.participate']::text[] <@ e.scopes
      and private.civya_entitlement_has_current_proof(e.id)
  ) then
    v_reminder := private.civya_suppress_reminder(v_reminder, 'entitlement_inactive');
    return jsonb_build_object(
      'state', 'suppressed', 'status', v_reminder.status,
      'reasonCode', 'entitlement_inactive', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id
    );
  end if;
  return public.civya_service_prepare_reminder_delivery_unchecked(p_reminder_id);
end;
$$;

revoke all on function public.civya_service_prepare_reminder_delivery(uuid)
  from public, anon, authenticated;
grant execute on function public.civya_service_prepare_reminder_delivery(uuid)
  to service_role;

-- A durable handoff receipt makes the final proof/entitlement commit and any
-- required case-selection creation one atomic, replayable transaction. It
-- stores no transfer token, verifier credential, email, or raw evidence.
create table private.bound_case_entitlement_handoffs (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  idempotency_key text not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key),
  check (length(idempotency_key) between 1 and 160),
  check (result is null or jsonb_typeof(result) = 'object')
);

revoke all on private.bound_case_entitlement_handoffs
  from public, anon, authenticated, service_role;

create or replace function private.civya_bound_entitlement_handoff_request_digest(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_transfer_digest text,
  p_expected_tenant_id uuid,
  p_expected_case_id uuid,
  p_expected_purpose text,
  p_expected_scopes text[],
  p_method text,
  p_provider_key text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public, private
as $$
  select encode(sha256(convert_to(concat_ws('|',
    'civya-bound-entitlement-handoff-v1', p_actor_user_id::text,
    lower(trim(p_actor_email)), p_actor_is_anonymous::text,
    coalesce(p_transfer_digest, 'direct'), p_expected_tenant_id::text,
    p_expected_case_id::text, p_expected_purpose,
    array_to_string(p_expected_scopes, ','), p_method, p_provider_key
  ), 'UTF8')), 'hex')
$$;

revoke all on function private.civya_bound_entitlement_handoff_request_digest(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text
) from public, anon, authenticated, service_role;

create or replace function public.civya_service_finalize_bound_case_entitlement_handoff(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_transfer_digest text,
  p_expected_tenant_id uuid,
  p_expected_case_id uuid,
  p_expected_purpose text,
  p_expected_scopes text[],
  p_method text,
  p_provider_key text,
  p_verifier_grant_digest text,
  p_expires_at timestamptz,
  p_idempotency_key text,
  p_selection_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_request_digest text;
  v_inserted boolean := false;
  v_receipt private.bound_case_entitlement_handoffs%rowtype;
  v_final jsonb;
  v_selection jsonb;
  v_selection_row private.case_entitlement_selections%rowtype;
  v_selection_expiry timestamptz;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or p_actor_is_anonymous
     or nullif(trim(p_actor_email), '') is null
     or p_expected_tenant_id is null or p_expected_case_id is null
     or p_selection_id is null
     or nullif(p_idempotency_key, '') is null or length(p_idempotency_key) > 160 then
    raise exception 'bound entitlement handoff rejected' using errcode = '28000';
  end if;
  v_request_digest := private.civya_bound_entitlement_handoff_request_digest(
    p_actor_user_id, p_actor_email, p_actor_is_anonymous,
    p_transfer_digest, p_expected_tenant_id, p_expected_case_id,
    p_expected_purpose, p_expected_scopes, p_method, p_provider_key
  );

  insert into private.bound_case_entitlement_handoffs (
    tenant_id, idempotency_key, auth_user_id, request_digest
  ) values (
    p_expected_tenant_id, p_idempotency_key, p_actor_user_id, v_request_digest
  ) on conflict (tenant_id, idempotency_key) do nothing
  returning true into v_inserted;

  if not coalesce(v_inserted, false) then
    select * into strict v_receipt
    from private.bound_case_entitlement_handoffs
    where tenant_id = p_expected_tenant_id
      and idempotency_key = p_idempotency_key
    for update;
    if v_receipt.auth_user_id <> p_actor_user_id
       or v_receipt.request_digest <> v_request_digest
       or v_receipt.result is null then
      raise exception 'bound entitlement handoff conflict' using errcode = '23505';
    end if;
    v_final := v_receipt.result;
    if coalesce((v_final ->> 'requiresCaseSelection')::boolean, false) then
      select * into v_selection_row from private.case_entitlement_selections
      where id = (v_final ->> 'selectionId')::uuid
        and auth_user_id = p_actor_user_id;
      if not found or (v_selection_row.used_at is null and v_selection_row.expires_at <= now()) then
        v_selection_expiry := least(
          (v_final ->> 'expiresAt')::timestamptz,
          now() + interval '10 minutes'
        );
        if v_selection_expiry <= now() then
          raise exception 'bound entitlement handoff expired' using errcode = '28000';
        end if;
        v_selection := public.civya_service_create_case_entitlement_selection(
          p_actor_user_id, p_selection_id, p_expected_case_id,
          nullif(v_final ->> 'entitlementId', '')::uuid,
          (v_final ->> 'existingActiveCaseId')::uuid,
          v_final ->> 'accessType', p_expected_purpose,
          p_expected_scopes, v_selection_expiry
        );
        v_final := v_final || jsonb_build_object(
          'selectionId', v_selection ->> 'selectionId',
          'selectionExpiresAt', v_selection ->> 'expiresAt',
          'existingCaseAvailable', (v_selection ->> 'existingCaseAvailable')::boolean
        );
        update private.bound_case_entitlement_handoffs
        set result = v_final, updated_at = now()
        where tenant_id = p_expected_tenant_id
          and idempotency_key = p_idempotency_key;
      end if;
    end if;
    return v_final || jsonb_build_object('duplicate', true);
  end if;

  v_final := public.civya_service_finalize_bound_case_entitlement(
    p_actor_user_id, p_actor_email, p_actor_is_anonymous,
    p_transfer_digest, p_expected_tenant_id, p_expected_case_id,
    p_expected_purpose, p_expected_scopes, p_method, p_provider_key,
    p_verifier_grant_digest, p_expires_at, p_idempotency_key
  );
  if coalesce((v_final ->> 'requiresCaseSelection')::boolean, false) then
    v_selection_expiry := least(
      (v_final ->> 'expiresAt')::timestamptz,
      now() + interval '10 minutes'
    );
    v_selection := public.civya_service_create_case_entitlement_selection(
      p_actor_user_id, p_selection_id, p_expected_case_id,
      nullif(v_final ->> 'entitlementId', '')::uuid,
      (v_final ->> 'existingActiveCaseId')::uuid,
      v_final ->> 'accessType', p_expected_purpose,
      p_expected_scopes, v_selection_expiry
    );
    v_final := v_final || jsonb_build_object(
      'selectionId', v_selection ->> 'selectionId',
      'selectionExpiresAt', v_selection ->> 'expiresAt',
      'existingCaseAvailable', (v_selection ->> 'existingCaseAvailable')::boolean
    );
  end if;
  update private.bound_case_entitlement_handoffs
  set result = v_final, updated_at = now()
  where tenant_id = p_expected_tenant_id and idempotency_key = p_idempotency_key;
  return v_final || jsonb_build_object('duplicate', false);
end;
$$;

-- This lookup runs before calling the external verifier on an HTTP retry. A
-- committed handoff can therefore be restored even when the provider code was
-- one-time or returns a different grant reference after the lost response.
create or replace function public.civya_service_recover_bound_case_entitlement_handoff(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_transfer_digest text,
  p_expected_tenant_id uuid,
  p_expected_case_id uuid,
  p_expected_purpose text,
  p_expected_scopes text[],
  p_method text,
  p_provider_key text,
  p_idempotency_key text,
  p_selection_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_request_digest text;
  v_receipt private.bound_case_entitlement_handoffs%rowtype;
  v_final jsonb;
  v_selection jsonb;
  v_selection_row private.case_entitlement_selections%rowtype;
  v_selection_expiry timestamptz;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or p_actor_is_anonymous
     or nullif(trim(p_actor_email), '') is null
     or p_expected_tenant_id is null or p_expected_case_id is null
     or p_selection_id is null
     or nullif(p_idempotency_key, '') is null or length(p_idempotency_key) > 160 then
    raise exception 'bound entitlement handoff recovery rejected' using errcode = '28000';
  end if;
  v_request_digest := private.civya_bound_entitlement_handoff_request_digest(
    p_actor_user_id, p_actor_email, p_actor_is_anonymous,
    p_transfer_digest, p_expected_tenant_id, p_expected_case_id,
    p_expected_purpose, p_expected_scopes, p_method, p_provider_key
  );
  select * into v_receipt
  from private.bound_case_entitlement_handoffs
  where tenant_id = p_expected_tenant_id
    and idempotency_key = p_idempotency_key
  for update;
  if not found then return null; end if;
  if v_receipt.auth_user_id <> p_actor_user_id
     or v_receipt.request_digest <> v_request_digest
     or v_receipt.result is null then
    raise exception 'bound entitlement handoff recovery conflict' using errcode = '23505';
  end if;
  v_final := v_receipt.result;
  if (v_final ->> 'tenantId')::uuid <> p_expected_tenant_id
     or (v_final ->> 'caseId')::uuid <> p_expected_case_id
     or v_final ->> 'purpose' <> p_expected_purpose
     or array(select jsonb_array_elements_text(v_final -> 'scopes')) <> p_expected_scopes then
    raise exception 'bound entitlement handoff recovery conflict' using errcode = '23505';
  end if;
  if coalesce((v_final ->> 'requiresCaseSelection')::boolean, false) then
    select * into v_selection_row from private.case_entitlement_selections
    where id = (v_final ->> 'selectionId')::uuid
      and auth_user_id = p_actor_user_id;
    if not found or (v_selection_row.used_at is null and v_selection_row.expires_at <= now()) then
      v_selection_expiry := least(
        (v_final ->> 'expiresAt')::timestamptz,
        now() + interval '10 minutes'
      );
      if v_selection_expiry <= now() then
        raise exception 'bound entitlement handoff expired' using errcode = '28000';
      end if;
      v_selection := public.civya_service_create_case_entitlement_selection(
        p_actor_user_id, p_selection_id, p_expected_case_id,
        nullif(v_final ->> 'entitlementId', '')::uuid,
        (v_final ->> 'existingActiveCaseId')::uuid,
        v_final ->> 'accessType', p_expected_purpose,
        p_expected_scopes, v_selection_expiry
      );
      v_final := v_final || jsonb_build_object(
        'selectionId', v_selection ->> 'selectionId',
        'selectionExpiresAt', v_selection ->> 'expiresAt',
        'existingCaseAvailable', (v_selection ->> 'existingCaseAvailable')::boolean
      );
      update private.bound_case_entitlement_handoffs
      set result = v_final, updated_at = now()
      where tenant_id = p_expected_tenant_id
        and idempotency_key = p_idempotency_key;
    end if;
  end if;
  return v_final || jsonb_build_object('duplicate', true);
end;
$$;

-- The non-replayable primitive is now internal to the replay-safe handoff.
revoke all on function public.civya_service_finalize_bound_case_entitlement(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text, text,
  timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.civya_service_finalize_bound_case_entitlement_handoff(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text, text,
  timestamptz, text, uuid
) from public, anon, authenticated;
grant execute on function public.civya_service_finalize_bound_case_entitlement_handoff(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text, text,
  timestamptz, text, uuid
) to service_role;
revoke all on function public.civya_service_recover_bound_case_entitlement_handoff(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.civya_service_recover_bound_case_entitlement_handoff(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text, text, uuid
) to service_role;

comment on table private.bound_case_entitlement_handoffs is
  'Secret-free receipt for atomic, replay-safe exact entitlement finalization and case-choice handoff.';
