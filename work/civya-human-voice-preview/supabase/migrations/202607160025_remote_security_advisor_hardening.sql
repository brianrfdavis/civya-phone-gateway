-- Hosted-project security-advisor hardening.
--
-- Supabase can install a public SECURITY DEFINER helper when automatic RLS is
-- enabled for newly created tables. It is needed only as a database trigger;
-- browser roles must never be able to invoke it through the Data API. Keep the
-- migration conditional so the same corpus applies to PGlite and projects
-- where the platform helper is not installed.

alter function private.set_updated_at()
  set search_path = pg_catalog, public, private;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role';
    comment on function public.rls_auto_enable() is
      'Supabase automatic-RLS trigger helper. Direct Data API execution is revoked.';
  end if;
end;
$$;

