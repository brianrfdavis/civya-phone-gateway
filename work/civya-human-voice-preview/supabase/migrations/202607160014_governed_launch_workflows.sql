-- Governed launch workflows for the five Wayne County resident journeys.
-- Browser state is never completion authority. Every transition is optimistic,
-- idempotent, and recorded; terminal transitions enforce the exact versioned
-- completion evidence definition selected when the workflow began.

alter table public.documents drop constraint if exists documents_scan_status_check;
alter table public.documents add constraint documents_scan_status_check
  check (scan_status in (
    'pending', 'quarantined', 'scanning', 'clean', 'rejected', 'failed'
  ));

alter table public.reminders drop constraint if exists reminders_status_check;
alter table public.reminders add constraint reminders_status_check
  check (status in (
    'scheduled', 'queued', 'sent', 'delivered', 'failed', 'cancelled', 'suppressed'
  ));

create table public.workflow_instances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  workflow_definition_id uuid not null references public.workflow_definition_versions(id) on delete restrict,
  completion_definition_id uuid not null references public.completion_definition_versions(id) on delete restrict,
  workflow_key text not null,
  definition_version text not null,
  current_state text not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'escalated', 'completed', 'cancelled')),
  redacted_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(redacted_context) = 'object'),
  started_by_type text not null check (started_by_type in ('resident', 'staff', 'system', 'provider')),
  started_by_auth_user_id uuid references auth.users(id) on delete set null,
  correlation_id text not null,
  idempotency_key text not null,
  row_version bigint not null default 1,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  unique (tenant_id, idempotency_key),
  check (
    (started_by_type in ('resident', 'staff') and started_by_auth_user_id is not null)
    or (started_by_type in ('system', 'provider') and started_by_auth_user_id is null)
  ),
  check (
    (status = 'completed' and completed_at is not null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null and completed_at is null)
    or (status in ('active', 'paused', 'escalated') and completed_at is null and cancelled_at is null)
  )
);

create unique index workflow_instances_one_open_key_idx
  on public.workflow_instances (case_id, workflow_key)
  where status in ('active', 'paused', 'escalated');
create index workflow_instances_operations_idx
  on public.workflow_instances (tenant_id, status, updated_at desc);

create table public.workflow_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  workflow_instance_id uuid not null references public.workflow_instances(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  sequence_number bigint not null,
  action_key text not null check (action_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  from_state text,
  to_state text not null,
  actor_type text not null check (actor_type in ('resident', 'staff', 'system', 'provider')),
  actor_auth_user_id uuid references auth.users(id) on delete set null,
  reason_code text not null,
  correlation_id text not null,
  idempotency_key text not null,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(redacted_metadata) = 'object'),
  completion_evidence_id uuid,
  created_at timestamptz not null default now(),
  unique (workflow_instance_id, sequence_number),
  unique (tenant_id, idempotency_key),
  check (
    (actor_type in ('resident', 'staff') and actor_auth_user_id is not null)
    or (actor_type in ('system', 'provider') and actor_auth_user_id is null)
  )
);

create index workflow_actions_case_timeline_idx
  on public.workflow_actions (case_id, created_at, sequence_number);

create table public.workflow_completion_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  workflow_instance_id uuid not null references public.workflow_instances(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  completion_definition_id uuid not null references public.completion_definition_versions(id) on delete restrict,
  authority_type text not null
    check (authority_type in ('county_source', 'provider_webhook', 'staff_attestation', 'synthetic_test')),
  assurance_scope text not null
    check (assurance_scope in ('synthetic', 'county_attested', 'provider_attested')),
  authoritative boolean not null default false,
  source_record_id uuid references public.authoritative_source_records(id) on delete restrict,
  provider_event_id uuid references private.provider_events(id) on delete restrict,
  outcome_verification_event_id uuid references public.outcome_verification_events(id) on delete restrict,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(redacted_evidence) = 'object'),
  observed_at timestamptz not null,
  verified_by_type text not null check (verified_by_type in ('service', 'staff')),
  verified_by_auth_user_id uuid references auth.users(id) on delete restrict,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (
    (verified_by_type = 'staff' and verified_by_auth_user_id is not null)
    or (verified_by_type = 'service' and verified_by_auth_user_id is null)
  ),
  check (
    not authoritative
    or (assurance_scope <> 'synthetic' and authority_type <> 'synthetic_test')
  ),
  check (
    (authority_type = 'county_source' and source_record_id is not null)
    or (authority_type = 'provider_webhook' and provider_event_id is not null)
    or authority_type in ('staff_attestation', 'synthetic_test')
  )
);

alter table public.workflow_actions
  add constraint workflow_actions_completion_evidence_fk
  foreign key (completion_evidence_id)
  references public.workflow_completion_evidence(id) on delete cascade;

create table public.operational_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  case_id uuid references public.cases(id) on delete cascade,
  workflow_instance_id uuid references public.workflow_instances(id) on delete cascade,
  exception_type text not null check (exception_type ~ '^[a-z0-9][a-z0-9._-]*$'),
  severity text not null check (severity in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open'
    check (status in ('open', 'owned', 'waiting_external', 'resolved', 'closed')),
  reason_code text not null,
  redacted_summary text not null,
  assigned_to_auth_user_id uuid references auth.users(id) on delete set null,
  resolution_code text,
  redacted_resolution text,
  correlation_id text not null,
  dedupe_key text not null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, dedupe_key),
  check (
    status not in ('resolved', 'closed')
    or (resolution_code is not null and resolved_at is not null)
  )
);

create index operational_exceptions_queue_idx
  on public.operational_exceptions (tenant_id, status, severity, created_at)
  where status in ('open', 'owned', 'waiting_external');

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  workflow_instance_id uuid references public.workflow_instances(id) on delete cascade,
  referral_type text not null check (referral_type in ('county_staff', 'authorized_partner', 'emergency', 'legal_aid')),
  destination_key text not null,
  status text not null default 'created'
    check (status in ('created', 'accepted', 'declined', 'completed', 'cancelled', 'failed')),
  redacted_reason text not null,
  provider_reference text,
  consent_id uuid references public.consent(id) on delete restrict,
  assigned_to_auth_user_id uuid references auth.users(id) on delete set null,
  idempotency_key text not null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, idempotency_key)
);

create table public.hosted_handoff_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  workflow_instance_id uuid references public.workflow_instances(id) on delete cascade,
  handoff_type text not null check (handoff_type in ('county', 'payment', 'identity', 'signature', 'partner')),
  provider_key text not null,
  provider_session_reference_digest text not null check (provider_session_reference_digest ~ '^[0-9a-f]{64}$'),
  destination_origin text not null check (destination_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  return_nonce_digest text not null check (return_nonce_digest ~ '^[0-9a-f]{64}$'),
  browser_state text not null default 'created'
    check (browser_state in ('created', 'opened', 'returned', 'abandoned', 'expired')),
  authoritative_state text not null default 'pending'
    check (authoritative_state in ('pending', 'confirmed', 'failed')),
  provider_reference text,
  idempotency_key text not null,
  row_version bigint not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, return_nonce_digest),
  check (expires_at > created_at),
  check (
    (authoritative_state = 'pending' and reconciled_at is null)
    or (authoritative_state in ('confirmed', 'failed') and reconciled_at is not null)
  )
);

create table public.handoff_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  handoff_session_id uuid not null references public.hosted_handoff_sessions(id) on delete cascade,
  source_type text not null check (source_type in ('browser', 'provider_webhook', 'reconciliation', 'system')),
  event_type text not null,
  external_event_id text,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_payload) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, source_type, external_event_id)
);

create table public.communication_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  workflow_instance_id uuid references public.workflow_instances(id) on delete cascade,
  consent_id uuid references public.consent(id) on delete restrict,
  channel text not null check (channel in ('sms', 'email', 'voice', 'portal')),
  message_type text not null,
  redacted_preview text not null,
  provider_key text not null,
  provider_reference text,
  status text not null default 'planned'
    check (status in ('planned', 'queued', 'sent', 'delivered', 'failed', 'suppressed', 'cancelled')),
  idempotency_key text not null,
  row_version bigint not null default 1,
  scheduled_for timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table public.communication_delivery_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  delivery_id uuid not null references public.communication_deliveries(id) on delete cascade,
  event_type text not null,
  provider_event_id text,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_payload) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, provider_event_id)
);

create table public.document_processing_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  from_state text,
  to_state text not null
    check (to_state in ('pending', 'quarantined', 'scanning', 'clean', 'rejected', 'failed')),
  processor_key text not null,
  processor_release text not null,
  malware_signature_version text,
  classification_confidence numeric(5,4)
    check (classification_confidence is null or classification_confidence between 0 and 1),
  extraction_confidence numeric(5,4)
    check (extraction_confidence is null or extraction_confidence between 0 and 1),
  reason_code text not null,
  result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_metadata) = 'object'),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'workflow_instances', 'operational_exceptions', 'referrals',
    'hosted_handoff_sessions', 'communication_deliveries'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()',
      v_table
    );
  end loop;
end;
$$;

-- Validate the tenant/case/definition chain before any launch record lands.
create or replace function private.civya_validate_launch_workflow_chain()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_table_name = 'workflow_instances' then
    if not exists (
      select 1
      from public.cases c
      join public.workflow_definition_versions w on w.id = new.workflow_definition_id
      join public.completion_definition_versions d on d.id = new.completion_definition_id
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and c.resident_id = new.resident_id
        and w.tenant_id = new.tenant_id and w.workflow_key = new.workflow_key
        and w.version = new.definition_version
        and w.completion_definition_id = d.id and d.tenant_id = new.tenant_id
        and new.current_state = any(w.states)
    ) then
      raise exception 'workflow instance tenant/case/definition mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'workflow_actions' then
    if not exists (
      select 1 from public.workflow_instances i
      where i.id = new.workflow_instance_id and i.tenant_id = new.tenant_id
        and i.case_id = new.case_id
    ) then
      raise exception 'workflow action instance mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'workflow_completion_evidence' then
    if not exists (
      select 1
      from public.workflow_instances i
      join public.completion_definition_versions d on d.id = new.completion_definition_id
      where i.id = new.workflow_instance_id and i.tenant_id = new.tenant_id
        and i.case_id = new.case_id
        and i.completion_definition_id = d.id and d.tenant_id = new.tenant_id
        and new.authority_type = any(d.allowed_authority_types)
    ) then
      raise exception 'completion evidence instance/definition mismatch' using errcode = '23514';
    end if;
    if new.authority_type = 'county_source' and not exists (
      select 1
      from public.authoritative_source_records r
      join public.source_batch_promotion_events p on p.source_batch_id = r.source_batch_id
      where r.id = new.source_record_id and r.tenant_id = new.tenant_id
        and p.tenant_id = new.tenant_id and p.decision = 'accepted'
        and not exists (
          select 1 from public.source_batch_promotion_events newer
          where newer.supersedes_event_id = p.id
        )
    ) then
      raise exception 'county completion evidence requires a currently accepted governed source batch'
        using errcode = '55000';
    end if;
  elsif tg_table_name = 'hosted_handoff_sessions' then
    if not exists (
      select 1 from public.cases c
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and c.resident_id = new.resident_id
    ) then
      raise exception 'hosted handoff case mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'document_processing_events' then
    if not exists (
      select 1 from public.documents d
      where d.id = new.document_id and d.tenant_id = new.tenant_id
        and d.case_id = new.case_id and d.resident_id = new.resident_id
    ) then
      raise exception 'document processing event mismatch' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_launch_workflow_chain()
  from public, anon, authenticated, service_role;

create trigger workflow_instances_chain_guard
  before insert or update on public.workflow_instances
  for each row execute function private.civya_validate_launch_workflow_chain();
create trigger workflow_actions_chain_guard
  before insert on public.workflow_actions
  for each row execute function private.civya_validate_launch_workflow_chain();
create trigger workflow_completion_evidence_chain_guard
  before insert on public.workflow_completion_evidence
  for each row execute function private.civya_validate_launch_workflow_chain();
create trigger hosted_handoff_chain_guard
  before insert or update on public.hosted_handoff_sessions
  for each row execute function private.civya_validate_launch_workflow_chain();
create trigger document_processing_chain_guard
  before insert on public.document_processing_events
  for each row execute function private.civya_validate_launch_workflow_chain();

-- Consequential ledgers are immutable; the sandbox retention marker remains
-- the only deletion path so existing demo cleanup continues to work.
create trigger workflow_actions_immutable
  before update or delete on public.workflow_actions
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger workflow_completion_evidence_immutable
  before update or delete on public.workflow_completion_evidence
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger handoff_events_immutable
  before update or delete on public.handoff_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger communication_delivery_events_immutable
  before update or delete on public.communication_delivery_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger document_processing_events_immutable
  before update or delete on public.document_processing_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();

-- ---------------------------------------------------------------------------
-- Atomic service-only workflow and evidence RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.civya_service_start_workflow(
  p_actor_user_id uuid,
  p_actor_type text,
  p_case_id uuid,
  p_workflow_definition_id uuid,
  p_correlation_id text,
  p_redacted_context jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_case public.cases%rowtype;
  v_definition public.workflow_definition_versions%rowtype;
  v_instance public.workflow_instances%rowtype;
  v_action public.workflow_actions%rowtype;
  v_duplicate boolean := false;
  v_input_sha text;
begin
  perform private.civya_service_required();
  if p_actor_type not in ('resident', 'staff', 'system', 'provider') then
    raise exception 'invalid workflow actor type' using errcode = '22023';
  end if;
  if (p_actor_type in ('resident', 'staff')) <> (p_actor_user_id is not null) then
    raise exception 'workflow actor identity mismatch' using errcode = '22023';
  end if;
  select * into v_case from public.cases where id = p_case_id for update;
  select * into v_definition from public.workflow_definition_versions
  where id = p_workflow_definition_id;
  if v_case.id is null or v_definition.id is null
     or v_case.tenant_id <> v_definition.tenant_id then
    raise exception 'case or workflow definition not found' using errcode = 'P0002';
  end if;
  if v_definition.status not in ('active', 'synthetic_test')
     or v_definition.effective_from > now()
     or (v_definition.effective_to is not null and v_definition.effective_to <= now()) then
    raise exception 'workflow definition is not currently active' using errcode = '55000';
  end if;
  if p_actor_type = 'resident'
     and not private.civya_actor_can_access_case(p_actor_user_id, p_case_id) then
    raise exception 'case entitlement required' using errcode = '42501';
  end if;
  if p_actor_type = 'staff'
     and not private.civya_actor_is_staff(p_actor_user_id, v_case.tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  insert into public.workflow_instances (
    tenant_id, resident_id, case_id, workflow_definition_id,
    completion_definition_id, workflow_key, definition_version, current_state,
    redacted_context, started_by_type, started_by_auth_user_id,
    correlation_id, idempotency_key
  ) values (
    v_case.tenant_id, v_case.resident_id, v_case.id, v_definition.id,
    v_definition.completion_definition_id, v_definition.workflow_key,
    v_definition.version, v_definition.initial_state,
    coalesce(p_redacted_context, '{}'::jsonb), p_actor_type, p_actor_user_id,
    p_correlation_id, p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_instance;
  if not found then
    v_duplicate := true;
    select * into strict v_instance from public.workflow_instances
    where tenant_id = v_case.tenant_id and idempotency_key = p_idempotency_key;
    if v_instance.case_id <> p_case_id
       or v_instance.workflow_definition_id <> p_workflow_definition_id
       or v_instance.correlation_id <> p_correlation_id then
      raise exception 'workflow start idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('workflowInstanceId', v_instance.id,
      'state', v_instance.current_state, 'status', v_instance.status,
      'rowVersion', v_instance.row_version, 'duplicate', true);
  end if;
  v_input_sha := encode(sha256(convert_to(jsonb_build_object(
    'caseId', v_case.id, 'definitionId', v_definition.id,
    'definitionSha256', v_definition.definition_sha256,
    'initialState', v_definition.initial_state, 'context', p_redacted_context
  )::text, 'UTF8')), 'hex');
  insert into public.workflow_actions (
    tenant_id, workflow_instance_id, case_id, sequence_number, action_key,
    from_state, to_state, actor_type, actor_auth_user_id, reason_code,
    correlation_id, idempotency_key, input_sha256, redacted_metadata
  ) values (
    v_case.tenant_id, v_instance.id, v_case.id, 1, 'workflow.start',
    null, v_instance.current_state, p_actor_type, p_actor_user_id, 'workflow_started',
    p_correlation_id, p_idempotency_key || ':action', v_input_sha, '{}'::jsonb
  ) returning * into v_action;
  insert into public.audit_events (tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source)
  values (v_case.tenant_id, v_case.resident_id, v_case.id, p_actor_user_id,
    'workflow_started', jsonb_build_object('workflowInstanceId', v_instance.id,
      'workflowKey', v_instance.workflow_key, 'definitionVersion', v_instance.definition_version,
      'correlationId', p_correlation_id),
    case when p_actor_type = 'resident' then 'resident'
      when p_actor_type = 'staff' then 'admin' else 'system' end);
  return jsonb_build_object('workflowInstanceId', v_instance.id,
    'state', v_instance.current_state, 'status', v_instance.status,
    'rowVersion', v_instance.row_version, 'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_record_completion_evidence(
  p_actor_user_id uuid,
  p_workflow_instance_id uuid,
  p_authority_type text,
  p_assurance_scope text,
  p_authoritative boolean,
  p_source_record_id uuid,
  p_provider_event_id uuid,
  p_outcome_verification_event_id uuid,
  p_evidence_sha256 text,
  p_redacted_evidence jsonb,
  p_observed_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_instance public.workflow_instances%rowtype;
  v_evidence public.workflow_completion_evidence%rowtype;
  v_actor_type text;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  select * into v_instance from public.workflow_instances
  where id = p_workflow_instance_id for update;
  if not found then raise exception 'workflow instance not found' using errcode = 'P0002'; end if;
  v_actor_type := case when p_actor_user_id is null then 'service' else 'staff' end;
  if p_actor_user_id is not null
     and not private.civya_actor_is_staff(p_actor_user_id, v_instance.tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  if p_observed_at > now() + interval '5 minutes' then
    raise exception 'completion evidence cannot be future dated' using errcode = '22007';
  end if;
  insert into public.workflow_completion_evidence (
    tenant_id, workflow_instance_id, case_id, completion_definition_id,
    authority_type, assurance_scope, authoritative, source_record_id,
    provider_event_id, outcome_verification_event_id, evidence_sha256,
    redacted_evidence, observed_at, verified_by_type,
    verified_by_auth_user_id, idempotency_key
  ) values (
    v_instance.tenant_id, v_instance.id, v_instance.case_id,
    v_instance.completion_definition_id, p_authority_type, p_assurance_scope,
    p_authoritative, p_source_record_id, p_provider_event_id,
    p_outcome_verification_event_id, p_evidence_sha256,
    coalesce(p_redacted_evidence, '{}'::jsonb), p_observed_at, v_actor_type,
    p_actor_user_id, p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_evidence;
  if not found then
    v_duplicate := true;
    select * into strict v_evidence from public.workflow_completion_evidence
    where tenant_id = v_instance.tenant_id and idempotency_key = p_idempotency_key;
    if v_evidence.workflow_instance_id <> p_workflow_instance_id
       or v_evidence.evidence_sha256 <> p_evidence_sha256 then
      raise exception 'completion evidence idempotency conflict' using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object('completionEvidenceId', v_evidence.id,
    'authoritative', v_evidence.authoritative,
    'assuranceScope', v_evidence.assurance_scope, 'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_transition_workflow(
  p_actor_user_id uuid,
  p_actor_type text,
  p_workflow_instance_id uuid,
  p_expected_row_version bigint,
  p_action_key text,
  p_to_state text,
  p_reason_code text,
  p_correlation_id text,
  p_redacted_metadata jsonb,
  p_completion_evidence_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_instance public.workflow_instances%rowtype;
  v_definition public.workflow_definition_versions%rowtype;
  v_completion public.completion_definition_versions%rowtype;
  v_evidence public.workflow_completion_evidence%rowtype;
  v_existing public.workflow_actions%rowtype;
  v_action public.workflow_actions%rowtype;
  v_is_terminal boolean;
  v_input_sha text;
  v_next_status text;
begin
  perform private.civya_service_required();
  if (p_actor_type in ('resident', 'staff')) <> (p_actor_user_id is not null)
     or p_actor_type not in ('resident', 'staff', 'system', 'provider') then
    raise exception 'workflow actor identity mismatch' using errcode = '22023';
  end if;
  select * into v_instance from public.workflow_instances
  where id = p_workflow_instance_id for update;
  if not found then raise exception 'workflow instance not found' using errcode = 'P0002'; end if;
  select * into v_definition from public.workflow_definition_versions
  where id = v_instance.workflow_definition_id;
  select * into v_completion from public.completion_definition_versions
  where id = v_instance.completion_definition_id;
  if p_actor_type = 'resident'
     and not private.civya_actor_can_access_case(p_actor_user_id, v_instance.case_id) then
    raise exception 'case entitlement required' using errcode = '42501';
  end if;
  if p_actor_type = 'staff'
     and not private.civya_actor_is_staff(p_actor_user_id, v_instance.tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  select * into v_existing from public.workflow_actions
  where tenant_id = v_instance.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.workflow_instance_id <> p_workflow_instance_id
       or v_existing.action_key <> p_action_key
       or v_existing.to_state <> p_to_state then
      raise exception 'workflow transition idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('workflowInstanceId', v_instance.id,
      'actionId', v_existing.id, 'state', v_existing.to_state,
      'status', v_instance.status, 'rowVersion', v_instance.row_version,
      'duplicate', true);
  end if;
  if v_instance.status not in ('active', 'paused', 'escalated') then
    raise exception 'terminal workflow cannot transition' using errcode = '55000';
  end if;
  if v_instance.row_version <> p_expected_row_version then
    raise exception 'stale workflow version' using errcode = '40001';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_definition.transitions -> v_instance.current_state, '[]'::jsonb)) edge
    where edge ->> 'action' = p_action_key and edge ->> 'to' = p_to_state
  ) then
    raise exception 'transition is not allowed by the active workflow definition'
      using errcode = '55000';
  end if;
  v_is_terminal := p_to_state = any(v_completion.terminal_states);
  if v_is_terminal and v_completion.evidence_required then
    select * into v_evidence from public.workflow_completion_evidence
    where id = p_completion_evidence_id
      and workflow_instance_id = v_instance.id
      and completion_definition_id = v_completion.id;
    if not found then
      raise exception 'terminal transition requires matching completion evidence'
        using errcode = '55000';
    end if;
    if v_completion.authoritative_evidence_required and not v_evidence.authoritative then
      raise exception 'authoritative completion evidence required' using errcode = '55000';
    end if;
    if not (
      case v_completion.minimum_assurance_scope
        when 'county_attested' then v_evidence.assurance_scope <> 'synthetic'
        when 'provider_attested' then v_evidence.assurance_scope = 'provider_attested'
        else true
      end
    ) then
      raise exception 'completion evidence assurance is below the required level'
        using errcode = '55000';
    end if;
  elsif not v_is_terminal and p_completion_evidence_id is not null then
    raise exception 'completion evidence may be bound only to a terminal transition'
      using errcode = '22023';
  end if;
  v_input_sha := encode(sha256(convert_to(jsonb_build_object(
    'workflowInstanceId', v_instance.id, 'rowVersion', v_instance.row_version,
    'definitionSha256', v_definition.definition_sha256,
    'action', p_action_key, 'from', v_instance.current_state, 'to', p_to_state,
    'reason', p_reason_code, 'metadata', coalesce(p_redacted_metadata, '{}'::jsonb),
    'completionEvidenceId', p_completion_evidence_id
  )::text, 'UTF8')), 'hex');
  v_next_status := case when v_is_terminal then 'completed' else 'active' end;
  insert into public.workflow_actions (
    tenant_id, workflow_instance_id, case_id, sequence_number, action_key,
    from_state, to_state, actor_type, actor_auth_user_id, reason_code,
    correlation_id, idempotency_key, input_sha256, redacted_metadata,
    completion_evidence_id
  ) values (
    v_instance.tenant_id, v_instance.id, v_instance.case_id,
    v_instance.row_version + 1, p_action_key, v_instance.current_state,
    p_to_state, p_actor_type, p_actor_user_id, p_reason_code,
    p_correlation_id, p_idempotency_key, v_input_sha,
    coalesce(p_redacted_metadata, '{}'::jsonb), p_completion_evidence_id
  ) returning * into v_action;
  update public.workflow_instances set
    current_state = p_to_state,
    status = v_next_status,
    row_version = row_version + 1,
    completed_at = case when v_next_status = 'completed' then now() else null end
  where id = v_instance.id returning * into v_instance;
  insert into public.audit_events (tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source)
  values (v_instance.tenant_id, v_instance.resident_id, v_instance.case_id,
    p_actor_user_id, 'workflow_transitioned', jsonb_build_object(
      'workflowInstanceId', v_instance.id, 'actionId', v_action.id,
      'actionKey', p_action_key, 'fromState', v_action.from_state,
      'toState', v_action.to_state, 'status', v_instance.status,
      'rowVersion', v_instance.row_version, 'correlationId', p_correlation_id,
      'completionEvidenceId', p_completion_evidence_id),
    case when p_actor_type = 'resident' then 'resident'
      when p_actor_type = 'staff' then 'admin' else 'system' end);
  return jsonb_build_object('workflowInstanceId', v_instance.id,
    'actionId', v_action.id, 'state', v_instance.current_state,
    'status', v_instance.status, 'rowVersion', v_instance.row_version,
    'duplicate', false);
end;
$$;

create or replace function public.civya_service_create_hosted_handoff(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_workflow_instance_id uuid,
  p_handoff_type text,
  p_provider_key text,
  p_provider_session_reference_digest text,
  p_destination_origin text,
  p_return_nonce_digest text,
  p_expires_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_case public.cases%rowtype; v_handoff public.hosted_handoff_sessions%rowtype;
begin
  perform private.civya_service_required();
  select * into v_case from public.cases where id = p_case_id;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_actor_user_id is not null
     and not private.civya_actor_can_access_case(p_actor_user_id, p_case_id) then
    raise exception 'case access required' using errcode = '42501';
  end if;
  if p_workflow_instance_id is not null and not exists (
    select 1 from public.workflow_instances i
    where i.id = p_workflow_instance_id and i.case_id = p_case_id
  ) then
    raise exception 'workflow instance not found' using errcode = 'P0002';
  end if;
  insert into public.hosted_handoff_sessions (
    tenant_id, resident_id, case_id, workflow_instance_id, handoff_type,
    provider_key, provider_session_reference_digest, destination_origin,
    return_nonce_digest, expires_at, idempotency_key
  ) values (
    v_case.tenant_id, v_case.resident_id, v_case.id, p_workflow_instance_id,
    p_handoff_type, p_provider_key, p_provider_session_reference_digest,
    p_destination_origin, p_return_nonce_digest, p_expires_at, p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_handoff;
  if not found then
    select * into strict v_handoff from public.hosted_handoff_sessions
    where tenant_id = v_case.tenant_id and idempotency_key = p_idempotency_key;
    if v_handoff.case_id <> p_case_id
       or v_handoff.provider_session_reference_digest <> p_provider_session_reference_digest then
      raise exception 'hosted handoff idempotency conflict' using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object('handoffSessionId', v_handoff.id,
    'browserState', v_handoff.browser_state,
    'authoritativeState', v_handoff.authoritative_state,
    'destinationOrigin', v_handoff.destination_origin,
    'expiresAt', v_handoff.expires_at);
end;
$$;

create or replace function public.civya_service_record_handoff_event(
  p_handoff_session_id uuid,
  p_expected_row_version bigint,
  p_source_type text,
  p_event_type text,
  p_external_event_id text,
  p_payload_sha256 text,
  p_redacted_payload jsonb,
  p_browser_state text,
  p_authoritative_state text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_handoff public.hosted_handoff_sessions%rowtype; v_event public.handoff_events%rowtype;
begin
  perform private.civya_service_required();
  select * into v_handoff from public.hosted_handoff_sessions
  where id = p_handoff_session_id for update;
  if not found then raise exception 'hosted handoff not found' using errcode = 'P0002'; end if;
  if v_handoff.row_version <> p_expected_row_version then
    raise exception 'stale hosted handoff version' using errcode = '40001';
  end if;
  if p_source_type = 'browser' and p_authoritative_state is distinct from v_handoff.authoritative_state then
    raise exception 'browser return is advisory and cannot set authoritative status'
      using errcode = '42501';
  end if;
  if p_authoritative_state in ('confirmed', 'failed')
     and p_source_type not in ('provider_webhook', 'reconciliation') then
    raise exception 'authoritative handoff status requires provider or reconciliation evidence'
      using errcode = '42501';
  end if;
  insert into public.handoff_events (
    tenant_id, handoff_session_id, source_type, event_type, external_event_id,
    payload_sha256, redacted_payload
  ) values (
    v_handoff.tenant_id, v_handoff.id, p_source_type, p_event_type,
    nullif(p_external_event_id, ''), p_payload_sha256,
    coalesce(p_redacted_payload, '{}'::jsonb)
  ) on conflict (tenant_id, source_type, external_event_id) do nothing
  returning * into v_event;
  if not found and p_external_event_id is not null then
    select * into strict v_event from public.handoff_events
    where tenant_id = v_handoff.tenant_id and source_type = p_source_type
      and external_event_id = p_external_event_id;
    return jsonb_build_object('handoffSessionId', v_handoff.id,
      'browserState', v_handoff.browser_state,
      'authoritativeState', v_handoff.authoritative_state,
      'rowVersion', v_handoff.row_version, 'duplicate', true);
  end if;
  update public.hosted_handoff_sessions set
    browser_state = coalesce(p_browser_state, browser_state),
    authoritative_state = coalesce(p_authoritative_state, authoritative_state),
    reconciled_at = case when p_authoritative_state in ('confirmed', 'failed') then now() else reconciled_at end,
    row_version = row_version + 1
  where id = v_handoff.id returning * into v_handoff;
  return jsonb_build_object('handoffSessionId', v_handoff.id,
    'browserState', v_handoff.browser_state,
    'authoritativeState', v_handoff.authoritative_state,
    'rowVersion', v_handoff.row_version, 'duplicate', false);
end;
$$;

create or replace function public.civya_service_append_document_processing_event(
  p_document_id uuid,
  p_expected_row_version bigint,
  p_to_state text,
  p_processor_key text,
  p_processor_release text,
  p_malware_signature_version text,
  p_classification_confidence numeric,
  p_extraction_confidence numeric,
  p_reason_code text,
  p_result_sha256 text,
  p_redacted_metadata jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_document public.documents%rowtype; v_event public.document_processing_events%rowtype;
begin
  perform private.civya_service_required();
  select * into v_document from public.documents where id = p_document_id for update;
  if not found then raise exception 'document not found' using errcode = 'P0002'; end if;
  select * into v_event from public.document_processing_events
  where tenant_id = v_document.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_event.document_id <> p_document_id or v_event.to_state <> p_to_state
       or v_event.result_sha256 <> p_result_sha256 then
      raise exception 'document event idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('documentId', v_document.id, 'eventId', v_event.id,
      'scanStatus', v_document.scan_status, 'rowVersion', v_document.row_version,
      'duplicate', true);
  end if;
  if v_document.row_version <> p_expected_row_version then
    raise exception 'stale document version' using errcode = '40001';
  end if;
  if not (
    (v_document.scan_status = 'pending' and p_to_state in ('quarantined', 'scanning', 'rejected'))
    or (v_document.scan_status = 'quarantined' and p_to_state in ('scanning', 'rejected'))
    or (v_document.scan_status = 'scanning' and p_to_state in ('clean', 'rejected', 'failed'))
    or (v_document.scan_status = 'failed' and p_to_state = 'scanning')
  ) then
    raise exception 'invalid document processing transition' using errcode = '55000';
  end if;
  insert into public.document_processing_events (
    tenant_id, resident_id, case_id, document_id, from_state, to_state,
    processor_key, processor_release, malware_signature_version,
    classification_confidence, extraction_confidence, reason_code,
    result_sha256, redacted_metadata, idempotency_key
  ) values (
    v_document.tenant_id, v_document.resident_id, v_document.case_id,
    v_document.id, v_document.scan_status, p_to_state, p_processor_key,
    p_processor_release, p_malware_signature_version,
    p_classification_confidence, p_extraction_confidence, p_reason_code,
    p_result_sha256, coalesce(p_redacted_metadata, '{}'::jsonb), p_idempotency_key
  ) returning * into v_event;
  update public.documents set scan_status = p_to_state,
    classification_confidence = p_classification_confidence,
    extraction_confidence = p_extraction_confidence,
    review_required = case when p_to_state = 'clean' then false else true end,
    review_reason = case when p_to_state = 'clean' then null else p_reason_code end,
    row_version = row_version + 1
  where id = v_document.id returning * into v_document;
  return jsonb_build_object('documentId', v_document.id, 'eventId', v_event.id,
    'scanStatus', v_document.scan_status, 'rowVersion', v_document.row_version,
    'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS/read grants. Base rows contain only redacted text and provider-neutral
-- references; writes are never granted to browser roles.
-- ---------------------------------------------------------------------------

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'workflow_instances', 'workflow_actions', 'workflow_completion_evidence',
    'operational_exceptions', 'referrals', 'hosted_handoff_sessions',
    'handoff_events', 'communication_deliveries', 'communication_delivery_events',
    'document_processing_events'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$$;

create policy workflow_instances_case_read on public.workflow_instances
  for select to authenticated using (public.civya_can_access_case(case_id));
create policy workflow_actions_case_read on public.workflow_actions
  for select to authenticated using (public.civya_can_access_case(case_id));
create policy workflow_completion_evidence_staff_read on public.workflow_completion_evidence
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));
create policy operational_exceptions_staff_read on public.operational_exceptions
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));
create policy referrals_case_read on public.referrals
  for select to authenticated using (public.civya_can_access_case(case_id));
create policy hosted_handoff_case_read on public.hosted_handoff_sessions
  for select to authenticated using (public.civya_can_access_case(case_id));
create policy handoff_events_staff_read on public.handoff_events
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));
create policy communication_deliveries_case_read on public.communication_deliveries
  for select to authenticated using (public.civya_can_access_case(case_id));
create policy communication_delivery_events_staff_read on public.communication_delivery_events
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));
create policy document_processing_events_case_read on public.document_processing_events
  for select to authenticated using (public.civya_can_access_case(case_id));

grant select on public.workflow_instances to authenticated, service_role;
grant select on public.workflow_actions to authenticated, service_role;
grant select on public.workflow_completion_evidence to authenticated, service_role;
grant select on public.operational_exceptions to authenticated, service_role;
grant select on public.referrals to authenticated, service_role;
grant select on public.hosted_handoff_sessions to authenticated, service_role;
grant select on public.handoff_events to authenticated, service_role;
grant select on public.communication_deliveries to authenticated, service_role;
grant select on public.communication_delivery_events to authenticated, service_role;
grant select on public.document_processing_events to authenticated, service_role;

revoke all on function public.civya_service_start_workflow(
  uuid, text, uuid, uuid, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.civya_service_record_completion_evidence(
  uuid, uuid, text, text, boolean, uuid, uuid, uuid, text, jsonb, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.civya_service_transition_workflow(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, uuid, text
) from public, anon, authenticated;
revoke all on function public.civya_service_create_hosted_handoff(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.civya_service_record_handoff_event(
  uuid, bigint, text, text, text, text, jsonb, text, text
) from public, anon, authenticated;
revoke all on function public.civya_service_append_document_processing_event(
  uuid, bigint, text, text, text, text, numeric, numeric, text, text, jsonb, text
) from public, anon, authenticated;

grant execute on function public.civya_service_start_workflow(
  uuid, text, uuid, uuid, text, jsonb, text
) to service_role;
grant execute on function public.civya_service_record_completion_evidence(
  uuid, uuid, text, text, boolean, uuid, uuid, uuid, text, jsonb, timestamptz, text
) to service_role;
grant execute on function public.civya_service_transition_workflow(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, uuid, text
) to service_role;
grant execute on function public.civya_service_create_hosted_handoff(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, text
) to service_role;
grant execute on function public.civya_service_record_handoff_event(
  uuid, bigint, text, text, text, text, jsonb, text, text
) to service_role;
grant execute on function public.civya_service_append_document_processing_event(
  uuid, bigint, text, text, text, text, numeric, numeric, text, text, jsonb, text
) to service_role;

comment on table public.workflow_completion_evidence is
  'Terminal workflow success requires versioned evidence. Browser return state is never completion authority.';
comment on table public.hosted_handoff_sessions is
  'Stores only destination origin and digests. Payment credentials and identity-proof secrets remain on the provider-hosted page.';
comment on table public.document_processing_events is
  'Append-only malware scan/classification/extraction chronology; no raw extracted document text.';
