-- Authoritative Outcome Kernel (fictional County-shaped first tranche)
--
-- Interaction lifecycle, workflow progress, submission, acceptance, and a
-- source-backed verified outcome are deliberately separate. Only service-role
-- reconciliation against a versioned synthetic-test definition and source record may append
-- a verification event. The current outcome is a projection of that ledger.

comment on column public.cases.completion_state is
  'Legacy nonofficial workflow detail. Never use this column as an official or verified outcome.';

-- Keep the existing RPC signature for deployed-client compatibility, but stop
-- ordinary turns from writing cases.completion_state. p_completion_state now
-- carries interaction lifecycle data only and is returned as interactionState.
create or replace function public.civya_commit_turn_result(
  p_user_turn_id uuid,
  p_expected_case_version bigint,
  p_spoken_response text,
  p_next_question text,
  p_workflow_state text,
  p_case_status text,
  p_conversation_summary text,
  p_completion_state jsonb,
  p_facts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_turn public.turns%rowtype;
  v_case public.cases%rowtype;
  v_conversation public.conversations%rowtype;
  v_fact record;
  v_result jsonb;
begin
  select * into v_user_turn from public.turns where id = p_user_turn_id for update;
  if not found or not public.civya_can_access_case(v_user_turn.case_id) then
    raise exception 'turn not found' using errcode = 'P0002';
  end if;
  if v_user_turn.processing_status = 'committed' then return v_user_turn.processing_result; end if;

  select * into v_case from public.cases where id = v_user_turn.case_id for update;
  if v_case.row_version <> p_expected_case_version then
    raise exception 'stale case version' using errcode = '40001';
  end if;
  select * into v_conversation from public.conversations where id = v_user_turn.conversation_id for update;

  if jsonb_typeof(coalesce(p_facts, '{}'::jsonb)) <> 'object' then
    raise exception 'facts must be an object';
  end if;
  for v_fact in select key, value from jsonb_each(coalesce(p_facts, '{}'::jsonb)) loop
    insert into public.case_facts (
      tenant_id, resident_id, case_id, fact_key, fact_value, source_turn_id,
      idempotency_key, confirmation_state, confirmed_at
    ) values (
      v_case.tenant_id, v_case.resident_id, v_case.id, v_fact.key, v_fact.value,
      v_user_turn.id, v_user_turn.idempotency_key || ':' || v_fact.key,
      'confirmed', now()
    )
    on conflict (case_id, fact_key) do update set
      fact_value = excluded.fact_value,
      source_turn_id = excluded.source_turn_id,
      idempotency_key = excluded.idempotency_key,
      confirmation_state = 'confirmed',
      confirmed_at = now(),
      row_version = public.case_facts.row_version + 1;
  end loop;

  update public.cases set
    status = coalesce(nullif(p_case_status, ''), status),
    workflow_state = coalesce(nullif(p_workflow_state, ''), workflow_state),
    next_question = p_next_question,
    resume_summary = left(coalesce(p_conversation_summary, resume_summary), 4000),
    row_version = row_version + 1
  where id = v_case.id returning * into v_case;

  update public.conversations set
    summary = left(coalesce(p_conversation_summary, summary), 4000),
    last_turn_at = now(),
    row_version = row_version + 1
  where id = v_conversation.id returning * into v_conversation;

  insert into public.turns (
    tenant_id, resident_id, case_id, conversation_id, speaker, channel,
    client_turn_id, idempotency_key, redacted_text, processing_status, committed_at
  ) values (
    v_user_turn.tenant_id, v_user_turn.resident_id, v_user_turn.case_id,
    v_user_turn.conversation_id, 'assistant', v_user_turn.channel,
    v_user_turn.client_turn_id || ':assistant', v_user_turn.idempotency_key || ':assistant',
    left(p_spoken_response, 12000), 'committed', now()
  ) on conflict (conversation_id, idempotency_key) do nothing;

  v_result := jsonb_build_object(
    'spokenResponse', p_spoken_response,
    'caseUpdate', jsonb_build_object(
      'caseId', v_case.id, 'status', v_case.status, 'rowVersion', v_case.row_version,
      'workflowState', v_case.workflow_state
    ),
    'nextQuestion', p_next_question,
    'interactionState', coalesce(p_completion_state, '{"state":"continue"}'::jsonb)
  );
  update public.turns set
    processing_status = 'committed', processing_result = v_result, committed_at = now()
  where id = v_user_turn.id;
  return v_result;
end;
$$;

create table public.authoritative_source_systems (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_key text not null,
  display_name text not null,
  authority_scope text[] not null default '{}'::text[],
  status text not null check (status = 'synthetic'),
  fictional boolean not null default true check (fictional),
  created_at timestamptz not null default now(),
  unique (tenant_id, source_key)
);

create table public.authoritative_source_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_system_id uuid not null references public.authoritative_source_systems(id),
  external_batch_id text not null,
  schema_version text not null,
  declared_batch_sha256 text not null check (declared_batch_sha256 ~ '^[0-9a-f]{64}$'),
  source_generated_at timestamptz not null,
  received_at timestamptz not null default now(),
  disposition text not null check (disposition in ('accepted', 'quarantined', 'rejected')),
  authentication_state text not null default 'synthetic'
    check (authentication_state = 'synthetic'),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, source_system_id, idempotency_key),
  unique (tenant_id, source_system_id, external_batch_id)
);

create table public.authoritative_source_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_system_id uuid not null references public.authoritative_source_systems(id),
  source_batch_id uuid not null references public.authoritative_source_batches(id),
  record_type text not null,
  external_record_id text not null,
  effective_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_record_id uuid references public.authoritative_source_records(id),
  created_at timestamptz not null default now(),
  unique (source_batch_id, external_record_id, payload_sha256)
);

create table public.outcome_definition_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pathway_key text not null,
  outcome_key text not null,
  version text not null,
  required_source_key text not null,
  required_record_type text not null,
  required_schema_version text not null,
  required_fields text[] not null default '{}'::text[],
  criteria jsonb not null default '{}'::jsonb check (jsonb_typeof(criteria) = 'object'),
  reversal_criteria jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reversal_criteria) = 'object'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  reversible boolean not null default true,
  status text not null check (status in ('draft', 'synthetic_test')),
  registered_by_auth_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, pathway_key, outcome_key, version),
  check (effective_to is null or effective_to > effective_from)
);

create table public.case_source_match_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  source_record_id uuid not null references public.authoritative_source_records(id),
  decision text not null check (decision in ('accepted', 'rejected', 'ambiguous')),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  factors jsonb not null default '[]'::jsonb check (jsonb_typeof(factors) = 'array'),
  reason_code text not null,
  decided_by_type text not null check (decided_by_type in ('service', 'staff')),
  decided_by_auth_user_id uuid references auth.users(id),
  supersedes_match_id uuid references public.case_source_match_decisions(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (
    (decided_by_type = 'staff' and decided_by_auth_user_id is not null)
    or (decided_by_type = 'service' and decided_by_auth_user_id is null)
  )
);

create table public.outcome_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  outcome_definition_id uuid not null references public.outcome_definition_versions(id),
  source_record_id uuid not null references public.authoritative_source_records(id),
  evaluator_release text not null,
  requested_by_type text not null check (requested_by_type in ('service', 'staff')),
  requested_by_auth_user_id uuid references auth.users(id),
  result text not null check (result in ('incomplete', 'ambiguous', 'verified', 'reversed')),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (
    (requested_by_type = 'staff' and requested_by_auth_user_id is not null)
    or (requested_by_type = 'service' and requested_by_auth_user_id is null)
  )
);

create table public.outcome_verification_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  reconciliation_run_id uuid not null references public.outcome_reconciliation_runs(id),
  outcome_definition_id uuid not null references public.outcome_definition_versions(id),
  source_record_id uuid not null references public.authoritative_source_records(id),
  event_type text not null check (event_type in ('verified', 'reversed')),
  actor_type text not null check (actor_type in ('service', 'staff')),
  actor_auth_user_id uuid references auth.users(id),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  supersedes_event_id uuid references public.outcome_verification_events(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check (
    (actor_type = 'staff' and actor_auth_user_id is not null)
    or (actor_type = 'service' and actor_auth_user_id is null)
  )
);

create table public.case_outcome_projections (
  case_id uuid not null references public.cases(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pathway_key text not null,
  outcome_key text not null,
  current_status text not null check (current_status in ('verified', 'reversed')),
  evidence_scope text not null check (evidence_scope = 'synthetic'),
  controlling_event_id uuid not null references public.outcome_verification_events(id),
  outcome_definition_id uuid not null references public.outcome_definition_versions(id),
  source_record_id uuid not null references public.authoritative_source_records(id),
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (case_id, pathway_key, outcome_key)
);

create index authoritative_source_records_external_idx
  on public.authoritative_source_records (tenant_id, source_system_id, external_record_id, effective_at desc);
create index case_source_match_current_idx
  on public.case_source_match_decisions (case_id, source_record_id, created_at desc);
create index outcome_reconciliation_case_idx
  on public.outcome_reconciliation_runs (tenant_id, case_id, created_at desc);
create index outcome_verification_case_idx
  on public.outcome_verification_events (tenant_id, case_id, created_at desc);
create index case_outcome_projection_status_idx
  on public.case_outcome_projections (tenant_id, current_status);

create or replace function private.civya_reject_immutable_outcome_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('civya.authorized_outcome_purge', true) = 'synthetic_retention'
     and exists (
       select 1 from public.tenants t
       where t.id = old.tenant_id and t.fictional and t.environment = 'sandbox'
     ) then
    return old;
  end if;
  raise exception 'authoritative outcome history is append-only' using errcode = '55000';
end;
$$;

revoke all on function private.civya_reject_immutable_outcome_mutation() from public, anon, authenticated;

create trigger authoritative_source_systems_immutable
  before update or delete on public.authoritative_source_systems
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger authoritative_source_batches_immutable
  before update or delete on public.authoritative_source_batches
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger authoritative_source_records_immutable
  before update or delete on public.authoritative_source_records
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger outcome_definition_versions_immutable
  before update or delete on public.outcome_definition_versions
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger case_source_match_decisions_immutable
  before update or delete on public.case_source_match_decisions
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger outcome_reconciliation_runs_immutable
  before update or delete on public.outcome_reconciliation_runs
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger outcome_verification_events_immutable
  before update or delete on public.outcome_verification_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();

create or replace function private.civya_validate_outcome_chain()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'authoritative_source_batches' then
    if not exists (
      select 1 from public.authoritative_source_systems s
      where s.id = new.source_system_id and s.tenant_id = new.tenant_id
    ) then
      raise exception 'source batch tenant/source mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'authoritative_source_records' then
    if not exists (
      select 1
      from public.authoritative_source_batches b
      where b.id = new.source_batch_id and b.tenant_id = new.tenant_id
        and b.source_system_id = new.source_system_id
    ) then
      raise exception 'source record tenant/source/batch mismatch' using errcode = '23514';
    end if;
    if new.supersedes_record_id is not null and not exists (
      select 1 from public.authoritative_source_records prior
      where prior.id = new.supersedes_record_id
        and prior.tenant_id = new.tenant_id
        and prior.source_system_id = new.source_system_id
        and prior.record_type = new.record_type
        and prior.external_record_id = new.external_record_id
        and prior.effective_at < new.effective_at
    ) then
      raise exception 'source supersession must preserve identity and advance effective time'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'case_source_match_decisions' then
    if not exists (
      select 1
      from public.cases c
      join public.authoritative_source_records r on r.id = new.source_record_id
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and r.tenant_id = new.tenant_id
    ) then
      raise exception 'source match tenant chain mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'outcome_reconciliation_runs' then
    if not exists (
      select 1
      from public.cases c
      join public.outcome_definition_versions d on d.id = new.outcome_definition_id
      join public.authoritative_source_records r on r.id = new.source_record_id
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and d.tenant_id = new.tenant_id and r.tenant_id = new.tenant_id
    ) then
      raise exception 'reconciliation tenant chain mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'outcome_verification_events' then
    if not exists (
      select 1 from public.outcome_reconciliation_runs r
      where r.id = new.reconciliation_run_id
        and r.tenant_id = new.tenant_id and r.case_id = new.case_id
        and r.outcome_definition_id = new.outcome_definition_id
        and r.source_record_id = new.source_record_id
        and r.result = new.event_type
    ) then
      raise exception 'verification event does not match its reconciliation run'
        using errcode = '23514';
    end if;
    if new.supersedes_event_id is not null and not exists (
      select 1 from public.outcome_verification_events prior
      join public.outcome_definition_versions prior_definition
        on prior_definition.id = prior.outcome_definition_id
      join public.outcome_definition_versions next_definition
        on next_definition.id = new.outcome_definition_id
      where prior.id = new.supersedes_event_id
        and prior.tenant_id = new.tenant_id and prior.case_id = new.case_id
        and prior_definition.pathway_key = next_definition.pathway_key
        and prior_definition.outcome_key = next_definition.outcome_key
        and not exists (
          select 1 from public.outcome_verification_events newer
          where newer.supersedes_event_id = prior.id
        )
    ) then
      raise exception 'verification predecessor is missing, unrelated, or no longer current'
        using errcode = '40001';
    end if;
  elsif tg_table_name = 'case_outcome_projections' then
    if not exists (
      select 1
      from public.outcome_verification_events e
      join public.outcome_definition_versions d on d.id = e.outcome_definition_id
      where e.id = new.controlling_event_id
        and e.tenant_id = new.tenant_id and e.case_id = new.case_id
        and e.outcome_definition_id = new.outcome_definition_id
        and e.source_record_id = new.source_record_id
        and e.event_type = new.current_status
        and d.pathway_key = new.pathway_key and d.outcome_key = new.outcome_key
    ) then
      raise exception 'outcome projection does not match its controlling event'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_outcome_chain()
  from public, anon, authenticated, service_role;

create trigger authoritative_source_batches_chain_guard
  before insert on public.authoritative_source_batches
  for each row execute function private.civya_validate_outcome_chain();
create trigger authoritative_source_records_chain_guard
  before insert on public.authoritative_source_records
  for each row execute function private.civya_validate_outcome_chain();
create trigger case_source_match_decisions_chain_guard
  before insert on public.case_source_match_decisions
  for each row execute function private.civya_validate_outcome_chain();
create trigger outcome_reconciliation_runs_chain_guard
  before insert on public.outcome_reconciliation_runs
  for each row execute function private.civya_validate_outcome_chain();
create trigger outcome_verification_events_chain_guard
  before insert on public.outcome_verification_events
  for each row execute function private.civya_validate_outcome_chain();
create trigger case_outcome_projections_chain_guard
  before insert or update on public.case_outcome_projections
  for each row execute function private.civya_validate_outcome_chain();

create or replace function private.civya_guard_outcome_case_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.parcel_id is distinct from new.parcel_id
     and exists (
       select 1 from public.case_outcome_projections p where p.case_id = old.id
     ) then
    raise exception 'case parcel identity cannot change while an outcome projection exists; invalidate and reconcile the match first'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.civya_guard_outcome_case_identity()
  from public, anon, authenticated, service_role;
create trigger cases_outcome_identity_guard
  before update of parcel_id on public.cases
  for each row execute function private.civya_guard_outcome_case_identity();

alter table public.authoritative_source_systems enable row level security;
alter table public.authoritative_source_batches enable row level security;
alter table public.authoritative_source_records enable row level security;
alter table public.outcome_definition_versions enable row level security;
alter table public.case_source_match_decisions enable row level security;
alter table public.outcome_reconciliation_runs enable row level security;
alter table public.outcome_verification_events enable row level security;
alter table public.case_outcome_projections enable row level security;

-- RLS policies execute as the querying role. Keep the broader staff-resolution
-- helper private and expose only this boolean, tenant-scoped security-definer
-- wrapper to authenticated users.
create or replace function private.civya_outcome_staff_read_allowed(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select private.civya_actor_is_staff(auth.uid(), p_tenant_id)
$$;

revoke all on function private.civya_outcome_staff_read_allowed(uuid)
  from public, anon, authenticated;
grant execute on function private.civya_outcome_staff_read_allowed(uuid)
  to authenticated;

create or replace function private.civya_outcome_admin_read_allowed(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select private.civya_actor_is_staff(auth.uid(), p_tenant_id, 'admin')
$$;

revoke all on function private.civya_outcome_admin_read_allowed(uuid)
  from public, anon, authenticated;
grant execute on function private.civya_outcome_admin_read_allowed(uuid)
  to authenticated;

create policy authoritative_source_systems_staff_read on public.authoritative_source_systems
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy authoritative_source_batches_staff_read on public.authoritative_source_batches
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy authoritative_source_records_staff_read on public.authoritative_source_records
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy outcome_definition_versions_staff_read on public.outcome_definition_versions
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy case_source_match_decisions_staff_read on public.case_source_match_decisions
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy outcome_reconciliation_runs_staff_read on public.outcome_reconciliation_runs
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy outcome_verification_events_staff_read on public.outcome_verification_events
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy case_outcome_projections_staff_read on public.case_outcome_projections
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));

revoke all on public.authoritative_source_systems from public, anon, authenticated;
revoke all on public.authoritative_source_batches from public, anon, authenticated;
revoke all on public.authoritative_source_records from public, anon, authenticated;
revoke all on public.outcome_definition_versions from public, anon, authenticated;
revoke all on public.case_source_match_decisions from public, anon, authenticated;
revoke all on public.outcome_reconciliation_runs from public, anon, authenticated;
revoke all on public.outcome_verification_events from public, anon, authenticated;
revoke all on public.case_outcome_projections from public, anon, authenticated;

grant select on public.authoritative_source_systems to authenticated;
grant select on public.authoritative_source_batches to authenticated;
grant select on public.authoritative_source_records to authenticated;
grant select on public.outcome_definition_versions to authenticated;
grant select on public.case_source_match_decisions to authenticated;
grant select on public.outcome_reconciliation_runs to authenticated;
grant select on public.outcome_verification_events to authenticated;
grant select on public.case_outcome_projections to authenticated;

-- Even service-role application code must cross the governed RPC boundary.
-- Security-definer functions retain owner privileges; the role itself receives
-- read access only and cannot forge ledger rows or overwrite the projection.
revoke insert, update, delete on public.authoritative_source_systems from service_role;
revoke insert, update, delete on public.authoritative_source_batches from service_role;
revoke insert, update, delete on public.authoritative_source_records from service_role;
revoke insert, update, delete on public.outcome_definition_versions from service_role;
revoke insert, update, delete on public.case_source_match_decisions from service_role;
revoke insert, update, delete on public.outcome_reconciliation_runs from service_role;
revoke insert, update, delete on public.outcome_verification_events from service_role;
revoke insert, update, delete on public.case_outcome_projections from service_role;

grant select on public.authoritative_source_systems to service_role;
grant select on public.authoritative_source_batches to service_role;
grant select on public.authoritative_source_records to service_role;
grant select on public.outcome_definition_versions to service_role;
grant select on public.case_source_match_decisions to service_role;
grant select on public.outcome_reconciliation_runs to service_role;
grant select on public.outcome_verification_events to service_role;
grant select on public.case_outcome_projections to service_role;

-- Preserve the sandbox retention promise without opening an ad hoc deletion
-- path. The prior retention/reset functions keep their authorization checks;
-- these wrappers set a transaction-local marker that only permits cascaded
-- deletion of outcome history belonging to fictional sandbox tenants.
alter function public.civya_prepare_retention_cleanup()
  rename to civya_prepare_retention_cleanup_pre_outcome_kernel;
revoke all on function public.civya_prepare_retention_cleanup_pre_outcome_kernel()
  from public, anon, authenticated, service_role;

create or replace function public.civya_prepare_retention_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_result jsonb;
  v_deleted integer;
  v_expired_record_ids uuid[] := '{}'::uuid[];
  v_expired_batch_ids uuid[] := '{}'::uuid[];
begin
  perform private.civya_service_required();
  perform set_config('civya.authorized_outcome_purge', 'synthetic_retention', true);

  select coalesce(array_agg(distinct m.source_record_id), '{}'::uuid[])
    into v_expired_record_ids
  from public.case_source_match_decisions m
  join public.cases c on c.id = m.case_id
  join public.tenants t on t.id = c.tenant_id
  where t.fictional and t.environment = 'sandbox'
    and c.updated_at < now() - make_interval(days => t.retention_days);
  select coalesce(array_agg(distinct r.source_batch_id), '{}'::uuid[])
    into v_expired_batch_ids
  from public.authoritative_source_records r
  where r.id = any(v_expired_record_ids);

  v_result := public.civya_prepare_retention_cleanup_pre_outcome_kernel();

  -- Source snapshots are case-independent. Remove only records captured from
  -- the expired cases above, or aged unreferenced orphans. Fresh records that
  -- are awaiting matching/reconciliation must survive the cleanup run.
  loop
    with deleted as (
      delete from public.authoritative_source_records r
      using public.authoritative_source_systems s, public.tenants t
      where r.source_system_id = s.id
        and r.tenant_id = t.id
        and s.fictional and t.fictional and t.environment = 'sandbox'
        and (
          r.id = any(v_expired_record_ids)
          or r.created_at < now() - make_interval(days => t.retention_days)
        )
        and not exists (
          select 1 from public.case_source_match_decisions m
          where m.source_record_id = r.id
        )
        and not exists (
          select 1 from public.authoritative_source_records child
          where child.supersedes_record_id = r.id
        )
      returning 1
    ) select count(*)::integer into v_deleted from deleted;
    exit when v_deleted = 0;
  end loop;

  delete from public.authoritative_source_batches b
  using public.authoritative_source_systems s, public.tenants t
  where b.source_system_id = s.id
    and b.tenant_id = t.id
    and s.fictional and t.fictional and t.environment = 'sandbox'
    and (
      b.id = any(v_expired_batch_ids)
      or b.created_at < now() - make_interval(days => t.retention_days)
    )
    and not exists (
      select 1 from public.authoritative_source_records r
      where r.source_batch_id = b.id
    );
  return v_result;
end;
$$;

revoke all on function public.civya_prepare_retention_cleanup()
  from public, anon, authenticated;
grant execute on function public.civya_prepare_retention_cleanup()
  to service_role;

alter function public.civya_reset_tenant_sandbox(text)
  rename to civya_reset_tenant_sandbox_pre_outcome_kernel;
revoke all on function public.civya_reset_tenant_sandbox_pre_outcome_kernel(text)
  from public, anon, authenticated, service_role;

create or replace function public.civya_reset_tenant_sandbox(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_result jsonb;
  v_tenant_id uuid;
  v_deleted integer;
begin
  select id into v_tenant_id from public.tenants
    where slug = p_tenant_slug and fictional and environment = 'sandbox';
  if not found then
    raise exception 'fictional sandbox tenant not found' using errcode = 'P0002';
  end if;
  perform set_config('civya.authorized_outcome_purge', 'synthetic_retention', true);
  v_result := public.civya_reset_tenant_sandbox_pre_outcome_kernel(p_tenant_slug);

  delete from public.outcome_definition_versions where tenant_id = v_tenant_id;
  loop
    with deleted as (
      delete from public.authoritative_source_records r
      where r.tenant_id = v_tenant_id
        and not exists (
          select 1 from public.authoritative_source_records child
          where child.supersedes_record_id = r.id
        )
      returning 1
    ) select count(*)::integer into v_deleted from deleted;
    exit when v_deleted = 0;
  end loop;
  delete from public.authoritative_source_batches where tenant_id = v_tenant_id;
  delete from public.authoritative_source_systems where tenant_id = v_tenant_id;
  return v_result;
end;
$$;

revoke all on function public.civya_reset_tenant_sandbox(text) from public, anon;
grant execute on function public.civya_reset_tenant_sandbox(text)
  to authenticated, service_role;

create or replace function public.civya_service_ingest_source_snapshot(
  p_tenant_id uuid,
  p_source_key text,
  p_source_display_name text,
  p_external_batch_id text,
  p_schema_version text,
  p_batch_sha256 text,
  p_source_generated_at timestamptz,
  p_record_type text,
  p_external_record_id text,
  p_effective_at timestamptz,
  p_payload jsonb,
  p_supersedes_record_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_source public.authoritative_source_systems%rowtype;
  v_batch public.authoritative_source_batches%rowtype;
  v_record public.authoritative_source_records%rowtype;
  v_payload_sha256 text;
begin
  perform private.civya_service_required();
  if not exists (select 1 from public.tenants where id = p_tenant_id and fictional) then
    raise exception 'fictional tenant not found' using errcode = 'P0002';
  end if;
  if coalesce(p_source_key, '') = '' or coalesce(p_source_display_name, '') = ''
     or coalesce(p_external_batch_id, '') = '' or coalesce(p_schema_version, '') = ''
     or coalesce(p_record_type, '') = '' or coalesce(p_external_record_id, '') = ''
     or coalesce(p_idempotency_key, '') = '' then
    raise exception 'source, batch, schema, record, and idempotency identifiers are required';
  end if;
  if jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) <> 'object' then
    raise exception 'source payload must be an object';
  end if;
  if p_batch_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'batch sha256 must be 64 lowercase hexadecimal characters';
  end if;
  if p_source_generated_at > now() + interval '5 minutes'
     or p_effective_at > p_source_generated_at then
    raise exception 'synthetic source timestamps are invalid' using errcode = '22007';
  end if;
  v_payload_sha256 := encode(
    sha256(convert_to(p_payload::text, 'UTF8')),
    'hex'
  );

  insert into public.authoritative_source_systems (
    tenant_id, source_key, display_name, authority_scope, status, fictional
  ) values (
    p_tenant_id, p_source_key, p_source_display_name,
    array[p_record_type]::text[], 'synthetic', true
  ) on conflict (tenant_id, source_key) do nothing;
  select * into v_source from public.authoritative_source_systems
    where tenant_id = p_tenant_id and source_key = p_source_key
    for update;
  if v_source.status <> 'synthetic' or not v_source.fictional
     or not (p_record_type = any(v_source.authority_scope)) then
    raise exception 'source system is outside its synthetic authority scope' using errcode = '55000';
  end if;
  if v_source.display_name <> p_source_display_name then
    raise exception 'source key metadata conflict' using errcode = '23505';
  end if;

  select * into v_batch from public.authoritative_source_batches
    where tenant_id = p_tenant_id
      and source_system_id = v_source.id
      and idempotency_key = p_idempotency_key;
  if found then
    if v_batch.declared_batch_sha256 <> p_batch_sha256
       or v_batch.external_batch_id <> p_external_batch_id
       or v_batch.schema_version <> p_schema_version
       or v_batch.source_generated_at <> p_source_generated_at then
      raise exception 'source batch idempotency conflict' using errcode = '23505';
    end if;
    select * into v_record from public.authoritative_source_records
      where source_batch_id = v_batch.id
        and external_record_id = p_external_record_id
        and payload_sha256 = v_payload_sha256;
    if not found then raise exception 'source record idempotency conflict' using errcode = '23505'; end if;
    if v_record.record_type <> p_record_type
       or v_record.effective_at <> p_effective_at
       or v_record.payload <> p_payload
       or v_record.supersedes_record_id is distinct from p_supersedes_record_id then
      raise exception 'source record idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'sourceSystemId', v_source.id, 'batchId', v_batch.id,
      'sourceRecordId', v_record.id, 'payloadSha256', v_record.payload_sha256,
      'idempotentReplay', true
    );
  end if;

  if p_supersedes_record_id is not null and not exists (
    select 1 from public.authoritative_source_records r
    where r.id = p_supersedes_record_id and r.source_system_id = v_source.id
  ) then
    raise exception 'superseded source record not found' using errcode = 'P0002';
  end if;
  if p_supersedes_record_id is not null and exists (
    select 1 from public.authoritative_source_records r
    where r.supersedes_record_id = p_supersedes_record_id
  ) then
    raise exception 'superseded source record is no longer current' using errcode = '40001';
  end if;

  insert into public.authoritative_source_batches (
    tenant_id, source_system_id, external_batch_id, schema_version,
    declared_batch_sha256, source_generated_at, disposition,
    authentication_state, idempotency_key
  ) values (
    p_tenant_id, v_source.id, p_external_batch_id, p_schema_version,
    p_batch_sha256, p_source_generated_at, 'accepted', 'synthetic', p_idempotency_key
  ) returning * into v_batch;

  insert into public.authoritative_source_records (
    tenant_id, source_system_id, source_batch_id, record_type,
    external_record_id, effective_at, payload, payload_sha256, supersedes_record_id
  ) values (
    p_tenant_id, v_source.id, v_batch.id, p_record_type,
    p_external_record_id, p_effective_at, p_payload, v_payload_sha256,
    p_supersedes_record_id
  ) returning * into v_record;

  return jsonb_build_object(
    'sourceSystemId', v_source.id, 'batchId', v_batch.id,
    'sourceRecordId', v_record.id, 'payloadSha256', v_record.payload_sha256,
    'idempotentReplay', false
  );
end;
$$;

create or replace function public.civya_service_register_outcome_definition(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_pathway_key text,
  p_outcome_key text,
  p_version text,
  p_required_source_key text,
  p_required_record_type text,
  p_required_schema_version text,
  p_required_fields text[],
  p_criteria jsonb,
  p_reversal_criteria jsonb,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_reversible boolean,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_definition public.outcome_definition_versions%rowtype;
  v_tenant public.tenants%rowtype;
begin
  perform private.civya_service_required();
  select * into v_tenant from public.tenants where id = p_tenant_id for update;
  if not found then raise exception 'tenant not found' using errcode = 'P0002'; end if;
  if p_status not in ('draft', 'synthetic_test') then
    raise exception 'invalid definition status';
  end if;
  if jsonb_typeof(coalesce(p_criteria, 'null'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_reversal_criteria, 'null'::jsonb)) <> 'object' then
    raise exception 'positive and reversal criteria must be objects';
  end if;
  if coalesce(p_pathway_key, '') = '' or coalesce(p_outcome_key, '') = ''
     or coalesce(p_version, '') = '' or coalesce(p_required_source_key, '') = ''
     or coalesce(p_required_record_type, '') = ''
     or coalesce(p_required_schema_version, '') = '' then
    raise exception 'pathway, outcome, version, source, record type, and schema are required';
  end if;
  if array_position(coalesce(p_required_fields, '{}'::text[]), null) is not null then
    raise exception 'required fields cannot contain null';
  end if;
  if p_status = 'synthetic_test'
     and (not v_tenant.fictional
       or not private.civya_actor_is_staff(p_actor_user_id, p_tenant_id, 'admin')) then
    raise exception 'synthetic test activation requires a fictional tenant administrator'
      using errcode = '42501';
  end if;
  if p_reversible and p_reversal_criteria = '{}'::jsonb then
    raise exception 'reversible definitions require explicit reversal criteria';
  end if;
  if p_status = 'synthetic_test' and exists (
    select 1 from public.outcome_definition_versions d
    where d.tenant_id = p_tenant_id
      and d.pathway_key = p_pathway_key and d.outcome_key = p_outcome_key
      and d.version <> p_version and d.status = 'synthetic_test'
      and tstzrange(d.effective_from, d.effective_to, '[)')
        && tstzrange(p_effective_from, p_effective_to, '[)')
  ) then
    raise exception 'synthetic test definition effective periods may not overlap'
      using errcode = '23505';
  end if;
  select * into v_definition from public.outcome_definition_versions
    where tenant_id = p_tenant_id and pathway_key = p_pathway_key
      and outcome_key = p_outcome_key and version = p_version;
  if found then
    if v_definition.required_source_key <> p_required_source_key
       or v_definition.required_record_type <> p_required_record_type
       or v_definition.required_schema_version <> p_required_schema_version
       or v_definition.required_fields <> coalesce(p_required_fields, '{}'::text[])
       or v_definition.criteria <> p_criteria
       or v_definition.reversal_criteria <> p_reversal_criteria
       or v_definition.effective_from <> p_effective_from
       or v_definition.effective_to is distinct from p_effective_to
       or v_definition.reversible <> p_reversible
       or v_definition.status <> p_status then
      raise exception 'outcome definition version conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('outcomeDefinitionId', v_definition.id, 'idempotentReplay', true);
  end if;
  insert into public.outcome_definition_versions (
    tenant_id, pathway_key, outcome_key, version, required_source_key,
    required_record_type, required_schema_version, required_fields, criteria,
    reversal_criteria, effective_from, effective_to, reversible,
    status, registered_by_auth_user_id
  ) values (
    p_tenant_id, p_pathway_key, p_outcome_key, p_version, p_required_source_key,
    p_required_record_type, p_required_schema_version,
    coalesce(p_required_fields, '{}'::text[]), p_criteria, p_reversal_criteria,
    p_effective_from, p_effective_to, p_reversible, p_status,
    case
      when private.civya_actor_is_staff(p_actor_user_id, p_tenant_id) then p_actor_user_id
      else null
    end
  ) returning * into v_definition;
  return jsonb_build_object('outcomeDefinitionId', v_definition.id, 'idempotentReplay', false);
end;
$$;

create or replace function public.civya_service_record_source_match(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_source_record_id uuid,
  p_decision text,
  p_reason_code text,
  p_supersedes_match_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_case public.cases%rowtype;
  v_record public.authoritative_source_records%rowtype;
  v_existing public.case_source_match_decisions%rowtype;
  v_match public.case_source_match_decisions%rowtype;
  v_actor_type text;
  v_actor_user_id uuid;
  v_exact_identifier boolean;
  v_confidence numeric;
  v_factors jsonb;
  v_reason_code text;
begin
  perform private.civya_service_required();
  if p_decision not in ('accepted', 'rejected', 'ambiguous') then raise exception 'invalid match decision'; end if;
  if coalesce(p_reason_code, '') = '' or coalesce(p_idempotency_key, '') = '' then
    raise exception 'match reason and idempotency key are required';
  end if;
  -- Match changes and reconciliation share this lock so a case cannot fork
  -- into two current evidence chains under concurrent requests.
  select * into v_case from public.cases where id = p_case_id for update;
  select * into v_record from public.authoritative_source_records where id = p_source_record_id;
  if v_case.id is null or v_record.id is null or v_case.tenant_id <> v_record.tenant_id then
    raise exception 'case or source record not found' using errcode = 'P0002';
  end if;
  v_actor_type := case
    when p_actor_user_id is not null
      and private.civya_actor_is_staff(p_actor_user_id, v_case.tenant_id) then 'staff'
    else 'service'
  end;
  v_actor_user_id := case when v_actor_type = 'staff' then p_actor_user_id else null end;
  v_exact_identifier := coalesce(trim(v_case.parcel_id), '') <> ''
    and coalesce(trim(v_record.payload ->> 'parcel_id'), '') <> ''
    and upper(trim(v_case.parcel_id)) = upper(trim(v_record.payload ->> 'parcel_id'));
  if p_decision = 'accepted' and not v_exact_identifier then
    raise exception 'accepted matches require an exact case/source parcel identifier'
      using errcode = '55000';
  end if;
  v_confidence := case when p_decision = 'accepted' then 1.0000 else null end;
  v_factors := jsonb_build_array(jsonb_build_object(
    'rule', 'exact_parcel_identifier_v1',
    'matched', v_exact_identifier,
    'sourceRecordSha256', v_record.payload_sha256
  ));
  v_reason_code := case
    when p_decision = 'accepted' then 'exact_parcel_identifier'
    else p_reason_code
  end;
  select * into v_existing from public.case_source_match_decisions
    where tenant_id = v_case.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.case_id <> p_case_id or v_existing.source_record_id <> p_source_record_id
       or v_existing.decision <> p_decision
       or v_existing.confidence is distinct from v_confidence
       or v_existing.factors <> v_factors
       or v_existing.reason_code <> v_reason_code
       or v_existing.decided_by_type <> v_actor_type
       or v_existing.decided_by_auth_user_id is distinct from v_actor_user_id
       or v_existing.supersedes_match_id is distinct from p_supersedes_match_id then
      raise exception 'match decision idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'matchDecisionId', v_existing.id,
      'matchBasis', v_existing.reason_code,
      'idempotentReplay', true
    );
  end if;
  if p_supersedes_match_id is not null and not exists (
    select 1
    from public.case_source_match_decisions m
    join public.authoritative_source_records prior_record on prior_record.id = m.source_record_id
    where m.id = p_supersedes_match_id and m.case_id = p_case_id
      and prior_record.source_system_id = v_record.source_system_id
      and not exists (
        select 1 from public.case_source_match_decisions newer
        where newer.supersedes_match_id = m.id
      )
  ) then
    raise exception 'superseded match decision is missing, unrelated, or no longer current'
      using errcode = '40001';
  end if;
  if p_supersedes_match_id is null and exists (
    select 1
    from public.case_source_match_decisions m
    join public.authoritative_source_records prior_record on prior_record.id = m.source_record_id
    where m.case_id = p_case_id
      and prior_record.source_system_id = v_record.source_system_id
      and not exists (
        select 1 from public.case_source_match_decisions newer
        where newer.supersedes_match_id = m.id
      )
  ) then
    raise exception 'a current source match must be explicitly superseded' using errcode = '40001';
  end if;
  insert into public.case_source_match_decisions (
    tenant_id, case_id, source_record_id, decision, confidence, factors,
    reason_code, decided_by_type, decided_by_auth_user_id,
    supersedes_match_id, idempotency_key
  ) values (
    v_case.tenant_id, p_case_id, p_source_record_id, p_decision, v_confidence,
    v_factors, v_reason_code, v_actor_type,
    v_actor_user_id, p_supersedes_match_id, p_idempotency_key
  ) returning * into v_match;
  return jsonb_build_object(
    'matchDecisionId', v_match.id,
    'matchBasis', v_match.reason_code,
    'idempotentReplay', false
  );
end;
$$;

create or replace function public.civya_service_reconcile_outcome(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_outcome_definition_id uuid,
  p_source_record_id uuid,
  p_evaluator_release text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_case public.cases%rowtype;
  v_definition public.outcome_definition_versions%rowtype;
  v_record public.authoritative_source_records%rowtype;
  v_source public.authoritative_source_systems%rowtype;
  v_batch public.authoritative_source_batches%rowtype;
  v_match public.case_source_match_decisions%rowtype;
  v_existing_run public.outcome_reconciliation_runs%rowtype;
  v_run public.outcome_reconciliation_runs%rowtype;
  v_projection public.case_outcome_projections%rowtype;
  v_current_record public.authoritative_source_records%rowtype;
  v_event public.outcome_verification_events%rowtype;
  v_result text := 'incomplete';
  v_reasons jsonb := '[]'::jsonb;
  v_required_field text;
  v_criterion record;
  v_current_accept_count integer := 0;
  v_required_satisfied boolean := true;
  v_positive_satisfied boolean := true;
  v_reversal_satisfied boolean := true;
  v_actor_type text;
  v_actor_user_id uuid;
  v_input_sha256 text;
begin
  perform private.civya_service_required();
  if coalesce(p_evaluator_release, '') = '' or coalesce(p_idempotency_key, '') = '' then
    raise exception 'evaluator release and idempotency key are required';
  end if;

  -- The same case row is locked by matching and reconciliation. This makes
  -- projection updates and predecessor selection serial for each case.
  select * into v_case from public.cases where id = p_case_id for update;
  select * into v_definition from public.outcome_definition_versions where id = p_outcome_definition_id;
  select * into v_record from public.authoritative_source_records where id = p_source_record_id;
  if v_case.id is null or v_definition.id is null or v_record.id is null
     or v_case.tenant_id <> v_definition.tenant_id or v_case.tenant_id <> v_record.tenant_id then
    raise exception 'case, definition, or source record not found' using errcode = 'P0002';
  end if;
  v_actor_type := case
    when p_actor_user_id is not null
      and private.civya_actor_is_staff(p_actor_user_id, v_case.tenant_id) then 'staff'
    else 'service'
  end;
  v_actor_user_id := case when v_actor_type = 'staff' then p_actor_user_id else null end;

  select r.* into v_existing_run from public.outcome_reconciliation_runs r
    where r.tenant_id = v_case.tenant_id and r.case_id = p_case_id
      and r.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_run.outcome_definition_id <> p_outcome_definition_id
       or v_existing_run.source_record_id <> p_source_record_id
       or v_existing_run.evaluator_release <> p_evaluator_release
       or v_existing_run.requested_by_type <> v_actor_type
       or v_existing_run.requested_by_auth_user_id is distinct from v_actor_user_id then
      raise exception 'reconciliation idempotency conflict' using errcode = '23505';
    end if;
    select * into v_projection from public.case_outcome_projections
      where case_id = p_case_id
        and pathway_key = v_definition.pathway_key
        and outcome_key = v_definition.outcome_key;
    return jsonb_build_object(
      'reconciliationRunId', v_existing_run.id,
      'result', v_existing_run.result,
      'resultAsOfRun', v_existing_run.result,
      'reasons', v_existing_run.reasons,
      'inputSha256', v_existing_run.input_sha256,
      'currentStatus', v_projection.current_status,
      'currentStatusAtReplay', v_projection.current_status,
      'controllingEventId', v_projection.controlling_event_id,
      'idempotentReplay', true
    );
  end if;

  select * into v_source from public.authoritative_source_systems where id = v_record.source_system_id;
  select * into v_batch from public.authoritative_source_batches where id = v_record.source_batch_id;
  if v_definition.status <> 'synthetic_test' then
    raise exception 'outcome definition is not active for synthetic testing' using errcode = '55000';
  end if;
  if v_definition.required_source_key <> v_source.source_key
     or v_definition.required_record_type <> v_record.record_type
     or v_definition.required_schema_version <> v_batch.schema_version
     or v_source.status <> 'synthetic' or not v_source.fictional
     or not (v_record.record_type = any(v_source.authority_scope))
     or v_batch.disposition <> 'accepted'
     or v_batch.authentication_state <> 'synthetic' then
    raise exception 'source record is outside the synthetic definition boundary' using errcode = '55000';
  end if;
  if v_record.effective_at < v_definition.effective_from
     or (v_definition.effective_to is not null and v_record.effective_at >= v_definition.effective_to) then
    raise exception 'outcome definition is not effective for the source record' using errcode = '55000';
  end if;

  select * into v_match from public.case_source_match_decisions m
    where m.case_id = p_case_id and m.source_record_id = p_source_record_id
      and not exists (
        select 1 from public.case_source_match_decisions newer
        where newer.supersedes_match_id = m.id
      )
    order by m.created_at desc limit 1;
  if not found or v_match.decision = 'rejected' then
    v_result := 'incomplete';
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code', 'accepted_match_required'));
  elsif v_match.decision = 'ambiguous' then
    v_result := 'ambiguous';
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code', 'ambiguous_match'));
  elsif coalesce(trim(v_case.parcel_id), '') = ''
     or upper(trim(v_case.parcel_id)) <> upper(trim(v_record.payload ->> 'parcel_id')) then
    v_result := 'ambiguous';
    v_reasons := v_reasons || jsonb_build_array(
      jsonb_build_object('code', 'case_identifier_changed_after_match')
    );
  else
    select count(*)::integer into v_current_accept_count
    from public.case_source_match_decisions m
    join public.authoritative_source_records r on r.id = m.source_record_id
    where m.case_id = p_case_id and r.source_system_id = v_source.id
      and m.decision = 'accepted'
      and not exists (
        select 1 from public.case_source_match_decisions newer
        where newer.supersedes_match_id = m.id
      );
    if v_current_accept_count > 1 then
      v_result := 'ambiguous';
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code', 'conflicting_current_matches'));
    end if;
  end if;

  select * into v_projection from public.case_outcome_projections
    where case_id = p_case_id
      and pathway_key = v_definition.pathway_key
      and outcome_key = v_definition.outcome_key;
  if found then
    select * into v_current_record from public.authoritative_source_records where id = v_projection.source_record_id;
    if v_record.effective_at < v_current_record.effective_at then
      v_result := 'ambiguous';
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code', 'stale_source_record'));
    elsif v_record.effective_at = v_current_record.effective_at
       and v_record.id <> v_current_record.id and v_record.payload_sha256 <> v_current_record.payload_sha256 then
      v_result := 'ambiguous';
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('code', 'conflicting_same_time_source'));
    end if;
  end if;

  if v_result <> 'ambiguous' then
    foreach v_required_field in array v_definition.required_fields loop
      if not (v_record.payload ? v_required_field)
         or coalesce(v_record.payload ->> v_required_field, '') = '' then
        v_required_satisfied := false;
        v_positive_satisfied := false;
        v_reversal_satisfied := false;
        v_reasons := v_reasons || jsonb_build_array(
          jsonb_build_object('code', 'missing_required_field', 'field', v_required_field)
        );
      end if;
    end loop;
    for v_criterion in select key, value from jsonb_each(v_definition.criteria) loop
      if not (v_record.payload ? v_criterion.key)
         or (v_record.payload -> v_criterion.key) is distinct from v_criterion.value then
        v_positive_satisfied := false;
        v_reasons := v_reasons || jsonb_build_array(
          jsonb_build_object('code', 'positive_criterion_not_satisfied', 'field', v_criterion.key)
        );
      end if;
    end loop;
    for v_criterion in select key, value from jsonb_each(v_definition.reversal_criteria) loop
      if not (v_record.payload ? v_criterion.key)
         or (v_record.payload -> v_criterion.key) is distinct from v_criterion.value then
        v_reversal_satisfied := false;
      end if;
    end loop;
    if v_match.decision = 'accepted' and v_current_accept_count = 1
       and v_required_satisfied and v_positive_satisfied then
      v_result := 'verified';
    elsif v_match.decision = 'accepted' and v_current_accept_count = 1
       and v_projection.current_status = 'verified'
       and v_definition.reversible and v_required_satisfied and v_reversal_satisfied
       and v_record.effective_at > v_current_record.effective_at then
      v_result := 'reversed';
      v_reasons := v_reasons || jsonb_build_array(
        jsonb_build_object('code', 'explicit_reversal_criteria_satisfied')
      );
    elsif v_result <> 'incomplete' then
      v_result := 'incomplete';
    end if;
  end if;

  -- The reconciliation input digest is calculated inside the trusted boundary
  -- from immutable identifiers and the exact match decision used by this run.
  v_input_sha256 := encode(sha256(convert_to(jsonb_build_object(
    'caseId', v_case.id,
    'caseRowVersion', v_case.row_version,
    'definitionId', v_definition.id,
    'definitionVersion', v_definition.version,
    'sourceRecordId', v_record.id,
    'sourceRecordSha256', v_record.payload_sha256,
    'matchDecisionId', v_match.id,
    'matchDecision', v_match.decision,
    'evaluatorRelease', p_evaluator_release
  )::text, 'UTF8')), 'hex');

  insert into public.outcome_reconciliation_runs (
    tenant_id, case_id, outcome_definition_id, source_record_id,
    evaluator_release, requested_by_type, requested_by_auth_user_id,
    result, reasons, input_sha256, idempotency_key
  ) values (
    v_case.tenant_id, p_case_id, p_outcome_definition_id, p_source_record_id,
    p_evaluator_release, v_actor_type, v_actor_user_id,
    v_result, v_reasons, v_input_sha256, p_idempotency_key
  ) returning * into v_run;

  if v_result in ('verified', 'reversed') then
    if v_projection.case_id is not null
       and v_projection.current_status = v_result
       and v_projection.source_record_id = p_source_record_id
       and v_projection.outcome_definition_id = p_outcome_definition_id then
      select * into v_event from public.outcome_verification_events
        where id = v_projection.controlling_event_id;
    else
      insert into public.outcome_verification_events (
        tenant_id, case_id, reconciliation_run_id, outcome_definition_id,
        source_record_id, event_type, actor_type, actor_auth_user_id,
        evidence, supersedes_event_id, idempotency_key
      ) values (
        v_case.tenant_id, p_case_id, v_run.id, p_outcome_definition_id,
        p_source_record_id, v_result, v_actor_type, v_actor_user_id,
        jsonb_build_object(
          'sourceKey', v_source.source_key,
          'sourceRecordSha256', v_record.payload_sha256,
          'definitionVersion', v_definition.version,
          'evaluatorRelease', p_evaluator_release,
          'reconciliationInputSha256', v_input_sha256,
          'reconciliationReasons', v_reasons,
          'evidenceScope', 'synthetic'
        ),
        v_projection.controlling_event_id,
        p_idempotency_key || ':event'
      ) returning * into v_event;

      insert into public.case_outcome_projections (
        case_id, tenant_id, pathway_key, outcome_key,
        current_status, evidence_scope, controlling_event_id,
        outcome_definition_id, source_record_id, verified_at, updated_at
      ) values (
        p_case_id, v_case.tenant_id, v_definition.pathway_key, v_definition.outcome_key,
        v_result, 'synthetic', v_event.id,
        p_outcome_definition_id, p_source_record_id,
        case when v_result = 'verified' then now() else null end, now()
      ) on conflict (case_id, pathway_key, outcome_key) do update set
        current_status = excluded.current_status,
        evidence_scope = excluded.evidence_scope,
        controlling_event_id = excluded.controlling_event_id,
        outcome_definition_id = excluded.outcome_definition_id,
        source_record_id = excluded.source_record_id,
        verified_at = excluded.verified_at,
        updated_at = now();
    end if;
  end if;

  select * into v_projection from public.case_outcome_projections
    where case_id = p_case_id
      and pathway_key = v_definition.pathway_key
      and outcome_key = v_definition.outcome_key;
  return jsonb_build_object(
    'reconciliationRunId', v_run.id,
    'result', v_result,
    'resultAsOfRun', v_result,
    'reasons', v_reasons,
    'inputSha256', v_input_sha256,
    'currentStatus', v_projection.current_status,
    'controllingEventId', v_projection.controlling_event_id,
    'evidenceScope', v_projection.evidence_scope,
    'idempotentReplay', false
  );
end;
$$;

create or replace function public.civya_service_export_outcome_evidence(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_purpose text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_case public.cases%rowtype;
  v_package jsonb;
  v_package_sha256 text;
begin
  perform private.civya_service_required();
  select * into v_case from public.cases where id = p_case_id;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not private.civya_actor_is_staff(p_actor_user_id, v_case.tenant_id, 'admin') then
    raise exception 'tenant administrator required for privileged evidence export'
      using errcode = '42501';
  end if;
  if coalesce(trim(p_purpose), '') = '' or coalesce(trim(p_request_id), '') = '' then
    raise exception 'export purpose and request identifier are required';
  end if;

  v_package := jsonb_build_object(
    'schemaVersion', 'civya-outcome-evidence-1.1',
    'generatedAt', now(),
    'evidenceScope', 'synthetic',
    'accessClass', 'synthetic_admin_privileged',
    'generatedByAuthUserId', p_actor_user_id,
    'requestId', p_request_id,
    'case', jsonb_build_object('caseId', v_case.id, 'tenantId', v_case.tenant_id),
    'currentProjections', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.pathway_key, p.outcome_key)
      from public.case_outcome_projections p where p.case_id = p_case_id
    ), '[]'::jsonb),
    'outcomeDefinitions', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.pathway_key, d.outcome_key, d.version)
      from public.outcome_definition_versions d
      where exists (
        select 1 from public.outcome_reconciliation_runs run
        where run.case_id = p_case_id and run.outcome_definition_id = d.id
      )
    ), '[]'::jsonb),
    'sourceSystems', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.source_key)
      from public.authoritative_source_systems s
      where exists (
        select 1
        from public.case_source_match_decisions m
        join public.authoritative_source_records r on r.id = m.source_record_id
        where m.case_id = p_case_id and r.source_system_id = s.id
      )
    ), '[]'::jsonb),
    'sourceBatches', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.source_generated_at, b.created_at)
      from public.authoritative_source_batches b
      where exists (
        select 1
        from public.case_source_match_decisions m
        join public.authoritative_source_records r on r.id = m.source_record_id
        where m.case_id = p_case_id and r.source_batch_id = b.id
      )
    ), '[]'::jsonb),
    'sourceRecords', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.effective_at, r.created_at)
      from public.authoritative_source_records r
      where exists (
        select 1 from public.case_source_match_decisions m
        where m.case_id = p_case_id and m.source_record_id = r.id
      )
    ), '[]'::jsonb),
    'matchDecisions', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.created_at)
      from public.case_source_match_decisions m where m.case_id = p_case_id
    ), '[]'::jsonb),
    'reconciliationRuns', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at)
      from public.outcome_reconciliation_runs r where r.case_id = p_case_id
    ), '[]'::jsonb),
    'verificationEvents', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at)
      from public.outcome_verification_events e where e.case_id = p_case_id
    ), '[]'::jsonb)
  );
  v_package_sha256 := encode(sha256(convert_to(v_package::text, 'UTF8')), 'hex');

  insert into public.audit_events (
    tenant_id, case_id, actor_user_id, event_type, redacted_payload, source, request_id
  ) values (
    v_case.tenant_id, v_case.id, p_actor_user_id, 'synthetic_outcome_evidence_exported',
    jsonb_build_object(
      'purpose', left(p_purpose, 200),
      'schemaVersion', 'civya-outcome-evidence-1.1',
      'packageSha256', v_package_sha256,
      'evidenceScope', 'synthetic'
    ),
    'admin', left(p_request_id, 200)
  );

  return v_package || jsonb_build_object(
    'packageIntegrity', jsonb_build_object(
      'algorithm', 'sha256',
      'sha256', v_package_sha256,
      'signatureState', 'unsigned_synthetic'
    )
  );
end;
$$;

revoke all on function public.civya_service_ingest_source_snapshot(
  uuid, text, text, text, text, text, timestamptz, text, text, timestamptz,
  jsonb, uuid, text
) from public, anon, authenticated;
revoke all on function public.civya_service_register_outcome_definition(
  uuid, uuid, text, text, text, text, text, text, text[], jsonb, jsonb,
  timestamptz, timestamptz, boolean, text
) from public, anon, authenticated;
revoke all on function public.civya_service_record_source_match(
  uuid, uuid, uuid, text, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.civya_service_reconcile_outcome(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.civya_service_export_outcome_evidence(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.civya_service_ingest_source_snapshot(
  uuid, text, text, text, text, text, timestamptz, text, text, timestamptz,
  jsonb, uuid, text
) to service_role;
grant execute on function public.civya_service_register_outcome_definition(
  uuid, uuid, text, text, text, text, text, text, text[], jsonb, jsonb,
  timestamptz, timestamptz, boolean, text
) to service_role;
grant execute on function public.civya_service_record_source_match(
  uuid, uuid, uuid, text, text, uuid, text
) to service_role;
grant execute on function public.civya_service_reconcile_outcome(
  uuid, uuid, uuid, uuid, text, text
) to service_role;
grant execute on function public.civya_service_export_outcome_evidence(uuid, uuid, text, text)
  to service_role;
