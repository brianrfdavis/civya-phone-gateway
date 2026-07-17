-- Tenant-bound staff authentication preflight.
--
-- Email OTP delivery is permitted only when the address already belongs to a
-- confirmed Supabase identity with an active reviewer/admin role for the
-- exact active tenant resolved from the trusted request hostname. The
-- function is service-only so public callers cannot use it to enumerate
-- accounts, roles, or tenants.

create or replace function public.civya_service_authorize_staff_email(
  p_tenant_slug text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_result record;
begin
  perform private.civya_service_required();

  if p_tenant_slug is null
     or p_tenant_slug !~ '^[a-z0-9-]+$'
     or p_email is null
     or length(p_email) > 254 then
    return jsonb_build_object('authorized', false);
  end if;

  select
    sr.auth_user_id,
    sr.role,
    t.id as tenant_id,
    t.slug as tenant_slug,
    t.name as tenant_name,
    t.environment,
    t.fictional
  into v_result
  from public.staff_roles sr
  join public.tenants t on t.id = sr.tenant_id
  join auth.users u on u.id = sr.auth_user_id
  where t.slug = p_tenant_slug
    and t.status = 'active'
    and sr.status = 'active'
    and sr.role in ('reviewer', 'admin')
    and lower(coalesce(to_jsonb(u) ->> 'email', '')) = lower(trim(p_email))
    and coalesce(
      nullif(to_jsonb(u) ->> 'email_confirmed_at', ''),
      nullif(to_jsonb(u) ->> 'confirmed_at', '')
    ) is not null
  limit 1;

  if not found then
    return jsonb_build_object('authorized', false);
  end if;

  return jsonb_build_object(
    'authorized', true,
    'authUserId', v_result.auth_user_id,
    'role', v_result.role,
    'tenantId', v_result.tenant_id,
    'tenantSlug', v_result.tenant_slug,
    'tenantName', v_result.tenant_name,
    'environment', v_result.environment,
    'fictional', v_result.fictional
  );
end;
$$;

revoke all on function public.civya_service_authorize_staff_email(text, text)
  from public, anon, authenticated;
grant execute on function public.civya_service_authorize_staff_email(text, text)
  to service_role;

comment on function public.civya_service_authorize_staff_email(text, text) is
  'Service-only, non-enumerating staff OTP preflight bound to one active host-resolved tenant and one confirmed existing auth identity.';
