-- One-time handoff for the case where an anonymous visitor enters an email
-- that already belongs to a verified account. The case is reassigned, never
-- merged. If the verified account already has an active case, both cases are
-- preserved and the caller must present a case-selection step.

create table if not exists private.case_transfer_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  created_by_auth_user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  claimed_by_auth_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists case_transfer_grants_expiry_idx
  on private.case_transfer_grants (expires_at) where used_at is null;

create or replace function public.civya_create_case_transfer_grant(
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
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not public.civya_can_access_case(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into v_case from public.cases where id = p_case_id;
  if not public.civya_owns_resident(v_case.resident_id) then raise exception 'resident ownership required' using errcode = '42501'; end if;
  if p_ttl_seconds < 60 or p_ttl_seconds > 900 then raise exception 'invalid transfer grant lifetime'; end if;

  delete from private.case_transfer_grants
    where created_by_auth_user_id = auth.uid() and used_at is null;
  insert into private.case_transfer_grants (
    tenant_id, source_resident_id, case_id, created_by_auth_user_id, token_hash, expires_at
  ) values (
    v_case.tenant_id, v_case.resident_id, v_case.id, auth.uid(), p_token_hash,
    now() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_grant;
  return jsonb_build_object('grantId', v_grant.id, 'expiresAt', v_grant.expires_at);
end;
$$;

create or replace function public.civya_redeem_case_transfer_grant(p_token_hash text)
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
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) then
    raise exception 'verified identity required' using errcode = '28000';
  end if;
  select * into v_grant from private.case_transfer_grants
    where token_hash = p_token_hash and used_at is null and expires_at > now()
    for update;
  if not found then raise exception 'transfer grant invalid or expired' using errcode = '28000'; end if;

  select * into v_source from public.residents where id = v_grant.source_resident_id for update;
  insert into public.residents (tenant_id, auth_user_id, identity_state, email)
  values (v_grant.tenant_id, auth.uid(), 'verified', nullif(auth.jwt() ->> 'email', ''))
  on conflict (tenant_id, auth_user_id) do update set
    identity_state = 'verified',
    email = coalesce(nullif(auth.jwt() ->> 'email', ''), public.residents.email),
    last_active_at = now(),
    row_version = public.residents.row_version + 1
  returning * into v_target;

  if v_target.id = v_source.id then
    update private.case_transfer_grants set used_at = now(), claimed_by_auth_user_id = auth.uid() where id = v_grant.id;
    return jsonb_build_object(
      'caseId', v_grant.case_id, 'residentId', v_target.id,
      'requiresCaseSelection', false, 'existingActiveCaseId', null
    );
  end if;

  select id into v_existing_case_id from public.cases
    where tenant_id = v_grant.tenant_id and resident_id = v_target.id and active and id <> v_grant.case_id
    for update;

  -- Preserve both cases. The already-verified account's current case stays
  -- active when present, and the claimed case is available for explicit selection.
  update public.cases set
    active = case when v_existing_case_id is null then active else false end,
    resident_id = v_target.id,
    row_version = row_version + 1
  where id = v_grant.case_id and resident_id = v_source.id;

  update public.conversations set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.turns set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.case_facts set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.documents set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.checklist_items set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.consent set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.review_tasks set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.reminders set resident_id = v_target.id where case_id = v_grant.case_id;
  update public.simulated_transactions set resident_id = v_target.id where case_id = v_grant.case_id;

  update private.case_transfer_grants set used_at = now(), claimed_by_auth_user_id = auth.uid()
    where id = v_grant.id;
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type, redacted_payload, source
  ) values (
    v_grant.tenant_id, v_target.id, v_grant.case_id, auth.uid(), 'case_attached_to_verified_account',
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

revoke all on function public.civya_create_case_transfer_grant(uuid, text, integer) from public;
revoke all on function public.civya_redeem_case_transfer_grant(text) from public;
grant execute on function public.civya_create_case_transfer_grant(uuid, text, integer) to authenticated;
grant execute on function public.civya_redeem_case_transfer_grant(text) to authenticated;
