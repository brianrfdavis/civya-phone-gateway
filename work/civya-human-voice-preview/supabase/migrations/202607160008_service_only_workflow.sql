-- All resident workflow mutations cross the trusted Next.js server boundary.
-- Browser JWTs retain RLS-protected reads, but cannot execute state-changing
-- workflow RPCs or write private document/storage records directly.

create table if not exists private.tenant_access_grants (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  invitation_id uuid not null references public.demo_invitations(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, auth_user_id)
);

create index if not exists tenant_access_grants_expiry_idx
  on private.tenant_access_grants (expires_at);

revoke all on private.tenant_access_grants from public, anon, authenticated;

create or replace function private.civya_service_required()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.civya_actor_is_staff(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_min_role text default 'reviewer'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.tenant_id = p_tenant_id
      and sr.auth_user_id = p_actor_user_id
      and sr.status = 'active'
      and case
        when p_min_role = 'admin' then sr.role = 'admin'
        else sr.role in ('reviewer', 'admin')
      end
  );
$$;

create or replace function private.civya_has_tenant_access(
  p_actor_user_id uuid,
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from private.tenant_access_grants g
    join public.demo_invitations i on i.id = g.invitation_id
    where g.auth_user_id = p_actor_user_id
      and g.tenant_id = p_tenant_id
      and g.expires_at > now()
      and i.tenant_id = g.tenant_id
      and i.expires_at > now()
      and i.revoked_at is null
      and 'resident_demo' = any(i.scopes)
  );
$$;

create or replace function private.civya_actor_has_tenant_access(
  p_actor_user_id uuid,
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select private.civya_has_tenant_access(p_actor_user_id, p_tenant_id)
    or private.civya_actor_is_staff(p_actor_user_id, p_tenant_id);
$$;

create or replace function private.civya_actor_can_access_case(
  p_actor_user_id uuid,
  p_case_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.cases c
    join public.residents r on r.id = c.resident_id
    where c.id = p_case_id
      and (
        (
          r.auth_user_id = p_actor_user_id
          and private.civya_has_tenant_access(p_actor_user_id, c.tenant_id)
        )
        or private.civya_actor_is_staff(p_actor_user_id, c.tenant_id)
      )
  );
$$;

revoke all on function private.civya_service_required() from public, anon, authenticated;
revoke all on function private.civya_actor_is_staff(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.civya_has_tenant_access(uuid, uuid) from public, anon, authenticated;
revoke all on function private.civya_actor_has_tenant_access(uuid, uuid) from public, anon, authenticated;
revoke all on function private.civya_actor_can_access_case(uuid, uuid) from public, anon, authenticated;

create or replace function public.civya_service_grant_tenant_access(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_tenant_slug text,
  p_invitation_id uuid,
  p_cookie_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_tenant public.tenants%rowtype;
  v_invitation public.demo_invitations%rowtype;
  v_expires_at timestamptz;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or not exists (select 1 from auth.users where id = p_actor_user_id) then
    raise exception 'authenticated actor not found' using errcode = '28000';
  end if;
  if p_cookie_expires_at is null or p_cookie_expires_at <= now() then
    raise exception 'county demo access expired' using errcode = '28000';
  end if;

  select * into v_tenant
  from public.tenants
  where slug = p_tenant_slug and status = 'active' and fictional;
  if not found then raise exception 'sandbox tenant unavailable' using errcode = 'P0002'; end if;

  select * into v_invitation
  from public.demo_invitations
  where id = p_invitation_id
    and tenant_id = v_tenant.id
    and revoked_at is null
    and expires_at > now()
    and use_count > 0
    and 'resident_demo' = any(scopes);
  if not found then raise exception 'invitation invalid or expired' using errcode = '28000'; end if;

  v_expires_at := least(v_invitation.expires_at, p_cookie_expires_at, now() + interval '8 hours');
  insert into private.tenant_access_grants (
    tenant_id, auth_user_id, invitation_id, expires_at
  ) values (
    v_tenant.id, p_actor_user_id, v_invitation.id, v_expires_at
  )
  on conflict (tenant_id, auth_user_id) do update set
    invitation_id = excluded.invitation_id,
    expires_at = excluded.expires_at,
    updated_at = now();

  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'tenantSlug', v_tenant.slug,
    'invitationId', v_invitation.id,
    'expiresAt', v_expires_at
  );
end;
$$;

create or replace function public.civya_service_bootstrap_session(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_actor_is_verified boolean,
  p_tenant_slug text default 'wayne-county-demo',
  p_channel text default 'voice'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_tenant public.tenants%rowtype;
  v_resident public.residents%rowtype;
  v_case public.cases%rowtype;
  v_conversation public.conversations%rowtype;
  v_facts jsonb;
  v_turns jsonb;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or not exists (select 1 from auth.users where id = p_actor_user_id) then
    raise exception 'authenticated actor not found' using errcode = '28000';
  end if;
  if p_channel not in ('voice', 'chat', 'sms', 'email') then raise exception 'invalid channel'; end if;

  select * into v_tenant from public.tenants where slug = p_tenant_slug and status = 'active';
  if not found then raise exception 'sandbox tenant unavailable' using errcode = 'P0002'; end if;
  if not private.civya_actor_has_tenant_access(p_actor_user_id, v_tenant.id) then
    raise exception 'active county demo invitation required' using errcode = '42501';
  end if;

  insert into public.residents (tenant_id, auth_user_id, identity_state, email)
  values (
    v_tenant.id,
    p_actor_user_id,
    case when p_actor_is_verified then 'verified' else 'anonymous' end,
    nullif(p_actor_email, '')
  )
  on conflict (tenant_id, auth_user_id) do update set
    last_active_at = now(),
    identity_state = case when p_actor_is_verified then 'verified' else public.residents.identity_state end,
    email = coalesce(nullif(p_actor_email, ''), public.residents.email),
    row_version = public.residents.row_version + 1
  returning * into v_resident;

  select * into v_case from public.cases
  where tenant_id = v_tenant.id and resident_id = v_resident.id and active
  for update;
  if not found then
    insert into public.cases (tenant_id, resident_id)
    values (v_tenant.id, v_resident.id)
    returning * into v_case;
  end if;

  select * into v_conversation from public.conversations
  where case_id = v_case.id and channel = p_channel and status = 'active'
  for update;
  if not found then
    insert into public.conversations (tenant_id, resident_id, case_id, channel)
    values (v_tenant.id, v_resident.id, v_case.id, p_channel)
    returning * into v_conversation;
  end if;

  select coalesce(jsonb_object_agg(fact_key, fact_value), '{}'::jsonb)
  into v_facts from public.case_facts
  where case_id = v_case.id and confirmation_state = 'confirmed';

  select coalesce(jsonb_agg(to_jsonb(recent_turns) order by sequence_number), '[]'::jsonb)
  into v_turns
  from (
    select id, speaker, channel, redacted_text as text, created_at, sequence_number
    from public.turns
    where conversation_id = v_conversation.id and processing_status <> 'failed'
    order by sequence_number desc
    limit 6
  ) recent_turns;

  return jsonb_build_object(
    'authentication', jsonb_build_object(
      'userId', p_actor_user_id,
      'isAnonymous', p_actor_is_anonymous,
      'isVerified', p_actor_is_verified,
      'email', nullif(p_actor_email, '')
    ),
    'tenant', jsonb_build_object('id', v_tenant.id, 'slug', v_tenant.slug, 'name', v_tenant.name, 'fictional', true),
    'resident', jsonb_build_object('id', v_resident.id, 'identityState', v_resident.identity_state),
    'activeCase', jsonb_build_object(
      'id', v_case.id, 'status', v_case.status, 'rowVersion', v_case.row_version,
      'workflowState', v_case.workflow_state, 'nextQuestion', v_case.next_question,
      'nextBestAction', v_case.next_best_action, 'updatedAt', v_case.updated_at
    ),
    'conversation', jsonb_build_object(
      'id', v_conversation.id, 'channel', v_conversation.channel,
      'status', v_conversation.status, 'rowVersion', v_conversation.row_version
    ),
    'resumeContext', jsonb_build_object(
      'confirmedFacts', v_facts,
      'conversationSummary', coalesce(nullif(v_conversation.summary, ''), v_case.resume_summary, ''),
      'recentTurns', v_turns,
      'currentWorkflowState', v_case.workflow_state,
      'nextQuestion', v_case.next_question
    ),
    'nextAction', jsonb_build_object(
      'kind', case when v_case.next_question is null then 'continue' else 'ask_question' end,
      'prompt', coalesce(v_case.next_question, v_case.next_best_action)
    )
  );
end;
$$;

create or replace function public.civya_service_create_or_get_conversation(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_case_id uuid,
  p_channel text
)
returns public.conversations
language plpgsql
security definer
set search_path = public, private
as $$
begin
  perform private.civya_service_required();
  if not private.civya_actor_can_access_case(p_actor_user_id, p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  return public.civya_create_or_get_conversation(p_case_id, p_channel);
end;
$$;

create or replace function public.civya_service_append_turn(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_conversation_id uuid,
  p_provider_item_id text,
  p_client_turn_id text,
  p_idempotency_key text,
  p_speaker text,
  p_channel text,
  p_redacted_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_case_id uuid;
begin
  perform private.civya_service_required();
  select case_id into v_case_id from public.conversations where id = p_conversation_id;
  if v_case_id is null or not private.civya_actor_can_access_case(p_actor_user_id, v_case_id) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  return public.civya_append_turn(
    p_conversation_id, p_provider_item_id, p_client_turn_id, p_idempotency_key,
    p_speaker, p_channel, p_redacted_text
  );
end;
$$;

create or replace function public.civya_service_upsert_case_facts(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_case_id uuid,
  p_expected_row_version bigint,
  p_facts jsonb,
  p_source_turn_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
begin
  perform private.civya_service_required();
  if not private.civya_actor_can_access_case(p_actor_user_id, p_case_id)
     or not exists (
       select 1 from public.turns
       where id = p_source_turn_id and case_id = p_case_id
     ) then
    raise exception 'case or source turn not found' using errcode = 'P0002';
  end if;
  return public.civya_upsert_case_facts(
    p_case_id, p_expected_row_version, p_facts, p_source_turn_id, p_idempotency_key
  );
end;
$$;

create or replace function public.civya_service_commit_turn_result(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_user_turn_id uuid,
  p_expected_case_version bigint,
  p_spoken_response text,
  p_next_question text,
  p_workflow_state text,
  p_case_status text,
  p_conversation_summary text,
  p_completion_state jsonb,
  p_facts jsonb,
  p_finish_conversation boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_turn public.turns%rowtype; v_result jsonb;
begin
  perform private.civya_service_required();
  select * into v_turn from public.turns where id = p_user_turn_id;
  if not found or v_turn.speaker <> 'user'
     or not private.civya_actor_can_access_case(p_actor_user_id, v_turn.case_id) then
    raise exception 'turn not found' using errcode = 'P0002';
  end if;

  v_result := public.civya_commit_turn_result(
    p_user_turn_id, p_expected_case_version, p_spoken_response, p_next_question,
    p_workflow_state, p_case_status, p_conversation_summary,
    p_completion_state, p_facts
  );

  if p_finish_conversation then
    update public.conversations set
      status = 'ended',
      summary = coalesce(nullif(p_conversation_summary, ''), summary),
      ended_at = coalesce(ended_at, now()),
      row_version = case when status = 'ended' then row_version else row_version + 1 end
    where id = v_turn.conversation_id;
  end if;
  return v_result;
end;
$$;

create or replace function public.civya_service_finish_conversation(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_conversation_id uuid,
  p_summary text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare v_case_id uuid;
begin
  perform private.civya_service_required();
  select case_id into v_case_id from public.conversations where id = p_conversation_id;
  if v_case_id is null or not private.civya_actor_can_access_case(p_actor_user_id, v_case_id) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  perform public.civya_finish_conversation(p_conversation_id, p_summary);
end;
$$;

create or replace function public.civya_service_mark_identity_verified(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_resident public.residents%rowtype;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or p_actor_is_anonymous or nullif(p_actor_email, '') is null then
    raise exception 'verified identity required' using errcode = '28000';
  end if;
  update public.residents set
    identity_state = 'verified',
    email = p_actor_email,
    row_version = row_version + 1
  where auth_user_id = p_actor_user_id
    and private.civya_has_tenant_access(p_actor_user_id, tenant_id);
  select * into v_resident from public.residents
    where auth_user_id = p_actor_user_id
      and private.civya_has_tenant_access(p_actor_user_id, tenant_id)
    order by last_active_at desc
    limit 1;
  if not found then raise exception 'resident workspace not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('residentId', v_resident.id, 'email', v_resident.email);
end;
$$;

create or replace function public.civya_service_create_case_transfer_grant(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_case_id uuid,
  p_token_hash text,
  p_ttl_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_case public.cases%rowtype; v_grant private.case_transfer_grants%rowtype;
begin
  perform private.civya_service_required();
  select c.* into v_case
  from public.cases c
  where c.id = p_case_id
    and private.civya_actor_can_access_case(p_actor_user_id, c.id);
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_ttl_seconds < 60 or p_ttl_seconds > 900 then raise exception 'invalid transfer grant lifetime'; end if;

  delete from private.case_transfer_grants
    where created_by_auth_user_id = p_actor_user_id and used_at is null;
  insert into private.case_transfer_grants (
    tenant_id, source_resident_id, case_id, created_by_auth_user_id, token_hash, expires_at
  ) values (
    v_case.tenant_id, v_case.resident_id, v_case.id, p_actor_user_id, p_token_hash,
    now() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_grant;
  return jsonb_build_object('grantId', v_grant.id, 'expiresAt', v_grant.expires_at);
end;
$$;

create or replace function public.civya_service_redeem_case_transfer_grant(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_grant private.case_transfer_grants%rowtype;
  v_source public.residents%rowtype;
  v_target public.residents%rowtype;
  v_existing_case_id uuid;
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or p_actor_is_anonymous or nullif(p_actor_email, '') is null then
    raise exception 'verified identity required' using errcode = '28000';
  end if;
  select * into v_grant from private.case_transfer_grants
    where token_hash = p_token_hash and used_at is null and expires_at > now()
    for update;
  if not found then raise exception 'transfer grant invalid or expired' using errcode = '28000'; end if;

  select * into v_source from public.residents where id = v_grant.source_resident_id for update;
  if not private.civya_has_tenant_access(v_grant.created_by_auth_user_id, v_grant.tenant_id) then
    raise exception 'source county demo access expired' using errcode = '28000';
  end if;
  insert into public.residents (tenant_id, auth_user_id, identity_state, email)
  values (v_grant.tenant_id, p_actor_user_id, 'verified', p_actor_email)
  on conflict (tenant_id, auth_user_id) do update set
    identity_state = 'verified',
    email = coalesce(nullif(p_actor_email, ''), public.residents.email),
    last_active_at = now(),
    row_version = public.residents.row_version + 1
  returning * into v_target;

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

  if v_target.id = v_source.id then
    update private.case_transfer_grants
      set used_at = now(), claimed_by_auth_user_id = p_actor_user_id
      where id = v_grant.id;
    return jsonb_build_object(
      'caseId', v_grant.case_id, 'residentId', v_target.id,
      'requiresCaseSelection', false, 'existingActiveCaseId', null
    );
  end if;

  select id into v_existing_case_id from public.cases
    where tenant_id = v_grant.tenant_id and resident_id = v_target.id
      and active and id <> v_grant.case_id
    for update;

  update public.cases set
    active = case when v_existing_case_id is null then active else false end,
    resident_id = v_target.id,
    row_version = row_version + 1
  where id = v_grant.case_id and resident_id = v_source.id;
  if not found then raise exception 'transfer case no longer belongs to source resident' using errcode = '40001'; end if;

  update public.conversations set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.turns set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.case_facts set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.documents set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.checklist_items set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.consent set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.review_tasks set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.reminders set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.simulated_transactions set resident_id = v_target.id where case_id = v_grant.case_id;

  update private.case_transfer_grants
    set used_at = now(), claimed_by_auth_user_id = p_actor_user_id
    where id = v_grant.id;
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type, redacted_payload, source
  ) values (
    v_grant.tenant_id, v_target.id, v_grant.case_id, p_actor_user_id,
    'case_attached_to_verified_account',
    jsonb_build_object('source', 'one_time_case_transfer', 'merged', false), 'system'
  );

  return jsonb_build_object(
    'caseId', v_grant.case_id,
    'residentId', v_target.id,
    'requiresCaseSelection', v_existing_case_id is not null,
    'existingActiveCaseId', v_existing_case_id
  );
end;
$$;

create or replace function public.civya_service_append_audit_event(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_tenant_id uuid,
  p_resident_id uuid,
  p_case_id uuid,
  p_event_type text,
  p_redacted_payload jsonb,
  p_source text,
  p_request_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare v_id uuid;
begin
  perform private.civya_service_required();
  if p_case_id is null and p_resident_id is null
     and not private.civya_actor_is_staff(p_actor_user_id, p_tenant_id) then
    raise exception 'case or resident required' using errcode = '42501';
  end if;
  if p_case_id is not null and not private.civya_actor_can_access_case(p_actor_user_id, p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  if p_case_id is null and p_resident_id is not null
     and not exists (
       select 1 from public.residents r
       where r.id = p_resident_id and r.tenant_id = p_tenant_id
         and (
           (
             r.auth_user_id = p_actor_user_id
             and private.civya_has_tenant_access(p_actor_user_id, p_tenant_id)
           )
           or private.civya_actor_is_staff(p_actor_user_id, p_tenant_id)
         )
     ) then
    raise exception 'resident not found' using errcode = 'P0002';
  end if;
  if p_source = 'admin' and not private.civya_actor_is_staff(p_actor_user_id, p_tenant_id, 'admin') then
    raise exception 'admin required' using errcode = '42501';
  end if;
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type,
    redacted_payload, source, request_id
  ) values (
    p_tenant_id, p_resident_id, p_case_id, p_actor_user_id, p_event_type,
    coalesce(p_redacted_payload, '{}'::jsonb), p_source, p_request_id
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.civya_service_take_rate_limit(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_key_hash text,
  p_bucket text,
  p_max_hits integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
begin
  perform private.civya_service_required();
  if p_actor_user_id is null or not exists (select 1 from auth.users where id = p_actor_user_id) then
    raise exception 'authenticated actor not found' using errcode = '28000';
  end if;
  return public.civya_take_rate_limit(
    p_key_hash, p_bucket, p_max_hits, p_window_seconds
  );
end;
$$;

create or replace function public.civya_service_activate_case(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_case_id uuid,
  p_expected_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_case public.cases%rowtype;
  v_resident public.residents%rowtype;
  v_deactivated uuid[];
begin
  perform private.civya_service_required();
  if p_actor_is_anonymous then raise exception 'verified identity required' using errcode = '28000'; end if;
  select c.* into v_case
  from public.cases c
  join public.residents r on r.id = c.resident_id
  where c.id = p_case_id and r.auth_user_id = p_actor_user_id
    and private.civya_has_tenant_access(p_actor_user_id, c.tenant_id)
  for update of c;
  if not found then
    raise exception 'verified resident case not found' using errcode = 'P0002';
  end if;
  select * into v_resident
  from public.residents
  where id = v_case.resident_id
  for update;
  if not found or v_resident.identity_state <> 'verified' then
    raise exception 'verified resident case not found' using errcode = 'P0002';
  end if;
  if v_case.status = 'closed' then raise exception 'closed case cannot be activated' using errcode = '22023'; end if;
  if v_case.row_version <> p_expected_row_version then
    raise exception 'stale case version' using errcode = '40001';
  end if;

  perform 1 from public.cases
    where resident_id = v_case.resident_id
    order by id
    for update;
  select coalesce(array_agg(id), '{}'::uuid[]) into v_deactivated
    from public.cases
    where resident_id = v_case.resident_id and active and id <> v_case.id;
  update public.cases set active = false, row_version = row_version + 1
    where resident_id = v_case.resident_id and active and id <> v_case.id;
  update public.cases set active = true, row_version = row_version + 1
    where id = v_case.id
    returning * into v_case;

  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type, redacted_payload, source
  ) values (
    v_case.tenant_id, v_case.resident_id, v_case.id, p_actor_user_id,
    'resident_case_activated',
    jsonb_build_object('deactivatedCaseIds', to_jsonb(v_deactivated), 'merged', false),
    'resident'
  );
  return jsonb_build_object(
    'caseId', v_case.id,
    'residentId', v_case.resident_id,
    'rowVersion', v_case.row_version,
    'deactivatedCaseIds', to_jsonb(v_deactivated)
  );
end;
$$;

-- The browser roles keep read policies but cannot invoke workflow mutations.
revoke all on function public.civya_bootstrap_session(text, text) from public, anon, authenticated;
revoke all on function public.civya_create_or_get_conversation(uuid, text) from public, anon, authenticated;
revoke all on function public.civya_append_turn(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.civya_upsert_case_facts(uuid, bigint, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.civya_commit_turn_result(uuid, bigint, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.civya_finish_conversation(uuid, text) from public, anon, authenticated;
revoke all on function public.civya_mark_identity_verified() from public, anon, authenticated;
revoke all on function public.civya_create_case_transfer_grant(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.civya_redeem_case_transfer_grant(text) from public, anon, authenticated;
revoke all on function public.civya_append_audit_event(uuid, uuid, uuid, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.civya_take_rate_limit(text, text, integer, integer) from public, anon, authenticated;

-- Keep explicit authenticated-role revocations for security auditing and
-- drift checks, in addition to the grouped revocations above.
revoke all on function public.civya_bootstrap_session(text, text) from authenticated;
revoke all on function public.civya_append_turn(uuid, text, text, text, text, text, text) from authenticated;
revoke all on function public.civya_commit_turn_result(uuid, bigint, text, text, text, text, text, jsonb, jsonb) from authenticated;
revoke all on function public.civya_finish_conversation(uuid, text) from authenticated;

grant execute on function public.civya_bootstrap_session(text, text) to service_role;
grant execute on function public.civya_create_or_get_conversation(uuid, text) to service_role;
grant execute on function public.civya_append_turn(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.civya_upsert_case_facts(uuid, bigint, jsonb, uuid, text) to service_role;
grant execute on function public.civya_commit_turn_result(uuid, bigint, text, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.civya_finish_conversation(uuid, text) to service_role;
grant execute on function public.civya_mark_identity_verified() to service_role;
grant execute on function public.civya_create_case_transfer_grant(uuid, text, integer) to service_role;
grant execute on function public.civya_redeem_case_transfer_grant(text) to service_role;
grant execute on function public.civya_append_audit_event(uuid, uuid, uuid, text, jsonb, text, text) to service_role;
grant execute on function public.civya_take_rate_limit(text, text, integer, integer) to service_role;

revoke all on function public.civya_service_grant_tenant_access(uuid, text, boolean, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.civya_service_bootstrap_session(uuid, text, boolean, boolean, text, text) from public, anon, authenticated;
revoke all on function public.civya_service_create_or_get_conversation(uuid, text, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.civya_service_append_turn(uuid, text, boolean, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.civya_service_upsert_case_facts(uuid, text, boolean, uuid, bigint, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.civya_service_commit_turn_result(uuid, text, boolean, uuid, bigint, text, text, text, text, text, jsonb, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.civya_service_finish_conversation(uuid, text, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.civya_service_mark_identity_verified(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.civya_service_create_case_transfer_grant(uuid, text, boolean, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.civya_service_redeem_case_transfer_grant(uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function public.civya_service_append_audit_event(uuid, text, boolean, uuid, uuid, uuid, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.civya_service_take_rate_limit(uuid, text, boolean, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.civya_service_activate_case(uuid, text, boolean, uuid, bigint) from public, anon, authenticated;

grant execute on function public.civya_service_grant_tenant_access(uuid, text, boolean, text, uuid, timestamptz) to service_role;
grant execute on function public.civya_service_bootstrap_session(uuid, text, boolean, boolean, text, text) to service_role;
grant execute on function public.civya_service_create_or_get_conversation(uuid, text, boolean, uuid, text) to service_role;
grant execute on function public.civya_service_append_turn(uuid, text, boolean, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.civya_service_upsert_case_facts(uuid, text, boolean, uuid, bigint, jsonb, uuid, text) to service_role;
grant execute on function public.civya_service_commit_turn_result(uuid, text, boolean, uuid, bigint, text, text, text, text, text, jsonb, jsonb, boolean) to service_role;
grant execute on function public.civya_service_finish_conversation(uuid, text, boolean, uuid, text) to service_role;
grant execute on function public.civya_service_mark_identity_verified(uuid, text, boolean) to service_role;
grant execute on function public.civya_service_create_case_transfer_grant(uuid, text, boolean, uuid, text, integer) to service_role;
grant execute on function public.civya_service_redeem_case_transfer_grant(uuid, text, boolean, text) to service_role;
grant execute on function public.civya_service_append_audit_event(uuid, text, boolean, uuid, uuid, uuid, text, jsonb, text, text) to service_role;
grant execute on function public.civya_service_take_rate_limit(uuid, text, boolean, text, text, integer, integer) to service_role;
grant execute on function public.civya_service_activate_case(uuid, text, boolean, uuid, bigint) to service_role;

-- A Supabase session alone is not sufficient for resident data access. The
-- session must also hold a live grant derived from the signed demo invitation.
create or replace function public.civya_owns_resident(p_resident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.residents r
    where r.id = p_resident_id
      and (
        (
          r.auth_user_id = auth.uid()
          and private.civya_has_tenant_access(auth.uid(), r.tenant_id)
        )
        or public.civya_is_staff(r.tenant_id)
      )
  );
$$;

create or replace function public.civya_can_access_case(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.cases c
    join public.residents r on r.id = c.resident_id
    where c.id = p_case_id
      and (
        (
          r.auth_user_id = auth.uid()
          and private.civya_has_tenant_access(auth.uid(), c.tenant_id)
        )
        or public.civya_is_staff(c.tenant_id)
      )
  );
$$;

create or replace function public.civya_can_access_storage_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, private
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
    select 1
    from public.cases c
    join public.residents r on r.id = c.resident_id
    where c.id = v_case_id
      and c.tenant_id = v_tenant_id
      and c.resident_id = v_resident_id
      and (
        (
          r.auth_user_id = auth.uid()
          and private.civya_has_tenant_access(auth.uid(), c.tenant_id)
        )
        or public.civya_is_staff(c.tenant_id)
      )
  );
exception when others then
  return false;
end;
$$;

drop policy if exists tenants_member_read on public.tenants;
create policy tenants_member_read on public.tenants for select to authenticated
  using (
    public.civya_is_staff(id)
    or (
      private.civya_has_tenant_access(auth.uid(), id)
      and exists (
        select 1 from public.residents r
        where r.tenant_id = id and r.auth_user_id = auth.uid()
      )
    )
  );

drop policy if exists residents_owner_read on public.residents;
drop policy if exists residents_owner_update on public.residents;
create policy residents_owner_read on public.residents for select to authenticated
  using (public.civya_owns_resident(id));
create policy residents_owner_update on public.residents for update to authenticated
  using (public.civya_owns_resident(id))
  with check (public.civya_owns_resident(id));

-- Browser sessions cannot write document metadata, consent, or Storage
-- directly. Staff policy definitions remain defense-in-depth; production
-- reviewer/admin writes cross the trusted server boundary as well.
revoke insert, update, delete on public.documents from authenticated;
revoke insert on public.consent from authenticated;
drop policy if exists documents_verified_resident_insert on public.documents;
drop policy if exists consent_owner_insert on public.consent;
create policy consent_staff_insert on public.consent for insert to authenticated
  with check (
    public.civya_is_staff(consent.tenant_id)
    and exists (
      select 1 from public.residents r
      where r.id = consent.resident_id and r.tenant_id = consent.tenant_id
    )
    and (
      consent.case_id is null
      or exists (
        select 1 from public.cases c
        where c.id = consent.case_id
          and c.tenant_id = consent.tenant_id
          and c.resident_id = consent.resident_id
      )
    )
  );

drop policy if exists civya_storage_verified_insert on storage.objects;
drop policy if exists civya_storage_member_delete on storage.objects;
create policy civya_storage_staff_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'civya-private-documents'
    and public.civya_can_access_storage_object(name)
    and public.civya_is_staff(
      substring(name from '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/')::uuid
    )
  );
create policy civya_storage_staff_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'civya-private-documents'
    and public.civya_can_access_storage_object(name)
    and public.civya_is_staff(
      substring(name from '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/')::uuid
    )
  );

-- Object reads must honor scan state even when a resident calls Supabase
-- Storage directly instead of the signed-download application route. Staff
-- retain access to pending/quarantined objects for the explicit review flow.
create or replace function public.civya_can_read_storage_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, private
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
    select 1
    from public.documents d
    join public.cases c on c.id = d.case_id
    join public.residents r on r.id = d.resident_id
    where d.storage_bucket = 'civya-private-documents'
      and d.storage_path = p_name
      and d.tenant_id = v_tenant_id
      and d.resident_id = v_resident_id
      and d.case_id = v_case_id
      and c.tenant_id = d.tenant_id
      and c.resident_id = d.resident_id
      and (
        private.civya_actor_is_staff(auth.uid(), d.tenant_id)
        or (
          r.auth_user_id = auth.uid()
          and private.civya_has_tenant_access(auth.uid(), d.tenant_id)
          and d.scan_status = 'clean'
        )
      )
  );
exception when others then
  return false;
end;
$$;

revoke all on function public.civya_can_read_storage_object(text) from public, anon;
grant execute on function public.civya_can_read_storage_object(text) to authenticated, service_role;

drop policy if exists civya_storage_member_read on storage.objects;
create policy civya_storage_clean_or_staff_read on storage.objects for select to authenticated
  using (
    bucket_id = 'civya-private-documents'
    and public.civya_can_read_storage_object(name)
  );
