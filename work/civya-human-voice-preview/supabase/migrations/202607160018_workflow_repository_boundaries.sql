-- Server workflow repository boundaries for the first governed vertical slice.
-- These wrappers keep definition selection and reads behind the same durable
-- resident entitlement / tenant staff checks as workflow mutations. Raising a
-- staff exception changes workflow state and creates its owned queue record in
-- one transaction.

create or replace function private.civya_validate_governed_completion_authority()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_instance public.workflow_instances%rowtype;
begin
  select * into strict v_instance from public.workflow_instances
  where id = new.workflow_instance_id;

  if new.authority_type = 'provider_webhook' and not exists (
    select 1
    from private.provider_events p
    join public.hosted_handoff_sessions h
      on h.id = nullif(p.redacted_payload ->> 'handoffSessionId', '')::uuid
    where p.id = new.provider_event_id
      and p.tenant_id = new.tenant_id
      and p.signature_verified
      and p.state in ('processing', 'processed')
      and p.redacted_payload ->> 'workflowInstanceId' = new.workflow_instance_id::text
      and h.tenant_id = new.tenant_id
      and h.case_id = new.case_id
      and h.workflow_instance_id = new.workflow_instance_id
      and h.provider_key = p.provider_key
  ) then
    raise exception 'provider completion evidence is not bound to a signed workflow handoff event'
      using errcode = '55000';
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

create trigger workflow_completion_evidence_authority_guard
  before insert on public.workflow_completion_evidence
  for each row execute function private.civya_validate_governed_completion_authority();


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

create or replace function public.civya_service_read_governed_workflow(
  p_actor_user_id uuid,
  p_actor_type text,
  p_workflow_instance_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_instance public.workflow_instances%rowtype;
  v_is_staff boolean := false;
  v_actions jsonb;
  v_handoffs jsonb;
  v_exception jsonb;
begin
  perform private.civya_service_required();
  if p_actor_type not in ('resident', 'staff') or p_actor_user_id is null then
    raise exception 'an authenticated resident or staff actor is required'
      using errcode = '22023';
  end if;
  select * into v_instance from public.workflow_instances
  where id = p_workflow_instance_id;
  if not found then raise exception 'workflow not found' using errcode = 'P0002'; end if;

  v_is_staff := private.civya_actor_is_staff(p_actor_user_id, v_instance.tenant_id);
  if p_actor_type = 'staff' and not v_is_staff then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  if p_actor_type = 'resident'
     and not private.civya_actor_can_access_case(p_actor_user_id, v_instance.case_id) then
    raise exception 'case entitlement required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'sequenceNumber', a.sequence_number,
    'actionKey', a.action_key,
    'fromState', a.from_state,
    'toState', a.to_state,
    'actorType', a.actor_type,
    'reasonCode', a.reason_code,
    'correlationId', a.correlation_id,
    'completionEvidenceId', a.completion_evidence_id,
    'createdAt', a.created_at
  ) order by a.sequence_number), '[]'::jsonb)
  into v_actions
  from public.workflow_actions a
  where a.workflow_instance_id = v_instance.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', h.id,
    'providerKey', h.provider_key,
    'destinationOrigin', h.destination_origin,
    'browserState', h.browser_state,
    'authoritativeState', h.authoritative_state,
    'rowVersion', h.row_version,
    'expiresAt', h.expires_at,
    'updatedAt', h.updated_at
  ) order by h.created_at), '[]'::jsonb)
  into v_handoffs
  from public.hosted_handoff_sessions h
  where h.workflow_instance_id = v_instance.id;

  if v_is_staff then
    select jsonb_build_object(
      'id', e.id,
      'type', e.exception_type,
      'severity', e.severity,
      'status', e.status,
      'reasonCode', e.reason_code,
      'redactedSummary', e.redacted_summary,
      'assignedToAuthUserId', e.assigned_to_auth_user_id,
      'rowVersion', e.row_version,
      'createdAt', e.created_at,
      'updatedAt', e.updated_at
    ) into v_exception
    from public.operational_exceptions e
    where e.workflow_instance_id = v_instance.id
      and e.status in ('open', 'owned', 'waiting_external')
    order by e.created_at desc
    limit 1;
  elsif v_instance.status = 'escalated' then
    v_exception := jsonb_build_object(
      'status', 'staff_review',
      'residentMessage', 'A Wayne County staff owner needs to review this step.'
    );
  end if;

  return jsonb_build_object(
    'id', v_instance.id,
    'tenantId', v_instance.tenant_id,
    'residentId', v_instance.resident_id,
    'caseId', v_instance.case_id,
    'workflowKey', v_instance.workflow_key,
    'definitionVersion', v_instance.definition_version,
    'state', v_instance.current_state,
    'status', v_instance.status,
    'rowVersion', v_instance.row_version,
    'correlationId', v_instance.correlation_id,
    'startedAt', v_instance.started_at,
    'updatedAt', v_instance.updated_at,
    'completedAt', v_instance.completed_at,
    'actions', v_actions,
    'handoffs', v_handoffs,
    'exception', v_exception
  );
end;
$$;

-- A verified active plan can later be authoritatively reversed. The original
-- 014 transition primitive correctly freezes ordinary completed workflows,
-- so this narrow path permits only the immutable definition's active->reversed
-- edge and requires a second, matching authoritative evidence record.
create or replace function private.civya_reverse_completed_workflow(
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
  v_input_sha text;
begin
  perform private.civya_service_required();
  if p_actor_type not in ('resident', 'staff', 'system', 'provider')
     or (p_actor_type in ('resident', 'staff')) <> (p_actor_user_id is not null) then
    raise exception 'workflow actor identity mismatch' using errcode = '22023';
  end if;
  select * into v_instance from public.workflow_instances
  where id = p_workflow_instance_id for update;
  if not found then raise exception 'workflow not found' using errcode = 'P0002'; end if;
  select * into strict v_definition from public.workflow_definition_versions
  where id = v_instance.workflow_definition_id;
  select * into strict v_completion from public.completion_definition_versions
  where id = v_instance.completion_definition_id;

  select * into v_existing from public.workflow_actions
  where tenant_id = v_instance.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.workflow_instance_id <> v_instance.id
       or v_existing.action_key <> p_action_key
       or v_existing.to_state <> p_to_state
       or v_existing.actor_type <> p_actor_type
       or v_existing.actor_auth_user_id is distinct from p_actor_user_id
       or v_existing.reason_code <> p_reason_code
       or v_existing.correlation_id <> p_correlation_id then
      raise exception 'workflow reversal idempotency conflict' using errcode = '23505';
    end if;
    v_input_sha := encode(sha256(convert_to(jsonb_build_object(
      'workflowInstanceId', v_instance.id,
      'rowVersion', v_existing.sequence_number - 1,
      'definitionSha256', v_definition.definition_sha256,
      'action', p_action_key,
      'from', v_existing.from_state,
      'to', p_to_state,
      'reason', p_reason_code,
      'metadata', coalesce(p_redacted_metadata, '{}'::jsonb),
      'completionEvidenceId', p_completion_evidence_id
    )::text, 'UTF8')), 'hex');
    if v_existing.input_sha256 <> v_input_sha then
      raise exception 'workflow reversal idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'workflowInstanceId', v_instance.id,
      'actionId', v_existing.id,
      'state', v_instance.current_state,
      'status', v_instance.status,
      'rowVersion', v_instance.row_version,
      'duplicate', true
    );
  end if;

  if v_instance.status <> 'completed'
     or v_instance.current_state <> 'active'
     or p_to_state <> 'reversed'
     or not (p_to_state = any(v_completion.terminal_states)) then
    raise exception 'only an authoritative active-plan reversal may reopen a completed workflow'
      using errcode = '55000';
  end if;
  if v_instance.row_version <> p_expected_row_version then
    raise exception 'stale workflow version' using errcode = '40001';
  end if;
  if p_actor_type = 'resident'
     and not private.civya_actor_can_access_case(p_actor_user_id, v_instance.case_id) then
    raise exception 'case entitlement required' using errcode = '42501';
  end if;
  if p_actor_type = 'staff'
     and not private.civya_actor_is_staff(p_actor_user_id, v_instance.tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_definition.transitions -> 'active', '[]'::jsonb)) edge
    where edge ->> 'action' = p_action_key
      and edge ->> 'to' = 'reversed'
      and exists (
        select 1 from jsonb_array_elements_text(coalesce(edge -> 'actors', '[]'::jsonb)) actor
        where actor = p_actor_type
      )
  ) then
    raise exception 'workflow actor is not authorized for the reversal'
      using errcode = '42501';
  end if;

  select * into v_evidence from public.workflow_completion_evidence
  where id = p_completion_evidence_id
    and workflow_instance_id = v_instance.id
    and completion_definition_id = v_completion.id;
  if not found or not v_evidence.authoritative then
    raise exception 'authoritative reversal evidence required' using errcode = '55000';
  end if;
  if not (
    case v_completion.minimum_assurance_scope
      when 'county_attested' then v_evidence.assurance_scope <> 'synthetic'
      when 'provider_attested' then v_evidence.assurance_scope = 'provider_attested'
      else true
    end
  ) then
    raise exception 'reversal evidence assurance is below the required level'
      using errcode = '55000';
  end if;

  v_input_sha := encode(sha256(convert_to(jsonb_build_object(
    'workflowInstanceId', v_instance.id,
    'rowVersion', v_instance.row_version,
    'definitionSha256', v_definition.definition_sha256,
    'action', p_action_key,
    'from', v_instance.current_state,
    'to', p_to_state,
    'reason', p_reason_code,
    'metadata', coalesce(p_redacted_metadata, '{}'::jsonb),
    'completionEvidenceId', p_completion_evidence_id
  )::text, 'UTF8')), 'hex');
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
  update public.workflow_instances
  set current_state = 'reversed',
      status = 'completed',
      row_version = row_version + 1,
      completed_at = now()
  where id = v_instance.id returning * into v_instance;
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source
  ) values (
    v_instance.tenant_id, v_instance.resident_id, v_instance.case_id,
    p_actor_user_id, 'workflow_reversed', jsonb_build_object(
      'workflowInstanceId', v_instance.id,
      'actionId', v_action.id,
      'fromState', 'active',
      'toState', 'reversed',
      'rowVersion', v_instance.row_version,
      'completionEvidenceId', p_completion_evidence_id,
      'correlationId', p_correlation_id
    ), case when p_actor_type = 'staff' then 'admin' else 'system' end
  );
  return jsonb_build_object(
    'workflowInstanceId', v_instance.id,
    'actionId', v_action.id,
    'state', v_instance.current_state,
    'status', v_instance.status,
    'rowVersion', v_instance.row_version,
    'duplicate', false
  );
end;
$$;

revoke all on function private.civya_reverse_completed_workflow(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.civya_service_advance_governed_workflow(
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
  v_existing public.workflow_actions%rowtype;
  v_edge_state text;
  v_result jsonb;
  v_resolved_count integer := 0;
  v_replay_input_sha text;
begin
  perform private.civya_service_required();
  if p_actor_type not in ('resident', 'staff', 'system', 'provider')
     or (p_actor_type in ('resident', 'staff')) <> (p_actor_user_id is not null) then
    raise exception 'workflow actor identity mismatch' using errcode = '22023';
  end if;
  select * into v_instance from public.workflow_instances
  where id = p_workflow_instance_id;
  if not found then raise exception 'workflow not found' using errcode = 'P0002'; end if;
  select * into strict v_definition from public.workflow_definition_versions
  where id = v_instance.workflow_definition_id;

  select * into v_existing from public.workflow_actions
  where tenant_id = v_instance.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.workflow_instance_id <> v_instance.id
       or v_existing.action_key <> p_action_key
       or v_existing.to_state <> p_to_state
       or v_existing.actor_type <> p_actor_type
       or v_existing.actor_auth_user_id is distinct from p_actor_user_id
       or v_existing.reason_code <> p_reason_code
       or v_existing.correlation_id <> p_correlation_id then
      raise exception 'workflow transition idempotency conflict' using errcode = '23505';
    end if;
    v_replay_input_sha := encode(sha256(convert_to(jsonb_build_object(
      'workflowInstanceId', v_instance.id,
      'rowVersion', v_existing.sequence_number - 1,
      'definitionSha256', v_definition.definition_sha256,
      'action', p_action_key,
      'from', v_existing.from_state,
      'to', p_to_state,
      'reason', p_reason_code,
      'metadata', coalesce(p_redacted_metadata, '{}'::jsonb),
      'completionEvidenceId', p_completion_evidence_id
    )::text, 'UTF8')), 'hex');
    if v_existing.input_sha256 <> v_replay_input_sha then
      raise exception 'workflow transition idempotency conflict' using errcode = '23505';
    end if;
    v_edge_state := v_existing.from_state;
  else
    v_edge_state := v_instance.current_state;
  end if;

  -- Actor permissions are part of the immutable, versioned transition edge.
  -- Missing actor metadata fails closed instead of inheriting broad service
  -- authority from the older transition primitive.
  if not exists (
    select 1
    from jsonb_array_elements(
      coalesce(v_definition.transitions -> v_edge_state, '[]'::jsonb)
    ) edge
    where edge ->> 'action' = p_action_key
      and edge ->> 'to' = p_to_state
      and exists (
        select 1 from jsonb_array_elements_text(coalesce(edge -> 'actors', '[]'::jsonb)) actor
        where actor = p_actor_type
      )
  ) then
    raise exception 'workflow actor is not authorized for this transition'
      using errcode = '42501';
  end if;

  if v_existing.id is null
     and v_instance.status = 'completed'
     and v_instance.current_state = 'active'
     and p_to_state = 'reversed' then
    v_result := private.civya_reverse_completed_workflow(
      p_actor_user_id,
      p_actor_type,
      p_workflow_instance_id,
      p_expected_row_version,
      p_action_key,
      p_to_state,
      p_reason_code,
      p_correlation_id,
      coalesce(p_redacted_metadata, '{}'::jsonb),
      p_completion_evidence_id,
      p_idempotency_key
    );
  else
    v_result := public.civya_service_transition_workflow(
      p_actor_user_id,
      p_actor_type,
      p_workflow_instance_id,
      p_expected_row_version,
      p_action_key,
      p_to_state,
      p_reason_code,
      p_correlation_id,
      coalesce(p_redacted_metadata, '{}'::jsonb),
      p_completion_evidence_id,
      p_idempotency_key
    );
  end if;

  if v_edge_state = 'staff_exception' and p_actor_type = 'staff' then
    update public.operational_exceptions
    set status = 'resolved',
        resolution_code = p_reason_code,
        redacted_resolution = left(coalesce(
          nullif(p_redacted_metadata ->> 'resolutionSummary', ''),
          'Staff completed the owned workflow exception step.'
        ), 500),
        resolved_at = now()
    where workflow_instance_id = v_instance.id
      and status in ('open', 'owned', 'waiting_external');
    get diagnostics v_resolved_count = row_count;
    if v_resolved_count = 0 and not exists (
      select 1 from public.operational_exceptions e
      where e.workflow_instance_id = v_instance.id
        and e.status in ('resolved', 'closed')
    ) then
      raise exception 'staff exception transition requires a durable exception record'
        using errcode = '55000';
    end if;
  end if;
  return v_result;
end;
$$;

create or replace function public.civya_service_raise_workflow_exception(
  p_actor_user_id uuid,
  p_actor_type text,
  p_workflow_instance_id uuid,
  p_expected_row_version bigint,
  p_action_key text,
  p_exception_type text,
  p_severity text,
  p_reason_code text,
  p_redacted_summary text,
  p_assigned_to_auth_user_id uuid,
  p_correlation_id text,
  p_dedupe_key text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_instance public.workflow_instances%rowtype;
  v_transition jsonb;
  v_exception public.operational_exceptions%rowtype;
  v_duplicate boolean := false;
  v_transition_duplicate boolean := false;
begin
  perform private.civya_service_required();
  if p_actor_type not in ('staff', 'system', 'provider')
     or (p_actor_type = 'staff') <> (p_actor_user_id is not null) then
    raise exception 'staff, system, or provider exception actor required'
      using errcode = '22023';
  end if;
  if p_action_key !~ '^[a-z0-9][a-z0-9._-]*$'
     or p_exception_type !~ '^[a-z0-9][a-z0-9._-]*$'
     or p_severity not in ('low', 'normal', 'high', 'urgent')
     or length(trim(p_reason_code)) not between 1 and 120
     or length(trim(p_redacted_summary)) not between 1 and 500
     or length(p_correlation_id) not between 8 and 180
     or length(p_dedupe_key) not between 8 and 180
     or length(p_idempotency_key) not between 8 and 180 then
    raise exception 'invalid workflow exception context' using errcode = '22023';
  end if;

  select * into v_instance from public.workflow_instances
  where id = p_workflow_instance_id for update;
  if not found then raise exception 'workflow not found' using errcode = 'P0002'; end if;
  if p_actor_type = 'staff'
     and not private.civya_actor_is_staff(p_actor_user_id, v_instance.tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  if p_assigned_to_auth_user_id is not null
     and not private.civya_actor_is_staff(p_assigned_to_auth_user_id, v_instance.tenant_id) then
    raise exception 'exception owner must be active tenant staff' using errcode = '42501';
  end if;

  v_transition := public.civya_service_advance_governed_workflow(
    p_actor_user_id,
    p_actor_type,
    v_instance.id,
    p_expected_row_version,
    p_action_key,
    'staff_exception',
    p_reason_code,
    p_correlation_id,
    jsonb_build_object('exceptionType', p_exception_type, 'severity', p_severity),
    null,
    p_idempotency_key
  );
  v_transition_duplicate := coalesce((v_transition ->> 'duplicate')::boolean, false);

  insert into public.operational_exceptions (
    tenant_id, case_id, workflow_instance_id, exception_type, severity,
    status, reason_code, redacted_summary, assigned_to_auth_user_id,
    correlation_id, dedupe_key
  ) values (
    v_instance.tenant_id, v_instance.case_id, v_instance.id,
    p_exception_type, p_severity,
    case when p_assigned_to_auth_user_id is null then 'open' else 'owned' end,
    p_reason_code, trim(p_redacted_summary), p_assigned_to_auth_user_id,
    p_correlation_id, p_dedupe_key
  ) on conflict (tenant_id, dedupe_key) do nothing returning * into v_exception;
  if not found then
    v_duplicate := true;
    select * into strict v_exception from public.operational_exceptions
    where tenant_id = v_instance.tenant_id and dedupe_key = p_dedupe_key;
    if v_exception.workflow_instance_id <> v_instance.id
       or v_exception.exception_type <> p_exception_type
       or v_exception.severity <> p_severity
       or v_exception.reason_code <> p_reason_code
       or v_exception.redacted_summary <> trim(p_redacted_summary)
       or v_exception.assigned_to_auth_user_id is distinct from p_assigned_to_auth_user_id
       or v_exception.correlation_id <> p_correlation_id then
      raise exception 'workflow exception idempotency conflict' using errcode = '23505';
    end if;
  end if;

  -- A true replay is observational. In particular, an old provider-failure
  -- delivery arriving after staff resolved and resumed the workflow must not
  -- re-escalate the current state or reopen the resolved exception.
  if v_duplicate and v_transition_duplicate then
    select * into strict v_instance from public.workflow_instances
    where id = p_workflow_instance_id;
    return jsonb_build_object(
      'workflowInstanceId', v_instance.id,
      'state', v_instance.current_state,
      'status', v_instance.status,
      'rowVersion', v_instance.row_version,
      'exceptionId', v_exception.id,
      'exceptionStatus', v_exception.status,
      'assignedToAuthUserId', v_exception.assigned_to_auth_user_id,
      'duplicate', true
    );
  end if;

  update public.workflow_instances
  set status = 'escalated'
  where id = v_instance.id and status = 'active'
  returning * into v_instance;
  if not found then
    select * into strict v_instance from public.workflow_instances
    where id = p_workflow_instance_id;
    if v_instance.status <> 'escalated' then
      raise exception 'workflow exception requires an open workflow' using errcode = '55000';
    end if;
  end if;

  if not (v_duplicate and v_transition_duplicate) then
    insert into public.audit_events (
      tenant_id, resident_id, case_id, actor_user_id,
      event_type, redacted_payload, source
    ) values (
      v_instance.tenant_id, v_instance.resident_id, v_instance.case_id,
      p_actor_user_id, 'workflow_exception_raised', jsonb_build_object(
        'workflowInstanceId', v_instance.id,
        'exceptionId', v_exception.id,
        'exceptionType', v_exception.exception_type,
        'severity', v_exception.severity,
        'status', v_exception.status,
        'correlationId', p_correlation_id
      ), case when p_actor_type = 'staff' then 'admin' else 'system' end
    );
  end if;

  return jsonb_build_object(
    'workflowInstanceId', v_instance.id,
    'state', v_instance.current_state,
    'status', v_instance.status,
    'rowVersion', v_instance.row_version,
    'exceptionId', v_exception.id,
    'exceptionStatus', v_exception.status,
    'assignedToAuthUserId', v_exception.assigned_to_auth_user_id,
    'duplicate', v_duplicate or v_transition_duplicate
  );
end;
$$;

revoke all on function public.civya_service_start_governed_workflow(
  uuid, text, uuid, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.civya_service_read_governed_workflow(
  uuid, text, uuid
) from public, anon, authenticated;
revoke all on function public.civya_service_advance_governed_workflow(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, uuid, text
) from public, anon, authenticated;
revoke all on function public.civya_service_raise_workflow_exception(
  uuid, text, uuid, bigint, text, text, text, text, text, uuid, text, text, text
) from public, anon, authenticated;

grant execute on function public.civya_service_start_governed_workflow(
  uuid, text, uuid, text, text, jsonb, text
) to service_role;
grant execute on function public.civya_service_read_governed_workflow(
  uuid, text, uuid
) to service_role;
grant execute on function public.civya_service_advance_governed_workflow(
  uuid, text, uuid, bigint, text, text, text, text, jsonb, uuid, text
) to service_role;
grant execute on function public.civya_service_raise_workflow_exception(
  uuid, text, uuid, bigint, text, text, text, text, text, uuid, text, text, text
) to service_role;

comment on function public.civya_service_read_governed_workflow(uuid, text, uuid) is
  'Authorization-aware redacted workflow read for resident and staff server APIs.';
comment on function public.civya_service_raise_workflow_exception(
  uuid, text, uuid, bigint, text, text, text, text, text, uuid, text, text, text
) is 'Atomically moves an open workflow to staff_exception and creates its durable owned operations record.';
