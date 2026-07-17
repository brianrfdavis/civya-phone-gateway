import { z } from "zod";
import type { JobEnvelope } from "./contracts";
import type { JobHandler } from "@/workers/runtime";
import { TerminalJobError } from "@/workers/runtime";

export const OUTBOX_DISPATCH_JOB = "foundation.outbox.dispatch";

const outboxDispatchPayloadSchema = z.object({
  limit: z.number().int().min(1).max(1_000).default(100),
}).strict();

export interface OutboxDispatchActivation {
  enabled: boolean;
  paused: boolean;
}

export interface OutboxDispatchStore {
  dispatchOutbox(limit?: number): Promise<JobEnvelope[]>;
}

/**
 * Converts committed transactional-outbox rows into leased jobs. It returns
 * aggregate metadata only, so source event payloads are never copied into the
 * dispatch job result or worker logs.
 */
export function createOutboxDispatchHandler(input: {
  activation: OutboxDispatchActivation;
  store: OutboxDispatchStore;
}): JobHandler {
  return async (job) => {
    if (input.activation.paused || !input.activation.enabled) {
      throw new TerminalJobError(
        "outbox_dispatch_inactive",
        "Transactional outbox dispatch is not activated for this release.",
      );
    }
    const payload = outboxDispatchPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new TerminalJobError(
        "outbox_dispatch_job_invalid",
        "The outbox dispatch job did not match the approved redacted contract.",
      );
    }
    const dispatched = await input.store.dispatchOutbox(payload.data.limit);
    return {
      dispatchedCount: dispatched.length,
      requestedLimit: payload.data.limit,
      payloadsPersistedInResult: false,
    };
  };
}
