import { createServer } from "node:http";
import { hostname } from "node:os";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { FoundationJobClient } from "@/lib/jobs";
import { readPstnRuntimeState } from "@/services/call-control/config";
import { CallControlHttpHandler } from "@/services/call-control/http";
import { createFoundationOperationRegistry } from "./operations";
import { FoundationWorker } from "./runtime";
import { createTelemetryOtlpReceiver } from "./telemetry-receiver";

const jobs = new FoundationJobClient(createSupabaseAdminClient());
const operations = createFoundationOperationRegistry(jobs);
const handlers = operations.handlers;

const capabilities = (process.env.CIVYA_WORKER_CAPABILITIES ?? operations.defaultCapabilities.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const workerId = process.env.CIVYA_WORKER_ID?.trim() || `${hostname()}-${process.pid}`;
const port = boundedInteger(process.env.PORT, 8080, 1, 65535);
const concurrency = boundedInteger(process.env.CIVYA_WORKER_CONCURRENCY, 4, 1, 100);
const leaseSeconds = boundedInteger(process.env.CIVYA_WORKER_LEASE_SECONDS, 60, 10, 3600);
const pollIntervalMs = boundedInteger(process.env.CIVYA_WORKER_POLL_MS, 1000, 100, 60_000);

const runtime = new FoundationWorker(
  jobs,
  handlers,
  { workerId, capabilities, concurrency, leaseSeconds, pollIntervalMs },
);
const initialPstn = readPstnRuntimeState();
const callControl = initialPstn.configured ? new CallControlHttpHandler(jobs) : null;
const telemetryReceiver = createTelemetryOtlpReceiver();
const shutdown = new AbortController();

const server = createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (!response.headersSent) respond(response, 500, { error: "runtime_request_failed" });
    else response.end();
  });
});

async function handleRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  if (await telemetryReceiver.handle(request, response)) return;
  if (callControl && await callControl.handle(request, response)) return;
  if (request.method === "POST" && request.url?.split("?", 1)[0] === "/webhooks/openai") {
    const pstn = readPstnRuntimeState();
    respond(response, 503, {
      accepted: false,
      code: pstn.enabled ? "call_control_not_configured" : "pstn_disabled",
    });
    return;
  }
  const snapshot = runtime.snapshot();
  const pstn = readPstnRuntimeState();
  const pstnReady = !pstn.enabled || (pstn.configured && callControl !== null);
  const callControlSnapshot = callControl?.controller.snapshot() ?? {
    activeCalls: 0,
    model: null,
    transcriptionModel: null,
  };
  const telemetryReceiverSnapshot = telemetryReceiver.snapshot();
  if (request.url === "/health/live") {
    respond(response, snapshot.live ? 200 : 503, {
      live: snapshot.live,
      workerId,
      callControl: callControlSnapshot,
      pstn: publicPstnState(pstn),
      telemetryReceiver: telemetryReceiverSnapshot,
    });
    return;
  }
  if (request.url === "/health/ready") {
    const telemetryReady = !telemetryReceiverSnapshot.enabled || telemetryReceiverSnapshot.ready;
    const ready = snapshot.ready && pstnReady && telemetryReady;
    respond(response, ready ? 200 : 503, {
      ...snapshot,
      ready,
      callControl: callControlSnapshot,
      pstn: publicPstnState(pstn),
      telemetryReceiver: telemetryReceiverSnapshot,
    });
    return;
  }
  if (request.url === "/metrics") {
    respond(response, 200, {
      ...snapshot,
      callControl: callControlSnapshot,
      pstn: publicPstnState(pstn),
      telemetryReceiver: telemetryReceiverSnapshot,
    });
    return;
  }
  respond(response, 404, { error: "not_found" });
}

server.listen(port, "0.0.0.0");
void runtime.start(shutdown.signal).catch(() => {
  process.exitCode = 1;
  shutdown.abort("worker_failed");
  server.close();
});

for (const event of ["SIGTERM", "SIGINT"] as const) {
  process.once(event, () => {
    shutdown.abort(event);
    callControl?.close();
    server.close(() => process.exit());
  });
}

function respond(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function publicPstnState(pstn: ReturnType<typeof readPstnRuntimeState>) {
  if (!pstn.enabled) return { enabled: false, configured: false };
  return { enabled: true, configured: pstn.configured, mode: pstn.mode, missing: pstn.missing };
}
