#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { listWorkflowDefinitions } from "@/lib/workflows/definitions";
import {
  GovernedWorkflowRepository,
  GovernedWorkflowRepositoryError,
  workflowImplementationStatus,
  type WorkflowRpcInvoker,
} from "@/lib/workflows/repository.server";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const TENANT = "91000000-0000-4000-8000-000000000001";
const RESIDENT_USER = "92000000-0000-4000-8000-000000000001";
const OTHER_USER = "92000000-0000-4000-8000-000000000002";
const STAFF_USER = "92000000-0000-4000-8000-000000000003";
const RESIDENT = "93000000-0000-4000-8000-000000000001";
const CASE = "94000000-0000-4000-8000-000000000001";
const CHALLENGE = "95000000-0000-4000-8000-000000000001";
const ENTITLEMENT = "96000000-0000-4000-8000-000000000001";
const COMPLETION_DEFINITION = "97000000-0000-4000-8000-000000000001";
const WORKFLOW_DEFINITION = "98000000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const WORKFLOW_HARDENING_MIGRATION = "202607160024_workflow_outcome_and_privacy_guards.sql";

const db = new PGlite();

function pass(message: string): void {
  console.log(`  PASS  ${message}`);
}

async function prepareDatabase(): Promise<void> {
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
      select jsonb_build_object(
        'is_anonymous', coalesce(
          nullif(current_setting('request.jwt.claim.is_anonymous', true), '')::boolean,
          false
        )
      )
    $$;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        'service_role'
      )
    $$;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null,
      name text not null
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
  assert.ok(
    migrations.includes("202607160018_workflow_repository_boundaries.sql"),
    "governed workflow repository migration 018 must be present",
  );
  await setRole("service_role");
  pass(`applied ${migrations.length} migrations through the governed workflow repository boundary`);
}

async function testRetainedSchemaUpgrade(): Promise<void> {
  const retainedDb = new PGlite();
  const retainedResidentUser = "92000000-0000-4000-8000-000000000101";
  const retainedResident = "93000000-0000-4000-8000-000000000101";
  const retainedCase = "94000000-0000-4000-8000-000000000101";
  const invalidWorkflowDefinition = "98000000-0000-4000-8000-000000000101";
  const invalidWorkflowInstance = "99000000-0000-4000-8000-000000000101";
  const validCompletionDefinition = "97000000-0000-4000-8000-000000000102";
  const validWorkflowDefinition = "98000000-0000-4000-8000-000000000102";
  const validWorkflowInstance = "99000000-0000-4000-8000-000000000102";
  const invalidDraftCompletionDefinition = "97000000-0000-4000-8000-000000000103";
  const invalidDraftWorkflowDefinition = "98000000-0000-4000-8000-000000000103";
  const validDraftCompletionDefinition = "97000000-0000-4000-8000-000000000104";
  const validDraftWorkflowDefinition = "98000000-0000-4000-8000-000000000104";
  const retainedHandoff = "9a000000-0000-4000-8000-000000000102";
  const retainedProviderEvent = "9b000000-0000-4000-8000-000000000102";
  const unreferencedEvidence = "9c000000-0000-4000-8000-000000000101";
  const referencedEvidence = "9c000000-0000-4000-8000-000000000102";
  try {
    await retainedDb.exec(`
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
        select jsonb_build_object(
          'is_anonymous', coalesce(
            nullif(current_setting('request.jwt.claim.is_anonymous', true), '')::boolean,
            false
          )
        )
      $$;
      create or replace function auth.role() returns text language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role')
      $$;
      create table storage.buckets (
        id text primary key,
        name text not null,
        public boolean not null default false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      create table storage.objects (
        id uuid primary key default gen_random_uuid(),
        bucket_id text not null,
        name text not null
      );
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon, authenticated, service_role;
      grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
    `);

    const migrations = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
    const hardeningIndex = migrations.indexOf(WORKFLOW_HARDENING_MIGRATION);
    assert.ok(hardeningIndex > 0, "forward workflow hardening migration must be present");
    for (const name of migrations.slice(0, hardeningIndex)) {
      const sql = (await readFile(join(MIGRATIONS, name), "utf8"))
        .replace(/create extension if not exists pgcrypto;\s*/i, "");
      await retainedDb.exec(sql);
    }

    await retainedDb.query(
      `insert into auth.users (id, email) values
         ($1::uuid, 'retained-approver@example.test'),
         ($2::uuid, 'retained-resident@example.test')`,
      [STAFF_USER, retainedResidentUser],
    );
    await retainedDb.query(
      `insert into public.tenants (
         id, slug, name, environment, fictional, content_version, retention_days
       ) values ($1::uuid, 'retained-workflow', 'Retained Workflow Schema',
         'production', false, 'retained-v1', 2555)`,
      [TENANT],
    );
    await retainedDb.query(
      `insert into public.staff_roles (tenant_id, auth_user_id, role, status)
       values ($1::uuid, $2::uuid, 'admin', 'active')`,
      [TENANT, STAFF_USER],
    );
    await retainedDb.query(
      `insert into public.residents (
         id, tenant_id, auth_user_id, identity_state, first_name, last_name
       ) values ($1::uuid, $2::uuid, $3::uuid, 'verified', 'Retained', 'Resident')`,
      [retainedResident, TENANT, retainedResidentUser],
    );
    await retainedDb.query(
      `insert into public.cases (
         id, tenant_id, resident_id, status, active, next_best_action
       ) values ($1::uuid, $2::uuid, $3::uuid, 'intake_in_progress', true,
         'Review retained workflow migration safeguards.')`,
      [retainedCase, TENANT, retainedResident],
    );
    await retainedDb.query(
      `insert into public.completion_definition_versions (
         id, tenant_id, completion_key, version, status, terminal_states,
         evidence_required, authoritative_evidence_required, allowed_authority_types,
         minimum_assurance_scope, evidence_schema, effective_from,
         approved_by_auth_user_id, approved_at
       ) values (
         $1::uuid, $2::uuid, 'retained-payment-completion', 'pre-outcome-schema-v1',
         'active', array['active','reversed']::text[], true, true,
         array['provider_webhook']::text[], 'provider_attested',
         '{"requiredBindings":["workflowInstanceId","handoffSessionId"]}'::jsonb,
         now() - interval '1 day', $3::uuid, now() - interval '1 day'
       )`,
      [COMPLETION_DEFINITION, TENANT, STAFF_USER],
    );
    await retainedDb.query(
      `insert into public.completion_definition_versions (
         id, tenant_id, completion_key, version, status, terminal_states,
         evidence_required, authoritative_evidence_required, allowed_authority_types,
         minimum_assurance_scope, evidence_schema, effective_from,
         approved_by_auth_user_id, approved_at
       ) values (
         $1::uuid, $2::uuid, 'retained-valid-payment-completion', 'pre-024-valid-v1',
         'active', array['active','reversed']::text[], true, true,
         array['provider_webhook']::text[], 'provider_attested',
         '{
           "providerEventType":"payment.plan.updated",
           "requiredBindings":["workflowInstanceId","handoffSessionId"],
           "outcomeField":"planStatus",
           "terminalOutcomes":{"active":["active"],"reversed":["reversed"]}
         }'::jsonb,
         now() - interval '1 day', $3::uuid, now() - interval '1 day'
       )`,
      [validCompletionDefinition, TENANT, STAFF_USER],
    );
    await retainedDb.query(
      `insert into public.completion_definition_versions (
         id, tenant_id, completion_key, version, status, terminal_states,
         evidence_required, authoritative_evidence_required, allowed_authority_types,
         minimum_assurance_scope, evidence_schema, effective_from
       ) values (
         $1::uuid, $2::uuid, 'retained-draft-payment-completion', 'pre-024-draft-v1',
         'draft', array['active','reversed']::text[], true, true,
         array['provider_webhook']::text[], 'provider_attested',
         '{"requiredBindings":["workflowInstanceId","handoffSessionId"]}'::jsonb,
         now() - interval '1 day'
       )`,
      [invalidDraftCompletionDefinition, TENANT],
    );
    await retainedDb.query(
      `insert into public.completion_definition_versions (
         id, tenant_id, completion_key, version, status, terminal_states,
         evidence_required, authoritative_evidence_required, allowed_authority_types,
         minimum_assurance_scope, evidence_schema, effective_from
       ) values (
         $1::uuid, $2::uuid, 'retained-valid-draft-payment-completion',
         'pre-024-valid-draft-v1', 'draft', array['active','reversed']::text[],
         true, true, array['provider_webhook']::text[], 'provider_attested',
         '{
           "providerEventType":"payment.plan.updated",
           "requiredBindings":["workflowInstanceId","handoffSessionId"],
           "outcomeField":"planStatus",
           "terminalOutcomes":{"active":["active"],"reversed":["reversed"]}
         }'::jsonb,
         now() - interval '1 day'
       )`,
      [validDraftCompletionDefinition, TENANT],
    );
    await retainedDb.query(
      `insert into public.workflow_definition_versions (
         id, tenant_id, workflow_key, version, status, initial_state, states,
         transitions, completion_definition_id, definition_sha256,
         effective_from, approved_by_auth_user_id, approved_at
       ) values
       (
         $1::uuid, $3::uuid, 'retained_ambiguous_workflow', 'pre-024-v1',
         'active', 'pending', array['pending','active','reversed']::text[],
         '{"pending":[{"action":"provider.confirmed","to":"active","actors":["provider"]}]}'::jsonb,
         $4::uuid, $6, now() - interval '1 day', $5::uuid, now() - interval '1 day'
       ),
       (
         $2::uuid, $3::uuid, 'retained_valid_provider_workflow', 'pre-024-v1',
         'active', 'pending', array['pending','active','reversed']::text[],
         '{"pending":[{"action":"provider.confirmed","to":"active","actors":["provider"]}]}'::jsonb,
         $7::uuid, $8, now() - interval '1 day', $5::uuid, now() - interval '1 day'
       )`,
      [
        invalidWorkflowDefinition,
        validWorkflowDefinition,
        TENANT,
        COMPLETION_DEFINITION,
        STAFF_USER,
        HASH_A,
        validCompletionDefinition,
        HASH_B,
      ],
    );
    await retainedDb.query(
      `insert into public.workflow_definition_versions (
         id, tenant_id, workflow_key, version, status, initial_state, states,
         transitions, completion_definition_id, definition_sha256,
         effective_from, approved_by_auth_user_id, approved_at
       ) values (
         $1::uuid, $2::uuid, 'retained_draft_completion_workflow', 'pre-024-v1',
         'active', 'pending', array['pending','active','reversed']::text[],
         '{"pending":[{"action":"provider.confirmed","to":"active","actors":["provider"]}]}'::jsonb,
         $3::uuid, $4, now() - interval '1 day', $5::uuid, now() - interval '1 day'
       )`,
      [invalidDraftWorkflowDefinition, TENANT, invalidDraftCompletionDefinition, HASH_C, STAFF_USER],
    );
    await retainedDb.query(
      `insert into public.workflow_definition_versions (
         id, tenant_id, workflow_key, version, status, initial_state, states,
         transitions, completion_definition_id, definition_sha256,
         effective_from, approved_by_auth_user_id, approved_at
       ) values (
         $1::uuid, $2::uuid, 'retained_valid_draft_completion_workflow',
         'pre-024-v1', 'active', 'pending',
         array['pending','active','reversed']::text[],
         '{"pending":[{"action":"provider.confirmed","to":"active","actors":["provider"]}]}'::jsonb,
         $3::uuid, $4, now() - interval '1 day', $5::uuid, now() - interval '1 day'
       )`,
      [validDraftWorkflowDefinition, TENANT, validDraftCompletionDefinition, HASH_A, STAFF_USER],
    );
    await retainedDb.query(
      `insert into public.workflow_instances (
         id, tenant_id, resident_id, case_id, workflow_definition_id,
         completion_definition_id, workflow_key, definition_version,
         current_state, status, redacted_context, started_by_type,
         started_by_auth_user_id, correlation_id, idempotency_key
       ) values
       (
         $1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
         'retained_ambiguous_workflow', 'pre-024-v1', 'pending', 'active',
         '{}'::jsonb, 'staff', $8::uuid, 'retained-ambiguous-correlation',
         'retained-ambiguous-instance'
       ),
       (
         $2::uuid, $3::uuid, $4::uuid, $5::uuid, $9::uuid, $10::uuid,
         'retained_valid_provider_workflow', 'pre-024-v1', 'pending', 'active',
         '{}'::jsonb, 'staff', $8::uuid, 'retained-valid-correlation',
         'retained-valid-instance'
       )`,
      [
        invalidWorkflowInstance,
        validWorkflowInstance,
        TENANT,
        retainedResident,
        retainedCase,
        invalidWorkflowDefinition,
        COMPLETION_DEFINITION,
        STAFF_USER,
        validWorkflowDefinition,
        validCompletionDefinition,
      ],
    );
    await retainedDb.query(
      `insert into public.hosted_handoff_sessions (
         id, tenant_id, resident_id, case_id, workflow_instance_id,
         handoff_type, provider_key, provider_session_reference_digest,
         destination_origin, return_nonce_digest, idempotency_key, expires_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'payment',
         'retained_provider', $6, 'https://provider.example.test', $7,
         'retained-provider-handoff', now() + interval '1 hour'
       )`,
      [retainedHandoff, TENANT, retainedResident, retainedCase, validWorkflowInstance, HASH_A, HASH_B],
    );
    await retainedDb.query(
      `insert into private.provider_events (
         id, tenant_id, provider_key, external_event_id, event_type,
         payload_sha256, redacted_payload, signature_verified, state,
         received_at, processed_at
       ) values (
         $1::uuid, $2::uuid, 'retained_provider', 'retained-event-001',
         'payment.plan.updated', $3,
         jsonb_build_object(
           'workflowInstanceId', $4::uuid,
           'handoffSessionId', $5::uuid,
           'planStatus', 'active'
         ),
         true, 'processed', now() - interval '12 minutes',
         now() - interval '11 minutes'
       )`,
      [retainedProviderEvent, TENANT, HASH_C, validWorkflowInstance, retainedHandoff],
    );
    await retainedDb.query(
      `insert into public.workflow_completion_evidence (
         id, tenant_id, workflow_instance_id, case_id, completion_definition_id,
         authority_type, assurance_scope, authoritative, provider_event_id,
         evidence_sha256, redacted_evidence, observed_at, verified_by_type,
         idempotency_key
       ) values
       (
         $1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'provider_webhook', 'provider_attested', true, $7::uuid, $8,
         '{"planStatus":"reversed"}'::jsonb, now() - interval '8 minutes',
         'service', 'retained-evidence-unreferenced'
       ),
       (
         $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'provider_webhook', 'provider_attested', true, $7::uuid, $9,
         '{"planStatus":"active"}'::jsonb, now() - interval '10 minutes',
         'service', 'retained-evidence-referenced'
       )`,
      [
        unreferencedEvidence,
        referencedEvidence,
        TENANT,
        validWorkflowInstance,
        retainedCase,
        validCompletionDefinition,
        retainedProviderEvent,
        HASH_A,
        HASH_B,
      ],
    );
    await retainedDb.query(
      `select public.civya_service_transition_workflow(
         null, 'provider', $1::uuid, 1, 'provider.confirmed', 'active',
         'retained_provider_confirmed', 'retained-valid-correlation',
         '{}'::jsonb, $2::uuid, 'retained-valid-terminal-action'
       )`,
      [validWorkflowInstance, referencedEvidence],
    );

    const hardeningSql = (await readFile(join(MIGRATIONS, WORKFLOW_HARDENING_MIGRATION), "utf8"))
      .replace(/create extension if not exists pgcrypto;\s*/i, "");
    await retainedDb.exec(hardeningSql);

    const retained = await retainedDb.query<{ count: number }>(
      "select count(*)::integer as count from public.completion_definition_versions where id = $1::uuid",
      [COMPLETION_DEFINITION],
    );
    assert.equal(retained.rows[0].count, 1, "forward migration must retain existing governed records");
    const quarantine = await retainedDb.query<{
      completion_definition_id: string;
      reason_code: string;
      original_status: string;
      affected_definition_count: number;
      affected_instance_count: number;
    }>(
      `select completion_definition_id::text, reason_code, original_status,
              cardinality(affected_workflow_definition_ids)::integer
                as affected_definition_count,
              cardinality(affected_open_workflow_instance_ids)::integer
                as affected_instance_count
       from private.workflow_completion_definition_quarantine
       where completion_definition_id = any($1::uuid[])
       order by completion_definition_id`,
      [[COMPLETION_DEFINITION, invalidDraftCompletionDefinition, validDraftCompletionDefinition]],
    );
    assert.deepEqual(
      quarantine.rows.map((row) => ({
        id: row.completion_definition_id,
        reason: row.reason_code,
        status: row.original_status,
        definitions: row.affected_definition_count,
        instances: row.affected_instance_count,
      })),
      [
        {
          id: COMPLETION_DEFINITION,
          reason: "ambiguous_terminal_outcome_schema",
          status: "active",
          definitions: 1,
          instances: 1,
        },
        {
          id: invalidDraftCompletionDefinition,
          reason: "ambiguous_terminal_outcome_schema",
          status: "draft",
          definitions: 1,
          instances: 0,
        },
        {
          id: validDraftCompletionDefinition,
          reason: "non_runnable_completion_status",
          status: "draft",
          definitions: 1,
          instances: 0,
        },
      ],
      "active workflows must quarantine ambiguous completion contracts regardless of completion-row status",
    );
    const quarantinedInstance = await retainedDb.query<{
      status: string;
      row_version: number;
      severity: string;
      exception_status: string;
    }>(
      `select i.status, i.row_version::integer, e.severity,
              e.status as exception_status
       from public.workflow_instances i
       join public.operational_exceptions e on e.workflow_instance_id = i.id
       where i.id = $1::uuid
         and e.exception_type = 'completion_definition_quarantine'`,
      [invalidWorkflowInstance],
    );
    assert.deepEqual(quarantinedInstance.rows[0], {
      status: "escalated",
      row_version: 2,
      severity: "urgent",
      exception_status: "open",
    });
    const quarantineAudit = await retainedDb.query<{ count: number }>(
      `select count(*)::integer as count
       from public.audit_events
       where request_id = any($1::text[])`,
      [[
        `migration-024:completion-definition:${COMPLETION_DEFINITION}`,
        `migration-024:workflow-instance:${invalidWorkflowInstance}`,
        `migration-024:completion-definition:${invalidDraftCompletionDefinition}`,
        `migration-024:completion-definition:${validDraftCompletionDefinition}`,
      ]],
    );
    assert.equal(quarantineAudit.rows[0].count, 4, "quarantine decisions must be tamper-evident");

    const retainedEvidence = await retainedDb.query<{
      id: string;
      idempotency_key: string;
      evidence_sha256: string;
      outcome: string;
    }>(
      `select id::text, idempotency_key, evidence_sha256,
              redacted_evidence ->> 'planStatus' as outcome
       from public.workflow_completion_evidence
       where id = any($1::uuid[])
       order by id`,
      [[unreferencedEvidence, referencedEvidence]],
    );
    assert.deepEqual(retainedEvidence.rows, [
      {
        id: unreferencedEvidence,
        idempotency_key: "retained-evidence-unreferenced",
        evidence_sha256: HASH_A,
        outcome: "reversed",
      },
      {
        id: referencedEvidence,
        idempotency_key: "retained-evidence-referenced",
        evidence_sha256: HASH_B,
        outcome: "active",
      },
    ]);
    const retainedActionReference = await retainedDb.query<{ count: number }>(
      `select count(*)::integer as count
       from public.workflow_actions
       where workflow_instance_id = $1::uuid
         and completion_evidence_id = $2::uuid`,
      [validWorkflowInstance, referencedEvidence],
    );
    assert.equal(retainedActionReference.rows[0].count, 1, "historical action FK must remain unchanged");
    const registry = await retainedDb.query<{
      canonical_evidence_id: string;
      evidence_count: number;
      referenced_evidence_count: number;
      evidence_set_sha256: string;
      retained_exact: boolean;
      referenced_exact: boolean;
    }>(
      `select canonical_evidence_id::text,
              evidence_count::integer,
              referenced_evidence_count::integer,
              evidence_set_sha256,
              retained_evidence_ids @> array[$3::uuid,$4::uuid]
                and cardinality(retained_evidence_ids) = 2 as retained_exact,
              referenced_evidence_ids = array[$4::uuid] as referenced_exact
       from private.workflow_completion_provider_event_registry
       where workflow_instance_id = $1::uuid and provider_event_id = $2::uuid`,
      [validWorkflowInstance, retainedProviderEvent, unreferencedEvidence, referencedEvidence],
    );
    assert.deepEqual(
      {
        canonical: registry.rows[0].canonical_evidence_id,
        evidenceCount: registry.rows[0].evidence_count,
        referencedCount: registry.rows[0].referenced_evidence_count,
        retainedExact: registry.rows[0].retained_exact,
        referencedExact: registry.rows[0].referenced_exact,
      },
      {
        canonical: referencedEvidence,
        evidenceCount: 2,
        referencedCount: 1,
        retainedExact: true,
        referencedExact: true,
      },
      "the action-referenced evidence must be the deterministic canonical member",
    );
    assert.match(registry.rows[0].evidence_set_sha256, /^[0-9a-f]{64}$/);
    const evidenceRegistryAudit = await retainedDb.query<{ count: number }>(
      `select count(*)::integer as count
       from public.audit_events
       where event_type = 'workflow_provider_evidence_set_canonicalized'
         and redacted_payload ->> 'workflowInstanceId' = $1
         and redacted_payload ->> 'canonicalEvidenceId' = $2
         and redacted_payload ->> 'evidenceSetSha256' = $3`,
      [validWorkflowInstance, referencedEvidence, registry.rows[0].evidence_set_sha256],
    );
    assert.equal(evidenceRegistryAudit.rows[0].count, 1, "canonical choice must enter the tamper-evident audit chain");

    await retainedDb.query(
      `select private.civya_validate_terminal_completion_evidence(
         $1::uuid, $2::uuid, $3::uuid, 'active', null
       )`,
      [validWorkflowInstance, validCompletionDefinition, referencedEvidence],
    );
    await assert.rejects(
      retainedDb.query(
        `select private.civya_validate_terminal_completion_evidence(
           $1::uuid, $2::uuid, $3::uuid, 'reversed', $4::uuid
         )`,
        [
          validWorkflowInstance,
          validCompletionDefinition,
          unreferencedEvidence,
          referencedEvidence,
        ],
      ),
      (error) => databaseError(error, "55000"),
    );
    await assert.rejects(
      retainedDb.query(
        `insert into public.workflow_completion_evidence (
           tenant_id, workflow_instance_id, case_id, completion_definition_id,
           authority_type, assurance_scope, authoritative, provider_event_id,
           evidence_sha256, redacted_evidence, observed_at, verified_by_type,
           idempotency_key
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'provider_webhook',
           'provider_attested', true, $5::uuid, $6,
           '{"planStatus":"active"}'::jsonb, now(), 'service',
           'retained-evidence-future-repackaging'
         )`,
        [
          TENANT,
          validWorkflowInstance,
          retainedCase,
          validCompletionDefinition,
          retainedProviderEvent,
          HASH_C,
        ],
      ),
      (error) => databaseError(error, "23505"),
    );
    const atomicDuplicateRejection = await retainedDb.query<{ count: number }>(
      `select count(*)::integer as count
       from public.workflow_completion_evidence
       where workflow_instance_id = $1::uuid and provider_event_id = $2::uuid`,
      [validWorkflowInstance, retainedProviderEvent],
    );
    assert.equal(atomicDuplicateRejection.rows[0].count, 2, "failed repackaging must roll back atomically");

    const guards = await retainedDb.query<{ count: number }>(
      `select count(*)::integer as count from pg_trigger
       where not tgisinternal and tgname = any($1::text[])`,
      [[
        "completion_definition_outcome_schema_guard",
        "workflow_completion_evidence_authority_guard",
        "workflow_actions_completion_outcome_guard",
        "workflow_instances_resident_context_guard",
        "workflow_actions_privacy_guard",
        "workflow_definition_completion_quarantine_guard",
        "workflow_instances_completion_quarantine_guard",
        "workflow_actions_completion_quarantine_guard",
        "workflow_completion_evidence_provider_event_registry_guard",
      ]],
    );
    assert.equal(guards.rows[0].count, 9);
    await assert.rejects(
      retainedDb.query(
        `select public.civya_service_start_governed_workflow(
           $1::uuid, 'staff', $2::uuid, 'retained_ambiguous_workflow',
           'retained-governed-start', '{}'::jsonb, 'retained-governed-start-001'
         )`,
        [STAFF_USER, retainedCase],
      ),
      (error) => databaseError(error, "P0002"),
    );
    await assert.rejects(
      retainedDb.query(
        `select public.civya_service_start_governed_workflow(
           $1::uuid, 'staff', $2::uuid, 'retained_valid_draft_completion_workflow',
           'retained-valid-draft-start', '{}'::jsonb,
           'retained-valid-draft-start-001'
         )`,
        [STAFF_USER, retainedCase],
      ),
      (error) => databaseError(error, "P0002"),
    );
    await assert.rejects(
      retainedDb.query(
        `select public.civya_service_start_governed_workflow(
           $1::uuid, 'staff', $2::uuid, 'retained_draft_completion_workflow',
           'retained-draft-start', '{}'::jsonb, 'retained-draft-start-001'
         )`,
        [STAFF_USER, retainedCase],
      ),
      (error) => databaseError(error, "P0002"),
    );
    await assert.rejects(
      retainedDb.query(
        `select public.civya_service_start_workflow(
           $1::uuid, 'staff', $2::uuid, $3::uuid,
           'retained-direct-start', '{}'::jsonb, 'retained-direct-start-001'
         )`,
        [STAFF_USER, retainedCase, invalidWorkflowDefinition],
      ),
      (error) => databaseError(error, "55000"),
    );
    await assert.rejects(
      retainedDb.query(
        `insert into public.workflow_actions (
           tenant_id, workflow_instance_id, case_id, sequence_number,
           action_key, from_state, to_state, actor_type, reason_code,
           correlation_id, idempotency_key, input_sha256
         ) values (
           $1::uuid, $2::uuid, $3::uuid, 1, 'workflow.retry', 'pending',
           'pending', 'system', 'completion_contract_remediation_required',
           'retained-quarantine-action', 'retained-quarantine-action-001', $4
         )`,
        [TENANT, invalidWorkflowInstance, retainedCase, HASH_C],
      ),
      (error) => databaseError(error, "55000"),
    );
    const runnableQuarantineCheck = await retainedDb.query<{ count: number }>(
      `select count(*)::integer as count
       from public.workflow_instances i
       join private.workflow_completion_definition_quarantine q
         on q.completion_definition_id = i.completion_definition_id
       where i.status in ('active', 'paused')`,
    );
    assert.equal(runnableQuarantineCheck.rows[0].count, 0);
    await assert.rejects(
      retainedDb.query(
        `insert into public.completion_definition_versions (
           tenant_id, completion_key, version, status, terminal_states,
           allowed_authority_types, minimum_assurance_scope, evidence_schema,
           effective_from, approved_by_auth_user_id, approved_at
         ) values (
           $1::uuid, 'invalid-new-provider-completion', '1', 'active',
           array['active','reversed']::text[], array['provider_webhook']::text[],
           'provider_attested', '{}'::jsonb, now(), $2::uuid, now()
         )`,
        [TENANT, STAFF_USER],
      ),
      (error) => databaseError(error, "23514"),
    );
    await retainedDb.query(
      `insert into public.completion_definition_versions (
         tenant_id, completion_key, version, status, terminal_states,
         allowed_authority_types, minimum_assurance_scope, evidence_schema,
         effective_from
       ) values (
         $1::uuid, 'valid-new-draft-provider-completion', '1', 'draft',
         array['active','reversed']::text[], array['provider_webhook']::text[],
         'provider_attested', '{
           "providerEventType":"payment.plan.updated",
           "requiredBindings":["workflowInstanceId","handoffSessionId"],
           "outcomeField":"planStatus",
           "terminalOutcomes":{"active":["active"],"reversed":["reversed"]}
         }'::jsonb, now()
       )`,
      [TENANT],
    );
    const newDraftCompletion = await retainedDb.query<{ id: string }>(
      `select id::text from public.completion_definition_versions
       where tenant_id = $1::uuid
         and completion_key = 'valid-new-draft-provider-completion'`,
      [TENANT],
    );
    await assert.rejects(
      retainedDb.query(
        `insert into public.workflow_definition_versions (
           tenant_id, workflow_key, version, status, initial_state, states,
           transitions, completion_definition_id, definition_sha256,
           effective_from, approved_by_auth_user_id, approved_at
         ) values (
           $1::uuid, 'invalid_new_draft_reference', '1', 'active', 'pending',
           array['pending','active','reversed']::text[], '{}'::jsonb,
           $2::uuid, $3, now(), $4::uuid, now()
         )`,
        [TENANT, newDraftCompletion.rows[0].id, HASH_C, STAFF_USER],
      ),
      (error) => databaseError(error, "55000"),
    );
    pass("migration 024 preserves retained evidence/action history, quarantines every unsafe runnable completion contract, and rejects provider-event repackaging");
  } finally {
    await retainedDb.close();
  }
}

async function setRole(role: "service_role" | "authenticated", userId = ""): Promise<void> {
  await db.query(
    `select set_config('request.jwt.claim.role', $1, false),
            set_config('request.jwt.claim.sub', $2, false),
            set_config('request.jwt.claim.is_anonymous', 'false', false)`,
    [role, userId],
  );
}

async function seedGovernedPaymentWorkflow(): Promise<void> {
  await db.query(
    `insert into auth.users (id, email) values
       ($1::uuid, 'resident@example.test'),
       ($2::uuid, 'other@example.test'),
       ($3::uuid, 'staff@example.test')`,
    [RESIDENT_USER, OTHER_USER, STAFF_USER],
  );
  await db.query(
    `insert into public.tenants (
       id, slug, name, environment, fictional, content_version, retention_days
     ) values ($1::uuid, 'wayne-workflow-test', 'Wayne County Workflow Test',
       'production', false, 'workflow-test-v1', 2555)`,
    [TENANT],
  );
  await db.query(
    `insert into public.staff_roles (tenant_id, auth_user_id, role, status)
     values ($1::uuid, $2::uuid, 'admin', 'active')`,
    [TENANT, STAFF_USER],
  );
  await db.query(
    `insert into public.residents (
       id, tenant_id, auth_user_id, identity_state, first_name, last_name
     ) values ($1::uuid, $2::uuid, $3::uuid, 'verified', 'Workflow', 'Resident')`,
    [RESIDENT, TENANT, RESIDENT_USER],
  );
  await db.query(
    `insert into public.cases (
       id, tenant_id, resident_id, status, active, parcel_id, next_best_action
     ) values ($1::uuid, $2::uuid, $3::uuid, 'intake_in_progress', true,
       'opaque-test-parcel', 'Review the governed payment-plan workflow.')`,
    [CASE, TENANT, RESIDENT],
  );
  await db.query(
    `insert into public.identity_proof_challenges (
       id, tenant_id, resident_id, case_id, auth_user_id, method, provider_key,
       challenge_digest, state, assurance_level, evidence_digest, attempt_count,
       expires_at, verified_at, resolved_at, idempotency_key
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'county_notice',
       'wayne_county_case_entitlement', $6, 'verified', 'substantial', $7, 1,
       now() + interval '1 day', now(), now(), 'workflow-proof-001'
     )`,
    [CHALLENGE, TENANT, RESIDENT, CASE, RESIDENT_USER, HASH_A, HASH_B],
  );
  await db.query(
    `insert into public.case_entitlements (
       id, tenant_id, case_id, resident_id, auth_user_id, proof_challenge_id,
       scopes, assurance_level, state, granted_by_type, grant_reason_code,
       evidence_digest, expires_at, idempotency_key
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       array['case.read','case.participate']::text[], 'substantial', 'active',
       'provider', 'verified_county_case', $7, now() + interval '8 hours',
       'workflow-entitlement-001'
     )`,
    [ENTITLEMENT, TENANT, CASE, RESIDENT, RESIDENT_USER, CHALLENGE, HASH_B],
  );
  await db.query(
    `insert into public.completion_definition_versions (
       id, tenant_id, completion_key, version, status, terminal_states,
       evidence_required, authoritative_evidence_required, allowed_authority_types,
       minimum_assurance_scope, evidence_schema, effective_from,
       approved_by_auth_user_id, approved_at
     ) values (
       $1::uuid, $2::uuid, 'payment_plan_active', 'wayne-payment-plan-completion-v1',
       'active', array['active','reversed']::text[], true, true,
       array['provider_webhook']::text[], 'provider_attested',
       '{
         "providerEventType":"payment_plan.status",
         "requiredBindings":["workflowInstanceId","handoffSessionId"],
         "outcomeField":"planStatus",
         "terminalOutcomes":{
           "active":["active"],
           "reversed":["reversed","cancelled"]
         }
       }'::jsonb,
       now() - interval '1 hour', $3::uuid, now()
     )`,
    [COMPLETION_DEFINITION, TENANT, STAFF_USER],
  );

  const transitions = {
    identified: [
      { action: "case.entitlement_confirmed", to: "entitled", actors: ["resident", "staff"] },
      { action: "exception.manual", to: "staff_exception", actors: ["staff"] },
    ],
    entitled: [
      { action: "handoff.requested", to: "handoff_created", actors: ["resident"] },
      { action: "exception.manual", to: "staff_exception", actors: ["staff"] },
      { action: "provider.failed", to: "staff_exception", actors: ["provider", "system"] },
    ],
    step_up: [
      { action: "handoff.requested", to: "handoff_created", actors: ["resident"] },
      { action: "exception.manual", to: "staff_exception", actors: ["staff"] },
    ],
    handoff_created: [
      { action: "handoff.open", to: "provider_open", actors: ["resident"] },
      { action: "provider.failed", to: "staff_exception", actors: ["provider", "system"] },
      { action: "exception.manual", to: "staff_exception", actors: ["staff"] },
    ],
    provider_open: [
      { action: "provider.submit", to: "submitted", actors: ["provider", "system"] },
      { action: "provider.failed", to: "staff_exception", actors: ["provider", "system"] },
    ],
    submitted: [
      { action: "reconciliation.start", to: "confirming", actors: ["provider", "system"] },
      { action: "provider.failed", to: "staff_exception", actors: ["provider", "system"] },
    ],
    confirming: [
      { action: "plan.confirm", to: "active", actors: ["system"] },
      { action: "provider.failed", to: "staff_exception", actors: ["provider", "system"] },
    ],
    mismatch: [
      { action: "reconciliation.retry", to: "confirming", actors: ["staff", "system"] },
      { action: "exception.manual", to: "staff_exception", actors: ["staff"] },
    ],
    staff_exception: [
      { action: "exception.resume", to: "entitled", actors: ["staff"] },
      { action: "exception.resume_reconciliation", to: "confirming", actors: ["staff"] },
      { action: "exception.close", to: "closed_unresolved", actors: ["staff"] },
    ],
    active: [
      { action: "plan.reverse", to: "reversed", actors: ["system"] },
    ],
    declined: [],
    cancelled: [],
    expired: [],
    reversed: [],
    closed_unresolved: [],
  };
  await db.query(
    `insert into public.workflow_definition_versions (
       id, tenant_id, workflow_key, version, status, initial_state, states,
       transitions, completion_definition_id, definition_sha256, effective_from,
       approved_by_auth_user_id, approved_at
     ) values (
       $1::uuid, $2::uuid, 'payment_plan_navigation', 'wayne-payment-plan-v1',
       'active', 'identified', $3::text[], $4::jsonb, $5::uuid, $6,
       now() - interval '1 hour', $7::uuid, now()
     )`,
    [
      WORKFLOW_DEFINITION,
      TENANT,
      [
        "identified", "entitled", "step_up", "handoff_created", "provider_open",
        "submitted", "confirming", "active", "declined", "cancelled", "expired",
        "reversed", "mismatch", "staff_exception", "closed_unresolved",
      ],
      JSON.stringify(transitions),
      COMPLETION_DEFINITION,
      HASH_C,
      STAFF_USER,
    ],
  );
  pass("seeded one active, versioned payment-plan definition with durable case entitlement and actor-scoped edges");
}

const invokeRpc: WorkflowRpcInvoker = async (name, p) => {
  try {
    let value: unknown;
    switch (name) {
      case "civya_service_start_governed_workflow":
        value = await queryValue(
          `select public.civya_service_start_governed_workflow(
             $1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7
           ) as value`,
          [
            p.p_actor_user_id, p.p_actor_type, p.p_case_id, p.p_workflow_key,
            p.p_correlation_id, JSON.stringify(p.p_redacted_context), p.p_idempotency_key,
          ],
        );
        break;
      case "civya_service_read_governed_workflow":
        value = await queryValue(
          "select public.civya_service_read_governed_workflow($1::uuid, $2, $3::uuid) as value",
          [p.p_actor_user_id, p.p_actor_type, p.p_workflow_instance_id],
        );
        break;
      case "civya_service_advance_governed_workflow":
        value = await queryValue(
          `select public.civya_service_advance_governed_workflow(
             $1::uuid, $2, $3::uuid, $4::bigint, $5, $6, $7, $8,
             $9::jsonb, $10::uuid, $11
           ) as value`,
          [
            p.p_actor_user_id, p.p_actor_type, p.p_workflow_instance_id,
            p.p_expected_row_version, p.p_action_key, p.p_to_state,
            p.p_reason_code, p.p_correlation_id, JSON.stringify(p.p_redacted_metadata),
            p.p_completion_evidence_id, p.p_idempotency_key,
          ],
        );
        break;
      case "civya_service_record_completion_evidence":
        value = await queryValue(
          `select public.civya_service_record_completion_evidence(
             $1::uuid, $2::uuid, $3, $4, $5::boolean, $6::uuid, $7::uuid,
             $8::uuid, $9, $10::jsonb, $11::timestamptz, $12
           ) as value`,
          [
            p.p_actor_user_id, p.p_workflow_instance_id, p.p_authority_type,
            p.p_assurance_scope, p.p_authoritative, p.p_source_record_id,
            p.p_provider_event_id, p.p_outcome_verification_event_id,
            p.p_evidence_sha256, JSON.stringify(p.p_redacted_evidence),
            p.p_observed_at, p.p_idempotency_key,
          ],
        );
        break;
      case "civya_service_raise_workflow_exception":
        value = await queryValue(
          `select public.civya_service_raise_workflow_exception(
             $1::uuid, $2, $3::uuid, $4::bigint, $5, $6, $7, $8, $9,
             $10::uuid, $11, $12, $13
           ) as value`,
          [
            p.p_actor_user_id, p.p_actor_type, p.p_workflow_instance_id,
            p.p_expected_row_version, p.p_action_key, p.p_exception_type,
            p.p_severity, p.p_reason_code, p.p_redacted_summary,
            p.p_assigned_to_auth_user_id, p.p_correlation_id, p.p_dedupe_key,
            p.p_idempotency_key,
          ],
        );
        break;
      default:
        throw new Error(`Unexpected workflow RPC: ${name}`);
    }
    return { data: value, error: null };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { data: null, error: { code: failure.code, message: failure.message } };
  }
};

async function queryValue(sql: string, parameters: unknown[]): Promise<unknown> {
  const result = await db.query<{ value: unknown }>(sql, parameters);
  return result.rows[0]?.value;
}

function repositoryError(error: unknown, code: string, causeCode?: string): boolean {
  assert.ok(error instanceof GovernedWorkflowRepositoryError);
  assert.equal(error.code, code);
  if (causeCode) assert.equal(error.causeCode, causeCode);
  return true;
}

function databaseError(error: unknown, code: string): boolean {
  assert.equal((error as { code?: string }).code, code);
  return true;
}

async function createHandoff(workflowInstanceId: string): Promise<{
  handoffSessionId: string;
  rowVersion: number;
}> {
  const created = await queryValue(
    `select public.civya_service_create_hosted_handoff(
       $1::uuid, $2::uuid, $3::uuid, 'payment', 'jpm_chase', $4, $5, $6,
       now() + interval '15 minutes', $7
     ) as value`,
    [
      RESIDENT_USER, CASE, workflowInstanceId, "d".repeat(64),
      "https://payments.example.invalid", "e".repeat(64),
      `payment-handoff:${workflowInstanceId}`,
    ],
  ) as Record<string, unknown>;
  const handoffSessionId = String(created.handoffSessionId);
  const row = await db.query<{ row_version: number }>(
    "select row_version::integer from public.hosted_handoff_sessions where id = $1::uuid",
    [handoffSessionId],
  );
  return { handoffSessionId, rowVersion: Number(row.rows[0].row_version) };
}

async function recordBrowserHandoffEvent(input: {
  handoffSessionId: string;
  expectedRowVersion: number;
  eventType: string;
  externalEventId: string;
  browserState: "opened" | "abandoned";
}): Promise<number> {
  const value = await queryValue(
    `select public.civya_service_record_handoff_event(
       $1::uuid, $2::bigint, 'browser', $3, $4, $5, $6::jsonb, $7, 'pending'
     ) as value`,
    [
      input.handoffSessionId, input.expectedRowVersion, input.eventType,
      input.externalEventId, HASH_A,
      JSON.stringify({ authority: "advisory", provider: "jpm_chase" }),
      input.browserState,
    ],
  ) as Record<string, unknown>;
  return Number(value.rowVersion);
}

async function claimProviderEvent(input: {
  workflowInstanceId: string;
  handoffSessionId: string;
  externalEventId: string;
  planStatus: "active" | "reversed";
}): Promise<{
  eventId: string;
  processingToken: string;
}> {
  const value = await queryValue(
    `select public.civya_service_claim_provider_event(
       $1::uuid, 'jpm_chase', $2, 'payment_plan.status',
       $3, $4::jsonb, true, 'workflow-test-worker', 60, 3
     ) as value`,
    [
      TENANT,
      input.externalEventId,
      input.planStatus === "active" ? HASH_B : HASH_A,
      JSON.stringify({
        workflowInstanceId: input.workflowInstanceId,
        handoffSessionId: input.handoffSessionId,
        planStatus: input.planStatus,
      }),
    ],
  ) as Record<string, unknown>;
  assert.equal(value.claimed, true);
  return { eventId: String(value.id), processingToken: String(value.processingToken) };
}

async function testDefinitionDisclosure(): Promise<void> {
  const definitions = listWorkflowDefinitions();
  assert.equal(definitions.length, 5);
  assert.equal(workflowImplementationStatus("payment_plan_navigation"), "verified_persisted_slice");
  for (const definition of definitions.filter((item) => item.key !== "payment_plan_navigation")) {
    assert.equal(workflowImplementationStatus(definition.key), "defined_not_activated");
  }
  pass("all five definitions are exposed honestly while only payment-plan navigation claims a verified persisted slice");
}

async function testPersistedPaymentJourney(repository: GovernedWorkflowRepository): Promise<void> {
  const resident = { type: "resident" as const, userId: RESIDENT_USER };
  const correlationId = "payment-plan:journey:001";
  const unsafeResidentContexts = [
    { channel: "web", purpose: "plan_navigation", email: "resident@example.test" },
    { channel: "web", purpose: "plan_navigation", profile: { ssn: "111-22-3333" } },
    { channel: "web", purpose: "plan_navigation", address: "123 Main Street" },
    { channel: "web", purpose: "plan_navigation", notes: "Please call after work." },
  ];
  for (const [index, redactedContext] of unsafeResidentContexts.entries()) {
    await assert.rejects(
      repository.start({
        actor: resident,
        caseId: CASE,
        workflowKey: "payment_plan_navigation",
        correlationId: `payment-plan:privacy:${index}`,
        idempotencyKey: `payment-plan:start:privacy:${index}`,
        redactedContext,
      }),
      (error) => repositoryError(error, "sensitive_workflow_metadata_rejected"),
    );
  }
  const beforeSafeStart = await db.query<{ count: number }>(
    "select count(*)::integer as count from public.workflow_instances where case_id = $1::uuid",
    [CASE],
  );
  assert.equal(beforeSafeStart.rows[0].count, 0, "rejected resident context must never reach durable workflow rows");

  await assert.rejects(
    queryValue(
      `select public.civya_service_start_governed_workflow(
         $1::uuid, 'resident', $2::uuid, 'payment_plan_navigation',
         'payment-plan:db-privacy', $3::jsonb, 'payment-plan:start:db-privacy'
       ) as value`,
      [RESIDENT_USER, CASE, JSON.stringify({ channel: "web", purpose: "plan_navigation", notes: "free text" })],
    ),
    (error) => databaseError(error, "22023"),
  );

  const started = await repository.start({
    actor: resident,
    caseId: CASE,
    workflowKey: "payment_plan_navigation",
    correlationId,
    idempotencyKey: "payment-plan:start:001",
    redactedContext: { channel: "web", purpose: "plan_navigation" },
  });
  assert.equal(started.state, "identified");
  assert.equal(started.rowVersion, 1);
  assert.equal(started.duplicate, false);
  const startReplay = await repository.start({
    actor: resident,
    caseId: CASE,
    workflowKey: "payment_plan_navigation",
    correlationId,
    idempotencyKey: "payment-plan:start:001",
    redactedContext: { channel: "web", purpose: "plan_navigation" },
  });
  assert.equal(startReplay.workflowInstanceId, started.workflowInstanceId);
  assert.equal(startReplay.duplicate, true);

  await assert.rejects(
    repository.start({
      actor: { type: "resident", userId: OTHER_USER },
      caseId: CASE,
      workflowKey: "payment_plan_navigation",
      correlationId: "payment-plan:unauthorized",
      idempotencyKey: "payment-plan:start:unauthorized",
    }),
    (error) => repositoryError(error, "workflow_access_denied", "42501"),
  );

  const entitled = await repository.advance({
    actor: resident,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: 1,
    actionKey: "case.entitlement_confirmed",
    toState: "entitled",
    reasonCode: "durable_case_entitlement",
    correlationId,
    idempotencyKey: "payment-plan:entitled:001",
  });
  assert.equal(entitled.rowVersion, 2);
  await assert.rejects(
    repository.advance({
      actor: resident,
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: entitled.rowVersion,
      actionKey: "handoff.requested",
      toState: "handoff_created",
      reasonCode: "resident_requested_official_handoff",
      correlationId,
      idempotencyKey: "payment-plan:resident-metadata:001",
      redactedMetadata: { profile: { email: "resident@example.test" } },
    }),
    (error) => repositoryError(error, "sensitive_workflow_metadata_rejected"),
  );
  await assert.rejects(
    queryValue(
      `select public.civya_service_advance_governed_workflow(
         $1::uuid, 'resident', $2::uuid, $3::bigint, 'handoff.requested',
         'handoff_created', 'resident_requested_official_handoff', $4,
         $5::jsonb, null, 'payment-plan:db-metadata:001'
       ) as value`,
      [
        RESIDENT_USER,
        started.workflowInstanceId,
        entitled.rowVersion,
        correlationId,
        JSON.stringify({ notes: "resident supplied free text" }),
      ],
    ),
    (error) => databaseError(error, "22023"),
  );
  const entitledReplay = await repository.advance({
    actor: resident,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: 1,
    actionKey: "case.entitlement_confirmed",
    toState: "entitled",
    reasonCode: "durable_case_entitlement",
    correlationId,
    idempotencyKey: "payment-plan:entitled:001",
  });
  assert.equal(entitledReplay.duplicate, true);
  await assert.rejects(
    repository.advance({
      actor: resident,
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: 1,
      actionKey: "handoff.requested",
      toState: "handoff_created",
      reasonCode: "resident_requested_official_handoff",
      correlationId,
      idempotencyKey: "payment-plan:stale:001",
    }),
    (error) => repositoryError(error, "workflow_stale_state", "40001"),
  );
  const handoffReady = await repository.advance({
    actor: resident,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: 2,
    actionKey: "handoff.requested",
    toState: "handoff_created",
    reasonCode: "resident_requested_official_handoff",
    correlationId,
    idempotencyKey: "payment-plan:handoff:001",
  });
  assert.equal(handoffReady.rowVersion, 3);

  const handoff = await createHandoff(started.workflowInstanceId);
  const abandonedVersion = await recordBrowserHandoffEvent({
    handoffSessionId: handoff.handoffSessionId,
    expectedRowVersion: handoff.rowVersion,
    eventType: "hosted_payment_abandoned",
    externalEventId: "browser-abandoned-001",
    browserState: "abandoned",
  });
  const abandoned = await repository.read({ actor: resident, workflowInstanceId: started.workflowInstanceId });
  assert.equal(abandoned.state, "handoff_created");
  assert.equal(abandoned.handoffs[0].browserState, "abandoned");
  assert.equal(abandoned.status, "active");

  await recordBrowserHandoffEvent({
    handoffSessionId: handoff.handoffSessionId,
    expectedRowVersion: abandonedVersion,
    eventType: "hosted_payment_resumed",
    externalEventId: "browser-resumed-001",
    browserState: "opened",
  });
  const resumed = await repository.read({ actor: resident, workflowInstanceId: started.workflowInstanceId });
  assert.equal(resumed.handoffs[0].browserState, "opened");
  assert.equal(resumed.state, "handoff_created");
  pass("browser abandonment and resume persist without claiming payment-plan completion");

  const providerOpen = await repository.advance({
    actor: resident,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: 3,
    actionKey: "handoff.open",
    toState: "provider_open",
    reasonCode: "resident_opened_official_provider",
    correlationId,
    idempotencyKey: "payment-plan:provider-open:001",
  });
  assert.equal(providerOpen.rowVersion, 4);
  await assert.rejects(
    repository.advance({
      actor: resident,
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: 4,
      actionKey: "provider.submit",
      toState: "submitted",
      reasonCode: "browser_claimed_submission",
      correlationId,
      idempotencyKey: "payment-plan:forged-provider:001",
    }),
    (error) => repositoryError(error, "workflow_access_denied", "42501"),
  );
  const submitted = await repository.advance({
    actor: { type: "provider", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: 4,
    actionKey: "provider.submit",
    toState: "submitted",
    reasonCode: "signed_provider_submission",
    correlationId,
    idempotencyKey: "payment-plan:submitted:001",
  });
  const confirming = await repository.advance({
    actor: { type: "system", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: submitted.rowVersion,
    actionKey: "reconciliation.start",
    toState: "confirming",
    reasonCode: "authoritative_reconciliation_started",
    correlationId,
    idempotencyKey: "payment-plan:confirming:001",
  });
  await assert.rejects(
    repository.advance({
      actor: { type: "system", userId: null },
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: confirming.rowVersion,
      actionKey: "plan.confirm",
      toState: "active",
      reasonCode: "completion_without_evidence",
      correlationId,
      idempotencyKey: "payment-plan:active:no-evidence",
    }),
    (error) => repositoryError(error, "workflow_transition_rejected", "55000"),
  );

  const earlyReversalObservedAt = new Date(Date.now() - 120_000).toISOString();
  const earlyReversalEvent = await claimProviderEvent({
    workflowInstanceId: started.workflowInstanceId,
    handoffSessionId: handoff.handoffSessionId,
    externalEventId: "evt-plan-reversed-too-early-001",
    planStatus: "reversed",
  });
  const earlyReversalEvidence = await repository.recordCompletionEvidence({
    actor: { type: "service", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    authorityType: "provider_webhook",
    assuranceScope: "provider_attested",
    authoritative: true,
    providerEventId: earlyReversalEvent.eventId,
    evidenceSha256: HASH_A,
    redactedEvidence: { planStatus: "reversed", bindingVerified: true },
    observedAt: earlyReversalObservedAt,
    idempotencyKey: "payment-plan:early-reversal-evidence:001",
  });
  await assert.rejects(
    repository.advance({
      actor: { type: "system", userId: null },
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: confirming.rowVersion,
      actionKey: "plan.confirm",
      toState: "active",
      reasonCode: "wrong_outcome_for_active",
      correlationId,
      idempotencyKey: "payment-plan:active:wrong-outcome",
      completionEvidenceId: earlyReversalEvidence.completionEvidenceId,
    }),
    (error) => repositoryError(error, "workflow_transition_rejected", "55000"),
  );

  const mismatchedOutcomeEvent = await claimProviderEvent({
    workflowInstanceId: started.workflowInstanceId,
    handoffSessionId: handoff.handoffSessionId,
    externalEventId: "evt-plan-evidence-mismatch-001",
    planStatus: "active",
  });
  await assert.rejects(
    repository.recordCompletionEvidence({
      actor: { type: "service", userId: null },
      workflowInstanceId: started.workflowInstanceId,
      authorityType: "provider_webhook",
      assuranceScope: "provider_attested",
      authoritative: true,
      providerEventId: mismatchedOutcomeEvent.eventId,
      evidenceSha256: HASH_B,
      redactedEvidence: { planStatus: "reversed", bindingVerified: true },
      observedAt: new Date(Date.now() - 90_000).toISOString(),
      idempotencyKey: "payment-plan:mismatched-provider-evidence:001",
    }),
    (error) => repositoryError(error, "workflow_transition_rejected", "55000"),
  );

  const providerEvent = await claimProviderEvent({
    workflowInstanceId: started.workflowInstanceId,
    handoffSessionId: handoff.handoffSessionId,
    externalEventId: "evt-plan-active-001",
    planStatus: "active",
  });
  const evidence = await repository.recordCompletionEvidence({
    actor: { type: "service", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    authorityType: "provider_webhook",
    assuranceScope: "provider_attested",
    authoritative: true,
    providerEventId: providerEvent.eventId,
    evidenceSha256: HASH_C,
    redactedEvidence: { planStatus: "active", bindingVerified: true },
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    idempotencyKey: "payment-plan:evidence:001",
  });
  assert.equal(evidence.authoritative, true);
  const evidenceReplay = await repository.recordCompletionEvidence({
    actor: { type: "service", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    authorityType: "provider_webhook",
    assuranceScope: "provider_attested",
    authoritative: true,
    providerEventId: providerEvent.eventId,
    evidenceSha256: HASH_C,
    redactedEvidence: { planStatus: "active", bindingVerified: true },
    observedAt: new Date().toISOString(),
    idempotencyKey: "payment-plan:evidence:001",
  });
  assert.equal(evidenceReplay.duplicate, true);
  await assert.rejects(
    repository.recordCompletionEvidence({
      actor: { type: "service", userId: null },
      workflowInstanceId: started.workflowInstanceId,
      authorityType: "provider_webhook",
      assuranceScope: "provider_attested",
      authoritative: true,
      providerEventId: providerEvent.eventId,
      evidenceSha256: HASH_C,
      redactedEvidence: { planStatus: "active", bindingVerified: true },
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: "payment-plan:evidence:repackaged-event",
    }),
    (error) => repositoryError(error, "workflow_idempotency_conflict", "23505"),
  );
  const completed = await repository.advance({
    actor: { type: "system", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: confirming.rowVersion,
    actionKey: "plan.confirm",
    toState: "active",
    reasonCode: "authoritative_plan_active",
    correlationId,
    idempotencyKey: "payment-plan:active:001",
    completionEvidenceId: evidence.completionEvidenceId,
  });
  assert.equal(completed.status, "completed");
  const completedSnapshot = await repository.read({ actor: resident, workflowInstanceId: started.workflowInstanceId });
  assert.equal(completedSnapshot.status, "completed");
  assert.equal(completedSnapshot.state, "active");
  assert.ok(completedSnapshot.completedAt);
  const providerFinished = await queryValue(
    `select public.civya_service_finish_provider_event_claim(
       $1::uuid, 'workflow-test-worker', $2::uuid, 'processed', null, 0
     ) as value`,
    [providerEvent.eventId, providerEvent.processingToken],
  );
  assert.equal(providerFinished, true);

  await assert.rejects(
    repository.advance({
      actor: { type: "system", userId: null },
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: completed.rowVersion,
      actionKey: "plan.reverse",
      toState: "reversed",
      reasonCode: "reversal_without_evidence",
      correlationId,
      idempotencyKey: "payment-plan:reversed:no-evidence",
    }),
    (error) => repositoryError(error, "workflow_transition_rejected", "55000"),
  );
  await assert.rejects(
    repository.advance({
      actor: { type: "system", userId: null },
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: completed.rowVersion,
      actionKey: "plan.reverse",
      toState: "reversed",
      reasonCode: "active_evidence_cannot_reverse",
      correlationId,
      idempotencyKey: "payment-plan:reversed:active-evidence",
      completionEvidenceId: evidence.completionEvidenceId,
    }),
    (error) => repositoryError(error, "workflow_transition_rejected", "55000"),
  );
  await assert.rejects(
    repository.advance({
      actor: { type: "system", userId: null },
      workflowInstanceId: started.workflowInstanceId,
      expectedRowVersion: completed.rowVersion,
      actionKey: "plan.reverse",
      toState: "reversed",
      reasonCode: "stale_reversal_evidence",
      correlationId,
      idempotencyKey: "payment-plan:reversed:stale-evidence",
      completionEvidenceId: earlyReversalEvidence.completionEvidenceId,
    }),
    (error) => repositoryError(error, "workflow_transition_rejected", "55000"),
  );
  const reversalEvent = await claimProviderEvent({
    workflowInstanceId: started.workflowInstanceId,
    handoffSessionId: handoff.handoffSessionId,
    externalEventId: "evt-plan-reversed-001",
    planStatus: "reversed",
  });
  const reversalEvidence = await repository.recordCompletionEvidence({
    actor: { type: "service", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    authorityType: "provider_webhook",
    assuranceScope: "provider_attested",
    authoritative: true,
    providerEventId: reversalEvent.eventId,
    evidenceSha256: HASH_A,
    redactedEvidence: { planStatus: "reversed", bindingVerified: true },
    observedAt: new Date().toISOString(),
    idempotencyKey: "payment-plan:reversal-evidence:001",
  });
  const reversed = await repository.advance({
    actor: { type: "system", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: completed.rowVersion,
    actionKey: "plan.reverse",
    toState: "reversed",
    reasonCode: "authoritative_plan_reversal",
    correlationId,
    idempotencyKey: "payment-plan:reversed:001",
    completionEvidenceId: reversalEvidence.completionEvidenceId,
  });
  assert.equal(reversed.state, "reversed");
  assert.equal(reversed.status, "completed");
  assert.equal(reversed.rowVersion, completed.rowVersion + 1);
  const reversalReplay = await repository.advance({
    actor: { type: "system", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: completed.rowVersion,
    actionKey: "plan.reverse",
    toState: "reversed",
    reasonCode: "authoritative_plan_reversal",
    correlationId,
    idempotencyKey: "payment-plan:reversed:001",
    completionEvidenceId: reversalEvidence.completionEvidenceId,
  });
  assert.equal(reversalReplay.duplicate, true);
  const reversedSnapshot = await repository.read({ actor: resident, workflowInstanceId: started.workflowInstanceId });
  assert.equal(reversedSnapshot.state, "reversed");
  assert.equal(reversedSnapshot.status, "completed");
  const reversalFinished = await queryValue(
    `select public.civya_service_finish_provider_event_claim(
       $1::uuid, 'workflow-test-worker', $2::uuid, 'processed', null, 0
     ) as value`,
    [reversalEvent.eventId, reversalEvent.processingToken],
  );
  assert.equal(reversalFinished, true);
  pass("idempotency, actor authority, outcome-bound completion, and distinct later authoritative reversal work through the typed repository");
}

async function testProviderAndManualExceptions(repository: GovernedWorkflowRepository): Promise<void> {
  const resident = { type: "resident" as const, userId: RESIDENT_USER };
  const staff = { type: "staff" as const, userId: STAFF_USER };
  const correlationId = "payment-plan:exception:002";
  const started = await repository.start({
    actor: resident,
    caseId: CASE,
    workflowKey: "payment_plan_navigation",
    correlationId,
    idempotencyKey: "payment-plan:start:002",
  });
  const entitled = await repository.advance({
    actor: resident,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: 1,
    actionKey: "case.entitlement_confirmed",
    toState: "entitled",
    reasonCode: "durable_case_entitlement",
    correlationId,
    idempotencyKey: "payment-plan:entitled:002",
  });
  const handoffReady = await repository.advance({
    actor: resident,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: entitled.rowVersion,
    actionKey: "handoff.requested",
    toState: "handoff_created",
    reasonCode: "resident_requested_official_handoff",
    correlationId,
    idempotencyKey: "payment-plan:handoff:002",
  });
  const providerFailure = await repository.raiseException({
    actor: { type: "provider", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: handoffReady.rowVersion,
    actionKey: "provider.failed",
    exceptionType: "payment_provider_failure",
    severity: "high",
    reasonCode: "provider_session_unavailable",
    redactedSummary: "The contracted provider session could not be opened; no payment credentials were collected.",
    assignedToAuthUserId: STAFF_USER,
    correlationId,
    dedupeKey: "payment-plan:provider-failure:002",
    idempotencyKey: "payment-plan:provider-exception:002",
  });
  assert.equal(providerFailure.status, "escalated");
  assert.equal(providerFailure.exceptionStatus, "owned");
  const failureReplay = await repository.raiseException({
    actor: { type: "provider", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: handoffReady.rowVersion,
    actionKey: "provider.failed",
    exceptionType: "payment_provider_failure",
    severity: "high",
    reasonCode: "provider_session_unavailable",
    redactedSummary: "The contracted provider session could not be opened; no payment credentials were collected.",
    assignedToAuthUserId: STAFF_USER,
    correlationId,
    dedupeKey: "payment-plan:provider-failure:002",
    idempotencyKey: "payment-plan:provider-exception:002",
  });
  assert.equal(failureReplay.duplicate, true);

  const residentView = await repository.read({ actor: resident, workflowInstanceId: started.workflowInstanceId });
  assert.equal(residentView.exception?.status, "staff_review");
  assert.equal(residentView.exception?.id, undefined);
  assert.equal(residentView.exception?.redactedSummary, undefined);
  const staffView = await repository.read({ actor: staff, workflowInstanceId: started.workflowInstanceId });
  assert.equal(staffView.exception?.id, providerFailure.exceptionId);
  assert.equal(staffView.exception?.assignedToAuthUserId, STAFF_USER);
  assert.match(staffView.exception?.redactedSummary ?? "", /no payment credentials/i);

  const resumed = await repository.advance({
    actor: staff,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: providerFailure.rowVersion,
    actionKey: "exception.resume",
    toState: "entitled",
    reasonCode: "staff_reopened_provider_path",
    correlationId,
    idempotencyKey: "payment-plan:exception-resume:002",
    redactedMetadata: { resolutionSummary: "Staff confirmed a safe retry path." },
  });
  assert.equal(resumed.status, "active");
  const resolvedException = await db.query<{ status: string; resolution_code: string }>(
    "select status, resolution_code from public.operational_exceptions where id = $1::uuid",
    [providerFailure.exceptionId],
  );
  assert.equal(resolvedException.rows[0].status, "resolved");
  assert.equal(resolvedException.rows[0].resolution_code, "staff_reopened_provider_path");

  const lateProviderReplay = await repository.raiseException({
    actor: { type: "provider", userId: null },
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: handoffReady.rowVersion,
    actionKey: "provider.failed",
    exceptionType: "payment_provider_failure",
    severity: "high",
    reasonCode: "provider_session_unavailable",
    redactedSummary: "The contracted provider session could not be opened; no payment credentials were collected.",
    assignedToAuthUserId: STAFF_USER,
    correlationId,
    dedupeKey: "payment-plan:provider-failure:002",
    idempotencyKey: "payment-plan:provider-exception:002",
  });
  assert.equal(lateProviderReplay.duplicate, true);
  assert.equal(lateProviderReplay.status, "active");
  assert.equal(lateProviderReplay.state, "entitled");
  const afterLateReplay = await repository.read({ actor: staff, workflowInstanceId: started.workflowInstanceId });
  assert.equal(afterLateReplay.status, "active");
  assert.equal(afterLateReplay.exception, null);

  const manual = await repository.raiseException({
    actor: staff,
    workflowInstanceId: started.workflowInstanceId,
    expectedRowVersion: resumed.rowVersion,
    actionKey: "exception.manual",
    exceptionType: "county_staff_review",
    severity: "normal",
    reasonCode: "manual_obligation_review",
    redactedSummary: "Staff needs to confirm the current obligation before another hosted handoff.",
    assignedToAuthUserId: STAFF_USER,
    correlationId,
    dedupeKey: "payment-plan:manual-review:002",
    idempotencyKey: "payment-plan:manual-exception:002",
  });
  assert.equal(manual.status, "escalated");
  const exceptionCount = await db.query<{ count: number }>(
    "select count(*)::integer as count from public.operational_exceptions where workflow_instance_id = $1::uuid",
    [started.workflowInstanceId],
  );
  assert.equal(exceptionCount.rows[0].count, 2);
  const auditCount = await db.query<{ count: number }>(
    `select count(*)::integer as count from public.audit_events
     where case_id = $1::uuid and event_type = 'workflow_exception_raised'`,
    [CASE],
  );
  assert.equal(auditCount.rows[0].count, 2, "idempotent exception replay must not duplicate audit evidence");
  pass("provider failures and manual staff exceptions are durable, owned, privacy-filtered, idempotent, and resumable");
}

async function main(): Promise<void> {
  console.log("Governed workflow persistence vertical slice");
  await testRetainedSchemaUpgrade();
  await prepareDatabase();
  await seedGovernedPaymentWorkflow();
  await testDefinitionDisclosure();
  const repository = new GovernedWorkflowRepository(invokeRpc);
  await testPersistedPaymentJourney(repository);
  await testProviderAndManualExceptions(repository);
  console.log("\nALL GOVERNED WORKFLOW PERSISTENCE TESTS PASSED");
}

main()
  .catch((error) => {
    console.error("\nGOVERNED WORKFLOW PERSISTENCE TESTS FAILED");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
