import { readCanaryTesters } from "./canary";

export interface PstnRuntimeState {
  enabled: boolean;
  configured: boolean;
  mode: string;
  missing: string[];
}

const REQUIRED_PSTN_VALUES = [
  "OPENAI_API_KEY",
  "OPENAI_WEBHOOK_SECRET",
  "CIVYA_WAYNE_TENANT_ID",
  "CIVYA_TWILIO_PHONE_NUMBER",
  "CIVYA_PHONE_TURN_URL",
  "CIVYA_PHONE_TURN_SERVICE_SECRET",
  "CIVYA_PHONE_DIGEST_SECRET",
] as const;
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Fail-closed call-control activation. The feature switch and live-provider
 * mode must both be explicit; credentials alone can never activate PSTN.
 */
export function readPstnRuntimeState(env: NodeJS.ProcessEnv = process.env): PstnRuntimeState {
  const enabled = env.CIVYA_ENABLE_PSTN === "true";
  const mode = env.CIVYA_TELEPHONY_MODE?.trim() || "disabled";
  const missing: string[] = REQUIRED_PSTN_VALUES.filter((name) => {
    if (name === "CIVYA_TWILIO_PHONE_NUMBER") {
      // The activation value is an authorization boundary, not display data.
      // Reject whitespace, punctuation, short fragments, and national formats.
      return !E164.test(env[name] ?? "");
    }
    if (name === "CIVYA_PHONE_TURN_URL") return !validPhoneTurnUrl(env[name]);
    if (name === "CIVYA_PHONE_TURN_SERVICE_SECRET" || name === "CIVYA_PHONE_DIGEST_SECRET") {
      return Buffer.byteLength(env[name]?.trim() ?? "") < 32;
    }
    return !env[name]?.trim();
  });
  if (mode !== "live") missing.unshift("CIVYA_TELEPHONY_MODE=live");
  if (env.CIVYA_LANGUAGE_MODE !== "live") missing.push("CIVYA_LANGUAGE_MODE=live");
  const accessMode = env.CIVYA_PSTN_ACCESS_MODE?.trim();
  if (accessMode !== "canary" && accessMode !== "public") {
    missing.push("CIVYA_PSTN_ACCESS_MODE=canary|public");
  } else if (accessMode === "canary") {
    try {
      readCanaryTesters(env);
    } catch {
      missing.push("CIVYA_PSTN_CANARY_TESTERS_JSON");
    }
  } else {
    if (!validBoundedInteger(env.CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR, 1, 20)) {
      missing.push("CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR=1..20");
    }
    if (!validBoundedInteger(env.CIVYA_PSTN_MAX_DURATION_SECONDS, 60, 1_800)) {
      missing.push("CIVYA_PSTN_MAX_DURATION_SECONDS=60..1800");
    }
    if (!validBoundedInteger(env.CIVYA_PSTN_MAX_CONCURRENT_CALLS, 1, 10)) {
      missing.push("CIVYA_PSTN_MAX_CONCURRENT_CALLS=1..10");
    }
    if (!validBoundedInteger(env.CIVYA_PSTN_MAX_TURNS, 1, 100)) {
      missing.push("CIVYA_PSTN_MAX_TURNS=1..100");
    }
  }
  if (env.CIVYA_CALL_RECORDING_MODE?.trim() !== "disabled") {
    missing.push("CIVYA_CALL_RECORDING_MODE=disabled");
  }
  return {
    enabled,
    configured: enabled && missing.length === 0,
    mode,
    missing,
  };
}

function validBoundedInteger(value: string | undefined, minimum: number, maximum: number): boolean {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) && String(parsed) === value?.trim() && parsed >= minimum && parsed <= maximum;
}

function validPhoneTurnUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value?.trim() ?? "");
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return !url.username && !url.password && !url.hash && !url.search
      && (url.protocol === "https:" || local)
      && url.pathname === "/api/internal/phone/turn";
  } catch {
    return false;
  }
}
