import { createHmac } from "node:crypto";
import { phoneFromSipDestination } from "@/lib/integrations/twilio-messaging-live";

const E164 = /^\+[1-9]\d{7,14}$/;
const ALIAS = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export interface PhoneParticipant {
  alias: string;
  participantDigest: string;
  admissionMode: "canary" | "public";
}

export interface CanaryTester extends PhoneParticipant {
  alias: string;
  phone: string;
  participantDigest: string;
  admissionMode: "canary";
}

export function readCanaryTesters(env: NodeJS.ProcessEnv = process.env): CanaryTester[] {
  const secret = env.CIVYA_PHONE_DIGEST_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret) < 32) throw new Error("CIVYA_PHONE_DIGEST_SECRET must be at least 32 bytes.");
  let value: unknown;
  try {
    value = JSON.parse(env.CIVYA_PSTN_CANARY_TESTERS_JSON ?? "");
  } catch {
    throw new Error("CIVYA_PSTN_CANARY_TESTERS_JSON must be a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CIVYA_PSTN_CANARY_TESTERS_JSON must map tester aliases to E.164 numbers.");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 25) throw new Error("Configure between 1 and 25 PSTN canary testers.");
  const numbers = new Set<string>();
  return entries.map(([alias, phone]) => {
    if (!ALIAS.test(alias) || typeof phone !== "string" || !E164.test(phone) || numbers.has(phone)) {
      throw new Error("Each canary tester needs a unique safe alias and E.164 number.");
    }
    numbers.add(phone);
    return {
      alias,
      phone,
      participantDigest: keyedPhoneDigest(phone, "participant", secret, env.CIVYA_WAYNE_TENANT_ID),
      admissionMode: "canary",
    };
  });
}

export function identifyCanaryTester(fromUri: string | undefined, env: NodeJS.ProcessEnv = process.env): CanaryTester | null {
  if (!fromUri) return null;
  let caller: string;
  try {
    caller = phoneFromSipDestination(fromUri);
  } catch {
    return null;
  }
  return readCanaryTesters(env).find((tester) => tester.phone === caller) ?? null;
}

/**
 * Resolve the only caller identity Civya retains for telephone admission.
 * Public mode admits any normally presented E.164 caller ID, but converts it
 * immediately to a keyed, tenant-bound digest. Withheld or malformed caller
 * identities fail closed rather than becoming anonymous public access.
 */
export function identifyPhoneParticipant(
  fromUri: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PhoneParticipant | null {
  const accessMode = env.CIVYA_PSTN_ACCESS_MODE?.trim();
  if (accessMode === "canary") return identifyCanaryTester(fromUri, env);
  if (accessMode !== "public" || !fromUri) return null;

  const secret = env.CIVYA_PHONE_DIGEST_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret) < 32) return null;
  try {
    const caller = phoneFromSipDestination(fromUri);
    return {
      alias: "public-caller",
      participantDigest: keyedPhoneDigest(caller, "participant", secret, env.CIVYA_WAYNE_TENANT_ID),
      admissionMode: "public",
    };
  } catch {
    return null;
  }
}

export function phoneCallReferenceDigest(callId: string, env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.CIVYA_PHONE_DIGEST_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret) < 32) throw new Error("CIVYA_PHONE_DIGEST_SECRET must be at least 32 bytes.");
  return keyedPhoneDigest(callId, "provider-call", secret, env.CIVYA_WAYNE_TENANT_ID);
}

function keyedPhoneDigest(value: string, purpose: string, secret: string, tenantId: string | undefined): string {
  return createHmac("sha256", secret)
    .update(`civya-phone-v1:${tenantId?.trim() || "unbound"}:${purpose}:${value}`)
    .digest("hex");
}
