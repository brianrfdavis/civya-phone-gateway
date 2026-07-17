-- Admin reset for the fictional sandbox. It preserves the tenant, versioned
-- scenarios, staff roles, and invitations; only resident-created demo data is
-- removed. There is deliberately no global reset function.

create or replace function public.civya_reset_tenant_sandbox(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_tenant public.tenants%rowtype; v_residents bigint; v_cases bigint;
begin
  select * into v_tenant from public.tenants
    where slug = p_tenant_slug and environment = 'sandbox' and fictional
    for update;
  if not found then raise exception 'fictional sandbox tenant not found' using errcode = 'P0002'; end if;
  if auth.role() <> 'service_role' and not public.civya_is_staff(v_tenant.id, 'admin') then
    raise exception 'tenant admin required' using errcode = '42501';
  end if;

  select count(*) into v_residents from public.residents where tenant_id = v_tenant.id;
  select count(*) into v_cases from public.cases where tenant_id = v_tenant.id;
  delete from public.audit_events where tenant_id = v_tenant.id;
  delete from public.residents where tenant_id = v_tenant.id;
  delete from private.case_transfer_grants where tenant_id = v_tenant.id;

  insert into public.audit_events (
    tenant_id, actor_user_id, event_type, redacted_payload, source
  ) values (
    v_tenant.id, auth.uid(), 'fictional_tenant_reset',
    jsonb_build_object('residentsRemoved', v_residents, 'casesRemoved', v_cases), 'admin'
  );
  return jsonb_build_object(
    'tenantId', v_tenant.id, 'tenantSlug', v_tenant.slug,
    'residentsRemoved', v_residents, 'casesRemoved', v_cases
  );
end;
$$;

revoke all on function public.civya_reset_tenant_sandbox(text) from public;
grant execute on function public.civya_reset_tenant_sandbox(text) to authenticated, service_role;
