#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { TwilioMessagingOutcomeUnknownError } from "@/lib/integrations/twilio-messaging-live";
import type { ExternalOperationClaimResult, JobEnvelope } from "@/lib/jobs";
import type { PreparedReminder } from "@/lib/reminders/contracts";
import { createReminderDeliveryHandler, REMINDER_JOB_TYPE } from "@/lib/reminders/worker-operation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const db = new PGlite();
const TENANT_A = "d1000000-0000-4000-8000-000000000001";
const TENANT_B = "d1000000-0000-4000-8000-000000000002";
const TEMPLATE = "c2100000-0000-4000-8000-000000000001";
const SCOPES = ["case.read", "case.participate", "document.read", "document.upload"];

interface Subject {
  user: string;
  resident: string;
  caseId: string;
  proof: string;
  entitlement: string;
  tenant: string;
}

const subjects: Subject[] = Array.from({ length: 6 }, (_, index) => {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    user: `d2000000-0000-4000-8000-${suffix}`,
    resident: `d3000000-0000-4000-8000-${suffix}`,
    caseId: `d4000000-0000-4000-8000-${suffix}`,
    proof: `d5000000-0000-4000-8000-${suffix}`,
    entitlement: `d6000000-0000-4000-8000-${suffix}`,
    tenant: index === 5 ? TENANT_B : TENANT_A,
  };
});

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
  assert.ok(migrations.includes("202607160021_durable_entitled_reminders.sql"));
  pass("all migrations apply through the durable reminder boundary");
}

async function seed() {
  await db.query(
    `insert into public.tenants (
       id, slug, name, environment, fictional, status, content_version, retention_days
     ) values
       ($1::uuid, 'reminder-production-a', 'Reminder A', 'production', false, 'active', 'v1', 365),
       ($2::uuid, 'reminder-production-b', 'Reminder B', 'production', false, 'active', 'v1', 365)`,
    [TENANT_A, TENANT_B],
  );
  for (const [index, subject] of subjects.entries()) {
    const email = `reminder-${index + 1}@example.test`;
    await db.query(`insert into auth.users (id, email) values ($1::uuid, $2)`, [subject.user, email]);
    await db.query(
      `insert into public.residents (
         id, tenant_id, auth_user_id, identity_state, email, phone, preferred_contact_channel
       ) values ($1::uuid, $2::uuid, $3::uuid, 'verified', $4, $5, 'sms')`,
      [subject.resident, subject.tenant, subject.user, email, `+13135550${String(index + 1).padStart(3, "0")}`],
    );
    await db.query(
      `insert into public.cases (id, tenant_id, resident_id, next_best_action)
       values ($1::uuid, $2::uuid, $3::uuid, 'Review your saved next step.')`,
      [subject.caseId, subject.tenant, subject.resident],
    );
    await db.query(
      `insert into public.identity_proof_challenges (
         id, tenant_id, resident_id, case_id, auth_user_id, method, provider_key,
         challenge_digest, state, assurance_level, evidence_digest,
         attempt_count, expires_at, verified_at, resolved_at, idempotency_key
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'county_notice',
         'wayne_county_case_entitlement', $6, 'verified', 'substantial', $7,
         1, now() + interval '2 days', now(), now(), $8
       )`,
      [subject.proof, subject.tenant, subject.resident, subject.caseId, subject.user,
        String(index + 1).repeat(64), String(index + 2).repeat(64), `proof-${index + 1}`],
    );
    await db.query(
      `insert into public.case_entitlements (
         id, tenant_id, case_id, resident_id, auth_user_id, proof_challenge_id,
         scopes, assurance_level, state, granted_by_type, grant_reason_code,
         evidence_digest, expires_at, idempotency_key
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::text[], 'substantial', 'active', 'provider', 'verified_identity',
         $8, now() + interval '1 day', $9
       )`,
      [subject.entitlement, subject.tenant, subject.caseId, subject.resident,
        subject.user, subject.proof, SCOPES, String(index + 2).repeat(64), `entitlement-${index + 1}`],
    );
  }
}

async function schedule(subject: Subject, key: string) {
  const scheduled = new Date(Date.now() + 24 * 60 * 60_000);
  scheduled.setUTCHours(12, 0, 0, 0);
  const scheduledFor = scheduled.toISOString();
  const result = await db.query<{ value: Record<string, any> }>(
    `select public.civya_service_schedule_entitled_reminder(
       $1::uuid, $2::uuid, $3::uuid, 'sms', $4::timestamptz,
       'Etc/UTC', 'civya.secure_account_reminder', 'v1',
       'civya-reminder-consent-v1', true, true, $5
     ) as value`,
    [subject.user, subject.caseId, subject.entitlement, scheduledFor, key],
  );
  return result.rows[0].value;
}

async function timezoneWithCurrentHour(minInclusive: number, maxExclusive: number): Promise<string> {
  const zones = await db.query<{ name: string; local_hour: number }>(
    `select name, extract(hour from now() at time zone name)::integer as local_hour
     from pg_timezone_names
     where extract(hour from now() at time zone name) >= $1
       and extract(hour from now() at time zone name) < $2
     order by name
     limit 1`,
    [minInclusive, maxExclusive],
  );
  const zone = zones.rows[0];
  assert.ok(zone?.name, `No timezone currently falls between hours ${minInclusive} and ${maxExclusive}.`);
  assert.ok(zone.local_hour >= minInclusive && zone.local_hour < maxExclusive);
  return zone.name;
}

async function makeDue(reminderId: string, timezone?: string) {
  // Ready-path tests must not depend on the wall-clock hour in UTC. Keep at
  // least two hours of buffer from both 08:00 and 21:00 policy boundaries.
  const effectiveTimezone = timezone ?? await timezoneWithCurrentHour(10, 18);
  await db.query(
    `update public.reminders set scheduled_for = now() - interval '1 minute',
       quiet_hours_timezone = $2 where id = $1::uuid`,
    [reminderId, effectiveTimezone],
  );
  await db.query(
    `update public.communication_deliveries set scheduled_for = now() - interval '1 minute'
     where id = (select delivery_id from public.reminders where id = $1::uuid)`,
    [reminderId],
  );
}

async function prepare(reminderId: string) {
  const result = await db.query<{ value: Record<string, any> }>(
    `select public.civya_service_prepare_reminder_delivery($1::uuid) as value`,
    [reminderId],
  );
  return result.rows[0].value;
}

async function testSchedulingAndIdempotency() {
  const subject = subjects[0];
  await setRole("authenticated", subject.user);
  await assert.rejects(schedule(subject, "reminder-boundary-1"), (error: { code?: string }) => error.code === "42501");
  await setRole("service_role");
  const first = await schedule(subject, "reminder-boundary-1");
  const replay = await schedule(subject, "reminder-boundary-1");
  assert.equal(first.reminderId, replay.reminderId);
  assert.equal(replay.duplicate, true);
  const payload = (await db.query<{ payload: Record<string, unknown> }>(
    `select payload from private.outbox_events where aggregate_id = $1::uuid`, [first.reminderId],
  )).rows[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["caseId", "deliveryId", "notBefore", "reminderId", "residentId", "templateId"]);
  assert.doesNotMatch(JSON.stringify(payload), /@|\+1313|phone|email|destination/i);
  const consents = await db.query<{ consent_type: string }>(
    `select consent_type from public.consent where case_id = $1::uuid order by consent_type`, [subject.caseId],
  );
  assert.deepEqual(consents.rows.map((row) => row.consent_type), ["reminder", "sms"]);
  await assert.rejects(
    schedule({ ...subject, caseId: subjects[5].caseId }, "wrong-tenant-case"),
    (error: { code?: string }) => error.code === "42501",
  );
  pass("service-only scheduling is exactly entitled, creates both consents and a contact-free idempotent outbox event");
}

async function testRevocationAndSuppression() {
  const revoked = await schedule(subjects[1], "reminder-revoked-consent");
  await makeDue(revoked.reminderId);
  await db.query(
    `update public.consent set revoked_at = now(), granted = false
     where id = (select consent_id from public.reminders where id = $1::uuid)`, [revoked.reminderId],
  );
  const revokedResult = await prepare(revoked.reminderId);
  assert.equal(revokedResult.state, "suppressed");
  assert.equal(revokedResult.reasonCode, "consent_inactive");

  const suppressed = await schedule(subjects[2], "reminder-contact-suppression");
  await makeDue(suppressed.reminderId);
  const initiallyReady = await prepare(suppressed.reminderId);
  assert.equal(initiallyReady.state, "ready");
  await db.query(
    `select public.civya_service_suppress_twilio_contact(
       $1::uuid, $2, 'provider-stop-event-1', 'provider_opt_out'
     )`, [subjects[2].tenant, initiallyReady.contactReferenceDigest],
  );
  const suppressedResult = await prepare(suppressed.reminderId);
  assert.equal(suppressedResult.state, "terminal");
  assert.equal(suppressedResult.status, "suppressed");

  const expiredProofSubject = subjects[5];
  const expiredProofReminder = await schedule(expiredProofSubject, "reminder-expired-proof");
  await makeDue(expiredProofReminder.reminderId);
  await db.query(
    `update public.identity_proof_challenges
     set created_at = now() - interval '3 hours',
         verified_at = now() - interval '2 hours',
         resolved_at = now() - interval '2 hours',
         expires_at = now() - interval '1 hour'
     where id = $1::uuid`,
    [expiredProofSubject.proof],
  );
  await assert.rejects(
    schedule(expiredProofSubject, "reminder-expired-proof-new"),
    (error: { code?: string }) => error.code === "42501",
  );
  const expiredProofResult = await prepare(expiredProofReminder.reminderId);
  assert.equal(expiredProofResult.state, "suppressed");
  assert.equal(expiredProofResult.reasonCode, "entitlement_inactive");
  pass("dispatch rechecks consent, suppression, and current proof before any side effect");
}

async function testQuietHours() {
  const reminder = await schedule(subjects[3], "reminder-quiet-hours");
  // Choose a timezone safely inside quiet hours rather than one close to the
  // 08:00 opening boundary, so a minute boundary cannot make this test flaky.
  const quietTimezone = await timezoneWithCurrentHour(0, 6);
  await makeDue(reminder.reminderId, quietTimezone);
  const result = await prepare(reminder.reminderId);
  assert.equal(result.state, "deferred");
  assert.equal(result.reasonCode, "quiet_hours");
  assert.ok(Date.parse(result.nextEligibleAt) > Date.now());
  pass("worker-time quiet-hours evaluation defers rather than sends");
}

async function claimProviderEvent(subject: Subject, eventId: string, status: string, payloadSha: string) {
  const result = await db.query<{ value: Record<string, any> }>(
    `select public.civya_service_claim_provider_event(
       $1::uuid, 'twilio', $2, $3, $4, '{}'::jsonb, true,
       'reminder-boundary-test', 30, 8
     ) as value`, [subject.tenant, eventId, status, payloadSha],
  );
  return result.rows[0].value;
}

async function applyReceipt(input: {
  subject: Subject; providerEventId: string; externalEventId: string;
  deliveryId: string; referenceDigest: string; status: string; payloadSha: string;
}) {
  const result = await db.query<{ value: Record<string, any> }>(
    `select public.civya_service_apply_twilio_delivery_receipt(
       $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7
     ) as value`,
    [input.subject.tenant, input.providerEventId, input.externalEventId, input.deliveryId,
      input.referenceDigest, input.status, input.payloadSha],
  );
  return result.rows[0].value;
}

async function testReceiptReplayAndOrdering() {
  const subject = subjects[4];
  const reminder = await schedule(subject, "reminder-receipts");
  await makeDue(reminder.reminderId);
  const ready = await prepare(reminder.reminderId);
  assert.equal(ready.state, "ready");
  const referenceDigest = "a".repeat(64);
  const deliveredPayload = "b".repeat(64);
  const deliveredEvent = await claimProviderEvent(subject, "SMtest:delivered", "delivered", deliveredPayload);
  const delivered = await applyReceipt({ subject, providerEventId: deliveredEvent.id,
    externalEventId: "SMtest:delivered", deliveryId: reminder.deliveryId,
    referenceDigest, status: "delivered", payloadSha: deliveredPayload });
  assert.equal(delivered.status, "delivered");
  const replay = await applyReceipt({ subject, providerEventId: deliveredEvent.id,
    externalEventId: "SMtest:delivered", deliveryId: reminder.deliveryId,
    referenceDigest, status: "delivered", payloadSha: deliveredPayload });
  assert.equal(replay.duplicate, true);
  const failedPayload = "c".repeat(64);
  const failedEvent = await claimProviderEvent(subject, "SMtest:failed", "failed", failedPayload);
  const outOfOrder = await applyReceipt({ subject, providerEventId: failedEvent.id,
    externalEventId: "SMtest:failed", deliveryId: reminder.deliveryId,
    referenceDigest, status: "failed", payloadSha: failedPayload });
  assert.equal(outOfOrder.status, "delivered");
  const stored = await db.query<{ status: string; delivered_at: string | null }>(
    `select status, delivered_at from public.communication_deliveries where id = $1::uuid`, [reminder.deliveryId],
  );
  assert.equal(stored.rows[0].status, "delivered");
  assert.ok(stored.rows[0].delivered_at);
  pass("signed delivery receipts are idempotent and out-of-order failure cannot downgrade delivered evidence");
}

function preparedReminder(): Extract<PreparedReminder, { state: "ready" }> {
  return {
    state: "ready", status: "queued", tenantId: TENANT_A,
    residentId: subjects[0].resident, caseId: subjects[0].caseId,
    entitlementId: subjects[0].entitlement,
    reminderId: "e1000000-0000-4000-8000-000000000001",
    deliveryId: "e2000000-0000-4000-8000-000000000001", templateId: TEMPLATE,
    templateKey: "civya.secure_account_reminder", templateVersion: "v1",
    templateBody: "Civya reminder: sign in using this secure link to review your saved next step. This text does not confirm County receipt or approval. {{secure_link}}",
    destination: "+13135550100", contactReferenceDigest: "d".repeat(64),
    quietHoursCheckedAt: new Date().toISOString(),
  };
}

function job(prepared: Extract<PreparedReminder, { state: "ready" }>): JobEnvelope {
  return {
    id: "e3000000-0000-4000-8000-000000000001", tenantId: prepared.tenantId,
    type: REMINDER_JOB_TYPE, schemaVersion: "1",
    payload: { reminderId: prepared.reminderId, deliveryId: prepared.deliveryId,
      caseId: prepared.caseId, residentId: prepared.residentId, templateId: prepared.templateId,
      notBefore: new Date().toISOString(), outboxEventId: "e4000000-0000-4000-8000-000000000001" },
    idempotencyKey: "outbox:test", sourceType: "outbox_event",
    sourceId: "e4000000-0000-4000-8000-000000000001", priority: 0,
    deadlineAt: null, state: "leased", attempt: 1, maxAttempts: 8, timeoutSeconds: 60,
    availableAt: new Date().toISOString(), leaseOwner: "test",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
  };
}

async function testCrashAfterProviderBoundary() {
  const prepared = preparedReminder();
  let operation: ExternalOperationClaimResult = {
    id: "e5000000-0000-4000-8000-000000000001", state: "planned", externalReference: null,
    acquired: false, busy: false, claimToken: null, leaseExpiresAt: null, attempt: 0,
  };
  let claimOwner = "";
  let providerCalls = 0;
  const outcomes: string[] = [];
  const reminders = {
    async prepareDelivery() { return prepared; },
    async markDeliveryOutcome(input: { outcome: string }) {
      outcomes.push(input.outcome);
      return { reminderId: prepared.reminderId, deliveryId: prepared.deliveryId,
        status: input.outcome, duplicate: false } as any;
    },
  };
  const jobs = {
    async claimExternalOperation(input: { claimOwner: string }) {
      if (operation.state === "planned") {
        claimOwner = input.claimOwner;
        operation = { ...operation, state: "in_flight", acquired: true, busy: false,
          claimToken: "e6000000-0000-4000-8000-000000000001",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1 };
        return { ...operation };
      }
      return { ...operation, acquired: false, busy: operation.state === "in_flight", claimToken: null };
    },
    async finishExternalOperationClaim(input: {
      claimOwner: string; claimToken: string; state: ExternalOperationClaimResult["state"];
      externalReference?: string | null;
    }) {
      if (input.claimOwner !== claimOwner || input.claimToken !== operation.claimToken || operation.state !== "in_flight") {
        return { ...operation, finished: false, stale: true };
      }
      operation = { ...operation, state: input.state,
        externalReference: input.externalReference ?? operation.externalReference,
        acquired: false, busy: false, claimToken: null, leaseExpiresAt: null };
      return { ...operation, finished: true, stale: false };
    },
  };
  const provider = {
    providerKey: "twilio" as const, idempotencySemantics: "none" as const,
    async send() { providerCalls += 1; throw new TwilioMessagingOutcomeUnknownError(); },
  };
  const handler = createReminderDeliveryHandler({
    activation: { enabled: true, paused: false, environment: "production", mode: "live",
      publicOrigin: "https://civya.example", twilioWebhookUrl: "https://civya.example/api/webhooks/twilio" },
    reminders, jobs: jobs as any, provider,
  });
  const first = await handler(job(prepared), { signal: new AbortController().signal, workerId: "test" });
  assert.equal(first.status, "failed_unknown");
  assert.equal(providerCalls, 1);
  assert.equal(operation.state, "failed_unknown");
  const second = await handler(job(prepared), { signal: new AbortController().signal, workerId: "test" });
  assert.equal(second.blindRetryPrevented, true);
  assert.equal(providerCalls, 1);
  assert.deepEqual(outcomes, ["failed_unknown", "failed_unknown"]);
  pass("an ambiguous crash-after-provider result becomes failed_unknown and is never blindly sent twice");
}

async function testConcurrentHandlersCallProviderOnce() {
  const prepared = preparedReminder();
  const operationId = "e5000000-0000-4000-8000-000000000002";
  const claimToken = "e6000000-0000-4000-8000-000000000002";
  let state: ExternalOperationClaimResult["state"] = "planned";
  let owner = "";
  let providerCalls = 0;
  const outcomes: string[] = [];
  const reminders = {
    async prepareDelivery() { return prepared; },
    async markDeliveryOutcome(input: { outcome: string }) {
      outcomes.push(input.outcome);
      return { reminderId: prepared.reminderId, deliveryId: prepared.deliveryId,
        status: input.outcome, duplicate: false } as any;
    },
  };
  const jobs = {
    async claimExternalOperation(input: { claimOwner: string }) {
      // Yield so both handlers reach the same atomic-claim boundary before
      // either proceeds to the non-idempotent provider call.
      await Promise.resolve();
      if (state === "planned") {
        state = "in_flight";
        owner = input.claimOwner;
        return { id: operationId, state, externalReference: null, duplicate: false,
          acquired: true, busy: false, claimToken,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1 };
      }
      return { id: operationId, state, externalReference: null, duplicate: true,
        acquired: false, busy: state === "in_flight", claimToken: null,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1 };
    },
    async finishExternalOperationClaim(input: {
      claimOwner: string; claimToken: string; state: ExternalOperationClaimResult["state"];
      externalReference?: string | null;
    }) {
      assert.equal(input.claimOwner, owner);
      assert.equal(input.claimToken, claimToken);
      assert.equal(state, "in_flight");
      state = input.state;
      return { id: operationId, state, externalReference: input.externalReference ?? null,
        finished: true, stale: false };
    },
  };
  const provider = {
    providerKey: "twilio" as const, idempotencySemantics: "none" as const,
    async send() {
      providerCalls += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { providerReferenceDigest: "f".repeat(64), status: "queued" };
    },
  };
  const handler = createReminderDeliveryHandler({
    activation: { enabled: true, paused: false, environment: "production", mode: "live",
      publicOrigin: "https://civya.example", twilioWebhookUrl: "https://civya.example/api/webhooks/twilio" },
    reminders, jobs: jobs as any, provider,
  });
  const [left, right] = await Promise.all([
    handler(job(prepared), { signal: new AbortController().signal, workerId: "worker-left" }),
    handler(job(prepared), { signal: new AbortController().signal, workerId: "worker-right" }),
  ]);
  assert.equal(providerCalls, 1, "Concurrent reminder handlers both called Twilio.");
  assert.equal(state, "succeeded");
  assert.deepEqual(outcomes, ["accepted"]);
  assert.equal([left, right].filter((result) => result.providerCalled === true).length, 1);
  const excluded = [left, right].find((result) => result.concurrentClaim === true);
  assert.ok(excluded);
  assert.equal(excluded.providerCalled, false);
  assert.equal(excluded.blindRetryPrevented, true);
  pass("two concurrent reminder handlers share one fenced claim and call Twilio exactly once");
}

async function testStaleReminderOwnerCannotFinalizeOrResend() {
  const prepared = preparedReminder();
  const operationId = "e5000000-0000-4000-8000-000000000003";
  let state: ExternalOperationClaimResult["state"] = "planned";
  let providerCalls = 0;
  const outcomes: string[] = [];
  const reminders = {
    async prepareDelivery() { return prepared; },
    async markDeliveryOutcome(input: { outcome: string }) {
      outcomes.push(input.outcome);
      return { reminderId: prepared.reminderId, deliveryId: prepared.deliveryId,
        status: input.outcome, duplicate: false } as any;
    },
  };
  const jobs = {
    async claimExternalOperation() {
      if (state === "planned") {
        state = "in_flight";
        return { id: operationId, state, externalReference: null, duplicate: false,
          acquired: true, busy: false, claimToken: "e6000000-0000-4000-8000-000000000003",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1 };
      }
      return { id: operationId, state, externalReference: null, duplicate: true,
        acquired: false, busy: false, claimToken: null, leaseExpiresAt: null,
        attempt: 1, reconciliationRequired: true };
    },
    async finishExternalOperationClaim() {
      state = "failed_unknown";
      return { id: operationId, state, externalReference: null,
        finished: false, stale: true, reconciliationRequired: true };
    },
  };
  const provider = {
    providerKey: "twilio" as const, idempotencySemantics: "none" as const,
    async send() {
      providerCalls += 1;
      return { providerReferenceDigest: "a".repeat(64), status: "queued" };
    },
  };
  const handler = createReminderDeliveryHandler({
    activation: { enabled: true, paused: false, environment: "production", mode: "live",
      publicOrigin: "https://civya.example", twilioWebhookUrl: "https://civya.example/api/webhooks/twilio" },
    reminders, jobs: jobs as any, provider,
  });
  const first = await handler(job(prepared), { signal: new AbortController().signal, workerId: "stale-owner" });
  assert.equal(first.status, "failed_unknown");
  assert.equal(first.staleOwnerFenced, true);
  assert.equal(providerCalls, 1);
  const second = await handler(job(prepared), { signal: new AbortController().signal, workerId: "new-owner" });
  assert.equal(second.blindRetryPrevented, true);
  assert.equal(providerCalls, 1);
  assert.deepEqual(outcomes, ["failed_unknown", "failed_unknown"]);
  pass("an expired reminder owner is fenced after the provider boundary and the unknown outcome is never resent");
}

async function testStaticContracts() {
  const migration = await readFile(join(MIGRATIONS, "202607160021_durable_entitled_reminders.sql"), "utf8");
  assert.match(migration, /private\.outbox_events/);
  assert.match(migration, /external_operations/);
  assert.match(migration, /provider_acceptance_not_delivery/);
  const worker = await readFile(join(ROOT, "lib/reminders/worker-operation.ts"), "utf8");
  assert.match(worker, /idempotencySemantics: "none"/);
  assert.match(worker, /claimExternalOperation/);
  assert.match(worker, /finishExternalOperationClaim/);
  assert.doesNotMatch(worker, /reserveExternalOperation/);
  assert.match(worker, /blindRetryPrevented/);
  assert.doesNotMatch(worker.match(/payloadSchema[\s\S]*?\.strict\(\)/)?.[0] ?? "", /phone|email|destination/i);
  pass("static contracts keep contact out of jobs and distinguish acceptance from delivery");
}

async function main() {
  console.log("Durable entitled reminder boundary");
  await prepareDatabase();
  await seed();
  await testSchedulingAndIdempotency();
  await testRevocationAndSuppression();
  await testQuietHours();
  await testReceiptReplayAndOrdering();
  await testConcurrentHandlersCallProviderOnce();
  await testStaleReminderOwnerCannotFinalizeOrResend();
  await testCrashAfterProviderBoundary();
  await testStaticContracts();
  console.log("\nAll durable reminder boundary tests passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
