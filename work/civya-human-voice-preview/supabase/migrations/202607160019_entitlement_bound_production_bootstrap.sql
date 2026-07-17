-- Exact, service-only bootstrap for an already-claimed production case.
--
-- This function is deliberately separate from the fictional sandbox
-- bootstrap. It cannot create or reassign a resident or case. The browser's
-- encrypted grant supplies one exact case/entitlement pair, and the database
-- revalidates the complete account -> resident -> case -> proof -> entitlement
-- chain on every bootstrap before it gets or creates that case's conversation.

create or replace function public.civya_service_bootstrap_entitled_production_case(
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_is_anonymous boolean,
  p_actor_is_verified boolean,
  p_case_id uuid,
  p_entitlement_id uuid,
  p_channel text default 'voice'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_tenant public.tenants%rowtype;
  v_resident public.residents%rowtype;
  v_case public.cases%rowtype;
  v_entitlement public.case_entitlements%rowtype;
  v_conversation public.conversations%rowtype;
  v_facts jsonb;
  v_turns jsonb;
begin
  perform private.civya_service_required();

  -- The authenticated account must still exist and match the confirmed email
  -- identity represented by the server-side session. Service credentials
  -- alone are not a resident entitlement.
  if p_actor_user_id is null
     or p_entitlement_id is null
     or p_case_id is null
     or p_actor_is_anonymous
     or not p_actor_is_verified
     or nullif(trim(p_actor_email), '') is null
     or not exists (
       select 1 from auth.users u
       where u.id = p_actor_user_id
         and nullif(u.email, '') is not null
         and lower(u.email) = lower(trim(p_actor_email))
     ) then
    raise exception 'entitled production bootstrap rejected'
      using errcode = '28000';
  end if;
  if p_channel not in ('voice', 'chat', 'sms', 'email') then
    raise exception 'entitled production bootstrap rejected'
      using errcode = '28000';
  end if;

  -- Locking the exact case serializes the partial-unique conversation
  -- get-or-create. No case or resident row is inserted or updated here.
  select * into v_case
  from public.cases c
  where c.id = p_case_id and c.active
  for update;
  if not found then
    raise exception 'entitled production bootstrap rejected'
      using errcode = 'P0002';
  end if;

  select * into v_tenant
  from public.tenants t
  where t.id = v_case.tenant_id
    and t.status = 'active'
    and t.environment = 'production'
    and not t.fictional;
  if not found then
    raise exception 'entitled production bootstrap rejected'
      using errcode = 'P0002';
  end if;

  select * into v_resident
  from public.residents r
  where r.id = v_case.resident_id
    and r.tenant_id = v_tenant.id
    and r.auth_user_id = p_actor_user_id
    and r.identity_state = 'verified';
  if not found then
    raise exception 'entitled production bootstrap rejected'
      using errcode = 'P0002';
  end if;

  select e.* into v_entitlement
  from public.case_entitlements e
  join public.identity_proof_challenges p
    on p.id = e.proof_challenge_id
  where e.id = p_entitlement_id
    and e.tenant_id = v_tenant.id
    and e.case_id = v_case.id
    and e.resident_id = v_resident.id
    and e.auth_user_id = p_actor_user_id
    and e.state = 'active'
    and e.expires_at > now()
    and e.assurance_level in ('substantial', 'high')
    and array['case.read', 'case.participate']::text[] <@ e.scopes
    and p.tenant_id = v_tenant.id
    and p.case_id = v_case.id
    and p.resident_id = v_resident.id
    and p.auth_user_id = p_actor_user_id
    and p.state = 'verified'
    and p.expires_at > now()
    and p.assurance_level in ('substantial', 'high')
    and p.evidence_digest = e.evidence_digest;
  if not found then
    raise exception 'entitled production bootstrap rejected'
      using errcode = 'P0002';
  end if;

  select * into v_conversation
  from public.conversations c
  where c.tenant_id = v_tenant.id
    and c.resident_id = v_resident.id
    and c.case_id = v_case.id
    and c.channel = p_channel
    and c.status = 'active'
  for update;
  if not found then
    insert into public.conversations (tenant_id, resident_id, case_id, channel)
    values (v_tenant.id, v_resident.id, v_case.id, p_channel)
    returning * into v_conversation;
  end if;

  select coalesce(jsonb_object_agg(f.fact_key, f.fact_value), '{}'::jsonb)
  into v_facts
  from public.case_facts f
  where f.tenant_id = v_tenant.id
    and f.resident_id = v_resident.id
    and f.case_id = v_case.id
    and f.confirmation_state = 'confirmed';

  -- Cross-channel resume remains confined to this one entitled case.
  select coalesce(
    jsonb_agg(to_jsonb(recent_turns) order by recent_turns.sequence_number),
    '[]'::jsonb
  ) into v_turns
  from (
    select tr.id, tr.speaker, tr.channel, tr.redacted_text as text,
      tr.created_at, tr.sequence_number
    from public.turns tr
    where tr.tenant_id = v_tenant.id
      and tr.resident_id = v_resident.id
      and tr.case_id = v_case.id
      and tr.processing_status <> 'failed'
    order by tr.sequence_number desc
    limit 6
  ) recent_turns;

  return jsonb_build_object(
    'authentication', jsonb_build_object(
      'userId', p_actor_user_id,
      'isAnonymous', false,
      'isVerified', true,
      'email', p_actor_email
    ),
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'environment', v_tenant.environment,
      'fictional', false,
      'retentionDays', v_tenant.retention_days
    ),
    'resident', jsonb_build_object(
      'id', v_resident.id,
      'identityState', v_resident.identity_state
    ),
    'activeCase', jsonb_build_object(
      'id', v_case.id,
      'status', v_case.status,
      'rowVersion', v_case.row_version,
      'workflowState', v_case.workflow_state,
      'nextQuestion', v_case.next_question,
      'nextBestAction', case
        when v_case.next_best_action ~* '(fictional|demo)'
          then coalesce(v_case.next_question, 'Continue the guided conversation.')
        else v_case.next_best_action
      end,
      'updatedAt', v_case.updated_at
    ),
    'conversation', jsonb_build_object(
      'id', v_conversation.id,
      'channel', v_conversation.channel,
      'status', v_conversation.status,
      'rowVersion', v_conversation.row_version
    ),
    'resumeContext', jsonb_build_object(
      'confirmedFacts', v_facts,
      'conversationSummary', coalesce(
        nullif(v_conversation.summary, ''),
        v_case.resume_summary,
        ''
      ),
      'recentTurns', v_turns,
      'currentWorkflowState', v_case.workflow_state,
      'nextQuestion', v_case.next_question
    ),
    'nextAction', jsonb_build_object(
      'kind', case when v_case.next_question is null then 'continue' else 'ask_question' end,
      'prompt', coalesce(
        v_case.next_question,
        case when v_case.next_best_action ~* '(fictional|demo)'
          then 'Continue the guided conversation.'
          else v_case.next_best_action
        end
      )
    ),
    'authorization', jsonb_build_object(
      'entitlementId', v_entitlement.id,
      'caseId', v_entitlement.case_id,
      'scopes', to_jsonb(v_entitlement.scopes),
      'expiresAt', v_entitlement.expires_at,
      'rowVersion', v_entitlement.row_version
    )
  );
end;
$$;

revoke all on function public.civya_service_bootstrap_entitled_production_case(
  uuid, text, boolean, boolean, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.civya_service_bootstrap_entitled_production_case(
  uuid, text, boolean, boolean, uuid, uuid, text
) to service_role;

comment on function public.civya_service_bootstrap_entitled_production_case(
  uuid, text, boolean, boolean, uuid, uuid, text
) is
  'Bootstraps only the exact active non-fictional production case and conversation authorized by an active verified-proof entitlement. It never creates or reassigns a resident or case.';
