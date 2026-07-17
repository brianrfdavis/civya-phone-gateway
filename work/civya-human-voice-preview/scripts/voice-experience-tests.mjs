#!/usr/bin/env node
/**
 * Static regression checks for the voice-first experience.
 *
 * These checks intentionally fail if future edits remove the trust,
 * accessibility, silence, or voice-first controls.
 */
import fs from "node:fs";

const read = (path) =>
  fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const persona = read("lib/realtime/persona.ts");
const tools = read("lib/realtime/tools.ts");
const session = read("app/api/realtime/session/route.ts");
const profiles = read("lib/realtime/profiles.ts");
const mode = read("lib/realtime/mode.ts");
const client = read("lib/realtime/client.ts");
const page = read("app/page.tsx");

let failures = 0;
function check(name, condition) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}

console.log("Voice experience safeguards");

check(
  "Civya clearly identifies itself as automated",
  persona.includes("You are Civya, an automated assistant") &&
    persona.includes("Never hide that you are automated"),
);
check(
  "Civya does not use the separate Sylvia identity",
  !persona.includes("You are Sylvia") && !persona.includes("I'm Sylvia"),
);
check(
  "Digital.gov plain-language rules are present",
  persona.includes("Use short, familiar words, active voice, present tense") &&
    persona.includes("Avoid jargon, bureaucratic terms, idioms"),
);
check(
  "privacy collection is minimized",
  persona.includes("Ask only for information required for the next useful step") &&
    persona.includes('Do not ask for information "just in case"'),
);
check(
  "human help remains easy to request",
  persona.includes("Make human help easy to request at any point"),
);
check(
  "time-sensitive program status is not hard-coded",
  persona.includes("Never state current program availability or a deadline from memory") &&
    !persona.includes("was set to expire"),
);
check(
  "fast server VAD is the turn detector",
  profiles.includes('type: "server_vad"') &&
    profiles.includes("silence_duration_ms: 500") &&
    !profiles.includes('type: "semantic_vad"'),
);
check(
  "Wayne County launch uses only the qualified Realtime model",
  session.includes('const MODEL = "gpt-realtime-2.1"') &&
    !session.includes("gpt-realtime-mini") &&
    !session.includes("preview"),
);
check(
  "opening greeting waits for the Realtime data channel",
  /dc\.onopen\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,500}this\.onDataChannelOpen\(speakOpening\)/.test(client) &&
    /private onDataChannelOpen\([\s\S]{0,700}this\.speakApproved\(this\.openingMessage\(\)/.test(client),
);
check(
  "qualified audio configuration is fail-closed",
  session.includes('const CONFIGURED_VOICE') &&
    session.includes('new Set(["marin", "cedar"])') &&
    session.includes('const TRANSCRIPTION_MODEL = "gpt-4o-transcribe"') &&
    session.includes('reasoning: { effort: "low" }'),
);
check(
  "authoritative mode remains server-first while synthetic fast modes auto-respond",
  profiles.includes("automaticResponseCreation: true") &&
    profiles.includes("automaticResponseCreation: false") &&
    client.includes('"/api/conversations/turn"') &&
    client.includes("if (this.isDirectMode())") &&
    mode.includes('mode === "fast" || mode === "legacy_fast"'),
);
check(
  "fact mutation is exposed only in the direct profile and remains server guarded",
  tools.includes('name: "save_intake_answer"') &&
    tools.includes("FAST_REALTIME_TOOLS") &&
    tools.includes("LEGACY_FAST_REALTIME_TOOLS") &&
    tools.includes('name: "request_secure_account"') &&
    client.includes('lookup_property_status: "/api/tools/property-status"'),
);
check(
  "voice recovery is bounded and falls back explicitly",
  client.includes("const MAX_RECONNECT_ATTEMPTS = 2") &&
    client.includes("onTextFallback") &&
    client.includes("disconnectInternal(true, true)"),
);
check(
  "final playback releases the microphone",
  client.includes("finishGracefulEnd") &&
    client.includes("this.events.onConversationEnded?.()") &&
    /finishGracefulEnd\(\)[\s\S]{0,400}disconnectInternal\(true, true\)/.test(client),
);
check(
  "persona is a warm resident advocate",
  persona.includes("practical resident advocate") &&
    persona.includes("Be on the resident's side"),
);
check(
  "voice is the primary landing action",
  page.includes("Start voice conversation") &&
    page.includes("Civya is automated and is not the Wayne County Treasurer"),
);
check(
  "UI avoids an absolute privacy promise",
  !page.includes("Your information is safe."),
);

console.log(
  failures === 0
    ? "\nALL VOICE EXPERIENCE CHECKS PASSED"
    : `\n${failures} VOICE EXPERIENCE CHECKS FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
