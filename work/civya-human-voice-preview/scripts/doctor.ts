import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRuntimeConfig, RuntimeConfigurationError } from "../lib/config/runtime";

type Check = { name: string; status: "pass" | "warn" | "fail"; detail: string; next?: string };
const checks: Check[] = [];

const major = Number(process.versions.node.split(".")[0]);
checks.push(
  major === 22
    ? { name: "runtime", status: "pass", detail: `Node ${process.version}` }
    : {
        name: "runtime",
        status: "fail",
        detail: `Node ${process.version} is outside the supported 22.x release line.`,
        next: "Run `nvm use` in the Civya application directory.",
      },
);

const root = resolve(import.meta.dirname, "..");
checks.push(
  existsSync(resolve(root, "package-lock.json"))
    ? { name: "lockfile", status: "pass", detail: "package-lock.json is present" }
    : { name: "lockfile", status: "fail", detail: "package-lock.json is missing", next: "Restore the reviewed lockfile." },
);
checks.push(
  existsSync(resolve(root, "next.config.ts")) && !existsSync(resolve(root, "next.config.mjs"))
    ? { name: "next-config", status: "pass", detail: "one authoritative Next.js config" }
    : { name: "next-config", status: "fail", detail: "Next.js configuration is missing or duplicated" },
);

try {
  const runtime = readRuntimeConfig();
  checks.push({
    name: "configuration",
    status: "pass",
    detail: `${runtime.environment}; synthetic=${runtime.syntheticMode}; config=${runtime.configVersion}`,
  });
  if (runtime.environment !== "production" && runtime.syntheticMode) {
    checks.push({
      name: "providers",
      status: "pass",
      detail: "credential-free synthetic adapters are available",
    });
  }
} catch (error) {
  const detail = error instanceof RuntimeConfigurationError ? error.issues.join(" ") : String(error);
  checks.push({ name: "configuration", status: "fail", detail, next: "Correct the named variable; do not bypass the gate." });
}

try {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const required = ["slice", "verify", "test:workflows"];
  const missing = required.filter((name) => !packageJson.scripts?.[name]);
  checks.push(
    missing.length === 0
      ? { name: "commands", status: "pass", detail: required.join(", ") }
      : { name: "commands", status: "fail", detail: `missing scripts: ${missing.join(", ")}` },
  );
} catch (error) {
  checks.push({ name: "commands", status: "fail", detail: `package.json could not be read: ${String(error)}` });
}

for (const check of checks) {
  console.log(`${check.status.toUpperCase().padEnd(5)} ${check.name.padEnd(16)} ${check.detail}`);
  if (check.next) console.log(`      next: ${check.next}`);
}

if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
else console.log("PASS  doctor           Civya is ready for local contract development");
