-- Atomic first-time claim of a governed production case after an external
-- identity provider has returned a verified result. Account authentication is
-- deliberately insufficient: this contract requires an opaque verifier grant
-- digest, binds it once to one exact tenant/case/account chain, records the
-- successful proof and least-privilege entitlement in the same transaction,
-- and emits one tamper-evident audit event.

-- County source imports may stage a resident before that resident has a Civya
-- account. Existing sandbox and account-created residents remain linked as
-- before; only the service-only claim RPC below may use an unclaimed production
-- row to establish the initial account binding.
alter table public.residents
  alter column auth_user_id drop not null;

create table private.production_case_claim_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  case_id uuid not null references public.cases(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  method text not null check (method in ('county_notice', 'knowledge')),
  provider_key text not null check (provider_key = 'wayne_county_case_entitlement'),
  purpose text not null default 'case_access' check (purpose = 'case_access'),
  scopes text[] not null default array[
    'case.read', 'case.participate', 'document.read', 'document.upload'
  ]::text[] check (
    coalesce(array_length(scopes, 1), 0) > 0
    and scopes <@ array[
      'case.read', 'case.participate', 'document.read', 'document.upload'
    ]::text[]
    and 'case.read' = any(scopes)
  ),
  verifier_grant_digest text not null check (verifier_grant_digest ~ '^[0-9a-f]{64}$'),
  challenge_id uuid not null
    references public.identity_proof_challenges(id) on delete restrict
    deferrable initially deferred,
  entitlement_id uuid not null
    references public.case_entitlements(id) on delete restrict
    deferrable initially deferred,
  idempotency_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (provider_key, verifier_grant_digest),
  unique (tenant_id, idempotency_key),
  unique (challenge_id),
  unique (entitlement_id),
  check (expires_at > created_at)
);

revoke all on private.production_case_claim_receipts
  from public, anon, authenticated, service_role;

create or replace function public.civya_service_claim_verified_production_case(
  p_tenant_id uuid,
  p_case_id uuid,
  p_actor_user_id uuid,
  p_method text,
  p_provider_key text,
  p_proof_result text,
  p_verifier_grant_digest text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_tenant public.tenants%rowtype;
  v_case public.cases%rowtype;
  v_resident public.residents%rowtype;
  v_receipt private.production_case_claim_receipts%rowtype;
  v_challenge public.identity_proof_challenges%rowtype;
  v_entitlement public.case_entitlements%rowtype;
  v_challenge_id uuid := gen_random_uuid();
  v_entitlement_id uuid := gen_random_uuid();
  v_claim_digest text;
  v_challenge_digest text;
  v_evidence_digest text;
  v_claim_key text;
  v_proof_key text;
  v_entitlement_key text;
  v_scopes text[] := array[
    'case.read',
    'case.participate',
    'document.read',
    'document.upload'
  ]::text[];
begin
  perform private.civya_service_required();

  -- A login session or a failed/pending verifier result can never reach the
  -- ownership mutation. The route passes only the digest of the opaque grant;
  -- raw notice codes, proof answers, and provider tokens are not accepted.
  if p_proof_result is distinct from 'verified'
     or p_method not in ('county_notice', 'knowledge')
     or p_provider_key is distinct from 'wayne_county_case_entitlement'
     or p_verifier_grant_digest is null
     or p_verifier_grant_digest !~ '^[0-9a-f]{64}$'
     or p_actor_user_id is null
     or not exists (select 1 from auth.users u where u.id = p_actor_user_id)
     or p_expires_at is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '30 minutes' then
    raise exception 'verified production case claim rejected' using errcode = '28000';
  end if;

  -- Exact tenant and case are required. The generic rejection deliberately
  -- gives the caller no signal about whether either identifier exists.
  select * into v_tenant
  from public.tenants t
  where t.id = p_tenant_id
    and t.environment = 'production'
    and not t.fictional
    and t.status = 'active';
  if not found then
    raise exception 'verified production case claim rejected' using errcode = 'P0002';
  end if;

  select * into v_case
  from public.cases c
  where c.id = p_case_id and c.tenant_id = p_tenant_id;
  if not found then
    raise exception 'verified production case claim rejected' using errcode = 'P0002';
  end if;

  -- The resident lock serializes first claim and replay. A resident already
  -- linked to another account is never moved, merged, or reassigned.
  select * into v_resident
  from public.residents r
  where r.id = v_case.resident_id and r.tenant_id = p_tenant_id
  for update;
  if not found
     or (v_resident.auth_user_id is not null
       and v_resident.auth_user_id <> p_actor_user_id) then
    raise exception 'verified production case claim rejected' using errcode = 'P0002';
  end if;

  v_claim_digest := encode(sha256(convert_to(
    concat_ws('|', 'civya-production-case-claim-v1', p_tenant_id::text,
      p_case_id::text, v_resident.id::text, p_actor_user_id::text,
      p_method, p_provider_key, p_verifier_grant_digest),
    'UTF8'
  )), 'hex');
  v_challenge_digest := encode(sha256(convert_to(
    'civya-production-case-challenge-v1|' || v_claim_digest,
    'UTF8'
  )), 'hex');
  v_evidence_digest := encode(sha256(convert_to(
    'civya-production-case-evidence-v1|' || v_claim_digest,
    'UTF8'
  )), 'hex');
  v_claim_key := 'production-case-claim:' || v_claim_digest;
  v_proof_key := 'production-case-proof:' || v_claim_digest;
  v_entitlement_key := 'production-case-entitlement:' || v_claim_digest;

  -- Reserve the provider grant globally for this provider. Deferred foreign
  -- keys allow the receipt to win the concurrency race before its proof and
  -- entitlement rows are inserted later in this same transaction.
  insert into private.production_case_claim_receipts (
    tenant_id, case_id, resident_id, auth_user_id, method, provider_key,
    verifier_grant_digest, challenge_id, entitlement_id, idempotency_key,
    expires_at
  ) values (
    p_tenant_id, p_case_id, v_resident.id, p_actor_user_id, p_method,
    p_provider_key, p_verifier_grant_digest, v_challenge_id,
    v_entitlement_id, v_claim_key, p_expires_at
  )
  on conflict (provider_key, verifier_grant_digest) do nothing
  returning * into v_receipt;

  if not found then
    select * into v_receipt
    from private.production_case_claim_receipts r
    where r.provider_key = p_provider_key
      and r.verifier_grant_digest = p_verifier_grant_digest
    for update;
    if not found
       or v_receipt.tenant_id <> p_tenant_id
       or v_receipt.case_id <> p_case_id
       or v_receipt.resident_id <> v_resident.id
       or v_receipt.auth_user_id <> p_actor_user_id
       or v_receipt.method <> p_method
       or v_receipt.idempotency_key <> v_claim_key
       or v_receipt.expires_at <> p_expires_at
       or v_resident.auth_user_id <> p_actor_user_id then
      raise exception 'verified production case claim rejected' using errcode = 'P0002';
    end if;

    select * into v_challenge
    from public.identity_proof_challenges p
    where p.id = v_receipt.challenge_id
      and p.tenant_id = p_tenant_id
      and p.case_id = p_case_id
      and p.resident_id = v_resident.id
      and p.auth_user_id = p_actor_user_id
      and p.state = 'verified'
      and p.evidence_digest = v_evidence_digest;
    select * into v_entitlement
    from public.case_entitlements e
    where e.id = v_receipt.entitlement_id
      and e.tenant_id = p_tenant_id
      and e.case_id = p_case_id
      and e.resident_id = v_resident.id
      and e.auth_user_id = p_actor_user_id
      and e.proof_challenge_id = v_receipt.challenge_id
      and e.scopes = v_scopes
      and e.state = 'active';
    if v_challenge.id is null or v_entitlement.id is null then
      raise exception 'verified production case claim rejected' using errcode = 'P0002';
    end if;

    return jsonb_build_object(
      'challengeId', v_challenge.id,
      'entitlementId', v_entitlement.id,
      'caseId', v_entitlement.case_id,
      'residentId', v_entitlement.resident_id,
      'state', v_entitlement.state,
      'scopes', to_jsonb(v_entitlement.scopes),
      'expiresAt', v_entitlement.expires_at,
      'duplicate', true
    );
  end if;

  -- Only the winner of the receipt race may establish ownership. Every later
  -- step remains in this function transaction, so a proof/entitlement/audit
  -- failure also rolls the resident binding back to NULL.
  if v_resident.auth_user_id is not null then
    raise exception 'verified production case claim rejected' using errcode = 'P0002';
  end if;

  update public.residents
  set auth_user_id = p_actor_user_id,
      identity_state = 'verified',
      last_active_at = now(),
      row_version = row_version + 1,
      updated_at = now()
  where id = v_resident.id
    and tenant_id = p_tenant_id
    and auth_user_id is null
  returning * into v_resident;
  if not found then
    raise exception 'verified production case claim rejected' using errcode = 'P0002';
  end if;

  insert into public.identity_proof_challenges (
    id, tenant_id, resident_id, case_id, auth_user_id, method, provider_key,
    challenge_digest, state, assurance_level, evidence_digest,
    provider_reference, attempt_count, expires_at, verified_at, resolved_at,
    idempotency_key
  ) values (
    v_receipt.challenge_id, p_tenant_id, v_resident.id, p_case_id,
    p_actor_user_id, p_method, p_provider_key, v_challenge_digest, 'verified',
    'substantial', v_evidence_digest,
    'sha256:' || p_verifier_grant_digest, 1, p_expires_at, now(), now(),
    v_proof_key
  ) returning * into v_challenge;

  insert into public.case_entitlements (
    id, tenant_id, case_id, resident_id, auth_user_id, proof_challenge_id,
    scopes, assurance_level, state, granted_by_type,
    granted_by_auth_user_id, grant_reason_code, evidence_digest, expires_at,
    idempotency_key
  ) values (
    v_receipt.entitlement_id, p_tenant_id, p_case_id, v_resident.id,
    p_actor_user_id, v_challenge.id, v_scopes, 'substantial', 'active',
    'provider', null, 'external_case_identity_verified', v_evidence_digest,
    p_expires_at, v_entitlement_key
  ) returning * into v_entitlement;

  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type,
    redacted_payload, source
  ) values (
    p_tenant_id, v_resident.id, p_case_id, p_actor_user_id,
    'production_case_claimed_after_verified_proof',
    jsonb_build_object(
      'challengeId', v_challenge.id,
      'entitlementId', v_entitlement.id,
      'method', v_challenge.method,
      'assuranceLevel', v_challenge.assurance_level,
      'scopes', to_jsonb(v_entitlement.scopes)
    ),
    'system'
  );

  return jsonb_build_object(
    'challengeId', v_challenge.id,
    'entitlementId', v_entitlement.id,
    'caseId', v_entitlement.case_id,
    'residentId', v_entitlement.resident_id,
    'state', v_entitlement.state,
    'scopes', to_jsonb(v_entitlement.scopes),
    'expiresAt', v_entitlement.expires_at,
    'duplicate', false
  );
end;
$$;

revoke all on function public.civya_service_claim_verified_production_case(
  uuid, uuid, uuid, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.civya_service_claim_verified_production_case(
  uuid, uuid, uuid, text, text, text, text, timestamptz
) to service_role;

comment on function public.civya_service_claim_verified_production_case(
  uuid, uuid, uuid, text, text, text, text, timestamptz
) is
  'Atomically binds one previously unclaimed non-fictional production case after verified identity proof, grants least-privilege case access, and audits the claim. Login alone is never sufficient.';

comment on table private.production_case_claim_receipts is
  'One-way provider-grant receipts for deterministic production case-claim replay. Stores only an opaque SHA-256 grant digest and chain identifiers; never proof answers or case facts.';

-- The browser never decides which County object a proof applies to. Every
-- account-upgrade flow carries this exact tuple in authenticated, encrypted
-- state, and the service compares it again before granting or moving anything.
alter table private.case_transfer_grants
  add column if not exists purpose text not null default 'case_access',
  add column if not exists scopes text[] not null default array[
    'case.read', 'case.participate', 'document.read', 'document.upload'
  ]::text[];

alter table private.case_transfer_grants
  drop constraint if exists case_transfer_grants_purpose_check;
alter table private.case_transfer_grants
  add constraint case_transfer_grants_purpose_check check (purpose = 'case_access');
alter table private.case_transfer_grants
  drop constraint if exists case_transfer_grants_scopes_check;
alter table private.case_transfer_grants
  add constraint case_transfer_grants_scopes_check check (
    coalesce(array_length(scopes, 1), 0) > 0
    and scopes <@ array[
      'case.read', 'case.participate', 'document.read', 'document.upload'
    ]::text[]
    and 'case.read' = any(scopes)
  );

create table public.entitlement_assistance_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete restrict,
  case_id uuid not null references public.cases(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose = 'case_access'),
  scopes text[] not null check (
    coalesce(array_length(scopes, 1), 0) > 0
    and scopes <@ array[
      'case.read', 'case.participate', 'document.read', 'document.upload'
    ]::text[]
    and 'case.read' = any(scopes)
  ),
  transfer_digest text check (
    transfer_digest is null or transfer_digest ~ '^[0-9a-f]{64}$'
  ),
  queue_key text not null default 'wayne_identity_review',
  state text not null default 'open'
    check (state in ('open', 'owned', 'approved', 'denied', 'expired', 'cancelled')),
  assigned_to_auth_user_id uuid references auth.users(id) on delete set null,
  correlation_id uuid not null,
  proof_challenge_id uuid references public.identity_proof_challenges(id) on delete restrict,
  entitlement_id uuid references public.case_entitlements(id) on delete restrict,
  resolution_code text,
  redacted_resolution text,
  sla_due_at timestamptz not null,
  expires_at timestamptz not null,
  resolved_at timestamptz,
  row_version bigint not null default 1,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  unique (correlation_id),
  check (sla_due_at > created_at and expires_at > sla_due_at),
  check (
    (state in ('open', 'owned') and resolved_at is null and resolution_code is null)
    or (state in ('approved', 'denied', 'expired', 'cancelled')
      and resolved_at is not null and resolution_code is not null)
  ),
  check (state <> 'owned' or assigned_to_auth_user_id is not null),
  check (state <> 'approved' or assigned_to_auth_user_id is not null)
);

create index entitlement_assistance_queue_idx
  on public.entitlement_assistance_requests
  (tenant_id, queue_key, state, sla_due_at, created_at)
  where state in ('open', 'owned');
create index entitlement_assistance_subject_idx
  on public.entitlement_assistance_requests (auth_user_id, state, created_at desc);

create trigger set_updated_at before update on public.entitlement_assistance_requests
  for each row execute function private.set_updated_at();

create table private.account_recovery_challenges (
  id uuid primary key default gen_random_uuid(),
  email_digest text not null check (email_digest ~ '^[0-9a-f]{64}$'),
  nonce_digest text not null check (nonce_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending'
    check (state in ('pending', 'verified', 'cancelled', 'expired')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  correlation_id uuid not null,
  auth_user_id uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  resolved_at timestamptz,
  used_at timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  unique (nonce_digest),
  unique (correlation_id),
  check (expires_at > created_at),
  check (
    (state = 'pending' and resolved_at is null and used_at is null)
    or (state = 'verified' and resolved_at is not null and used_at is not null
      and auth_user_id is not null)
    or (state in ('cancelled', 'expired') and resolved_at is not null)
  )
);

create index account_recovery_expiry_idx
  on private.account_recovery_challenges (expires_at)
  where state = 'pending';

revoke all on public.entitlement_assistance_requests
  from public, anon, authenticated, service_role;
revoke all on private.account_recovery_challenges
  from public, anon, authenticated, service_role;
grant select on public.entitlement_assistance_requests to service_role;

create or replace function public.civya_service_case_access_binding(
  p_actor_user_id uuid,
  p_case_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_case public.cases%rowtype;
  v_resident public.residents%rowtype;
  v_tenant public.tenants%rowtype;
  v_scopes text[] := array[
    'case.read', 'case.participate', 'document.read', 'document.upload'
  ]::text[];
begin
  perform private.civya_service_required();
  select * into v_case from public.cases where id = p_case_id;
  if not found then raise exception 'case access context unavailable' using errcode = 'P0002'; end if;
  select * into v_resident from public.residents where id = v_case.resident_id;
  select * into v_tenant from public.tenants where id = v_case.tenant_id and status = 'active';
  if v_resident.id is null or v_tenant.id is null then
    raise exception 'case access context unavailable' using errcode = 'P0002';
  end if;
  if v_tenant.environment = 'sandbox' and v_tenant.fictional then
    if v_resident.auth_user_id <> p_actor_user_id
       or not private.civya_has_tenant_access(p_actor_user_id, v_tenant.id) then
      raise exception 'case access context unavailable' using errcode = 'P0002';
    end if;
  elsif v_tenant.environment = 'production' and not v_tenant.fictional then
    if v_resident.auth_user_id is not null and v_resident.auth_user_id <> p_actor_user_id then
      raise exception 'case access context unavailable' using errcode = 'P0002';
    end if;
  else
    raise exception 'case access context unavailable' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'tenantId', v_tenant.id, 'tenantSlug', v_tenant.slug,
    'tenantEnvironment', v_tenant.environment, 'tenantFictional', v_tenant.fictional,
    'residentId', v_resident.id, 'caseId', v_case.id,
    'purpose', 'case_access', 'scopes', to_jsonb(v_scopes)
  );
end;
$$;

create or replace function public.civya_service_recovery_case_access_binding(
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_case_id uuid;
begin
  perform private.civya_service_required();
  select c.id into v_case_id
  from public.cases c
  join public.residents r on r.id = c.resident_id
  join public.tenants t on t.id = c.tenant_id and t.status = 'active'
  where r.auth_user_id = p_actor_user_id and c.active
  order by c.updated_at desc, c.id
  limit 1;
  if v_case_id is null then return null; end if;
  return public.civya_service_case_access_binding(p_actor_user_id, v_case_id);
end;
$$;

-- Every production authorization surface uses this exact proof lifecycle
-- predicate. An entitlement cannot outlive, weaken, or detach from the proof
-- that created it, even if its own state and expiry still look active.
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
declare
  v_case public.cases%rowtype;
  v_resident public.residents%rowtype;
  v_tenant public.tenants%rowtype;
  v_entitlement public.case_entitlements%rowtype;
  v_sandbox_expiry timestamptz;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or p_purpose <> 'case_access'
     or coalesce(array_length(p_required_scopes, 1), 0) = 0
     or not (p_required_scopes <@ array[
       'case.read', 'case.participate', 'document.read', 'document.upload'
     ]::text[])
     or not ('case.read' = any(p_required_scopes)) then
    return jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required');
  end if;
  select * into v_case from public.cases
  where id = p_case_id and tenant_id = p_tenant_id and active;
  if not found then return jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required'); end if;
  select * into v_resident from public.residents where id = v_case.resident_id;
  select * into v_tenant from public.tenants where id = p_tenant_id and status = 'active';
  if v_resident.id is null or v_tenant.id is null then
    return jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required');
  end if;

  if v_tenant.environment = 'sandbox' and v_tenant.fictional then
    if p_entitlement_id is not null or p_expected_row_version <> 0
       or v_resident.auth_user_id <> p_actor_user_id then
      return jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required');
    end if;
    select least(g.expires_at, i.expires_at) into v_sandbox_expiry
    from private.tenant_access_grants g
    join public.demo_invitations i on i.id = g.invitation_id
    where g.tenant_id = p_tenant_id and g.auth_user_id = p_actor_user_id
      and g.expires_at > now() and i.expires_at > now() and i.revoked_at is null
      and 'resident_demo' = any(i.scopes)
    limit 1;
    if v_sandbox_expiry is null then
      return jsonb_build_object('authorized', false, 'reason', 'fictional_invitation_required');
    end if;
    return jsonb_build_object(
      'authorized', true, 'accessType', 'fictional_invitation',
      'tenantId', p_tenant_id, 'caseId', p_case_id, 'purpose', p_purpose,
      'scopes', to_jsonb(p_required_scopes), 'rowVersion', 0,
      'expiresAt', v_sandbox_expiry
    );
  end if;

  if v_tenant.environment <> 'production' or v_tenant.fictional
     or p_entitlement_id is null or p_expected_row_version < 1 then
    return jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required');
  end if;
  select e.* into v_entitlement
  from public.case_entitlements e
  join public.identity_proof_challenges p on p.id = e.proof_challenge_id
  where e.id = p_entitlement_id and e.tenant_id = p_tenant_id
    and e.case_id = p_case_id and e.resident_id = v_case.resident_id
    and e.auth_user_id = p_actor_user_id and e.row_version = p_expected_row_version
    and e.state = 'active' and e.expires_at > now()
    and p.state = 'verified' and p.auth_user_id = p_actor_user_id
    and p.tenant_id = p_tenant_id and p.case_id = p_case_id
    and private.civya_entitlement_has_current_proof(e.id)
    and p_required_scopes <@ e.scopes;
  if not found then return jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required'); end if;
  return jsonb_build_object(
    'authorized', true, 'accessType', 'case_entitlement',
    'entitlementId', v_entitlement.id, 'tenantId', v_entitlement.tenant_id,
    'caseId', v_entitlement.case_id, 'purpose', p_purpose,
    'scopes', to_jsonb(v_entitlement.scopes), 'rowVersion', v_entitlement.row_version,
    'expiresAt', v_entitlement.expires_at
  );
end;
$$;

create or replace function private.civya_bound_case_transfer(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_transfer_digest text,
  p_expected_tenant_id uuid,
  p_expected_case_id uuid,
  p_expected_purpose text,
  p_expected_scopes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_grant private.case_transfer_grants%rowtype;
  v_case public.cases%rowtype;
  v_tenant public.tenants%rowtype;
  v_source public.residents%rowtype;
  v_target public.residents%rowtype;
  v_existing_case_id uuid;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or p_actor_is_anonymous or nullif(p_actor_email, '') is null
     or p_transfer_digest !~ '^[0-9a-f]{64}$'
     or p_expected_purpose <> 'case_access'
     or coalesce(array_length(p_expected_scopes, 1), 0) = 0
     or not (p_expected_scopes <@ array[
       'case.read', 'case.participate', 'document.read', 'document.upload'
     ]::text[])
     or not ('case.read' = any(p_expected_scopes)) then
    raise exception 'bound case transfer rejected' using errcode = '28000';
  end if;

  select * into v_grant from private.case_transfer_grants
  where token_hash = p_transfer_digest and used_at is null and expires_at > now()
    and tenant_id = p_expected_tenant_id and case_id = p_expected_case_id
    and purpose = p_expected_purpose and scopes = p_expected_scopes
  for update;
  if not found then raise exception 'bound case transfer rejected' using errcode = '28000'; end if;
  select * into v_case from public.cases
    where id = v_grant.case_id and tenant_id = v_grant.tenant_id for update;
  select * into v_tenant from public.tenants
    where id = v_grant.tenant_id and status = 'active';
  select * into v_source from public.residents
    where id = v_grant.source_resident_id and tenant_id = v_grant.tenant_id for update;
  if v_case.id is null or v_tenant.id is null or v_source.id is null
     or v_case.resident_id <> v_source.id then
    raise exception 'bound case transfer rejected' using errcode = '28000';
  end if;
  if v_tenant.environment = 'sandbox' and v_tenant.fictional then
    if not private.civya_has_tenant_access(v_grant.created_by_auth_user_id, v_grant.tenant_id) then
      raise exception 'bound case transfer rejected' using errcode = '28000';
    end if;
  elsif v_tenant.environment = 'production' and not v_tenant.fictional then
    if not private.civya_active_case_entitlement(
      v_grant.created_by_auth_user_id, v_grant.case_id, 'case.read'
    ) then
      raise exception 'bound case transfer rejected' using errcode = '28000';
    end if;
  else
    raise exception 'bound case transfer rejected' using errcode = '28000';
  end if;

  insert into public.residents (tenant_id, auth_user_id, identity_state, email)
  values (v_grant.tenant_id, p_actor_user_id, 'verified', p_actor_email)
  on conflict (tenant_id, auth_user_id) do update set
    identity_state = 'verified',
    email = coalesce(nullif(p_actor_email, ''), public.residents.email),
    last_active_at = now(),
    row_version = public.residents.row_version + 1
  returning * into v_target;

  if v_tenant.environment = 'sandbox' and v_tenant.fictional then
    insert into private.tenant_access_grants (
      tenant_id, auth_user_id, invitation_id, expires_at
    )
    select tenant_id, p_actor_user_id, invitation_id, expires_at
    from private.tenant_access_grants
    where tenant_id = v_grant.tenant_id
      and auth_user_id = v_grant.created_by_auth_user_id
      and expires_at > now()
    on conflict (tenant_id, auth_user_id) do update set
      invitation_id = excluded.invitation_id,
      expires_at = excluded.expires_at,
      updated_at = now();
  end if;

  if v_target.id = v_source.id then
    update private.case_transfer_grants
      set used_at = now(), claimed_by_auth_user_id = p_actor_user_id
      where id = v_grant.id and used_at is null;
    if not found then raise exception 'bound case transfer rejected' using errcode = '40001'; end if;
    return jsonb_build_object(
      'tenantId', v_tenant.id, 'tenantEnvironment', v_tenant.environment,
      'tenantFictional', v_tenant.fictional, 'caseId', v_grant.case_id,
      'residentId', v_target.id, 'purpose', v_grant.purpose,
      'scopes', to_jsonb(v_grant.scopes), 'requiresCaseSelection', false,
      'existingActiveCaseId', null
    );
  end if;

  select id into v_existing_case_id from public.cases
  where tenant_id = v_grant.tenant_id and resident_id = v_target.id
    and active and id <> v_grant.case_id
  order by updated_at desc, id
  limit 1 for update;

  if v_tenant.environment = 'production' then
    update public.case_delegations set
      state = 'revoked', revoked_at = now(), revocation_reason = 'case_transferred',
      row_version = row_version + 1
    where case_id = v_grant.case_id and state = 'active';
    update public.case_entitlements set
      state = 'revoked', revoked_at = now(), revocation_reason = 'case_transferred',
      row_version = row_version + 1
    where case_id = v_grant.case_id and state = 'active';
  end if;

  update public.cases set
    active = case when v_existing_case_id is null then active else false end,
    resident_id = v_target.id,
    row_version = row_version + 1
  where id = v_grant.case_id and resident_id = v_source.id;
  if not found then raise exception 'bound case transfer rejected' using errcode = '40001'; end if;

  update public.conversations set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.turns set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.case_facts set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.documents set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.checklist_items set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.consent set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.review_tasks set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.reminders set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.simulated_transactions set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.workflow_instances set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.referrals set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.hosted_handoff_sessions set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.communication_deliveries set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.document_processing_events set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.channel_sessions set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.call_sessions set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.entitlement_assistance_requests set resident_id = v_target.id
    where case_id = v_grant.case_id and state in ('open', 'owned');

  update private.case_transfer_grants
  set used_at = now(), claimed_by_auth_user_id = p_actor_user_id
  where id = v_grant.id and used_at is null;
  if not found then raise exception 'bound case transfer rejected' using errcode = '40001'; end if;

  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type,
    redacted_payload, source
  ) values (
    v_grant.tenant_id, v_target.id, v_grant.case_id, p_actor_user_id,
    'case_attached_after_exact_entitlement_binding',
    jsonb_build_object('purpose', v_grant.purpose, 'scopes', to_jsonb(v_grant.scopes)),
    'system'
  );
  return jsonb_build_object(
    'tenantId', v_tenant.id, 'tenantEnvironment', v_tenant.environment,
    'tenantFictional', v_tenant.fictional, 'caseId', v_grant.case_id,
    'residentId', v_target.id, 'purpose', v_grant.purpose,
    'scopes', to_jsonb(v_grant.scopes),
    'requiresCaseSelection', v_existing_case_id is not null,
    'existingActiveCaseId', v_existing_case_id
  );
end;
$$;

revoke all on function private.civya_bound_case_transfer(
  uuid, text, boolean, text, uuid, uuid, text, text[]
) from public, anon, authenticated;

create or replace function public.civya_service_finalize_bound_case_entitlement(
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
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_transfer jsonb;
  v_claim jsonb;
  v_challenge jsonb;
  v_resolution jsonb;
  v_grant jsonb;
  v_case public.cases%rowtype;
  v_resident public.residents%rowtype;
  v_entitlement public.case_entitlements%rowtype;
  v_db_method text;
  v_claim_digest text;
  v_challenge_digest text;
  v_evidence_digest text;
begin
  perform private.civya_service_required();
  if p_method not in ('notice_code', 'invitation_code')
     or p_provider_key <> 'wayne_county_case_entitlement'
     or p_verifier_grant_digest !~ '^[0-9a-f]{64}$'
     or p_expected_purpose <> 'case_access'
     or p_expected_scopes <> array[
       'case.read', 'case.participate', 'document.read', 'document.upload'
     ]::text[]
     or (p_transfer_digest is not null and p_transfer_digest !~ '^[0-9a-f]{64}$')
     or p_expires_at <= now() or p_expires_at > now() + interval '30 minutes'
     or nullif(p_idempotency_key, '') is null then
    raise exception 'bound entitlement finalization rejected' using errcode = '28000';
  end if;
  if p_transfer_digest is not null then
    v_transfer := private.civya_bound_case_transfer(
      p_actor_user_id, p_actor_email, p_actor_is_anonymous, p_transfer_digest,
      p_expected_tenant_id, p_expected_case_id, p_expected_purpose, p_expected_scopes
    );
  else
    if p_actor_user_id is null or p_actor_is_anonymous or nullif(p_actor_email, '') is null then
      raise exception 'bound entitlement finalization rejected' using errcode = '28000';
    end if;
    v_transfer := public.civya_service_case_access_binding(
      p_actor_user_id, p_expected_case_id
    );
  end if;
  if (v_transfer ->> 'caseId')::uuid <> p_expected_case_id
     or (v_transfer ->> 'tenantId')::uuid <> p_expected_tenant_id
     or v_transfer ->> 'purpose' <> p_expected_purpose
     or array(select jsonb_array_elements_text(v_transfer -> 'scopes')) <> p_expected_scopes then
    raise exception 'bound entitlement finalization rejected' using errcode = '28000';
  end if;

  if coalesce((v_transfer ->> 'tenantFictional')::boolean, false)
     and v_transfer ->> 'tenantEnvironment' = 'sandbox' then
    return v_transfer || jsonb_build_object(
      'accessType', 'fictional_invitation', 'entitlementId', null,
      'rowVersion', 0, 'expiresAt', p_expires_at
    );
  end if;
  if v_transfer ->> 'tenantEnvironment' <> 'production'
     or coalesce((v_transfer ->> 'tenantFictional')::boolean, true) then
    raise exception 'bound entitlement finalization rejected' using errcode = '28000';
  end if;

  select * into v_case from public.cases
  where id = p_expected_case_id and tenant_id = p_expected_tenant_id;
  select * into v_resident from public.residents
  where id = v_case.resident_id and tenant_id = p_expected_tenant_id
  for update;
  if v_case.id is null or v_resident.id is null
     or (v_resident.auth_user_id is not null
       and v_resident.auth_user_id <> p_actor_user_id) then
    raise exception 'bound entitlement finalization rejected' using errcode = '28000';
  end if;

  if v_resident.auth_user_id is null then
    v_claim := public.civya_service_claim_verified_production_case(
      p_expected_tenant_id, p_expected_case_id, p_actor_user_id,
      case when p_method = 'notice_code' then 'county_notice' else 'knowledge' end,
      p_provider_key, 'verified', p_verifier_grant_digest, p_expires_at
    );
    select * into strict v_entitlement from public.case_entitlements
    where id = (v_claim ->> 'entitlementId')::uuid;
    return v_transfer || jsonb_build_object(
      'accessType', 'case_entitlement', 'entitlementId', v_entitlement.id,
      'rowVersion', v_entitlement.row_version, 'expiresAt', v_entitlement.expires_at,
      'scopes', to_jsonb(v_entitlement.scopes),
      'requiresCaseSelection', false, 'existingActiveCaseId', null
    );
  end if;

  v_db_method := case when p_method = 'notice_code' then 'county_notice' else 'knowledge' end;
  v_claim_digest := encode(sha256(convert_to(concat_ws('|',
    'civya-bound-entitlement-v1', p_expected_tenant_id::text, p_expected_case_id::text,
    p_actor_user_id::text, p_expected_purpose, array_to_string(p_expected_scopes, ','),
    coalesce(p_transfer_digest, 'direct'), p_verifier_grant_digest
  ), 'UTF8')), 'hex');
  v_challenge_digest := encode(sha256(convert_to(
    'civya-bound-challenge-v1|' || v_claim_digest, 'UTF8'
  )), 'hex');
  v_evidence_digest := encode(sha256(convert_to(
    'civya-bound-evidence-v1|' || v_claim_digest, 'UTF8'
  )), 'hex');
  v_challenge := public.civya_service_create_identity_proof_challenge(
    p_actor_user_id, p_expected_case_id, v_db_method, p_provider_key,
    v_challenge_digest, p_expires_at, 'bound-proof:' || v_claim_digest
  );
  v_resolution := public.civya_service_resolve_identity_proof_challenge(
    (v_challenge ->> 'challengeId')::uuid, 'verified', 'substantial',
    v_evidence_digest, 'sha256:' || p_verifier_grant_digest
  );
  if v_resolution ->> 'state' <> 'verified' then
    raise exception 'bound entitlement finalization rejected' using errcode = '28000';
  end if;
  v_grant := public.civya_service_grant_case_entitlement(
    null, (v_challenge ->> 'challengeId')::uuid, p_expected_scopes,
    p_expires_at, 'external_case_identity_verified',
    'bound-entitlement:' || v_claim_digest
  );
  select * into strict v_entitlement from public.case_entitlements
    where id = (v_grant ->> 'entitlementId')::uuid;
  return v_transfer || jsonb_build_object(
    'accessType', 'case_entitlement', 'entitlementId', v_entitlement.id,
    'rowVersion', v_entitlement.row_version, 'expiresAt', v_entitlement.expires_at,
    'scopes', to_jsonb(v_entitlement.scopes)
  );
end;
$$;

create or replace function public.civya_service_create_entitlement_assistance_request(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_case_id uuid,
  p_purpose text,
  p_scopes text[],
  p_transfer_digest text,
  p_correlation_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_case public.cases%rowtype;
  v_resident public.residents%rowtype;
  v_transfer private.case_transfer_grants%rowtype;
  v_request public.entitlement_assistance_requests%rowtype;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null
     or not exists (
       select 1 from auth.users u
       where u.id = p_actor_user_id and nullif(u.email, '') is not null
     )
     or p_purpose <> 'case_access'
     or coalesce(array_length(p_scopes, 1), 0) = 0
     or not (p_scopes <@ array[
       'case.read', 'case.participate', 'document.read', 'document.upload'
     ]::text[])
     or not ('case.read' = any(p_scopes))
     or p_correlation_id is null
     or nullif(p_idempotency_key, '') is null then
    raise exception 'assistance request rejected' using errcode = '28000';
  end if;

  select * into v_case from public.cases
  where id = p_case_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'assistance request rejected' using errcode = 'P0002';
  end if;
  select * into v_resident from public.residents
  where id = v_case.resident_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'assistance request rejected' using errcode = 'P0002';
  end if;

  if p_transfer_digest is not null then
    if p_transfer_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'assistance request rejected' using errcode = '28000';
    end if;
    select * into v_transfer from private.case_transfer_grants
    where token_hash = p_transfer_digest
      and tenant_id = p_tenant_id
      and case_id = p_case_id
      and source_resident_id = v_resident.id
      and purpose = p_purpose
      and scopes = p_scopes
      and used_at is null
      and expires_at > now()
    for update;
    if not found then
      raise exception 'assistance request rejected' using errcode = '28000';
    end if;
  elsif v_resident.auth_user_id is distinct from p_actor_user_id
        and v_resident.auth_user_id is not null then
    raise exception 'assistance request rejected' using errcode = '28000';
  end if;

  insert into public.entitlement_assistance_requests (
    tenant_id, resident_id, case_id, auth_user_id, purpose, scopes,
    transfer_digest, correlation_id, sla_due_at, expires_at, idempotency_key
  ) values (
    p_tenant_id, v_resident.id, p_case_id, p_actor_user_id, p_purpose, p_scopes,
    p_transfer_digest, p_correlation_id, now() + interval '4 hours',
    now() + interval '24 hours', p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing
  returning * into v_request;
  if not found then
    v_duplicate := true;
    select * into strict v_request
    from public.entitlement_assistance_requests
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if v_request.auth_user_id <> p_actor_user_id
       or v_request.case_id <> p_case_id
       or v_request.purpose <> p_purpose
       or v_request.scopes <> p_scopes
       or v_request.transfer_digest is distinct from p_transfer_digest
       or v_request.correlation_id <> p_correlation_id then
      raise exception 'assistance request idempotency conflict' using errcode = '23505';
    end if;
  else
    insert into public.audit_events (
      tenant_id, resident_id, case_id, actor_user_id, event_type,
      redacted_payload, source
    ) values (
      v_request.tenant_id, v_request.resident_id, v_request.case_id,
      v_request.auth_user_id, 'entitlement_assistance_requested',
      jsonb_build_object(
        'requestId', v_request.id, 'correlationId', v_request.correlation_id,
        'queueKey', v_request.queue_key, 'purpose', v_request.purpose,
        'scopes', to_jsonb(v_request.scopes), 'slaDueAt', v_request.sla_due_at
      ), 'resident'
    );
  end if;
  return jsonb_build_object(
    'requestId', v_request.id, 'correlationId', v_request.correlation_id,
    'state', v_request.state, 'queueKey', v_request.queue_key,
    'slaDueAt', v_request.sla_due_at, 'expiresAt', v_request.expires_at,
    'rowVersion', v_request.row_version, 'duplicate', v_duplicate
  );
end;
$$;

create or replace function public.civya_service_entitlement_assistance_status(
  p_actor_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_request public.entitlement_assistance_requests%rowtype;
  v_entitlement public.case_entitlements%rowtype;
  v_access jsonb;
begin
  perform private.civya_service_required();
  select * into v_request from public.entitlement_assistance_requests
  where id = p_request_id and auth_user_id = p_actor_user_id
  for update;
  if not found then
    return jsonb_build_object('found', false, 'state', 'unavailable');
  end if;
  if v_request.state in ('open', 'owned') and v_request.expires_at <= now() then
    update public.entitlement_assistance_requests set
      state = 'expired', resolution_code = 'request_expired',
      resolved_at = now(), row_version = row_version + 1
    where id = v_request.id returning * into v_request;
    insert into public.audit_events (
      tenant_id, resident_id, case_id, actor_user_id, event_type,
      redacted_payload, source
    ) values (
      v_request.tenant_id, v_request.resident_id, v_request.case_id,
      v_request.auth_user_id, 'entitlement_assistance_expired',
      jsonb_build_object('requestId', v_request.id, 'correlationId', v_request.correlation_id),
      'system'
    );
  end if;
  if v_request.state = 'approved' then
    if v_request.entitlement_id is not null then
      select * into v_entitlement from public.case_entitlements
      where id = v_request.entitlement_id;
      if not found then
        raise exception 'approved assistance entitlement unavailable' using errcode = '55000';
      end if;
      v_access := public.civya_service_case_entitlement_cache_status(
        p_actor_user_id, v_entitlement.id, v_entitlement.row_version,
        v_request.tenant_id, v_request.case_id, v_request.purpose, v_request.scopes
      );
    else
      v_access := public.civya_service_case_entitlement_cache_status(
        p_actor_user_id, null, 0, v_request.tenant_id, v_request.case_id,
        v_request.purpose, v_request.scopes
      );
    end if;
  end if;
  return jsonb_build_object(
    'found', true, 'requestId', v_request.id,
    'correlationId', v_request.correlation_id, 'state', v_request.state,
    'queueKey', v_request.queue_key, 'slaDueAt', v_request.sla_due_at,
    'expiresAt', v_request.expires_at, 'rowVersion', v_request.row_version,
    'resolutionCode', v_request.resolution_code,
    'access', case when coalesce((v_access ->> 'authorized')::boolean, false)
      then v_access else null end
  );
end;
$$;

create or replace function public.civya_service_list_entitlement_assistance(
  p_staff_actor_user_id uuid,
  p_tenant_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
begin
  perform private.civya_service_required();
  if not private.civya_actor_is_staff(p_staff_actor_user_id, p_tenant_id)
     or p_limit < 1 or p_limit > 100 then
    raise exception 'tenant reviewer required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'requestId', q.id, 'correlationId', q.correlation_id,
      'state', q.state, 'queueKey', q.queue_key, 'purpose', q.purpose,
      'scopes', to_jsonb(q.scopes), 'slaDueAt', q.sla_due_at,
      'expiresAt', q.expires_at, 'rowVersion', q.row_version,
      'assignedToCurrentStaff', q.assigned_to_auth_user_id = p_staff_actor_user_id,
      'createdAt', q.created_at
    ) order by q.sla_due_at, q.created_at)
    from (
      select * from public.entitlement_assistance_requests
      where tenant_id = p_tenant_id and state in ('open', 'owned')
        and expires_at > now()
      order by sla_due_at, created_at
      limit p_limit
    ) q
  ), '[]'::jsonb);
end;
$$;

create or replace function public.civya_service_resolve_entitlement_assistance(
  p_staff_actor_user_id uuid,
  p_request_id uuid,
  p_expected_row_version bigint,
  p_decision text,
  p_resolution_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_request public.entitlement_assistance_requests%rowtype;
  v_resident public.residents%rowtype;
  v_target_email text;
  v_binding jsonb;
  v_challenge jsonb;
  v_resolution jsonb;
  v_grant jsonb;
  v_entitlement public.case_entitlements%rowtype;
  v_access jsonb;
  v_digest text;
  v_expires_at timestamptz;
begin
  perform private.civya_service_required();
  select * into v_request from public.entitlement_assistance_requests
  where id = p_request_id for update;
  if not found
     or not private.civya_actor_is_staff(
       p_staff_actor_user_id, v_request.tenant_id,
       case when p_decision = 'approve' then 'admin' else 'reviewer' end
     ) then
    raise exception 'tenant reviewer required' using errcode = '42501';
  end if;
  if p_decision not in ('claim', 'approve', 'deny')
     or p_expected_row_version <> v_request.row_version
     or (p_decision <> 'claim' and coalesce(p_resolution_code, '') !~ '^[a-z0-9_]{2,64}$')
     or v_request.state not in ('open', 'owned')
     or (v_request.state = 'owned'
       and v_request.assigned_to_auth_user_id <> p_staff_actor_user_id) then
    raise exception 'assistance resolution conflict' using errcode = '40001';
  end if;
  if v_request.expires_at <= now() then
    update public.entitlement_assistance_requests set
      state = 'expired', resolution_code = 'request_expired', resolved_at = now(),
      row_version = row_version + 1
    where id = v_request.id returning * into v_request;
    return jsonb_build_object(
      'requestId', v_request.id, 'state', v_request.state,
      'rowVersion', v_request.row_version, 'correlationId', v_request.correlation_id,
      'resolutionCode', v_request.resolution_code
    );
  end if;

  if v_request.state = 'open' then
    update public.entitlement_assistance_requests set
      state = 'owned', assigned_to_auth_user_id = p_staff_actor_user_id,
      row_version = row_version + 1
    where id = v_request.id returning * into v_request;
  end if;
  if p_decision = 'claim' then
    insert into public.audit_events (
      tenant_id, resident_id, case_id, actor_user_id, event_type,
      redacted_payload, source
    ) values (
      v_request.tenant_id, v_request.resident_id, v_request.case_id,
      p_staff_actor_user_id, 'entitlement_assistance_claimed',
      jsonb_build_object('requestId', v_request.id, 'correlationId', v_request.correlation_id),
      'admin'
    );
    return jsonb_build_object(
      'requestId', v_request.id, 'state', v_request.state,
      'rowVersion', v_request.row_version, 'correlationId', v_request.correlation_id
    );
  end if;
  if p_decision = 'deny' then
    update public.entitlement_assistance_requests set
      state = 'denied', resolution_code = p_resolution_code,
      redacted_resolution = 'Staff review did not establish case access.',
      resolved_at = now(), row_version = row_version + 1
    where id = v_request.id returning * into v_request;
    insert into public.audit_events (
      tenant_id, resident_id, case_id, actor_user_id, event_type,
      redacted_payload, source
    ) values (
      v_request.tenant_id, v_request.resident_id, v_request.case_id,
      p_staff_actor_user_id, 'entitlement_assistance_denied',
      jsonb_build_object(
        'requestId', v_request.id, 'correlationId', v_request.correlation_id,
        'resolutionCode', v_request.resolution_code
      ), 'admin'
    );
    return jsonb_build_object(
      'requestId', v_request.id, 'state', v_request.state,
      'rowVersion', v_request.row_version, 'correlationId', v_request.correlation_id,
      'resolutionCode', v_request.resolution_code
    );
  end if;

  select lower(trim(u.email)) into v_target_email
  from auth.users u where u.id = v_request.auth_user_id;
  if nullif(v_target_email, '') is null then
    raise exception 'assistance target unavailable' using errcode = '28000';
  end if;
  if v_request.transfer_digest is not null then
    v_binding := private.civya_bound_case_transfer(
      v_request.auth_user_id, v_target_email, false, v_request.transfer_digest,
      v_request.tenant_id, v_request.case_id, v_request.purpose, v_request.scopes
    );
  else
    select * into v_resident from public.residents
    where id = v_request.resident_id and tenant_id = v_request.tenant_id
    for update;
    if not found
       or (v_resident.auth_user_id is not null
         and v_resident.auth_user_id <> v_request.auth_user_id) then
      raise exception 'assistance target unavailable' using errcode = '28000';
    end if;
    if v_resident.auth_user_id is null then
      update public.residents set
        auth_user_id = v_request.auth_user_id, identity_state = 'verified',
        email = coalesce(email, v_target_email), last_active_at = now(),
        row_version = row_version + 1
      where id = v_resident.id and auth_user_id is null;
      if not found then
        raise exception 'assistance target unavailable' using errcode = '40001';
      end if;
    end if;
    v_binding := public.civya_service_case_access_binding(
      v_request.auth_user_id, v_request.case_id
    );
  end if;
  if (v_binding ->> 'tenantId')::uuid <> v_request.tenant_id
     or (v_binding ->> 'caseId')::uuid <> v_request.case_id
     or v_binding ->> 'purpose' <> v_request.purpose
     or array(select jsonb_array_elements_text(v_binding -> 'scopes')) <> v_request.scopes then
    raise exception 'assistance binding mismatch' using errcode = '28000';
  end if;

  v_expires_at := least(v_request.expires_at, now() + interval '30 minutes');
  if v_binding ->> 'tenantEnvironment' = 'production'
     and not coalesce((v_binding ->> 'tenantFictional')::boolean, true) then
    v_digest := encode(sha256(convert_to(concat_ws('|',
      'civya-staff-assisted-v1', v_request.id::text, v_request.tenant_id::text,
      v_request.case_id::text, v_request.auth_user_id::text,
      p_staff_actor_user_id::text, p_resolution_code
    ), 'UTF8')), 'hex');
    v_challenge := public.civya_service_create_identity_proof_challenge(
      v_request.auth_user_id, v_request.case_id, 'staff_assisted',
      'wayne_county_staff_identity_review',
      encode(sha256(convert_to('challenge|' || v_digest, 'UTF8')), 'hex'),
      v_expires_at, 'staff-proof:' || v_digest
    );
    v_resolution := public.civya_service_resolve_identity_proof_challenge(
      (v_challenge ->> 'challengeId')::uuid, 'verified', 'substantial',
      encode(sha256(convert_to('evidence|' || v_digest, 'UTF8')), 'hex'),
      'assistance:' || v_request.id::text
    );
    v_grant := public.civya_service_grant_case_entitlement(
      p_staff_actor_user_id, (v_challenge ->> 'challengeId')::uuid,
      v_request.scopes, v_expires_at, p_resolution_code,
      'staff-entitlement:' || v_digest
    );
    select * into strict v_entitlement from public.case_entitlements
    where id = (v_grant ->> 'entitlementId')::uuid;
    v_access := public.civya_service_case_entitlement_cache_status(
      v_request.auth_user_id, v_entitlement.id, v_entitlement.row_version,
      v_request.tenant_id, v_request.case_id, v_request.purpose, v_request.scopes
    );
  elsif v_binding ->> 'tenantEnvironment' = 'sandbox'
        and coalesce((v_binding ->> 'tenantFictional')::boolean, false) then
    v_access := public.civya_service_case_entitlement_cache_status(
      v_request.auth_user_id, null, 0, v_request.tenant_id,
      v_request.case_id, v_request.purpose, v_request.scopes
    );
  else
    raise exception 'assistance target unavailable' using errcode = '28000';
  end if;
  if not coalesce((v_access ->> 'authorized')::boolean, false) then
    raise exception 'assistance grant unavailable' using errcode = '28000';
  end if;

  select * into v_request from public.entitlement_assistance_requests
  where id = p_request_id for update;
  update public.entitlement_assistance_requests set
    state = 'approved', proof_challenge_id = case when v_challenge is null then null
      else (v_challenge ->> 'challengeId')::uuid end,
    entitlement_id = v_entitlement.id, resolution_code = p_resolution_code,
    redacted_resolution = 'Staff review established time-limited case access.',
    resolved_at = now(), row_version = row_version + 1
  where id = v_request.id returning * into v_request;
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type,
    redacted_payload, source
  ) values (
    v_request.tenant_id, v_request.resident_id, v_request.case_id,
    p_staff_actor_user_id, 'entitlement_assistance_approved',
    jsonb_build_object(
      'requestId', v_request.id, 'correlationId', v_request.correlation_id,
      'resolutionCode', v_request.resolution_code,
      'entitlementId', v_request.entitlement_id, 'purpose', v_request.purpose,
      'scopes', to_jsonb(v_request.scopes)
    ), 'admin'
  );
  return jsonb_build_object(
    'requestId', v_request.id, 'state', v_request.state,
    'rowVersion', v_request.row_version, 'correlationId', v_request.correlation_id,
    'resolutionCode', v_request.resolution_code, 'access', v_access
  );
end;
$$;

create or replace function public.civya_service_create_account_recovery_challenge(
  p_email_digest text,
  p_nonce_digest text,
  p_correlation_id uuid,
  p_expires_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_challenge private.account_recovery_challenges%rowtype;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  if p_email_digest !~ '^[0-9a-f]{64}$'
     or p_nonce_digest !~ '^[0-9a-f]{64}$'
     or p_correlation_id is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '15 minutes'
     or nullif(p_idempotency_key, '') is null then
    raise exception 'recovery challenge rejected' using errcode = '28000';
  end if;
  insert into private.account_recovery_challenges (
    email_digest, nonce_digest, correlation_id, expires_at, idempotency_key
  ) values (
    p_email_digest, p_nonce_digest, p_correlation_id, p_expires_at, p_idempotency_key
  ) on conflict (idempotency_key) do nothing returning * into v_challenge;
  if not found then
    v_duplicate := true;
    select * into strict v_challenge from private.account_recovery_challenges
    where idempotency_key = p_idempotency_key;
    if v_challenge.email_digest <> p_email_digest
       or v_challenge.nonce_digest <> p_nonce_digest
       or v_challenge.correlation_id <> p_correlation_id
       or v_challenge.expires_at <> p_expires_at then
      raise exception 'recovery challenge idempotency conflict' using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object(
    'challengeId', v_challenge.id, 'correlationId', v_challenge.correlation_id,
    'state', v_challenge.state, 'expiresAt', v_challenge.expires_at,
    'duplicate', v_duplicate
  );
end;
$$;

create or replace function public.civya_service_resolve_account_recovery_challenge(
  p_challenge_id uuid,
  p_nonce_digest text,
  p_result text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_challenge private.account_recovery_challenges%rowtype;
  v_actor_email_digest text;
begin
  perform private.civya_service_required();
  if p_nonce_digest !~ '^[0-9a-f]{64}$' or p_result not in ('verified', 'failed') then
    raise exception 'recovery resolution rejected' using errcode = '28000';
  end if;
  select * into v_challenge from private.account_recovery_challenges
  where id = p_challenge_id and nonce_digest = p_nonce_digest
  for update;
  if not found then
    raise exception 'recovery resolution rejected' using errcode = '28000';
  end if;
  if v_challenge.state <> 'pending' then
    raise exception 'recovery challenge already consumed' using errcode = '28000';
  end if;
  if v_challenge.expires_at <= now() then
    update private.account_recovery_challenges set
      state = 'expired', resolved_at = now(), attempt_count = attempt_count + 1
    where id = v_challenge.id returning * into v_challenge;
    return jsonb_build_object(
      'challengeId', v_challenge.id, 'state', v_challenge.state,
      'attemptCount', v_challenge.attempt_count
    );
  end if;
  if p_result = 'failed' then
    update private.account_recovery_challenges set
      attempt_count = attempt_count + 1,
      state = case when attempt_count + 1 >= 5 then 'cancelled' else state end,
      resolved_at = case when attempt_count + 1 >= 5 then now() else resolved_at end
    where id = v_challenge.id returning * into v_challenge;
    return jsonb_build_object(
      'challengeId', v_challenge.id, 'state', v_challenge.state,
      'attemptCount', v_challenge.attempt_count
    );
  end if;
  select encode(sha256(convert_to(
    'civya-recovery-email-v1|' || lower(trim(u.email)), 'UTF8'
  )), 'hex') into v_actor_email_digest
  from auth.users u
  where u.id = p_actor_user_id and nullif(u.email, '') is not null;
  if v_actor_email_digest is null or v_actor_email_digest <> v_challenge.email_digest then
    raise exception 'recovery resolution rejected' using errcode = '28000';
  end if;
  update private.account_recovery_challenges set
    state = 'verified', auth_user_id = p_actor_user_id,
    attempt_count = attempt_count + 1, resolved_at = now(), used_at = now()
  where id = v_challenge.id and state = 'pending'
  returning * into v_challenge;
  if not found then
    raise exception 'recovery challenge already consumed' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'challengeId', v_challenge.id, 'correlationId', v_challenge.correlation_id,
    'state', v_challenge.state, 'actorUserId', v_challenge.auth_user_id,
    'usedAt', v_challenge.used_at
  );
end;
$$;

revoke all on function public.civya_service_case_access_binding(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_recovery_case_access_binding(uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_case_entitlement_cache_status(
  uuid, uuid, bigint, uuid, uuid, text, text[]
) from public, anon, authenticated;
revoke all on function public.civya_service_finalize_bound_case_entitlement(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text, text,
  timestamptz, text
) from public, anon, authenticated;
revoke all on function public.civya_service_create_entitlement_assistance_request(
  uuid, uuid, uuid, text, text[], text, uuid, text
) from public, anon, authenticated;
revoke all on function public.civya_service_entitlement_assistance_status(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_list_entitlement_assistance(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.civya_service_resolve_entitlement_assistance(
  uuid, uuid, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.civya_service_create_account_recovery_challenge(
  text, text, uuid, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.civya_service_resolve_account_recovery_challenge(
  uuid, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.civya_service_case_access_binding(uuid, uuid)
  to service_role;
grant execute on function public.civya_service_recovery_case_access_binding(uuid)
  to service_role;
grant execute on function public.civya_service_case_entitlement_cache_status(
  uuid, uuid, bigint, uuid, uuid, text, text[]
) to service_role;
grant execute on function public.civya_service_finalize_bound_case_entitlement(
  uuid, text, boolean, text, uuid, uuid, text, text[], text, text, text,
  timestamptz, text
) to service_role;
grant execute on function public.civya_service_create_entitlement_assistance_request(
  uuid, uuid, uuid, text, text[], text, uuid, text
) to service_role;
grant execute on function public.civya_service_entitlement_assistance_status(uuid, uuid)
  to service_role;
grant execute on function public.civya_service_list_entitlement_assistance(uuid, uuid, integer)
  to service_role;
grant execute on function public.civya_service_resolve_entitlement_assistance(
  uuid, uuid, bigint, text, text
) to service_role;
grant execute on function public.civya_service_create_account_recovery_challenge(
  text, text, uuid, timestamptz, text
) to service_role;
grant execute on function public.civya_service_resolve_account_recovery_challenge(
  uuid, text, text, uuid
) to service_role;

comment on table public.entitlement_assistance_requests is
  'Durable, tenant-scoped human identity-review queue with resident correlation, SLA, optimistic ownership, audit state, and the final entitlement reference.';
comment on table private.account_recovery_challenges is
  'One-time, non-enumerating recovery state. It stores only email and nonce digests and rejects expiry, account mismatch, and replay.';

-- A transfer into an account that already owns an active case cannot mint a
-- browser grant for the newly attached, inactive case. Hold both candidates
-- in a one-time server record until the resident chooses; only the selected
-- active case is returned as browser-cache material.
create table private.case_entitlement_selections (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  attached_case_id uuid not null references public.cases(id) on delete restrict,
  attached_entitlement_id uuid references public.case_entitlements(id) on delete restrict,
  existing_case_id uuid not null references public.cases(id) on delete restrict,
  existing_entitlement_id uuid references public.case_entitlements(id) on delete restrict,
  access_type text not null check (access_type in ('case_entitlement', 'fictional_invitation')),
  purpose text not null check (purpose = 'case_access'),
  scopes text[] not null check (scopes = array[
    'case.read', 'case.participate', 'document.read', 'document.upload'
  ]::text[]),
  expires_at timestamptz not null,
  selected_case_id uuid references public.cases(id) on delete restrict,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (attached_case_id <> existing_case_id),
  check (expires_at > created_at),
  check (
    (access_type = 'case_entitlement' and attached_entitlement_id is not null)
    or (access_type = 'fictional_invitation' and attached_entitlement_id is null
      and existing_entitlement_id is null)
  ),
  check (
    (used_at is null and selected_case_id is null)
    or (used_at is not null and selected_case_id in (attached_case_id, existing_case_id))
  )
);

create index case_entitlement_selections_expiry_idx
  on private.case_entitlement_selections (expires_at)
  where used_at is null;

revoke all on private.case_entitlement_selections
  from public, anon, authenticated, service_role;

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
  v_attached public.cases%rowtype;
  v_existing public.cases%rowtype;
  v_resident public.residents%rowtype;
  v_tenant public.tenants%rowtype;
  v_attached_entitlement public.case_entitlements%rowtype;
  v_existing_entitlement public.case_entitlements%rowtype;
  v_sandbox_expiry timestamptz;
  v_effective_expiry timestamptz;
  v_selection private.case_entitlement_selections%rowtype;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or p_selection_id is null
     or p_attached_case_id = p_existing_case_id
     or p_access_type not in ('case_entitlement', 'fictional_invitation')
     or p_purpose <> 'case_access'
     or p_scopes <> array[
       'case.read', 'case.participate', 'document.read', 'document.upload'
     ]::text[]
     or p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;
  select * into v_attached from public.cases
  where id = p_attached_case_id for update;
  select * into v_existing from public.cases
  where id = p_existing_case_id for update;
  if v_attached.id is null or v_existing.id is null
     or v_attached.active or not v_existing.active
     or v_attached.tenant_id <> v_existing.tenant_id
     or v_attached.resident_id <> v_existing.resident_id then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;
  select * into v_resident from public.residents
  where id = v_attached.resident_id and tenant_id = v_attached.tenant_id
    and auth_user_id = p_actor_user_id and identity_state = 'verified';
  select * into v_tenant from public.tenants
  where id = v_attached.tenant_id and status = 'active';
  if v_resident.id is null or v_tenant.id is null then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;

  if v_tenant.environment = 'production' and not v_tenant.fictional
     and p_access_type = 'case_entitlement' then
    select e.* into v_attached_entitlement
    from public.case_entitlements e
    join public.identity_proof_challenges p on p.id = e.proof_challenge_id
    where e.id = p_attached_entitlement_id
      and e.tenant_id = v_tenant.id and e.case_id = v_attached.id
      and e.resident_id = v_resident.id and e.auth_user_id = p_actor_user_id
      and e.state = 'active' and e.expires_at > now() and p_scopes <@ e.scopes
      and p.state = 'verified' and p.tenant_id = v_tenant.id
      and p.case_id = v_attached.id and p.resident_id = v_resident.id
      and p.auth_user_id = p_actor_user_id
      and private.civya_entitlement_has_current_proof(e.id);
    if not found then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
    select e.* into v_existing_entitlement
    from public.case_entitlements e
    join public.identity_proof_challenges p on p.id = e.proof_challenge_id
    where e.tenant_id = v_tenant.id and e.case_id = v_existing.id
      and e.resident_id = v_resident.id and e.auth_user_id = p_actor_user_id
      and e.state = 'active' and e.expires_at > now() and p_scopes <@ e.scopes
      and p.state = 'verified' and p.tenant_id = v_tenant.id
      and p.case_id = v_existing.id and p.resident_id = v_resident.id
      and p.auth_user_id = p_actor_user_id
      and private.civya_entitlement_has_current_proof(e.id)
    order by e.expires_at desc, e.id
    limit 1;
    v_effective_expiry := least(
      p_expires_at, v_attached_entitlement.expires_at,
      coalesce(v_existing_entitlement.expires_at, p_expires_at)
    );
  elsif v_tenant.environment = 'sandbox' and v_tenant.fictional
        and p_access_type = 'fictional_invitation'
        and p_attached_entitlement_id is null then
    select least(g.expires_at, i.expires_at) into v_sandbox_expiry
    from private.tenant_access_grants g
    join public.demo_invitations i on i.id = g.invitation_id
    where g.tenant_id = v_tenant.id and g.auth_user_id = p_actor_user_id
      and g.expires_at > now() and i.expires_at > now() and i.revoked_at is null
      and 'resident_demo' = any(i.scopes)
    limit 1;
    if v_sandbox_expiry is null then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
    v_effective_expiry := least(p_expires_at, v_sandbox_expiry);
  else
    raise exception 'case selection rejected' using errcode = '28000';
  end if;

  insert into private.case_entitlement_selections (
    id, tenant_id, resident_id, auth_user_id, attached_case_id,
    attached_entitlement_id, existing_case_id, existing_entitlement_id,
    access_type, purpose, scopes, expires_at
  ) values (
    p_selection_id, v_tenant.id, v_resident.id, p_actor_user_id,
    v_attached.id, v_attached_entitlement.id, v_existing.id,
    v_existing_entitlement.id, p_access_type, p_purpose, p_scopes,
    v_effective_expiry
  ) returning * into v_selection;
  return jsonb_build_object(
    'selectionId', v_selection.id, 'tenantId', v_selection.tenant_id,
    'attachedCaseId', v_selection.attached_case_id,
    'existingActiveCaseId', v_selection.existing_case_id,
    'existingCaseAvailable', v_selection.access_type = 'fictional_invitation'
      or v_selection.existing_entitlement_id is not null,
    'expiresAt', v_selection.expires_at
  );
end;
$$;

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
  v_attached public.cases%rowtype;
  v_existing public.cases%rowtype;
  v_selected public.cases%rowtype;
  v_entitlement public.case_entitlements%rowtype;
  v_sandbox_expiry timestamptz;
begin
  perform private.civya_service_required();
  select * into v_selection from private.case_entitlement_selections
  where id = p_selection_id and auth_user_id = p_actor_user_id
    and used_at is null and expires_at > now()
  for update;
  if not found or p_selected_case_id not in (
    v_selection.attached_case_id, v_selection.existing_case_id
  ) then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;
  perform 1 from public.cases
  where resident_id = v_selection.resident_id
  order by id for update;
  select * into v_attached from public.cases
  where id = v_selection.attached_case_id and tenant_id = v_selection.tenant_id
    and resident_id = v_selection.resident_id;
  select * into v_existing from public.cases
  where id = v_selection.existing_case_id and tenant_id = v_selection.tenant_id
    and resident_id = v_selection.resident_id;
  if v_attached.id is null or v_existing.id is null
     or v_attached.active or not v_existing.active then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;

  if v_selection.access_type = 'case_entitlement' then
    select e.* into v_entitlement
    from public.case_entitlements e
    join public.identity_proof_challenges p on p.id = e.proof_challenge_id
    where e.id = case when p_selected_case_id = v_selection.attached_case_id
        then v_selection.attached_entitlement_id
        else v_selection.existing_entitlement_id end
      and e.tenant_id = v_selection.tenant_id
      and e.case_id = p_selected_case_id
      and e.resident_id = v_selection.resident_id
      and e.auth_user_id = p_actor_user_id
      and e.state = 'active' and e.expires_at > now()
      and v_selection.scopes <@ e.scopes
      and p.state = 'verified' and p.tenant_id = e.tenant_id
      and p.case_id = e.case_id and p.resident_id = e.resident_id
      and p.auth_user_id = e.auth_user_id
      and private.civya_entitlement_has_current_proof(e.id);
    if not found then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
  else
    select least(g.expires_at, i.expires_at) into v_sandbox_expiry
    from private.tenant_access_grants g
    join public.demo_invitations i on i.id = g.invitation_id
    where g.tenant_id = v_selection.tenant_id
      and g.auth_user_id = p_actor_user_id
      and g.expires_at > now() and i.expires_at > now() and i.revoked_at is null
      and 'resident_demo' = any(i.scopes)
    limit 1;
    if v_sandbox_expiry is null then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
  end if;

  if p_selected_case_id = v_selection.attached_case_id then
    update public.cases set active = false, row_version = row_version + 1
    where id = v_selection.existing_case_id and active;
    update public.cases set active = true, row_version = row_version + 1
    where id = v_selection.attached_case_id and not active;
    if not found then
      raise exception 'case selection rejected' using errcode = '40001';
    end if;
  end if;
  select * into v_selected from public.cases
  where id = p_selected_case_id and active;
  if not found then
    raise exception 'case selection rejected' using errcode = '40001';
  end if;
  update private.case_entitlement_selections set
    selected_case_id = p_selected_case_id, used_at = now()
  where id = v_selection.id and used_at is null;
  if not found then
    raise exception 'case selection rejected' using errcode = '40001';
  end if;
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type,
    redacted_payload, source
  ) values (
    v_selection.tenant_id, v_selection.resident_id, p_selected_case_id,
    p_actor_user_id, 'resident_entitled_case_selected',
    jsonb_build_object(
      'selectionId', v_selection.id,
      'attachedCaseId', v_selection.attached_case_id,
      'existingCaseId', v_selection.existing_case_id,
      'merged', false
    ), 'resident'
  );
  return jsonb_build_object(
    'authorized', true, 'accessType', v_selection.access_type,
    'entitlementId', v_entitlement.id, 'rowVersion', coalesce(v_entitlement.row_version, 0),
    'tenantId', v_selection.tenant_id, 'caseId', v_selected.id,
    'purpose', v_selection.purpose, 'scopes', to_jsonb(v_selection.scopes),
    'expiresAt', case when v_selection.access_type = 'case_entitlement'
      then least(v_selection.expires_at, v_entitlement.expires_at)
      else least(v_selection.expires_at, v_sandbox_expiry) end,
    'casesMerged', false
  );
end;
$$;

revoke all on function public.civya_service_create_case_entitlement_selection(
  uuid, uuid, uuid, uuid, uuid, text, text, text[], timestamptz
) from public, anon, authenticated;
revoke all on function public.civya_service_select_entitled_case(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.civya_service_create_case_entitlement_selection(
  uuid, uuid, uuid, uuid, uuid, text, text, text[], timestamptz
) to service_role;
grant execute on function public.civya_service_select_entitled_case(uuid, uuid, uuid)
  to service_role;

comment on table private.case_entitlement_selections is
  'One-time exact case-choice handoffs. Inactive cases never become browser grants; selection atomically activates and returns only the chosen authorized case.';
