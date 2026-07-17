import { z } from "zod";
import type { JobHandler } from "@/workers/runtime";
import { RetryableJobError, TerminalJobError } from "@/workers/runtime";
import {
  CountyBatchValidationError,
  type CountySourceBatch,
  type ValidatedCountyBatch,
  validateCountyBatch,
} from "./contracts";

export const COUNTY_SOURCE_INGEST_JOB = "county.source.batch.ingest";
export const COUNTY_SOURCE_PROMOTION_REQUEST_JOB = "county.source.promotion.request";

export type CountySourceMode = "disabled" | "synthetic" | "live";

export interface CountySourceActivation {
  enabled: boolean;
  paused: boolean;
  environment: "development" | "test" | "staging" | "production";
  mode: CountySourceMode;
  /** Presence check only. Credentials themselves must remain in the adapter. */
  credentialsConfigured: boolean;
}

const sourceIngestPayloadSchema = z.object({
  tenantSlug: z.string().regex(/^[a-z0-9-]+$/),
  sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/),
  externalBatchId: z.string().min(1).max(200),
  schemaVersion: z.string().min(1).max(80),
  contractVersion: z.string().min(1).max(80),
  sourceGeneratedAt: z.string().datetime(),
  expectedRecordCount: z.number().int().nonnegative().max(200_000),
  expectedControlTotal: z.string().regex(/^[0-9a-f]{64}$/),
  transportReferenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  requestReference: z.string().regex(/^source_request_[A-Za-z0-9_-]{8,120}$/),
}).strict();

const promotionRequestPayloadSchema = z.object({
  sourceBatchId: z.string().uuid(),
  validationId: z.string().uuid(),
  sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
  requestedAssuranceScope: z.enum(["county_attested", "provider_attested"]),
}).strict();

const governedStageResultSchema = z.object({
  batchId: z.string().uuid(),
  validationId: z.string().uuid(),
  state: z.enum(["quarantined", "requires_review"]),
  duplicate: z.boolean(),
}).strict();

const governedPromotionResultSchema = z.object({
  requestId: z.string().uuid(),
  state: z.enum(["pending_review", "quarantined", "rejected"]),
  duplicate: z.boolean(),
}).strict();

export type CountySourceIngestPayload = z.infer<typeof sourceIngestPayloadSchema>;
export type CountySourcePromotionRequestPayload = z.infer<typeof promotionRequestPayloadSchema>;

export interface CountySourceFetchRequest {
  tenantId: string;
  sourceKey: string;
  externalBatchId: string;
  requestReference: string;
  transportReferenceDigest: string;
  signal: AbortSignal;
}

/**
 * Boundary for a County-approved transport. A live implementation must own its
 * authentication details and return an in-memory batch; job payloads contain
 * only opaque references and digests, never County records.
 */
export interface CountySourceAdapter {
  readonly mode: Exclude<CountySourceMode, "disabled">;
  fetchBatch(request: CountySourceFetchRequest): Promise<unknown>;
}

export interface GovernedSourceStageResult {
  batchId: string;
  validationId: string;
  state: "quarantined" | "requires_review";
  duplicate: boolean;
}

export interface GovernedPromotionRequestResult {
  requestId: string;
  state: "pending_review" | "quarantined" | "rejected";
  duplicate: boolean;
}

/**
 * Persistence boundary for a future service-only atomic source-governance RPC.
 * The current schema intentionally revokes direct service-role writes to the
 * validation and promotion tables, so no production implementation is faked.
 */
export interface CountySourceGovernanceStore {
  readonly durable: boolean;
  stageValidatedBatch(input: {
    tenantId: string;
    jobId: string;
    idempotencyKey: string;
    contractVersion: string;
    transportReferenceDigest: string;
    validatedBatch: ValidatedCountyBatch;
  }): Promise<GovernedSourceStageResult>;
  requestPromotion(input: {
    tenantId: string;
    jobId: string;
    idempotencyKey: string;
    sourceBatchId: string;
    validationId: string;
    sourceKey: string;
    reasonCode: string;
    requestedAssuranceScope: "county_attested" | "provider_attested";
  }): Promise<GovernedPromotionRequestResult>;
}

export function createCountySourceIngestHandler(input: {
  activation: CountySourceActivation;
  adapter: CountySourceAdapter;
  governance: CountySourceGovernanceStore;
}): JobHandler {
  return async (job, context) => {
    assertCountySourceActive(input.activation, input.adapter, input.governance);
    const parsed = sourceIngestPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new TerminalJobError(
        "county_source_job_invalid",
        "The County source job did not match the approved redacted contract.",
      );
    }
    const request = parsed.data;
    let validated: ValidatedCountyBatch;
    try {
      const batch = await input.adapter.fetchBatch({
        tenantId: job.tenantId,
        sourceKey: request.sourceKey,
        externalBatchId: request.externalBatchId,
        requestReference: request.requestReference,
        transportReferenceDigest: request.transportReferenceDigest,
        signal: context.signal,
      });
      validated = validateCountyBatch(batch);
    } catch (error) {
      if (error instanceof CountyBatchValidationError) {
        throw new TerminalJobError(error.code, "The County source batch failed governed validation.");
      }
      throw new RetryableJobError(
        "county_source_fetch_failed",
        "The County source batch could not be obtained through the approved transport.",
        60,
      );
    }
    assertBatchMatchesRequest(request, validated.batch);
    const rawStaged = await input.governance.stageValidatedBatch({
      tenantId: job.tenantId,
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      contractVersion: request.contractVersion,
      transportReferenceDigest: request.transportReferenceDigest,
      validatedBatch: validated,
    });
    const staged = governedStageResultSchema.safeParse(rawStaged);
    if (!staged.success) {
      throw new TerminalJobError(
        "county_source_stage_unsafe",
        "The County source store returned an unsafe pre-promotion state.",
      );
    }
    return {
      sourceKey: request.sourceKey,
      batchId: staged.data.batchId,
      validationId: staged.data.validationId,
      state: staged.data.state,
      recordCount: validated.recordCount,
      controlTotal: validated.computedControlTotal,
      duplicate: staged.data.duplicate,
    };
  };
}

export function createCountySourcePromotionRequestHandler(input: {
  activation: CountySourceActivation;
  adapter: CountySourceAdapter;
  governance: CountySourceGovernanceStore;
}): JobHandler {
  return async (job) => {
    assertCountySourceActive(input.activation, input.adapter, input.governance);
    const parsed = promotionRequestPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new TerminalJobError(
        "county_source_promotion_job_invalid",
        "The County source promotion request did not match the approved redacted contract.",
      );
    }
    const request = parsed.data;
    const rawResult = await input.governance.requestPromotion({
      tenantId: job.tenantId,
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      sourceBatchId: request.sourceBatchId,
      validationId: request.validationId,
      sourceKey: request.sourceKey,
      reasonCode: request.reasonCode,
      requestedAssuranceScope: request.requestedAssuranceScope,
    });
    const result = governedPromotionResultSchema.safeParse(rawResult);
    if (!result.success) {
      throw new TerminalJobError(
        "county_source_promotion_result_unsafe",
        "The County source store returned an unsafe promotion-request state.",
      );
    }
    return {
      requestId: result.data.requestId,
      state: result.data.state,
      sourceKey: request.sourceKey,
      duplicate: result.data.duplicate,
    };
  };
}

/** Test/local adapter only; it performs no network calls and stores no state. */
export class SyntheticCountySourceAdapter implements CountySourceAdapter {
  readonly mode = "synthetic" as const;

  constructor(private readonly batches: ReadonlyMap<string, CountySourceBatch>) {}

  async fetchBatch(request: CountySourceFetchRequest): Promise<unknown> {
    if (request.signal.aborted) throw new Error("operation_aborted");
    const batch = this.batches.get(request.requestReference);
    if (!batch) throw new Error("synthetic_batch_missing");
    return structuredClone(batch);
  }
}

function assertCountySourceActive(
  activation: CountySourceActivation,
  adapter: CountySourceAdapter,
  governance: CountySourceGovernanceStore,
): void {
  if (activation.paused || !activation.enabled || activation.mode === "disabled") {
    throw new TerminalJobError(
      "county_source_inactive",
      "County source processing is not activated for this release.",
    );
  }
  if (!governance.durable) {
    throw new TerminalJobError(
      "county_source_store_not_durable",
      "County source processing requires the approved durable governance store.",
    );
  }
  if (activation.environment === "production" && activation.mode !== "live") {
    throw new TerminalJobError(
      "county_source_production_mode_invalid",
      "Production County source processing requires a live approved adapter.",
    );
  }
  if (activation.mode === "live" && !activation.credentialsConfigured) {
    throw new TerminalJobError(
      "county_source_credentials_missing",
      "The live County source adapter is missing approved credentials or endpoint configuration.",
    );
  }
  if (adapter.mode !== activation.mode) {
    throw new TerminalJobError(
      "county_source_adapter_mismatch",
      "The configured County source adapter does not match the activated mode.",
    );
  }
}

function assertBatchMatchesRequest(request: CountySourceIngestPayload, batch: CountySourceBatch): void {
  const mismatch = batch.tenantSlug !== request.tenantSlug
    || batch.sourceKey !== request.sourceKey
    || batch.externalBatchId !== request.externalBatchId
    || batch.schemaVersion !== request.schemaVersion
    || batch.sourceGeneratedAt !== request.sourceGeneratedAt
    || batch.declaredRecordCount !== request.expectedRecordCount
    || batch.declaredControlTotal !== request.expectedControlTotal;
  if (mismatch) {
    throw new TerminalJobError(
      "county_source_request_mismatch",
      "The received County source batch did not match its governed request envelope.",
    );
  }
}
