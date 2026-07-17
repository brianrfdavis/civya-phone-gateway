import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SEED = join(ROOT, "supabase", "seed", "20260716_fictional_county_demo_v1.sql");
const TENANT_SLUG = "wayne-county-demo";
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const INVITATION_ID = "40000000-0000-4000-8000-000000000001";
const USER_A = "30000000-0000-4000-8000-000000000001";
const USER_B = "30000000-0000-4000-8000-000000000002";
const STAFF_USER = "30000000-0000-4000-8000-000000000003";
const REVIEWER_USER = "30000000-0000-4000-8000-000000000004";
const OTHER_TENANT_ID = "10000000-0000-4000-8000-000000000002";

const db = new PGlite();
let serviceActor = { userId: "", email: "", isAnonymous: true, isVerified: false };

function pass(message) {
  console.log(`  PASS  ${message}`);
}

async function setClaims(userId, { anonymous = true, role = "authenticated" } = {}) {
  await db.query(
    `select
       set_config($1, $2, false),
       set_config($3, $4, false),
       set_config($5, $6, false)`,
    [
      "request.jwt.claim.sub",
      userId || "",
      "request.jwt.claim.is_anonymous",
      String(anonymous),
      "request.jwt.claim.role",
      role,
    ],
  );
}

async function setServiceActor(userId, { email = "", anonymous = true, verified = !anonymous && Boolean(email) } = {}) {
  serviceActor = { userId, email, isAnonymous: anonymous, isVerified: verified };
  await setClaims("", { anonymous: false, role: "service_role" });
}

async function grantTenantAccess(userId) {
  const result = await db.query(
    `select public.civya_service_grant_tenant_access(
       $1::uuid, $2, $3, $4, $5::uuid, now() + interval '8 hours'
     ) as value`,
    [userId, serviceActor.email, serviceActor.isAnonymous, TENANT_SLUG, INVITATION_ID],
  );
  return result.rows[0].value;
}

async function bootstrap(channel = "voice") {
  const result = await db.query(
    `select public.civya_service_bootstrap_session(
       $1::uuid, $2, $3, $4, $5, $6
     ) as value`,
    [
      serviceActor.userId,
      serviceActor.email,
      serviceActor.isAnonymous,
      serviceActor.isVerified,
      TENANT_SLUG,
      channel,
    ],
  );
  return result.rows[0].value;
}

async function appendUserTurn({ conversationId, sequence, channel, text }) {
  const result = await db.query(
    `select public.civya_service_append_turn(
       $1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10
     ) as value`,
    [
      serviceActor.userId,
      serviceActor.email,
      serviceActor.isAnonymous,
      conversationId,
      `provider-${sequence}`,
      `client-${sequence}`,
      `idempotency-${sequence}`,
      "user",
      channel,
      text,
    ],
  );
  return result.rows[0].value;
}

async function commitTurn({
  turnId,
  expectedVersion,
  sequence,
  factKey,
  factValue,
  spokenResponse = `Saved cycle ${sequence}.`,
  finish = false,
}) {
  const result = await db.query(
    `select public.civya_service_commit_turn_result(
       $1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10,
       $11::jsonb, $12::jsonb, $13
     ) as value`,
    [
      serviceActor.userId,
      serviceActor.email,
      serviceActor.isAnonymous,
      turnId,
      expectedVersion,
      spokenResponse,
      `Question after cycle ${sequence}?`,
      `cycle_${sequence}`,
      "intake_in_progress",
      `Cycle ${sequence} is durably saved in this fictional case.`,
      JSON.stringify({ state: finish ? "conversation_ended" : "continue", final: finish }),
      JSON.stringify({ [factKey]: factValue }),
      finish,
    ],
  );
  return result.rows[0].value;
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

    create or replace function auth.uid()
    returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    create or replace function auth.jwt()
    returns jsonb language sql stable as $$
      select jsonb_build_object(
        'is_anonymous',
        coalesce(
          nullif(current_setting('request.jwt.claim.is_anonymous', true), '')::boolean,
          true
        )
      )
    $$;

    create or replace function auth.role()
    returns text language sql stable as $$
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

  const migrationFiles = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrationFiles.length >= 7, "Expected the complete county-memory migration set.");

  for (const name of migrationFiles) {
    let sql = await readFile(join(MIGRATIONS, name), "utf8");
    // PGlite implements gen_random_uuid() but does not ship the pgcrypto
    // extension control file. Supabase Postgres applies this statement as-is.
    sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, "");
    try {
      await db.exec(sql);
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }

  await db.exec(await readFile(SEED, "utf8"));
  await db.query(
    `insert into public.demo_invitations (
       id, tenant_id, token_hash, label, scopes, expires_at, max_uses, use_count
     ) values (
       $1::uuid, $2::uuid, 'pglite-resident-demo-invitation', 'PGlite resident demo',
       array['resident_demo']::text[], now() + interval '1 day', 100, 1
     )`,
    [INVITATION_ID, TENANT_ID],
  );
  const seeded = await db.query(
    `select t.content_version, t.fictional, count(s.id)::integer as scenario_count
     from public.tenants t
     join public.demo_scenarios s on s.tenant_id = t.id
     where t.slug = $1
     group by t.id`,
    [TENANT_SLUG],
  );
  assert.equal(seeded.rows[0].fictional, true);
  assert.equal(seeded.rows[0].content_version, "fictional-v1.0.0");
  assert.equal(seeded.rows[0].scenario_count, 3);
  pass(`applied ${migrationFiles.length} migrations and the versioned fictional seed`);
}

async function testTwentyResumeCycles() {
  await db.query("insert into auth.users (id) values ($1::uuid)", [USER_A]);
  await setServiceActor(USER_A);
  await assert.rejects(
    bootstrap("voice"),
    (error) => error.code === "42501",
    "Bootstrap must require a live tenant invitation grant.",
  );
  await grantTenantAccess(USER_A);

  let caseId;
  for (let index = 1; index <= 20; index += 1) {
    const requestedChannel = index % 2 === 0 ? "chat" : "voice";
    const boot = await bootstrap(requestedChannel);
    caseId ||= boot.activeCase.id;
    assert.equal(boot.activeCase.id, caseId, `Cycle ${index} changed the active case.`);

    const turn = await appendUserTurn({
      conversationId: boot.conversation.id,
      sequence: `resume-${index}`,
      channel: requestedChannel,
      text: `Fictional continuity answer ${index}.`,
    });
    assert.equal(turn.duplicate, false);

    const factKey = `continuity_cycle_${String(index).padStart(2, "0")}`;
    const factValue = `confirmed-${String(index).padStart(2, "0")}`;
    const committed = await commitTurn({
      turnId: turn.turn.id,
      expectedVersion: Number(boot.activeCase.rowVersion),
      sequence: `resume-${index}`,
      factKey,
      factValue,
    });

    const replay = await commitTurn({
      turnId: turn.turn.id,
      expectedVersion: -1,
      sequence: `changed-${index}`,
      factKey: `should_not_exist_${index}`,
      factValue: "not-saved",
      spokenResponse: "This changed replay must never replace the committed result.",
    });
    assert.deepEqual(replay, committed, `Cycle ${index} did not replay its original committed result.`);

    const resumed = await bootstrap(requestedChannel);
    assert.equal(resumed.activeCase.id, caseId);
    assert.equal(resumed.resumeContext.confirmedFacts[factKey], factValue);
    assert.equal(resumed.activeCase.rowVersion, Number(boot.activeCase.rowVersion) + 1);
  }

  const facts = await db.query(
    "select fact_key, fact_value from public.case_facts where case_id = $1::uuid",
    [caseId],
  );
  assert.equal(facts.rows.length, 20);
  assert.equal(facts.rows.some((fact) => String(fact.fact_key).startsWith("should_not_exist_")), false);

  const legacyWorkflowDetail = await db.query(
    "select completion_state from public.cases where id = $1::uuid",
    [caseId],
  );
  assert.deepEqual(
    legacyWorkflowDetail.rows[0].completion_state,
    {},
    "An interaction turn overwrote the legacy workflow-detail column.",
  );

  const recent = await db.query(
    "select public.civya_recent_case_turns($1::uuid, 6) as value",
    [caseId],
  );
  assert.equal(recent.rows[0].value.length, 6);
  assert.deepEqual(new Set(recent.rows[0].value.map((turn) => turn.channel)), new Set(["voice", "chat"]));
  pass("20 stop/resume and voice/text cycles preserve one case without mutating outcome state");
  return caseId;
}

async function testAtomicFinalCommit(caseId) {
  await setServiceActor(USER_A);
  const boot = await bootstrap("voice");
  assert.equal(boot.activeCase.id, caseId);
  const turn = await appendUserTurn({
    conversationId: boot.conversation.id,
    sequence: "atomic-final",
    channel: "voice",
    text: "That is everything for this fictional demonstration.",
  });
  const committed = await commitTurn({
    turnId: turn.turn.id,
    expectedVersion: Number(boot.activeCase.rowVersion),
    sequence: "atomic-final",
    factKey: "atomic_final_saved",
    factValue: "yes",
    spokenResponse: "This fictional conversation is complete.",
    finish: true,
  });
  assert.equal(committed.caseUpdate.rowVersion, Number(boot.activeCase.rowVersion) + 1);
  const ended = await db.query(
    "select status, ended_at from public.conversations where id = $1::uuid",
    [boot.conversation.id],
  );
  assert.equal(ended.rows[0].status, "ended");
  assert.ok(ended.rows[0].ended_at);

  const resumed = await bootstrap("voice");
  assert.equal(resumed.activeCase.id, caseId);
  assert.notEqual(resumed.conversation.id, boot.conversation.id);
  pass("final turn commit atomically closes playback context and resume opens a fresh conversation");
}

async function testConcurrentStaleWrite(caseId) {
  await setServiceActor(USER_A);
  const boot = await bootstrap("voice");
  assert.equal(boot.activeCase.id, caseId);
  const baseVersion = Number(boot.activeCase.rowVersion);

  const writerA = await appendUserTurn({
    conversationId: boot.conversation.id,
    sequence: "concurrent-a",
    channel: "voice",
    text: "Writer A fictional update.",
  });
  const writerB = await appendUserTurn({
    conversationId: boot.conversation.id,
    sequence: "concurrent-b",
    channel: "voice",
    text: "Writer B fictional update.",
  });
  const writes = [
    {
      turnId: writerA.turn.id,
      expectedVersion: baseVersion,
      sequence: "concurrent-a",
      factKey: "concurrency_writer_a",
      factValue: "A",
    },
    {
      turnId: writerB.turn.id,
      expectedVersion: baseVersion,
      sequence: "concurrent-b",
      factKey: "concurrency_writer_b",
      factValue: "B",
    },
  ];

  const settled = await Promise.allSettled(writes.map((write) => commitTurn(write)));
  const fulfilled = settled.flatMap((result, index) => result.status === "fulfilled" ? [index] : []);
  const rejected = settled.flatMap((result, index) => result.status === "rejected" ? [index] : []);
  assert.equal(fulfilled.length, 1, "Exactly one writer must win the shared row version.");
  assert.equal(rejected.length, 1, "Exactly one writer must be rejected as stale.");
  assert.equal(settled[rejected[0]].reason?.code, "40001");

  const beforeRetry = await db.query(
    `select fact_key from public.case_facts
     where case_id = $1::uuid and fact_key like 'concurrency_writer_%'
     order by fact_key`,
    [caseId],
  );
  assert.deepEqual(beforeRetry.rows.map((row) => row.fact_key), [writes[fulfilled[0]].factKey]);

  const current = await db.query(
    "select row_version from public.cases where id = $1::uuid",
    [caseId],
  );
  assert.equal(Number(current.rows[0].row_version), baseVersion + 1);
  await commitTurn({ ...writes[rejected[0]], expectedVersion: baseVersion + 1 });

  const afterRetry = await db.query(
    `select fact_key, fact_value from public.case_facts
     where case_id = $1::uuid and fact_key like 'concurrency_writer_%'
     order by fact_key`,
    [caseId],
  );
  assert.deepEqual(afterRetry.rows.map((row) => row.fact_key), ["concurrency_writer_a", "concurrency_writer_b"]);
  assert.deepEqual(afterRetry.rows.map((row) => row.fact_value), ["A", "B"]);
  pass("concurrent writers reject the stale version and retain both updates after bounded retry");
}

async function testAuthoritativeOutcomeKernel(caseId) {
  await setServiceActor(USER_A);

  await db.query(
    "insert into auth.users (id) values ($1::uuid), ($2::uuid)",
    [STAFF_USER, REVIEWER_USER],
  );
  await db.query(
    `insert into public.staff_roles (tenant_id, auth_user_id, role, status)
     values ($1::uuid, $2::uuid, 'admin', 'active')`,
    [TENANT_ID, STAFF_USER],
  );
  await db.query(
    `insert into public.staff_roles (tenant_id, auth_user_id, role, status)
     values ($1::uuid, $2::uuid, 'reviewer', 'active')`,
    [TENANT_ID, REVIEWER_USER],
  );
  await db.query(
    `insert into public.tenants (
       id, slug, name, environment, fictional, status, content_version, retention_days
     ) values (
       $1::uuid, 'other-fictional-county', 'Other Fictional County', 'sandbox',
       true, 'active', 'fictional-v1.0.0', 30
     )`,
    [OTHER_TENANT_ID],
  );
  await db.query(
    `insert into public.authoritative_source_systems (
       tenant_id, source_key, display_name, authority_scope, status, fictional
     ) values (
       $1::uuid, 'other_fictional_feed', 'Other fictional feed',
       array['fictional_relief_status']::text[], 'synthetic', true
     )`,
    [OTHER_TENANT_ID],
  );
  await db.query("update public.cases set parcel_id = 'P-100' where id = $1::uuid", [caseId]);

  const definitionResult = await db.query(
    `select public.civya_service_register_outcome_definition(
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::text[],
       $10::jsonb, $11::jsonb, $12::timestamptz, $13::timestamptz, $14, $15
     ) as value`,
    [
      STAFF_USER,
      TENANT_ID,
      "fictional_property_tax_relief",
      "fictional_relief_completed",
      "synthetic-v1.0.0",
      "fictional_county_outcome_feed",
      "fictional_relief_status",
      "1.0",
      ["parcel_id", "official_receipt"],
      JSON.stringify({ program_status: "completed" }),
      JSON.stringify({ program_status: "cancelled" }),
      "2026-01-01T00:00:00Z",
      null,
      true,
      "synthetic_test",
    ],
  );
  const definitionId = definitionResult.rows[0].value.outcomeDefinitionId;

  async function ingest({
    suffix,
    effectiveAt,
    payload,
    batchHash,
    supersedesRecordId = null,
    idempotencyKey = `kernel-ingest-${suffix}`,
  }) {
    const result = await db.query(
      `select public.civya_service_ingest_source_snapshot(
         $1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9,
         $10::timestamptz, $11::jsonb, $12::uuid, $13
       ) as value`,
      [
        TENANT_ID,
        "fictional_county_outcome_feed",
        "Fictional County outcome feed",
        `batch-${suffix}`,
        "1.0",
        batchHash,
        effectiveAt,
        "fictional_relief_status",
        "parcel-P-100",
        effectiveAt,
        JSON.stringify(payload),
        supersedesRecordId,
        idempotencyKey,
      ],
    );
    return result.rows[0].value;
  }

  async function match({
    sourceRecordId,
    decision,
    suffix,
    supersedesMatchId = null,
  }) {
    const result = await db.query(
      `select public.civya_service_record_source_match(
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7
       ) as value`,
      [
        null,
        caseId,
        sourceRecordId,
        decision,
        `synthetic_${decision}`,
        supersedesMatchId,
        `kernel-match-${suffix}`,
      ],
    );
    return result.rows[0].value;
  }

  async function reconcile({ sourceRecordId, suffix }) {
    const result = await db.query(
      `select public.civya_service_reconcile_outcome(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6
       ) as value`,
      [
        null,
        caseId,
        definitionId,
        sourceRecordId,
        "synthetic-kernel-test-v1",
        `kernel-reconcile-${suffix}`,
      ],
    );
    return result.rows[0].value;
  }

  const verifiedRecord = await ingest({
    suffix: "verified",
    effectiveAt: "2026-07-01T12:00:00Z",
    payload: { parcel_id: "P-100", program_status: "completed", official_receipt: "R-1" },
    batchHash: "a".repeat(64),
  });
  const expectedPayloadHash = await db.query(
    "select encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') as hash",
    [JSON.stringify({ parcel_id: "P-100", program_status: "completed", official_receipt: "R-1" })],
  );
  assert.equal(verifiedRecord.payloadSha256, expectedPayloadHash.rows[0].hash);
  await assert.rejects(
    db.query(
      `insert into public.authoritative_source_batches (
         tenant_id, source_system_id, external_batch_id, schema_version,
         declared_batch_sha256, source_generated_at, disposition,
         authentication_state, idempotency_key
       ) values (
         $1::uuid, $2::uuid, 'cross-tenant-batch', '1.0', $3,
         now(), 'accepted', 'synthetic', 'cross-tenant-batch'
       )`,
      [OTHER_TENANT_ID, verifiedRecord.sourceSystemId, "0".repeat(64)],
    ),
    (error) => error.code === "23514",
    "The database accepted a cross-tenant source chain.",
  );
  const verifiedMatch = await match({
    sourceRecordId: verifiedRecord.sourceRecordId,
    decision: "accepted",
    suffix: "verified",
  });
  const mismatchedRecord = await ingest({
    suffix: "identifier-mismatch",
    effectiveAt: "2026-07-01T18:00:00Z",
    payload: { parcel_id: "P-999", program_status: "completed", official_receipt: "R-X" },
    batchHash: "0f".repeat(32),
  });
  await assert.rejects(
    match({
      sourceRecordId: mismatchedRecord.sourceRecordId,
      decision: "accepted",
      suffix: "identifier-mismatch",
      supersedesMatchId: verifiedMatch.matchDecisionId,
    }),
    (error) => error.code === "55000",
  );
  const verified = await reconcile({
    sourceRecordId: verifiedRecord.sourceRecordId,
    suffix: "verified",
  });
  assert.equal(verified.result, "verified");
  assert.equal(verified.currentStatus, "verified");
  assert.equal(verified.evidenceScope, "synthetic");
  assert.match(verified.inputSha256, /^[0-9a-f]{64}$/);
  assert.ok(verified.controllingEventId);
  await assert.rejects(
    db.query("update public.cases set parcel_id = 'P-200' where id = $1::uuid", [caseId]),
    (error) => error.code === "55000",
    "A case identity change left an existing verified projection in place.",
  );

  const replay = await reconcile({
    sourceRecordId: verifiedRecord.sourceRecordId,
    suffix: "verified",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.reconciliationRunId, verified.reconciliationRunId);
  assert.equal(replay.inputSha256, verified.inputSha256);

  await assert.rejects(
    ingest({
      suffix: "verified-conflict",
      effectiveAt: "2026-07-01T12:00:00Z",
      payload: { parcel_id: "P-100", program_status: "completed", official_receipt: "R-X" },
      batchHash: "d".repeat(64),
      idempotencyKey: "kernel-ingest-verified",
    }),
    (error) => error.code === "23505",
  );

  await setClaims(USER_A, { anonymous: false, role: "authenticated" });
  await db.exec("set role authenticated");
  try {
    await assert.rejects(
      db.query(
        `select public.civya_service_reconcile_outcome(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'forbidden', 'forbidden'
         )`,
        [USER_A, caseId, definitionId, verifiedRecord.sourceRecordId],
      ),
      (error) => error.code === "42501",
    );
    const hidden = await db.query(
      "select case_id from public.case_outcome_projections where case_id = $1::uuid",
      [caseId],
    );
    assert.equal(hidden.rows.length, 0, "Resident read staff-only outcome evidence.");
  } finally {
    await db.exec("reset role");
  }

  await setClaims(STAFF_USER, { anonymous: false, role: "authenticated" });
  await db.exec("set role authenticated");
  try {
    const visibleProjection = await db.query(
      "select case_id from public.case_outcome_projections where case_id = $1::uuid",
      [caseId],
    );
    assert.equal(visibleProjection.rows.length, 1, "Tenant admin could not read outcome projection.");
    const visibleSources = await db.query(
      "select tenant_id from public.authoritative_source_systems order by tenant_id",
    );
    assert.deepEqual(visibleSources.rows.map((row) => row.tenant_id), [TENANT_ID]);
  } finally {
    await db.exec("reset role");
  }

  await setClaims(REVIEWER_USER, { anonymous: false, role: "authenticated" });
  await db.exec("set role authenticated");
  try {
    const reviewerProjection = await db.query(
      "select case_id from public.case_outcome_projections where case_id = $1::uuid",
      [caseId],
    );
    assert.equal(reviewerProjection.rows.length, 1);
    const reviewerRawSources = await db.query(
      "select id from public.authoritative_source_records",
    );
    assert.equal(reviewerRawSources.rows.length, 0, "Reviewer read privileged raw source evidence.");
  } finally {
    await db.exec("reset role");
  }

  await setServiceActor(USER_A);
  await db.exec("set role service_role");
  try {
    await assert.rejects(
      db.query(
        "update public.case_outcome_projections set current_status = 'reversed' where case_id = $1::uuid",
        [caseId],
      ),
      (error) => error.code === "42501",
      "service_role bypassed the governed outcome RPC boundary.",
    );
  } finally {
    await db.exec("reset role");
  }

  await setServiceActor(USER_A);
  await assert.rejects(
    db.query(
      "update public.outcome_verification_events set evidence = '{}'::jsonb where id = $1::uuid",
      [verified.controllingEventId],
    ),
    (error) => error.code === "55000",
  );

  const staleRecord = await ingest({
    suffix: "stale",
    effectiveAt: "2026-06-01T12:00:00Z",
    payload: { parcel_id: "P-100", program_status: "completed", official_receipt: "R-OLD" },
    batchHash: "1".repeat(64),
  });
  const staleMatch = await match({
    sourceRecordId: staleRecord.sourceRecordId,
    decision: "accepted",
    suffix: "stale",
    supersedesMatchId: verifiedMatch.matchDecisionId,
  });
  const stale = await reconcile({
    sourceRecordId: staleRecord.sourceRecordId,
    suffix: "stale",
  });
  assert.equal(stale.result, "ambiguous");
  assert.equal(stale.currentStatus, "verified");
  assert.ok(stale.reasons.some((reason) => reason.code === "stale_source_record"));

  const ambiguousRecord = await ingest({
    suffix: "ambiguous",
    effectiveAt: "2026-07-02T12:00:00Z",
    payload: { parcel_id: "P-100", program_status: "completed", official_receipt: "R-2" },
    batchHash: "4".repeat(64),
  });
  const ambiguousMatch = await match({
    sourceRecordId: ambiguousRecord.sourceRecordId,
    decision: "ambiguous",
    suffix: "ambiguous",
    supersedesMatchId: staleMatch.matchDecisionId,
  });
  const ambiguous = await reconcile({
    sourceRecordId: ambiguousRecord.sourceRecordId,
    suffix: "ambiguous",
  });
  assert.equal(ambiguous.result, "ambiguous");
  assert.equal(ambiguous.currentStatus, "verified");

  const incompleteRecord = await ingest({
    suffix: "incomplete",
    effectiveAt: "2026-07-02T18:00:00Z",
    payload: { parcel_id: "P-100", program_status: "pending" },
    batchHash: "d1".repeat(32),
  });
  const incompleteMatch = await match({
    sourceRecordId: incompleteRecord.sourceRecordId,
    decision: "accepted",
    suffix: "incomplete",
    supersedesMatchId: ambiguousMatch.matchDecisionId,
  });
  const incomplete = await reconcile({
    sourceRecordId: incompleteRecord.sourceRecordId,
    suffix: "incomplete",
  });
  assert.equal(incomplete.result, "incomplete");
  assert.equal(incomplete.currentStatus, "verified");
  assert.ok(incomplete.reasons.some((reason) => reason.code === "missing_required_field"));

  const eventsBeforeReversal = await db.query(
    "select count(*)::integer as count from public.outcome_verification_events where case_id = $1::uuid",
    [caseId],
  );
  assert.equal(eventsBeforeReversal.rows[0].count, 1);

  const reversalRecord = await ingest({
    suffix: "reversal",
    effectiveAt: "2026-07-03T12:00:00Z",
    payload: { parcel_id: "P-100", program_status: "cancelled", official_receipt: "R-3" },
    batchHash: "7".repeat(64),
    supersedesRecordId: verifiedRecord.sourceRecordId,
  });
  const reversalMatch = await match({
    sourceRecordId: reversalRecord.sourceRecordId,
    decision: "accepted",
    suffix: "reversal",
    supersedesMatchId: incompleteMatch.matchDecisionId,
  });
  const reversed = await reconcile({
    sourceRecordId: reversalRecord.sourceRecordId,
    suffix: "reversal",
  });
  assert.equal(reversed.result, "reversed");
  assert.equal(reversed.currentStatus, "reversed");

  await assert.rejects(
    db.query(
      `select public.civya_service_export_outcome_evidence(
         $1::uuid, $2::uuid, 'Unauthorized export test', 'kernel-export-forbidden'
       )`,
      [USER_A, caseId],
    ),
    (error) => error.code === "42501",
  );
  const exportResult = await db.query(
    `select value,
       encode(sha256(convert_to((value - 'packageIntegrity')::text, 'UTF8')), 'hex')
         as recomputed_hash
     from (
       select public.civya_service_export_outcome_evidence(
         $1::uuid, $2::uuid, $3, $4
       ) as value
     ) exported`,
    [STAFF_USER, caseId, "Synthetic kernel verification test", "kernel-export-1"],
  );
  const evidence = exportResult.rows[0].value;
  assert.equal(evidence.schemaVersion, "civya-outcome-evidence-1.1");
  assert.equal(evidence.currentProjections[0].current_status, "reversed");
  assert.equal(evidence.outcomeDefinitions.length, 1);
  assert.equal(evidence.sourceSystems.length, 1);
  assert.equal(evidence.sourceBatches.length, 5);
  assert.equal(evidence.verificationEvents.length, 2);
  assert.equal(evidence.reconciliationRuns.length, 5);
  assert.match(evidence.packageIntegrity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.packageIntegrity.signatureState, "unsigned_synthetic");
  assert.equal(evidence.packageIntegrity.sha256, exportResult.rows[0].recomputed_hash);
  const exportAudit = await db.query(
    "select event_type from public.audit_events where request_id = 'kernel-export-1'",
  );
  assert.equal(exportAudit.rows[0].event_type, "synthetic_outcome_evidence_exported");

  const verifiedCountAfterReversal = await db.query(
    "select count(*)::integer as count from public.case_outcome_projections where tenant_id = $1::uuid and current_status = 'verified'",
    [TENANT_ID],
  );
  assert.equal(verifiedCountAfterReversal.rows[0].count, 0);

  const restoredRecord = await ingest({
    suffix: "restored",
    effectiveAt: "2026-07-04T12:00:00Z",
    payload: { parcel_id: "P-100", program_status: "completed", official_receipt: "R-4" },
    batchHash: "a1".repeat(32),
    supersedesRecordId: reversalRecord.sourceRecordId,
  });
  const restoredMatch = await match({
    sourceRecordId: restoredRecord.sourceRecordId,
    decision: "accepted",
    suffix: "restored",
    supersedesMatchId: reversalMatch.matchDecisionId,
  });
  const restored = await reconcile({
    sourceRecordId: restoredRecord.sourceRecordId,
    suffix: "restored",
  });
  assert.equal(restored.result, "verified");
  assert.equal(restored.currentStatus, "verified");

  const concurrentRecordA = await ingest({
    suffix: "concurrent-a",
    effectiveAt: "2026-07-05T12:00:00Z",
    payload: { parcel_id: "P-100", program_status: "completed", official_receipt: "R-5A" },
    batchHash: "d2".repeat(32),
  });
  const concurrentRecordB = await ingest({
    suffix: "concurrent-b",
    effectiveAt: "2026-07-06T12:00:00Z",
    payload: { parcel_id: "P-100", program_status: "completed", official_receipt: "R-5B" },
    batchHash: "e3".repeat(32),
  });
  const concurrentMatches = await Promise.allSettled([
    match({
      sourceRecordId: concurrentRecordA.sourceRecordId,
      decision: "accepted",
      suffix: "concurrent-a",
      supersedesMatchId: restoredMatch.matchDecisionId,
    }),
    match({
      sourceRecordId: concurrentRecordB.sourceRecordId,
      decision: "accepted",
      suffix: "concurrent-b",
      supersedesMatchId: restoredMatch.matchDecisionId,
    }),
  ]);
  const winningMatchIndexes = concurrentMatches.flatMap((result, index) =>
    result.status === "fulfilled" ? [index] : []
  );
  const rejectedMatchIndexes = concurrentMatches.flatMap((result, index) =>
    result.status === "rejected" ? [index] : []
  );
  assert.equal(winningMatchIndexes.length, 1);
  assert.equal(rejectedMatchIndexes.length, 1);
  assert.equal(concurrentMatches[rejectedMatchIndexes[0]].reason?.code, "40001");

  const winningRecord = [concurrentRecordA, concurrentRecordB][winningMatchIndexes[0]];
  const eventsBeforeConcurrentReconcile = await db.query(
    "select count(*)::integer as count from public.outcome_verification_events where case_id = $1::uuid",
    [caseId],
  );
  const concurrentReconciliations = await Promise.all([
    reconcile({ sourceRecordId: winningRecord.sourceRecordId, suffix: "concurrent-a" }),
    reconcile({ sourceRecordId: winningRecord.sourceRecordId, suffix: "concurrent-b" }),
  ]);
  assert.ok(concurrentReconciliations.every((result) => result.result === "verified"));
  const eventsAfterConcurrentReconcile = await db.query(
    "select count(*)::integer as count from public.outcome_verification_events where case_id = $1::uuid",
    [caseId],
  );
  assert.equal(
    eventsAfterConcurrentReconcile.rows[0].count,
    eventsBeforeConcurrentReconcile.rows[0].count + 1,
    "Concurrent reconciliations forked the verification event chain.",
  );

  const reconciled = await db.query(
    `select
       (select count(*)::integer from public.case_outcome_projections
        where tenant_id = $1::uuid and current_status = 'verified') as aggregate_count,
       (select count(*)::integer
        from public.outcome_verification_events e
        where e.tenant_id = $1::uuid and e.event_type = 'verified'
          and not exists (
            select 1 from public.outcome_verification_events newer
            where newer.supersedes_event_id = e.id
          )) as ledger_count`,
    [TENANT_ID],
  );
  assert.equal(reconciled.rows[0].aggregate_count, reconciled.rows[0].ledger_count);
  assert.equal(reconciled.rows[0].aggregate_count, 1);
  pass("synthetic outcome kernel computes provenance hashes and blocks unauthorized, ambiguous, stale, forked, incomplete, and mutable-history paths");
}

async function testResidentIsolation(caseA) {
  await db.query("insert into auth.users (id) values ($1::uuid)", [USER_B]);
  await setServiceActor(USER_B);
  await grantTenantAccess(USER_B);
  const bootB = await bootstrap("voice");
  const caseB = bootB.activeCase.id;
  assert.notEqual(caseB, caseA);

  await setClaims(USER_A);
  await db.exec("set role authenticated");
  try {
    const visibleA = await db.query("select id from public.cases order by id");
    assert.deepEqual(visibleA.rows.map((row) => row.id), [caseA]);
    const victimA = await db.query("select id from public.cases where id = $1::uuid", [caseB]);
    assert.equal(victimA.rows.length, 0);
    const canAccessB = await db.query("select public.civya_can_access_case($1::uuid) as allowed", [caseB]);
    assert.equal(canAccessB.rows[0].allowed, false);

    await assert.rejects(
      db.query("update public.cases set status = $1 where id = $2::uuid", ["closed", caseA]),
      (error) => error.code === "42501",
    );

    await setClaims(USER_B);
    const visibleB = await db.query("select id from public.cases order by id");
    assert.deepEqual(visibleB.rows.map((row) => row.id), [caseB]);
  } finally {
    await db.exec("reset role");
  }
  pass("RLS isolates residents and direct workflow mutation remains denied");
  return { caseB, residentB: bootB.resident.id, tenantId: bootB.tenant.id };
}

async function testServiceOnlyBoundaries(caseA) {
  const owner = await db.query(
    `select c.resident_id, (
       select id from public.turns
       where case_id = c.id and speaker = 'user'
       order by created_at desc limit 1
     ) as turn_id
     from public.cases c where c.id = $1::uuid`,
    [caseA],
  );
  const { resident_id: residentId, turn_id: turnId } = owner.rows[0];

  await setClaims(USER_A, { anonymous: true, role: "anon" });
  await db.exec("set role anon");
  try {
    await assert.rejects(
      db.query("select public.civya_bootstrap_session($1, $2)", [TENANT_SLUG, "voice"]),
      (error) => error.code === "42501",
    );
  } finally {
    await db.exec("reset role");
  }

  await setClaims(USER_A, { anonymous: false, role: "authenticated" });
  await db.exec("set role authenticated");
  try {
    await assert.rejects(
      db.query(
        `select public.civya_service_commit_turn_result(
           $1::uuid, '', true, $2::uuid, 1, 'forbidden', null, 'forbidden',
           'intake_in_progress', '', '{}'::jsonb, '{}'::jsonb, false
         )`,
        [USER_A, turnId],
      ),
      (error) => error.code === "42501",
    );

    const directPath = `${TENANT_ID}/${residentId}/${caseA}/direct-resident-write`;
    await assert.rejects(
      db.query(
        "insert into storage.objects (bucket_id, name) values ('civya-private-documents', $1)",
        [directPath],
      ),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      db.query(
        `insert into public.documents (
           tenant_id, resident_id, case_id, storage_path, original_file_name,
           content_type, size_bytes, idempotency_key
         ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'forbidden.pdf',
           'application/pdf', 12, 'direct-resident-document')`,
        [TENANT_ID, residentId, caseA, directPath],
      ),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      db.query(
        `insert into public.consent (
           tenant_id, resident_id, case_id, consent_type, consent_text,
           granted, source, idempotency_key
         ) values (
           $1::uuid, $2::uuid, $3::uuid, 'save_progress',
           'Forbidden direct resident consent write.', true, 'resident',
           'direct-resident-consent'
         )`,
        [TENANT_ID, residentId, caseA],
      ),
      (error) => error.code === "42501",
    );
  } finally {
    await db.exec("reset role");
  }

  const workflowFunctions = await db.query(
    `select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'execute') as service_execute
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any($1::text[])`,
    [[
      "civya_bootstrap_session",
      "civya_create_or_get_conversation",
      "civya_append_turn",
      "civya_upsert_case_facts",
      "civya_commit_turn_result",
      "civya_finish_conversation",
      "civya_mark_identity_verified",
      "civya_create_case_transfer_grant",
      "civya_redeem_case_transfer_grant",
      "civya_append_audit_event",
      "civya_take_rate_limit",
      "civya_service_grant_tenant_access",
      "civya_service_bootstrap_session",
      "civya_service_create_or_get_conversation",
      "civya_service_append_turn",
      "civya_service_upsert_case_facts",
      "civya_service_commit_turn_result",
      "civya_service_finish_conversation",
      "civya_service_mark_identity_verified",
      "civya_service_create_case_transfer_grant",
      "civya_service_redeem_case_transfer_grant",
      "civya_service_append_audit_event",
      "civya_service_take_rate_limit",
      "civya_service_activate_case",
      "civya_service_ingest_source_snapshot",
      "civya_service_register_outcome_definition",
      "civya_service_record_source_match",
      "civya_service_reconcile_outcome",
      "civya_service_export_outcome_evidence",
    ]],
  );
  assert.ok(workflowFunctions.rows.length >= 29);
  for (const fn of workflowFunctions.rows) {
    assert.equal(fn.anon_execute, false, `${fn.proname} is executable by anon.`);
    assert.equal(fn.authenticated_execute, false, `${fn.proname} is executable by authenticated.`);
    assert.equal(fn.service_execute, true, `${fn.proname} is not executable by service_role.`);
  }
  pass("browser roles cannot invoke workflow RPCs or write document/Storage records directly");
}

async function testStorageScanReadBoundary(caseA) {
  const owner = await db.query(
    "select resident_id from public.cases where id = $1::uuid",
    [caseA],
  );
  const residentId = owner.rows[0].resident_id;
  const storagePath = `${TENANT_ID}/${residentId}/${caseA}/scan-boundary-object`;

  await setServiceActor(USER_A);
  await db.query(
    `insert into public.documents (
       tenant_id, resident_id, case_id, storage_path, original_file_name,
       content_type, size_bytes, scan_status, review_required, idempotency_key
     ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'scan-boundary.pdf',
       'application/pdf', 32, 'pending', true, 'scan-read-boundary')`,
    [TENANT_ID, residentId, caseA, storagePath],
  );
  await db.query(
    "insert into storage.objects (bucket_id, name) values ('civya-private-documents', $1)",
    [storagePath],
  );

  await setClaims(USER_A, { anonymous: false, role: "authenticated" });
  await db.exec("set role authenticated");
  try {
    const pending = await db.query("select name from storage.objects where name = $1", [storagePath]);
    assert.equal(pending.rows.length, 0, "Resident read a document before its scan was clean.");
  } finally {
    await db.exec("reset role");
  }

  await setServiceActor(USER_A);
  await db.query(
    "update public.documents set scan_status = 'clean', review_required = false where storage_path = $1",
    [storagePath],
  );
  await setClaims(USER_A, { anonymous: false, role: "authenticated" });
  await db.exec("set role authenticated");
  try {
    const clean = await db.query("select name from storage.objects where name = $1", [storagePath]);
    assert.deepEqual(clean.rows.map((row) => row.name), [storagePath]);
  } finally {
    await db.exec("reset role");
  }
  pass("resident Storage reads remain blocked until a document scan is clean");
}

async function testExpiringTenantGrant(caseA) {
  await setServiceActor(USER_A);
  await db.query(
    "update private.tenant_access_grants set expires_at = now() - interval '1 second' where auth_user_id = $1::uuid",
    [USER_A],
  );
  await assert.rejects(bootstrap("voice"), (error) => error.code === "42501");

  await setClaims(USER_A, { anonymous: false, role: "authenticated" });
  await db.exec("set role authenticated");
  try {
    const hidden = await db.query("select id from public.cases where id = $1::uuid", [caseA]);
    assert.equal(hidden.rows.length, 0);
  } finally {
    await db.exec("reset role");
  }

  await setServiceActor(USER_A);
  await grantTenantAccess(USER_A);
  const resumed = await bootstrap("voice");
  assert.equal(resumed.activeCase.id, caseA);
  pass("expired invitation grants remove resident RLS access until the signed grant is renewed");
}

async function testVersionedCaseActivation(caseA, caseB) {
  const email = "resident-a@example.test";
  await db.query("update auth.users set email = $1 where id = $2::uuid", [email, USER_A]);
  await setServiceActor(USER_A, { email, anonymous: false });
  const verified = await db.query(
    "select public.civya_service_mark_identity_verified($1::uuid, $2, false) as value",
    [USER_A, email],
  );
  const residentA = verified.rows[0].value.residentId;
  const second = await db.query(
    `insert into public.cases (tenant_id, resident_id, active, workflow_state)
     values ($1::uuid, $2::uuid, false, 'case_selection')
     returning id, row_version`,
    [TENANT_ID, residentA],
  );
  const secondCaseId = second.rows[0].id;

  const activatedSecond = await db.query(
    "select public.civya_service_activate_case($1::uuid, $2, false, $3::uuid, $4) as value",
    [USER_A, email, secondCaseId, Number(second.rows[0].row_version)],
  );
  assert.deepEqual(activatedSecond.rows[0].value.deactivatedCaseIds, [caseA]);
  await assert.rejects(
    db.query(
      "select public.civya_service_activate_case($1::uuid, $2, false, $3::uuid, 1)",
      [USER_A, email, secondCaseId],
    ),
    (error) => error.code === "40001",
  );

  const original = await db.query("select row_version from public.cases where id = $1::uuid", [caseA]);
  const reactivated = await db.query(
    "select public.civya_service_activate_case($1::uuid, $2, false, $3::uuid, $4) as value",
    [USER_A, email, caseA, Number(original.rows[0].row_version)],
  );
  assert.deepEqual(reactivated.rows[0].value.deactivatedCaseIds, [secondCaseId]);

  const cases = await db.query(
    `select id, resident_id, active from public.cases
     where id = any($1::uuid[]) order by id`,
    [[caseA, secondCaseId, caseB]],
  );
  const byId = new Map(cases.rows.map((row) => [row.id, row]));
  assert.equal(byId.get(caseA).active, true);
  assert.equal(byId.get(secondCaseId).active, false);
  assert.equal(byId.get(caseB).active, true, "Activating resident A's case changed resident B's case.");
  assert.equal(byId.get(caseA).resident_id, residentA);
  assert.equal(byId.get(secondCaseId).resident_id, residentA);
  const continuityFacts = await db.query(
    "select count(*)::integer as count from public.case_facts where case_id = $1::uuid",
    [caseA],
  );
  const secondFacts = await db.query(
    "select count(*)::integer as count from public.case_facts where case_id = $1::uuid",
    [secondCaseId],
  );
  assert.ok(continuityFacts.rows[0].count >= 20);
  assert.equal(secondFacts.rows[0].count, 0);
  pass("versioned activation changes only the verified resident's active pointer without merging cases");
}

async function testRetentionOutbox({ caseB, residentB, tenantId }, outcomeCaseId) {
  await setClaims("", { anonymous: false, role: "service_role" });
  const survivorResult = await db.query(
    `select id from public.cases
     where resident_id = (select resident_id from public.cases where id = $1::uuid)
       and id <> $1::uuid
     order by created_at desc limit 1`,
    [outcomeCaseId],
  );
  assert.equal(survivorResult.rows.length, 1, "A non-expired comparison case is required.");
  const survivingCaseId = survivorResult.rows[0].id;
  const storagePath = `${tenantId}/${residentB}/${caseB}/expired-fictional-document.pdf`;
  await db.query(
    `insert into public.documents (
       tenant_id, resident_id, case_id, storage_path, original_file_name,
       content_type, size_bytes, idempotency_key
     ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      residentB,
      caseB,
      storagePath,
      "expired-fictional-document.pdf",
      "application/pdf",
      128,
      "retention-document",
    ],
  );
  const expiredStorage = await db.query(
    "select storage_path from public.documents where case_id = any($1::uuid[]) order by storage_path",
    [[caseB, outcomeCaseId]],
  );
  const expiringSourceRecords = await db.query(
    `select distinct source_record_id
     from public.case_source_match_decisions
     where case_id = $1::uuid
     order by source_record_id`,
    [outcomeCaseId],
  );

  // The production trigger correctly stamps every mutation with now(). Disable
  // it only while constructing an intentionally 31-day-old deterministic row.
  await db.exec("alter table public.cases disable trigger set_updated_at");
  await db.exec("alter table public.residents disable trigger set_updated_at");
  try {
    await db.query(
      "update public.cases set updated_at = now() - make_interval(days => 31) where id = any($1::uuid[])",
      [[caseB, outcomeCaseId]],
    );
    await db.query(
      "update public.residents set updated_at = now() - make_interval(days => 31) where id = $1::uuid",
      [residentB],
    );
  } finally {
    await db.exec("alter table public.cases enable trigger set_updated_at");
    await db.exec("alter table public.residents enable trigger set_updated_at");
  }

  const cleanup = await db.query("select public.civya_prepare_retention_cleanup() as value");
  const result = cleanup.rows[0].value;
  assert.equal(result.casesRemoved, 2);
  assert.equal(result.residentsRemoved, 1);
  assert.deepEqual(
    result.deletions.map((item) => [item.kind, item.reference]).sort(),
    [
      ["auth_user", USER_B],
      ...expiredStorage.rows.map((row) => ["storage_object", row.storage_path]),
    ].sort(),
  );

  const survivor = await db.query("select id from public.cases where id = $1::uuid", [survivingCaseId]);
  assert.equal(survivor.rows.length, 1, "Retention cleanup deleted a non-expired resident case.");
  const retainedOutcomeRows = await db.query(
    `select
       (select count(*)::integer from public.case_source_match_decisions where case_id = $1::uuid) as matches,
       (select count(*)::integer from public.outcome_reconciliation_runs where case_id = $1::uuid) as runs,
       (select count(*)::integer from public.outcome_verification_events where case_id = $1::uuid) as events,
       (select count(*)::integer from public.case_outcome_projections where case_id = $1::uuid) as projections`,
    [outcomeCaseId],
  );
  assert.deepEqual(retainedOutcomeRows.rows[0], {
    matches: 0,
    runs: 0,
    events: 0,
    projections: 0,
  });
  const expiredSourceRecords = await db.query(
    "select id from public.authoritative_source_records where id = any($1::uuid[])",
    [expiringSourceRecords.rows.map((row) => row.source_record_id)],
  );
  assert.equal(expiredSourceRecords.rows.length, 0);
  const freshUnmatchedRecords = await db.query(
    `select count(*)::integer as count
     from public.authoritative_source_records r
     where r.tenant_id = $1::uuid
       and not exists (
         select 1 from public.case_source_match_decisions m where m.source_record_id = r.id
       )`,
    [tenantId],
  );
  assert.ok(freshUnmatchedRecords.rows[0].count >= 1, "Cleanup deleted fresh unmatched source records.");

  const deletionIds = result.deletions.map((item) => item.id);
  await db.query(
    "select public.civya_complete_retention_deletions($1::uuid[], null)",
    [deletionIds],
  );
  const replay = await db.query("select public.civya_prepare_retention_cleanup() as value");
  assert.deepEqual(replay.rows[0].value.deletions, []);
  pass("31-day retention removes expired synthetic outcome chains and durably queues Storage/Auth cleanup");
}

console.log("Supabase persistence and continuity");
try {
  await prepareDatabase();
  const caseA = await testTwentyResumeCycles();
  await testConcurrentStaleWrite(caseA);
  await testAtomicFinalCommit(caseA);
  await testAuthoritativeOutcomeKernel(caseA);
  const residentB = await testResidentIsolation(caseA);
  await testServiceOnlyBoundaries(caseA);
  await testStorageScanReadBoundary(caseA);
  await testExpiringTenantGrant(caseA);
  await testVersionedCaseActivation(caseA, residentB.caseB);
  await testRetentionOutbox(residentB, caseA);
  console.log("\nALL PERSISTENCE TESTS PASSED");
} finally {
  await db.close();
}
