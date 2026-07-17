import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeIntakeFact } from "../lib/conversation/engine";
import {
  parseVoiceResponseMode,
  resolveVoiceResponseMode,
} from "../lib/realtime/mode";
import {
  REALTIME_VOICE_PROFILES,
} from "../lib/realtime/profiles";
import { FAST_CIVYA_INSTRUCTIONS } from "../lib/realtime/persona";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

assert.deepEqual(
  resolveVoiceResponseMode({ syntheticMode: true, environment: "development" }),
  { requested: "fast", effective: "fast", forcedAuthoritative: false },
);
assert.equal(
  resolveVoiceResponseMode({ configuredMode: "legacy_fast", syntheticMode: true, environment: "staging" }).effective,
  "legacy_fast",
);
assert.equal(
  resolveVoiceResponseMode({ configuredMode: "authoritative", syntheticMode: true, environment: "development" }).effective,
  "authoritative",
);
assert.deepEqual(
  resolveVoiceResponseMode({ configuredMode: "fast", syntheticMode: false, environment: "staging" }),
  { requested: "fast", effective: "authoritative", forcedAuthoritative: true },
);
assert.equal(
  resolveVoiceResponseMode({ configuredMode: "legacy_fast", syntheticMode: true, environment: "production" }).effective,
  "authoritative",
);
assert.throws(() => parseVoiceResponseMode("quick-ish"), /CIVYA_VOICE_MODE/);

assert.equal(REALTIME_VOICE_PROFILES.fast.automaticResponseCreation, true);
assert.equal(REALTIME_VOICE_PROFILES.fast.turnDetection.create_response, true);
assert.equal(REALTIME_VOICE_PROFILES.fast.turnDetection.silence_duration_ms, 500);
assert.equal(REALTIME_VOICE_PROFILES.legacy_fast.automaticResponseCreation, true);
assert.equal(REALTIME_VOICE_PROFILES.authoritative.automaticResponseCreation, false);
assert.equal(REALTIME_VOICE_PROFILES.authoritative.turnDetection.create_response, false);
assert.notStrictEqual(
  REALTIME_VOICE_PROFILES.fast.tools,
  REALTIME_VOICE_PROFILES.legacy_fast.tools,
  "fallback manifests must not share a mutable tool array",
);
assert(Object.isFrozen(REALTIME_VOICE_PROFILES.fast.tools));
assert(Object.isFrozen(REALTIME_VOICE_PROFILES.legacy_fast.tools));

const goldenProfileHashes = {
  fast: "1c97374385a92658feebaab2e567abab1a6c4a254c5e7ea6e233ebbd082d4e05",
  legacy_fast: "9f1cd5d6b0196084680062e50923b6d65445978e387cd142f5a21883ee7bbd24",
  authoritative: "038477e886a353450ab7fe750c5c04e01c1f387158848b1cabcdd8cc600b0a9b",
} as const;
for (const mode of Object.keys(goldenProfileHashes) as Array<keyof typeof goldenProfileHashes>) {
  const profile = REALTIME_VOICE_PROFILES[mode];
  const snapshot = {
    mode: profile.mode,
    version: profile.version,
    instructions: profile.instructions,
    tools: profile.tools,
    automaticResponseCreation: profile.automaticResponseCreation,
    turnDetection: profile.turnDetection,
  };
  assert.equal(
    createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    goldenProfileHashes[mode],
    `${mode} profile changed; version and golden signature must be reviewed together`,
  );
}

const fastToolNames = REALTIME_VOICE_PROFILES.fast.tools
  .map((tool) => (tool as { name?: string }).name)
  .filter(Boolean);
const authoritativeToolNames = REALTIME_VOICE_PROFILES.authoritative.tools
  .map((tool) => (tool as { name?: string }).name)
  .filter(Boolean);
assert(fastToolNames.includes("save_intake_answer"));
assert(fastToolNames.includes("request_secure_account"));
assert(fastToolNames.includes("wait_for_user"));
assert(!authoritativeToolNames.includes("save_intake_answer"));
assert(!authoritativeToolNames.includes("request_secure_account"));

const promptWords = FAST_CIVYA_INSTRUCTIONS.split(/\s+/).filter(Boolean).length;
const normalizedPrompt = FAST_CIVYA_INSTRUCTIONS.replace(/\s+/g, " ");
assert(promptWords < 650, `fast prompt is ${promptWords} words; expected fewer than 650`);
for (const required of [
  "Answer first",
  "short familiar words",
  "active voice",
  "present tense",
  "first hearing",
  "Questions, refusals, corrections",
  "Use a tool before stating an official or time-sensitive",
]) {
  assert(normalizedPrompt.includes(required), `fast prompt is missing: ${required}`);
}

assert.equal(normalizeIntakeFact("municipality", "Why do you need that?"), null);
assert.equal(normalizeIntakeFact("municipality", "Please repeat the question"), null);
assert.equal(normalizeIntakeFact("municipality", "I'd rather not say"), null);
assert.equal(normalizeIntakeFact("municipality", "I live in Detroit")?.value, "Detroit");
assert.equal(normalizeIntakeFact("unknown", "Detroit"), null);

const client = read("lib/realtime/client.ts");
const session = read("app/api/realtime/session/route.ts");
const cachedAnswer = read("app/api/tools/cached-answer/route.ts");
const propertyStatus = read("app/api/tools/property-status/route.ts");
const transcriptRoute = read("app/api/conversations/transcript/route.ts");
const caseManagement = read("app/api/tools/case-mgmt/route.ts");
assert(client.includes("if (this.isDirectMode())"));
assert(client.includes("this.pendingAutomaticTurnIds"));
assert(client.includes('"/api/conversations/transcript"'));
assert(client.includes("waitForTurnTranscript(turn)"));
assert(client.includes("result.success === true"));
assert(client.includes("profile changed during reconnect"));
assert(client.includes('call.name === "end_or_save_conversation" ? 1 : 2'));
assert(client.includes("this.settledResponseIds.has(request.afterResponseId)"));
assert(session.includes("requested_response_mode"));
assert(session.includes("response_profile_version"));
assert(session.includes("max_output_tokens: 512"));
assert(transcriptRoute.includes('bootstrapSession(platform, undefined, "voice")'));
assert(transcriptRoute.includes('body.speaker === "user"'));
assert(!transcriptRoute.includes('body.speaker === "assistant"'));
assert(caseManagement.includes("unexpected_field"));
assert(caseManagement.includes("idempotency_conflict"));
assert(caseManagement.includes('createHash("sha256")'));
assert(caseManagement.includes('error.code === "23505"'));
assert(caseManagement.includes("persisted.idempotencyKey !== stableTurnKey"));
assert(cachedAnswer.includes("verification_state"));
assert(cachedAnswer.includes("retrieved_at"));
assert(propertyStatus.includes("authority"));
assert(propertyStatus.includes("spoken_text"));

console.log(`Fast voice contracts passed (${promptWords}-word prompt).`);
