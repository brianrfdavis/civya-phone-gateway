-- Preserve the short expiry for an unconsumed case choice while allowing a
-- committed choice to be recovered after an HTTP response is lost. A replay
-- is accepted only for the exact original choice and still has to pass the
-- current proof, entitlement row-version, active-case, and tenant checks.

create or replace function public.civya_service_select_entitled_case(
  p_actor_user_id uuid,
  p_selection_id uuid,
  p_selected_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_selection private.case_entitlement_selections%rowtype;
  v_selected_entitlement_id uuid;
  v_entitlement public.case_entitlements%rowtype;
  v_result jsonb;
begin
  perform private.civya_service_required();
  select * into v_selection from private.case_entitlement_selections
  where id = p_selection_id and auth_user_id = p_actor_user_id
  for update;
  if not found
     or (v_selection.used_at is null and v_selection.expires_at <= now())
     or p_selected_case_id not in (
       v_selection.attached_case_id, v_selection.existing_case_id
     ) then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;
  v_selected_entitlement_id := case
    when p_selected_case_id = v_selection.attached_case_id
      then v_selection.attached_entitlement_id
    else v_selection.existing_entitlement_id
  end;

  if v_selection.used_at is not null then
    if v_selection.selected_case_id <> p_selected_case_id then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
    if v_selection.access_type = 'case_entitlement' then
      select * into v_entitlement from public.case_entitlements
      where id = v_selected_entitlement_id;
      if not found or not private.civya_entitlement_has_current_proof(v_entitlement.id) then
        raise exception 'case selection rejected' using errcode = '28000';
      end if;
      v_result := public.civya_service_case_entitlement_cache_status(
        p_actor_user_id, v_entitlement.id, v_entitlement.row_version,
        v_selection.tenant_id, p_selected_case_id,
        v_selection.purpose, v_selection.scopes
      );
    else
      v_result := public.civya_service_case_entitlement_cache_status(
        p_actor_user_id, null, 0, v_selection.tenant_id,
        p_selected_case_id, v_selection.purpose, v_selection.scopes
      );
    end if;
    if not coalesce((v_result ->> 'authorized')::boolean, false) then
      raise exception 'case selection rejected' using errcode = '28000';
    end if;
    return v_result || jsonb_build_object('casesMerged', false, 'duplicate', true);
  end if;

  if v_selection.access_type = 'case_entitlement'
     and not private.civya_entitlement_has_current_proof(v_selected_entitlement_id) then
    raise exception 'case selection rejected' using errcode = '28000';
  end if;
  v_result := public.civya_service_select_entitled_case_unchecked(
    p_actor_user_id, p_selection_id, p_selected_case_id
  );
  return v_result || jsonb_build_object('duplicate', false);
end;
$$;

revoke all on function public.civya_service_select_entitled_case(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.civya_service_select_entitled_case(uuid, uuid, uuid)
  to service_role;

comment on function public.civya_service_select_entitled_case(uuid, uuid, uuid) is
  'Exact case choice. Unused choices expire; a committed choice is replayable only while its authoritative access remains current.';
