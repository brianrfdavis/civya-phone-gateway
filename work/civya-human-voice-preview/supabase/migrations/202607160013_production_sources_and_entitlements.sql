-- Governed production sources, versioned decision artifacts, and explicit
-- case entitlements. Authentication establishes an account only. For every
-- non-fictional tenant, case access requires a current case-scoped entitlement
-- (or a current delegation derived from one). The invitation/ownership path is
-- retained exclusively for the fictional sandbox.

-- ---------------------------------------------------------------------------
-- Extend the synthetic authoritative-source kernel without weakening history.
-- Existing rows retain synthetic assurance; production rows must be registered
-- against an approved immutable contract and promoted after control validation.
-- ---------------------------------------------------------------------------

alter table public.authoritative_source_systems
  drop constraint if exists authoritative_source_systems_status_check;
alter table public.authoritative_source_systems
  drop constraint if exists authoritative_source_systems_fictional_check;

alter table public.authoritative_source_systems
  add column assurance_scope text not null default 'synthetic',
  add column authentication_method text not null default 'synthetic',
  add column freshness_sla_seconds integer not null default 86400,
  add column data_classification text not null default 'restricted';

alter table public.authoritative_source_systems
  add constraint authoritative_source_systems_status_check
    check (status in ('pending_approval', 'active', 'suspended', 'retired', 'synthetic')),
  add constraint authoritative_source_systems_assurance_scope_check
    check (assurance_scope in ('synthetic', 'county_attested', 'provider_attested')),
  add constraint authoritative_source_systems_authentication_method_check
    check (authentication_method in ('synthetic', 'mtls', 'signed_file', 'oauth2', 'private_network')),
  add constraint authoritative_source_systems_freshness_sla_check
    check (freshness_sla_seconds between 60 and 2592000),
  add constraint authoritative_source_systems_classification_check
    check (data_classification in ('internal', 'confidential', 'restricted')),
  add constraint authoritative_source_systems_scope_check
    check (
      (status = 'synthetic' and fictional and assurance_scope = 'synthetic'
        and authentication_method = 'synthetic')
      or status <> 'synthetic'
    );

alter table public.authoritative_source_batches
  drop constraint if exists authoritative_source_batches_authentication_state_check;

alter table public.authoritative_source_batches
  add column assurance_scope text not null default 'synthetic',
  add column expected_record_count integer,
  add column declared_control_totals jsonb not null default '{}'::jsonb,
  add column correction_of_batch_id uuid references public.authoritative_source_batches(id) on delete restrict,
  add column contract_version text,
  add column transport_reference_digest text,
  add column freshness_deadline_at timestamptz;

alter table public.authoritative_source_batches
  add constraint authoritative_source_batches_authentication_state_check
    check (authentication_state in ('synthetic', 'verified', 'failed')),
  add constraint authoritative_source_batches_assurance_scope_check
    check (assurance_scope in ('synthetic', 'county_attested', 'provider_attested')),
  add constraint authoritative_source_batches_record_count_check
    check (expected_record_count is null or expected_record_count >= 0),
  add constraint authoritative_source_batches_control_totals_check
    check (jsonb_typeof(declared_control_totals) = 'object'),
  add constraint authoritative_source_batches_transport_digest_check
    check (transport_reference_digest is null or transport_reference_digest ~ '^[0-9a-f]{64}$'),
  add constraint authoritative_source_batches_freshness_check
    check (freshness_deadline_at is null or freshness_deadline_at >= source_generated_at),
  add constraint authoritative_source_batches_correction_check
    check (correction_of_batch_id is null or correction_of_batch_id <> id);

alter table public.authoritative_source_records
  add column schema_validation_state text not null default 'valid',
  add column data_classification text not null default 'restricted',
  add column record_position integer;

alter table public.authoritative_source_records
  add constraint authoritative_source_records_schema_state_check
    check (schema_validation_state in ('valid', 'invalid', 'quarantined')),
  add constraint authoritative_source_records_classification_check
    check (data_classification in ('internal', 'confidential', 'restricted')),
  add constraint authoritative_source_records_position_check
    check (record_position is null or record_position > 0);

create unique index authoritative_source_records_batch_external_unique
  on public.authoritative_source_records (source_batch_id, external_record_id);

alter table public.outcome_definition_versions
  drop constraint if exists outcome_definition_versions_status_check;
alter table public.outcome_definition_versions
  add column assurance_scope text not null default 'synthetic';
alter table public.outcome_definition_versions
  add constraint outcome_definition_versions_status_check
    check (status in ('draft', 'synthetic_test', 'approved', 'active', 'retired')),
  add constraint outcome_definition_versions_assurance_scope_check
    check (assurance_scope in ('synthetic', 'county_attested', 'provider_attested'));

alter table public.case_outcome_projections
  drop constraint if exists case_outcome_projections_evidence_scope_check;
alter table public.case_outcome_projections
  add constraint case_outcome_projections_evidence_scope_check
    check (evidence_scope in ('synthetic', 'county_attested', 'provider_attested'));

create table public.authoritative_source_contract_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  source_system_id uuid not null references public.authoritative_source_systems(id) on delete restrict,
  source_key text not null,
  version text not null,
  schema_version text not null,
  status text not null check (status in ('draft', 'approved', 'active', 'retired')),
  authority_scope text[] not null,
  required_fields text[] not null default '{}'::text[],
  control_total_keys text[] not null default '{}'::text[],
  maximum_age_seconds integer not null check (maximum_age_seconds between 60 and 2592000),
  authentication_method text not null
    check (authentication_method in ('mtls', 'signed_file', 'oauth2', 'private_network')),
  contract_sha256 text not null check (contract_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  approved_by_auth_user_id uuid references auth.users(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, source_system_id, version),
  check (coalesce(array_length(authority_scope, 1), 0) > 0),
  check (array_position(authority_scope, null) is null),
  check (array_position(required_fields, null) is null),
  check (array_position(control_total_keys, null) is null),
  check (effective_to is null or effective_to > effective_from),
  check (
    status = 'draft'
    or (approved_by_auth_user_id is not null and approved_at is not null)
  )
);

create unique index authoritative_source_contract_one_active_idx
  on public.authoritative_source_contract_versions (tenant_id, source_system_id)
  where status = 'active';

create table public.source_batch_control_validations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  source_batch_id uuid not null references public.authoritative_source_batches(id) on delete restrict,
  source_contract_id uuid not null references public.authoritative_source_contract_versions(id) on delete restrict,
  observed_record_count integer not null check (observed_record_count >= 0),
  calculated_control_totals jsonb not null check (jsonb_typeof(calculated_control_totals) = 'object'),
  schema_valid boolean not null,
  control_totals_match boolean not null,
  record_count_matches boolean not null,
  freshness_state text not null check (freshness_state in ('fresh', 'stale', 'future_dated')),
  result text not null check (result in ('passed', 'failed', 'requires_review')),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  validator_release text not null,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table public.source_batch_promotion_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  source_batch_id uuid not null references public.authoritative_source_batches(id) on delete restrict,
  validation_id uuid not null references public.source_batch_control_validations(id) on delete restrict,
  decision text not null check (decision in ('accepted', 'quarantined', 'rejected')),
  assurance_scope text not null check (assurance_scope in ('county_attested', 'provider_attested')),
  reason_code text not null,
  decided_by_type text not null check (decided_by_type in ('service', 'staff')),
  decided_by_auth_user_id uuid references auth.users(id) on delete restrict,
  supersedes_event_id uuid references public.source_batch_promotion_events(id) on delete restrict,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (
    (decided_by_type = 'staff' and decided_by_auth_user_id is not null)
    or (decided_by_type = 'service' and decided_by_auth_user_id is null)
  )
);

create index source_batch_promotion_current_idx
  on public.source_batch_promotion_events (source_batch_id, created_at desc);

create table public.source_correction_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  source_system_id uuid not null references public.authoritative_source_systems(id) on delete restrict,
  source_batch_id uuid references public.authoritative_source_batches(id) on delete restrict,
  source_record_id uuid references public.authoritative_source_records(id) on delete restrict,
  case_id uuid references public.cases(id) on delete restrict,
  reason_code text not null,
  redacted_description text not null,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'corrected', 'rejected', 'closed')),
  provider_reference text,
  correction_batch_id uuid references public.authoritative_source_batches(id) on delete restrict,
  requested_by_type text not null check (requested_by_type in ('service', 'staff', 'resident')),
  requested_by_auth_user_id uuid references auth.users(id) on delete set null,
  row_version bigint not null default 1,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (tenant_id, idempotency_key),
  check (source_batch_id is not null or source_record_id is not null),
  check (correction_batch_id is null or correction_batch_id <> source_batch_id),
  check (
    requested_by_type = 'service'
    or requested_by_auth_user_id is not null
  )
);

create trigger set_updated_at before update on public.source_correction_requests
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Immutable, versioned rules, resident content, completion requirements, and
-- workflow state machines. Models may help converse; these artifacts retain
-- deterministic authority for consequential actions.
-- ---------------------------------------------------------------------------

create table public.rule_definition_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  rule_key text not null check (rule_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version text not null,
  status text not null check (status in ('draft', 'approved', 'active', 'retired', 'synthetic_test')),
  input_schema jsonb not null check (jsonb_typeof(input_schema) = 'object'),
  deterministic_spec jsonb not null check (jsonb_typeof(deterministic_spec) = 'object'),
  output_schema jsonb not null check (jsonb_typeof(output_schema) = 'object'),
  authority_effect text not null
    check (authority_effect in ('informational', 'recommendation', 'consequential')),
  required_assurance_scope text not null
    check (required_assurance_scope in ('synthetic', 'county_attested', 'provider_attested')),
  test_vector_sha256 text not null check (test_vector_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  approved_by_auth_user_id uuid references auth.users(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, rule_key, version),
  check (effective_to is null or effective_to > effective_from),
  check (
    status in ('draft', 'synthetic_test')
    or (approved_by_auth_user_id is not null and approved_at is not null)
  )
);

create unique index rule_definition_one_active_idx
  on public.rule_definition_versions (tenant_id, rule_key)
  where status = 'active';

create table public.content_definition_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  content_key text not null check (content_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version text not null,
  status text not null check (status in ('draft', 'approved', 'active', 'retired', 'synthetic_test')),
  locale text not null default 'en-US',
  channels text[] not null default array['web']::text[],
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  reading_level text,
  legal_review_reference text,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  approved_by_auth_user_id uuid references auth.users(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, content_key, version),
  check (coalesce(array_length(channels, 1), 0) > 0),
  check (channels <@ array['web', 'chat', 'voice', 'sms', 'email', 'staff']::text[]),
  check (effective_to is null or effective_to > effective_from),
  check (
    status in ('draft', 'synthetic_test')
    or (approved_by_auth_user_id is not null and approved_at is not null)
  )
);

create unique index content_definition_one_active_idx
  on public.content_definition_versions (tenant_id, content_key, locale)
  where status = 'active';

create table public.completion_definition_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  completion_key text not null check (completion_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version text not null,
  status text not null check (status in ('draft', 'approved', 'active', 'retired', 'synthetic_test')),
  terminal_states text[] not null,
  evidence_required boolean not null default true,
  authoritative_evidence_required boolean not null default true,
  allowed_authority_types text[] not null default array['county_source']::text[],
  minimum_assurance_scope text not null
    check (minimum_assurance_scope in ('synthetic', 'county_attested', 'provider_attested')),
  evidence_schema jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence_schema) = 'object'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  approved_by_auth_user_id uuid references auth.users(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, completion_key, version),
  check (coalesce(array_length(terminal_states, 1), 0) > 0),
  check (array_position(terminal_states, null) is null),
  check (coalesce(array_length(allowed_authority_types, 1), 0) > 0),
  check (effective_to is null or effective_to > effective_from),
  check (
    status in ('draft', 'synthetic_test')
    or (approved_by_auth_user_id is not null and approved_at is not null)
  )
);

create unique index completion_definition_one_active_idx
  on public.completion_definition_versions (tenant_id, completion_key)
  where status = 'active';

create table public.workflow_definition_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  workflow_key text not null check (workflow_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version text not null,
  status text not null check (status in ('draft', 'approved', 'active', 'retired', 'synthetic_test')),
  initial_state text not null,
  states text[] not null,
  transitions jsonb not null check (jsonb_typeof(transitions) = 'object'),
  rule_references jsonb not null default '[]'::jsonb check (jsonb_typeof(rule_references) = 'array'),
  content_references jsonb not null default '[]'::jsonb check (jsonb_typeof(content_references) = 'array'),
  completion_definition_id uuid not null references public.completion_definition_versions(id) on delete restrict,
  definition_sha256 text not null check (definition_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  approved_by_auth_user_id uuid references auth.users(id) on delete restrict,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, workflow_key, version),
  check (coalesce(array_length(states, 1), 0) > 0),
  check (initial_state = any(states)),
  check (array_position(states, null) is null),
  check (effective_to is null or effective_to > effective_from),
  check (
    status in ('draft', 'synthetic_test')
    or (approved_by_auth_user_id is not null and approved_at is not null)
  )
);

create unique index workflow_definition_one_active_idx
  on public.workflow_definition_versions (tenant_id, workflow_key)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- Identity proof, explicit entitlements, and resident-authorized delegation.
-- Challenge material is represented only by SHA-256 digests.
-- ---------------------------------------------------------------------------

create table public.identity_proof_challenges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete restrict,
  case_id uuid not null references public.cases(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  method text not null
    check (method in ('county_notice', 'knowledge', 'document', 'clear', 'staff_assisted')),
  provider_key text not null,
  challenge_digest text not null check (challenge_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending'
    check (state in ('pending', 'verified', 'failed', 'expired', 'cancelled')),
  assurance_level text check (assurance_level is null or assurance_level in ('basic', 'substantial', 'high')),
  evidence_digest text check (evidence_digest is null or evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_reference text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  expires_at timestamptz not null,
  verified_at timestamptz,
  resolved_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, challenge_digest),
  check (expires_at > created_at),
  check (
    (state = 'verified' and assurance_level is not null and evidence_digest is not null
      and verified_at is not null and resolved_at is not null)
    or (state <> 'verified' and verified_at is null)
  )
);

create table public.case_entitlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  case_id uuid not null references public.cases(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  proof_challenge_id uuid not null references public.identity_proof_challenges(id) on delete restrict,
  scopes text[] not null default array['case.read']::text[],
  assurance_level text not null check (assurance_level in ('substantial', 'high')),
  state text not null default 'active' check (state in ('active', 'revoked', 'expired')),
  granted_by_type text not null check (granted_by_type in ('provider', 'staff')),
  granted_by_auth_user_id uuid references auth.users(id) on delete restrict,
  grant_reason_code text not null,
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_auth_user_id uuid references auth.users(id) on delete restrict,
  revocation_reason text,
  row_version bigint not null default 1,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (coalesce(array_length(scopes, 1), 0) > 0),
  check (scopes <@ array['case.read', 'case.participate', 'document.read', 'document.upload', 'case.delegate']::text[]),
  check (expires_at > granted_at),
  check (
    (granted_by_type = 'staff' and granted_by_auth_user_id is not null)
    or (granted_by_type = 'provider' and granted_by_auth_user_id is null)
  ),
  check (
    (state = 'active' and revoked_at is null and revoked_by_auth_user_id is null and revocation_reason is null)
    or (state = 'revoked' and revoked_at is not null and revocation_reason is not null)
    or state = 'expired'
  )
);

create unique index case_entitlements_one_active_subject_idx
  on public.case_entitlements (case_id, auth_user_id)
  where state = 'active';
create index case_entitlements_actor_lookup_idx
  on public.case_entitlements (auth_user_id, case_id, expires_at)
  where state = 'active';

create table public.case_delegations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  case_id uuid not null references public.cases(id) on delete restrict,
  principal_entitlement_id uuid not null references public.case_entitlements(id) on delete restrict,
  principal_auth_user_id uuid not null references auth.users(id) on delete restrict,
  delegate_auth_user_id uuid not null references auth.users(id) on delete restrict,
  scopes text[] not null default array['case.read']::text[],
  state text not null default 'active' check (state in ('active', 'revoked', 'expired')),
  consent_evidence_digest text not null check (consent_evidence_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revocation_reason text,
  row_version bigint not null default 1,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (principal_auth_user_id <> delegate_auth_user_id),
  check (coalesce(array_length(scopes, 1), 0) > 0),
  check (scopes <@ array['case.read', 'case.participate', 'document.read']::text[]),
  check (expires_at > created_at),
  check (
    (state = 'active' and revoked_at is null and revocation_reason is null)
    or (state = 'revoked' and revoked_at is not null and revocation_reason is not null)
    or state = 'expired'
  )
);

create unique index case_delegations_one_active_delegate_idx
  on public.case_delegations (case_id, delegate_auth_user_id)
  where state = 'active';

create trigger set_updated_at before update on public.case_entitlements
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.case_delegations
  for each row execute function private.set_updated_at();

-- Cross-tenant and identity-chain validation is centralized so service-role
-- callers cannot manufacture a valid-looking entitlement by choosing IDs from
-- unrelated rows.
create or replace function private.civya_validate_launch_governance_chain()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_table_name = 'authoritative_source_contract_versions' then
    if not exists (
      select 1 from public.authoritative_source_systems s
      where s.id = new.source_system_id and s.tenant_id = new.tenant_id
        and s.source_key = new.source_key
    ) then
      raise exception 'source contract tenant/source mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'source_batch_control_validations' then
    if not exists (
      select 1
      from public.authoritative_source_batches b
      join public.authoritative_source_contract_versions c on c.id = new.source_contract_id
      where b.id = new.source_batch_id and b.tenant_id = new.tenant_id
        and c.tenant_id = new.tenant_id and c.source_system_id = b.source_system_id
        and c.schema_version = b.schema_version
    ) then
      raise exception 'source validation tenant/contract mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'source_batch_promotion_events' then
    if not exists (
      select 1 from public.source_batch_control_validations v
      where v.id = new.validation_id and v.tenant_id = new.tenant_id
        and v.source_batch_id = new.source_batch_id
    ) then
      raise exception 'source promotion validation mismatch' using errcode = '23514';
    end if;
    if new.supersedes_event_id is not null and not exists (
      select 1 from public.source_batch_promotion_events prior
      where prior.id = new.supersedes_event_id
        and prior.tenant_id = new.tenant_id
        and prior.source_batch_id = new.source_batch_id
        and not exists (
          select 1 from public.source_batch_promotion_events newer
          where newer.supersedes_event_id = prior.id
        )
    ) then
      raise exception 'source promotion predecessor is not current' using errcode = '40001';
    end if;
  elsif tg_table_name = 'workflow_definition_versions' then
    if not exists (
      select 1 from public.completion_definition_versions c
      where c.id = new.completion_definition_id and c.tenant_id = new.tenant_id
    ) then
      raise exception 'workflow completion definition tenant mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'identity_proof_challenges' then
    if not exists (
      select 1 from public.cases c
      join public.residents r on r.id = c.resident_id
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and r.id = new.resident_id and r.tenant_id = new.tenant_id
        and r.auth_user_id = new.auth_user_id
    ) then
      raise exception 'identity challenge case/resident/account mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'case_entitlements' then
    if not exists (
      select 1
      from public.cases c
      join public.residents r on r.id = c.resident_id
      join public.identity_proof_challenges p on p.id = new.proof_challenge_id
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and r.id = new.resident_id and r.tenant_id = new.tenant_id
        and r.auth_user_id = new.auth_user_id
        and p.tenant_id = new.tenant_id and p.case_id = new.case_id
        and p.resident_id = new.resident_id and p.auth_user_id = new.auth_user_id
        and p.state = 'verified' and p.expires_at > p.verified_at
        and p.assurance_level = new.assurance_level
        and p.evidence_digest = new.evidence_digest
    ) then
      raise exception 'entitlement requires matching verified identity proof' using errcode = '23514';
    end if;
  elsif tg_table_name = 'case_delegations' then
    if not exists (
      select 1 from public.case_entitlements e
      where e.id = new.principal_entitlement_id
        and e.tenant_id = new.tenant_id and e.case_id = new.case_id
        and e.auth_user_id = new.principal_auth_user_id
        and e.state = 'active' and e.expires_at > now()
        and 'case.delegate' = any(e.scopes)
        and new.expires_at <= e.expires_at
    ) then
      raise exception 'delegation requires a current delegable entitlement' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_launch_governance_chain()
  from public, anon, authenticated, service_role;

create trigger authoritative_source_contract_chain_guard
  before insert on public.authoritative_source_contract_versions
  for each row execute function private.civya_validate_launch_governance_chain();
create trigger source_batch_validation_chain_guard
  before insert on public.source_batch_control_validations
  for each row execute function private.civya_validate_launch_governance_chain();
create trigger source_batch_promotion_chain_guard
  before insert on public.source_batch_promotion_events
  for each row execute function private.civya_validate_launch_governance_chain();
create trigger workflow_definition_chain_guard
  before insert on public.workflow_definition_versions
  for each row execute function private.civya_validate_launch_governance_chain();
create trigger identity_proof_challenge_chain_guard
  before insert on public.identity_proof_challenges
  for each row execute function private.civya_validate_launch_governance_chain();
create trigger case_entitlement_chain_guard
  before insert on public.case_entitlements
  for each row execute function private.civya_validate_launch_governance_chain();
create trigger case_delegation_chain_guard
  before insert on public.case_delegations
  for each row execute function private.civya_validate_launch_governance_chain();

-- Versioned governance artifacts and source validation history are append-only.
create trigger authoritative_source_contract_immutable
  before update or delete on public.authoritative_source_contract_versions
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger source_batch_validation_immutable
  before update or delete on public.source_batch_control_validations
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger source_batch_promotion_immutable
  before update or delete on public.source_batch_promotion_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger rule_definition_immutable
  before update or delete on public.rule_definition_versions
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger content_definition_immutable
  before update or delete on public.content_definition_versions
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger completion_definition_immutable
  before update or delete on public.completion_definition_versions
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger workflow_definition_immutable
  before update or delete on public.workflow_definition_versions
  for each row execute function private.civya_reject_immutable_outcome_mutation();

-- ---------------------------------------------------------------------------
-- Entitlement-aware authorization. These functions are the single boundary
-- reused by RLS, Storage, trusted application RPCs, and channel controls.
-- ---------------------------------------------------------------------------

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
        and e.state = 'active' and e.expires_at > now()
        and e.tenant_id = d.tenant_id
        and e.case_id = d.case_id
        and e.auth_user_id = d.principal_auth_user_id
        and private.civya_entitlement_has_current_proof(e.id)
    )
  )
$$;

revoke all on function private.civya_active_case_entitlement(uuid, uuid, text)
  from public, anon, authenticated;

create or replace function private.civya_has_tenant_access(
  p_actor_user_id uuid,
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from private.tenant_access_grants g
    join public.demo_invitations i on i.id = g.invitation_id
    join public.tenants t on t.id = g.tenant_id
    where g.auth_user_id = p_actor_user_id
      and g.tenant_id = p_tenant_id
      and t.environment = 'sandbox' and t.fictional
      and g.expires_at > now()
      and i.tenant_id = g.tenant_id
      and i.expires_at > now()
      and i.revoked_at is null
      and 'resident_demo' = any(i.scopes)
  )
$$;

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

create or replace function private.civya_actor_can_access_case(
  p_actor_user_id uuid,
  p_case_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from public.cases c
    join public.residents r on r.id = c.resident_id
    join public.tenants t on t.id = c.tenant_id
    where c.id = p_case_id
      and (
        private.civya_actor_is_staff(p_actor_user_id, c.tenant_id)
        or (
          t.environment = 'sandbox' and t.fictional
          and r.auth_user_id = p_actor_user_id
          and private.civya_has_tenant_access(p_actor_user_id, c.tenant_id)
        )
        or (
          not (t.environment = 'sandbox' and t.fictional)
          and private.civya_active_case_entitlement(p_actor_user_id, c.id, 'case.read')
        )
      )
  )
$$;

create or replace function public.civya_owns_resident(p_resident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from public.residents r
    join public.tenants t on t.id = r.tenant_id
    where r.id = p_resident_id
      and (
        public.civya_is_staff(r.tenant_id)
        or (
          t.environment = 'sandbox' and t.fictional
          and r.auth_user_id = auth.uid()
          and private.civya_has_tenant_access(auth.uid(), r.tenant_id)
        )
        or (
          not (t.environment = 'sandbox' and t.fictional)
          and exists (
            select 1 from public.cases c
            where c.resident_id = r.id
              and private.civya_active_case_entitlement(auth.uid(), c.id, 'case.read')
          )
        )
      )
  )
$$;

create or replace function public.civya_can_access_case(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select auth.role() = 'service_role'
    or private.civya_actor_can_access_case(auth.uid(), p_case_id)
$$;

create or replace function public.civya_can_access_storage_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_tenant_id uuid;
  v_resident_id uuid;
  v_case_id uuid;
begin
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$' then
    return false;
  end if;
  v_tenant_id := split_part(p_name, '/', 1)::uuid;
  v_resident_id := split_part(p_name, '/', 2)::uuid;
  v_case_id := split_part(p_name, '/', 3)::uuid;
  return exists (
    select 1 from public.cases c
    where c.id = v_case_id and c.tenant_id = v_tenant_id
      and c.resident_id = v_resident_id
      and public.civya_can_access_case(c.id)
  );
exception when others then
  return false;
end;
$$;

create or replace function public.civya_can_read_storage_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_tenant_id uuid;
  v_resident_id uuid;
  v_case_id uuid;
begin
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$' then
    return false;
  end if;
  v_tenant_id := split_part(p_name, '/', 1)::uuid;
  v_resident_id := split_part(p_name, '/', 2)::uuid;
  v_case_id := split_part(p_name, '/', 3)::uuid;
  return exists (
    select 1 from public.documents d
    where d.storage_bucket = 'civya-private-documents'
      and d.storage_path = p_name
      and d.tenant_id = v_tenant_id and d.resident_id = v_resident_id
      and d.case_id = v_case_id
      and public.civya_can_access_case(d.case_id)
      and (
        private.civya_actor_is_staff(auth.uid(), d.tenant_id)
        or d.scan_status = 'clean'
      )
  );
exception when others then
  return false;
end;
$$;

-- Case-specific policies prevent an entitlement for one case from exposing a
-- second case that happens to belong to the same resident account.
drop policy if exists cases_member_read on public.cases;
drop policy if exists cases_member_update on public.cases;
create policy cases_member_read on public.cases for select to authenticated
  using (public.civya_can_access_case(id));
create policy cases_member_update on public.cases for update to authenticated
  using (public.civya_can_access_case(id))
  with check (public.civya_can_access_case(id));

drop policy if exists conversations_member_all on public.conversations;
create policy conversations_member_all on public.conversations for all to authenticated
  using (public.civya_can_access_case(case_id))
  with check (public.civya_can_access_case(case_id));
drop policy if exists turns_member_read on public.turns;
create policy turns_member_read on public.turns for select to authenticated
  using (public.civya_can_access_case(case_id));
drop policy if exists facts_member_read on public.case_facts;
create policy facts_member_read on public.case_facts for select to authenticated
  using (public.civya_can_access_case(case_id));
drop policy if exists documents_member_read on public.documents;
create policy documents_member_read on public.documents for select to authenticated
  using (public.civya_can_access_case(case_id));
drop policy if exists checklist_member_read on public.checklist_items;
create policy checklist_member_read on public.checklist_items for select to authenticated
  using (public.civya_can_access_case(case_id));
drop policy if exists consent_member_read on public.consent;
create policy consent_member_read on public.consent for select to authenticated
  using (case_id is null and public.civya_owns_resident(resident_id)
    or case_id is not null and public.civya_can_access_case(case_id));
drop policy if exists reviews_resident_read on public.review_tasks;
create policy reviews_resident_read on public.review_tasks for select to authenticated
  using (public.civya_can_access_case(case_id));
drop policy if exists reminders_member_read on public.reminders;
create policy reminders_member_read on public.reminders for select to authenticated
  using (public.civya_can_access_case(case_id));
drop policy if exists transactions_member_read on public.simulated_transactions;
create policy transactions_member_read on public.simulated_transactions for select to authenticated
  using (public.civya_can_access_case(case_id));

drop policy if exists tenants_member_read on public.tenants;
create policy tenants_member_read on public.tenants for select to authenticated
  using (private.civya_actor_has_tenant_access(auth.uid(), id));

-- ---------------------------------------------------------------------------
-- Service-only atomic registration, proof, grant, revocation, and delegation.
-- ---------------------------------------------------------------------------

create or replace function public.civya_service_register_authoritative_source(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_source_key text,
  p_display_name text,
  p_authority_scope text[],
  p_assurance_scope text,
  p_authentication_method text,
  p_freshness_sla_seconds integer,
  p_data_classification text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_source public.authoritative_source_systems%rowtype;
begin
  perform private.civya_service_required();
  if not private.civya_actor_is_staff(p_actor_user_id, p_tenant_id, 'admin') then
    raise exception 'tenant admin required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.tenants t where t.id = p_tenant_id and not t.fictional
  ) then
    raise exception 'non-fictional tenant required' using errcode = 'P0002';
  end if;
  if coalesce(array_length(p_authority_scope, 1), 0) = 0
     or array_position(p_authority_scope, null) is not null then
    raise exception 'authority scope is required' using errcode = '22023';
  end if;
  insert into public.authoritative_source_systems (
    tenant_id, source_key, display_name, authority_scope, status, fictional,
    assurance_scope, authentication_method, freshness_sla_seconds, data_classification
  ) values (
    p_tenant_id, p_source_key, p_display_name, p_authority_scope, 'active', false,
    p_assurance_scope, p_authentication_method, p_freshness_sla_seconds, p_data_classification
  ) returning * into v_source;
  insert into public.audit_events (tenant_id, actor_user_id, event_type, redacted_payload, source)
  values (p_tenant_id, p_actor_user_id, 'authoritative_source_registered',
    jsonb_build_object('sourceSystemId', v_source.id, 'sourceKey', v_source.source_key,
      'assuranceScope', v_source.assurance_scope), 'admin');
  return jsonb_build_object('sourceSystemId', v_source.id, 'status', v_source.status);
end;
$$;

create or replace function public.civya_service_create_identity_proof_challenge(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_method text,
  p_provider_key text,
  p_challenge_digest text,
  p_expires_at timestamptz,
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
  v_challenge public.identity_proof_challenges%rowtype;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  select * into v_case from public.cases where id = p_case_id;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into v_resident from public.residents where id = v_case.resident_id;
  if not found or v_resident.auth_user_id <> p_actor_user_id then
    raise exception 'case/account identity mismatch' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.tenants t
    where t.id = v_case.tenant_id and t.environment = 'sandbox' and t.fictional
  ) then
    raise exception 'production identity proof is unavailable for fictional sandbox cases'
      using errcode = '55000';
  end if;
  insert into public.identity_proof_challenges (
    tenant_id, resident_id, case_id, auth_user_id, method, provider_key,
    challenge_digest, expires_at, idempotency_key
  ) values (
    v_case.tenant_id, v_case.resident_id, v_case.id, p_actor_user_id, p_method,
    p_provider_key, p_challenge_digest, p_expires_at, p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_challenge;
  if not found then
    v_duplicate := true;
    select * into strict v_challenge from public.identity_proof_challenges
    where tenant_id = v_case.tenant_id and idempotency_key = p_idempotency_key;
    if v_challenge.case_id <> p_case_id
       or v_challenge.auth_user_id <> p_actor_user_id
       or v_challenge.challenge_digest <> p_challenge_digest then
      raise exception 'identity challenge idempotency conflict' using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object('challengeId', v_challenge.id, 'state', v_challenge.state,
    'expiresAt', v_challenge.expires_at, 'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_resolve_identity_proof_challenge(
  p_challenge_id uuid,
  p_result text,
  p_assurance_level text,
  p_evidence_digest text,
  p_provider_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_challenge public.identity_proof_challenges%rowtype;
begin
  perform private.civya_service_required();
  if p_result not in ('verified', 'failed') then
    raise exception 'invalid proof result' using errcode = '22023';
  end if;
  select * into v_challenge from public.identity_proof_challenges
  where id = p_challenge_id for update;
  if not found then raise exception 'identity challenge not found' using errcode = 'P0002'; end if;
  if v_challenge.state <> 'pending' then
    if v_challenge.state = p_result
       and v_challenge.evidence_digest is not distinct from p_evidence_digest then
      return jsonb_build_object('challengeId', v_challenge.id, 'state', v_challenge.state,
        'assuranceLevel', v_challenge.assurance_level);
    end if;
    raise exception 'identity challenge is already resolved' using errcode = '55000';
  end if;
  if v_challenge.expires_at <= now() then
    update public.identity_proof_challenges
    set state = 'expired', resolved_at = now(), attempt_count = attempt_count + 1
    where id = v_challenge.id;
    raise exception 'identity challenge expired' using errcode = '28000';
  end if;
  if p_result = 'verified' and (
    p_assurance_level not in ('substantial', 'high')
    or p_evidence_digest !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'verified proof requires substantial assurance evidence' using errcode = '22023';
  end if;
  update public.identity_proof_challenges set
    state = p_result,
    assurance_level = case when p_result = 'verified' then p_assurance_level else null end,
    evidence_digest = case when p_result = 'verified' then p_evidence_digest else null end,
    provider_reference = nullif(p_provider_reference, ''),
    attempt_count = attempt_count + 1,
    verified_at = case when p_result = 'verified' then now() else null end,
    resolved_at = now()
  where id = v_challenge.id returning * into v_challenge;
  insert into public.audit_events (tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source)
  values (v_challenge.tenant_id, v_challenge.resident_id, v_challenge.case_id,
    v_challenge.auth_user_id, 'identity_proof_' || p_result,
    jsonb_build_object('challengeId', v_challenge.id, 'method', v_challenge.method,
      'assuranceLevel', v_challenge.assurance_level), 'system');
  return jsonb_build_object('challengeId', v_challenge.id, 'state', v_challenge.state,
    'assuranceLevel', v_challenge.assurance_level);
end;
$$;

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
       or v_entitlement.scopes <> p_scopes then
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

create or replace function public.civya_service_revoke_case_entitlement(
  p_entitlement_id uuid,
  p_actor_user_id uuid,
  p_expected_row_version bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_entitlement public.case_entitlements%rowtype;
begin
  perform private.civya_service_required();
  select * into v_entitlement from public.case_entitlements
  where id = p_entitlement_id for update;
  if not found then raise exception 'entitlement not found' using errcode = 'P0002'; end if;
  if p_actor_user_id <> v_entitlement.auth_user_id
     and not private.civya_actor_is_staff(p_actor_user_id, v_entitlement.tenant_id, 'admin') then
    raise exception 'entitlement owner or tenant admin required' using errcode = '42501';
  end if;
  if v_entitlement.state = 'revoked' then
    return jsonb_build_object('entitlementId', v_entitlement.id,
      'state', v_entitlement.state, 'rowVersion', v_entitlement.row_version);
  end if;
  if v_entitlement.state <> 'active' or v_entitlement.row_version <> p_expected_row_version then
    raise exception 'stale or inactive entitlement' using errcode = '40001';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'revocation reason required' using errcode = '22023';
  end if;
  update public.case_entitlements set state = 'revoked', revoked_at = now(),
    revoked_by_auth_user_id = p_actor_user_id, revocation_reason = left(p_reason, 500),
    row_version = row_version + 1
  where id = v_entitlement.id returning * into v_entitlement;
  update public.case_delegations set state = 'revoked', revoked_at = now(),
    revocation_reason = 'principal_entitlement_revoked', row_version = row_version + 1
  where principal_entitlement_id = v_entitlement.id and state = 'active';
  insert into public.audit_events (tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source)
  values (v_entitlement.tenant_id, v_entitlement.resident_id, v_entitlement.case_id,
    p_actor_user_id, 'case_entitlement_revoked',
    jsonb_build_object('entitlementId', v_entitlement.id, 'reason', left(p_reason, 200)),
    case when p_actor_user_id = v_entitlement.auth_user_id then 'resident' else 'admin' end);
  return jsonb_build_object('entitlementId', v_entitlement.id,
    'state', v_entitlement.state, 'rowVersion', v_entitlement.row_version);
end;
$$;

create or replace function public.civya_service_create_case_delegation(
  p_principal_auth_user_id uuid,
  p_case_id uuid,
  p_delegate_auth_user_id uuid,
  p_scopes text[],
  p_consent_evidence_digest text,
  p_expires_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_entitlement public.case_entitlements%rowtype;
  v_delegation public.case_delegations%rowtype;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  select * into v_entitlement from public.case_entitlements
  where case_id = p_case_id and auth_user_id = p_principal_auth_user_id
    and state = 'active' and expires_at > now()
    and 'case.delegate' = any(scopes)
  for update;
  if not found then raise exception 'delegable case entitlement required' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users where id = p_delegate_auth_user_id) then
    raise exception 'delegate account not found' using errcode = 'P0002';
  end if;
  insert into public.case_delegations (
    tenant_id, case_id, principal_entitlement_id, principal_auth_user_id,
    delegate_auth_user_id, scopes, consent_evidence_digest, expires_at, idempotency_key
  ) values (
    v_entitlement.tenant_id, p_case_id, v_entitlement.id, p_principal_auth_user_id,
    p_delegate_auth_user_id, p_scopes, p_consent_evidence_digest, p_expires_at,
    p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_delegation;
  if not found then
    v_duplicate := true;
    select * into strict v_delegation from public.case_delegations
    where tenant_id = v_entitlement.tenant_id and idempotency_key = p_idempotency_key;
    if v_delegation.case_id <> p_case_id
       or v_delegation.delegate_auth_user_id <> p_delegate_auth_user_id
       or v_delegation.scopes <> p_scopes then
      raise exception 'delegation idempotency conflict' using errcode = '23505';
    end if;
  end if;
  insert into public.audit_events (tenant_id, case_id, actor_user_id, event_type,
    redacted_payload, source)
  values (v_delegation.tenant_id, v_delegation.case_id, p_principal_auth_user_id,
    'case_delegation_created', jsonb_build_object('delegationId', v_delegation.id,
      'delegateAuthUserId', p_delegate_auth_user_id, 'scopes', to_jsonb(p_scopes),
      'expiresAt', p_expires_at), 'resident');
  return jsonb_build_object('delegationId', v_delegation.id,
    'state', v_delegation.state, 'expiresAt', v_delegation.expires_at,
    'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_case_entitlement_status(
  p_actor_user_id uuid,
  p_case_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select case
    when auth.role() <> 'service_role' then
      jsonb_build_object('authorized', false, 'reason', 'service_role_required')
    when private.civya_actor_is_staff(p_actor_user_id, c.tenant_id) then
      jsonb_build_object('authorized', true, 'accessType', 'staff')
    when t.environment = 'sandbox' and t.fictional
      and r.auth_user_id = p_actor_user_id
      and private.civya_has_tenant_access(p_actor_user_id, c.tenant_id) then
      jsonb_build_object('authorized', true, 'accessType', 'fictional_invitation')
    when private.civya_active_case_entitlement(p_actor_user_id, c.id, 'case.read') then
      jsonb_build_object('authorized', true, 'accessType', 'case_entitlement')
    else jsonb_build_object('authorized', false, 'reason', 'case_entitlement_required')
  end
  from public.cases c
  join public.residents r on r.id = c.resident_id
  join public.tenants t on t.id = c.tenant_id
  where c.id = p_case_id
$$;

-- RLS and grants for new public tables. Sensitive proof digests and all writes
-- remain service-only; authenticated users receive only their own entitlement
-- or delegation rows and staff receive governed definition/source reads.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'authoritative_source_contract_versions', 'source_batch_control_validations',
    'source_batch_promotion_events', 'source_correction_requests',
    'rule_definition_versions', 'content_definition_versions',
    'completion_definition_versions', 'workflow_definition_versions',
    'identity_proof_challenges', 'case_entitlements', 'case_delegations'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$$;

create policy authoritative_source_contract_admin_read on public.authoritative_source_contract_versions
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy source_batch_validation_admin_read on public.source_batch_control_validations
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy source_batch_promotion_admin_read on public.source_batch_promotion_events
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy source_correction_staff_read on public.source_correction_requests
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));
create policy rule_definition_admin_read on public.rule_definition_versions
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy content_definition_staff_read on public.content_definition_versions
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));
create policy completion_definition_admin_read on public.completion_definition_versions
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy workflow_definition_admin_read on public.workflow_definition_versions
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy case_entitlements_subject_read on public.case_entitlements
  for select to authenticated using (
    auth_user_id = auth.uid() or private.civya_outcome_staff_read_allowed(tenant_id)
  );
create policy case_delegations_subject_read on public.case_delegations
  for select to authenticated using (
    principal_auth_user_id = auth.uid() or delegate_auth_user_id = auth.uid()
    or private.civya_outcome_staff_read_allowed(tenant_id)
  );

grant select on public.authoritative_source_contract_versions to authenticated, service_role;
grant select on public.source_batch_control_validations to authenticated, service_role;
grant select on public.source_batch_promotion_events to authenticated, service_role;
grant select on public.source_correction_requests to authenticated, service_role;
grant select on public.rule_definition_versions to authenticated, service_role;
grant select on public.content_definition_versions to authenticated, service_role;
grant select on public.completion_definition_versions to authenticated, service_role;
grant select on public.workflow_definition_versions to authenticated, service_role;
grant select on public.case_entitlements to authenticated, service_role;
grant select on public.case_delegations to authenticated, service_role;
grant select on public.identity_proof_challenges to service_role;

revoke all on function public.civya_service_register_authoritative_source(
  uuid, uuid, text, text, text[], text, text, integer, text
) from public, anon, authenticated;
revoke all on function public.civya_service_create_identity_proof_challenge(
  uuid, uuid, text, text, text, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.civya_service_resolve_identity_proof_challenge(
  uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.civya_service_grant_case_entitlement(
  uuid, uuid, text[], timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.civya_service_revoke_case_entitlement(
  uuid, uuid, bigint, text
) from public, anon, authenticated;
revoke all on function public.civya_service_create_case_delegation(
  uuid, uuid, uuid, text[], text, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.civya_service_case_entitlement_status(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.civya_service_register_authoritative_source(
  uuid, uuid, text, text, text[], text, text, integer, text
) to service_role;
grant execute on function public.civya_service_create_identity_proof_challenge(
  uuid, uuid, text, text, text, timestamptz, text
) to service_role;
grant execute on function public.civya_service_resolve_identity_proof_challenge(
  uuid, text, text, text, text
) to service_role;
grant execute on function public.civya_service_grant_case_entitlement(
  uuid, uuid, text[], timestamptz, text, text
) to service_role;
grant execute on function public.civya_service_revoke_case_entitlement(
  uuid, uuid, bigint, text
) to service_role;
grant execute on function public.civya_service_create_case_delegation(
  uuid, uuid, uuid, text[], text, timestamptz, text
) to service_role;
grant execute on function public.civya_service_case_entitlement_status(uuid, uuid)
  to service_role;

comment on table public.case_entitlements is
  'A social login or passkey account does not grant case access. Non-fictional case access requires an active scoped entitlement backed by verified proof.';
comment on table public.identity_proof_challenges is
  'Contains digests and redacted provider references only; never stores proof answers or identity-document contents.';
comment on table public.authoritative_source_batches is
  'Production batches remain quarantined until a passed control validation and append-only promotion event exist.';
