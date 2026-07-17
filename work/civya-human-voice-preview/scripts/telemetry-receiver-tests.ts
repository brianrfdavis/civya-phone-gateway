#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkTelemetryHealth,
  exportTelemetryLog,
  type TelemetryFetch,
} from "../lib/telemetry/otlp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = `receiver-authority-${"8Qa!".repeat(10)}`;
const STARTUP_TIMEOUT_MS = 6_000;

interface WorkerProcess {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function startWorker(port: number): WorkerProcess {
  const child = spawn(resolve(ROOT, "node_modules", ".bin", "tsx"), ["workers/foundation-worker.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "receiver-test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "receiver-test-service-role-key",
      CIVYA_WORKER_CAPABILITIES: "foundation.healthcheck",
      CIVYA_WORKER_POLL_MS: "100",
      CIVYA_WORKER_CONCURRENCY: "1",
      CIVYA_ENABLE_PSTN: "false",
      CIVYA_TELEPHONY_MODE: "disabled",
      CIVYA_ENABLE_TELEMETRY_RECEIVER: "true",
      CIVYA_TELEMETRY_INGEST_SECRET: SECRET,
      OPENAI_API_KEY: "",
      OPENAI_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exited, output: () => output };
}

async function fetchWhenListening(
  worker: WorkerProcess,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      const exit = await worker.exited;
      throw new Error(`worker exited before startup (${JSON.stringify(exit)}): ${worker.output()}`);
    }
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(500) });
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`worker did not listen: ${worker.output()} (${String(lastError)})`);
}

async function stopWorker(worker: WorkerProcess): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill("SIGTERM");
  const graceful = await Promise.race([
    worker.exited.then(() => true),
    new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 1_500)),
  ]);
  if (!graceful) {
    worker.child.kill("SIGKILL");
    await worker.exited;
  }
}

function postJson(url: string, body: unknown, credential = SECRET): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-civya-telemetry-key": credential,
    },
    body: JSON.stringify(body),
  });
}

async function currentExporterEnvelope(env: NodeJS.ProcessEnv): Promise<Record<string, any>> {
  let body = "";
  const capture: TelemetryFetch = async (_input, init) => {
    body = String(init?.body ?? "");
    return new Response(null, { status: 202 });
  };
  await exportTelemetryLog("info", "civya.telemetry.health", {
    operation: "readiness_probe",
    status: "ok",
  }, { env, fetchImpl: capture, now: 1_700_000_000_000 });
  return JSON.parse(body) as Record<string, any>;
}

async function main(): Promise<void> {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const worker = startWorker(port);
  const exporterEnv = {
    NODE_ENV: "test",
    CIVYA_ENVIRONMENT: "test",
    CIVYA_TELEMETRY_MODE: "otlp-http-json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${base}/v1/logs`,
    OTEL_EXPORTER_OTLP_HEADERS: `x-civya-telemetry-key=${encodeURIComponent(SECRET)}`,
    OTEL_SERVICE_NAME: "civya-web",
    CIVYA_RELEASE_VERSION: "receiver-contract-v1",
  } as NodeJS.ProcessEnv;

  try {
    const live = await fetchWhenListening(worker, `${base}/health/live`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).telemetryReceiver.ready, true);

    const unauthorized = await postJson(`${base}/v1/logs`, {}, "wrong-credential");
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error, "unauthorized");

    const unsupported = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${SECRET}` },
      body: "{}",
    });
    assert.equal(unsupported.status, 415);

    const oversized = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: Buffer.alloc(65_537, 97),
    });
    assert.equal(oversized.status, 413);

    const validEnvelope = await currentExporterEnvelope(exporterEnv);
    const piiEnvelope = structuredClone(validEnvelope);
    piiEnvelope.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.push({
      key: "civya.resident",
      value: { stringValue: "resident-name" },
    });
    const pii = await postJson(`${base}/v1/logs`, piiEnvelope);
    assert.equal(pii.status, 400);
    assert.equal((await pii.json()).error, "sensitive_content");

    const secretEnvelope = structuredClone(validEnvelope);
    secretEnvelope.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.push({
      key: "civya.code",
      value: { stringValue: `sk-${"A".repeat(40)}` },
    });
    const secretLike = await postJson(`${base}/v1/logs`, secretEnvelope);
    assert.equal(secretLike.status, 400);
    assert.equal((await secretLike.json()).error, "sensitive_content");

    const readiness = await checkTelemetryHealth({ env: exporterEnv });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.httpStatus, undefined);

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    const snapshot = (await metrics.json()).telemetryReceiver;
    assert.equal(snapshot.capability, "otlp.logs.receive");
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.acceptedRequests, 1);
    assert.equal(snapshot.rejectedRequests, 5);
    assert.equal(snapshot.unauthorizedRequests, 1);
    assert.equal(snapshot.oversizedRequests, 1);
    assert.equal(snapshot.invalidRequests, 3);

    assert.match(worker.output(), /"event":"civya\.telemetry\.received"/);
    assert.match(worker.output(), /"source_event":"civya\.telemetry\.health"/);
    assert.doesNotMatch(worker.output(), /resident-name|sk-[A-Z]{20}|receiver-authority/i);
    console.log("Authenticated privacy-safe OTLP receiver, caps, rejection policy, readiness, and metrics passed.");
  } finally {
    await stopWorker(worker);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
