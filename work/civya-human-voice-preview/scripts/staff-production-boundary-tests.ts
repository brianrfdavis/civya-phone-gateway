import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { resolveTenantSlug, TenantResolutionError } from "../lib/tenancy/resolve-tenant";
import type { RuntimeConfig } from "../lib/config/runtime";

const ROOT = process.cwd();
const MIGRATION = join(ROOT, "supabase/migrations/202607160020_tenant_bound_staff_access.sql");

const PROD_TENANT = "10000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "10000000-0000-4000-8000-000000000002";
const SANDBOX_TENANT = "10000000-0000-4000-8000-000000000003";
const SUSPENDED_TENANT = "10000000-0000-4000-8000-000000000004";
const PROD_ADMIN = "20000000-0000-4000-8000-000000000001";
const OTHER_REVIEWER = "20000000-0000-4000-8000-000000000002";
const NO_ROLE = "20000000-0000-4000-8000-000000000003";
const UNCONFIRMED = "20000000-0000-4000-8000-000000000004";
const SANDBOX_REVIEWER = "20000000-0000-4000-8000-000000000005";
const SUSPENDED_ADMIN = "20000000-0000-4000-8000-000000000006";

function pass(message: string): void {
  process.stdout.write(`✓ ${message}\n`);
}

async function source(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

async function authorize(db: PGlite, tenantSlug: string, email: string) {
  const result = await db.query<{ result: Record<string, unknown> }>(
    "select public.civya_service_authorize_staff_email($1, $2) as result",
    [tenantSlug, email],
  );
  return result.rows[0].result;
}

async function main(): Promise<void> {
  const config = {
    tenantHosts: { "staff.wayne.example": "wayne-county", localhost: "wayne-county-demo" },
  } as unknown as RuntimeConfig;
  assert.equal(resolveTenantSlug("STAFF.WAYNE.EXAMPLE:443", config), "wayne-county");
  assert.throws(
    () => resolveTenantSlug("unassigned.example", config),
    (error) => error instanceof TenantResolutionError && error.code === "unknown_tenant_host",
  );
  pass("trusted hostname resolution rejects an unassigned host and never falls back to a demo tenant");

  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema private;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz
    );
    create table public.tenants (
      id uuid primary key,
      slug text not null unique,
      name text not null,
      environment text not null,
      fictional boolean not null,
      status text not null
    );
    create table public.staff_roles (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references public.tenants(id),
      auth_user_id uuid not null references auth.users(id),
      role text not null,
      status text not null,
      unique (tenant_id, auth_user_id)
    );
    create or replace function private.civya_service_required()
    returns void language plpgsql as $$ begin return; end $$;
  `);
  await db.exec(await readFile(MIGRATION, "utf8"));
  await db.query(
    `insert into public.tenants (id, slug, name, environment, fictional, status) values
      ($1, 'wayne-county', 'Wayne County', 'production', false, 'active'),
      ($2, 'other-county', 'Other County', 'production', false, 'active'),
      ($3, 'wayne-county-demo', 'Wayne County Demo', 'sandbox', true, 'active'),
      ($4, 'suspended-county', 'Suspended County', 'production', false, 'suspended')`,
    [PROD_TENANT, OTHER_TENANT, SANDBOX_TENANT, SUSPENDED_TENANT],
  );
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at) values
      ($1, 'admin@wayne.example', now()),
      ($2, 'reviewer@other.example', now()),
      ($3, 'norole@wayne.example', now()),
      ($4, 'pending@wayne.example', null),
      ($5, 'reviewer@demo.example', now()),
      ($6, 'admin@suspended.example', now())`,
    [PROD_ADMIN, OTHER_REVIEWER, NO_ROLE, UNCONFIRMED, SANDBOX_REVIEWER, SUSPENDED_ADMIN],
  );
  await db.query(
    `insert into public.staff_roles (tenant_id, auth_user_id, role, status) values
      ($1, $2, 'admin', 'active'),
      ($3, $4, 'reviewer', 'active'),
      ($1, $5, 'reviewer', 'active'),
      ($6, $7, 'reviewer', 'active'),
      ($8, $9, 'admin', 'active')`,
    [
      PROD_TENANT, PROD_ADMIN,
      OTHER_TENANT, OTHER_REVIEWER,
      UNCONFIRMED,
      SANDBOX_TENANT, SANDBOX_REVIEWER,
      SUSPENDED_TENANT, SUSPENDED_ADMIN,
    ],
  );

  const production = await authorize(db, "wayne-county", "ADMIN@WAYNE.EXAMPLE");
  assert.equal(production.authorized, true);
  assert.equal(production.tenantSlug, "wayne-county");
  assert.equal(production.fictional, false);
  assert.equal(production.environment, "production");
  pass("a confirmed active production administrator is authorized only for the exact tenant");

  assert.equal((await authorize(db, "other-county", "admin@wayne.example")).authorized, false);
  assert.equal((await authorize(db, "wayne-county", "reviewer@other.example")).authorized, false);
  assert.equal((await authorize(db, "wayne-county", "norole@wayne.example")).authorized, false);
  assert.equal((await authorize(db, "wayne-county", "pending@wayne.example")).authorized, false);
  assert.equal((await authorize(db, "suspended-county", "admin@suspended.example")).authorized, false);
  pass("cross-tenant, no-role, unconfirmed, and suspended-tenant identities fail closed");

  const sandbox = await authorize(db, "wayne-county-demo", "reviewer@demo.example");
  assert.equal(sandbox.authorized, true);
  assert.equal(sandbox.fictional, true);
  assert.equal(sandbox.environment, "sandbox");
  pass("fictional sandbox authorization remains explicit and distinguishable from production");

  const startRoute = await source("app/api/staff/auth/start/route.ts");
  assert.match(startRoute, /authorizeStaffEmail\(tenantSlug, email\)/);
  assert.match(startRoute, /authorization\.authorized && authorization\.tenantSlug === tenantSlug/);
  assert.match(startRoute, /shouldCreateUser:\s*false/);
  assert.doesNotMatch(startRoute, /message:.*authorization\./);
  assert.ok(startRoute.indexOf("authorizeStaffEmail") < startRoute.indexOf("signInWithOtp"));
  pass("OTP start preflights an exact role, never creates users, and returns no authorization detail");

  const verifyRoute = await source("app/api/staff/auth/verify/route.ts");
  assert.match(verifyRoute, /resolveStaffTenantSlug\(req\.headers\.get\("host"\)\)/);
  assert.match(verifyRoute, /state\.tenantSlug !== expectedTenant/);
  assert.match(verifyRoute, /principal\.isAnonymous \|\| !principal\.isVerified/);
  pass("OTP verification rebinds the challenge, confirmed identity, and role to the current hostname");

  const guards = await source("lib/security/guards.ts");
  assert.match(guards, /resolveStaffTenantSlug\(host\)/);
  assert.match(guards, /staffBootstrap\(platform, tenantSlug\)/);
  const invitations = await source("app/api/admin/invitations/route.ts");
  const seed = await source("app/api/admin/seed/route.ts");
  const reminders = await source("app/api/admin/reminders/run/route.ts");
  for (const guarded of [invitations, seed, reminders]) {
    assert.match(guarded, /!staff\.tenant\.fictional \|\| staff\.tenant\.environment !== "sandbox"/);
  }
  pass("demo invitation, seed/reset, and simulated reminder mutations fail closed outside the sandbox");

  const casesRoute = await source("app/api/admin/cases/route.ts");
  assert.match(casesRoute, /staff\.tenant\.fictional[\s\S]+simulated_transactions/);
  assert.match(casesRoute, /staff\.tenant\.fictional \? "Fictional guided review" : "County guided review"/);
  const workflowRoute = await source("app/api/v1/staff/workflows/[workflowInstanceId]/actions/route.ts");
  assert.match(workflowRoute, /before\.tenantId !== staff\.tenant\.id/);
  pass("production case output excludes simulated transactions and workflow mutations enforce host tenant scope");

  const staffPage = await source("app/staff/page.tsx");
  const operationsPage = await source("app/staff/operations/page.tsx");
  assert.match(staffPage, /fictional\s*\?/);
  assert.match(operationsPage, /County source/);
  assert.match(operationsPage, /Payment handoff/);
  assert.match(operationsPage, /Identity proofing/);
  pass("staff UI separates fictional copy from production and labels inactive external integrations truthfully");

  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
