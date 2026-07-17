import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const evidence = {
  generated_at: new Date().toISOString(),
  release: process.env.CIVYA_RELEASE_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || "uncommitted",
  config_version: process.env.CIVYA_CONFIG_VERSION || "local",
  node: process.version,
  package_lock_sha256: await digest(new URL("../../package-lock.json", import.meta.url)),
  workflow_versions: [
    "wayne-notice-v1",
    "wayne-payment-plan-v1",
    "wayne-document-readiness-v1",
    "wayne-reminders-v1",
    "wayne-human-partner-v1",
  ],
  model_registry: {
    realtime_voice: "gpt-realtime-2.1",
    transcription: "gpt-4o-transcribe",
    consequential_authority: "deterministic_only",
  },
  production_invariants: [
    "no_synthetic_provider",
    "case_entitlement_required",
    "authoritative_completion_only",
    "document_quarantine",
    "durable_external_effects",
  ],
};
console.log(JSON.stringify(evidence, null, 2));
