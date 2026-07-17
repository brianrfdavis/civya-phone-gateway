const base = (process.env.CIVYA_SMOKE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const checks = [
  ["liveness", "/api/health/live", 200],
  ["readiness", "/api/health/ready", 200],
  ["workflow registry", "/api/v1/workflows", 200],
  ["trust surface", "/trust", 200],
  ["resident surface", "/", 200],
];

let failed = false;
for (const [name, path, expected] of checks) {
  try {
    const response = await fetch(`${base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const ok = response.status === expected;
    console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(20)} ${response.status} ${path}`);
    failed ||= !ok;
  } catch (error) {
    console.log(`FAIL ${name.padEnd(20)} unavailable ${path} ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
