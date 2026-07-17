import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_TIMEOUT_MS = 6_000;

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function startWorker(environment) {
  const child = spawn(resolve(ROOT, "node_modules", ".bin", "tsx"), ["workers/foundation-worker.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "startup-test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "startup-test-service-key",
      CIVYA_WORKER_CAPABILITIES: "foundation.healthcheck",
      CIVYA_WORKER_POLL_MS: "100",
      CIVYA_WORKER_CONCURRENCY: "1",
      OPENAI_API_KEY: "",
      OPENAI_WEBHOOK_SECRET: "",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exited, output: () => output };
}

async function fetchWhenListening(worker, port, path, init) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      const exit = await worker.exited;
      throw new Error(`worker exited before startup (${JSON.stringify(exit)}): ${worker.output()}`);
    }
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        signal: AbortSignal.timeout(500),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`worker did not listen within ${STARTUP_TIMEOUT_MS}ms: ${worker.output()} (${lastError})`);
}

async function stopWorker(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill("SIGTERM");
  const graceful = await Promise.race([
    worker.exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 1_500)),
  ]);
  if (!graceful) {
    worker.child.kill("SIGKILL");
    await worker.exited;
  }
}

async function testDisabledPstnBoot() {
  const port = await reservePort();
  const worker = startWorker({
    PORT: String(port),
    CIVYA_ENABLE_PSTN: "false",
    CIVYA_TELEPHONY_MODE: "disabled",
  });
  try {
    const liveResponse = await fetchWhenListening(worker, port, "/health/live");
    assert.equal(liveResponse.status, 200);
    const live = await liveResponse.json();
    assert.equal(live.live, true);
    assert.deepEqual(live.pstn, { enabled: false, configured: false });

    const webhookResponse = await fetchWhenListening(worker, port, "/webhooks/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(webhookResponse.status, 503);
    assert.equal((await webhookResponse.json()).code, "pstn_disabled");
  } finally {
    await stopWorker(worker);
  }
}

async function testIncompleteEnabledPstnReadiness() {
  const port = await reservePort();
  const worker = startWorker({
    PORT: String(port),
    CIVYA_ENABLE_PSTN: "true",
    CIVYA_TELEPHONY_MODE: "live",
    CIVYA_WAYNE_TENANT_ID: "81000000-0000-4000-8000-000000000001",
    CIVYA_TWILIO_PHONE_NUMBER: "+13135550123",
  });
  try {
    const liveResponse = await fetchWhenListening(worker, port, "/health/live");
    assert.equal(liveResponse.status, 200);
    const live = await liveResponse.json();
    assert.equal(live.pstn.enabled, true);
    assert.equal(live.pstn.configured, false);
    assert.equal(live.pstn.mode, "live");
    assert.ok(live.pstn.missing.includes("CIVYA_PHONE_TURN_SERVICE_SECRET"));

    const readyResponse = await fetchWhenListening(worker, port, "/health/ready");
    assert.equal(readyResponse.status, 503);
    const ready = await readyResponse.json();
    assert.equal(ready.ready, false);
    assert.equal(ready.pstn.enabled, true);
    assert.equal(ready.pstn.configured, false);
    assert.ok(ready.pstn.missing.includes("CIVYA_PSTN_ACCESS_MODE=canary|public"));

    const webhookResponse = await fetchWhenListening(worker, port, "/webhooks/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(webhookResponse.status, 503);
    assert.equal((await webhookResponse.json()).code, "call_control_not_configured");
  } finally {
    await stopWorker(worker);
  }
}

await testDisabledPstnBoot();
await testIncompleteEnabledPstnReadiness();
console.log("Worker startup, non-PSTN liveness, and fail-closed PSTN readiness passed.");
