import type { JobEnvelope, JobFailure, JobHealth } from "@/lib/jobs";
import { FoundationJobClient } from "@/lib/jobs";

export type JobResult = Record<string, unknown>;

export interface JobHandlerContext {
  signal: AbortSignal;
  workerId: string;
}

export type JobHandler = (job: JobEnvelope, context: JobHandlerContext) => Promise<JobResult>;

export class RetryableJobError extends Error {
  constructor(
    readonly code: string,
    readonly redactedMessage: string,
    readonly retryDelaySeconds = 30,
  ) {
    super(redactedMessage);
    this.name = "RetryableJobError";
  }
}

export class TerminalJobError extends Error {
  constructor(readonly code: string, readonly redactedMessage: string) {
    super(redactedMessage);
    this.name = "TerminalJobError";
  }
}

export interface FoundationWorkerOptions {
  workerId: string;
  capabilities: string[];
  concurrency: number;
  leaseSeconds: number;
  pollIntervalMs: number;
}

export interface WorkerHealthSnapshot {
  live: boolean;
  ready: boolean;
  workerId: string;
  capabilities: string[];
  activeJobs: number;
  processedJobs: number;
  failedJobs: number;
  lastPollAt: string | null;
  lastSuccessfulStoreCheckAt: string | null;
  store: JobHealth | null;
}

/**
 * Stateless executor. Leases, retries, attempts, deadlines, and idempotency all
 * live in Postgres; process memory contains only disposable health counters.
 */
export class FoundationWorker {
  private running = false;
  private activeJobs = 0;
  private processedJobs = 0;
  private failedJobs = 0;
  private lastPollAt: string | null = null;
  private lastSuccessfulStoreCheckAt: string | null = null;
  private storeHealth: JobHealth | null = null;

  constructor(
    private readonly jobs: FoundationJobClient,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly options: FoundationWorkerOptions,
  ) {
    if (options.capabilities.length === 0) throw new Error("At least one worker capability is required.");
    const missing = options.capabilities.filter((capability) => !handlers.has(capability));
    if (missing.length > 0) throw new Error(`No handler registered for: ${missing.join(", ")}`);
  }

  snapshot(): WorkerHealthSnapshot {
    const storeIsCurrent = this.lastSuccessfulStoreCheckAt !== null
      && Date.now() - Date.parse(this.lastSuccessfulStoreCheckAt) < Math.max(this.options.pollIntervalMs * 5, 30_000);
    return {
      live: this.running,
      ready: this.running && storeIsCurrent,
      workerId: this.options.workerId,
      capabilities: [...this.options.capabilities],
      activeJobs: this.activeJobs,
      processedJobs: this.processedJobs,
      failedJobs: this.failedJobs,
      lastPollAt: this.lastPollAt,
      lastSuccessfulStoreCheckAt: this.lastSuccessfulStoreCheckAt,
      store: this.storeHealth,
    };
  }

  async start(signal: AbortSignal): Promise<void> {
    this.running = true;
    try {
      while (!signal.aborted) {
        await this.poll(signal);
        await waitFor(this.options.pollIntervalMs, signal);
      }
    } finally {
      this.running = false;
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    this.lastPollAt = new Date().toISOString();
    try {
      this.storeHealth = await this.jobs.health();
      this.lastSuccessfulStoreCheckAt = new Date().toISOString();
      const available = Math.max(0, this.options.concurrency - this.activeJobs);
      if (available === 0 || signal.aborted) return;
      const claimed = await this.jobs.claim(
        this.options.workerId,
        this.options.capabilities,
        available,
        this.options.leaseSeconds,
      );
      await Promise.allSettled(claimed.map((job) => this.execute(job, signal)));
    } catch {
      // Store errors affect readiness. Do not log payloads or raw provider errors.
      this.storeHealth = null;
    }
  }

  private async execute(job: JobEnvelope, parentSignal: AbortSignal): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) return;
    this.activeJobs += 1;
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort("job_timeout"), job.timeoutSeconds * 1000);
    const heartbeat = setInterval(() => {
      void this.jobs.heartbeat(job.id, this.options.workerId, this.options.leaseSeconds).then((renewed) => {
        if (!renewed) controller.abort("lease_lost");
      }).catch(() => controller.abort("heartbeat_failed"));
    }, Math.max(5_000, Math.floor(this.options.leaseSeconds * 1000 / 3)));

    try {
      const result = await raceWithAbort(
        handler(job, { signal: controller.signal, workerId: this.options.workerId }),
        controller.signal,
      );
      if (controller.signal.aborted) {
        throw new RetryableJobError("worker_interrupted", "The worker was interrupted before completion.", 15);
      }
      await this.jobs.complete(job.id, this.options.workerId, result);
      this.processedJobs += 1;
    } catch (error) {
      this.failedJobs += 1;
      const failure = normalizeFailure(error);
      try {
        await this.jobs.fail(job.id, this.options.workerId, failure);
      } catch {
        // A lost lease is resolved by the database lease-expiry path.
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abort);
      this.activeJobs -= 1;
    }
  }
}

function normalizeFailure(error: unknown): JobFailure {
  if (error instanceof RetryableJobError) {
    return {
      retryable: true,
      code: error.code,
      redactedMessage: error.redactedMessage,
      retryDelaySeconds: error.retryDelaySeconds,
    };
  }
  if (error instanceof TerminalJobError) {
    return { retryable: false, code: error.code, redactedMessage: error.redactedMessage };
  }
  return {
    retryable: true,
    code: "unhandled_worker_error",
    redactedMessage: "The worker encountered an unclassified error.",
    retryDelaySeconds: 30,
  };
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function raceWithAbort<Result>(operation: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new RetryableJobError("worker_interrupted", "The worker was interrupted before completion.", 15));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
