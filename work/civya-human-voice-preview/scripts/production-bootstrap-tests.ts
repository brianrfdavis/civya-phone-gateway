#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const MIGRATION = "202607160019_entitlement_bound_production_bootstrap.sql";

const TENANT = "a1000000-0000-4000-8000-000000000001";
const USER_A = "a2000000-0000-4000-8000-000000000001";
const USER_B = "a2000000-0000-4000-8000-000000000002";
const RESIDENT_A = "a3000000-0000-4000-8000-000000000001";
const RESIDENT_B = "a3000000-0000-4000-8000-000000000002";
const CASE_A = "a4000000-0000-4000-8000-000000000001";
const CASE_B = "a4000000-0000-4000-8000-000000000002";
const PROOF_A = "a5000000-0000-4000-8000-000000000001";
const PROOF_B = "a5000000-0000-4000-8000-000000000002";
const ENTITLEMENT_A = "a6000000-0000-4000-8000-000000000001";
const ENTITLEMENT_B = "a6000000-0000-4000-8000-000000000002";
const SCOPES = ["case.read", "case.participate", "document.read", "document.upload"];
const db = new PGlite();

function pass(message: string) {
  console.log(`  PASS  ${message}`);
}

async function setRole(role: "service_role" | "authenticated", userId = "") {
  await db.query(
    `select set_config('request.jwt.claim.role', $1, false),
            set_config('request.jwt.claim.sub', $2, false),
            set_config('request.jwt.claim.is_anonymous', 'false', false)`,
    [role, userId],
  );
}

async function prepareDatabase() {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema storage;
    create table auth.users (
      id uuid primary key, email text,
      raw_app_meta_data jsonb not null default '{}'::jsonb
    );
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select jsonb_build_object('is_anonymous', false)
    $$;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role')
    $$;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null
    );
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated, service_role;
    grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
  `);
  const migrations = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    let sql = await readFile(join(MIGRATIONS, name), "utf8");
    sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, "");
    try {
      await db.exec(sql);
    } catch (error) {
      if (error instanceof Error) error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  assert.ok(migrations.includes(MIGRATION));
  pass("all migrations apply with the production bootstrap boundary present");
}

async function seed() {
  await db.query(
    `insert into auth.users (id, email) values
       ($1::uuid, 'resident-a@example.test'),
       ($2::uuid, 'resident-b@example.test')`,
    [USER_A, USER_B],
  );
  await db.query(
    `insert into public.tenants (
       id, slug, name, environment, fictional, status, content_version, retention_days
     ) values ($1::uuid, 'wayne-county-production', 'Wayne County',
       'production', false, 'active', 'v1', 365)`,
    [TENANT],
  );
  await db.query(
    `insert into public.residents (
       id, tenant_id, auth_user_id, identity_state, email
     ) values
       ($1::uuid, $3::uuid, $4::uuid, 'verified', 'resident-a@example.test'),
       ($2::uuid, $3::uuid, $5::uuid, 'verified', 'resident-b@example.test')`,
    [RESIDENT_A, RESIDENT_B, TENANT, USER_A, USER_B],
  );
  await db.query(
    `insert into public.cases (id, tenant_id, resident_id) values
       ($1::uuid, $3::uuid, $4::uuid),
       ($2::uuid, $3::uuid, $5::uuid)`,
    [CASE_A, CASE_B, TENANT, RESIDENT_A, RESIDENT_B],
  );

  const future = new Date(Date.now() + 20 * 60_000).toISOString();
  const oldCreated = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const expired = new Date(Date.now() - 60 * 60_000).toISOString();
  await db.query(
    `insert into public.identity_proof_challenges (
       id, tenant_id, resident_id, case_id, auth_user_id, method, provider_key,
       challenge_digest, state, assurance_level, evidence_digest,
       provider_reference, attempt_count, expires_at, verified_at, resolved_at,
       idempotency_key, created_at
     ) values
       ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'county_notice',
        'wayne_county_case_entitlement', $9, 'verified', 'substantial', $10,
        'sha256:a', 1, $11::timestamptz, now(), now(), 'proof-a', now()),
       ($2::uuid, $3::uuid, $7::uuid, $8::uuid, $12::uuid, 'county_notice',
        'wayne_county_case_entitlement', $13, 'verified', 'substantial', $14,
        'sha256:b', 1, $15::timestamptz, $16::timestamptz, $16::timestamptz,
        'proof-b', $16::timestamptz)`,
    [
      PROOF_A, PROOF_B, TENANT, RESIDENT_A, CASE_A, USER_A, RESIDENT_B, CASE_B,
      "1".repeat(64), "2".repeat(64), future, USER_B, "3".repeat(64),
      "4".repeat(64), expired, oldCreated,
    ],
  );
  await db.query(
    `insert into public.case_entitlements (
       id, tenant_id, case_id, resident_id, auth_user_id, proof_challenge_id,
       scopes, assurance_level, state, granted_by_type, grant_reason_code,
       evidence_digest, granted_at, expires_at, idempotency_key
     ) values
       ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
        $11::text[], 'substantial', 'active', 'provider', 'verified_identity',
        $12, now(), $13::timestamptz, 'entitlement-a'),
       ($2::uuid, $3::uuid, $8::uuid, $9::uuid, $10::uuid, $14::uuid,
        $11::text[], 'substantial', 'expired', 'provider', 'verified_identity',
        $15, $16::timestamptz, $17::timestamptz, 'entitlement-b')`,
    [
      ENTITLEMENT_A, ENTITLEMENT_B, TENANT, CASE_A, RESIDENT_A, USER_A, PROOF_A,
      CASE_B, RESIDENT_B, USER_B, SCOPES, "2".repeat(64), future, PROOF_B,
      "4".repeat(64), oldCreated, expired,
    ],
  );
}

async function bootstrap(input: { userId: string; email: string; caseId: string; entitlementId: string }) {
  const result = await db.query<{ value: Record<string, any> }>(
    `select public.civya_service_bootstrap_entitled_production_case(
       $1::uuid, $2, false, true, $3::uuid, $4::uuid, 'voice'
     ) as value`,
    [input.userId, input.email, input.caseId, input.entitlementId],
  );
  return result.rows[0].value;
}

async function testBoundReplay() {
  await setRole("authenticated", USER_A);
  await assert.rejects(
    bootstrap({ userId: USER_A, email: "resident-a@example.test", caseId: CASE_A, entitlementId: ENTITLEMENT_A }),
    (error: { code?: string }) => error.code === "42501",
  );
  await setRole("service_role");
  const first = await bootstrap({ userId: USER_A, email: "resident-a@example.test", caseId: CASE_A, entitlementId: ENTITLEMENT_A });
  const replay = await bootstrap({ userId: USER_A, email: "resident-a@example.test", caseId: CASE_A, entitlementId: ENTITLEMENT_A });
  assert.equal(first.activeCase.id, CASE_A);
  assert.equal(first.authorization.entitlementId, ENTITLEMENT_A);
  assert.equal(first.conversation.id, replay.conversation.id);
  assert.equal(first.tenant.environment, "production");
  assert.equal(first.tenant.fictional, false);
  assert.doesNotMatch(first.activeCase.nextBestAction, /fictional|demo/i);
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from public.conversations where case_id = $1::uuid",
    [CASE_A],
  )).rows[0].count, 1);
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from public.cases",
  )).rows[0].count, 2);
  pass("service-only replay returns one exact non-fictional case conversation without creating a case");
}

async function testWrongBindingsAndLifecycle() {
  await assert.rejects(
    bootstrap({ userId: USER_B, email: "resident-b@example.test", caseId: CASE_A, entitlementId: ENTITLEMENT_A }),
    (error: { code?: string }) => error.code === "P0002",
  );
  await assert.rejects(
    bootstrap({ userId: USER_A, email: "resident-a@example.test", caseId: CASE_B, entitlementId: ENTITLEMENT_A }),
    (error: { code?: string }) => error.code === "P0002",
  );
  await assert.rejects(
    bootstrap({ userId: USER_B, email: "resident-b@example.test", caseId: CASE_B, entitlementId: ENTITLEMENT_B }),
    (error: { code?: string }) => error.code === "P0002",
  );
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from public.conversations where case_id = $1::uuid",
    [CASE_B],
  )).rows[0].count, 0);
  await db.query(
    `update public.case_entitlements set state = 'revoked', revoked_at = now(),
       revocation_reason = 'test_revocation', row_version = row_version + 1
     where id = $1::uuid`,
    [ENTITLEMENT_A],
  );
  await assert.rejects(
    bootstrap({ userId: USER_A, email: "resident-a@example.test", caseId: CASE_A, entitlementId: ENTITLEMENT_A }),
    (error: { code?: string }) => error.code === "P0002",
  );
  pass("wrong user, wrong case, expired, and revoked entitlement attempts fail closed");
}

async function testStaticBoundaries() {
  const migration = await readFile(join(MIGRATIONS, MIGRATION), "utf8");
  assert.doesNotMatch(migration, /insert\s+into\s+public\.(?:cases|residents)/i);
  assert.match(migration, /insert\s+into\s+public\.conversations/i);
  assert.match(migration, /e\.id = p_entitlement_id/);
  assert.match(migration, /e\.case_id = v_case\.id/);
  assert.match(migration, /p\.state = 'verified'/);
  assert.match(migration, /e\.state = 'active'/);
  const repository = await readFile(join(ROOT, "lib/platform/repository.ts"), "utf8");
  assert.match(repository, /bootstrapEntitledProductionCase/);
  assert.match(repository, /civya_service_bootstrap_entitled_production_case/);
  for (const route of ["app/api/bootstrap/route.ts", "app/api/conversations/turn/route.ts"]) {
    const source = await readFile(join(ROOT, route), "utf8");
    assert.match(source, /runtimeConfig\.environment === "production"/);
    assert.match(source, /bootstrapEntitledProductionCase/);
  }
  for (const route of [
    "app/api/tools/case-mgmt/route.ts",
    "app/api/tools/property-status/route.ts",
    "app/api/tools/resident-case/route.ts",
    "app/api/tools/document-checklist/route.ts",
    "app/api/tools/eligibility/route.ts",
  ]) {
    assert.match(await readFile(join(ROOT, route), "utf8"), /assertSyntheticSandboxCase\(entitlement\.caseId\)/);
  }
  const grant = await readFile(join(ROOT, "lib/entitlement/grant.ts"), "utf8");
  assert.match(grant, /caseBindingHash/);
  assert.match(grant, /grantIdHash/);
  assert.match(grant, /hashOpaqueReference\(grant\.caseId\)/);
  assert.match(grant, /hashOpaqueReference\(grant\.entitlementId\)/);
  pass("routes, encrypted grant hashes, repository, and demo-only tool guards are statically bound");
}

async function main() {
  console.log("Entitlement-bound production resident bootstrap");
  await prepareDatabase();
  await seed();
  await testBoundReplay();
  await testWrongBindingsAndLifecycle();
  await testStaticBoundaries();
  console.log("\nAll entitlement-bound production bootstrap tests passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
