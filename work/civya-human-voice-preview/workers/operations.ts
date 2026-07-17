import type { FoundationJobClient } from "@/lib/jobs";
import { createOutboxDispatchHandler, OUTBOX_DISPATCH_JOB } from "@/lib/jobs/worker-operations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { ReminderRepository } from "@/lib/reminders/repository.server";
import {
  createReminderDeliveryHandler,
  LiveTwilioReminderProvider,
  REMINDER_JOB_TYPE,
} from "@/lib/reminders/worker-operation";
import {
  createProviderReconciliationHandler,
  PROVIDER_RECONCILIATION_JOB,
  SyntheticReconciliationAdapter,
  type ReconciliationActivation,
} from "@/lib/reconciliation/worker-operation";
import type { JobHandler } from "./runtime";

export class WorkerOperationConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkerOperationConfigurationError";
  }
}

export interface FoundationOperationRegistry {
  handlers: ReadonlyMap<string, JobHandler>;
  defaultCapabilities: readonly string[];
}

/**
 * Registers only handlers whose persistence and adapter dependencies are real.
 * County source handlers remain exported/tested boundaries until an approved
 * service-only governance RPC and County transport adapter are supplied.
 */
export function createFoundationOperationRegistry(
  jobs: FoundationJobClient,
  env: NodeJS.ProcessEnv = process.env,
): FoundationOperationRegistry {
  const handlers = new Map<string, JobHandler>([
    ["foundation.healthcheck", async () => ({ checkedAt: new Date().toISOString() })],
  ]);
  const environment = deploymentEnvironment(env);
  const paused = readBoolean(env.CIVYA_PAUSE_ALL, false, "CIVYA_PAUSE_ALL");
  if (paused) return { handlers, defaultCapabilities: [...handlers.keys()] };

  const outboxEnabled = readBoolean(
    env.CIVYA_ENABLE_OUTBOX_DISPATCH,
    true,
    "CIVYA_ENABLE_OUTBOX_DISPATCH",
  );
  if (outboxEnabled) {
    handlers.set(OUTBOX_DISPATCH_JOB, createOutboxDispatchHandler({
      activation: { enabled: true, paused: false },
      store: jobs,
    }));
  }

  const messagesEnabled = readBoolean(
    env.CIVYA_ENABLE_MESSAGES,
    false,
    "CIVYA_ENABLE_MESSAGES",
  );
  if (messagesEnabled) {
    const mode = parseMode(env.CIVYA_MESSAGING_MODE);
    if (mode !== "live") {
      throw new WorkerOperationConfigurationError(
        "reminder_messaging_live_required",
        "The durable reminder worker requires the live Twilio messaging mode.",
      );
    }
    const publicOrigin = exactHttpsOrigin(env.CIVYA_PUBLIC_ORIGIN);
    const webhookUrl = exactHttpsUrl(env.CIVYA_TWILIO_WEBHOOK_URL);
    if (!publicOrigin || !webhookUrl) {
      throw new WorkerOperationConfigurationError(
        "reminder_messaging_urls_missing",
        "Live reminders require an exact HTTPS Civya origin and Twilio webhook URL.",
      );
    }
    const reminders = new ReminderRepository(createSupabaseAdminClient());
    handlers.set(REMINDER_JOB_TYPE, createReminderDeliveryHandler({
      activation: {
        enabled: true,
        paused: false,
        environment,
        mode,
        publicOrigin,
        twilioWebhookUrl: webhookUrl,
      },
      reminders,
      jobs,
      provider: new LiveTwilioReminderProvider(),
    }));
  }

  const sourceEnabled = readBoolean(
    env.CIVYA_ENABLE_COUNTY_SOURCE_WORKER,
    false,
    "CIVYA_ENABLE_COUNTY_SOURCE_WORKER",
  );
  if (sourceEnabled) assertCountySourceCanRegister(env, environment);

  const reconciliationEnabled = readBoolean(
    env.CIVYA_ENABLE_PROVIDER_RECONCILIATION,
    false,
    "CIVYA_ENABLE_PROVIDER_RECONCILIATION",
  );
  if (reconciliationEnabled) {
    const mode = parseMode(env.CIVYA_RECONCILIATION_MODE);
    const activation: ReconciliationActivation = {
      enabled: true,
      paused: false,
      environment,
      mode,
      credentialsConfigured: liveReconciliationConfigPresent(env),
    };
    if (mode === "disabled") {
      throw new WorkerOperationConfigurationError(
        "reconciliation_mode_disabled",
        "Provider reconciliation was enabled without an adapter mode.",
      );
    }
    if (mode === "live") {
      if (!activation.credentialsConfigured) {
        throw new WorkerOperationConfigurationError(
          "reconciliation_live_config_missing",
          "Live provider reconciliation requires an HTTPS endpoint and an explicit credential.",
        );
      }
      throw new WorkerOperationConfigurationError(
        "reconciliation_live_adapter_missing",
        "Live provider reconciliation cannot start until an approved provider-specific adapter is installed.",
      );
    }
    if (environment === "production") {
      throw new WorkerOperationConfigurationError(
        "reconciliation_synthetic_in_production",
        "Synthetic provider reconciliation cannot run in production.",
      );
    }
    const providerKey = env.CIVYA_RECONCILIATION_PROVIDER_KEY?.trim() || "synthetic_provider";
    if (!/^[a-z][a-z0-9_-]{1,79}$/.test(providerKey)) {
      throw new WorkerOperationConfigurationError(
        "reconciliation_provider_invalid",
        "The reconciliation provider key is invalid.",
      );
    }
    const adapter = new SyntheticReconciliationAdapter(providerKey);
    handlers.set(PROVIDER_RECONCILIATION_JOB, createProviderReconciliationHandler({
      activation,
      adapters: new Map([[providerKey, adapter]]),
      store: jobs,
    }));
  }

  return { handlers, defaultCapabilities: [...handlers.keys()] };
}

function assertCountySourceCanRegister(
  env: NodeJS.ProcessEnv,
  environment: ReconciliationActivation["environment"],
): never {
  const mode = parseMode(env.CIVYA_COUNTY_SOURCE_MODE);
  if (mode === "disabled") {
    throw new WorkerOperationConfigurationError(
      "county_source_mode_disabled",
      "County source work was enabled without an adapter mode.",
    );
  }
  if (environment === "production" && mode !== "live") {
    throw new WorkerOperationConfigurationError(
      "county_source_synthetic_in_production",
      "Synthetic County source processing cannot run in production.",
    );
  }
  if (mode === "live" && !liveCountySourceConfigPresent(env)) {
    throw new WorkerOperationConfigurationError(
      "county_source_live_config_missing",
      "Live County source processing requires an HTTPS endpoint and an explicit credential.",
    );
  }
  throw new WorkerOperationConfigurationError(
    "county_source_governance_adapter_missing",
    "County source work cannot start until an approved transport and atomic governance store are installed.",
  );
}

function liveCountySourceConfigPresent(env: NodeJS.ProcessEnv): boolean {
  return isHttpsUrl(env.CIVYA_COUNTY_SOURCE_ENDPOINT)
    && Boolean(env.CIVYA_COUNTY_SOURCE_CREDENTIAL?.trim());
}

function liveReconciliationConfigPresent(env: NodeJS.ProcessEnv): boolean {
  return isHttpsUrl(env.CIVYA_RECONCILIATION_ENDPOINT)
    && Boolean(env.CIVYA_RECONCILIATION_CREDENTIAL?.trim())
    && Boolean(env.CIVYA_RECONCILIATION_PROVIDER_KEY?.trim());
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function exactHttpsOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function exactHttpsUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseMode(raw: string | undefined): ReconciliationActivation["mode"] {
  const mode = raw?.trim() || "disabled";
  if (mode === "disabled" || mode === "synthetic" || mode === "live") return mode;
  throw new WorkerOperationConfigurationError(
    "worker_adapter_mode_invalid",
    "A worker adapter mode must be disabled, synthetic, or live.",
  );
}

function deploymentEnvironment(env: NodeJS.ProcessEnv): ReconciliationActivation["environment"] {
  const value = env.CIVYA_ENVIRONMENT?.trim() || (env.NODE_ENV === "test" ? "test" : "development");
  if (value === "development" || value === "test" || value === "staging" || value === "production") {
    return value;
  }
  throw new WorkerOperationConfigurationError(
    "worker_environment_invalid",
    "The worker environment must be development, test, staging, or production.",
  );
}

function readBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new WorkerOperationConfigurationError(
    "worker_boolean_invalid",
    `${name} must be true or false.`,
  );
}
