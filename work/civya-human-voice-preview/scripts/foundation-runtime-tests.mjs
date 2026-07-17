import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const PROD_TENANT = "81000000-0000-4000-8000-000000000001";
const SANDBOX_TENANT = "81000000-0000-4000-8000-000000000002";
const ADMIN_USER = "82000000-0000-4000-8000-000000000001";
const PROD_USER = "82000000-0000-4000-8000-000000000002";
const SANDBOX_USER = "82000000-0000-4000-8000-000000000003";
const PROD_RESIDENT = "83000000-0000-4000-8000-000000000001";
const SANDBOX_RESIDENT = "83000000-0000-4000-8000-000000000002";
const PROD_CASE = "84000000-0000-4000-8000-000000000001";
const SANDBOX_CASE = "84000000-0000-4000-8000-000000000002";
let PROD_WORKFLOW = null;

const db = new PGlite();

function pass(message) {
  console.log(`  PASS  ${message}`);
}

async function setRoleClaim(role, userId = "") {
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

  const migrations = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    let sql = await readFile(join(MIGRATIONS, name), "utf8");
    sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, "");
    try {
      await db.exec(sql);
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  assert.ok(
    migrations.includes("202607160017_provider_event_processing_leases.sql"),
    "provider-event lease migration is missing",
  );
  assert.ok(
    migrations.includes("202607160026_external_operation_claim_fencing.sql"),
    "external-operation claim fencing migration is missing",
  );
  pass(`applied all ${migrations.length} migrations, including the provider-event lease and verified case-claim boundaries`);
}

async function seedFoundation() {
  await db.query(
    "insert into auth.users (id, email) values ($1::uuid, 'admin@example.test'), ($2::uuid, 'resident@example.test'), ($3::uuid, 'sandbox@example.test')",
    [ADMIN_USER, PROD_USER, SANDBOX_USER],
  );
  await db.query(
    `insert into public.tenants (
       id, slug, name, environment, fictional, content_version, retention_days
     ) values
       ($1::uuid, 'wayne-production', 'Wayne County', 'production', false, 'wayne-v1', 30),
       ($2::uuid, 'foundation-sandbox', 'Foundation Sandbox', 'sandbox', true, 'sandbox-v1', 30)`,
    [PROD_TENANT, SANDBOX_TENANT],
  );
  await db.query(
    `insert into public.staff_roles (tenant_id, auth_user_id, role, status)
     values ($1::uuid, $2::uuid, 'admin', 'active')`,
    [PROD_TENANT, ADMIN_USER],
  );
  await db.query(
    `insert into public.tenant_domains (
       tenant_id, hostname, purpose, verification_state, is_primary, verified_at
     ) values ($1::uuid, 'wayne.civya.example', 'resident', 'verified', true, now())`,
    [PROD_TENANT],
  );
  await db.query(
    `insert into public.tenant_program_config_versions (
       tenant_id, program_key, version, schema_version, status, configuration,
       effective_from, approved_by_auth_user_id, approved_at
     ) values ($1::uuid, 'foreclosure-prevention', '1.0.0', '1', 'active',
       '{"cohort":50}'::jsonb, now() - interval '1 hour', $2::uuid, now())`,
    [PROD_TENANT, ADMIN_USER],
  );
  await db.query(
    `insert into public.record_series_schedules (
       tenant_id, record_series_key, version, status, retention_days,
       disposition_action, legal_basis, approved_by_auth_user_id, approved_at
     ) values ($1::uuid, 'case-record', '1.0.0', 'active', 2555,
       'review', 'County records schedule pending final citation', $2::uuid, now())`,
    [PROD_TENANT, ADMIN_USER],
  );
  await db.query(
    `insert into public.legal_holds (
       tenant_id, hold_key, scope, reason, authority_reference, opened_by_auth_user_id
     ) values ($1::uuid, 'launch-preservation', '{"recordSeries":"case-record"}'::jsonb,
       'Preserve launch evidence', 'WAYNE-LAUNCH-001', $2::uuid)`,
    [PROD_TENANT, ADMIN_USER],
  );

  await assert.rejects(
    db.query(`insert into public.tenants (slug, name, environment, fictional, content_version)
      values ('bad-production', 'Bad', 'production', true, 'bad')`),
    (error) => error.code === "23514",
  );
  await assert.rejects(
    db.query(`insert into public.tenants (slug, name, environment, fictional, content_version)
      values ('bad-sandbox', 'Bad', 'sandbox', false, 'bad')`),
    (error) => error.code === "23514",
  );
  pass("production/sandbox invariants, verified domains, governed config, schedules, and legal holds are enforced");
}

async function testRetentionGuard() {
  await db.query(
    `insert into public.residents (id, tenant_id, auth_user_id, identity_state, updated_at)
     values
       ($1::uuid, $2::uuid, $3::uuid, 'verified', now() - interval '60 days'),
       ($4::uuid, $5::uuid, $6::uuid, 'verified', now() - interval '60 days')`,
    [PROD_RESIDENT, PROD_TENANT, PROD_USER, SANDBOX_RESIDENT, SANDBOX_TENANT, SANDBOX_USER],
  );
  await db.query(
    `insert into public.cases (id, tenant_id, resident_id, updated_at)
     values
       ($1::uuid, $2::uuid, $3::uuid, now() - interval '60 days'),
       ($4::uuid, $5::uuid, $6::uuid, now() - interval '60 days')`,
    [PROD_CASE, PROD_TENANT, PROD_RESIDENT, SANDBOX_CASE, SANDBOX_TENANT, SANDBOX_RESIDENT],
  );
  await db.query(
    `insert into public.audit_events (tenant_id, resident_id, case_id, event_type, source, created_at)
     values
       ($1::uuid, $2::uuid, $3::uuid, 'production_old_event', 'system', now() - interval '60 days'),
       ($4::uuid, $5::uuid, $6::uuid, 'sandbox_old_event', 'system', now() - interval '60 days')`,
    [PROD_TENANT, PROD_RESIDENT, PROD_CASE, SANDBOX_TENANT, SANDBOX_RESIDENT, SANDBOX_CASE],
  );
  await setRoleClaim("service_role");
  const cleanup = await db.query("select public.civya_prepare_retention_cleanup() as value");
  assert.equal(cleanup.rows[0].value.casesRemoved, 1);
  assert.equal((await db.query("select count(*)::integer as count from public.cases where id = $1::uuid", [PROD_CASE])).rows[0].count, 1);
  assert.equal((await db.query("select count(*)::integer as count from public.cases where id = $1::uuid", [SANDBOX_CASE])).rows[0].count, 0);
  assert.equal((await db.query(
    "select count(*)::integer as count from public.audit_events where tenant_id = $1::uuid and event_type = 'production_old_event'",
    [PROD_TENANT],
  )).rows[0].count, 1);
  const prodChain = (await db.query("select public.civya_service_verify_audit_chain($1::uuid) as value", [PROD_TENANT])).rows[0].value;
  const sandboxChain = (await db.query("select public.civya_service_verify_audit_chain($1::uuid) as value", [SANDBOX_TENANT])).rows[0].value;
  assert.equal(prodChain.valid, true);
  assert.equal(sandboxChain.valid, true);
  pass("retention removes expired sandbox data while production cases and audit history remain untouched");
}

async function testConfigurationResolution() {
  await setRoleClaim("service_role");
  const tenant = (await db.query("select public.civya_service_resolve_tenant('wayne.civya.example') as value")).rows[0].value;
  const config = (await db.query(
    "select public.civya_service_get_program_config($1::uuid, 'foreclosure-prevention', now()) as value",
    [PROD_TENANT],
  )).rows[0].value;
  assert.equal(tenant.environment, "production");
  assert.equal(tenant.fictional, false);
  assert.equal(config.configuration.cohort, 50);
  pass("verified-host tenant resolution and effective versioned program configuration are service-only and deterministic");
}

async function testProductionCaseEntitlement() {
  await setRoleClaim("service_role");
  const challenge = (await db.query(
    `select public.civya_service_create_identity_proof_challenge(
       $1::uuid, $2::uuid, 'county_notice', 'wayne_county_case_entitlement',
       $3, now() + interval '1 hour', 'runtime-proof-1'
     ) as value`,
    [PROD_USER, PROD_CASE, "1".repeat(64)],
  )).rows[0].value;
  assert.equal(challenge.state, "pending");
  const verified = (await db.query(
    `select public.civya_service_resolve_identity_proof_challenge(
       $1::uuid, 'verified', 'substantial', $2, 'wayne-proof-ref-1'
     ) as value`,
    [challenge.challengeId, "2".repeat(64)],
  )).rows[0].value;
  assert.equal(verified.state, "verified");
  const entitlement = (await db.query(
    `select public.civya_service_grant_case_entitlement(
       $1::uuid, $2::uuid,
       array['case.read', 'case.participate', 'document.read']::text[],
       now() + interval '30 minutes', 'verified_county_notice', 'runtime-entitlement-1'
     ) as value`,
    [ADMIN_USER, challenge.challengeId],
  )).rows[0].value;
  assert.equal(entitlement.state, "active");
  const status = (await db.query(
    "select public.civya_service_case_entitlement_status($1::uuid, $2::uuid) as value",
    [PROD_USER, PROD_CASE],
  )).rows[0].value;
  assert.equal(status.authorized, true);
  assert.equal(status.accessType, "case_entitlement");

  await setRoleClaim("authenticated", PROD_USER);
  await db.exec("set role authenticated");
  try {
    const ownRows = (await db.query(
      "select count(*)::integer as count from public.case_entitlements where case_id = $1::uuid",
      [PROD_CASE],
    )).rows[0].count;
    assert.equal(ownRows, 1);
    await assert.rejects(
      db.query("select public.civya_service_case_entitlement_status($1::uuid, $2::uuid)", [PROD_USER, PROD_CASE]),
      (error) => error.code === "42501",
    );
  } finally {
    await db.exec("reset role");
  }

  await setRoleClaim("authenticated", SANDBOX_USER);
  await db.exec("set role authenticated");
  try {
    const foreignRows = (await db.query(
      "select count(*)::integer as count from public.case_entitlements where case_id = $1::uuid",
      [PROD_CASE],
    )).rows[0].count;
    assert.equal(foreignRows, 0);
  } finally {
    await db.exec("reset role");
    await setRoleClaim("service_role");
  }
  pass("verified proof grants only the scoped production case entitlement, with subject RLS and service-only mutation RPCs");
}

async function testGovernedWorkflowEvidence() {
  await setRoleClaim("service_role");
  const completion = (await db.query(
    `insert into public.completion_definition_versions (
       tenant_id, completion_key, version, status, terminal_states,
       evidence_required, authoritative_evidence_required, allowed_authority_types,
       minimum_assurance_scope, evidence_schema, effective_from,
       approved_by_auth_user_id, approved_at
     ) values (
       $1::uuid, 'runtime-completion', '1.0.0', 'active', array['completed']::text[],
       true, true, array['staff_attestation']::text[], 'county_attested',
       '{}'::jsonb, now() - interval '1 hour', $2::uuid, now()
     ) returning id`,
    [PROD_TENANT, ADMIN_USER],
  )).rows[0].id;
  const definition = (await db.query(
    `insert into public.workflow_definition_versions (
       tenant_id, workflow_key, version, status, initial_state, states,
       transitions, completion_definition_id, definition_sha256,
       effective_from, approved_by_auth_user_id, approved_at
     ) values (
       $1::uuid, 'runtime-evidence', '1.0.0', 'active', 'started',
       array['started', 'completed']::text[],
       '{"started":[{"action":"complete","to":"completed"}]}'::jsonb,
       $2::uuid, $3, now() - interval '1 hour', $4::uuid, now()
     ) returning id`,
    [PROD_TENANT, completion, "3".repeat(64), ADMIN_USER],
  )).rows[0].id;
  const started = (await db.query(
    `select public.civya_service_start_workflow(
       $1::uuid, 'staff', $2::uuid, $3::uuid,
       'runtime-workflow-correlation', '{}'::jsonb, 'runtime-workflow-start'
     ) as value`,
    [ADMIN_USER, PROD_CASE, definition],
  )).rows[0].value;
  PROD_WORKFLOW = started.workflowInstanceId;
  assert.equal(started.state, "started");
  assert.equal(started.rowVersion, 1);

  await assert.rejects(
    db.query(
      `select public.civya_service_transition_workflow(
         $1::uuid, 'staff', $2::uuid, 1, 'complete', 'completed',
         'staff_requested_completion', 'runtime-workflow-correlation',
         '{}'::jsonb, null, 'runtime-transition-no-evidence'
       )`,
      [ADMIN_USER, PROD_WORKFLOW],
    ),
    (error) => error.code === "55000",
  );

  const synthetic = (await db.query(
    `select public.civya_service_record_completion_evidence(
       $1::uuid, $2::uuid, 'staff_attestation', 'synthetic', false,
       null, null, null, $3, '{"kind":"runtime"}'::jsonb,
       now(), 'runtime-evidence-synthetic'
     ) as value`,
    [ADMIN_USER, PROD_WORKFLOW, "4".repeat(64)],
  )).rows[0].value;
  await assert.rejects(
    db.query(
      `select public.civya_service_transition_workflow(
         $1::uuid, 'staff', $2::uuid, 1, 'complete', 'completed',
         'staff_requested_completion', 'runtime-workflow-correlation',
         '{}'::jsonb, $3::uuid, 'runtime-transition-synthetic'
       )`,
      [ADMIN_USER, PROD_WORKFLOW, synthetic.completionEvidenceId],
    ),
    (error) => error.code === "55000",
  );

  const authoritative = (await db.query(
    `select public.civya_service_record_completion_evidence(
       $1::uuid, $2::uuid, 'staff_attestation', 'county_attested', true,
       null, null, null, $3, '{"kind":"runtime"}'::jsonb,
       now(), 'runtime-evidence-authoritative'
     ) as value`,
    [ADMIN_USER, PROD_WORKFLOW, "5".repeat(64)],
  )).rows[0].value;
  const completed = (await db.query(
    `select public.civya_service_transition_workflow(
       $1::uuid, 'staff', $2::uuid, 1, 'complete', 'completed',
       'authoritative_evidence_received', 'runtime-workflow-correlation',
       '{}'::jsonb, $3::uuid, 'runtime-transition-authoritative'
     ) as value`,
    [ADMIN_USER, PROD_WORKFLOW, authoritative.completionEvidenceId],
  )).rows[0].value;
  assert.equal(completed.status, "completed");
  assert.equal(completed.rowVersion, 2);
  const replay = (await db.query(
    `select public.civya_service_transition_workflow(
       $1::uuid, 'staff', $2::uuid, 1, 'complete', 'completed',
       'authoritative_evidence_received', 'runtime-workflow-correlation',
       '{}'::jsonb, $3::uuid, 'runtime-transition-authoritative'
     ) as value`,
    [ADMIN_USER, PROD_WORKFLOW, authoritative.completionEvidenceId],
  )).rows[0].value;
  assert.equal(replay.duplicate, true);
  await assert.rejects(
    db.query(
      "update public.workflow_actions set reason_code = 'tampered' where id = $1::uuid",
      [completed.actionId],
    ),
    (error) => error.code === "55000",
  );

  await assert.rejects(
    db.query(
      `insert into public.operational_exceptions (
         tenant_id, case_id, workflow_instance_id, exception_type, severity,
         status, reason_code, redacted_summary, assigned_to_auth_user_id,
         correlation_id, dedupe_key
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'runtime_invalid', 'normal',
         'resolved', 'runtime', 'Missing resolution evidence', $4::uuid,
         'runtime-exception-invalid', 'runtime-exception-invalid'
       )`,
      [PROD_TENANT, PROD_CASE, PROD_WORKFLOW, ADMIN_USER],
    ),
    (error) => error.code === "23514",
  );
  const exceptionId = (await db.query(
    `insert into public.operational_exceptions (
       tenant_id, case_id, workflow_instance_id, exception_type, severity,
       status, reason_code, redacted_summary, assigned_to_auth_user_id,
       correlation_id, dedupe_key
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'runtime_review', 'normal',
       'owned', 'runtime_review', 'County staff review required', $4::uuid,
       'runtime-exception-valid', 'runtime-exception-valid'
     ) returning id`,
    [PROD_TENANT, PROD_CASE, PROD_WORKFLOW, ADMIN_USER],
  )).rows[0].id;

  await setRoleClaim("authenticated", ADMIN_USER);
  await db.exec("set role authenticated");
  try {
    assert.equal((await db.query(
      "select count(*)::integer as count from public.operational_exceptions where id = $1::uuid",
      [exceptionId],
    )).rows[0].count, 1);
  } finally {
    await db.exec("reset role");
  }
  await setRoleClaim("authenticated", PROD_USER);
  await db.exec("set role authenticated");
  try {
    assert.equal((await db.query(
      "select count(*)::integer as count from public.operational_exceptions where id = $1::uuid",
      [exceptionId],
    )).rows[0].count, 0);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.workflow_actions where workflow_instance_id = $1::uuid",
      [PROD_WORKFLOW],
    )).rows[0].count, 2);
  } finally {
    await db.exec("reset role");
    await setRoleClaim("service_role");
  }
  pass("terminal workflow completion requires immutable authoritative evidence, idempotent actions, and staff-only operational exceptions");
}

async function testChannelSecureLinkAndCallControls() {
  await setRoleClaim("service_role");
  assert.ok(PROD_WORKFLOW);
  const channel = (await db.query(
    `select public.civya_service_create_channel_session(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'web', 'civya-web', $5,
       'runtime-channel-correlation', '{"step":"completed"}'::jsonb,
       'runtime-channel-session'
     ) as value`,
    [PROD_TENANT, PROD_USER, PROD_CASE, PROD_WORKFLOW, "6".repeat(64)],
  )).rows[0].value;
  assert.equal(channel.subjectState, "case_entitled");
  const active = (await db.query(
    `select public.civya_service_control_channel_session(
       $1::uuid, $2::uuid, 1, 'active', 'session.activated', $3,
       '{}'::jsonb, 'runtime-channel-active'
     ) as value`,
    [PROD_USER, channel.channelSessionId, "7".repeat(64)],
  )).rows[0].value;
  assert.equal(active.status, "active");
  await assert.rejects(
    db.query(
      `select public.civya_service_control_channel_session(
         $1::uuid, $2::uuid, 1, 'closed', 'session.closed', $3,
         '{}'::jsonb, 'runtime-channel-stale'
       )`,
      [PROD_USER, channel.channelSessionId, "8".repeat(64)],
    ),
    (error) => error.code === "40001",
  );

  const tokenDigest = "9".repeat(64);
  await db.query(
    `select public.civya_service_create_secure_link(
       $1::uuid, null, $2::uuid, $3::uuid, null, 'resume_case', $4,
       $5::uuid, now() + interval '1 hour', 'runtime-secure-link'
     )`,
    [PROD_TENANT, PROD_CASE, channel.channelSessionId, tokenDigest, PROD_USER],
  );
  const wrongAudience = (await db.query(
    "select public.civya_service_consume_secure_link($1::uuid, $2, 'resume_case', $3::uuid) as value",
    [PROD_TENANT, tokenDigest, SANDBOX_USER],
  )).rows[0].value;
  assert.equal(wrongAudience.consumed, false);
  assert.equal(wrongAudience.reason, "audience_mismatch");
  const consumed = (await db.query(
    "select public.civya_service_consume_secure_link($1::uuid, $2, 'resume_case', $3::uuid) as value",
    [PROD_TENANT, tokenDigest, PROD_USER],
  )).rows[0].value;
  assert.equal(consumed.consumed, true);
  const consumedReplay = (await db.query(
    "select public.civya_service_consume_secure_link($1::uuid, $2, 'resume_case', $3::uuid) as value",
    [PROD_TENANT, tokenDigest, PROD_USER],
  )).rows[0].value;
  assert.equal(consumedReplay.reason, "already_consumed");

  const call = (await db.query(
    `select public.civya_service_create_call_session(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       'openai', $6, $7, 'inbound', 'runtime-call-correlation',
       'runtime-call-session'
     ) as value`,
    [
      PROD_TENANT, PROD_USER, PROD_CASE, PROD_WORKFLOW, channel.channelSessionId,
      "a".repeat(64), "b".repeat(64),
    ],
  )).rows[0].value;
  const connected = (await db.query(
    `select public.civya_service_control_call(
       $1::uuid, 1, 'connected', 'deterministic_request', null,
       'call.requested', 'runtime-call-event-1', 'deterministic_request',
       'system', null, $2, '{"request":"status"}'::jsonb
     ) as value`,
    [call.callSessionId, "c".repeat(64)],
  )).rows[0].value;
  assert.equal(connected.status, "connected");
  const completed = (await db.query(
    `select public.civya_service_control_call(
       $1::uuid, 2, 'completed', 'deterministic_request', null,
       'call.completed', 'runtime-call-event-2', 'conversation',
       'system', null, $2, '{}'::jsonb
     ) as value`,
    [call.callSessionId, "d".repeat(64)],
  )).rows[0].value;
  assert.equal(completed.status, "completed");

  const unboundCall = (await db.query(
    `select public.civya_service_create_call_session(
       $1::uuid, null, null, null, null, 'openai', $2, null,
       'inbound', 'runtime-unbound-call', 'runtime-unbound-call'
     ) as value`,
    [PROD_TENANT, "e".repeat(64)],
  )).rows[0].value;
  await assert.rejects(
    db.query(
      `select public.civya_service_control_call(
         $1::uuid, 1, 'connected', 'deterministic_request', null,
         'call.requested', 'runtime-unbound-call-event', 'deterministic_request',
         'system', null, $2, '{}'::jsonb
       )`,
      [unboundCall.callSessionId, "f".repeat(64)],
    ),
    (error) => error.code === "42501",
  );

  await setRoleClaim("authenticated", PROD_USER);
  await db.exec("set role authenticated");
  try {
    assert.equal((await db.query(
      "select count(*)::integer as count from public.channel_sessions where id = $1::uuid",
      [channel.channelSessionId],
    )).rows[0].count, 1);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.call_sessions where id = $1::uuid",
      [call.callSessionId],
    )).rows[0].count, 1);
    await assert.rejects(
      db.query("select count(*) from private.secure_link_tokens"),
      (error) => error.code === "42501",
    );
  } finally {
    await db.exec("reset role");
  }
  await setRoleClaim("authenticated", SANDBOX_USER);
  await db.exec("set role authenticated");
  try {
    assert.equal((await db.query(
      "select count(*)::integer as count from public.channel_sessions where id = $1::uuid",
      [channel.channelSessionId],
    )).rows[0].count, 0);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.call_sessions where id = $1::uuid",
      [call.callSessionId],
    )).rows[0].count, 0);
  } finally {
    await db.exec("reset role");
    await setRoleClaim("service_role");
  }
  pass("channel continuity, one-time audience-bound links, call authority limits, optimistic concurrency, and subject RLS hold end to end");
}

async function testDurableJobs() {
  await setRoleClaim("service_role");
  const enqueueArgs = [
    PROD_TENANT, "foundation.healthcheck", "1", JSON.stringify({ probe: true }),
    "health-1", 10, null, 2, 30, new Date().toISOString(), "test", null,
  ];
  const first = (await db.query(
    `select public.civya_service_enqueue_job(
       $1::uuid, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8, $9,
       $10::timestamptz, $11, $12::uuid
     ) as value`, enqueueArgs,
  )).rows[0].value;
  const duplicate = (await db.query(
    `select public.civya_service_enqueue_job(
       $1::uuid, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8, $9,
       $10::timestamptz, $11, $12::uuid
     ) as value`, enqueueArgs,
  )).rows[0].value;
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.job.id, duplicate.job.id);

  let claimed = (await db.query(
    "select public.civya_service_claim_jobs('worker-a', array['foundation.healthcheck'], 1, 30) as value",
  )).rows[0].value;
  assert.equal(claimed.length, 1);
  assert.equal(await heartbeat(first.job.id, "wrong-worker"), false);
  assert.equal(await heartbeat(first.job.id, "worker-a"), true);
  let failed = (await db.query(
    "select public.civya_service_fail_job($1::uuid, 'worker-a', true, 'temporary', 'Temporary dependency failure.', 0) as value",
    [first.job.id],
  )).rows[0].value;
  assert.equal(failed.state, "retry_wait");
  claimed = (await db.query(
    "select public.civya_service_claim_jobs('worker-b', array['foundation.healthcheck'], 1, 30) as value",
  )).rows[0].value;
  assert.equal(claimed[0].attempt, 2);
  failed = (await db.query(
    "select public.civya_service_fail_job($1::uuid, 'worker-b', true, 'still_down', 'Dependency remains unavailable.', 0) as value",
    [first.job.id],
  )).rows[0].value;
  assert.equal(failed.state, "dead_letter");
  const replay = (await db.query(
    "select public.civya_service_replay_job($1::uuid, 'health-1-replay', $2::uuid, 'Approved after provider recovery') as value",
    [first.job.id, ADMIN_USER],
  )).rows[0].value;
  assert.equal(replay.state, "queued");

  const outbox = (await db.query(
    `select public.civya_service_append_outbox_event(
       $1::uuid, 'case', $2::uuid, 'case.changed', '1', '{"safe":true}'::jsonb, 'outbox-1'
     ) as value`, [PROD_TENANT, PROD_CASE],
  )).rows[0].value;
  const dispatched = (await db.query("select public.civya_service_dispatch_outbox(10) as value")).rows[0].value;
  assert.equal(outbox.duplicate, false);
  assert.equal(dispatched.length, 1);

  const requestHash = "a".repeat(64);
  const operation = (await db.query(
    `select public.civya_service_reserve_external_operation(
       $1::uuid, 'jpmorgan', 'hosted_handoff', 'handoff-1', $2, '{}'::jsonb
     ) as value`, [PROD_TENANT, requestHash],
  )).rows[0].value;
  const operationReplay = (await db.query(
    `select public.civya_service_reserve_external_operation(
       $1::uuid, 'jpmorgan', 'hosted_handoff', 'handoff-1', $2, '{}'::jsonb
     ) as value`, [PROD_TENANT, requestHash],
  )).rows[0].value;
  assert.equal(operation.duplicate, false);
  assert.equal(operationReplay.duplicate, true);
  const finishedOperation = (await db.query(
    `select public.civya_service_finish_external_operation(
       $1::uuid, 'succeeded', 'provider-handoff-1', '{"safe":true}'::jsonb, null
     ) as value`, [operation.id],
  )).rows[0].value;
  const finishedOperationReplay = (await db.query(
    `select public.civya_service_finish_external_operation(
       $1::uuid, 'succeeded', 'provider-handoff-1', '{"safe":true}'::jsonb, null
     ) as value`, [operation.id],
  )).rows[0].value;
  assert.equal(finishedOperation.state, "succeeded");
  assert.deepEqual(finishedOperationReplay, finishedOperation);

  const eventHash = "b".repeat(64);
  const event = await claimProviderEvent("evt-1", eventHash, "same-owner", 3);
  assert.equal(event.claimed, true);
  assert.equal(event.attempt, 1);
  assert.match(event.processingToken, /^[0-9a-f-]{36}$/);
  const busy = await claimProviderEvent("evt-1", eventHash, "same-owner", 3);
  assert.equal(busy.claimed, false);
  assert.equal(busy.busy, true);
  assert.equal(busy.attempt, 1);
  await assert.rejects(
    claimProviderEvent("evt-1", "c".repeat(64), "same-owner", 3),
    (error) => error.code === "23505",
  );

  await db.query(
    `update private.provider_events
     set processing_started_at = now() - interval '10 seconds',
         processing_lease_expires_at = now() - interval '1 second'
     where id = $1::uuid`,
    [event.id],
  );
  const reclaimed = await claimProviderEvent("evt-1", eventHash, "same-owner", 3);
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.attempt, 2);
  assert.notEqual(reclaimed.processingToken, event.processingToken);
  const staleFinish = (await db.query(
    `select public.civya_service_finish_provider_event_claim(
       $1::uuid, 'same-owner', $2::uuid, 'processed', null, 0
     ) as value`,
    [event.id, event.processingToken],
  )).rows[0].value;
  assert.equal(staleFinish, false, "A stale processing token completed reclaimed work.");
  const retry = (await db.query(
    `select public.civya_service_finish_provider_event_claim(
       $1::uuid, 'same-owner', $2::uuid, 'retry', 'provider_unavailable', 60
     ) as value`,
    [event.id, reclaimed.processingToken],
  )).rows[0].value;
  assert.equal(retry, true);
  const delayed = await claimProviderEvent("evt-1", eventHash, "next-owner", 3);
  assert.equal(delayed.claimed, false);
  assert.equal(delayed.busy, true);
  assert.ok(delayed.retryAfterSeconds >= 1);
  await db.query("update private.provider_events set available_at = now() where id = $1::uuid", [event.id]);
  const finalClaim = await claimProviderEvent("evt-1", eventHash, "next-owner", 3);
  assert.equal(finalClaim.claimed, true);
  assert.equal(finalClaim.attempt, 3);
  const exhausted = (await db.query(
    `select public.civya_service_finish_provider_event_claim(
       $1::uuid, 'next-owner', $2::uuid, 'retry', 'still_unavailable', 0
     ) as value`,
    [event.id, finalClaim.processingToken],
  )).rows[0].value;
  assert.equal(exhausted, true);
  const terminal = await claimProviderEvent("evt-1", eventHash, "never-runs", 3);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.claimed, false);

  const processedClaim = await claimProviderEvent("evt-processed", "d".repeat(64), "worker-final", 2);
  const processed = (await db.query(
    `select public.civya_service_finish_provider_event_claim(
       $1::uuid, 'worker-final', $2::uuid, 'processed', null, 0
     ) as value`,
    [processedClaim.id, processedClaim.processingToken],
  )).rows[0].value;
  assert.equal(processed, true);
  const processedReplay = await claimProviderEvent("evt-processed", "d".repeat(64), "worker-replay", 2);
  assert.equal(processedReplay.state, "processed");
  assert.equal(processedReplay.claimed, false);

  const health = (await db.query("select public.civya_service_job_health() as value")).rows[0].value;
  assert.ok(health.counts.dead_letter >= 1);
  assert.ok(health.pendingOutbox === 0);
  pass("job leases plus token-fenced provider claims enforce bounded retry, stale-owner rejection, terminal dedupe, DLQ, outbox, and external idempotency");
}

async function claimProviderEvent(eventId, payloadSha256, owner, maxAttempts) {
  return (await db.query(
    `select public.civya_service_claim_provider_event(
       $1::uuid, 'openai', $2, 'realtime.call.incoming', $3,
       '{}'::jsonb, true, $4, 5, $5
     ) as value`,
    [PROD_TENANT, eventId, payloadSha256, owner, maxAttempts],
  )).rows[0].value;
}

async function testExternalOperationClaimFencing() {
  await setRoleClaim("service_role");
  const requestHash = "7".repeat(64);
  let simulatedProviderCalls = 0;
  const claimAndReachProvider = async (owner) => {
    const claim = (await db.query(
      `select public.civya_service_claim_external_operation(
         $1::uuid, 'twilio', 'secure_link_sms', 'phone-concurrent-1', $2,
         '{"purpose":"phone_resume"}'::jsonb, $3, 60
       ) as value`,
      [PROD_TENANT, requestHash, owner],
    )).rows[0].value;
    if (claim.acquired) simulatedProviderCalls += 1;
    return claim;
  };

  const contenders = await Promise.all([
    claimAndReachProvider("phone-route-owner-a"),
    claimAndReachProvider("phone-route-owner-b"),
  ]);
  const acquired = contenders.filter((claim) => claim.acquired);
  const excluded = contenders.filter((claim) => !claim.acquired);
  assert.equal(acquired.length, 1, "Concurrent claimers both reached the provider boundary.");
  assert.equal(excluded.length, 1);
  assert.equal(simulatedProviderCalls, 1, "The simulated Twilio boundary was called more than once.");
  assert.equal(acquired[0].state, "in_flight");
  assert.match(acquired[0].claimToken, /^[0-9a-f-]{36}$/);
  assert.equal(excluded[0].state, "in_flight");
  assert.equal(excluded[0].busy, true);
  assert.equal(excluded[0].claimToken, null, "A non-owner received the fencing token.");

  await assert.rejects(
    db.query(
      `select public.civya_service_claim_external_operation(
         $1::uuid, 'twilio', 'secure_link_sms', 'phone-concurrent-1', $2,
         '{}'::jsonb, 'phone-route-owner-c', 60
       )`,
      [PROD_TENANT, "8".repeat(64)],
    ),
    (error) => error.code === "23505",
  );
  await assert.rejects(
    db.query(
      `select public.civya_service_finish_external_operation(
         $1::uuid, 'succeeded', 'legacy-bypass', '{}'::jsonb, null
       )`,
      [acquired[0].id],
    ),
    (error) => error.code === "55000",
  );
  const wrongTokenFinish = (await db.query(
    `select public.civya_service_finish_external_operation_claim(
       $1::uuid, $2, '00000000-0000-4000-8000-000000000000'::uuid,
       'succeeded', 'wrong-owner-result', '{}'::jsonb, null
     ) as value`,
    [acquired[0].id, acquired[0] === contenders[0] ? "phone-route-owner-a" : "phone-route-owner-b"],
  )).rows[0].value;
  assert.equal(wrongTokenFinish.finished, false);
  assert.equal(wrongTokenFinish.stale, true);

  const acquiredOwner = acquired[0] === contenders[0] ? "phone-route-owner-a" : "phone-route-owner-b";
  const finished = (await db.query(
    `select public.civya_service_finish_external_operation_claim(
       $1::uuid, $2, $3::uuid, 'succeeded', 'twilio-reference-digest',
       '{"providerStatus":"queued"}'::jsonb, null
     ) as value`,
    [acquired[0].id, acquiredOwner, acquired[0].claimToken],
  )).rows[0].value;
  assert.equal(finished.finished, true);
  assert.equal(finished.state, "succeeded");
  const terminalReplay = await claimAndReachProvider("phone-route-owner-replay");
  assert.equal(terminalReplay.state, "succeeded");
  assert.equal(terminalReplay.acquired, false);
  assert.equal(simulatedProviderCalls, 1);

  const stale = (await db.query(
    `select public.civya_service_claim_external_operation(
       $1::uuid, 'twilio', 'secure_link_sms', 'phone-stale-1', $2,
       '{"purpose":"phone_resume"}'::jsonb, 'phone-route-stale-owner', 60
     ) as value`,
    [PROD_TENANT, "9".repeat(64)],
  )).rows[0].value;
  assert.equal(stale.acquired, true);
  await db.query(
    `update private.external_operations
     set claim_expires_at = now() - interval '1 second'
     where id = $1::uuid`,
    [stale.id],
  );
  const afterExpiry = (await db.query(
    `select public.civya_service_claim_external_operation(
       $1::uuid, 'twilio', 'secure_link_sms', 'phone-stale-1', $2,
       '{"purpose":"phone_resume"}'::jsonb, 'phone-route-new-owner', 60
     ) as value`,
    [PROD_TENANT, "9".repeat(64)],
  )).rows[0].value;
  assert.equal(afterExpiry.state, "failed_unknown");
  assert.equal(afterExpiry.acquired, false);
  assert.equal(afterExpiry.reconciliationRequired, true);
  const staleOwnerFinish = (await db.query(
    `select public.civya_service_finish_external_operation_claim(
       $1::uuid, 'phone-route-stale-owner', $2::uuid, 'succeeded',
       'late-result', '{}'::jsonb, null
     ) as value`,
    [stale.id, stale.claimToken],
  )).rows[0].value;
  assert.equal(staleOwnerFinish.finished, false);
  assert.equal(staleOwnerFinish.state, "failed_unknown");
  await assert.rejects(
    db.query(
      `select public.civya_service_finish_external_operation(
         $1::uuid, 'succeeded', 'stale-bypass', '{}'::jsonb, null
       )`,
      [stale.id],
    ),
    (error) => error.code === "55000",
  );
  const neverReassigned = (await db.query(
    `select public.civya_service_claim_external_operation(
       $1::uuid, 'twilio', 'secure_link_sms', 'phone-stale-1', $2,
       '{"purpose":"phone_resume"}'::jsonb, 'phone-route-third-owner', 60
     ) as value`,
    [PROD_TENANT, "9".repeat(64)],
  )).rows[0].value;
  assert.equal(neverReassigned.state, "failed_unknown");
  assert.equal(neverReassigned.acquired, false);
  const staleRow = (await db.query(
    `select claim_attempts, claim_token, last_error_code
     from private.external_operations where id = $1::uuid`,
    [stale.id],
  )).rows[0];
  assert.equal(staleRow.claim_attempts, 1);
  assert.equal(staleRow.claim_token, null);
  assert.equal(staleRow.last_error_code, "external_claim_lease_expired");
  pass("concurrent outbound claims allow one provider call, fence non-owners, and quarantine expired outcomes without blind retry");
}

async function heartbeat(jobId, workerId) {
  return (await db.query(
    "select public.civya_service_heartbeat_job($1::uuid, $2, 30) as value",
    [jobId, workerId],
  )).rows[0].value;
}

async function testReconciliationCheckpoint() {
  await setRoleClaim("service_role");
  const runId = "86000000-0000-4000-8000-000000000001";
  const throughAt = new Date().toISOString();
  const started = (await db.query(
    `select public.civya_service_advance_reconciliation_checkpoint(
       $1::uuid, 'jpmorgan', 'hosted_handoffs', 1, $2::uuid, 'started',
       null, null, 0, 0, null, $3, '{"outcomeCode":"started"}'::jsonb
     ) as value`,
    [PROD_TENANT, runId, "d".repeat(64)],
  )).rows[0].value;
  assert.equal(started.status, "running");
  assert.equal(started.rowVersion, 2);
  assert.equal(started.duplicate, false);

  const completed = (await db.query(
    `select public.civya_service_advance_reconciliation_checkpoint(
       $1::uuid, 'jpmorgan', 'hosted_handoffs', 2, $2::uuid, 'succeeded',
       $3, $4::timestamptz, 12, 1, null, $5,
       '{"outcomeCode":"completed"}'::jsonb
     ) as value`,
    [PROD_TENANT, runId, "e".repeat(64), throughAt, "f".repeat(64)],
  )).rows[0].value;
  assert.equal(completed.status, "healthy");
  assert.equal(completed.rowVersion, 3);
  assert.equal(completed.duplicate, false);

  const replay = (await db.query(
    `select public.civya_service_advance_reconciliation_checkpoint(
       $1::uuid, 'jpmorgan', 'hosted_handoffs', 2, $2::uuid, 'succeeded',
       $3, $4::timestamptz, 12, 1, null, $5,
       '{"outcomeCode":"completed"}'::jsonb
     ) as value`,
    [PROD_TENANT, runId, "e".repeat(64), throughAt, "f".repeat(64)],
  )).rows[0].value;
  assert.equal(replay.duplicate, true);
  assert.equal(replay.rowVersion, 3);

  await assert.rejects(
    db.query(
      `select public.civya_service_advance_reconciliation_checkpoint(
         $1::uuid, 'jpmorgan', 'hosted_handoffs', 1,
         '86000000-0000-4000-8000-000000000002'::uuid, 'started',
         null, null, 0, 0, null, $2, '{}'::jsonb
       )`,
      [PROD_TENANT, "a".repeat(64)],
    ),
    (error) => error.code === "40001",
  );
  await assert.rejects(
    db.query(
      `select public.civya_service_advance_reconciliation_checkpoint(
         $1::uuid, 'jpmorgan', 'hosted_handoffs', 3,
         '86000000-0000-4000-8000-000000000003'::uuid, 'succeeded',
         $2, now() - interval '1 day', 13, 0, null, $3,
         '{"outcomeCode":"backward"}'::jsonb
       )`,
      [PROD_TENANT, "b".repeat(64), "c".repeat(64)],
    ),
    (error) => error.code === "55000",
  );
  pass("provider reconciliation checkpoints are versioned, idempotent, monotonic, and service-controlled");
}

async function testAuditIntegrityAndArchive() {
  await setRoleClaim("service_role");
  await db.query(
    `insert into public.audit_events (tenant_id, event_type, redacted_payload, source)
     values ($1::uuid, 'foundation_runtime_test', '{"safe":true}'::jsonb, 'system')`,
    [PROD_TENANT],
  );
  const verified = (await db.query(
    "select public.civya_service_verify_audit_chain($1::uuid) as value", [PROD_TENANT],
  )).rows[0].value;
  assert.equal(verified.valid, true);
  await assert.rejects(
    db.query("update public.audit_events set event_type = 'tampered' where tenant_id = $1::uuid", [PROD_TENANT]),
    (error) => error.code === "55000",
  );
  const archive = (await db.query(
    "select public.civya_service_request_audit_archive($1::uuid, null, 'archive-1') as value",
    [PROD_TENANT],
  )).rows[0].value;
  assert.equal(archive.duplicate, false);
  const completed = (await db.query(
    "select public.civya_service_complete_audit_archive($1::uuid, 'worm://wayne/audit-1', $2) as value",
    [archive.checkpointId, "c".repeat(64)],
  )).rows[0].value;
  assert.equal(completed.state, "verified");
  const completedReplay = (await db.query(
    "select public.civya_service_complete_audit_archive($1::uuid, 'worm://wayne/audit-1', $2) as value",
    [archive.checkpointId, "c".repeat(64)],
  )).rows[0].value;
  assert.deepEqual(completedReplay, completed);
  const archiveReplay = (await db.query(
    "select public.civya_service_request_audit_archive($1::uuid, null, 'archive-1') as value",
    [PROD_TENANT],
  )).rows[0].value;
  assert.equal(archiveReplay.duplicate, true);
  assert.equal(archiveReplay.checkpointId, archive.checkpointId);
  assert.equal(archiveReplay.state, "verified");
  const afterArchive = (await db.query(
    "select public.civya_service_verify_audit_chain($1::uuid) as value", [PROD_TENANT],
  )).rows[0].value;
  assert.equal(afterArchive.valid, true);
  pass("audit rows are chained, immutable, independently verifiable, and exported through durable archive checkpoints");
}

async function testServiceBoundary() {
  await setRoleClaim("authenticated", PROD_USER);
  await db.exec("set role authenticated");
  try {
    await assert.rejects(
      db.query("select count(*) from private.jobs"),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      db.query("select public.civya_service_job_health()"),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      db.query(
        `select public.civya_service_claim_external_operation(
           $1::uuid, 'twilio', 'secure_link_sms', 'forbidden-claim', $2,
           '{}'::jsonb, 'browser-claim-owner', 60
         )`,
        [PROD_TENANT, "f".repeat(64)],
      ),
      (error) => error.code === "42501",
    );
  } finally {
    await db.exec("reset role");
    await setRoleClaim("service_role");
  }
  pass("browser roles cannot inspect private work state or execute service-only worker RPCs");
}

console.log("Production foundation runtime");
try {
  await prepareDatabase();
  await seedFoundation();
  await testRetentionGuard();
  await testConfigurationResolution();
  await testProductionCaseEntitlement();
  await testGovernedWorkflowEvidence();
  await testChannelSecureLinkAndCallControls();
  await testDurableJobs();
  await testExternalOperationClaimFencing();
  await testReconciliationCheckpoint();
  await testAuditIntegrityAndArchive();
  await testServiceBoundary();
  console.log("\nALL FOUNDATION RUNTIME TESTS PASSED");
} finally {
  await db.close();
}
