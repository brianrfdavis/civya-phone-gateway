import { readCanaryTesters } from "../services/call-control/canary";
import { readPstnRuntimeState } from "../services/call-control/config";

const state = readPstnRuntimeState(process.env);
const missing = new Set(state.missing);

if (!/^AC[0-9a-f]{32}$/i.test(process.env.TWILIO_ACCOUNT_SID?.trim() ?? "")) {
  missing.add("TWILIO_ACCOUNT_SID");
}
if (Buffer.byteLength(process.env.TWILIO_AUTH_TOKEN?.trim() ?? "") < 16) {
  missing.add("TWILIO_AUTH_TOKEN");
}
if (!/^TK[0-9a-f]{32}$/i.test(process.env.TWILIO_SIP_TRUNK_SID?.trim() ?? "")) {
  missing.add("TWILIO_SIP_TRUNK_SID");
}
if (!/^proj_[A-Za-z0-9_-]+$/.test(process.env.OPENAI_PROJECT_ID?.trim() ?? "")) {
  missing.add("OPENAI_PROJECT_ID");
}
if (!isHttpsOrigin(process.env.CIVYA_CALL_CONTROL_BASE_URL)) {
  missing.add("CIVYA_CALL_CONTROL_BASE_URL");
}

let testerAliases: string[] = [];
if (process.env.CIVYA_PSTN_ACCESS_MODE?.trim() === "canary") {
  try {
    testerAliases = readCanaryTesters(process.env).map((tester) => tester.alias);
  } catch {
    missing.add("CIVYA_PSTN_CANARY_TESTERS_JSON");
  }
}

const result = {
  ready: state.configured && missing.size === 0,
  pstnEnabled: state.enabled,
  telephonyMode: state.mode,
  accessMode: process.env.CIVYA_PSTN_ACCESS_MODE?.trim() || "unset",
  recordingMode: process.env.CIVYA_CALL_RECORDING_MODE?.trim() || "unset",
  testerAliases,
  missing: [...missing].sort(),
};

console.log(JSON.stringify(result, null, 2));
if (!result.ready) process.exitCode = 1;

function isHttpsOrigin(value: string | undefined): boolean {
  try {
    const url = new URL(value?.trim() ?? "");
    return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}
