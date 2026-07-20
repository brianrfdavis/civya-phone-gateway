import { signPhoneTurnRequest } from "@/lib/phone/signing";
import {
  validatePublicPhoneTurnResult,
  type PublicPhoneTurnRequest,
  type PublicPhoneTurnResult,
} from "@/lib/phone/turn";

export class PhoneTurnClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PhoneTurnClientError";
  }
}

export async function requestPublicPhoneTurn(
  input: PublicPhoneTurnRequest,
  options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; nowSeconds?: number } = {},
): Promise<PublicPhoneTurnResult> {
  const env = options.env ?? process.env;
  const endpoint = exactEndpoint(env.CIVYA_PHONE_TURN_URL);
  const secret = env.CIVYA_PHONE_TURN_SERVICE_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret) < 32) throw new PhoneTurnClientError("phone_turn_not_configured");
  const rawBody = JSON.stringify(input);
  const timestamp = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  // Complex official-source lookups run after Realtime has already spoken a
  // bridge. Keep the normal voice path instant while allowing the verified
  // lookup to finish within its separate deadline.
  const timeoutMs = boundedInteger(env.CIVYA_PHONE_TURN_TIMEOUT_MS, 12_000, 1_000, 15_000);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Civya-Phone-Timestamp": String(timestamp),
        "X-Civya-Phone-Signature": signPhoneTurnRequest(rawBody, timestamp, secret),
      },
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new PhoneTurnClientError("phone_turn_unavailable");
  }
  if (!response.ok) {
    throw new PhoneTurnClientError(response.status === 409 ? "phone_turn_in_progress" : "phone_turn_rejected");
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new PhoneTurnClientError("phone_turn_invalid_response");
  }
  try {
    return validatePublicPhoneTurnResult(result, input.provider_item_id);
  } catch {
    throw new PhoneTurnClientError("phone_turn_invalid_response");
  }
}

function exactEndpoint(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new PhoneTurnClientError("phone_turn_not_configured");
  }
  if (url.username || url.password || url.hash || url.search
      || (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      || url.pathname !== "/api/internal/phone/turn") {
    throw new PhoneTurnClientError("phone_turn_not_configured");
  }
  return url.toString();
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
