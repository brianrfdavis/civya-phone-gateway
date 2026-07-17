-- Forward hardening for governed workflow completion integrity and resident-input privacy.
--
-- Migration 018 introduced the repository boundary. This migration upgrades
-- already-retained schemas: terminal state now has explicit, disjoint outcome
-- semantics, provider evidence is bound to the signed event outcome, and a
-- later terminal state requires a distinct later observation.

-- Migration 018 permitted governed definitions that did not identify which
-- provider outcome proved each terminal state. Completion definitions are an
-- immutable governance ledger, so a forward migration must not rewrite or
-- retire those historical rows. Instead, classify them deterministically in
-- an immutable private quarantine ledger, surface every affected open instance
-- to operations, and make all start/action boundaries fail closed.
create or replace function private.civya_completion_outcome_schema_is_valid(
  p_terminal_states text[],
  p_evidence_required boolean,
  p_allowed_authority_types text[],
  p_evidence_schema jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  v_state text;
  v_values jsonb;
  v_requires_outcomes boolean;
begin
  if not p_evidence_required then
    return true;
  end if;

  v_requires_outcomes := cardinality(p_terminal_states) > 1
    or p_evidence_schema ? 'outcomeField'
    or p_evidence_schema ? 'terminalOutcomes'
    or 'provider_webhook' = any(p_allowed_authority_types);
  if not v_requires_outcomes then
    return true;
  end if;

  if jsonb_typeof(p_evidence_schema -> 'outcomeField') is distinct from 'string'
     or coalesce(p_evidence_schema ->> 'outcomeField', '')
       !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
     or jsonb_typeof(p_evidence_schema -> 'terminalOutcomes')
       is distinct from 'object' then
    return false;
  end if;

  foreach v_state in array p_terminal_states loop
    v_values := p_evidence_schema -> 'terminalOutcomes' -> v_state;
    if jsonb_typeof(v_values) is distinct from 'array'
       or jsonb_array_length(v_values) = 0
       or exists (
         select 1
         from jsonb_array_elements(v_values) item
         where jsonb_typeof(item) is distinct from 'string'
           or nullif(trim(item #>> '{}'), '') is null
       ) then
      return false;
    end if;
  end loop;

  if exists (
    select 1
    from unnest(p_terminal_states) left_state(state)
    cross join unnest(p_terminal_states) right_state(state)
    cross join lateral jsonb_array_elements_text(
      p_evidence_schema -> 'terminalOutcomes' -> left_state.state
    ) left_outcome(value)
    cross join lateral jsonb_array_elements_text(
      p_evidence_schema -> 'terminalOutcomes' -> right_state.state
    ) right_outcome(value)
    where left_state.state < right_state.state
      and left_outcome.value = right_outcome.value
  ) then
    return false;
  end if;

  if 'provider_webhook' = any(p_allowed_authority_types) then
    if jsonb_typeof(p_evidence_schema -> 'providerEventType')
         is distinct from 'string'
       or nullif(trim(p_evidence_schema ->> 'providerEventType'), '') is null
       or jsonb_typeof(p_evidence_schema -> 'requiredBindings')
         is distinct from 'array'
       or not (p_evidence_schema -> 'requiredBindings' @>
         '["workflowInstanceId","handoffSessionId"]'::jsonb) then
      return false;
    end if;
  end if;
  return true;
end;
$$;

revoke all on function private.civya_completion_outcome_schema_is_valid(
  text[], boolean, text[], jsonb
) from public, anon, authenticated, service_role;

create table private.workflow_completion_definition_quarantine (
  completion_definition_id uuid primary key
    references public.completion_definition_versions(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  completion_key text not null,
  definition_version text not null,
  original_status text not null,
  reason_code text not null
    check (reason_code in (
      'ambiguous_terminal_outcome_schema',
      'non_runnable_completion_status'
    )),
  definition_sha256 text not null check (definition_sha256 ~ '^[0-9a-f]{64}$'),
  affected_workflow_definition_ids uuid[] not null default '{}'::uuid[],
  affected_open_workflow_instance_ids uuid[] not null default '{}'::uuid[],
  quarantined_at timestamptz not null default now()
);

revoke all on private.workflow_completion_definition_quarantine
  from public, anon, authenticated, service_role;

insert into private.workflow_completion_definition_quarantine (
  completion_definition_id, tenant_id, completion_key, definition_version,
  original_status, reason_code, definition_sha256,
  affected_workflow_definition_ids, affected_open_workflow_instance_ids
)
select
  c.id,
  c.tenant_id,
  c.completion_key,
  c.version,
  c.status,
  case
    when not private.civya_completion_outcome_schema_is_valid(
      c.terminal_states,
      c.evidence_required,
      c.allowed_authority_types,
      c.evidence_schema
    ) then 'ambiguous_terminal_outcome_schema'
    else 'non_runnable_completion_status'
  end,
  encode(sha256(convert_to(jsonb_build_object(
    'completionDefinitionId', c.id,
    'terminalStates', c.terminal_states,
    'evidenceRequired', c.evidence_required,
    'authoritativeEvidenceRequired', c.authoritative_evidence_required,
    'allowedAuthorityTypes', c.allowed_authority_types,
    'minimumAssuranceScope', c.minimum_assurance_scope,
    'evidenceSchema', c.evidence_schema
  )::text, 'UTF8')), 'hex'),
  coalesce(array(
    select w.id
    from public.workflow_definition_versions w
    where w.completion_definition_id = c.id
    order by w.id
  ), '{}'::uuid[]),
  coalesce(array(
    select i.id
    from public.workflow_instances i
    where i.completion_definition_id = c.id
      and i.status in ('active', 'paused', 'escalated')
    order by i.id
  ), '{}'::uuid[])
from public.completion_definition_versions c
where (
    not private.civya_completion_outcome_schema_is_valid(
      c.terminal_states,
      c.evidence_required,
      c.allowed_authority_types,
      c.evidence_schema
    )
    and (
      c.status in ('active', 'synthetic_test')
      or exists (
        select 1
        from public.workflow_definition_versions w
        where w.completion_definition_id = c.id
          and w.status in ('active', 'synthetic_test')
      )
      or exists (
        select 1
        from public.workflow_instances i
        where i.completion_definition_id = c.id
          and i.status in ('active', 'paused', 'escalated')
      )
    )
  )
  or exists (
    select 1
    from public.workflow_definition_versions w
    where w.completion_definition_id = c.id
      and w.status in ('active', 'synthetic_test')
      and w.status <> c.status
  )
  or exists (
    select 1
    from public.workflow_instances i
    where i.completion_definition_id = c.id
      and i.status in ('active', 'paused', 'escalated')
      and c.status not in ('active', 'synthetic_test')
  );

create trigger workflow_completion_definition_quarantine_immutable
  before update or delete on private.workflow_completion_definition_quarantine
  for each row execute function private.civya_reject_immutable_outcome_mutation();

insert into public.audit_events (
  tenant_id, event_type, redacted_payload, source, request_id
)
select
  q.tenant_id,
  'workflow_completion_definition_quarantined',
  jsonb_build_object(
    'completionDefinitionId', q.completion_definition_id,
    'completionKey', q.completion_key,
    'definitionVersion', q.definition_version,
    'originalStatus', q.original_status,
    'reasonCode', q.reason_code,
    'definitionSha256', q.definition_sha256,
    'affectedWorkflowDefinitionCount',
      cardinality(q.affected_workflow_definition_ids),
    'affectedOpenWorkflowInstanceCount',
      cardinality(q.affected_open_workflow_instance_ids)
  ),
  'system',
  'migration-024:completion-definition:' || q.completion_definition_id::text
from private.workflow_completion_definition_quarantine q;

insert into public.audit_events (
  tenant_id, resident_id, case_id, event_type, redacted_payload, source,
  request_id
)
select
  i.tenant_id,
  i.resident_id,
  i.case_id,
  'workflow_instance_quarantined',
  jsonb_build_object(
    'workflowInstanceId', i.id,
    'completionDefinitionId', i.completion_definition_id,
    'originalStatus', i.status,
    'reasonCode', q.reason_code
  ),
  'system',
  'migration-024:workflow-instance:' || i.id::text
from public.workflow_instances i
join private.workflow_completion_definition_quarantine q
  on q.completion_definition_id = i.completion_definition_id
where i.status in ('active', 'paused', 'escalated');

insert into public.operational_exceptions (
  tenant_id, case_id, workflow_instance_id, exception_type, severity,
  status, reason_code, redacted_summary, correlation_id, dedupe_key
)
select
  i.tenant_id,
  i.case_id,
  i.id,
  'completion_definition_quarantine',
  'urgent',
  'open',
  q.reason_code,
  'This workflow was paused for governed completion-definition remediation.',
  'migration-024-quarantine-' || i.id::text,
  'migration024:completion-definition-quarantine:' || i.id::text
from public.workflow_instances i
join private.workflow_completion_definition_quarantine q
  on q.completion_definition_id = i.completion_definition_id
where i.status in ('active', 'paused', 'escalated')
on conflict (tenant_id, dedupe_key) do nothing;

update public.workflow_instances i
set status = 'escalated',
    row_version = i.row_version + 1,
    updated_at = now()
from private.workflow_completion_definition_quarantine q
where q.completion_definition_id = i.completion_definition_id
  and i.status in ('active', 'paused');

create or replace function private.civya_reject_quarantined_workflow_definition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_completion public.completion_definition_versions%rowtype;
begin
  if new.status in ('active', 'synthetic_test') then
    select * into v_completion
    from public.completion_definition_versions c
    where c.id = new.completion_definition_id
      and c.tenant_id = new.tenant_id;
    if not found
       or v_completion.status <> new.status
       or not private.civya_completion_outcome_schema_is_valid(
         v_completion.terminal_states,
         v_completion.evidence_required,
         v_completion.allowed_authority_types,
         v_completion.evidence_schema
       )
       or exists (
         select 1
         from private.workflow_completion_definition_quarantine q
         where q.completion_definition_id = new.completion_definition_id
       ) then
      raise exception 'runnable workflow requires a matching approved completion definition'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_reject_quarantined_workflow_definition()
  from public, anon, authenticated, service_role;

create trigger workflow_definition_completion_quarantine_guard
  before insert or update on public.workflow_definition_versions
  for each row execute function private.civya_reject_quarantined_workflow_definition();

create or replace function private.civya_reject_quarantined_workflow_instance()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if exists (
    select 1
    from private.workflow_completion_definition_quarantine q
    where q.completion_definition_id = new.completion_definition_id
  ) then
    if tg_op = 'INSERT'
       or new.workflow_definition_id is distinct from old.workflow_definition_id
       or new.completion_definition_id is distinct from old.completion_definition_id
       or new.current_state is distinct from old.current_state
       or new.status in ('active', 'paused', 'completed') then
      raise exception 'workflow completion definition is quarantined for remediation'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_reject_quarantined_workflow_instance()
  from public, anon, authenticated, service_role;

create trigger workflow_instances_completion_quarantine_guard
  before insert or update on public.workflow_instances
  for each row execute function private.civya_reject_quarantined_workflow_instance();

create or replace function private.civya_reject_quarantined_workflow_action()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if exists (
    select 1
    from public.workflow_instances i
    join private.workflow_completion_definition_quarantine q
      on q.completion_definition_id = i.completion_definition_id
    where i.id = new.workflow_instance_id
  ) then
    raise exception 'workflow completion definition is quarantined for remediation'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.civya_reject_quarantined_workflow_action()
  from public, anon, authenticated, service_role;

create trigger workflow_actions_completion_quarantine_guard
  before insert on public.workflow_actions
  for each row execute function private.civya_reject_quarantined_workflow_action();

-- Keep governed selection from returning a quarantined definition. Direct
-- starts are independently rejected by the workflow-instance guard above.
create or replace function public.civya_service_start_governed_workflow(
  p_actor_user_id uuid,
  p_actor_type text,
  p_case_id uuid,
  p_workflow_key text,
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
  v_tenant public.tenants%rowtype;
  v_definition public.workflow_definition_versions%rowtype;
  v_existing public.workflow_instances%rowtype;
begin
  perform private.civya_service_required();
  if p_actor_type not in ('resident', 'staff') or p_actor_user_id is null then
    raise exception 'an authenticated resident or staff actor is required'
      using errcode = '22023';
  end if;
  if p_workflow_key !~ '^[a-z0-9][a-z0-9._-]*$'
     or length(p_correlation_id) not between 8 and 180
     or length(p_idempotency_key) not between 8 and 180 then
    raise exception 'invalid workflow start context' using errcode = '22023';
  end if;

  select * into v_case from public.cases where id = p_case_id;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into strict v_tenant from public.tenants where id = v_case.tenant_id;

  if p_actor_type = 'resident'
     and not private.civya_actor_can_access_case(p_actor_user_id, v_case.id) then
    raise exception 'case entitlement required' using errcode = '42501';
  end if;
  if p_actor_type = 'staff'
     and not private.civya_actor_is_staff(p_actor_user_id, v_case.tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;

  select * into v_definition
  from public.workflow_definition_versions w
  where w.tenant_id = v_case.tenant_id
    and w.workflow_key = p_workflow_key
    and w.effective_from <= now()
    and (w.effective_to is null or w.effective_to > now())
    and not exists (
      select 1
      from private.workflow_completion_definition_quarantine q
      where q.completion_definition_id = w.completion_definition_id
    )
    and (
      (v_tenant.environment = 'sandbox' and v_tenant.fictional and w.status = 'synthetic_test')
      or (not (v_tenant.environment = 'sandbox' and v_tenant.fictional) and w.status = 'active')
    )
  order by w.effective_from desc
  limit 1;
  if not found then
    raise exception 'approved workflow definition not found' using errcode = 'P0002';
  end if;

  select * into v_existing from public.workflow_instances
  where tenant_id = v_case.tenant_id and idempotency_key = p_idempotency_key;
  if found and (
    v_existing.case_id <> p_case_id
    or v_existing.workflow_definition_id <> v_definition.id
    or v_existing.correlation_id <> p_correlation_id
    or v_existing.started_by_type <> p_actor_type
    or v_existing.started_by_auth_user_id is distinct from p_actor_user_id
    or v_existing.redacted_context is distinct from coalesce(p_redacted_context, '{}'::jsonb)
  ) then
    raise exception 'workflow start idempotency conflict' using errcode = '23505';
  end if;

  return public.civya_service_start_workflow(
    p_actor_user_id,
    p_actor_type,
    p_case_id,
    v_definition.id,
    p_correlation_id,
    coalesce(p_redacted_context, '{}'::jsonb),
    p_idempotency_key
  );
end;
$$;

-- Multi-outcome completion definitions must say exactly which redacted source
-- outcome proves each terminal state. Provider-backed definitions also bind
-- the event type and the workflow/handoff identifiers. Keeping this contract
-- in the immutable completion definition makes terminal meaning reviewable and
-- prevents a generic "provider event exists" assertion from completing a
-- workflow with the wrong business outcome.
create or replace function private.civya_validate_completion_outcome_schema()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_state text;
  v_values jsonb;
  v_requires_outcomes boolean;
begin
  -- Draft/retired rows cannot activate a workflow. Historical non-compliant
  -- immutable rows are handled by the private quarantine ledger above;
  -- every newly runnable status remains fail-closed.
  if not new.evidence_required or new.status in ('draft', 'retired') then
    return new;
  end if;

  v_requires_outcomes := cardinality(new.terminal_states) > 1
    or new.evidence_schema ? 'outcomeField'
    or new.evidence_schema ? 'terminalOutcomes'
    or 'provider_webhook' = any(new.allowed_authority_types);
  if not v_requires_outcomes then
    return new;
  end if;

  if jsonb_typeof(new.evidence_schema -> 'outcomeField') is distinct from 'string'
     or coalesce(new.evidence_schema ->> 'outcomeField', '') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
     or jsonb_typeof(new.evidence_schema -> 'terminalOutcomes') is distinct from 'object' then
    raise exception 'completion evidence schema requires an outcome field and terminal outcome map'
      using errcode = '23514';
  end if;

  foreach v_state in array new.terminal_states loop
    v_values := new.evidence_schema -> 'terminalOutcomes' -> v_state;
    if jsonb_typeof(v_values) is distinct from 'array'
       or jsonb_array_length(v_values) = 0
       or exists (
         select 1
         from jsonb_array_elements(v_values) item
         where jsonb_typeof(item) is distinct from 'string'
           or nullif(trim(item #>> '{}'), '') is null
       ) then
      raise exception 'completion evidence schema must map every terminal state to non-empty outcome values'
        using errcode = '23514';
    end if;
  end loop;

  if exists (
    select 1
    from unnest(new.terminal_states) left_state(state)
    cross join unnest(new.terminal_states) right_state(state)
    cross join lateral jsonb_array_elements_text(
      new.evidence_schema -> 'terminalOutcomes' -> left_state.state
    ) left_outcome(value)
    cross join lateral jsonb_array_elements_text(
      new.evidence_schema -> 'terminalOutcomes' -> right_state.state
    ) right_outcome(value)
    where left_state.state < right_state.state
      and left_outcome.value = right_outcome.value
  ) then
    raise exception 'terminal outcome values must be disjoint'
      using errcode = '23514';
  end if;

  if 'provider_webhook' = any(new.allowed_authority_types) then
    if jsonb_typeof(new.evidence_schema -> 'providerEventType') is distinct from 'string'
       or nullif(trim(new.evidence_schema ->> 'providerEventType'), '') is null
       or jsonb_typeof(new.evidence_schema -> 'requiredBindings') is distinct from 'array'
       or not (new.evidence_schema -> 'requiredBindings' @>
         '["workflowInstanceId","handoffSessionId"]'::jsonb) then
      raise exception 'provider completion schema requires event type and workflow/handoff bindings'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_completion_outcome_schema()
  from public, anon, authenticated, service_role;

drop trigger if exists completion_definition_outcome_schema_guard
  on public.completion_definition_versions;

create trigger completion_definition_outcome_schema_guard
  before insert or update on public.completion_definition_versions
  for each row execute function private.civya_validate_completion_outcome_schema();

create or replace function private.civya_validate_governed_completion_authority()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_instance public.workflow_instances%rowtype;
  v_completion public.completion_definition_versions%rowtype;
  v_provider private.provider_events%rowtype;
  v_outcome_field text;
begin
  select * into strict v_instance from public.workflow_instances
  where id = new.workflow_instance_id;

  if new.tenant_id <> v_instance.tenant_id
     or new.case_id <> v_instance.case_id
     or new.completion_definition_id <> v_instance.completion_definition_id then
    raise exception 'completion evidence is not bound to this workflow definition'
      using errcode = '23514';
  end if;
  select * into strict v_completion from public.completion_definition_versions
  where id = new.completion_definition_id;

  if new.authority_type = 'provider_webhook' then
    select p.* into v_provider
    from private.provider_events p
    where p.id = new.provider_event_id
      and p.tenant_id = new.tenant_id
      and p.signature_verified
      and p.state in ('processing', 'processed')
      and p.redacted_payload ->> 'workflowInstanceId' = new.workflow_instance_id::text
      and exists (
        select 1
        from public.hosted_handoff_sessions h
        where h.id = nullif(p.redacted_payload ->> 'handoffSessionId', '')::uuid
          and h.tenant_id = new.tenant_id
          and h.case_id = new.case_id
          and h.workflow_instance_id = new.workflow_instance_id
          and h.provider_key = p.provider_key
      );
    if not found then
      raise exception 'provider completion evidence is not bound to a signed workflow handoff event'
        using errcode = '55000';
    end if;

    if v_provider.event_type is distinct from
       v_completion.evidence_schema ->> 'providerEventType' then
      raise exception 'provider completion evidence event type does not match its completion definition'
        using errcode = '55000';
    end if;
    if jsonb_typeof(v_completion.evidence_schema -> 'requiredBindings') is distinct from 'array'
       or exists (
         select 1
         from jsonb_array_elements_text(
           v_completion.evidence_schema -> 'requiredBindings'
         ) binding(value)
         where not (v_provider.redacted_payload ? binding.value)
           or nullif(trim(v_provider.redacted_payload ->> binding.value), '') is null
       ) then
      raise exception 'provider completion evidence is missing a required event binding'
        using errcode = '55000';
    end if;

    v_outcome_field := nullif(trim(v_completion.evidence_schema ->> 'outcomeField'), '');
    if v_outcome_field is null
       or nullif(trim(v_provider.redacted_payload ->> v_outcome_field), '') is null
       or new.redacted_evidence ->> v_outcome_field is distinct from
          v_provider.redacted_payload ->> v_outcome_field then
      raise exception 'provider completion evidence outcome does not match the signed event'
        using errcode = '55000';
    end if;
  end if;

  if new.outcome_verification_event_id is not null and not exists (
    select 1 from public.outcome_verification_events o
    where o.id = new.outcome_verification_event_id
      and o.tenant_id = new.tenant_id
      and o.case_id = new.case_id
  ) then
    raise exception 'outcome verification evidence is not bound to this workflow case'
      using errcode = '23514';
  end if;
  return new;
exception
  when invalid_text_representation then
    raise exception 'provider completion evidence has an invalid handoff binding'
      using errcode = '55000';
end;
$$;

revoke all on function private.civya_validate_governed_completion_authority()
  from public, anon, authenticated, service_role;

drop trigger if exists workflow_completion_evidence_authority_guard
  on public.workflow_completion_evidence;

create trigger workflow_completion_evidence_authority_guard
  before insert on public.workflow_completion_evidence
  for each row execute function private.civya_validate_governed_completion_authority();

-- A signed provider event is a single immutable observation. Retained schemas
-- can already contain more than one append-only evidence row for that event,
-- including rows referenced by historical workflow actions. Never delete,
-- rewrite, or repoint that history merely to satisfy a new unique constraint.
-- This private immutable registry records the complete retained set, chooses a
-- deterministic canonical member, and rejects every future repackaging insert.
drop index if exists workflow_completion_evidence_provider_event_unique_idx;

create table private.workflow_completion_provider_event_registry (
  workflow_instance_id uuid not null
    references public.workflow_instances(id) on delete cascade,
  provider_event_id uuid not null
    references private.provider_events(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  canonical_evidence_id uuid not null
    references public.workflow_completion_evidence(id) on delete cascade,
  retained_evidence_ids uuid[] not null,
  referenced_evidence_ids uuid[] not null,
  evidence_count integer not null check (evidence_count > 0),
  referenced_evidence_count integer not null
    check (referenced_evidence_count >= 0
      and referenced_evidence_count <= evidence_count),
  evidence_set_sha256 text not null check (evidence_set_sha256 ~ '^[0-9a-f]{64}$'),
  registration_reason text not null
    check (registration_reason in ('retained_provider_evidence_set', 'new_provider_evidence')),
  registered_at timestamptz not null default now(),
  primary key (workflow_instance_id, provider_event_id),
  check (canonical_evidence_id = any(retained_evidence_ids)),
  check (cardinality(retained_evidence_ids) = evidence_count),
  check (cardinality(referenced_evidence_ids) = referenced_evidence_count)
);

revoke all on private.workflow_completion_provider_event_registry
  from public, anon, authenticated, service_role;

with ranked as (
  select
    e.tenant_id,
    e.workflow_instance_id,
    e.provider_event_id,
    e.id as evidence_id,
    e.observed_at,
    e.created_at,
    a.first_sequence,
    row_number() over (
      partition by e.workflow_instance_id, e.provider_event_id
      order by
        (a.first_sequence is null),
        a.first_sequence nulls last,
        e.observed_at,
        e.created_at,
        e.id
    ) as canonical_rank
  from public.workflow_completion_evidence e
  left join lateral (
    select min(wa.sequence_number) as first_sequence
    from public.workflow_actions wa
    where wa.completion_evidence_id = e.id
  ) a on true
  where e.provider_event_id is not null
), grouped as (
  select
    tenant_id,
    workflow_instance_id,
    provider_event_id,
    (array_agg(evidence_id order by canonical_rank))[1] as canonical_evidence_id,
    array_agg(evidence_id order by observed_at, created_at, evidence_id)
      as retained_evidence_ids,
    array_remove(array_agg(
      case when first_sequence is not null then evidence_id end
      order by first_sequence nulls last, observed_at, created_at, evidence_id
    ), null) as referenced_evidence_ids,
    count(*)::integer as evidence_count,
    count(first_sequence)::integer as referenced_evidence_count
  from ranked
  group by tenant_id, workflow_instance_id, provider_event_id
)
insert into private.workflow_completion_provider_event_registry (
  tenant_id, workflow_instance_id, provider_event_id, canonical_evidence_id,
  retained_evidence_ids, referenced_evidence_ids, evidence_count,
  referenced_evidence_count, evidence_set_sha256, registration_reason
)
select
  g.tenant_id,
  g.workflow_instance_id,
  g.provider_event_id,
  g.canonical_evidence_id,
  g.retained_evidence_ids,
  g.referenced_evidence_ids,
  g.evidence_count,
  g.referenced_evidence_count,
  encode(sha256(convert_to(jsonb_build_object(
    'workflowInstanceId', g.workflow_instance_id,
    'providerEventId', g.provider_event_id,
    'canonicalEvidenceId', g.canonical_evidence_id,
    'retainedEvidenceIds', g.retained_evidence_ids,
    'referencedEvidenceIds', g.referenced_evidence_ids
  )::text, 'UTF8')), 'hex'),
  'retained_provider_evidence_set'
from grouped g;

insert into public.audit_events (
  tenant_id, event_type, redacted_payload, source, request_id
)
select
  r.tenant_id,
  'workflow_provider_evidence_set_canonicalized',
  jsonb_build_object(
    'workflowInstanceId', r.workflow_instance_id,
    'providerEventId', r.provider_event_id,
    'canonicalEvidenceId', r.canonical_evidence_id,
    'evidenceCount', r.evidence_count,
    'referencedEvidenceCount', r.referenced_evidence_count,
    'evidenceSetSha256', r.evidence_set_sha256
  ),
  'system',
  'migration-024:provider-evidence:' || r.workflow_instance_id::text || ':'
    || r.provider_event_id::text
from private.workflow_completion_provider_event_registry r
where r.evidence_count > 1;

create trigger workflow_completion_provider_event_registry_immutable
  before update or delete on private.workflow_completion_provider_event_registry
  for each row execute function private.civya_reject_immutable_outcome_mutation();

create or replace function private.civya_register_provider_completion_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if new.provider_event_id is null then
    return new;
  end if;

  insert into private.workflow_completion_provider_event_registry (
    tenant_id, workflow_instance_id, provider_event_id,
    canonical_evidence_id, retained_evidence_ids, referenced_evidence_ids,
    evidence_count, referenced_evidence_count, evidence_set_sha256,
    registration_reason
  ) values (
    new.tenant_id,
    new.workflow_instance_id,
    new.provider_event_id,
    new.id,
    array[new.id]::uuid[],
    '{}'::uuid[],
    1,
    0,
    encode(sha256(convert_to(jsonb_build_object(
      'workflowInstanceId', new.workflow_instance_id,
      'providerEventId', new.provider_event_id,
      'canonicalEvidenceId', new.id,
      'retainedEvidenceIds', array[new.id]::uuid[],
      'referencedEvidenceIds', '{}'::uuid[]
    )::text, 'UTF8')), 'hex'),
    'new_provider_evidence'
  );
  return new;
end;
$$;

revoke all on function private.civya_register_provider_completion_evidence()
  from public, anon, authenticated, service_role;

create trigger workflow_completion_evidence_provider_event_registry_guard
  after insert on public.workflow_completion_evidence
  for each row execute function private.civya_register_provider_completion_evidence();

create or replace function private.civya_validate_terminal_completion_evidence(
  p_workflow_instance_id uuid,
  p_completion_definition_id uuid,
  p_completion_evidence_id uuid,
  p_to_state text,
  p_prior_completion_evidence_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_completion public.completion_definition_versions%rowtype;
  v_evidence public.workflow_completion_evidence%rowtype;
  v_prior public.workflow_completion_evidence%rowtype;
  v_provider private.provider_events%rowtype;
  v_prior_provider private.provider_events%rowtype;
  v_outcome_field text;
  v_outcome text;
  v_allowed_outcomes jsonb;
  v_requires_outcomes boolean;
  v_canonical_evidence_id uuid;
begin
  select * into strict v_completion from public.completion_definition_versions
  where id = p_completion_definition_id;
  if not (p_to_state = any(v_completion.terminal_states)) then
    raise exception 'completion evidence may be bound only to a terminal transition'
      using errcode = '22023';
  end if;

  if p_completion_evidence_id is null then
    if v_completion.evidence_required then
      raise exception 'terminal transition requires matching completion evidence'
        using errcode = '55000';
    end if;
    return;
  end if;

  select * into v_evidence from public.workflow_completion_evidence
  where id = p_completion_evidence_id
    and workflow_instance_id = p_workflow_instance_id
    and completion_definition_id = p_completion_definition_id;
  if not found then
    raise exception 'terminal transition requires matching completion evidence'
      using errcode = '55000';
  end if;
  if not (v_evidence.authority_type = any(v_completion.allowed_authority_types)) then
    raise exception 'completion evidence authority is not allowed by its definition'
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

  v_requires_outcomes := cardinality(v_completion.terminal_states) > 1
    or v_completion.evidence_schema ? 'outcomeField'
    or v_completion.evidence_schema ? 'terminalOutcomes'
    or v_evidence.authority_type = 'provider_webhook';
  if v_requires_outcomes then
    v_outcome_field := nullif(trim(v_completion.evidence_schema ->> 'outcomeField'), '');
    v_allowed_outcomes := v_completion.evidence_schema -> 'terminalOutcomes' -> p_to_state;
    v_outcome := nullif(trim(v_evidence.redacted_evidence ->> v_outcome_field), '');
    if v_outcome_field is null
       or jsonb_typeof(v_allowed_outcomes) is distinct from 'array'
       or v_outcome is null
       or not exists (
         select 1 from jsonb_array_elements_text(v_allowed_outcomes) allowed(value)
         where allowed.value = v_outcome
       ) then
      raise exception 'completion evidence outcome does not prove the requested terminal state'
        using errcode = '55000';
    end if;
  end if;

  if v_evidence.authority_type = 'provider_webhook' then
    select r.canonical_evidence_id into v_canonical_evidence_id
    from private.workflow_completion_provider_event_registry r
    where r.workflow_instance_id = v_evidence.workflow_instance_id
      and r.provider_event_id = v_evidence.provider_event_id;
    if not found or v_canonical_evidence_id <> v_evidence.id then
      raise exception 'terminal transition requires the canonical retained provider evidence'
        using errcode = '55000';
    end if;

    select * into v_provider from private.provider_events
    where id = v_evidence.provider_event_id
      and signature_verified
      and state in ('processing', 'processed');
    if not found
       or v_provider.event_type is distinct from
          v_completion.evidence_schema ->> 'providerEventType'
       or v_provider.redacted_payload ->> v_outcome_field is distinct from v_outcome then
      raise exception 'completion evidence is not backed by a matching signed provider outcome'
        using errcode = '55000';
    end if;
  end if;

  if p_prior_completion_evidence_id is not null then
    select * into v_prior from public.workflow_completion_evidence
    where id = p_prior_completion_evidence_id
      and workflow_instance_id = p_workflow_instance_id
      and completion_definition_id = p_completion_definition_id;
    if not found
       or v_prior.id = v_evidence.id
       or v_evidence.created_at <= v_prior.created_at
       or v_evidence.observed_at <= v_prior.observed_at then
      raise exception 'terminal-state change requires distinct later completion evidence'
        using errcode = '55000';
    end if;
    if v_prior.provider_event_id is not null and v_evidence.provider_event_id is not null then
      select * into strict v_prior_provider from private.provider_events
      where id = v_prior.provider_event_id;
      select * into strict v_provider from private.provider_events
      where id = v_evidence.provider_event_id;
      if v_evidence.provider_event_id = v_prior.provider_event_id
         or v_provider.received_at <= v_prior_provider.received_at then
        raise exception 'terminal-state change requires a later provider event'
          using errcode = '55000';
      end if;
    end if;
  end if;
end;
$$;

revoke all on function private.civya_validate_terminal_completion_evidence(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;

create or replace function private.civya_validate_workflow_completion_action()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_instance public.workflow_instances%rowtype;
  v_completion public.completion_definition_versions%rowtype;
  v_prior_evidence_id uuid;
begin
  select * into strict v_instance from public.workflow_instances
  where id = new.workflow_instance_id;
  select * into strict v_completion from public.completion_definition_versions
  where id = v_instance.completion_definition_id;

  if new.to_state = any(v_completion.terminal_states) then
    if new.from_state = any(v_completion.terminal_states) then
      select a.completion_evidence_id into v_prior_evidence_id
      from public.workflow_actions a
      where a.workflow_instance_id = new.workflow_instance_id
        and a.to_state = new.from_state
        and a.completion_evidence_id is not null
      order by a.sequence_number desc
      limit 1;
      if v_prior_evidence_id is null then
        raise exception 'terminal-state change requires prior completion evidence'
          using errcode = '55000';
      end if;
    end if;
    perform private.civya_validate_terminal_completion_evidence(
      new.workflow_instance_id,
      v_instance.completion_definition_id,
      new.completion_evidence_id,
      new.to_state,
      v_prior_evidence_id
    );
  elsif new.completion_evidence_id is not null then
    raise exception 'completion evidence may be bound only to a terminal transition'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_workflow_completion_action()
  from public, anon, authenticated, service_role;

drop trigger if exists workflow_actions_completion_outcome_guard
  on public.workflow_actions;

create trigger workflow_actions_completion_outcome_guard
  before insert on public.workflow_actions
  for each row execute function private.civya_validate_workflow_completion_action();

-- Resident-controlled workflow payloads are deliberately narrower than staff
-- or provider payloads. The server persists only its canonical, enum-valued
-- start context and no resident action metadata/free text.
create or replace function private.civya_validate_resident_workflow_context()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if new.started_by_type = 'resident'
     and (
       new.workflow_key <> 'payment_plan_navigation'
       or new.redacted_context is distinct from
         '{"channel":"web","purpose":"plan_navigation"}'::jsonb
     ) then
    raise exception 'resident workflow context must be server derived'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_resident_workflow_context()
  from public, anon, authenticated, service_role;

drop trigger if exists workflow_instances_resident_context_guard
  on public.workflow_instances;

create trigger workflow_instances_resident_context_guard
  before insert on public.workflow_instances
  for each row execute function private.civya_validate_resident_workflow_context();

create or replace function private.civya_validate_workflow_action_privacy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_expected_reason text;
begin
  if new.reason_code !~ '^[a-z0-9][a-z0-9._-]{0,119}$' then
    raise exception 'workflow reason must be a machine-readable code'
      using errcode = '22023';
  end if;

  if new.actor_type = 'resident' then
    if new.redacted_metadata <> '{}'::jsonb then
      raise exception 'resident workflow action metadata must be server derived'
        using errcode = '22023';
    end if;
    v_expected_reason := case
      when new.action_key = 'workflow.start' and new.from_state is null
        then 'workflow_started'
      when new.action_key = 'case.entitlement_confirmed' and new.to_state = 'entitled'
        then 'durable_case_entitlement'
      when new.action_key = 'handoff.requested' and new.to_state = 'handoff_created'
        then 'resident_requested_official_handoff'
      when new.action_key = 'handoff.open' and new.to_state = 'provider_open'
        then 'resident_opened_official_provider'
      else null
    end;
    if v_expected_reason is null or new.reason_code <> v_expected_reason then
      raise exception 'resident workflow action context is not an approved server mapping'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_workflow_action_privacy()
  from public, anon, authenticated, service_role;

drop trigger if exists workflow_actions_privacy_guard
  on public.workflow_actions;

create trigger workflow_actions_privacy_guard
  before insert on public.workflow_actions
  for each row execute function private.civya_validate_workflow_action_privacy();

comment on function private.civya_validate_terminal_completion_evidence(
  uuid, uuid, uuid, text, uuid
) is 'Binds terminal workflow state to versioned outcome semantics; terminal-to-terminal changes require distinct later source evidence.';
