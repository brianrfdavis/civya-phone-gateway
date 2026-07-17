import { createHash } from "node:crypto";
import type {
  ApprovedSpeechDirective,
  CallProviderAdapter,
  CallState,
  HumanTransferDirective,
  VoiceModelAdapter,
} from "./contracts";

function ref(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export class SyntheticTwilioCallAdapter implements CallProviderAdapter {
  readonly provider = "twilio" as const;
  private states = new Map<string, CallState>();
  private results = new Map<string, CallState>();

  async connect(input: { callReference: string; contactToken: string; idempotencyKey: string }): Promise<{ state: CallState }> {
    if (!/^call_[A-Za-z0-9_-]{8,120}$/.test(input.callReference)) throw new Error("Call reference must be opaque.");
    if (!/^contact_[A-Za-z0-9_-]{8,120}$/.test(input.contactToken)) throw new Error("Contact token must be opaque.");
    const operationKey = `connect:${input.idempotencyKey}`;
    const prior = this.results.get(operationKey);
    if (prior) return { state: prior };
    this.states.set(input.callReference, "connected");
    this.results.set(operationKey, "connected");
    return { state: "connected" };
  }

  async transfer(input: {
    callReference: string;
    directive: HumanTransferDirective;
    idempotencyKey: string;
  }): Promise<{ state: CallState }> {
    if (!this.states.has(input.callReference)) throw new Error("Unknown synthetic call.");
    if (input.directive.requiresStaffAcceptance !== true) throw new Error("Warm transfer requires staff acceptance.");
    const operationKey = `transfer:${input.idempotencyKey}`;
    const prior = this.results.get(operationKey);
    if (prior) return { state: prior };
    this.states.set(input.callReference, "transferring");
    this.results.set(operationKey, "transferring");
    return { state: "transferring" };
  }

  async end(input: { callReference: string; reasonCode: string; idempotencyKey: string }): Promise<{ state: "ended" }> {
    if (!this.states.has(input.callReference)) throw new Error("Unknown synthetic call.");
    if (!/^[a-z0-9_]{3,80}$/.test(input.reasonCode)) throw new Error("Unsafe call ending reason.");
    this.states.set(input.callReference, "ended");
    this.results.set(`end:${input.idempotencyKey}`, "ended");
    return { state: "ended" };
  }
}

export class SyntheticOpenAIRealtimeCallAdapter implements VoiceModelAdapter {
  readonly provider = "openai" as const;
  readonly authority = "language_and_delivery_only" as const;

  async speak(callReference: string, directive: ApprovedSpeechDirective): Promise<{ state: "speaking"; responseReference: string }> {
    if (!/^call_[A-Za-z0-9_-]{8,120}$/.test(callReference)) throw new Error("Call reference must be opaque.");
    if (directive.mayChangeCaseState !== false) throw new Error("Voice delivery cannot mutate case state.");
    if (directive.source !== "deterministic_policy" && directive.source !== "approved_content") {
      throw new Error("OpenAI may speak only server-approved text.");
    }
    return {
      state: "speaking",
      responseReference: `syn_voice_${ref(`${callReference}:${directive.id}:${directive.text}`)}`,
    };
  }
}
