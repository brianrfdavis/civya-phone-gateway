#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const MIGRATION = "202607160016_verified_production_case_claim.sql";

const TENANT_A = "91000000-0000-4000-8000-000000000001";
const TENANT_B = "91000000-0000-4000-8000-000000000002";
const TENANT_SANDBOX = "91000000-0000-4000-8000-000000000003";
const USER_A = "92000000-0000-4000-8000-000000000001";
const USER_B = "92000000-0000-4000-8000-000000000002";
const USER_C = "92000000-0000-4000-8000-000000000003";

const RESIDENT_FIRST = "93000000-0000-4000-8000-000000000001";
const RESIDENT_CONCURRENT = "93000000-0000-4000-8000-000000000002";
const RESIDENT_REUSE = "93000000-0000-4000-8000-000000000003";
const RESIDENT_LINKED = "93000000-0000-4000-8000-000000000004";
const RESIDENT_OTHER = "93000000-0000-4000-8000-000000000005";
const RESIDENT_SANDBOX = "93000000-0000-4000-8000-000000000006";

const CASE_FIRST = "94000000-0000-4000-8000-000000000001";
const CASE_CONCURRENT = "94000000-0000-4000-8000-000000000002";
const CASE_REUSE = "94000000-0000-4000-8000-000000000003";
const CASE_LINKED = "94000000-0000-4000-8000-000000000004";
const CASE_OTHER = "94000000-0000-4000-8000-000000000005";
const CASE_SANDBOX = "94000000-0000-4000-8000-000000000006";

const PROVIDER = "wayne_county_case_entitlement";
const FIRST_DIGEST = "a".repeat(64);
const CONCURRENT_DIGEST = "b".repeat(64);
const FAILED_DIGEST = "c".repeat(64);
const LINKED_DIGEST = "d".repeat(64);
const SANDBOX_DIGEST = "e".repeat(64);
const OTHER_DIGEST = "f".repeat(64);
const TRANSFER_DIGEST = "1".repeat(64);
const FINALIZER_DIGEST = "2".repeat(64);
const RECOVERY_NONCE_DIGEST = "3".repeat(64);
const DIRECT_FINALIZER_DIGEST = "5".repeat(64);
const SCOPES = ["case.read", "case.participate", "document.read", "document.upload"];
const db = new PGlite();

function pass(message: string) {
  console.log(`  PASS  ${message}`);
}

async function setRoleClaim(role: "service_role" | "authenticated", userId = "") {
  await db.query(
    `select set_config('request.jwt.claim.role', $1, false),
            set_config('request.jwt.claim.sub', $2, false),
            set_config('request.jwt.claim.is_anonymous', 'false', false)`,
    [role, userId],
  );
}

async function installDatabase(target: PGlite, throughMigration?: string) {
  await target.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema storage;
    create table auth.users (
      id uuid primary key,
      email text,
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

  const migrations = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith(".sql") && (!throughMigration || name <= throughMigration))
    .sort();
  for (const name of migrations) {
    let sql = await readFile(join(MIGRATIONS, name), "utf8");
    sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, "");
    try {
      await target.exec(sql);
    } catch (error) {
      if (error instanceof Error) error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  return migrations;
}

async function prepareDatabase() {
  const migrations = await installDatabase(db);
  assert.ok(migrations.includes(MIGRATION), "The atomic production case-claim migration must be present.");

  const claimMigration = await readFile(join(MIGRATIONS, MIGRATION), "utf8");
  assert.doesNotMatch(claimMigration, /\b(?:create|drop)\s+policy\b/i);
  assert.match(claimMigration, /from public, anon, authenticated/);
  assert.match(claimMigration, /to service_role/);
  pass("all current migrations apply, and the atomic claim boundary adds no replacement RLS policies");
}

async function testRetainedSchemaProofLifecycleUpgrade() {
  const retained = new PGlite();
  await installDatabase(retained, "202607160022_bound_demo_invitation_exchange.sql");
  // Model an estate that already retained the pre-hardening 013 definition.
  await retained.exec(`
    create or replace function private.civya_active_case_entitlement(
      p_actor_user_id uuid, p_case_id uuid, p_scope text default 'case.read'
    ) returns boolean language sql stable security definer
      set search_path = pg_catalog, public, private as $$
      select exists (
        select 1 from public.case_entitlements e
        where e.auth_user_id = p_actor_user_id and e.case_id = p_case_id
          and e.state = 'active' and e.expires_at > now()
          and p_scope = any(e.scopes)
      )
    $$;
  `);
  const forwardMigrations = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith(".sql")
      && name > "202607160022_bound_demo_invitation_exchange.sql")
    .sort();
  assert.ok(
    forwardMigrations.includes("202607160023_proof_lifecycle_and_entitlement_handoff.sql"),
    "The proof-lifecycle repair must be a forward migration.",
  );
  const proofLifecycleUpgrade = await readFile(
    join(MIGRATIONS, "202607160023_proof_lifecycle_and_entitlement_handoff.sql"),
    "utf8",
  );
  for (const boundary of [
    /create or replace function private\.civya_entitlement_has_current_proof/,
    /create or replace function private\.civya_active_case_entitlement/,
    /create or replace function private\.civya_actor_has_tenant_access/,
    /create or replace function public\.civya_service_grant_case_entitlement/,
    /alter function public\.civya_service_case_entitlement_cache_status[\s\S]*rename to civya_service_case_entitlement_cache_status_unchecked/,
    /alter function public\.civya_service_create_case_entitlement_selection[\s\S]*rename to civya_service_create_case_entitlement_selection_unchecked/,
    /alter function public\.civya_service_select_entitled_case[\s\S]*rename to civya_service_select_entitled_case_unchecked/,
    /alter function private\.civya_exact_reminder_entitlement[\s\S]*rename to civya_exact_reminder_entitlement_unchecked/,
    /alter function public\.civya_service_prepare_reminder_delivery[\s\S]*rename to civya_service_prepare_reminder_delivery_unchecked/,
    /create or replace function public\.civya_service_recover_bound_case_entitlement_handoff/,
    /revoke all on function public\.civya_service_finalize_bound_case_entitlement\(/,
  ]) {
    assert.match(
      proofLifecycleUpgrade,
      boundary,
      "Every auth repair must ship in migration 023 or a later forward migration.",
    );
  }
  for (const name of forwardMigrations) {
    let upgrade = await readFile(join(MIGRATIONS, name), "utf8");
    upgrade = upgrade.replace(/create extension if not exists pgcrypto;\s*/i, "");
    await retained.exec(upgrade);
  }
  const definitions = (await retained.query<{ name: string; definition: string }>(`
    select 'active' as name, pg_get_functiondef(
      'private.civya_active_case_entitlement(uuid,uuid,text)'::regprocedure
    ) as definition
    union all
    select 'cache', pg_get_functiondef(
      'public.civya_service_case_entitlement_cache_status(uuid,uuid,bigint,uuid,uuid,text,text[])'::regprocedure
    )
    union all
    select 'grant', pg_get_functiondef(
      'public.civya_service_grant_case_entitlement(uuid,uuid,text[],timestamptz,text,text)'::regprocedure
    )
    union all
    select 'reminder', pg_get_functiondef(
      'public.civya_service_prepare_reminder_delivery(uuid)'::regprocedure
    )
    union all
    select 'selection', pg_get_functiondef(
      'public.civya_service_select_entitled_case(uuid,uuid,uuid)'::regprocedure
    )
  `)).rows;
  const byName = Object.fromEntries(definitions.map((row) => [row.name, row.definition]));
  assert.match(byName.active, /civya_entitlement_has_current_proof/);
  assert.match(byName.cache, /civya_entitlement_has_current_proof/);
  assert.match(byName.grant, /v_challenge\.expires_at <= now\(\)/);
  assert.match(byName.grant, /p_expires_at > v_challenge\.expires_at/);
  assert.match(byName.reminder, /civya_entitlement_has_current_proof/);
  assert.match(byName.selection, /v_selection\.used_at is null and v_selection\.expires_at <= now\(\)/);
  assert.match(byName.selection, /v_selection\.selected_case_id <> p_selected_case_id/);
  assert.match(byName.selection, /civya_entitlement_has_current_proof/);
  const privileges = (await retained.query<{ legacy: boolean; handoff: boolean }>(`
    select
      has_function_privilege(
        'service_role',
        'public.civya_service_finalize_bound_case_entitlement(uuid,text,boolean,text,uuid,uuid,text,text[],text,text,text,timestamptz,text)',
        'EXECUTE'
      ) as legacy,
      has_function_privilege(
        'service_role',
        'public.civya_service_finalize_bound_case_entitlement_handoff(uuid,text,boolean,text,uuid,uuid,text,text[],text,text,text,timestamptz,text,uuid)',
        'EXECUTE'
      ) as handoff
  `)).rows[0];
  assert.equal(privileges.legacy, false);
  assert.equal(privileges.handoff, true);
  await retained.close();
  pass("forward migrations harden a retained pre-fix schema, revoke the non-replayable primitive, and preserve committed-choice recovery");
}

async function seedCases() {
  await db.query(
    `insert into auth.users (id, email) values
       ($1::uuid, 'a@example.test'),
       ($2::uuid, 'b@example.test'),
       ($3::uuid, 'c@example.test')`,
    [USER_A, USER_B, USER_C],
  );
  await db.query(
    `insert into public.tenants (
       id, slug, name, environment, fictional, status, content_version, retention_days
     ) values
       ($1::uuid, 'wayne-production-a', 'Wayne A', 'production', false, 'active', 'v1', 365),
       ($2::uuid, 'wayne-production-b', 'Wayne B', 'production', false, 'active', 'v1', 365),
       ($3::uuid, 'claim-sandbox', 'Sandbox', 'sandbox', true, 'active', 'v1', 30)`,
    [TENANT_A, TENANT_B, TENANT_SANDBOX],
  );
  await db.query(
    `insert into public.residents (
       id, tenant_id, auth_user_id, identity_state, first_name
     ) values
       ($1::uuid, $7::uuid, null, 'anonymous', 'Staged'),
       ($2::uuid, $7::uuid, null, 'anonymous', 'Concurrent'),
       ($3::uuid, $7::uuid, null, 'anonymous', 'Reuse'),
       ($4::uuid, $7::uuid, $9::uuid, 'verified', 'Linked'),
       ($5::uuid, $8::uuid, null, 'anonymous', 'Other tenant'),
       ($6::uuid, $10::uuid, $11::uuid, 'verified', 'Sandbox')`,
    [
      RESIDENT_FIRST,
      RESIDENT_CONCURRENT,
      RESIDENT_REUSE,
      RESIDENT_LINKED,
      RESIDENT_OTHER,
      RESIDENT_SANDBOX,
      TENANT_A,
      TENANT_B,
      USER_C,
      TENANT_SANDBOX,
      USER_C,
    ],
  );
  await db.query(
    `insert into public.cases (id, tenant_id, resident_id, property_address, parcel_id)
     values
       ($1::uuid, $7::uuid, $8::uuid, '100 Secret St', 'private-1'),
       ($2::uuid, $7::uuid, $9::uuid, '200 Secret St', 'private-2'),
       ($3::uuid, $7::uuid, $10::uuid, '300 Secret St', 'private-3'),
       ($4::uuid, $7::uuid, $11::uuid, '400 Secret St', 'private-4'),
       ($5::uuid, $12::uuid, $13::uuid, '500 Secret St', 'private-5'),
       ($6::uuid, $14::uuid, $15::uuid, '600 Secret St', 'private-6')`,
    [
      CASE_FIRST,
      CASE_CONCURRENT,
      CASE_REUSE,
      CASE_LINKED,
      CASE_OTHER,
      CASE_SANDBOX,
      TENANT_A,
      RESIDENT_FIRST,
      RESIDENT_CONCURRENT,
      RESIDENT_REUSE,
      RESIDENT_LINKED,
      TENANT_B,
      RESIDENT_OTHER,
      TENANT_SANDBOX,
      RESIDENT_SANDBOX,
    ],
  );
  pass("governed cases can be staged without an account only after migration 016");
}

interface ClaimInput {
  tenantId: string;
  caseId: string;
  userId: string;
  digest: string;
  proofResult?: "verified" | "failed";
  expiresAt: string;
}

async function claim(input: ClaimInput) {
  const result = await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_claim_verified_production_case(
       $1::uuid, $2::uuid, $3::uuid, 'county_notice', $4, $5, $6, $7::timestamptz
     ) as value`,
    [
      input.tenantId,
      input.caseId,
      input.userId,
      PROVIDER,
      input.proofResult ?? "verified",
      input.digest,
      input.expiresAt,
    ],
  );
  return result.rows[0].value;
}

async function residentOwner(residentId: string): Promise<string | null> {
  const result = await db.query<{ auth_user_id: string | null }>(
    "select auth_user_id::text from public.residents where id = $1::uuid",
    [residentId],
  );
  return result.rows[0]?.auth_user_id ?? null;
}

async function testServiceAndProofBoundary(expiry: string) {
  await setRoleClaim("authenticated", USER_A);
  await assert.rejects(
    claim({ tenantId: TENANT_A, caseId: CASE_FIRST, userId: USER_A, digest: FAILED_DIGEST, expiresAt: expiry }),
    (error: { code?: string }) => error.code === "42501",
  );
  await setRoleClaim("service_role");
  await assert.rejects(
    claim({
      tenantId: TENANT_A,
      caseId: CASE_FIRST,
      userId: USER_A,
      digest: FAILED_DIGEST,
      proofResult: "failed",
      expiresAt: expiry,
    }),
    (error: { code?: string }) => error.code === "28000",
  );
  assert.equal(await residentOwner(RESIDENT_FIRST), null);
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from public.identity_proof_challenges where case_id = $1::uuid",
    [CASE_FIRST],
  )).rows[0].count, 0);
  pass("account login and failed proof cannot claim a case or create proof evidence");
}

async function testExactScopeAndNegativeCases(expiry: string) {
  await assert.rejects(
    claim({ tenantId: TENANT_B, caseId: CASE_FIRST, userId: USER_A, digest: FAILED_DIGEST, expiresAt: expiry }),
    (error: { code?: string }) => error.code === "P0002",
  );
  assert.equal(await residentOwner(RESIDENT_FIRST), null);

  await assert.rejects(
    claim({
      tenantId: TENANT_SANDBOX,
      caseId: CASE_SANDBOX,
      userId: USER_C,
      digest: SANDBOX_DIGEST,
      expiresAt: expiry,
    }),
    (error: { code?: string }) => error.code === "P0002",
  );
  assert.equal(await residentOwner(RESIDENT_SANDBOX), USER_C);
  pass("wrong-tenant and fictional-sandbox claims fail without ownership mutation");
}

async function testFirstClaimAndReplay(expiry: string) {
  const first = await claim({
    tenantId: TENANT_A,
    caseId: CASE_FIRST,
    userId: USER_A,
    digest: FIRST_DIGEST,
    expiresAt: expiry,
  });
  const replay = await claim({
    tenantId: TENANT_A,
    caseId: CASE_FIRST,
    userId: USER_A,
    digest: FIRST_DIGEST,
    expiresAt: expiry,
  });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(first.challengeId, replay.challengeId);
  assert.equal(first.entitlementId, replay.entitlementId);
  assert.deepEqual(first.scopes, [
    "case.read",
    "case.participate",
    "document.read",
    "document.upload",
  ]);
  assert.deepEqual(Object.keys(first).sort(), [
    "caseId",
    "challengeId",
    "duplicate",
    "entitlementId",
    "expiresAt",
    "residentId",
    "scopes",
    "state",
  ].sort());
  assert.equal(await residentOwner(RESIDENT_FIRST), USER_A);
  assert.equal((await db.query<{ count: number }>(
    `select count(*)::integer as count from public.audit_events
     where case_id = $1::uuid
       and event_type = 'production_case_claimed_after_verified_proof'`,
    [CASE_FIRST],
  )).rows[0].count, 1);
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from public.case_entitlements where case_id = $1::uuid",
    [CASE_FIRST],
  )).rows[0].count, 1);
  pass("first claim commits one proof, least-privilege entitlement, audit event, and deterministic replay");
}

async function testNoOwnershipTransfer(expiry: string) {
  await assert.rejects(
    claim({
      tenantId: TENANT_A,
      caseId: CASE_FIRST,
      userId: USER_B,
      digest: OTHER_DIGEST,
      expiresAt: expiry,
    }),
    (error: { code?: string }) => error.code === "P0002",
  );
  await assert.rejects(
    claim({
      tenantId: TENANT_A,
      caseId: CASE_LINKED,
      userId: USER_C,
      digest: LINKED_DIGEST,
      expiresAt: expiry,
    }),
    (error: { code?: string }) => error.code === "P0002",
  );
  assert.equal(await residentOwner(RESIDENT_FIRST), USER_A);
  assert.equal(await residentOwner(RESIDENT_LINKED), USER_C);
  assert.equal((await db.query<{ resident_id: string }>(
    "select resident_id::text from public.cases where id = $1::uuid",
    [CASE_FIRST],
  )).rows[0].resident_id, RESIDENT_FIRST);
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from public.case_entitlements where auth_user_id = $1::uuid and case_id = $2::uuid",
    [USER_B, CASE_FIRST],
  )).rows[0].count, 0);
  pass("a wrong user cannot reassign, merge, or transfer a claimed/already-linked resident or case");
}

async function testGrantReuseAndConcurrency(expiry: string) {
  await assert.rejects(
    claim({
      tenantId: TENANT_A,
      caseId: CASE_REUSE,
      userId: USER_B,
      digest: FIRST_DIGEST,
      expiresAt: expiry,
    }),
    (error: { code?: string }) => error.code === "P0002",
  );
  assert.equal(await residentOwner(RESIDENT_REUSE), null);

  const concurrentInput = {
    tenantId: TENANT_A,
    caseId: CASE_CONCURRENT,
    userId: USER_B,
    digest: CONCURRENT_DIGEST,
    expiresAt: expiry,
  };
  const [left, right] = await Promise.all([claim(concurrentInput), claim(concurrentInput)]);
  assert.equal(left.entitlementId, right.entitlementId);
  assert.deepEqual([left.duplicate, right.duplicate].sort(), [false, true]);
  assert.equal(await residentOwner(RESIDENT_CONCURRENT), USER_B);
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from private.production_case_claim_receipts where case_id = $1::uuid",
    [CASE_CONCURRENT],
  )).rows[0].count, 1);
  assert.equal((await db.query<{ count: number }>(
    "select count(*)::integer as count from public.case_entitlements where case_id = $1::uuid",
    [CASE_CONCURRENT],
  )).rows[0].count, 1);
  pass("provider-grant reuse is case-bound and concurrent identical claims converge on one entitlement");
}

async function finalizeTransfer(input: {
  tenantId?: string;
  purpose?: string;
  scopes?: string[];
  transferDigest?: string;
  selectionId?: string;
  expiresAt: string;
}) {
  const result = await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_finalize_bound_case_entitlement_handoff(
       $1::uuid, $2, false, $3, $4::uuid, $5::uuid, $6, $7::text[],
       'notice_code', $8, $9, $10::timestamptz, $11, $12::uuid
     ) as value`,
    [
      USER_B,
      "b@example.test",
      input.transferDigest ?? TRANSFER_DIGEST,
      input.tenantId ?? TENANT_A,
      CASE_FIRST,
      input.purpose ?? "case_access",
      input.scopes ?? SCOPES,
      PROVIDER,
      FINALIZER_DIGEST,
      input.expiresAt,
      "test-bound-finalizer",
      input.selectionId ?? "95000000-0000-4000-8000-000000000020",
    ],
  );
  return result.rows[0].value;
}

async function recoverTransfer(selectionId: string) {
  const result = await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_recover_bound_case_entitlement_handoff(
       $1::uuid, $2, false, $3, $4::uuid, $5::uuid,
       'case_access', $6::text[], 'notice_code', $7, $8, $9::uuid
     ) as value`,
    [
      USER_B, "b@example.test", TRANSFER_DIGEST, TENANT_A, CASE_FIRST,
      SCOPES, PROVIDER, "test-bound-finalizer", selectionId,
    ],
  );
  return result.rows[0].value;
}

async function testAtomicBoundTransfer(expiry: string) {
  await db.query(
    `insert into private.case_transfer_grants (
       tenant_id, source_resident_id, case_id, created_by_auth_user_id,
       token_hash, expires_at, purpose, scopes
     ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz,
       'case_access', $7::text[])`,
    [TENANT_A, RESIDENT_FIRST, CASE_FIRST, USER_A, TRANSFER_DIGEST, expiry, SCOPES],
  );
  const stillUnused = async () => (await db.query<{ used: boolean }>(
    "select used_at is not null as used from private.case_transfer_grants where token_hash = $1",
    [TRANSFER_DIGEST],
  )).rows[0].used;

  await assert.rejects(
    finalizeTransfer({ tenantId: TENANT_B, expiresAt: expiry }),
    (error: { code?: string }) => error.code === "28000",
  );
  assert.equal(await stillUnused(), false);
  await assert.rejects(
    finalizeTransfer({ purpose: "document_access", expiresAt: expiry }),
    (error: { code?: string }) => error.code === "28000",
  );
  assert.equal(await stillUnused(), false);
  await assert.rejects(
    finalizeTransfer({ scopes: ["case.read"], expiresAt: expiry }),
    (error: { code?: string }) => error.code === "28000",
  );
  assert.equal(await stillUnused(), false);

  const finalized = await finalizeTransfer({ expiresAt: expiry });
  assert.equal(finalized.accessType, "case_entitlement");
  assert.equal(finalized.caseId, CASE_FIRST);
  assert.equal(finalized.tenantId, TENANT_A);
  assert.equal(finalized.requiresCaseSelection, true);
  assert.equal(finalized.existingActiveCaseId, CASE_CONCURRENT);
  assert.deepEqual(finalized.scopes, SCOPES);
  assert.equal(await stillUnused(), true);
  assert.equal((await db.query<{ resident_id: string }>(
    "select resident_id::text from public.cases where id = $1::uuid",
    [CASE_FIRST],
  )).rows[0].resident_id, RESIDENT_CONCURRENT);
  const recoveredAfterResponseLoss = await recoverTransfer(
    "95000000-0000-4000-8000-000000000021",
  );
  assert.equal(recoveredAfterResponseLoss.duplicate, true);
  assert.equal(recoveredAfterResponseLoss.entitlementId, finalized.entitlementId);
  assert.equal(recoveredAfterResponseLoss.selectionId, finalized.selectionId);
  assert.equal((await db.query<{ count: number }>(
    `select count(*)::integer as count
     from private.bound_case_entitlement_handoffs
     where tenant_id = $1::uuid and idempotency_key = 'test-bound-finalizer'`,
    [TENANT_A],
  )).rows[0].count, 1);
  assert.equal((await db.query<{ count: number }>(
    `select count(*)::integer as count from public.case_entitlements
     where case_id = $1::uuid and auth_user_id = $2::uuid and state = 'active'`,
    [CASE_FIRST, USER_B],
  )).rows[0].count, 1);

  const inactiveStatus = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_case_entitlement_cache_status(
       $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid,
       'case_access', $6::text[]
     ) as value`,
    [USER_B, finalized.entitlementId, finalized.rowVersion, TENANT_A, CASE_FIRST, SCOPES],
  )).rows[0].value;
  assert.equal(inactiveStatus.authorized, false);

  const createSelection = async (selectionId: string) => (await db.query<{
    value: Record<string, unknown>;
  }>(
    `select public.civya_service_create_case_entitlement_selection(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       'case_entitlement', 'case_access', $6::text[], now() + interval '10 minutes'
     ) as value`,
    [USER_B, selectionId, CASE_FIRST, finalized.entitlementId, CASE_CONCURRENT, SCOPES],
  )).rows[0].value;
  const choose = async (selectionId: string, selectedCaseId: string) => (await db.query<{
    value: Record<string, unknown>;
  }>(
    `select public.civya_service_select_entitled_case(
       $1::uuid, $2::uuid, $3::uuid
     ) as value`,
    [USER_B, selectionId, selectedCaseId],
  )).rows[0].value;

  const keepExistingId = String(finalized.selectionId);
  assert.equal(finalized.existingCaseAvailable, true);
  const existingSelected = await choose(keepExistingId, CASE_CONCURRENT);
  assert.equal(existingSelected.authorized, true);
  assert.equal(existingSelected.caseId, CASE_CONCURRENT);
  assert.equal((await db.query<{ active: boolean }>(
    "select active from public.cases where id = $1::uuid", [CASE_FIRST],
  )).rows[0].active, false);
  const existingSelectionReplay = await choose(keepExistingId, CASE_CONCURRENT);
  assert.equal(existingSelectionReplay.authorized, true);
  assert.equal(existingSelectionReplay.caseId, CASE_CONCURRENT);
  assert.equal(existingSelectionReplay.duplicate, true);
  await db.query(
    `update private.case_entitlement_selections
     set created_at = now() - interval '2 hours',
         expires_at = now() - interval '1 hour'
     where id = $1::uuid`,
    [keepExistingId],
  );
  const existingSelectionLateReplay = await choose(keepExistingId, CASE_CONCURRENT);
  assert.equal(existingSelectionLateReplay.authorized, true);
  assert.equal(existingSelectionLateReplay.caseId, CASE_CONCURRENT);
  assert.equal(existingSelectionLateReplay.duplicate, true);
  await assert.rejects(
    choose(keepExistingId, CASE_FIRST),
    (error: { code?: string }) => error.code === "28000",
  );

  const expiredUnusedId = "95000000-0000-4000-8000-000000000012";
  await createSelection(expiredUnusedId);
  await db.query(
    `update private.case_entitlement_selections
     set created_at = now() - interval '2 hours',
         expires_at = now() - interval '1 hour'
     where id = $1::uuid`,
    [expiredUnusedId],
  );
  await assert.rejects(
    choose(expiredUnusedId, CASE_FIRST),
    (error: { code?: string }) => error.code === "28000",
  );

  const chooseAttachedId = "95000000-0000-4000-8000-000000000011";
  await createSelection(chooseAttachedId);
  const attachedSelected = await choose(chooseAttachedId, CASE_FIRST);
  assert.equal(attachedSelected.authorized, true);
  assert.equal(attachedSelected.caseId, CASE_FIRST);
  assert.equal((await db.query<{ active: boolean }>(
    "select active from public.cases where id = $1::uuid", [CASE_FIRST],
  )).rows[0].active, true);
  assert.equal((await db.query<{ active: boolean }>(
    "select active from public.cases where id = $1::uuid", [CASE_CONCURRENT],
  )).rows[0].active, false);
  const activeStatus = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_case_entitlement_cache_status(
       $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid,
       'case_access', $6::text[]
     ) as value`,
    [USER_B, finalized.entitlementId, finalized.rowVersion, TENANT_A, CASE_FIRST, SCOPES],
  )).rows[0].value;
  assert.equal(activeStatus.authorized, true);

  const proof = (await db.query<{
    id: string;
    created_at: string;
    verified_at: string;
    resolved_at: string;
    expires_at: string;
    assurance_level: string;
    evidence_digest: string;
  }>(
    `select p.id::text, p.created_at::text, p.verified_at::text,
            p.resolved_at::text, p.expires_at::text,
            p.assurance_level, p.evidence_digest
     from public.identity_proof_challenges p
     join public.case_entitlements e on e.proof_challenge_id = p.id
     where e.id = $1::uuid`,
    [finalized.entitlementId],
  )).rows[0];
  await setRoleClaim("authenticated", USER_B);
  await db.exec("set role authenticated");
  try {
    const visibleBeforeExpiry = (await db.query<{ count: number }>(
      "select count(*)::integer as count from public.cases where id = $1::uuid",
      [CASE_FIRST],
    )).rows[0].count;
    assert.equal(visibleBeforeExpiry, 1);
  } finally {
    await db.exec("reset role");
    await setRoleClaim("service_role");
  }
  await db.query(
    `update public.identity_proof_challenges
     set created_at = now() - interval '3 hours',
         verified_at = now() - interval '2 hours',
         resolved_at = now() - interval '2 hours',
         expires_at = now() - interval '1 hour'
     where id = $1::uuid`,
    [proof.id],
  );
  const directAfterProofExpiry = (await db.query<{ authorized: boolean }>(
    `select private.civya_active_case_entitlement(
       $1::uuid, $2::uuid, 'case.read'
     ) as authorized`,
    [USER_B, CASE_FIRST],
  )).rows[0].authorized;
  assert.equal(directAfterProofExpiry, false);
  await setRoleClaim("authenticated", USER_B);
  await db.exec("set role authenticated");
  try {
    const visibleAfterExpiry = (await db.query<{ count: number }>(
      "select count(*)::integer as count from public.cases where id = $1::uuid",
      [CASE_FIRST],
    )).rows[0].count;
    assert.equal(visibleAfterExpiry, 0);
  } finally {
    await db.exec("reset role");
    await setRoleClaim("service_role");
  }
  const cacheAfterProofExpiry = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_case_entitlement_cache_status(
       $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid,
       'case_access', $6::text[]
     ) as value`,
    [USER_B, finalized.entitlementId, finalized.rowVersion, TENANT_A, CASE_FIRST, SCOPES],
  )).rows[0].value;
  assert.equal(cacheAfterProofExpiry.authorized, false);
  await assert.rejects(
    db.query(
      `select public.civya_service_grant_case_entitlement(
         null, $1::uuid, $2::text[], now() + interval '5 minutes',
         'expired-proof-test', 'expired-proof-test'
       )`,
      [proof.id, SCOPES],
    ),
    (error: { code?: string }) => error.code === "28000",
  );
  await db.query(
    `update public.identity_proof_challenges
     set created_at = $2::timestamptz, verified_at = $3::timestamptz,
         resolved_at = $4::timestamptz, expires_at = $5::timestamptz
     where id = $1::uuid`,
    [proof.id, proof.created_at, proof.verified_at, proof.resolved_at, proof.expires_at],
  );
  await db.query(
    "update public.identity_proof_challenges set assurance_level = 'basic' where id = $1::uuid",
    [proof.id],
  );
  assert.equal((await db.query<{ authorized: boolean }>(
    `select private.civya_active_case_entitlement(
       $1::uuid, $2::uuid, 'case.read'
     ) as authorized`,
    [USER_B, CASE_FIRST],
  )).rows[0].authorized, false);
  await assert.rejects(
    db.query(
      `select public.civya_service_grant_case_entitlement(
         null, $1::uuid, $2::text[], now() + interval '5 minutes',
         'weak-proof-test', 'weak-proof-test'
       )`,
      [proof.id, SCOPES],
    ),
    (error: { code?: string }) => error.code === "28000",
  );
  await db.query(
    `update public.identity_proof_challenges
     set assurance_level = $2, evidence_digest = $3
     where id = $1::uuid`,
    [proof.id, proof.assurance_level, "9".repeat(64)],
  );
  assert.equal((await db.query<{ authorized: boolean }>(
    `select private.civya_active_case_entitlement(
       $1::uuid, $2::uuid, 'case.read'
     ) as authorized`,
    [USER_B, CASE_FIRST],
  )).rows[0].authorized, false);
  await db.query(
    "update public.identity_proof_challenges set evidence_digest = $2 where id = $1::uuid",
    [proof.id, proof.evidence_digest],
  );
  assert.equal((await db.query<{ authorized: boolean }>(
    `select private.civya_active_case_entitlement(
       $1::uuid, $2::uuid, 'case.read'
     ) as authorized`,
    [USER_B, CASE_FIRST],
  )).rows[0].authorized, true);
  await assert.rejects(
    db.query(
      `select public.civya_service_grant_case_entitlement(
         null, $1::uuid, $2::text[], $3::timestamptz + interval '1 minute',
         'proof-lifetime-test', 'proof-lifetime-test'
       )`,
      [proof.id, SCOPES, proof.expires_at],
    ),
    (error: { code?: string }) => error.code === "22023",
  );
  pass("mismatches never consume transfer; response-loss retries recover; inactive and expired-proof cases cannot become browser grants");
}

async function testDirectFinalizerResponseLoss(expiry: string) {
  const finalize = async (selectionId: string) => (await db.query<{
    value: Record<string, unknown>;
  }>(
    `select public.civya_service_finalize_bound_case_entitlement_handoff(
       $1::uuid, 'c@example.test', false, null, $2::uuid, $3::uuid,
       'case_access', $4::text[], 'notice_code', $5, $6,
       $7::timestamptz, 'test-direct-finalizer', $8::uuid
     ) as value`,
    [USER_C, TENANT_A, CASE_LINKED, SCOPES, PROVIDER, DIRECT_FINALIZER_DIGEST, expiry, selectionId],
  )).rows[0].value;
  const first = await finalize("95000000-0000-4000-8000-000000000022");
  const recovered = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_recover_bound_case_entitlement_handoff(
       $1::uuid, 'c@example.test', false, null, $2::uuid, $3::uuid,
       'case_access', $4::text[], 'notice_code', $5,
       'test-direct-finalizer', $6::uuid
     ) as value`,
    [USER_C, TENANT_A, CASE_LINKED, SCOPES, PROVIDER,
      "95000000-0000-4000-8000-000000000023"],
  )).rows[0].value;
  assert.notEqual(first.requiresCaseSelection, true);
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.entitlementId, first.entitlementId);
  assert.equal((await db.query<{ count: number }>(
    `select count(*)::integer as count from public.case_entitlements
     where case_id = $1::uuid and auth_user_id = $2::uuid and state = 'active'`,
    [CASE_LINKED, USER_C],
  )).rows[0].count, 1);
  await db.query(
    `select public.civya_service_revoke_case_entitlement(
       $1::uuid, $2::uuid, $3::bigint, 'direct-response-loss-test-complete'
     )`,
    [first.entitlementId, USER_C, first.rowVersion],
  );
  pass("direct finalization replays its committed entitlement after HTTP response loss");
}

async function testExpiredProofStillAllowsRevocation(expiry: string) {
  const challenge = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_create_identity_proof_challenge(
       $1::uuid, $2::uuid, 'county_notice', $3, $4,
       $5::timestamptz, 'delegation-expiry-challenge'
     ) as value`,
    [USER_C, CASE_LINKED, PROVIDER, "6".repeat(64), expiry],
  )).rows[0].value;
  await db.query(
    `select public.civya_service_resolve_identity_proof_challenge(
       $1::uuid, 'verified', 'substantial', $2, 'sha256:delegation-expiry-test'
     )`,
    [challenge.challengeId, "7".repeat(64)],
  );
  const entitlement = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_grant_case_entitlement(
       null, $1::uuid, array['case.read', 'case.delegate']::text[],
       $2::timestamptz, 'delegation-expiry-test', 'delegation-expiry-entitlement'
     ) as value`,
    [challenge.challengeId, expiry],
  )).rows[0].value;
  const delegation = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_create_case_delegation(
       $1::uuid, $2::uuid, $3::uuid, array['case.read']::text[],
       $4, $5::timestamptz, 'delegation-expiry-test'
     ) as value`,
    [USER_C, CASE_LINKED, USER_B, "8".repeat(64), expiry],
  )).rows[0].value;
  await db.query(
    `update public.identity_proof_challenges
     set created_at = now() - interval '3 hours',
         verified_at = now() - interval '2 hours',
         resolved_at = now() - interval '2 hours',
         expires_at = now() - interval '1 hour'
     where id = $1::uuid`,
    [challenge.challengeId],
  );
  const revoked = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_revoke_case_entitlement(
       $1::uuid, $2::uuid, 1, 'expired-proof-principal-revoked'
     ) as value`,
    [entitlement.entitlementId, USER_C],
  )).rows[0].value;
  assert.equal(revoked.state, "revoked");
  assert.equal((await db.query<{ state: string }>(
    "select state from public.case_delegations where id = $1::uuid",
    [delegation.delegationId],
  )).rows[0].state, "revoked");
  pass("expired proof blocks authorization but never blocks entitlement or delegation revocation");
}

async function testHumanAssistanceAndRevocation(expiry: string) {
  await db.query(
    `insert into public.staff_roles (tenant_id, auth_user_id, role, status)
     values ($1::uuid, $2::uuid, 'admin', 'active')`,
    [TENANT_A, USER_A],
  );
  const correlationId = "95000000-0000-4000-8000-000000000001";
  const created = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_create_entitlement_assistance_request(
       $1::uuid, $2::uuid, $3::uuid, 'case_access', $4::text[], null,
       $5::uuid, 'human-test-request'
     ) as value`,
    [USER_C, TENANT_A, CASE_LINKED, SCOPES, correlationId],
  )).rows[0].value;
  assert.equal(created.state, "open");
  assert.equal(created.correlationId, correlationId);
  const queue = (await db.query<{ value: Array<Record<string, unknown>> }>(
    "select public.civya_service_list_entitlement_assistance($1::uuid, $2::uuid, 50) as value",
    [USER_A, TENANT_A],
  )).rows[0].value;
  assert.ok(queue.some((item) => item.requestId === created.requestId));

  const claimed = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_resolve_entitlement_assistance(
       $1::uuid, $2::uuid, $3::bigint, 'claim', null
     ) as value`,
    [USER_A, created.requestId, created.rowVersion],
  )).rows[0].value;
  assert.equal(claimed.state, "owned");
  const approved = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_resolve_entitlement_assistance(
       $1::uuid, $2::uuid, $3::bigint, 'approve', 'staff_identity_confirmed'
     ) as value`,
    [USER_A, created.requestId, claimed.rowVersion],
  )).rows[0].value;
  assert.equal(approved.state, "approved");
  assert.equal((approved.access as Record<string, unknown>).authorized, true);

  const polled = (await db.query<{ value: Record<string, unknown> }>(
    "select public.civya_service_entitlement_assistance_status($1::uuid, $2::uuid) as value",
    [USER_C, created.requestId],
  )).rows[0].value;
  assert.equal(polled.state, "approved");
  const access = polled.access as Record<string, unknown>;
  assert.equal(access.authorized, true);
  const entitlementId = String(access.entitlementId);
  const rowVersion = Number(access.rowVersion);
  await db.query(
    "select public.civya_service_revoke_case_entitlement($1::uuid, $2::uuid, $3::bigint, 'staff_review_revoked')",
    [entitlementId, USER_A, rowVersion],
  );
  const revoked = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_case_entitlement_cache_status(
       $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid,
       'case_access', $6::text[]
     ) as value`,
    [USER_C, entitlementId, rowVersion, TENANT_A, CASE_LINKED, SCOPES],
  )).rows[0].value;
  assert.equal(revoked.authorized, false);
  pass("human assistance is durable, staff-owned, resident-pollable, audited, and revocation invalidates its cache");
}

async function testRecoveryExpiryMismatchAndReplay() {
  const emailDigest = crypto.createHash("sha256")
    .update("civya-recovery-email-v1|b@example.test")
    .digest("hex");
  const correlationId = "95000000-0000-4000-8000-000000000002";
  const challenge = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_create_account_recovery_challenge(
       $1, $2, $3::uuid, now() + interval '10 minutes', 'recovery-test'
     ) as value`,
    [emailDigest, RECOVERY_NONCE_DIGEST, correlationId],
  )).rows[0].value;
  await assert.rejects(
    db.query(
      `select public.civya_service_resolve_account_recovery_challenge(
         $1::uuid, $2, 'verified', $3::uuid
       )`,
      [challenge.challengeId, RECOVERY_NONCE_DIGEST, USER_A],
    ),
    (error: { code?: string }) => error.code === "28000",
  );
  const verified = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_resolve_account_recovery_challenge(
       $1::uuid, $2, 'verified', $3::uuid
     ) as value`,
    [challenge.challengeId, RECOVERY_NONCE_DIGEST, USER_B],
  )).rows[0].value;
  assert.equal(verified.state, "verified");
  await assert.rejects(
    db.query(
      `select public.civya_service_resolve_account_recovery_challenge(
         $1::uuid, $2, 'verified', $3::uuid
       )`,
      [challenge.challengeId, RECOVERY_NONCE_DIGEST, USER_B],
    ),
    (error: { code?: string }) => error.code === "28000",
  );

  const expiredNonce = "4".repeat(64);
  const expired = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_create_account_recovery_challenge(
       $1, $2, $3::uuid, now() + interval '10 minutes', 'recovery-expired-test'
     ) as value`,
    [emailDigest, expiredNonce, "95000000-0000-4000-8000-000000000003"],
  )).rows[0].value;
  await db.query(
    `update private.account_recovery_challenges
     set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
     where id = $1::uuid`,
    [expired.challengeId],
  );
  const expiredResult = (await db.query<{ value: Record<string, unknown> }>(
    `select public.civya_service_resolve_account_recovery_challenge(
       $1::uuid, $2, 'verified', $3::uuid
     ) as value`,
    [expired.challengeId, expiredNonce, USER_B],
  )).rows[0].value;
  assert.equal(expiredResult.state, "expired");
  pass("recovery is account-bound, persists expiry, and rejects one-time challenge replay");
}

async function main() {
  console.log("Atomic verified production case claim");
  await testRetainedSchemaProofLifecycleUpgrade();
  await prepareDatabase();
  await seedCases();
  const expiry = new Date(Date.now() + 20 * 60 * 1_000).toISOString();
  await testServiceAndProofBoundary(expiry);
  await testExactScopeAndNegativeCases(expiry);
  await testFirstClaimAndReplay(expiry);
  await testNoOwnershipTransfer(expiry);
  await testGrantReuseAndConcurrency(expiry);
  await testAtomicBoundTransfer(expiry);
  await testExpiredProofStillAllowsRevocation(expiry);
  await testDirectFinalizerResponseLoss(expiry);
  await testHumanAssistanceAndRevocation(expiry);
  await testRecoveryExpiryMismatchAndReplay();
  console.log("\nAll production case-claim tests passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
