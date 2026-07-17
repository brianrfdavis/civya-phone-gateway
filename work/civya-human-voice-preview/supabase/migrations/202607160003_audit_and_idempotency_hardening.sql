-- Hardening discovered during route integration: audit writes stay behind an
-- ownership-checking RPC, and provider/client retries return the original turn.

create or replace function public.civya_append_turn(
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
set search_path = public
as $$
declare v_conversation public.conversations%rowtype; v_turn public.turns%rowtype; v_inserted boolean := true;
begin
  select * into v_conversation from public.conversations where id = p_conversation_id;
  if not found or not public.civya_can_access_case(v_conversation.case_id) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  if length(trim(p_redacted_text)) = 0 or length(p_redacted_text) > 12000 then raise exception 'invalid redacted transcript'; end if;

  insert into public.turns (
    tenant_id, resident_id, case_id, conversation_id, speaker, channel,
    provider_item_id, client_turn_id, idempotency_key, redacted_text
  ) values (
    v_conversation.tenant_id, v_conversation.resident_id, v_conversation.case_id,
    v_conversation.id, p_speaker, p_channel, nullif(p_provider_item_id, ''),
    p_client_turn_id, p_idempotency_key, p_redacted_text
  )
  on conflict do nothing
  returning * into v_turn;

  if not found then
    v_inserted := false;
    select * into v_turn from public.turns
      where conversation_id = p_conversation_id
        and (
          idempotency_key = p_idempotency_key
          or (client_turn_id = p_client_turn_id and speaker = p_speaker)
          or (provider_item_id = nullif(p_provider_item_id, '') and speaker = p_speaker)
        )
      order by sequence_number
      limit 1;
    if not found then raise exception 'turn conflict could not be resolved' using errcode = '40001'; end if;
  else
    update public.conversations set last_turn_at = now(), row_version = row_version + 1
      where id = p_conversation_id;
  end if;
  return jsonb_build_object('turn', to_jsonb(v_turn), 'duplicate', not v_inserted);
end;
$$;

create or replace function public.civya_append_audit_event(
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
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.uid() is null and auth.role() <> 'service_role' then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_case_id is not null and not public.civya_can_access_case(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_case_id is null and p_resident_id is not null
     and not (public.civya_owns_resident(p_resident_id) or public.civya_is_staff(p_tenant_id)) then
    raise exception 'resident not found' using errcode = 'P0002';
  end if;
  if p_source = 'admin' and auth.role() <> 'service_role' and not public.civya_is_staff(p_tenant_id, 'admin') then
    raise exception 'admin required' using errcode = '42501';
  end if;
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id, event_type,
    redacted_payload, source, request_id
  ) values (
    p_tenant_id, p_resident_id, p_case_id, auth.uid(), p_event_type,
    coalesce(p_redacted_payload, '{}'::jsonb), p_source, p_request_id
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.civya_append_audit_event(uuid, uuid, uuid, text, jsonb, text, text) from public;
grant execute on function public.civya_append_audit_event(uuid, uuid, uuid, text, jsonb, text, text) to authenticated, service_role;
