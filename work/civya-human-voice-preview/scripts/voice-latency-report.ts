import fs from "node:fs";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run report:voice-latency -- <audit-events.json-or-jsonl>");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(inputPath), "utf8").trim();
const parsed = raw.startsWith("[")
  ? JSON.parse(raw) as unknown[]
  : raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);

const groups = new Map<string, number[]>();
for (const value of parsed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) continue;
  const row = value as JsonRecord;
  const payload = object(row.redacted_payload) || object(row.data) || row;
  const eventType = string(payload.event_type) || string(row.event_type) || string(row.type);
  const milliseconds = number(payload.milliseconds);
  if (eventType !== "speech_to_first_audio" || milliseconds === null) continue;
  const mode = string(payload.response_mode) || "unknown-mode";
  const profile = string(payload.profile_version) || "unknown-profile";
  const kind = string(payload.latency_kind) || "ordinary";
  const key = `${mode}\t${profile}\t${kind}`;
  groups.set(key, [...(groups.get(key) || []), milliseconds]);
}

if (!groups.size) {
  console.error("No speech_to_first_audio samples were found.");
  process.exit(1);
}

console.log("mode\tprofile\tkind\tn\tmedian_ms\tp95_ms");
for (const [key, values] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  values.sort((a, b) => a - b);
  console.log(`${key}\t${values.length}\t${percentile(values, 0.5)}\t${percentile(values, 0.95)}`);
}

function percentile(sorted: number[], quantile: number): number {
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
