import assert from "node:assert/strict";
import {
  computeCountyBatchControlTotal,
  type CountySourceBatch,
} from "@/lib/source/contracts";
import {
  createCountySourceIngestHandler,
  createCountySourcePromotionRequestHandler,
  SyntheticCountySourceAdapter,
  type CountySourceGovernanceStore,
} from "@/lib/source/worker-operations";
import {
  createProviderReconciliationHandler,
  SyntheticReconciliationAdapter,
  type ProviderReconciliationAdapter,
  type ReconciliationCheckpointStore,
} from "@/lib/reconciliation/worker-operation";
import { createOutboxDispatchHandler } from "@/lib/jobs/worker-operations";
import type {
  AdvanceReconciliationCheckpointInput,
  JobEnvelope,
  ReconciliationCheckpoint,
} from "@/lib/jobs";
import type { FoundationJobClient } from "@/lib/jobs";
import { TerminalJobError } from "@/workers/runtime";
import {
  createFoundationOperationRegistry,
  WorkerOperationConfigurationError,
} from "@/workers/operations";

const TENANT_ID = "81000000-0000-4000-8000-000000000001";
const JOB_ID = "91000000-0000-4000-8000-000000000001";
const RUN_ID = "92000000-0000-4000-8000-000000000001";
const BATCH_ID = "93000000-0000-4000-8000-000000000001";
const VALIDATION_ID = "94000000-0000-4000-8000-000000000001";
const REQUEST_ID = "95000000-0000-4000-8000-000000000001";

function pass(message: string): void {
  console.log(`  PASS  ${message}`);
}

function envelope(
  type: string,
  payload: Record<string, unknown>,
  idempotencyKey = `${type}:test-1`,
): JobEnvelope {
  return {
    id: JOB_ID,
    tenantId: TENANT_ID,
    type,
    schemaVersion: "1",
    payload,
    idempotencyKey,
    sourceType: "test",
    sourceId: null,
    priority: 0,
    deadlineAt: null,
    state: "leased",
    attempt: 1,
    maxAttempts: 3,
    timeoutSeconds: 30,
    availableAt: "2026-07-16T12:00:00.000Z",
    leaseOwner: "test-worker",
    leaseExpiresAt: "2026-07-16T12:01:00.000Z",
    createdAt: "2026-07-16T12:00:00.000Z",
  };
}

const context = {
  signal: new AbortController().signal,
  workerId: "test-worker",
};

function countyBatch(): CountySourceBatch {
  const records = [{
    externalRecordId: "record-1",
    recordType: "case_status" as const,
    parcelId: "parcel-subject-value",
    taxYear: 2025,
    effectiveAt: "2026-07-16T11:00:00.000Z",
    retracted: false,
    fields: { ownerName: "Sensitive Resident", status: "pending" },
  }];
  return {
    tenantSlug: "wayne-production",
    sourceKey: "wayne_case_status",
    externalBatchId: "county-batch-1",
    schemaVersion: "1",
    sourceGeneratedAt: "2026-07-16T11:30:00.000Z",
    declaredRecordCount: records.length,
    declaredControlTotal: computeCountyBatchControlTotal(records),
    records,
  };
}

class FakeCountyGovernanceStore implements CountySourceGovernanceStore {
  readonly durable = true;
  staged: Parameters<CountySourceGovernanceStore["stageValidatedBatch"]>[0][] = [];
  promotions: Parameters<CountySourceGovernanceStore["requestPromotion"]>[0][] = [];

  async stageValidatedBatch(input: Parameters<CountySourceGovernanceStore["stageValidatedBatch"]>[0]) {
    this.staged.push(input);
    return {
      batchId: BATCH_ID,
      validationId: VALIDATION_ID,
      state: "quarantined" as const,
      duplicate: false,
    };
  }

  async requestPromotion(input: Parameters<CountySourceGovernanceStore["requestPromotion"]>[0]) {
    this.promotions.push(input);
    return { requestId: REQUEST_ID, state: "pending_review" as const, duplicate: false };
  }
}

async function testCountySourceBoundaries(): Promise<void> {
  const batch = countyBatch();
  const requestReference = "source_request_synthetic01";
  const adapter = new SyntheticCountySourceAdapter(new Map([[requestReference, batch]]));
  const governance = new FakeCountyGovernanceStore();
  const activation = {
    enabled: true,
    paused: false,
    environment: "test" as const,
    mode: "synthetic" as const,
    credentialsConfigured: false,
  };
  const handler = createCountySourceIngestHandler({ activation, adapter, governance });
  const payload = {
    tenantSlug: batch.tenantSlug,
    sourceKey: batch.sourceKey,
    externalBatchId: batch.externalBatchId,
    schemaVersion: batch.schemaVersion,
    contractVersion: "county-contract-v1",
    sourceGeneratedAt: batch.sourceGeneratedAt,
    expectedRecordCount: batch.declaredRecordCount,
    expectedControlTotal: batch.declaredControlTotal,
    transportReferenceDigest: "a".repeat(64),
    requestReference,
  };
  const result = await handler(envelope("county.source.batch.ingest", payload), context);
  assert.equal(result.state, "quarantined");
  assert.equal(governance.staged.length, 1);
  assert.equal(governance.staged[0].validatedBatch.batch.records[0].fields.ownerName, "Sensitive Resident");
  assert.doesNotMatch(JSON.stringify(result), /Sensitive Resident|parcel-subject-value|records|fields/);

  await assert.rejects(
    handler(envelope("county.source.batch.ingest", { ...payload, records: batch.records }), context),
    (error) => error instanceof TerminalJobError
      && error.code === "county_source_job_invalid"
      && !error.message.includes("Sensitive Resident"),
  );

  const productionHandler = createCountySourceIngestHandler({
    activation: { ...activation, environment: "production", mode: "synthetic" },
    adapter,
    governance,
  });
  await assert.rejects(
    productionHandler(envelope("county.source.batch.ingest", payload), context),
    (error) => error instanceof TerminalJobError
      && error.code === "county_source_production_mode_invalid",
  );
  assert.equal(governance.staged.length, 1);

  const promotion = createCountySourcePromotionRequestHandler({ activation, adapter, governance });
  const promotionResult = await promotion(envelope("county.source.promotion.request", {
    sourceBatchId: BATCH_ID,
    validationId: VALIDATION_ID,
    sourceKey: batch.sourceKey,
    reasonCode: "controls_passed",
    requestedAssuranceScope: "county_attested",
  }), context);
  assert.equal(promotionResult.state, "pending_review");
  assert.equal(governance.promotions.length, 1);
  assert.notEqual(promotionResult.state, "accepted");
  pass("County jobs carry only opaque references/digests, stage in quarantine, and request rather than self-authorize promotion");
}

class FakeCheckpointStore implements ReconciliationCheckpointStore {
  checkpoint: ReconciliationCheckpoint | null = null;
  advances: AdvanceReconciliationCheckpointInput[] = [];

  async getReconciliationCheckpoint(): Promise<ReconciliationCheckpoint | null> {
    return this.checkpoint ? { ...this.checkpoint } : null;
  }

  async advanceReconciliationCheckpoint(input: AdvanceReconciliationCheckpointInput) {
    this.advances.push(structuredClone(input));
    assert.equal(input.expectedRowVersion, this.checkpoint?.rowVersion ?? 1);
    const status = input.result === "started"
      ? "running" as const
      : input.result === "succeeded"
        ? "healthy" as const
        : input.result;
    this.checkpoint = {
      id: "96000000-0000-4000-8000-000000000001",
      tenantId: input.tenantId,
      providerKey: input.providerKey,
      streamKey: input.streamKey,
      cursorDigest: input.result === "succeeded" || input.result === "degraded"
        ? input.cursorDigest ?? null
        : this.checkpoint?.cursorDigest ?? null,
      throughAt: input.result === "succeeded" || input.result === "degraded"
        ? input.throughAt ?? null
        : this.checkpoint?.throughAt ?? null,
      status,
      lastRunId: input.runId,
      rowVersion: (this.checkpoint?.rowVersion ?? 1) + 1,
    };
    return {
      checkpointId: this.checkpoint.id,
      status: this.checkpoint.status,
      rowVersion: this.checkpoint.rowVersion,
      eventId: `97000000-0000-4000-8000-00000000000${this.advances.length}`,
      duplicate: false,
    };
  }
}

async function testReconciliationExecution(): Promise<void> {
  const store = new FakeCheckpointStore();
  const adapter = new SyntheticReconciliationAdapter(
    "jpmorgan",
    "synthetic-v1",
    () => Date.parse("2026-07-16T12:00:00.000Z"),
  );
  const handler = createProviderReconciliationHandler({
    activation: {
      enabled: true,
      paused: false,
      environment: "test",
      mode: "synthetic",
      credentialsConfigured: false,
    },
    adapters: new Map([[adapter.providerKey, adapter]]),
    store,
  });
  const result = await handler(envelope("provider.reconciliation.execute", {
    providerKey: "jpmorgan",
    streamKey: "hosted_handoffs",
    runId: RUN_ID,
  }), context);
  assert.equal(result.status, "healthy");
  assert.equal(store.advances.length, 2);
  assert.deepEqual(store.advances.map((entry) => entry.result), ["started", "succeeded"]);
  for (const entry of store.advances) {
    assert.deepEqual(Object.keys(entry.redactedSummary).sort(), ["adapterMode", "adapterRelease", "outcomeCode"]);
    assert.match(entry.summarySha256, /^[0-9a-f]{64}$/);
  }
  assert.doesNotMatch(JSON.stringify(store.advances), /credential|token|resident|providerPayload/i);
  pass("reconciliation records started/completed checkpoints with monotonic versions, digests, and fixed-shape summaries");
}

async function testReconciliationFailsClosed(): Promise<void> {
  const store = new FakeCheckpointStore();
  const unsafeAdapter: ProviderReconciliationAdapter = {
    providerKey: "jpmorgan",
    mode: "synthetic",
    release: "unsafe-test",
    async reconcile() {
      return {
        result: "succeeded",
        cursorDigest: "b".repeat(64),
        throughAt: "2026-07-16T12:00:00.000Z",
        recordsExamined: 1,
        discrepanciesFound: 0,
        errorCode: null,
        outcomeCode: "clean",
        providerPayload: { residentName: "Sensitive Resident" },
      };
    },
  };
  const handler = createProviderReconciliationHandler({
    activation: {
      enabled: true,
      paused: false,
      environment: "test",
      mode: "synthetic",
      credentialsConfigured: false,
    },
    adapters: new Map([[unsafeAdapter.providerKey, unsafeAdapter]]),
    store,
  });
  await assert.rejects(
    handler(envelope("provider.reconciliation.execute", {
      providerKey: "jpmorgan",
      streamKey: "hosted_handoffs",
      runId: RUN_ID,
    }), context),
    (error) => error instanceof TerminalJobError
      && error.code === "reconciliation_result_invalid"
      && !error.message.includes("Sensitive Resident"),
  );
  assert.deepEqual(store.advances.map((entry) => entry.result), ["started", "failed"]);
  assert.doesNotMatch(JSON.stringify(store.advances), /Sensitive Resident|providerPayload/);
  pass("unsafe provider results are rejected and recorded only as redacted failure checkpoints");
}

async function testOutboxDispatchRedaction(): Promise<void> {
  const dispatchedJob = envelope("outbox.case.changed", {
    residentName: "Sensitive Resident",
    rawPayload: "must-not-be-returned",
  });
  let receivedLimit = 0;
  const handler = createOutboxDispatchHandler({
    activation: { enabled: true, paused: false },
    store: {
      async dispatchOutbox(limit) {
        receivedLimit = limit ?? 0;
        return [dispatchedJob];
      },
    },
  });
  const result = await handler(envelope("foundation.outbox.dispatch", { limit: 25 }), context);
  assert.equal(receivedLimit, 25);
  assert.deepEqual(result, {
    dispatchedCount: 1,
    requestedLimit: 25,
    payloadsPersistedInResult: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /Sensitive Resident|must-not-be-returned|residentName|rawPayload/);
  await assert.rejects(
    handler(envelope("foundation.outbox.dispatch", { limit: 25, payload: "secret" }), context),
    (error) => error instanceof TerminalJobError && error.code === "outbox_dispatch_job_invalid",
  );
  pass("outbox dispatch persists only aggregate counts in its job result, never dispatched event payloads");
}

function testSafeRuntimeRegistration(): void {
  const fakeJobs = {} as FoundationJobClient;
  const defaultRegistry = createFoundationOperationRegistry(fakeJobs, {
    NODE_ENV: "test",
    CIVYA_ENVIRONMENT: "test",
  });
  assert.deepEqual([...defaultRegistry.handlers.keys()], ["foundation.healthcheck", "foundation.outbox.dispatch"]);

  assert.throws(
    () => createFoundationOperationRegistry(fakeJobs, {
      NODE_ENV: "production",
      CIVYA_ENVIRONMENT: "production",
      CIVYA_ENABLE_COUNTY_SOURCE_WORKER: "true",
      CIVYA_COUNTY_SOURCE_MODE: "live",
    }),
    (error) => error instanceof WorkerOperationConfigurationError
      && error.code === "county_source_live_config_missing",
  );
  assert.throws(
    () => createFoundationOperationRegistry(fakeJobs, {
      NODE_ENV: "production",
      CIVYA_ENVIRONMENT: "production",
      CIVYA_ENABLE_PROVIDER_RECONCILIATION: "true",
      CIVYA_RECONCILIATION_MODE: "live",
    }),
    (error) => error instanceof WorkerOperationConfigurationError
      && error.code === "reconciliation_live_config_missing",
  );
  const syntheticRegistry = createFoundationOperationRegistry(fakeJobs, {
    NODE_ENV: "test",
    CIVYA_ENVIRONMENT: "test",
    CIVYA_ENABLE_PROVIDER_RECONCILIATION: "true",
    CIVYA_RECONCILIATION_MODE: "synthetic",
    CIVYA_RECONCILIATION_PROVIDER_KEY: "jpmorgan",
  });
  assert.equal(syntheticRegistry.handlers.has("provider.reconciliation.execute"), true);
  assert.equal(syntheticRegistry.handlers.has("county.source.batch.ingest"), false);
  pass("runtime registers only durable implemented operations and rejects incomplete live adapter activation");
}

async function main(): Promise<void> {
  console.log("Controlled-launch worker operations");
  await testCountySourceBoundaries();
  await testReconciliationExecution();
  await testReconciliationFailsClosed();
  await testOutboxDispatchRedaction();
  testSafeRuntimeRegistration();
  console.log("\nALL WORKER OPERATION TESTS PASSED");
}

void main();
