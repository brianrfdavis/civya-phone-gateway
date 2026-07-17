import { createHash } from "node:crypto";
import twilio from "twilio";

const E164 = /^\+[1-9]\d{7,14}$/;

export interface LiveMessageReceipt {
  providerReferenceDigest: string;
  status: string;
}

export class TwilioMessagingConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TwilioMessagingConfigurationError";
  }
}

export class TwilioMessagingOutcomeUnknownError extends Error {
  readonly code = "twilio_delivery_outcome_unknown";

  constructor() {
    super("Twilio did not return an authoritative reminder acceptance outcome.");
    this.name = "TwilioMessagingOutcomeUnknownError";
  }
}

export function phoneFromSipDestination(value: string): string {
  const trimmed = value.trim().slice(0, 500);
  const nameAddress = trimmed.match(/^[^\r\n<>]*<([^\r\n<>]+)>(?:[ \t]*;[^\r\n]*)?$/);
  if ((trimmed.includes("<") || trimmed.includes(">")) && !nameAddress) {
    throw new Error("The call destination cannot receive a secure text link.");
  }
  // If a display name is present, only the URI inside its single name-address
  // bracket pair is authoritative. Never scan arbitrary display text for a
  // number or a second URI-like substring.
  const address = (nameAddress?.[1] ?? trimmed).trim();
  const sip = address.match(/^sips?:([+][1-9]\d{7,14})@[^@\s;>]+(?:[;?][^\s<>]*)?$/i)?.[1];
  const tel = address.match(/^tel:([+][1-9]\d{7,14})(?:;[^\s<>]*)?$/i)?.[1];
  const direct = E164.test(address) ? address : undefined;
  const destination = sip ?? tel ?? direct;
  if (!destination || !E164.test(destination)) throw new Error("The call destination cannot receive a secure text link.");
  return destination;
}

export function phoneReferenceDigest(phone: string): string {
  if (!E164.test(phone)) throw new Error("Phone destination is invalid.");
  return createHash("sha256").update(`civya-phone-reference-v1:${phone}`).digest("hex");
}

export function secureLinkMessage(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("Secure-link messages require HTTPS.");
  return `Civya secure link: ${url} Expires in 10 minutes. Don't share it. We never ask for card, bank, password, or security-code details by text.`;
}

export async function sendLiveTwilioSecureLink(input: {
  to: string;
  body: string;
}): Promise<LiveMessageReceipt> {
  if (!E164.test(input.to)) throw new Error("Phone destination is invalid.");
  if (!input.body || input.body.length > 500) throw new Error("Secure-link message is invalid.");
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim() || process.env.CIVYA_TWILIO_PHONE_NUMBER?.trim();
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || authToken.length < 16) {
    throw new Error("Twilio messaging credentials are not configured.");
  }
  if (!messagingServiceSid && (!from || !E164.test(from))) {
    throw new Error("A Twilio messaging service or approved sender number is required.");
  }
  if (messagingServiceSid && !/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
    throw new Error("Twilio messaging service identifier is invalid.");
  }
  const client = twilio(accountSid, authToken, { autoRetry: false });
  const message = await client.messages.create({
    to: input.to,
    body: input.body,
    ...(messagingServiceSid ? { messagingServiceSid } : { from }),
  });
  if (!message.sid) throw new Error("Twilio did not return a message reference.");
  return {
    providerReferenceDigest: createHash("sha256").update(message.sid).digest("hex"),
    status: message.status || "accepted",
  };
}

/**
 * Twilio's Messages resource does not enforce our idempotency key. The caller
 * must reserve an external operation before calling this function and must not
 * blindly retry an ambiguous result. The delivery UUID in statusCallback lets
 * a signed receipt reconcile a process crash after Twilio accepted the send.
 */
export async function sendLiveTwilioReminder(input: {
  to: string;
  body: string;
  statusCallback: string;
}): Promise<LiveMessageReceipt> {
  if (!E164.test(input.to)) {
    throw new TwilioMessagingConfigurationError("twilio_destination_invalid", "Phone destination is invalid.");
  }
  if (!input.body || Buffer.byteLength(input.body, "utf8") > 1_600) {
    throw new TwilioMessagingConfigurationError("twilio_message_invalid", "Reminder message is invalid.");
  }
  let callback: URL;
  try {
    callback = new URL(input.statusCallback);
  } catch {
    throw new TwilioMessagingConfigurationError("twilio_callback_invalid", "Twilio status callback is invalid.");
  }
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash) {
    throw new TwilioMessagingConfigurationError("twilio_callback_invalid", "Twilio status callback must use exact HTTPS.");
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim() || process.env.CIVYA_TWILIO_PHONE_NUMBER?.trim();
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || authToken.length < 16) {
    throw new TwilioMessagingConfigurationError("twilio_credentials_missing", "Twilio messaging credentials are not configured.");
  }
  if (!messagingServiceSid && (!from || !E164.test(from))) {
    throw new TwilioMessagingConfigurationError("twilio_sender_missing", "An approved Twilio sender is required.");
  }
  if (messagingServiceSid && !/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
    throw new TwilioMessagingConfigurationError("twilio_sender_invalid", "Twilio messaging service identifier is invalid.");
  }
  const client = twilio(accountSid, authToken, { autoRetry: false });
  try {
    const message = await client.messages.create({
      to: input.to,
      body: input.body,
      statusCallback: callback.toString(),
      ...(messagingServiceSid ? { messagingServiceSid } : { from }),
    });
    if (!message.sid) throw new TwilioMessagingOutcomeUnknownError();
    return {
      providerReferenceDigest: createHash("sha256").update(message.sid).digest("hex"),
      status: message.status || "accepted",
    };
  } catch (error) {
    if (error instanceof TwilioMessagingOutcomeUnknownError) throw error;
    // Twilio/network errors after create() starts are ambiguous. They are
    // intentionally redacted and classified so the job never blindly retries.
    throw new TwilioMessagingOutcomeUnknownError();
  }
}
