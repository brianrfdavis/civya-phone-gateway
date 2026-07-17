import { createHash, createHmac, randomUUID } from "node:crypto";
import OpenAI, { InvalidWebhookSignatureError } from "openai";
import WebSocket from "ws";
import type { CallSessionResult, FoundationJobClient } from "@/lib/jobs";
import type { PublicPhoneTurnRequest, PublicPhoneTurnResult } from "@/lib/phone/turn";
import { phoneFromSipDestination } from "@/lib/integrations/twilio-messaging-live";
import { identifyPhoneParticipant, phoneCallReferenceDigest, type PhoneParticipant } from "./canary";
import { readPstnRuntimeState } from "./config";
import { requestPublicPhoneTurn } from "./phone-turn-client";
import {
  routePhoneControlTranscript,
  routePhoneTranscript,
  welcomePhoneRoute,
  type PhoneRoute,
  type PhoneRouterState,
} from "./phone-router";

const MODEL = "gpt-realtime-2.1";
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const DEFAULT_VOICE = "marin";
const CALL_ID = /^[A-Za-z0-9_-]{6,200}$/;

export interface SipWebhookResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface VerifiedWebhookEvent {
  id: string;
  type: string;
  data: {
    call_id?: string;
    sip_headers?: Array<{ name: string; value: string }>;
  };
}

export interface OpenAISipControllerOptions {
  verifyWebhook?: (rawBody: string, headers: Headers) => Promise<VerifiedWebhookEvent>;
  fetch?: typeof fetch;
  attachCall?: (
    callId: string,
    fromUri: string | undefined,
    sendWelcome: boolean,
    metadata?: CallAttachmentMetadata,
  ) => Promise<void>;
  requestPhoneTurn?: (input: PublicPhoneTurnRequest) => Promise<PublicPhoneTurnResult>;
}

interface RealtimeEvent {
  type?: string;
  item_id?: string;
  transcript?: string;
  response?: { id?: string; status?: string; output?: Array<{ type?: string }> };
}

interface CallAttachmentMetadata {
  participant: PhoneParticipant;
  callReferenceDigest: string;
  callSession: CallSessionResult;
}

interface ActiveCall {
  callId: string;
  fromUri?: string;
  socket: WebSocket;
  state: PhoneRouterState;
  queuedRoutes: PhoneRoute[];
  responseInFlight: boolean;
  activeRoute?: PhoneRoute;
  turnChain: Promise<void>;
  inputSequence: number;
  turnCount: number;
  callReferenceDigest: string;
  participantAlias: string;
  admissionMode: PhoneParticipant["admissionMode"];
  callSession: CallSessionResult;
  startedAtMs: number;
  outcome: string;
  closeTimer: NodeJS.Timeout;
}

export class OpenAISipController {
  private readonly verifyWebhook: ((rawBody: string, headers: Headers) => Promise<VerifiedWebhookEvent>) | null;
  private readonly fetcher: typeof fetch;
  private readonly attachCall: (
    callId: string,
    fromUri: string | undefined,
    sendWelcome: boolean,
    metadata?: CallAttachmentMetadata,
  ) => Promise<void>;
  private readonly requestPhoneTurn: (input: PublicPhoneTurnRequest) => Promise<PublicPhoneTurnResult>;
  private readonly activeCalls = new Map<string, ActiveCall>();
  private readonly pendingCalls = new Set<string>();
  private readonly metrics = {
    received: 0,
    accepted: 0,
    rejectedDestination: 0,
    rejectedCaller: 0,
    rejectedRateLimit: 0,
    rejectedCapacity: 0,
    phoneTurnFailures: 0,
    languageFallbacks: 0,
    secureLinkRequested: 0,
    transferRequested: 0,
  };
  private readonly publicCallStarts = new Map<string, number[]>();

  constructor(private readonly jobs: FoundationJobClient, options: OpenAISipControllerOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.attachCall = options.attachCall ?? ((callId, fromUri, sendWelcome, metadata) =>
      this.monitor(callId, fromUri, sendWelcome, metadata));
    this.requestPhoneTurn = options.requestPhoneTurn ?? ((input) => requestPublicPhoneTurn(input, { fetch: this.fetcher }));
    if (options.verifyWebhook) {
      this.verifyWebhook = options.verifyWebhook;
      return;
    }
    const state = readPstnRuntimeState();
    if (!state.configured) {
      this.verifyWebhook = null;
      return;
    }
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
    });
    this.verifyWebhook = async (rawBody, headers) =>
      openai.webhooks.unwrap(rawBody, headers) as unknown as VerifiedWebhookEvent;
  }

  async handleWebhook(rawBody: string, headers: Headers): Promise<SipWebhookResult> {
    const pstn = readPstnRuntimeState();
    if (!pstn.enabled) {
      return { status: 503, body: { accepted: false, code: "pstn_disabled" } };
    }
    const tenantId = process.env.CIVYA_WAYNE_TENANT_ID?.trim();
    if (!pstn.configured || !tenantId || !this.verifyWebhook) {
      return { status: 503, body: { accepted: false, code: "call_control_not_configured" } };
    }

    let event: VerifiedWebhookEvent;
    try {
      event = await this.verifyWebhook(rawBody, headers);
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        return { status: 400, body: { accepted: false, code: "invalid_webhook_signature" } };
      }
      return { status: 400, body: { accepted: false, code: "invalid_webhook" } };
    }

    if (event.type !== "realtime.call.incoming") {
      return { status: 200, body: { accepted: true, ignored: true } };
    }
    const callId = event.data.call_id ?? "";
    if (!CALL_ID.test(callId)) {
      return { status: 400, body: { accepted: false, code: "invalid_call_reference" } };
    }
    this.metrics.received += 1;
    const sipHeaders = event.data.sip_headers ?? [];
    const fromUri = sipHeader(sipHeaders, "from");
    const toUri = sipHeader(sipHeaders, "to");
    const diversionUri = sipHeader(sipHeaders, "diversion");
    const participant = identifyPhoneParticipant(fromUri);
    const callReferenceDigest = phoneCallReferenceDigest(callId);

    const processingOwner = `call-control:${randomUUID()}`;
    const durable = await this.jobs.claimProviderEvent({
      tenantId,
      providerKey: "openai",
      externalEventId: event.id,
      eventType: event.type,
      payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      redactedPayload: {
        call_reference_digest: callReferenceDigest,
        participant_reference_digest: participant?.participantDigest ?? null,
        participant_alias: participant?.alias ?? "unrecognized",
        admission_mode: participant?.admissionMode ?? "unrecognized",
        recording_state: "disabled",
        direction: "inbound",
      },
      signatureVerified: true,
      processingOwner,
      leaseSeconds: 30,
      maxAttempts: 8,
    }).catch(() => null);
    if (!durable) {
      return {
        status: 503,
        body: { accepted: false, code: "durable_event_store_unavailable" },
        headers: { "Retry-After": "5" },
      };
    }
    if (!durable.claimed && durable.state === "processed") {
      return { status: 200, body: { accepted: true, duplicate: true } };
    }
    if (!durable.claimed) {
      const retryAfter = Math.max(1, durable.retryAfterSeconds ?? 5);
      return {
        status: 503,
        body: {
          accepted: false,
          duplicate: durable.duplicate,
          code: durable.busy ? "provider_event_in_progress" : "provider_event_reclaim_unavailable",
          retry_after_seconds: retryAfter,
        },
        headers: { "Retry-After": String(retryAfter) },
      };
    }
    if (!durable.processingToken) {
      return {
        status: 503,
        body: { accepted: false, code: "provider_event_claim_unfenced" },
        headers: { "Retry-After": "5" },
      };
    }

    try {
      if (!this.destinationAllowed(diversionUri, toUri)) {
        this.metrics.rejectedDestination += 1;
        await this.reject(callId, 403);
        if (!await this.jobs.finishProviderEventClaim(durable.id, processingOwner, durable.processingToken, "processed")) {
          throw new Error("provider_event_claim_lost");
        }
        return { status: 200, body: { accepted: false, code: "destination_not_allowed" } };
      }
      if (!participant) {
        this.metrics.rejectedCaller += 1;
        await this.reject(callId, 403);
        if (!await this.jobs.finishProviderEventClaim(durable.id, processingOwner, durable.processingToken, "processed")) {
          throw new Error("provider_event_claim_lost");
        }
        return { status: 200, body: { accepted: false, code: "caller_identity_unavailable" } };
      }
      const maximumConcurrent = boundedInteger(process.env.CIVYA_PSTN_MAX_CONCURRENT_CALLS, 2, 1, 10);
      if (this.activeCalls.size + this.pendingCalls.size >= maximumConcurrent) {
        this.metrics.rejectedCapacity += 1;
        await this.reject(callId, 486);
        if (!await this.jobs.finishProviderEventClaim(durable.id, processingOwner, durable.processingToken, "processed")) {
          throw new Error("provider_event_claim_lost");
        }
        return { status: 200, body: { accepted: false, code: "call_capacity_reached" } };
      }
      if (participant.admissionMode === "public" && !this.allowPublicCaller(participant.participantDigest)) {
        this.metrics.rejectedRateLimit += 1;
        await this.reject(callId, 429);
        if (!await this.jobs.finishProviderEventClaim(durable.id, processingOwner, durable.processingToken, "processed")) {
          throw new Error("provider_event_claim_lost");
        }
        return { status: 200, body: { accepted: false, code: "public_rate_limit_reached" } };
      }
      const callSession = await this.jobs.createCallSession({
        tenantId,
        providerKey: "twilio_openai_sip",
        providerCallReferenceDigest: callReferenceDigest,
        participantReferenceDigest: participant.participantDigest,
        direction: "inbound",
        correlationId: `pstn_${callReferenceDigest.slice(0, 32)}`,
        idempotencyKey: `pstn_call_${callReferenceDigest}`,
      });
      const metadata = { participant, callReferenceDigest, callSession };
      this.pendingCalls.add(callId);
      if (durable.attempt > 1) {
        try {
          // If a prior process crashed after accepting, attaching succeeds and
          // avoids repeating the external accept effect.
          await this.attachCall(callId, fromUri, false, metadata);
        } catch {
          await this.acceptOrResume(callId, fromUri, metadata);
        }
      } else {
        await this.acceptOrResume(callId, fromUri, metadata);
      }
      this.pendingCalls.delete(callId);
      this.metrics.accepted += 1;
      if (!await this.jobs.finishProviderEventClaim(durable.id, processingOwner, durable.processingToken, "processed")) {
        throw new Error("provider_event_claim_lost");
      }
      return { status: 200, body: { accepted: true } };
    } catch {
      this.pendingCalls.delete(callId);
      await this.jobs.finishProviderEventClaim(
        durable.id,
        processingOwner,
        durable.processingToken,
        "retry",
        "call_accept_failed",
        15,
      ).catch(() => false);
      return { status: 503, body: { accepted: false, code: "call_control_unavailable" } };
    }
  }

  snapshot() {
    return {
      activeCalls: this.activeCalls.size,
      pendingCalls: this.pendingCalls.size,
      model: MODEL,
      transcriptionModel: TRANSCRIPTION_MODEL,
      counters: { ...this.metrics },
    };
  }

  close(): void {
    for (const call of this.activeCalls.values()) {
      clearTimeout(call.closeTimer);
      call.outcome = "service_restart";
      call.socket.close(1012, "service_restart");
      void this.hangup(call.callId);
    }
    this.activeCalls.clear();
    this.pendingCalls.clear();
    this.publicCallStarts.clear();
  }

  private destinationAllowed(diversionUri: string | undefined, toUri: string | undefined): boolean {
    const expected = process.env.CIVYA_TWILIO_PHONE_NUMBER ?? "";
    const authoritativeDestination = diversionUri ?? toUri;
    if (!authoritativeDestination) return false;
    try {
      const configuredDestination = phoneFromSipDestination(expected);
      // Defense in depth if the controller is ever constructed without the
      // activation gate: the configured value itself must be canonical E.164.
      if (configuredDestination !== expected) return false;
      return phoneFromSipDestination(authoritativeDestination) === configuredDestination;
    } catch {
      return false;
    }
  }

  private async accept(callId: string): Promise<void> {
    await this.callApi(callId, "accept", {
      type: "realtime",
      model: MODEL,
      instructions: [
        "You are Civya's phone voice renderer.",
        "Never originate advice, facts, amounts, dates, case status, eligibility, identity decisions, or completion claims.",
        "Automatic response creation is disabled. Speak only the exact approved text provided in each response instruction.",
        "Do not add, omit, summarize, or paraphrase words. You have no authority to change a case or official record.",
      ].join(" "),
      output_modalities: ["audio"],
      include: ["item.input_audio_transcription.logprobs"],
      audio: {
        input: {
          transcription: {
            model: TRANSCRIPTION_MODEL,
            prompt: "Wayne County property tax assistance. Preserve the caller's spoken language.",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 650,
            create_response: false,
            interrupt_response: true,
            idle_timeout_ms: 20_000,
          },
        },
        output: { voice: process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_VOICE },
      },
    });
  }

  private monitor(
    callId: string,
    fromUri?: string,
    sendWelcome = true,
    metadata?: CallAttachmentMetadata,
  ): Promise<void> {
    if (this.activeCalls.get(callId)?.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!metadata) return Promise.reject(new Error("call_metadata_required"));
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
        headers: buildRealtimeConnectionHeaders(process.env.OPENAI_API_KEY, callId, fromUri),
        handshakeTimeout: 10_000,
      });
      const call: ActiveCall = {
        callId,
        fromUri,
        socket,
        state: { offeredSecureLink: false, locale: "und" },
        queuedRoutes: [],
        responseInFlight: false,
        turnChain: Promise.resolve(),
        inputSequence: 0,
        turnCount: 0,
        callReferenceDigest: metadata.callReferenceDigest,
        participantAlias: metadata.participant.alias,
        admissionMode: metadata.participant.admissionMode,
        callSession: metadata.callSession,
        startedAtMs: Date.now(),
        outcome: "completed",
        closeTimer: setTimeout(() => {
          call.outcome = "maximum_duration";
          socket.close(1000, "maximum_call_duration");
          void this.hangup(callId);
        }, maximumCallDurationSeconds(metadata.participant.admissionMode) * 1_000),
      };
      this.activeCalls.set(callId, call);
      let attached = false;
      const attachTimeout = setTimeout(() => {
        if (attached) return;
        clearTimeout(call.closeTimer);
        this.activeCalls.delete(callId);
        socket.terminate();
        reject(new Error("call_attach_timeout"));
      }, 11_000);

      socket.once("open", () => {
        void (async () => {
          try {
            if (call.callSession.status === "received") {
              call.callSession = await this.jobs.controlCall({
                callSessionId: call.callSession.callSessionId,
                expectedRowVersion: call.callSession.rowVersion,
                nextStatus: "connected",
                eventType: "call.connected",
                payloadSha256: createHash("sha256").update("call.connected").digest("hex"),
                redactedMetadata: {
                  participant_alias: call.participantAlias,
                  admission_mode: call.admissionMode,
                  recording_state: "disabled",
                },
              });
            }
            attached = true;
            clearTimeout(attachTimeout);
            if (sendWelcome) this.enqueueSpeech(call, welcomePhoneRoute());
            resolve();
          } catch {
            socket.close(1011, "call_lifecycle_unavailable");
            reject(new Error("call_lifecycle_unavailable"));
          }
        })();
      });
      socket.on("message", (data) => this.handleRealtimeEvent(call, data.toString()));
      socket.once("error", () => {
        if (attached) return;
        clearTimeout(attachTimeout);
        clearTimeout(call.closeTimer);
        this.activeCalls.delete(callId);
        reject(new Error("call_attach_failed"));
      });
      socket.on("close", () => {
        clearTimeout(attachTimeout);
        clearTimeout(call.closeTimer);
        this.activeCalls.delete(callId);
        void this.finishCallLifecycle(
          call,
          attached && call.outcome !== "service_restart" ? "completed" : "failed",
        );
        if (!attached) reject(new Error("call_closed_before_attach"));
      });
    });
  }

  private async acceptOrResume(callId: string, fromUri: string | undefined, metadata: CallAttachmentMetadata): Promise<void> {
    try {
      await this.accept(callId);
      await this.attachCall(callId, fromUri, true, metadata);
    } catch (error) {
      // A conflict means another attempt may already have accepted the call.
      // Attach is the safe idempotent recovery probe; no speech is repeated.
      if (error instanceof RealtimeCallApiError && error.status === 409) {
        await this.attachCall(callId, fromUri, false, metadata);
        return;
      }
      throw error;
    }
  }

  private handleRealtimeEvent(call: ActiveCall, raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const itemId = event.item_id ?? "";
      if (!CALL_ID.test(itemId)) return;
      call.inputSequence += 1;
      const sequence = call.inputSequence;
      call.queuedRoutes.length = 0;
      call.turnChain = call.turnChain
        .then(() => this.processTranscript(call, itemId, event.transcript ?? "", sequence))
        .catch(() => undefined);
      return;
    }
    if (event.type === "response.done") {
      const route = call.activeRoute;
      if (!route) return;
      call.activeRoute = undefined;
      const completed = event.response?.status === "completed";
      void (async () => {
        try {
          if (completed) await this.applyEffectAfterSpeech(call, route);
        } finally {
          call.responseInFlight = false;
          this.flush(call);
        }
      })();
    }
  }

  private async processTranscript(call: ActiveCall, itemId: string, transcript: string, sequence: number): Promise<void> {
    if (!readPstnRuntimeState().enabled) {
      call.outcome = "kill_switch";
      this.enqueueSpeech(call, {
        intent: "end",
        approvedSpeech: "This test phone service has been turned off. No official action was completed. Please try the secure website or contact the Treasurer's Office directly.",
        effect: "end_call",
        offerSecureLink: false,
        locale: "en",
      });
      return;
    }
    call.turnCount += 1;
    const maximumTurns = boundedInteger(process.env.CIVYA_PSTN_MAX_TURNS, 30, 1, 100);
    if (call.turnCount > maximumTurns) {
      call.outcome = "maximum_turns";
      this.enqueueSpeech(call, {
        intent: "end",
        approvedSpeech: "This test call has reached its turn limit. No official action was completed. Please continue through the secure website or ask a person for help.",
        effect: "end_call",
        offerSecureLink: false,
        locale: "en",
      });
      return;
    }

    const control = routePhoneControlTranscript(transcript, call.state);
    let route: PhoneRoute;
    if (control) {
      route = control;
    } else {
      try {
        const result = await this.requestPhoneTurn({
          transcript: transcript.trim().slice(0, 2_000),
          call_reference_digest: call.callReferenceDigest,
          provider_item_id: itemId,
          idempotency_key: `phone_turn_${call.callReferenceDigest}_${itemId}`,
          locale_hint: call.state.locale,
        });
        if (result.language_status === "fallback") this.metrics.languageFallbacks += 1;
        route = {
          intent: result.escalated ? "urgent_notice" : "menu",
          approvedSpeech: result.approved_speech,
          effect: "none",
          offerSecureLink: result.offer_secure_link,
          locale: result.locale,
        };
      } catch {
        this.metrics.phoneTurnFailures += 1;
        route = routePhoneTranscript(transcript, call.state);
      }
    }
    if (sequence !== call.inputSequence) return;
    call.state = { offeredSecureLink: route.offerSecureLink, locale: route.locale };
    this.enqueueSpeech(call, route);
  }

  private async applyEffectAfterSpeech(call: ActiveCall, route: PhoneRoute): Promise<void> {
    if (route.effect === "transfer_human") {
      this.metrics.transferRequested += 1;
      const target = process.env.CIVYA_HUMAN_TRANSFER_URI?.trim();
      if (target && /^(?:tel:\+[1-9]\d{7,14}|sip:[^\s@]+@[^\s@]+)$/i.test(target)) {
        try {
          await this.callApi(call.callId, "refer", { target_uri: target });
          call.outcome = "transfer_requested";
          return;
        } catch {
          this.enqueueSpeech(call, fallbackHumanRoute(route.locale));
          return;
        }
      }
      this.enqueueSpeech(call, fallbackHumanRoute(route.locale));
      return;
    }
    if (route.effect === "send_secure_link") {
      this.metrics.secureLinkRequested += 1;
      const sent = await this.issueSecureLink(call.callId, call.fromUri);
      call.outcome = sent ? "secure_link_requested" : "secure_link_failed";
      if (!sent) this.enqueueSpeech(call, fallbackLinkRoute(route.locale));
      return;
    }
    if (route.effect === "end_call") {
      call.outcome = call.outcome === "completed" ? "caller_ended" : call.outcome;
      await this.hangup(call.callId).catch(() => undefined);
      call.socket.close(1000, "approved_end");
    }
  }

  private async issueSecureLink(callId: string, fromUri: string | undefined): Promise<boolean> {
    const endpoint = process.env.CIVYA_SECURE_LINK_ISSUER_URL?.trim();
    const secret = process.env.CIVYA_INTERNAL_SERVICE_SECRET?.trim();
    if (!endpoint || !secret || !fromUri) return false;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: "phone_resume",
          destination: fromUri,
          idempotency_key: `phone_resume_${createHash("sha256").update(callId).digest("hex")}`,
        }),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private enqueueSpeech(call: ActiveCall, route: PhoneRoute): void {
    call.queuedRoutes.push(route);
    this.flush(call);
  }

  private flush(call: ActiveCall): void {
    if (call.responseInFlight || call.socket.readyState !== WebSocket.OPEN) return;
    const route = call.queuedRoutes.shift();
    if (!route) return;
    call.responseInFlight = true;
    call.activeRoute = route;
    call.socket.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: `Speak exactly this approved text with no additions or changes:\n\n${route.approvedSpeech}`,
      },
    }));
  }

  private async finishCallLifecycle(call: ActiveCall, desired: "completed" | "failed"): Promise<void> {
    if (call.callSession.status === "completed" || call.callSession.status === "failed") return;
    const nextStatus = call.callSession.status === "received" ? "failed" : desired;
    const metadata = {
      participant_alias: call.participantAlias,
      admission_mode: call.admissionMode,
      locale: call.state.locale,
      outcome: call.outcome,
      recording_state: "disabled",
      turn_count: call.turnCount,
      duration_seconds: Math.max(0, Math.round((Date.now() - call.startedAtMs) / 1_000)),
    };
    try {
      call.callSession = await this.jobs.controlCall({
        callSessionId: call.callSession.callSessionId,
        expectedRowVersion: call.callSession.rowVersion,
        nextStatus,
        eventType: nextStatus === "completed" ? "call.completed" : "call.failed",
        payloadSha256: createHash("sha256").update(JSON.stringify(metadata)).digest("hex"),
        redactedMetadata: metadata,
      });
    } catch {
      // The provider event remains durable; reconciliation can repair a lost
      // lifecycle close without retaining caller speech or phone numbers.
    }
  }

  private reject(callId: string, statusCode: number): Promise<void> {
    return this.callApi(callId, "reject", { status_code: statusCode });
  }

  /**
   * Public admission is intentionally bounded per caller identity. The map
   * contains only tenant-keyed digests, expires entries hourly, and is capped
   * so a barrage of new caller IDs cannot grow worker memory without limit.
   */
  private allowPublicCaller(participantDigest: string): boolean {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1_000;
    for (const [digest, starts] of this.publicCallStarts) {
      const recent = starts.filter((startedAt) => startedAt >= cutoff);
      if (recent.length === 0) this.publicCallStarts.delete(digest);
      else this.publicCallStarts.set(digest, recent);
    }
    const limit = boundedInteger(process.env.CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR, 3, 1, 20);
    const starts = this.publicCallStarts.get(participantDigest) ?? [];
    if (starts.length >= limit) return false;
    if (!this.publicCallStarts.has(participantDigest) && this.publicCallStarts.size >= 1_000) {
      const oldest = this.publicCallStarts.keys().next().value;
      if (oldest) this.publicCallStarts.delete(oldest);
    }
    this.publicCallStarts.set(participantDigest, [...starts, now]);
    return true;
  }

  private hangup(callId: string): Promise<void> {
    return this.callApi(callId, "hangup");
  }

  private async callApi(callId: string, operation: "accept" | "reject" | "refer" | "hangup", body?: unknown): Promise<void> {
    if (!CALL_ID.test(callId)) throw new Error("Invalid call reference.");
    const response = await this.fetcher(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RealtimeCallApiError(operation, response.status);
  }
}

export class RealtimeCallApiError extends Error {
  constructor(readonly operation: string, readonly status: number) {
    super(`Realtime call ${operation} failed with status ${status}.`);
    this.name = "RealtimeCallApiError";
  }
}

/**
 * Realtime safety identifiers must be stable without exposing a phone number,
 * SIP address, or provider call reference. The caller URI is the closest
 * available end-user identity; calls without one use an opaque per-call
 * fallback so every trusted-backend connection still carries the header.
 */
export function buildRealtimeConnectionHeaders(
  apiKey: string | undefined,
  callId: string,
  fromUri?: string,
): { Authorization: string; "OpenAI-Safety-Identifier": string } {
  const key = apiKey?.trim();
  if (!key) throw new Error("OpenAI API key is required for a Realtime connection.");
  const digestSecret = process.env.CIVYA_PHONE_DIGEST_SECRET?.trim() ?? "";
  if (Buffer.byteLength(digestSecret) < 32) throw new Error("Phone digest secret is required for a Realtime connection.");
  const stableSubject = fromUri?.trim()
    ? `phone-origin:${fromUri.trim().toLowerCase()}`
    : `provider-call:${callId}`;
  return {
    Authorization: `Bearer ${key}`,
    "OpenAI-Safety-Identifier": createHmac("sha256", digestSecret).update(stableSubject).digest("hex"),
  };
}

function sipHeader(headers: Array<{ name: string; value: string }>, target: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === target)?.value.slice(0, 500);
}

function fallbackHumanRoute(locale: string): PhoneRoute {
  return locale === "es"
    ? { intent: "human_transfer", effect: "none", offerSecureLink: true, locale, approvedSpeech: "No puedo completar la transferencia en este momento. Puedo enviarle un enlace seguro para pedir ayuda humana sin perder su lugar." }
    : { intent: "human_transfer", effect: "none", offerSecureLink: true, locale, approvedSpeech: "I can't complete the transfer right now. I can text a secure link so you can request human help without losing your place." };
}

function fallbackLinkRoute(locale: string): PhoneRoute {
  return locale === "es"
    ? { intent: "secure_link", effect: "none", offerSecureLink: false, locale, approvedSpeech: "No pude enviar el enlace. No comparta información privada por teléfono. Puedo intentar comunicarle con una persona." }
    : { intent: "secure_link", effect: "none", offerSecureLink: false, locale, approvedSpeech: "I couldn't send the link. Please don't share private information over the phone. I can try to connect you with a person." };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function maximumCallDurationSeconds(admissionMode: PhoneParticipant["admissionMode"]): number {
  const fallback = admissionMode === "public" ? 600 : 1_800;
  return boundedInteger(process.env.CIVYA_PSTN_MAX_DURATION_SECONDS, fallback, 60, 1_800);
}
