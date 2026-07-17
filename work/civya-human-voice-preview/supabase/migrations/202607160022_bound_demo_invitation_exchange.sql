-- Bind invitation consumption to the exact configured fictional tenant before
-- incrementing use_count. Browser clients must never be able to exhaust or
-- redeem invitations directly through the public API schema.

create or replace function public.civya_service_redeem_demo_invitation(
  p_token_hash text,
  p_expected_tenant_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_invite public.demo_invitations%rowtype;
  v_tenant public.tenants%rowtype;
begin
  perform private.civya_service_required();
  if p_token_hash !~ '^[0-9a-f]{64}$'
     or p_expected_tenant_slug !~ '^[a-z0-9-]+$' then
    raise exception 'invitation invalid or expired' using errcode = '28000';
  end if;

  select i.*
    into v_invite
  from public.demo_invitations i
  join public.tenants t on t.id = i.tenant_id
  where i.token_hash = p_token_hash
    and i.revoked_at is null
    and i.expires_at > now()
    and i.use_count < i.max_uses
    and t.slug = p_expected_tenant_slug
    and t.status = 'active'
    and t.environment = 'sandbox'
    and t.fictional
  for update of i;
  if not found then
    raise exception 'invitation invalid or expired' using errcode = '28000';
  end if;
  select * into strict v_tenant from public.tenants
  where id = v_invite.tenant_id;

  update public.demo_invitations
  set use_count = use_count + 1
  where id = v_invite.id
  returning * into v_invite;

  return jsonb_build_object(
    'invitationId', v_invite.id,
    'tenantId', v_tenant.id,
    'tenantSlug', v_tenant.slug,
    'scopes', to_jsonb(v_invite.scopes),
    'expiresAt', v_invite.expires_at
  );
end;
$$;

revoke all on function public.civya_redeem_invitation(text)
  from public, anon, authenticated, service_role;
revoke all on function public.civya_service_redeem_demo_invitation(text, text)
  from public, anon, authenticated;
grant execute on function public.civya_service_redeem_demo_invitation(text, text)
  to service_role;

comment on function public.civya_service_redeem_demo_invitation(text, text) is
  'Service-only, exact-tenant fictional invitation exchange. Tenant validation precedes use-count mutation.';
