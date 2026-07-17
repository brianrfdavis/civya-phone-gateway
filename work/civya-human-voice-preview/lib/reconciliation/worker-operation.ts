import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AdvanceReconciliationCheckpointInput,
  AdvanceReconciliationCheckpointResult,
  ReconciliationCheckpoint,
} from "@/lib/jobs";
import type { JobHandler } from "@/workers/runtime";
import { RetryableJobError, TerminalJobError } from "@/workers/runtime";

export const PROVIDER_RECONCILIATION_JOB = "provider.reconciliation.execute";

export type ReconciliationAdapterMode = "synthetic" | "live";

export interface ReconciliationActivation {
  enabled: boolean;
  paused: boolean;
  environment: "development" | "test" | "staging" | "production";
  mode: "disabled" | ReconciliationAdapterMode;
  /** Presence check only. Secrets remain inside the selected adapter. */
  credentialsConfigured: boolean;
}

const reconciliationPayloadSchema = z.object({
  providerKey: z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/),
  streamKey: z.string().regex(/^[a-z][a-z0-9_.-]{1,119}$/),
  runId: z.string().uuid(),
}).strict();

const adapterResultSchema = z.object({
  result: z.enum(["succeeded", "degraded", "failed"]),
  cursorDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  throughAt: z.string().datetime().nullable(),
  recordsExamined: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  discrepanciesFound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  errorCode: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/).nullable(),
  outcomeCode: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
}).strict();

export type ReconciliationAdapterResult = z.infer<typeof adapterResultSchema>;

export interface ReconciliationAdapterRequest {
  tenantId: string;
  streamKey: string;
  runId: string;
  checkpoint: Pick<ReconciliationCheckpoint, "cursorDigest" | "throughAt" | "rowVersion"> | null;
  signal: AbortSignal;
}

/** Live adapters are provider-specific and must own credentials and cursors. */
export interface ProviderReconciliationAdapter {
  readonly providerKey: string;
  readonly mode: ReconciliationAdapterMode;
  readonly release: string;
  reconcile(request: ReconciliationAdapterRequest): Promise<unknown>;
}

export interface ReconciliationCheckpointStore {
  getReconciliationCheckpoint(
    tenantId: string,
    providerKey: string,
    streamKey: string,
  ): Promise<ReconciliationCheckpoint | null>;
  advanceReconciliationCheckpoint(
    input: AdvanceReconciliationCheckpointInput,
  ): Promise<AdvanceReconciliationCheckpointResult>;
}

export function createProviderReconciliationHandler(input: {
  activation: ReconciliationActivation;
  adapters: ReadonlyMap<string, ProviderReconciliationAdapter>;
  store: ReconciliationCheckpointStore;
}): JobHandler {
  return async (job, context) => {
    const payload = reconciliationPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new TerminalJobError(
        "reconciliation_job_invalid",
        "The reconciliation job did not match the approved redacted contract.",
      );
    }
    const adapter = input.adapters.get(payload.data.providerKey);
    assertReconciliationActive(input.activation, payload.data.providerKey, adapter);
    const checkpoint = await input.store.getReconciliationCheckpoint(
      job.tenantId,
      payload.data.providerKey,
      payload.data.streamKey,
    );
    if (checkpoint?.status === "running" && checkpoint.lastRunId !== payload.data.runId) {
      throw new RetryableJobError(
        "reconciliation_run_in_progress",
        "Another reconciliation run currently owns this checkpoint.",
        30,
      );
    }

    const startedSummary = safeSummary(adapter, "started");
    const started = await input.store.advanceReconciliationCheckpoint({
      tenantId: job.tenantId,
      providerKey: payload.data.providerKey,
      streamKey: payload.data.streamKey,
      expectedRowVersion: checkpoint?.rowVersion ?? 1,
      runId: payload.data.runId,
      result: "started",
      cursorDigest: checkpoint?.cursorDigest ?? null,
      throughAt: checkpoint?.throughAt ?? null,
      summarySha256: digestSummary(startedSummary),
      redactedSummary: startedSummary,
    });
    if (started.duplicate && started.status !== "running") {
      return {
        checkpointId: started.checkpointId,
        status: started.status,
        runId: payload.data.runId,
        duplicate: true,
      };
    }

    let result: ReconciliationAdapterResult;
    try {
      const rawResult = await adapter!.reconcile({
        tenantId: job.tenantId,
        streamKey: payload.data.streamKey,
        runId: payload.data.runId,
        checkpoint: checkpoint
          ? {
              cursorDigest: checkpoint.cursorDigest,
              throughAt: checkpoint.throughAt,
              rowVersion: checkpoint.rowVersion,
            }
          : null,
        signal: context.signal,
      });
      const parsedResult = adapterResultSchema.safeParse(rawResult);
      if (!parsedResult.success) {
        throw new TerminalJobError(
          "reconciliation_result_invalid",
          "The provider reconciliation adapter returned an invalid redacted result.",
        );
      }
      result = parsedResult.data;
      validateAdapterResult(result, checkpoint);
    } catch (error) {
      if (error instanceof TerminalJobError) {
        await recordAdapterFailure(input.store, job.tenantId, payload.data, adapter!, started.rowVersion, error.code);
        throw error;
      }
      await recordAdapterFailure(
        input.store,
        job.tenantId,
        payload.data,
        adapter!,
        started.rowVersion,
        "provider_reconciliation_unavailable",
      );
      throw new TerminalJobError(
        "provider_reconciliation_unavailable",
        "The provider reconciliation run failed; a redacted checkpoint was recorded.",
      );
    }

    const completedSummary = safeSummary(adapter!, result.outcomeCode);
    const completed = await input.store.advanceReconciliationCheckpoint({
      tenantId: job.tenantId,
      providerKey: payload.data.providerKey,
      streamKey: payload.data.streamKey,
      expectedRowVersion: started.rowVersion,
      runId: payload.data.runId,
      result: result.result,
      cursorDigest: result.cursorDigest,
      throughAt: result.throughAt,
      recordsExamined: result.recordsExamined,
      discrepanciesFound: result.discrepanciesFound,
      errorCode: result.errorCode,
      summarySha256: digestSummary(completedSummary),
      redactedSummary: completedSummary,
    });
    return {
      checkpointId: completed.checkpointId,
      status: completed.status,
      runId: payload.data.runId,
      recordsExamined: result.recordsExamined,
      discrepanciesFound: result.discrepanciesFound,
      duplicate: completed.duplicate,
    };
  };
}

export class SyntheticReconciliationAdapter implements ProviderReconciliationAdapter {
  readonly mode = "synthetic" as const;

  constructor(
    readonly providerKey: string,
    readonly release = "synthetic-reconciliation-v1",
    private readonly now: () => number = () => Date.now(),
  ) {}

  async reconcile(request: ReconciliationAdapterRequest): Promise<ReconciliationAdapterResult> {
    if (request.signal.aborted) throw new Error("operation_aborted");
    return {
      result: "succeeded",
      cursorDigest: createHash("sha256")
        .update(`synthetic-reconciliation:${this.providerKey}:${request.streamKey}:${request.runId}`)
        .digest("hex"),
      throughAt: new Date(this.now()).toISOString(),
      recordsExamined: 0,
      discrepanciesFound: 0,
      errorCode: null,
      outcomeCode: "synthetic_clean",
    };
  }
}

function assertReconciliationActive(
  activation: ReconciliationActivation,
  expectedProviderKey: string,
  adapter: ProviderReconciliationAdapter | undefined,
): asserts adapter is ProviderReconciliationAdapter {
  if (activation.paused || !activation.enabled || activation.mode === "disabled") {
    throw new TerminalJobError(
      "reconciliation_inactive",
      "Provider reconciliation is not activated for this release.",
    );
  }
  if (!adapter) {
    throw new TerminalJobError(
      "reconciliation_adapter_missing",
      "No approved reconciliation adapter is registered for this provider.",
    );
  }
  if (activation.environment === "production" && activation.mode !== "live") {
    throw new TerminalJobError(
      "reconciliation_production_mode_invalid",
      "Production reconciliation requires a live approved provider adapter.",
    );
  }
  if (activation.mode === "live" && !activation.credentialsConfigured) {
    throw new TerminalJobError(
      "reconciliation_credentials_missing",
      "The live reconciliation adapter is missing approved credentials or endpoint configuration.",
    );
  }
  if (adapter.mode !== activation.mode) {
    throw new TerminalJobError(
      "reconciliation_adapter_mismatch",
      "The reconciliation adapter does not match the activated mode.",
    );
  }
  if (adapter.providerKey !== expectedProviderKey) {
    throw new TerminalJobError(
      "reconciliation_provider_mismatch",
      "The reconciliation adapter does not match the requested provider.",
    );
  }
}

function validateAdapterResult(
  result: ReconciliationAdapterResult,
  checkpoint: ReconciliationCheckpoint | null,
): void {
  if (result.discrepanciesFound > result.recordsExamined) {
    throw new TerminalJobError(
      "reconciliation_counts_invalid",
      "The reconciliation adapter returned inconsistent aggregate counts.",
    );
  }
  if (result.result !== "failed" && (!result.cursorDigest || !result.throughAt)) {
    throw new TerminalJobError(
      "reconciliation_checkpoint_incomplete",
      "A successful reconciliation result requires a digest and completion timestamp.",
    );
  }
  if (result.result === "failed" && !result.errorCode) {
    throw new TerminalJobError(
      "reconciliation_failure_unclassified",
      "A failed reconciliation result requires a redacted error code.",
    );
  }
  if (result.result === "failed" && (result.cursorDigest !== null || result.throughAt !== null)) {
    throw new TerminalJobError(
      "reconciliation_failure_checkpoint_invalid",
      "A failed reconciliation result cannot advance the provider checkpoint.",
    );
  }
  if (result.throughAt && checkpoint?.throughAt
      && Date.parse(result.throughAt) < Date.parse(checkpoint.throughAt)) {
    throw new TerminalJobError(
      "reconciliation_checkpoint_regression",
      "The reconciliation adapter attempted to move a checkpoint backward.",
    );
  }
}

async function recordAdapterFailure(
  store: ReconciliationCheckpointStore,
  tenantId: string,
  payload: z.infer<typeof reconciliationPayloadSchema>,
  adapter: ProviderReconciliationAdapter,
  expectedRowVersion: number,
  errorCode: string,
): Promise<void> {
  const summary = safeSummary(adapter, "adapter_failed");
  await store.advanceReconciliationCheckpoint({
    tenantId,
    providerKey: payload.providerKey,
    streamKey: payload.streamKey,
    expectedRowVersion,
    runId: payload.runId,
    result: "failed",
    recordsExamined: 0,
    discrepanciesFound: 0,
    errorCode,
    summarySha256: digestSummary(summary),
    redactedSummary: summary,
  });
}

function safeSummary(
  adapter: ProviderReconciliationAdapter,
  outcomeCode: string,
): Record<string, string | number | boolean | null> {
  return {
    adapterMode: adapter.mode,
    adapterRelease: /^[A-Za-z0-9._-]{1,80}$/.test(adapter.release)
      ? adapter.release
      : "unregistered_release",
    outcomeCode,
  };
}

function digestSummary(summary: Record<string, string | number | boolean | null>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(summary).sort(([left], [right]) => left.localeCompare(right))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}
