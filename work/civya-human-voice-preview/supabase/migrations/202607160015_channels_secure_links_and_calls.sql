-- Cross-channel session continuity, one-time secure links, provider-neutral
-- phone sessions, and reconciliation checkpoints. Phone records never include
-- phone numbers, raw audio, or raw transcripts; external identifiers and link
-- secrets are stored only as SHA-256 digests.

create table public.channel_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid references public.residents(id) on delete cascade,
  case_id uuid references public.cases(id) on delete cascade,
  workflow_instance_id uuid references public.workflow_instances(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  channel text not null check (channel in ('web', 'chat', 'voice', 'sms', 'email')),
  subject_state text not null
    check (subject_state in ('anonymous', 'account_authenticated', 'case_entitled', 'staff')),
  status text not null default 'created'
    check (status in ('created', 'active', 'awaiting_handoff', 'closed', 'failed')),
  provider_key text,
  external_session_reference_digest text
    check (external_session_reference_digest is null or external_session_reference_digest ~ '^[0-9a-f]{64}$'),
  redacted_resume_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(redacted_resume_context) = 'object'),
  correlation_id text not null,
  idempotency_key text not null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (tenant_id, idempotency_key),
  check ((case_id is null and resident_id is null) or (case_id is not null and resident_id is not null)),
  check ((status = 'closed' and closed_at is not null) or (status <> 'closed' and closed_at is null)),
  check (
    (subject_state = 'anonymous' and auth_user_id is null and case_id is null)
    or (subject_state = 'account_authenticated' and auth_user_id is not null and case_id is null)
    or (subject_state = 'case_entitled' and auth_user_id is not null and case_id is not null)
    or subject_state = 'staff'
  )
);

create index channel_sessions_resume_idx
  on public.channel_sessions (tenant_id, auth_user_id, status, last_active_at desc);
create index channel_sessions_case_idx
  on public.channel_sessions (case_id, status, last_active_at desc)
  where case_id is not null;

create table public.channel_session_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  sequence_number bigint not null check (sequence_number > 0),
  event_type text not null,
  actor_type text not null check (actor_type in ('resident', 'staff', 'system', 'provider')),
  actor_auth_user_id uuid references auth.users(id) on delete set null,
  correlation_id text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_payload) = 'object'),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (channel_session_id, sequence_number),
  unique (tenant_id, idempotency_key),
  check (
    (actor_type in ('resident', 'staff') and actor_auth_user_id is not null)
    or (actor_type in ('system', 'provider') and actor_auth_user_id is null)
  )
);

create table private.secure_link_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  case_id uuid references public.cases(id) on delete cascade,
  channel_session_id uuid references public.channel_sessions(id) on delete cascade,
  handoff_session_id uuid references public.hosted_handoff_sessions(id) on delete cascade,
  purpose text not null
    check (purpose in ('resume_case', 'hosted_handoff', 'document_upload', 'staff_callback', 'identity_proof')),
  token_digest text not null check (token_digest ~ '^[0-9a-f]{64}$'),
  audience_auth_user_id uuid references auth.users(id) on delete cascade,
  issued_by_type text not null check (issued_by_type in ('system', 'staff')),
  issued_by_auth_user_id uuid references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_auth_user_id uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revocation_reason text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, token_digest),
  unique (tenant_id, idempotency_key),
  check (expires_at > created_at),
  check (
    (issued_by_type = 'staff' and issued_by_auth_user_id is not null)
    or (issued_by_type = 'system' and issued_by_auth_user_id is null)
  ),
  check (consumed_at is null or revoked_at is null)
);

create index secure_link_tokens_lookup_idx
  on private.secure_link_tokens (tenant_id, token_digest, expires_at)
  where consumed_at is null and revoked_at is null;

create table public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid references public.residents(id) on delete cascade,
  case_id uuid references public.cases(id) on delete cascade,
  workflow_instance_id uuid references public.workflow_instances(id) on delete cascade,
  channel_session_id uuid references public.channel_sessions(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  provider_key text not null,
  provider_call_reference_digest text not null check (provider_call_reference_digest ~ '^[0-9a-f]{64}$'),
  participant_reference_digest text check (participant_reference_digest is null or participant_reference_digest ~ '^[0-9a-f]{64}$'),
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null default 'received'
    check (status in ('received', 'ringing', 'connected', 'transferring', 'transferred', 'completed', 'failed')),
  authority_mode text not null default 'conversational_only'
    check (authority_mode in ('conversational_only', 'deterministic_request', 'human_transfer')),
  transfer_destination_key text,
  correlation_id text not null,
  idempotency_key text not null,
  row_version bigint not null default 1,
  started_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider_key, provider_call_reference_digest),
  unique (tenant_id, idempotency_key),
  check ((case_id is null and resident_id is null) or (case_id is not null and resident_id is not null)),
  check (
    (status in ('completed', 'failed') and ended_at is not null)
    or (status not in ('completed', 'failed') and ended_at is null)
  )
);

create index call_sessions_operations_idx
  on public.call_sessions (tenant_id, status, updated_at desc);
create index call_sessions_case_idx
  on public.call_sessions (case_id, started_at desc) where case_id is not null;

create table public.call_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  call_session_id uuid not null references public.call_sessions(id) on delete cascade,
  sequence_number bigint not null check (sequence_number > 0),
  provider_event_id text,
  event_type text not null,
  authority_effect text not null
    check (authority_effect in ('conversation', 'deterministic_request', 'human_transfer', 'consequential_blocked')),
  actor_type text not null check (actor_type in ('system', 'provider', 'staff')),
  actor_auth_user_id uuid references auth.users(id) on delete set null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_metadata) = 'object'),
  correlation_id text not null,
  created_at timestamptz not null default now(),
  unique (call_session_id, sequence_number),
  unique (tenant_id, provider_event_id),
  check (
    (actor_type = 'staff' and actor_auth_user_id is not null)
    or (actor_type in ('system', 'provider') and actor_auth_user_id is null)
  )
);

create index call_events_timeline_idx
  on public.call_events (call_session_id, sequence_number);

create table public.provider_reconciliation_checkpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  provider_key text not null,
  stream_key text not null,
  cursor_digest text check (cursor_digest is null or cursor_digest ~ '^[0-9a-f]{64}$'),
  through_at timestamptz,
  status text not null default 'idle'
    check (status in ('idle', 'running', 'healthy', 'degraded', 'failed')),
  last_run_id uuid,
  records_examined bigint not null default 0 check (records_examined >= 0),
  discrepancies_found bigint not null default 0 check (discrepancies_found >= 0),
  last_error_code text,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  unique (tenant_id, provider_key, stream_key)
);

create table public.reconciliation_checkpoint_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  checkpoint_id uuid not null references public.provider_reconciliation_checkpoints(id) on delete restrict,
  run_id uuid not null,
  result text not null check (result in ('started', 'succeeded', 'degraded', 'failed')),
  cursor_digest text check (cursor_digest is null or cursor_digest ~ '^[0-9a-f]{64}$'),
  through_at timestamptz,
  records_examined bigint not null default 0 check (records_examined >= 0),
  discrepancies_found bigint not null default 0 check (discrepancies_found >= 0),
  error_code text,
  summary_sha256 text not null check (summary_sha256 ~ '^[0-9a-f]{64}$'),
  redacted_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(redacted_summary) = 'object'),
  created_at timestamptz not null default now(),
  unique (checkpoint_id, run_id, result)
);

create trigger set_updated_at before update on public.channel_sessions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.call_sessions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.provider_reconciliation_checkpoints
  for each row execute function private.set_updated_at();

alter table private.secure_link_tokens enable row level security;
revoke all on private.secure_link_tokens from public, anon, authenticated, service_role;

-- Cross-record checks keep sessions tenant scoped and prevent an account-only
-- channel from being relabeled as case-entitled without a current grant.
create or replace function private.civya_validate_channel_and_call_chain()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_table_name = 'channel_sessions' then
    if new.case_id is not null and not exists (
      select 1 from public.cases c
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and c.resident_id = new.resident_id
    ) then
      raise exception 'channel session case/resident mismatch' using errcode = '23514';
    end if;
    if new.workflow_instance_id is not null and not exists (
      select 1 from public.workflow_instances i
      where i.id = new.workflow_instance_id and i.tenant_id = new.tenant_id
        and (new.case_id is null or i.case_id = new.case_id)
    ) then
      raise exception 'channel session workflow mismatch' using errcode = '23514';
    end if;
    if new.subject_state = 'case_entitled'
       and not private.civya_active_case_entitlement(new.auth_user_id, new.case_id, 'case.read')
       and not private.civya_actor_is_staff(new.auth_user_id, new.tenant_id) then
      raise exception 'account authentication alone is not case entitlement'
        using errcode = '42501';
    end if;
  elsif tg_table_name = 'channel_session_events' then
    if not exists (
      select 1 from public.channel_sessions s
      where s.id = new.channel_session_id and s.tenant_id = new.tenant_id
    ) then
      raise exception 'channel event session mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'call_sessions' then
    if new.case_id is not null and not exists (
      select 1 from public.cases c
      where c.id = new.case_id and c.tenant_id = new.tenant_id
        and c.resident_id = new.resident_id
    ) then
      raise exception 'call session case/resident mismatch' using errcode = '23514';
    end if;
    if new.channel_session_id is not null and not exists (
      select 1 from public.channel_sessions s
      where s.id = new.channel_session_id and s.tenant_id = new.tenant_id
        and (new.case_id is null or s.case_id = new.case_id)
    ) then
      raise exception 'call/channel session mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'call_events' then
    if not exists (
      select 1 from public.call_sessions c
      where c.id = new.call_session_id and c.tenant_id = new.tenant_id
    ) then
      raise exception 'call event session mismatch' using errcode = '23514';
    end if;
  elsif tg_table_name = 'reconciliation_checkpoint_events' then
    if not exists (
      select 1 from public.provider_reconciliation_checkpoints c
      where c.id = new.checkpoint_id and c.tenant_id = new.tenant_id
    ) then
      raise exception 'reconciliation event checkpoint mismatch' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.civya_validate_channel_and_call_chain()
  from public, anon, authenticated, service_role;

create trigger channel_sessions_chain_guard
  before insert or update on public.channel_sessions
  for each row execute function private.civya_validate_channel_and_call_chain();
create trigger channel_session_events_chain_guard
  before insert on public.channel_session_events
  for each row execute function private.civya_validate_channel_and_call_chain();
create trigger call_sessions_chain_guard
  before insert or update on public.call_sessions
  for each row execute function private.civya_validate_channel_and_call_chain();
create trigger call_events_chain_guard
  before insert on public.call_events
  for each row execute function private.civya_validate_channel_and_call_chain();
create trigger reconciliation_checkpoint_events_chain_guard
  before insert on public.reconciliation_checkpoint_events
  for each row execute function private.civya_validate_channel_and_call_chain();

create trigger channel_session_events_immutable
  before update or delete on public.channel_session_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger call_events_immutable
  before update or delete on public.call_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();
create trigger reconciliation_checkpoint_events_immutable
  before update or delete on public.reconciliation_checkpoint_events
  for each row execute function private.civya_reject_immutable_outcome_mutation();

-- ---------------------------------------------------------------------------
-- Service-only atomic channel and secure-link controls.
-- ---------------------------------------------------------------------------

create or replace function public.civya_service_create_channel_session(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_case_id uuid,
  p_workflow_instance_id uuid,
  p_channel text,
  p_provider_key text,
  p_external_session_reference_digest text,
  p_correlation_id text,
  p_redacted_resume_context jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_case public.cases%rowtype;
  v_session public.channel_sessions%rowtype;
  v_subject_state text;
  v_actor_type text;
  v_payload_sha text;
  v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  if p_actor_user_id is not null and not exists (select 1 from auth.users where id = p_actor_user_id) then
    raise exception 'actor account not found' using errcode = 'P0002';
  end if;
  if p_case_id is not null then
    select * into v_case from public.cases where id = p_case_id and tenant_id = p_tenant_id;
    if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
    if p_actor_user_id is null
       or not private.civya_actor_can_access_case(p_actor_user_id, p_case_id) then
      raise exception 'case entitlement required' using errcode = '42501';
    end if;
  end if;
  if p_workflow_instance_id is not null and not exists (
    select 1 from public.workflow_instances i
    where i.id = p_workflow_instance_id and i.tenant_id = p_tenant_id
      and (p_case_id is null or i.case_id = p_case_id)
  ) then
    raise exception 'workflow instance not found' using errcode = 'P0002';
  end if;
  v_subject_state := case
    when p_case_id is not null and private.civya_actor_is_staff(p_actor_user_id, p_tenant_id) then 'staff'
    when p_case_id is not null then 'case_entitled'
    when p_actor_user_id is not null then 'account_authenticated'
    else 'anonymous'
  end;
  v_actor_type := case
    when v_subject_state = 'staff' then 'staff'
    when p_actor_user_id is not null then 'resident'
    else 'system'
  end;
  insert into public.channel_sessions (
    tenant_id, resident_id, case_id, workflow_instance_id, auth_user_id,
    channel, subject_state, provider_key, external_session_reference_digest,
    redacted_resume_context, correlation_id, idempotency_key
  ) values (
    p_tenant_id, v_case.resident_id, p_case_id, p_workflow_instance_id,
    p_actor_user_id, p_channel, v_subject_state, nullif(p_provider_key, ''),
    p_external_session_reference_digest,
    coalesce(p_redacted_resume_context, '{}'::jsonb), p_correlation_id,
    p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_session;
  if not found then
    v_duplicate := true;
    select * into strict v_session from public.channel_sessions
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if v_session.channel <> p_channel
       or v_session.case_id is distinct from p_case_id
       or v_session.auth_user_id is distinct from p_actor_user_id then
      raise exception 'channel session idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('channelSessionId', v_session.id,
      'subjectState', v_session.subject_state, 'status', v_session.status,
      'rowVersion', v_session.row_version, 'duplicate', true);
  end if;
  v_payload_sha := encode(sha256(convert_to(jsonb_build_object(
    'channel', p_channel, 'subjectState', v_subject_state,
    'caseId', p_case_id, 'workflowInstanceId', p_workflow_instance_id,
    'context', p_redacted_resume_context
  )::text, 'UTF8')), 'hex');
  insert into public.channel_session_events (
    tenant_id, channel_session_id, sequence_number, event_type,
    actor_type, actor_auth_user_id, correlation_id, payload_sha256,
    redacted_payload, idempotency_key
  ) values (
    p_tenant_id, v_session.id, 1, 'session.created', v_actor_type,
    case when v_actor_type in ('resident', 'staff') then p_actor_user_id else null end,
    p_correlation_id, v_payload_sha, '{}'::jsonb, p_idempotency_key || ':event'
  );
  return jsonb_build_object('channelSessionId', v_session.id,
    'subjectState', v_session.subject_state, 'status', v_session.status,
    'rowVersion', v_session.row_version, 'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_control_channel_session(
  p_actor_user_id uuid,
  p_channel_session_id uuid,
  p_expected_row_version bigint,
  p_next_status text,
  p_event_type text,
  p_payload_sha256 text,
  p_redacted_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_session public.channel_sessions%rowtype;
  v_event public.channel_session_events%rowtype;
  v_actor_type text;
begin
  perform private.civya_service_required();
  select * into v_session from public.channel_sessions
  where id = p_channel_session_id for update;
  if not found then raise exception 'channel session not found' using errcode = 'P0002'; end if;
  select * into v_event from public.channel_session_events
  where tenant_id = v_session.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('channelSessionId', v_session.id,
      'status', v_session.status, 'rowVersion', v_session.row_version,
      'eventId', v_event.id, 'duplicate', true);
  end if;
  if v_session.row_version <> p_expected_row_version then
    raise exception 'stale channel session version' using errcode = '40001';
  end if;
  if p_actor_user_id is not null and v_session.case_id is not null
     and not private.civya_actor_can_access_case(p_actor_user_id, v_session.case_id) then
    raise exception 'case entitlement required' using errcode = '42501';
  end if;
  if not (
    (v_session.status = 'created' and p_next_status in ('active', 'closed', 'failed'))
    or (v_session.status = 'active' and p_next_status in ('awaiting_handoff', 'closed', 'failed'))
    or (v_session.status = 'awaiting_handoff' and p_next_status in ('active', 'closed', 'failed'))
    or (v_session.status = 'failed' and p_next_status = 'active')
  ) then
    raise exception 'invalid channel session transition' using errcode = '55000';
  end if;
  v_actor_type := case
    when p_actor_user_id is null then 'system'
    when private.civya_actor_is_staff(p_actor_user_id, v_session.tenant_id) then 'staff'
    else 'resident'
  end;
  insert into public.channel_session_events (
    tenant_id, channel_session_id, sequence_number, event_type, actor_type,
    actor_auth_user_id, correlation_id, payload_sha256, redacted_payload,
    idempotency_key
  ) values (
    v_session.tenant_id, v_session.id, v_session.row_version + 1,
    p_event_type, v_actor_type,
    case when v_actor_type in ('resident', 'staff') then p_actor_user_id else null end,
    v_session.correlation_id, p_payload_sha256,
    coalesce(p_redacted_payload, '{}'::jsonb), p_idempotency_key
  ) returning * into v_event;
  update public.channel_sessions set status = p_next_status,
    row_version = row_version + 1, last_active_at = now(),
    closed_at = case when p_next_status = 'closed' then now() else null end
  where id = v_session.id returning * into v_session;
  return jsonb_build_object('channelSessionId', v_session.id,
    'status', v_session.status, 'rowVersion', v_session.row_version,
    'eventId', v_event.id, 'duplicate', false);
end;
$$;

create or replace function public.civya_service_create_secure_link(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_case_id uuid,
  p_channel_session_id uuid,
  p_handoff_session_id uuid,
  p_purpose text,
  p_token_digest text,
  p_audience_auth_user_id uuid,
  p_expires_at timestamptz,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_link private.secure_link_tokens%rowtype; v_issuer_type text;
begin
  perform private.civya_service_required();
  if p_case_id is not null and p_actor_user_id is not null
     and not private.civya_actor_can_access_case(p_actor_user_id, p_case_id) then
    raise exception 'case access required' using errcode = '42501';
  end if;
  if p_actor_user_id is not null
     and not private.civya_actor_is_staff(p_actor_user_id, p_tenant_id) then
    raise exception 'tenant staff required to issue a secure link' using errcode = '42501';
  end if;
  if p_expires_at <= now() + interval '1 minute'
     or p_expires_at > now() + interval '24 hours' then
    raise exception 'secure link lifetime must be between one minute and 24 hours'
      using errcode = '22023';
  end if;
  if p_case_id is not null and not exists (
    select 1 from public.cases where id = p_case_id and tenant_id = p_tenant_id
  ) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_channel_session_id is not null and not exists (
    select 1 from public.channel_sessions
    where id = p_channel_session_id and tenant_id = p_tenant_id
      and (p_case_id is null or case_id = p_case_id)
  ) then raise exception 'channel session not found' using errcode = 'P0002'; end if;
  if p_handoff_session_id is not null and not exists (
    select 1 from public.hosted_handoff_sessions
    where id = p_handoff_session_id and tenant_id = p_tenant_id
      and (p_case_id is null or case_id = p_case_id)
  ) then raise exception 'handoff session not found' using errcode = 'P0002'; end if;
  v_issuer_type := case when p_actor_user_id is null then 'system' else 'staff' end;
  insert into private.secure_link_tokens (
    tenant_id, case_id, channel_session_id, handoff_session_id, purpose,
    token_digest, audience_auth_user_id, issued_by_type,
    issued_by_auth_user_id, expires_at, idempotency_key
  ) values (
    p_tenant_id, p_case_id, p_channel_session_id, p_handoff_session_id,
    p_purpose, p_token_digest, p_audience_auth_user_id, v_issuer_type,
    p_actor_user_id, p_expires_at, p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_link;
  if not found then
    select * into strict v_link from private.secure_link_tokens
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if v_link.token_digest <> p_token_digest or v_link.purpose <> p_purpose then
      raise exception 'secure link idempotency conflict' using errcode = '23505';
    end if;
  end if;
  insert into public.audit_events (tenant_id, case_id, actor_user_id,
    event_type, redacted_payload, source)
  values (p_tenant_id, p_case_id, p_actor_user_id, 'secure_link_issued',
    jsonb_build_object('secureLinkId', v_link.id, 'purpose', v_link.purpose,
      'expiresAt', v_link.expires_at),
    case when p_actor_user_id is null then 'system' else 'admin' end);
  return jsonb_build_object('secureLinkId', v_link.id, 'purpose', v_link.purpose,
    'expiresAt', v_link.expires_at);
end;
$$;

create or replace function public.civya_service_consume_secure_link(
  p_tenant_id uuid,
  p_token_digest text,
  p_purpose text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_link private.secure_link_tokens%rowtype;
begin
  perform private.civya_service_required();
  select * into v_link from private.secure_link_tokens
  where tenant_id = p_tenant_id and token_digest = p_token_digest
  for update;
  if not found then
    return jsonb_build_object('consumed', false, 'reason', 'invalid');
  end if;
  if v_link.purpose <> p_purpose then
    return jsonb_build_object('consumed', false, 'reason', 'purpose_mismatch');
  end if;
  if v_link.revoked_at is not null then
    return jsonb_build_object('consumed', false, 'reason', 'revoked');
  end if;
  if v_link.consumed_at is not null then
    return jsonb_build_object('consumed', false, 'reason', 'already_consumed');
  end if;
  if v_link.expires_at <= now() then
    return jsonb_build_object('consumed', false, 'reason', 'expired');
  end if;
  if v_link.audience_auth_user_id is not null
     and v_link.audience_auth_user_id is distinct from p_actor_user_id then
    return jsonb_build_object('consumed', false, 'reason', 'audience_mismatch');
  end if;
  update private.secure_link_tokens set consumed_at = now(),
    consumed_by_auth_user_id = p_actor_user_id
  where id = v_link.id and consumed_at is null and revoked_at is null
  returning * into v_link;
  if not found then
    return jsonb_build_object('consumed', false, 'reason', 'concurrent_consumption');
  end if;
  insert into public.audit_events (tenant_id, case_id, actor_user_id,
    event_type, redacted_payload, source)
  values (v_link.tenant_id, v_link.case_id, p_actor_user_id, 'secure_link_consumed',
    jsonb_build_object('secureLinkId', v_link.id, 'purpose', v_link.purpose), 'system');
  return jsonb_build_object('consumed', true, 'secureLinkId', v_link.id,
    'purpose', v_link.purpose, 'caseId', v_link.case_id,
    'channelSessionId', v_link.channel_session_id,
    'handoffSessionId', v_link.handoff_session_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-only atomic call and reconciliation controls.
-- ---------------------------------------------------------------------------

create or replace function public.civya_service_create_call_session(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_case_id uuid,
  p_workflow_instance_id uuid,
  p_channel_session_id uuid,
  p_provider_key text,
  p_provider_call_reference_digest text,
  p_participant_reference_digest text,
  p_direction text,
  p_correlation_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_case public.cases%rowtype; v_call public.call_sessions%rowtype; v_duplicate boolean := false;
begin
  perform private.civya_service_required();
  if p_case_id is not null then
    select * into v_case from public.cases where id = p_case_id and tenant_id = p_tenant_id;
    if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
    if p_actor_user_id is null
       or not private.civya_actor_can_access_case(p_actor_user_id, p_case_id) then
      raise exception 'case entitlement required to bind a call to a case' using errcode = '42501';
    end if;
  end if;
  insert into public.call_sessions (
    tenant_id, resident_id, case_id, workflow_instance_id, channel_session_id,
    auth_user_id, provider_key, provider_call_reference_digest,
    participant_reference_digest, direction, correlation_id, idempotency_key
  ) values (
    p_tenant_id, v_case.resident_id, p_case_id, p_workflow_instance_id,
    p_channel_session_id, p_actor_user_id, p_provider_key,
    p_provider_call_reference_digest, p_participant_reference_digest,
    p_direction, p_correlation_id, p_idempotency_key
  ) on conflict (tenant_id, idempotency_key) do nothing returning * into v_call;
  if not found then
    v_duplicate := true;
    select * into strict v_call from public.call_sessions
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if v_call.provider_call_reference_digest <> p_provider_call_reference_digest
       or v_call.direction <> p_direction then
      raise exception 'call session idempotency conflict' using errcode = '23505';
    end if;
  else
    insert into public.call_events (
      tenant_id, call_session_id, sequence_number, event_type,
      authority_effect, actor_type, payload_sha256, redacted_metadata,
      correlation_id
    ) values (
      p_tenant_id, v_call.id, 1, 'call.received', 'conversation', 'system',
      encode(sha256(convert_to(jsonb_build_object('direction', p_direction,
        'providerKey', p_provider_key)::text, 'UTF8')), 'hex'),
      '{}'::jsonb, p_correlation_id
    );
  end if;
  return jsonb_build_object('callSessionId', v_call.id, 'status', v_call.status,
    'authorityMode', v_call.authority_mode, 'rowVersion', v_call.row_version,
    'duplicate', v_duplicate);
end;
$$;

create or replace function public.civya_service_control_call(
  p_call_session_id uuid,
  p_expected_row_version bigint,
  p_next_status text,
  p_authority_mode text,
  p_transfer_destination_key text,
  p_event_type text,
  p_provider_event_id text,
  p_authority_effect text,
  p_actor_type text,
  p_actor_user_id uuid,
  p_payload_sha256 text,
  p_redacted_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_call public.call_sessions%rowtype; v_event public.call_events%rowtype;
begin
  perform private.civya_service_required();
  select * into v_call from public.call_sessions where id = p_call_session_id for update;
  if not found then raise exception 'call session not found' using errcode = 'P0002'; end if;
  if p_provider_event_id is not null then
    select * into v_event from public.call_events
    where tenant_id = v_call.tenant_id and provider_event_id = p_provider_event_id;
    if found then
      if v_event.call_session_id <> v_call.id or v_event.payload_sha256 <> p_payload_sha256 then
        raise exception 'provider call event id reused with different payload' using errcode = '23505';
      end if;
      return jsonb_build_object('callSessionId', v_call.id, 'status', v_call.status,
        'authorityMode', v_call.authority_mode, 'rowVersion', v_call.row_version,
        'eventId', v_event.id, 'duplicate', true);
    end if;
  end if;
  if v_call.row_version <> p_expected_row_version then
    raise exception 'stale call version' using errcode = '40001';
  end if;
  if not (
    (v_call.status = 'received' and p_next_status in ('ringing', 'connected', 'failed'))
    or (v_call.status = 'ringing' and p_next_status in ('connected', 'transferring', 'transferred', 'completed', 'failed'))
    or (v_call.status = 'connected' and p_next_status in ('transferring', 'transferred', 'completed', 'failed'))
    or (v_call.status = 'transferring' and p_next_status in ('connected', 'transferred', 'failed'))
    or (v_call.status = 'transferred' and p_next_status in ('completed', 'failed'))
  ) then
    raise exception 'invalid call transition' using errcode = '55000';
  end if;
  if p_authority_mode = 'human_transfer' and nullif(p_transfer_destination_key, '') is null then
    raise exception 'human transfer destination is required' using errcode = '22023';
  end if;
  if p_authority_effect = 'deterministic_request'
     and (v_call.case_id is null or v_call.workflow_instance_id is null) then
    raise exception 'deterministic call requests require an entitled case workflow'
      using errcode = '42501';
  end if;
  if p_actor_type = 'staff'
     and not private.civya_actor_is_staff(p_actor_user_id, v_call.tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  insert into public.call_events (
    tenant_id, call_session_id, sequence_number, provider_event_id, event_type,
    authority_effect, actor_type, actor_auth_user_id, payload_sha256,
    redacted_metadata, correlation_id
  ) values (
    v_call.tenant_id, v_call.id, v_call.row_version + 1,
    nullif(p_provider_event_id, ''), p_event_type, p_authority_effect,
    p_actor_type, case when p_actor_type = 'staff' then p_actor_user_id else null end,
    p_payload_sha256, coalesce(p_redacted_metadata, '{}'::jsonb),
    v_call.correlation_id
  ) returning * into v_event;
  update public.call_sessions set
    status = p_next_status, authority_mode = p_authority_mode,
    transfer_destination_key = case when p_authority_mode = 'human_transfer'
      then p_transfer_destination_key else transfer_destination_key end,
    connected_at = case when p_next_status = 'connected'
      then coalesce(connected_at, now()) else connected_at end,
    ended_at = case when p_next_status in ('completed', 'failed') then now() else null end,
    row_version = row_version + 1
  where id = v_call.id returning * into v_call;
  return jsonb_build_object('callSessionId', v_call.id, 'status', v_call.status,
    'authorityMode', v_call.authority_mode, 'rowVersion', v_call.row_version,
    'eventId', v_event.id, 'duplicate', false);
end;
$$;

create or replace function public.civya_service_advance_reconciliation_checkpoint(
  p_tenant_id uuid,
  p_provider_key text,
  p_stream_key text,
  p_expected_row_version bigint,
  p_run_id uuid,
  p_result text,
  p_cursor_digest text,
  p_through_at timestamptz,
  p_records_examined bigint,
  p_discrepancies_found bigint,
  p_error_code text,
  p_summary_sha256 text,
  p_redacted_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_checkpoint public.provider_reconciliation_checkpoints%rowtype;
  v_event public.reconciliation_checkpoint_events%rowtype;
  v_status text;
begin
  perform private.civya_service_required();
  insert into public.provider_reconciliation_checkpoints (
    tenant_id, provider_key, stream_key
  ) values (p_tenant_id, p_provider_key, p_stream_key)
  on conflict (tenant_id, provider_key, stream_key) do nothing;
  select * into strict v_checkpoint from public.provider_reconciliation_checkpoints
  where tenant_id = p_tenant_id and provider_key = p_provider_key
    and stream_key = p_stream_key for update;
  select * into v_event from public.reconciliation_checkpoint_events
  where checkpoint_id = v_checkpoint.id and run_id = p_run_id and result = p_result;
  if found then
    return jsonb_build_object('checkpointId', v_checkpoint.id,
      'status', v_checkpoint.status, 'rowVersion', v_checkpoint.row_version,
      'eventId', v_event.id, 'duplicate', true);
  end if;
  if v_checkpoint.row_version <> p_expected_row_version then
    raise exception 'stale reconciliation checkpoint version' using errcode = '40001';
  end if;
  if p_result = 'succeeded' and v_checkpoint.through_at is not null
     and p_through_at < v_checkpoint.through_at then
    raise exception 'reconciliation checkpoint cannot move backward' using errcode = '55000';
  end if;
  v_status := case p_result
    when 'started' then 'running'
    when 'succeeded' then 'healthy'
    when 'degraded' then 'degraded'
    else 'failed'
  end;
  insert into public.reconciliation_checkpoint_events (
    tenant_id, checkpoint_id, run_id, result, cursor_digest, through_at,
    records_examined, discrepancies_found, error_code, summary_sha256,
    redacted_summary
  ) values (
    p_tenant_id, v_checkpoint.id, p_run_id, p_result, p_cursor_digest,
    p_through_at, p_records_examined, p_discrepancies_found, p_error_code,
    p_summary_sha256, coalesce(p_redacted_summary, '{}'::jsonb)
  ) returning * into v_event;
  update public.provider_reconciliation_checkpoints set
    cursor_digest = case when p_result in ('succeeded', 'degraded') then p_cursor_digest else cursor_digest end,
    through_at = case when p_result in ('succeeded', 'degraded') then p_through_at else through_at end,
    status = v_status, last_run_id = p_run_id,
    records_examined = p_records_examined,
    discrepancies_found = p_discrepancies_found,
    last_error_code = p_error_code,
    last_started_at = case when p_result = 'started' then now() else last_started_at end,
    last_succeeded_at = case when p_result = 'succeeded' then now() else last_succeeded_at end,
    row_version = row_version + 1
  where id = v_checkpoint.id returning * into v_checkpoint;
  return jsonb_build_object('checkpointId', v_checkpoint.id,
    'status', v_checkpoint.status, 'rowVersion', v_checkpoint.row_version,
    'eventId', v_event.id, 'duplicate', false);
end;
$$;

-- Staff summary RPCs deliberately omit subject identifiers, external digests,
-- link material, and provider cursors. They execute under authenticated claims.
create or replace function public.civya_staff_channel_session_summary(
  p_tenant_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_result jsonb;
begin
  if not private.civya_actor_is_staff(auth.uid(), p_tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'channelSessionId', s.id, 'caseId', s.case_id, 'channel', s.channel,
    'subjectState', s.subject_state, 'status', s.status,
    'correlationId', s.correlation_id, 'lastActiveAt', s.last_active_at,
    'rowVersion', s.row_version
  ) order by s.last_active_at desc), '[]'::jsonb) into v_result
  from (
    select * from public.channel_sessions
    where tenant_id = p_tenant_id order by last_active_at desc
    limit least(greatest(p_limit, 1), 500)
  ) s;
  return v_result;
end;
$$;

create or replace function public.civya_staff_call_session_summary(
  p_tenant_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_result jsonb;
begin
  if not private.civya_actor_is_staff(auth.uid(), p_tenant_id) then
    raise exception 'tenant staff required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'callSessionId', c.id, 'caseId', c.case_id, 'direction', c.direction,
    'status', c.status, 'authorityMode', c.authority_mode,
    'transferDestinationKey', c.transfer_destination_key,
    'correlationId', c.correlation_id, 'startedAt', c.started_at,
    'connectedAt', c.connected_at, 'endedAt', c.ended_at,
    'rowVersion', c.row_version
  ) order by c.started_at desc), '[]'::jsonb) into v_result
  from (
    select * from public.call_sessions
    where tenant_id = p_tenant_id order by started_at desc
    limit least(greatest(p_limit, 1), 500)
  ) c;
  return v_result;
end;
$$;

create or replace function public.civya_staff_reconciliation_summary(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_result jsonb;
begin
  if not private.civya_actor_is_staff(auth.uid(), p_tenant_id, 'admin') then
    raise exception 'tenant admin required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'checkpointId', c.id, 'providerKey', c.provider_key,
    'streamKey', c.stream_key, 'status', c.status,
    'throughAt', c.through_at, 'recordsExamined', c.records_examined,
    'discrepanciesFound', c.discrepancies_found,
    'lastErrorCode', c.last_error_code, 'lastSucceededAt', c.last_succeeded_at,
    'rowVersion', c.row_version
  ) order by c.provider_key, c.stream_key), '[]'::jsonb) into v_result
  from public.provider_reconciliation_checkpoints c
  where c.tenant_id = p_tenant_id;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants.
-- ---------------------------------------------------------------------------

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'channel_sessions', 'channel_session_events', 'call_sessions', 'call_events',
    'provider_reconciliation_checkpoints', 'reconciliation_checkpoint_events'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$$;

create policy channel_sessions_subject_read on public.channel_sessions
  for select to authenticated using (
    private.civya_outcome_staff_read_allowed(tenant_id)
    or (case_id is not null and public.civya_can_access_case(case_id))
    or (case_id is null and auth_user_id = auth.uid())
  );
create policy channel_session_events_subject_read on public.channel_session_events
  for select to authenticated using (exists (
    select 1 from public.channel_sessions s
    where s.id = channel_session_id and (
      private.civya_outcome_staff_read_allowed(s.tenant_id)
      or (s.case_id is not null and public.civya_can_access_case(s.case_id))
      or (s.case_id is null and s.auth_user_id = auth.uid())
    )
  ));
create policy call_sessions_subject_read on public.call_sessions
  for select to authenticated using (
    private.civya_outcome_staff_read_allowed(tenant_id)
    or (case_id is not null and public.civya_can_access_case(case_id))
    or (case_id is null and auth_user_id = auth.uid())
  );
create policy call_events_staff_read on public.call_events
  for select to authenticated using (private.civya_outcome_staff_read_allowed(tenant_id));
create policy reconciliation_checkpoints_admin_read on public.provider_reconciliation_checkpoints
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));
create policy reconciliation_checkpoint_events_admin_read on public.reconciliation_checkpoint_events
  for select to authenticated using (private.civya_outcome_admin_read_allowed(tenant_id));

grant select on public.channel_sessions to authenticated, service_role;
grant select on public.channel_session_events to authenticated, service_role;
grant select on public.call_sessions to authenticated, service_role;
grant select on public.call_events to authenticated, service_role;
grant select on public.provider_reconciliation_checkpoints to authenticated, service_role;
grant select on public.reconciliation_checkpoint_events to authenticated, service_role;

revoke all on function public.civya_service_create_channel_session(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.civya_service_control_channel_session(
  uuid, uuid, bigint, text, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.civya_service_create_secure_link(
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.civya_service_consume_secure_link(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_create_call_session(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.civya_service_control_call(
  uuid, bigint, text, text, text, text, text, text, text, uuid, text, jsonb
) from public, anon, authenticated;
revoke all on function public.civya_service_advance_reconciliation_checkpoint(
  uuid, text, text, bigint, uuid, text, text, timestamptz, bigint, bigint, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.civya_service_create_channel_session(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb, text
) to service_role;
grant execute on function public.civya_service_control_channel_session(
  uuid, uuid, bigint, text, text, text, jsonb, text
) to service_role;
grant execute on function public.civya_service_create_secure_link(
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, timestamptz, text
) to service_role;
grant execute on function public.civya_service_consume_secure_link(uuid, text, text, uuid)
  to service_role;
grant execute on function public.civya_service_create_call_session(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text
) to service_role;
grant execute on function public.civya_service_control_call(
  uuid, bigint, text, text, text, text, text, text, text, uuid, text, jsonb
) to service_role;
grant execute on function public.civya_service_advance_reconciliation_checkpoint(
  uuid, text, text, bigint, uuid, text, text, timestamptz, bigint, bigint, text, text, jsonb
) to service_role;

revoke all on function public.civya_staff_channel_session_summary(uuid, integer)
  from public, anon;
revoke all on function public.civya_staff_call_session_summary(uuid, integer)
  from public, anon;
revoke all on function public.civya_staff_reconciliation_summary(uuid)
  from public, anon;
grant execute on function public.civya_staff_channel_session_summary(uuid, integer)
  to authenticated, service_role;
grant execute on function public.civya_staff_call_session_summary(uuid, integer)
  to authenticated, service_role;
grant execute on function public.civya_staff_reconciliation_summary(uuid)
  to authenticated, service_role;

comment on table private.secure_link_tokens is
  'One-time token digests only. Plaintext secure-link tokens are never persisted.';
comment on table public.call_sessions is
  'Provider-neutral phone lifecycle without phone numbers, raw audio, raw transcripts, or payment credentials.';
comment on table public.call_events is
  'Append-only call-control chronology. Consequential model output is blocked or routed into deterministic workflow authority.';
