import { createHash } from "node:crypto";

export type MessageChannel = "sms" | "email";
export type MessageDeliveryStatus = "accepted" | "delivered" | "failed" | "bounced" | "complained" | "suppressed";

export interface ApprovedMessageTemplate {
  templateId: string;
  version: string;
  locale: string;
  channel: MessageChannel;
  allowedVariableNames: string[];
  containsSensitiveContent: false;
}

export interface MessageSendRequest {
  contactToken: string;
  template: ApprovedMessageTemplate;
  variables: Record<string, string>;
  consentReference: string;
  idempotencyKey: string;
  quietHoursCheckedAt: string;
}

export interface MessageReceipt {
  provider: "twilio" | "synthetic_email";
  messageReference: string;
  status: MessageDeliveryStatus;
  acceptedAt: string;
  duplicate: boolean;
}

export interface MessagingProvider {
  send(request: MessageSendRequest): Promise<MessageReceipt>;
}

export function validateMessageRequest(request: MessageSendRequest): void {
  if (!/^contact_[A-Za-z0-9_-]{8,120}$/.test(request.contactToken)) {
    throw new Error("Messaging adapters accept an opaque contact token, never a raw address or phone number.");
  }
  if (!/^consent_[A-Za-z0-9_-]{8,120}$/.test(request.consentReference)) {
    throw new Error("An explicit consent reference is required.");
  }
  if (request.template.containsSensitiveContent !== false) throw new Error("Sensitive content is prohibited in provider messages.");
  const allowed = new Set(request.template.allowedVariableNames);
  for (const [key, value] of Object.entries(request.variables)) {
    if (!allowed.has(key)) throw new Error(`Template variable is not approved: ${key}.`);
    if (value.length > 160 || /https?:\/\//i.test(value)) throw new Error(`Template variable is unsafe: ${key}.`);
  }
}

function receiptReference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export class SyntheticTwilioMessagingAdapter implements MessagingProvider {
  private sent = new Map<string, MessageReceipt>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async send(request: MessageSendRequest): Promise<MessageReceipt> {
    validateMessageRequest(request);
    const existing = this.sent.get(request.idempotencyKey);
    if (existing) return { ...existing, duplicate: true };
    const receipt: MessageReceipt = {
      provider: "twilio",
      messageReference: `syn_msg_${receiptReference(request.idempotencyKey)}`,
      status: "accepted",
      acceptedAt: new Date(this.now()).toISOString(),
      duplicate: false,
    };
    this.sent.set(request.idempotencyKey, receipt);
    return receipt;
  }
}
