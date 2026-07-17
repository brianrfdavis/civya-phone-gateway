"use client";

import { CASE_MGMT_TOOLS } from "./tools";

/** Browser-side OpenAI Realtime session over WebRTC. */
export type CivyaStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface TurnMeta {
  turnId: string;
  layer?: string;
  intent?: string;
  speechToFirstAudioMs?: number;
}

export interface CaseUpdate {
  caseId: string;
  status?: string;
  pathway?: string;
  intakeCollected?: number;
  intakeTotal?: number;
  missingDocuments?: string[];
  nextBestAction?: string;
  checklistSummary?: string;
  reviewRequired?: boolean;
  submissionStatus?: string;
  paymentStatus?: string;
  confirmationNumber?: string;
}

export interface AuthRequiredPayload {
  reason: string;
  message: string;
  pendingQuestion?: string;
  pendingTurnId?: string;
  sensitiveFields?: string[];
}

export interface ResumeTurn {
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
}

export interface ResumeContext {
  confirmedFacts: Record<string, unknown> | unknown[];
  conversationSummary: string;
  recentTurns: ResumeTurn[];
  currentWorkflowState?: Record<string, unknown> | string | null;
  currentQuestion?: string;
}

export interface SessionBootstrap {
  authenticationState?: string;
  resident?: { id: string } | null;
  activeCase?: { id: string; [key: string]: unknown } | null;
  conversation?: { id: string; [key: string]: unknown } | null;
  resumeSummary?: string;
  resumeContext?: ResumeContext;
  nextAction?: Record<string, unknown> | string | null;
  authRequired?: AuthRequiredPayload | null;
}

export interface TurnEnvelope {
  conversation_id?: string;
  provider_item_id: string;
  client_turn_id: string;
  transcript: string;
  channel: "voice" | "text";
  idempotency_key: string;
  pending_turn_id?: string;
}

export interface TurnResult {
  conversation_id?: string;
  client_turn_id?: string;
  pending_turn_id?: string;
  spoken_response?: string;
  case_update?: Record<string, unknown> | null;
  next_question?: string | Record<string, unknown> | null;
  interaction_state?: string | Record<string, unknown> | null;
  interactionState?: string | Record<string, unknown> | null;
  auth_required?: AuthRequiredPayload | Record<string, unknown> | null;
  persistence?: string | Record<string, unknown> | null;
}

export interface CivyaClientEvents {
  onStatus: (status: CivyaStatus, detail?: string) => void;
  onUserTranscript: (text: string, final: boolean) => void;
  onAssistantTranscript: (text: string, final: boolean) => void;
  onTurnMeta: (meta: TurnMeta) => void;
  onNextStep: (nextStep: { title: string; body: string; escalated: boolean }) => void;
  onCaseUpdate: (update: CaseUpdate) => void;
  onError: (message: string) => void;
  onAuthRequired?: (payload: AuthRequiredPayload) => void;
  onTextFallback?: (message: string) => void;
  onConversationEnded?: () => void;
}

interface ToolCall {
  name: string;
  call_id: string;
  arguments: string;
  response_id?: string;
}

interface RealtimeSessionSecret {
  client_secret: string;
  model: string;
  voice: string;
  turn_detection?: string;
}

interface TurnContext {
  clientTurnId: string;
  providerItemId: string;
  stoppedAt: number;
  startedAt: number;
  meta: TurnMeta;
  transcriptTimer?: ReturnType<typeof setTimeout>;
}

interface ResponseRequest {
  localId: string;
  instructions: string;
  approvedText?: string;
  turnId?: string;
  afterResponseId?: string;
  endAfterPlayback: boolean;
}

type JsonObject = Record<string, unknown>;

const TOOL_ROUTES: Record<string, string> = {
  get_cached_answer: "/api/tools/cached-answer",
  lookup_property_status: "/api/tools/property-status",
  // Legacy tools remain callable for explicit actions and compatibility. Facts
  // from ordinary resident turns are now committed by /api/conversations/turn.
  classify_resident_intent: "/api/tools/intent",
  get_program_answer: "/api/tools/program",
  get_next_workflow_step: "/api/tools/workflow",
  get_property_status: "/api/tools/property-status",
  get_resident_case: "/api/tools/resident-case",
  get_program_eligibility: "/api/tools/eligibility",
  get_document_checklist: "/api/tools/document-checklist",
  create_human_followup_request: "/api/tools/human-followup",
  flag_for_human_review: "/api/tools/human-review",
};

const CONNECT_TIMEOUT_MS = 15_000;
const TRANSCRIPT_TIMEOUT_MS = 12_000;
const TURN_REQUEST_TIMEOUT_MS = 15_000;
const TOOL_REQUEST_TIMEOUT_MS = 12_000;
const RESPONSE_CREATE_TIMEOUT_MS = 10_000;
const PLAYBACK_END_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 2;
const PROVISIONAL_RESPONSE_SCOPE = "__creating_response__";
const GREETING =
  "Hi, I'm Civya, an automated assistant for Wayne County property-tax help. I can help explain a notice, check possible options, or find your next step. I'm not the Treasurer, and I can't change an official record. What would you like help with?";

export class CivyaRealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private connectAbort: AbortController | null = null;
  private connectGeneration = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private manualDisconnect = true;
  private ending = false;
  private authPaused = false;
  private microphoneEnabled = true;

  readonly sessionId: string;
  model = "";
  voice = "";
  turnDetection = "";
  residentId: string | null = null;
  caseId: string | null = null;
  conversationId: string | null = null;

  private currentTurnId = "";
  private turnByProviderItem = new Map<string, TurnContext>();
  private turnByClientId = new Map<string, TurnContext>();
  private unboundAudioTurns: TurnContext[] = [];
  private processedTurnKeys = new Set<string>();
  private turnControllers = new Set<AbortController>();

  private bootstrapData: JsonObject | null = null;
  private resumeContext: ResumeContext | null = null;
  private pendingAuth: AuthRequiredPayload | null = null;
  private pendingTurnIdForNextTurn: string | null = null;

  private responseCreating = false;
  private responseCreateTimer: ReturnType<typeof setTimeout> | null = null;
  private provisionalResponse: ResponseRequest | null = null;
  private activeResponseId: string | null = null;
  private activeResponseRequest: ResponseRequest | null = null;
  private responseQueue: ResponseRequest[] = [];
  private responseRequests = new Map<string, ResponseRequest>();
  private assistantBuffers = new Map<string, string>();
  private assistantFinalized = new Set<string>();
  private completedEndResponseIds = new Set<string>();
  private lastOutputStoppedAt = 0;
  private gracefulEndTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private events: CivyaClientEvents) {
    this.sessionId = makeId("sess");
  }

  /**
   * Start voice. Microphone permission starts inside the click gesture while
   * authenticated bootstrap/session setup continues in parallel.
   */
  async connect(providedResumeContext?: ResumeContext): Promise<void> {
    if (this.dc?.readyState === "open") return;

    this.disconnectInternal(false, false);
    this.manualDisconnect = false;
    this.ending = false;
    this.authPaused = false;
    this.reconnectAttempts = 0;
    this.events.onStatus("connecting");

    const generation = ++this.connectGeneration;
    const controller = new AbortController();
    this.connectAbort = controller;
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    try {
      const bootstrap = await this.fetchBootstrap(controller.signal);
      this.applyBootstrap(bootstrap);
      if (providedResumeContext) {
        this.resumeContext = mergeResumeContexts(this.resumeContext, providedResumeContext);
      }

      // Bootstrap runs first so the Realtime route can derive the authenticated
      // resident and bind a stable safety identifier to the client secret.
      const sessionPromise = this.fetchRealtimeSecret(controller.signal);
      const [mic, session] = await Promise.all([micPromise, sessionPromise]);
      if (controller.signal.aborted || generation !== this.connectGeneration) {
        stopStream(mic);
        throw abortError();
      }
      this.mic = mic;
      this.setMicrophoneEnabled(true);
      await this.establishPeer(session, generation, true, controller.signal);
    } catch (error) {
      void micPromise.then((stream) => {
        if (this.mic !== stream || controller.signal.aborted) stopStream(stream);
      }).catch(() => {});
      if (isAbortError(error) && (controller.signal.aborted || this.manualDisconnect)) return;
      this.failToTextMode(error);
      throw error;
    }
  }

  /** Stop immediately when the reviewer explicitly presses Stop. */
  disconnect(): void {
    this.log("session_ended", { reason: "resident_stopped" });
    this.disconnectInternal(true, true);
    this.events.onStatus("idle");
  }

  /** Pause/resume capture without discarding the WebRTC session. */
  setMicrophoneEnabled(enabled: boolean): void {
    this.microphoneEnabled = enabled;
    for (const track of this.mic?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  /** Resume the exact protected question after the email code is verified. */
  async resumeAfterAuth(pendingQuestion?: string): Promise<void> {
    this.pendingAuth = null;
    this.authPaused = false;
    try {
      const bootstrap = await this.fetchBootstrap();
      this.applyBootstrap(bootstrap);
      const auth = objectValue(bootstrap.auth ?? bootstrap.authentication);
      if (stringValue(auth?.state).toLowerCase() === "declined") {
        this.pendingTurnIdForNextTurn = null;
      }
      this.hydrateRealtimeContext(this.resumeContext);
      this.setMicrophoneEnabled(true);
      const question =
        pendingQuestion?.trim() ||
        this.resumeContext?.currentQuestion ||
        this.nextQuestionFromBootstrap() ||
        "You're all set. What would you like help with next?";
      this.events.onStatus("thinking");
      this.speakApproved(question, { turnId: makeId("auth-resume") });
    } catch (error) {
      this.setMicrophoneEnabled(true);
      this.events.onError(
        "Your account is verified, but voice could not restore the next question. Please continue in text mode.",
      );
      this.events.onTextFallback?.(
        "Your account is verified and your progress is safe. Continue in text mode while voice reconnects.",
      );
      throw error;
    }
  }

  /** Typed input during an active voice session follows the same durable turn path. */
  sendText(text: string): void {
    const transcript = text.trim();
    if (!transcript) return;
    const providerItemId = makeId("text-item");
    const turn = this.createTurn(providerItemId);
    this.events.onUserTranscript(transcript, true);
    this.dcSend({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: transcript }],
      },
    });
    void this.submitAuthoritativeTurn(turn, transcript, "text");
  }

  /** Refresh ownership-derived case context; never create records from browser IDs. */
  async ensureCase(): Promise<{ residentId: string; caseId: string }> {
    if (!this.residentId || !this.caseId) {
      this.applyBootstrap(await this.fetchBootstrap());
    }
    if (!this.residentId || !this.caseId) {
      throw new Error("Save progress before uploading a private document.");
    }
    return { residentId: this.residentId, caseId: this.caseId };
  }

  /** Acknowledge an already-authorized, already-persisted upload. */
  notifyUpload(result: {
    file_name: string;
    document_type: string;
    checklist_summary?: string;
  }): void {
    const summary = result.checklist_summary?.trim();
    const spoken = summary
      ? `I received ${result.file_name}. It was added as ${result.document_type}. ${summary}`
      : `I received ${result.file_name}. It was added as ${result.document_type}.`;
    this.speakApproved(spoken, { turnId: makeId("upload") });
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  private async establishPeer(
    session: RealtimeSessionSecret,
    generation: number,
    speakOpening: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.model = session.model;
    this.voice = session.voice;
    this.turnDetection = session.turn_detection ?? "";

    const pc = new RTCPeerConnection();
    const dc = pc.createDataChannel("oai-events");
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "true");

    this.pc = pc;
    this.dc = dc;
    this.audioEl = audioEl;

    pc.ontrack = (event) => {
      if (this.audioEl !== audioEl) return;
      audioEl.srcObject = event.streams[0];
      void audioEl.play().catch(() => {
        this.events.onError("Your browser blocked voice playback. Tap the microphone again or continue in text mode.");
      });
    };
    for (const track of this.mic?.getTracks() ?? []) {
      pc.addTrack(track, this.mic!);
    }

    const opened = new Promise<void>((resolve, reject) => {
      dc.onopen = () => {
        if (signal.aborted || generation !== this.connectGeneration || this.manualDisconnect) {
          reject(abortError());
          return;
        }
        try {
          this.onDataChannelOpen(speakOpening);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      dc.onerror = () => reject(new Error("The secure voice data channel could not open."));
      dc.onclose = () => {
        if (generation === this.connectGeneration) this.scheduleReconnect("data channel closed");
      };
      dc.onmessage = (event) => {
        try {
          this.handleEvent(JSON.parse(event.data) as JsonObject);
        } catch (error) {
          this.events.onError("Voice returned an unreadable event. Your saved progress was not changed.");
          this.log("error", { message: String(error), phase: "realtime_event_parse" });
        }
      };
    });

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || generation !== this.connectGeneration) return;
      if (pc.connectionState === "failed") this.scheduleReconnect("peer connection failed");
      if (pc.connectionState === "disconnected") this.scheduleReconnect("peer connection disconnected", 1_200);
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc || generation !== this.connectGeneration) return;
      if (pc.iceConnectionState === "failed") this.scheduleReconnect("ICE connection failed");
    };

    const offer = await pc.createOffer();
    if (signal.aborted) throw abortError();
    await pc.setLocalDescription(offer);
    const sdpResponse = await this.fetchWithTimeout(
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(this.model)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.client_secret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      },
      CONNECT_TIMEOUT_MS,
      signal,
    );
    if (!sdpResponse.ok) {
      throw new Error(`Realtime voice connection was declined (${sdpResponse.status}).`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
    await promiseWithTimeout(opened, CONNECT_TIMEOUT_MS, "Voice connection timed out.", signal);

    this.log("session_started", {
      model: this.model,
      voice: this.voice,
      turn_detection: this.turnDetection,
      reconnect_attempt: this.reconnectAttempts,
    });
  }

  private onDataChannelOpen(speakOpening: boolean): void {
    this.events.onStatus("listening");
    this.hydrateRealtimeContext(this.resumeContext);

    const auth = this.authRequiredFromBootstrap();
    if (auth) {
      this.pauseForAuth(auth);
      if (speakOpening) this.speakApproved(auth.message, { turnId: makeId("auth") });
    } else if (speakOpening) {
      this.speakApproved(this.openingMessage(), { turnId: makeId("opening") });
    }
    this.drainResponseQueue();
  }

  private scheduleReconnect(reason: string, delayMs = 350): void {
    if (this.manualDisconnect || this.ending || this.authPaused || this.reconnecting || this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.events.onStatus("error");
      this.events.onError("Voice could not reconnect. Your saved progress is safe.");
      this.events.onTextFallback?.(
        "Voice could not reconnect after two tries. Continue in text mode; your case will resume from the same step.",
      );
      this.disconnectInternal(true, true);
      return;
    }

    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    this.events.onStatus("connecting", `reconnecting ${attempt} of ${MAX_RECONNECT_ATTEMPTS}`);
    this.log("reconnect", { attempt, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(attempt);
    }, delayMs * attempt);
  }

  private async reconnect(attempt: number): Promise<void> {
    if (this.manualDisconnect || this.ending || this.authPaused) return;
    this.reconnecting = true;
    const generation = ++this.connectGeneration;
    this.connectAbort?.abort();
    const controller = new AbortController();
    this.connectAbort = controller;
    this.teardownTransport(true);

    try {
      if (!this.mic || this.mic.getAudioTracks().every((track) => track.readyState === "ended")) {
        throw new Error("The microphone is no longer available.");
      }
      const bootstrap = await this.fetchBootstrap(controller.signal);
      this.applyBootstrap(bootstrap);
      const session = await this.fetchRealtimeSecret(controller.signal);
      await this.establishPeer(session, generation, false, controller.signal);
      this.setMicrophoneEnabled(this.microphoneEnabled);
      this.reconnecting = false;
      this.events.onStatus("listening");
      this.log("reconnect_succeeded", { attempt });
    } catch (error) {
      this.reconnecting = false;
      if (!isAbortError(error)) this.scheduleReconnect(String(error), 500);
    }
  }

  private disconnectInternal(markManual: boolean, stopMicrophone: boolean): void {
    this.manualDisconnect = markManual;
    this.connectGeneration += 1;
    this.connectAbort?.abort();
    this.connectAbort = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnecting = false;
    if (this.responseCreateTimer) clearTimeout(this.responseCreateTimer);
    this.responseCreateTimer = null;
    if (this.gracefulEndTimer) clearTimeout(this.gracefulEndTimer);
    this.gracefulEndTimer = null;
    for (const controller of this.turnControllers) controller.abort();
    this.turnControllers.clear();
    for (const turn of this.turnByClientId.values()) {
      if (turn.transcriptTimer) clearTimeout(turn.transcriptTimer);
    }
    this.turnByClientId.clear();
    this.turnByProviderItem.clear();
    this.unboundAudioTurns = [];
    this.teardownTransport(!markManual);
    if (markManual) {
      this.responseQueue = [];
      this.completedEndResponseIds.clear();
    }
    if (stopMicrophone) {
      stopStream(this.mic);
      this.mic = null;
    }
  }

  private teardownTransport(preserveInterruptedResponse: boolean): void {
    if (preserveInterruptedResponse && this.activeResponseRequest) {
      this.responseQueue.unshift({
        ...this.activeResponseRequest,
        localId: makeId("response-retry"),
        afterResponseId: undefined,
      });
    }
    if (
      preserveInterruptedResponse &&
      this.provisionalResponse &&
      this.provisionalResponse.localId !== this.activeResponseRequest?.localId
    ) {
      this.responseQueue.unshift({
        ...this.provisionalResponse,
        localId: makeId("response-retry"),
        afterResponseId: undefined,
      });
    }
    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onmessage = null;
      this.dc.onerror = null;
      this.dc.onclose = null;
      this.dc.close();
    }
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
    }
    this.dc = null;
    this.pc = null;
    this.audioEl = null;
    this.responseCreating = false;
    this.provisionalResponse = null;
    this.activeResponseId = null;
    this.activeResponseRequest = null;
    this.responseRequests.clear();
    this.assistantBuffers.clear();
    this.assistantFinalized.clear();
  }

  private failToTextMode(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.events.onStatus("error");
    this.events.onError(message);
    this.events.onTextFallback?.(
      "High-fidelity voice is unavailable right now. Continue in text mode; any earlier saved progress is safe.",
    );
    this.log("error", { phase: "connect", message });
    this.disconnectInternal(true, true);
  }

  // ── Authoritative turns ───────────────────────────────────────────

  private handleEvent(event: JsonObject): void {
    const type = stringValue(event.type);
    switch (type) {
      case "session.created":
      case "session.updated":
        break;

      case "input_audio_buffer.speech_started":
        this.events.onStatus("listening", "hearing you");
        break;

      case "input_audio_buffer.speech_stopped": {
        const suppliedItemId = stringValue(event.item_id);
        const providerItemId = suppliedItemId || makeId("unbound-audio-item");
        const turn = this.createTurn(providerItemId);
        if (!suppliedItemId) this.unboundAudioTurns.push(turn);
        turn.transcriptTimer = setTimeout(() => {
          if (!this.turnByClientId.has(turn.clientTurnId)) return;
          this.removeTurn(turn);
          this.events.onStatus("listening");
          this.events.onError("I couldn't confirm that audio. Please say it once more.");
        }, TRANSCRIPT_TIMEOUT_MS);
        this.events.onStatus("thinking");
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = stringValue(event.transcript).trim();
        const providerItemId = stringValue(event.item_id) || makeId("audio-item");
        let turn = this.turnByProviderItem.get(providerItemId);
        if (!turn && this.unboundAudioTurns.length) {
          turn = this.unboundAudioTurns.shift()!;
          this.turnByProviderItem.delete(turn.providerItemId);
          turn.providerItemId = providerItemId;
          this.turnByProviderItem.set(providerItemId, turn);
        }
        turn ??= this.createTurn(providerItemId);
        if (turn.transcriptTimer) clearTimeout(turn.transcriptTimer);
        if (!isMeaningfulTranscript(transcript)) {
          this.removeTurn(turn);
          this.events.onStatus("listening");
          break;
        }
        this.events.onUserTranscript(transcript, true);
        void this.submitAuthoritativeTurn(turn, transcript, "voice");
        break;
      }

      case "conversation.item.input_audio_transcription.failed": {
        const providerItemId = stringValue(event.item_id);
        const turn = providerItemId ? this.turnByProviderItem.get(providerItemId) : undefined;
        if (turn) this.removeTurn(turn);
        this.events.onStatus("listening");
        this.events.onError("I couldn't transcribe that safely. Please say it once more.");
        break;
      }

      case "response.created":
        this.onResponseCreated(event);
        break;

      case "output_audio_buffer.started":
        this.markFirstAudio();
        this.events.onStatus("speaking");
        break;

      case "output_audio_buffer.stopped":
        this.lastOutputStoppedAt = performance.now();
        if (this.completedEndResponseIds.size > 0) {
          this.finishGracefulEnd();
        }
        break;

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this.onAssistantTranscriptDelta(event);
        break;

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        this.onAssistantTranscriptDone(event);
        break;

      case "response.function_call_arguments.done":
        void this.executeTool({
          name: stringValue(event.name),
          call_id: stringValue(event.call_id),
          arguments: stringValue(event.arguments),
          response_id: stringValue(event.response_id) || this.activeResponseId || undefined,
        });
        break;

      case "response.done":
        this.onResponseDone(event);
        break;

      case "error": {
        const message = JSON.stringify(event.error ?? event);
        this.events.onError(message);
        this.log("error", { message });
        break;
      }
    }
  }

  private createTurn(providerItemId: string): TurnContext {
    const existing = this.turnByProviderItem.get(providerItemId);
    if (existing) return existing;
    const now = performance.now();
    const clientTurnId = makeId("turn");
    const turn: TurnContext = {
      clientTurnId,
      providerItemId,
      stoppedAt: now,
      startedAt: now,
      meta: { turnId: clientTurnId },
    };
    this.currentTurnId = clientTurnId;
    this.turnByProviderItem.set(providerItemId, turn);
    this.turnByClientId.set(clientTurnId, turn);
    return turn;
  }

  private removeTurn(turn: TurnContext): void {
    if (turn.transcriptTimer) clearTimeout(turn.transcriptTimer);
    this.turnByProviderItem.delete(turn.providerItemId);
    this.turnByClientId.delete(turn.clientTurnId);
    this.unboundAudioTurns = this.unboundAudioTurns.filter(
      (candidate) => candidate.clientTurnId !== turn.clientTurnId,
    );
  }

  private async submitAuthoritativeTurn(
    turn: TurnContext,
    transcript: string,
    channel: "voice" | "text",
  ): Promise<void> {
    const idempotencyKey = `${this.conversationId ?? this.sessionId}:${turn.providerItemId}:${turn.clientTurnId}`;
    if (this.processedTurnKeys.has(idempotencyKey)) return;
    this.processedTurnKeys.add(idempotencyKey);
    this.events.onStatus("thinking");

    const envelope: TurnEnvelope = {
      conversation_id: this.conversationId ?? undefined,
      provider_item_id: turn.providerItemId,
      client_turn_id: turn.clientTurnId,
      transcript,
      channel,
      idempotency_key: idempotencyKey,
      pending_turn_id: this.pendingTurnIdForNextTurn ?? undefined,
    };
    const controller = new AbortController();
    this.turnControllers.add(controller);
    let responseQueued = false;

    try {
      const result = await this.postTurnWithRetry(envelope, controller.signal);
      responseQueued = this.applyTurnResult(result, turn);
      const rawResult = result as JsonObject;
      if (!rawResult.auth_required && !rawResult.authRequired && envelope.pending_turn_id) {
        this.pendingTurnIdForNextTurn = null;
      }
    } catch (error) {
      if (!isAbortError(error)) {
        const message =
          "I couldn't safely confirm or save that turn. Your earlier progress is still available. Please try again or continue in text.";
        this.events.onError(message);
        this.events.onTextFallback?.(message);
        this.log("turn_failed", {
          client_turn_id: turn.clientTurnId,
          provider_item_id: turn.providerItemId,
          message: String(error),
        });
        if (this.dc?.readyState === "open") this.events.onStatus("listening");
      }
    } finally {
      this.turnControllers.delete(controller);
      if (turn.transcriptTimer) clearTimeout(turn.transcriptTimer);
      this.turnByProviderItem.delete(turn.providerItemId);
      if (!responseQueued) this.turnByClientId.delete(turn.clientTurnId);
    }
  }

  private async postTurnWithRetry(
    envelope: TurnEnvelope,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(
          "/api/conversations/turn",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": envelope.idempotency_key,
            },
            body: JSON.stringify(envelope),
          },
          TURN_REQUEST_TIMEOUT_MS,
          signal,
        );
        const json = await readJson(response);
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          const message = stringValue(json.error) || `Turn processing failed (${response.status}).`;
          if (!retryable) throw new NonRetryableTurnError(message);
          if (attempt === 2) throw new Error(message);
          lastError = new Error(message);
        } else {
          const result = objectValue(json.result) ?? json;
          return result as TurnResult;
        }
      } catch (error) {
        if (error instanceof NonRetryableTurnError) throw error;
        if (isAbortError(error) && signal.aborted) throw error;
        lastError = error;
        if (attempt === 2) break;
      }
      await wait(250 * attempt, signal);
    }
    throw lastError instanceof Error ? lastError : new Error("Turn processing failed.");
  }

  private applyTurnResult(result: TurnResult, turn: TurnContext): boolean {
    const raw = result as JsonObject;
    const conversationId = stringValue(raw.conversation_id) || stringValue(raw.conversationId);
    if (conversationId) this.conversationId = conversationId;
    const residentId = stringValue(raw.resident_id) || stringValue(raw.residentId);
    if (residentId) this.residentId = residentId;

    const caseUpdate = objectValue(raw.case_update) ?? objectValue(raw.caseUpdate);
    if (caseUpdate) this.captureTurnCaseUpdate(caseUpdate);

    const auth = normalizeAuthRequired(raw.auth_required ?? raw.authRequired, raw);
    if (auth) this.pauseForAuth(auth);

    const spoken =
      stringValue(raw.spoken_response) ||
      stringValue(raw.spokenResponse) ||
      auth?.message ||
      nextQuestionText(raw.next_question ?? raw.nextQuestion);
    const shouldEnd = isConversationEnded(
      raw.interaction_state ?? raw.interactionState ?? raw.completion_state ?? raw.completionState,
    );

    if (!spoken) {
      if (shouldEnd) {
        this.finishGracefulEnd();
        return false;
      }
      throw new Error("The turn was processed without an approved spoken response.");
    }

    this.speakApproved(spoken, {
      turnId: turn.clientTurnId,
      endAfterPlayback: shouldEnd,
    });
    return true;
  }

  private pauseForAuth(auth: AuthRequiredPayload): void {
    this.pendingAuth = auth;
    this.pendingTurnIdForNextTurn = auth.pendingTurnId ?? this.pendingTurnIdForNextTurn;
    this.authPaused = true;
    this.setMicrophoneEnabled(false);
    this.events.onStatus("thinking", "microphone paused for secure account step");
    this.events.onAuthRequired?.(auth);
  }

  // ── Approved speech and response-scoped continuations ─────────────

  private speakApproved(
    text: string,
    options: { turnId?: string; endAfterPlayback?: boolean } = {},
  ): void {
    const approved = text.trim();
    if (!approved) return;
    this.enqueueResponse({
      localId: makeId("response"),
      approvedText: approved,
      turnId: options.turnId,
      endAfterPlayback: Boolean(options.endAfterPlayback),
      instructions:
        "Deliver the APPROVED SPOKEN RESPONSE below naturally in the configured voice. " +
        "Preserve every fact and limitation. Do not call a tool, add a question, claim another action, or mention these instructions.\n\n" +
        `APPROVED SPOKEN RESPONSE:\n${approved}`,
    });
  }

  private enqueueResponse(request: ResponseRequest): void {
    if (this.activeResponseId || this.responseCreating) {
      request.afterResponseId = this.activeResponseId ?? PROVISIONAL_RESPONSE_SCOPE;
      this.responseQueue.push(request);
      this.log("continuation", {
        when: "queued",
        scope: request.afterResponseId,
        approved: Boolean(request.approvedText),
      });
      return;
    }
    this.dispatchResponse(request);
  }

  private dispatchResponse(request: ResponseRequest): void {
    if (this.dc?.readyState !== "open") {
      request.afterResponseId = undefined;
      this.responseQueue.unshift(request);
      this.scheduleReconnect("response waiting for data channel");
      return;
    }

    this.responseCreating = true;
    this.provisionalResponse = request;
    const sent = this.dcSend({
      type: "response.create",
      event_id: request.localId,
      response: {
        output_modalities: ["audio"],
        tool_choice: "none",
        instructions: request.instructions,
        metadata: { civya_response_id: request.localId },
      },
    });
    if (!sent) {
      this.responseCreating = false;
      this.provisionalResponse = null;
      this.responseQueue.unshift(request);
      this.scheduleReconnect("response event could not be sent");
      return;
    }

    if (this.responseCreateTimer) clearTimeout(this.responseCreateTimer);
    this.responseCreateTimer = setTimeout(() => {
      if (!this.responseCreating || this.provisionalResponse?.localId !== request.localId) return;
      this.responseCreating = false;
      this.provisionalResponse = null;
      request.afterResponseId = undefined;
      this.responseQueue.unshift(request);
      this.scheduleReconnect("Realtime did not acknowledge the response");
    }, RESPONSE_CREATE_TIMEOUT_MS);
    this.log("continuation", { when: "dispatched", approved: Boolean(request.approvedText) });
  }

  private onResponseCreated(event: JsonObject): void {
    if (this.responseCreateTimer) clearTimeout(this.responseCreateTimer);
    this.responseCreateTimer = null;
    const response = objectValue(event.response);
    const responseId = stringValue(response?.id) || stringValue(event.response_id) || makeId("provider-response");
    const metadata = objectValue(response?.metadata);
    const localId = stringValue(metadata?.civya_response_id);
    let request = this.provisionalResponse;
    if (!request && localId) {
      const queuedIndex = this.responseQueue.findIndex((item) => item.localId === localId);
      if (queuedIndex >= 0) [request] = this.responseQueue.splice(queuedIndex, 1);
    }
    request ??= {
      localId: makeId("response-external"),
      instructions: "",
      endAfterPlayback: false,
    };
    if (localId && this.reconnectTimer && this.pc?.connectionState === "connected") {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempts = Math.max(0, this.reconnectAttempts - 1);
    }
    this.responseCreating = false;
    this.provisionalResponse = null;
    this.activeResponseId = responseId;
    this.activeResponseRequest = request;
    this.responseRequests.set(responseId, request);

    for (const queued of this.responseQueue) {
      if (queued.afterResponseId === PROVISIONAL_RESPONSE_SCOPE) queued.afterResponseId = responseId;
    }
  }

  private onResponseDone(event: JsonObject): void {
    const response = objectValue(event.response);
    const responseId = stringValue(response?.id) || stringValue(event.response_id) || this.activeResponseId || "";
    const status = stringValue(response?.status);
    const request = this.responseRequests.get(responseId) ?? this.activeResponseRequest;
    const turn = request?.turnId ? this.turnByClientId.get(request.turnId) : undefined;
    const responseSucceeded = !status || status === "completed";

    if (turn) {
      const total = Math.round(performance.now() - turn.startedAt);
      this.log("latency", { event_type: "turn_total", milliseconds: total, turn_id: turn.clientTurnId });
      this.turnByClientId.delete(turn.clientTurnId);
    }
    if (
      request?.approvedText &&
      !this.assistantFinalized.has(responseId) &&
      responseSucceeded
    ) {
      this.assistantFinalized.add(responseId);
      this.events.onAssistantTranscript(request.approvedText, true);
    }
    if (request?.approvedText && !responseSucceeded && status !== "cancelled") {
      const message =
        "Civya saved the turn, but voice could not finish the approved response. Continue in text mode to see the saved next step.";
      this.events.onError(message);
      this.events.onTextFallback?.(message);
    }

    const completedEnd = Boolean(request?.endAfterPlayback && responseSucceeded);
    if (completedEnd) {
      this.completedEndResponseIds.add(responseId);
      if (performance.now() - this.lastOutputStoppedAt < 300) {
        this.finishGracefulEnd();
        return;
      }
      if (this.gracefulEndTimer) clearTimeout(this.gracefulEndTimer);
      this.gracefulEndTimer = setTimeout(() => this.finishGracefulEnd(), PLAYBACK_END_TIMEOUT_MS);
    }

    this.responseRequests.delete(responseId);
    this.assistantBuffers.delete(responseId);
    if (this.activeResponseId === responseId || !responseId) {
      this.activeResponseId = null;
      this.activeResponseRequest = null;
    }
    if (!completedEnd) {
      if (this.authPaused) {
        this.events.onStatus("thinking", "microphone paused for secure account step");
      } else {
        this.events.onStatus("listening");
      }
      this.drainResponseQueue(responseId);
    }
  }

  private drainResponseQueue(completedScope?: string): void {
    if (this.activeResponseId || this.responseCreating || this.dc?.readyState !== "open") return;
    let index = this.responseQueue.findIndex(
      (request) => !request.afterResponseId || request.afterResponseId === completedScope,
    );
    if (index < 0 && completedScope) index = 0;
    if (index < 0) return;
    const [next] = this.responseQueue.splice(index, 1);
    const oldScope = next.afterResponseId;
    for (const queued of this.responseQueue) {
      if (queued.afterResponseId === oldScope) queued.afterResponseId = undefined;
    }
    next.afterResponseId = undefined;
    this.dispatchResponse(next);
  }

  private onAssistantTranscriptDelta(event: JsonObject): void {
    this.markFirstAudio();
    const responseId = stringValue(event.response_id) || this.activeResponseId || "unscoped";
    const buffer = (this.assistantBuffers.get(responseId) ?? "") + stringValue(event.delta);
    this.assistantBuffers.set(responseId, buffer);
    this.events.onAssistantTranscript(buffer, false);
  }

  private onAssistantTranscriptDone(event: JsonObject): void {
    const responseId = stringValue(event.response_id) || this.activeResponseId || "unscoped";
    const transcript = stringValue(event.transcript) || this.assistantBuffers.get(responseId) || "";
    if (!transcript) return;
    this.assistantFinalized.add(responseId);
    this.events.onAssistantTranscript(transcript, true);
  }

  private markFirstAudio(): void {
    const request = this.activeResponseRequest ?? this.provisionalResponse;
    if (!request?.turnId) return;
    const turn = this.turnByClientId.get(request.turnId);
    if (!turn || turn.meta.speechToFirstAudioMs !== undefined) return;
    const milliseconds = Math.round(performance.now() - turn.stoppedAt);
    turn.meta.speechToFirstAudioMs = milliseconds;
    this.events.onTurnMeta({ ...turn.meta });
    this.log("latency", {
      event_type: "speech_to_first_audio",
      milliseconds,
      turn_id: turn.clientTurnId,
    });
    this.log("model_used", { model: this.model, turn_detection: this.turnDetection });
  }

  private finishGracefulEnd(): void {
    if (this.ending) return;
    this.ending = true;
    this.log("session_ended", { reason: "authoritative_completion" });
    this.disconnectInternal(true, true);
    this.events.onStatus("idle");
    this.events.onConversationEnded?.();
  }

  // ── Explicit model tools (secondary path) ─────────────────────────

  private async executeTool(call: ToolCall): Promise<void> {
    if (!call.name || !call.call_id) return;
    let output: unknown = { error: `Unknown tool: ${call.name}` };
    const startedAt = performance.now();
    try {
      const args = JSON.parse(call.arguments || "{}") as JsonObject;
      if (CASE_MGMT_TOOLS.has(call.name)) {
        output = await this.postTool("/api/tools/case-mgmt", {
          tool: call.name,
          args: {
            resident_id: this.residentId ?? undefined,
            case_id: this.caseId ?? undefined,
            ...args,
          },
          session_id: this.sessionId,
          idempotency_key: call.call_id,
        }, call.call_id);
        this.captureCaseContext(call.name, output as JsonObject);
      } else if (TOOL_ROUTES[call.name]) {
        output = await this.postTool(TOOL_ROUTES[call.name], {
          ...args,
          case_id: this.caseId ?? undefined,
          resident_id: this.residentId ?? undefined,
          session_id: this.sessionId,
          turn_id: this.currentTurnId,
          idempotency_key: call.call_id,
        }, call.call_id);
      }
    } catch (error) {
      output = { error: String(error), saved: false };
    }

    const result = output as JsonObject;
    this.surfaceToolResult(call.name, result);
    this.dcSend({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(output),
      },
    });

    const followup =
      stringValue(result.assistant_followup) ||
      stringValue(result.spoken_confirmation) ||
      stringValue(result.spoken_summary);
    const instructions = followup
      ? `Speak this verified tool result faithfully without adding claims: ${followup}`
      : "Briefly explain the verified tool result. Do not claim an action succeeded if the result contains an error.";
    this.enqueueResponse({
      localId: makeId("tool-response"),
      instructions,
      turnId: this.currentTurnId || undefined,
      afterResponseId: call.response_id,
      endAfterPlayback: call.name === "end_or_save_conversation" && !result.error,
    });
    this.log("tool_result", {
      tool: call.name,
      has_followup: Boolean(followup),
      tool_ms: Math.round(performance.now() - startedAt),
      saved: !result.error,
    });
  }

  private async postTool(path: string, body: JsonObject, idempotencyKey: string): Promise<unknown> {
    const response = await this.fetchWithTimeout(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      TOOL_REQUEST_TIMEOUT_MS,
    );
    const json = await readJson(response);
    if (!response.ok) throw new Error(stringValue(json.error) || `Tool failed (${response.status}).`);
    return json;
  }

  private surfaceToolResult(name: string, output: JsonObject): void {
    if (name === "get_cached_answer") {
      const turn = this.turnByClientId.get(this.currentTurnId);
      if (turn) {
        turn.meta.layer = stringValue(output.layer) || undefined;
        turn.meta.intent = stringValue(output.intent) || undefined;
        this.events.onTurnMeta({ ...turn.meta });
      }
      if (output.hit && output.next_step_prompt) {
        this.events.onNextStep({
          title: "Suggested next step",
          body: stringValue(output.next_step_prompt),
          escalated: Boolean(output.escalated),
        });
      }
    }
  }

  private captureCaseContext(_tool: string, output: JsonObject): void {
    if (typeof output.resident_id === "string") this.residentId = output.resident_id;
    if (typeof output.case_id === "string") this.caseId = output.case_id;
    const kase = objectValue(output.case);
    if (kase && typeof kase.id === "string") this.caseId = kase.id;
    if (!this.caseId) return;

    const intake = objectValue(output.intake) ?? {};
    const submission = objectValue(kase?.submission) ?? {};
    const payment = objectValue(kase?.payment) ?? {};
    const confirmation = objectValue(output.confirmation) ?? {};
    const relevant =
      output.status || output.missing_documents || output.next_best_action || kase ||
      output.confirmation_number || output.enrollment;
    if (!relevant) return;

    this.events.onCaseUpdate({
      caseId: this.caseId,
      status: stringValue(output.status) || stringValue(kase?.status) || undefined,
      pathway:
        stringValue(output.pathway) ||
        firstArrayString(output.likely_pathways) ||
        firstArrayString(kase?.likelyPathways) ||
        undefined,
      intakeCollected: numberValue(intake.collected),
      intakeTotal: numberValue(intake.total),
      missingDocuments: stringArray(output.missing_documents) ?? stringArray(kase?.missingDocuments),
      nextBestAction: stringValue(output.next_best_action) || stringValue(kase?.nextBestAction) || undefined,
      checklistSummary:
        stringValue(output.checklist_summary) ||
        stringValue(output.checklistSummary) ||
        stringValue(output.spoken_summary) ||
        undefined,
      reviewRequired: Boolean(output.review_required ?? kase?.reviewRequired),
      submissionStatus: stringValue(submission.status) || undefined,
      paymentStatus: stringValue(payment.status) || undefined,
      confirmationNumber:
        stringValue(output.confirmation_number) ||
        stringValue(confirmation.confirmation_number) ||
        stringValue(submission.confirmationNumber) ||
        stringValue(payment.confirmationNumber) ||
        undefined,
    });
  }

  private captureTurnCaseUpdate(update: JsonObject): void {
    const nestedCase = objectValue(update.case);
    const caseId =
      stringValue(update.case_id) ||
      stringValue(update.caseId) ||
      stringValue(update.id) ||
      stringValue(nestedCase?.id) ||
      this.caseId ||
      "";
    if (!caseId) return;
    this.caseId = caseId;
    this.events.onCaseUpdate({
      caseId,
      status: stringValue(update.status) || stringValue(nestedCase?.status) || undefined,
      pathway: stringValue(update.pathway) || firstArrayString(update.likely_pathways) || undefined,
      intakeCollected: numberValue(update.intake_collected ?? update.intakeCollected),
      intakeTotal: numberValue(update.intake_total ?? update.intakeTotal),
      missingDocuments: stringArray(update.missing_documents ?? update.missingDocuments),
      nextBestAction: stringValue(update.next_best_action ?? update.nextBestAction) || undefined,
      checklistSummary: stringValue(update.checklist_summary ?? update.checklistSummary) || undefined,
      reviewRequired: Boolean(update.review_required ?? update.reviewRequired),
      submissionStatus: stringValue(update.submission_status ?? update.submissionStatus) || undefined,
      paymentStatus: stringValue(update.payment_status ?? update.paymentStatus) || undefined,
      confirmationNumber: stringValue(update.confirmation_number ?? update.confirmationNumber) || undefined,
    });
  }

  // ── Bootstrap and hydration ───────────────────────────────────────

  private async fetchBootstrap(signal?: AbortSignal): Promise<JsonObject> {
    const response = await this.fetchWithTimeout(
      "/api/bootstrap",
      { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
      CONNECT_TIMEOUT_MS,
      signal,
    );
    const json = await readJson(response);
    if (!response.ok) throw new Error(stringValue(json.error) || `Session restore failed (${response.status}).`);
    return objectValue(json.bootstrap) ?? json;
  }

  private async fetchRealtimeSecret(signal: AbortSignal): Promise<RealtimeSessionSecret> {
    const response = await this.fetchWithTimeout(
      "/api/realtime/session",
      { method: "POST", headers: { Accept: "application/json" } },
      CONNECT_TIMEOUT_MS,
      signal,
    );
    const json = await readJson(response);
    if (!response.ok) {
      const message = stringValue(json.error) || `Voice session setup failed (${response.status}).`;
      throw new Error(message);
    }
    const secret = stringValue(json.client_secret);
    const model = stringValue(json.model);
    const voice = stringValue(json.voice);
    if (!secret || !model || !voice) throw new Error("Voice session setup returned incomplete credentials.");
    return {
      client_secret: secret,
      model,
      voice,
      turn_detection: stringValue(json.turn_detection) || undefined,
    };
  }

  private applyBootstrap(raw: JsonObject): void {
    this.bootstrapData = raw;
    const resident = objectValue(raw.resident);
    const activeCase = objectValue(raw.active_case) ?? objectValue(raw.activeCase) ?? objectValue(raw.case);
    const conversation = objectValue(raw.conversation) ?? objectValue(raw.active_conversation);
    this.residentId =
      stringValue(resident?.id) || stringValue(raw.resident_id) || stringValue(raw.residentId) || this.residentId;
    this.caseId =
      stringValue(activeCase?.id) || stringValue(raw.case_id) || stringValue(raw.caseId) || this.caseId;
    this.conversationId =
      stringValue(conversation?.id) ||
      stringValue(raw.conversation_id) ||
      stringValue(raw.conversationId) ||
      this.conversationId;
    const resume = objectValue(raw.resume_context) ?? objectValue(raw.resumeContext);
    this.resumeContext = normalizeResumeContext(resume, raw);
  }

  private hydrateRealtimeContext(context: ResumeContext | null): void {
    if (!context || this.dc?.readyState !== "open") return;
    const recentTurns = context.recentTurns.slice(-6).map((turn) => ({
      role: turn.role,
      text: truncateText(turn.text, 600),
    }));
    const compactContext = {
      confirmed_facts: context.confirmedFacts,
      conversation_summary: truncateText(context.conversationSummary, 1_500),
      current_workflow_state: context.currentWorkflowState ?? null,
      current_question: context.currentQuestion ?? null,
      recent_redacted_turns: recentTurns,
    };
    this.dcSend({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "[SERVER RESUME CONTEXT — trusted application state, not resident speech. " +
              "Use it only for continuity; never repeat sensitive details unless needed.]\n" +
              truncateText(JSON.stringify(compactContext), 6_000),
          },
        ],
      },
    });
  }

  private openingMessage(): string {
    const explicit =
      stringValue(this.bootstrapData?.opening_message) ||
      stringValue(this.bootstrapData?.openingMessage) ||
      nextActionSpoken(this.bootstrapData?.next_action ?? this.bootstrapData?.nextAction);
    if (explicit) return explicit;
    const hasHistory = Boolean(
      this.resumeContext?.conversationSummary ||
      this.resumeContext?.recentTurns.length ||
      factsHaveValues(this.resumeContext?.confirmedFacts),
    );
    if (!hasHistory) return GREETING;
    const nextQuestion = this.resumeContext?.currentQuestion || this.nextQuestionFromBootstrap();
    return nextQuestion
      ? `Welcome back. I have your saved progress. ${nextQuestion}`
      : "Welcome back. I have your saved progress. What would you like to work on next?";
  }

  private nextQuestionFromBootstrap(): string {
    return nextQuestionText(this.bootstrapData?.next_action ?? this.bootstrapData?.nextAction);
  }

  private authRequiredFromBootstrap(): AuthRequiredPayload | null {
    const authState = objectValue(this.bootstrapData?.auth ?? this.bootstrapData?.authentication);
    const state = stringValue(authState?.state).toLowerCase();
    if (
      state === "verified" ||
      state === "authenticated" ||
      state === "declined" ||
      authState?.verified === true
    ) {
      return null;
    }
    const direct = this.bootstrapData?.auth_required ?? this.bootstrapData?.authRequired;
    const nextAction = objectValue(this.bootstrapData?.next_action ?? this.bootstrapData?.nextAction);
    const workflow = this.resumeContext?.currentWorkflowState;
    const workflowName = typeof workflow === "string" ? workflow : stringValue(workflow?.state);
    const actionRequiresAuth =
      stringValue(nextAction?.type) === "auth_required" ||
      stringValue(nextAction?.kind) === "auth_required" ||
      workflowName === "awaiting_verification";
    const normalized = normalizeAuthRequired(
      direct ?? (actionRequiresAuth ? nextAction : null),
      this.bootstrapData ?? {},
    );
    if (normalized && !normalized.pendingQuestion) {
      normalized.pendingQuestion =
        this.resumeContext?.currentQuestion || nextQuestionText(nextAction) || undefined;
    }
    return normalized;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private dcSend(event: unknown): boolean {
    if (this.dc?.readyState !== "open") return false;
    this.dc.send(JSON.stringify(event));
    return true;
  }

  private async fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal, credentials: "same-origin" });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
    }
  }

  private log(type: string, data: JsonObject): void {
    void fetch("/api/tools/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: this.sessionId,
        conversation_id: this.conversationId,
        turn_id: this.currentTurnId,
        type,
        data,
      }),
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {});
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function firstArrayString(value: unknown): string | undefined {
  return stringArray(value)?.[0];
}

function makeId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 12);
  return `${prefix}-${id}`;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function abortError(): DOMException {
  return new DOMException("Operation was cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class NonRetryableTurnError extends Error {}

function isMeaningfulTranscript(text: string): boolean {
  if (!text.trim()) return false;
  return !/^[\s.]*[\[(]?(?:silence|inaudible|noise|music)[\])]?[\s.]*$/i.test(text);
}

async function readJson(response: Response): Promise<JsonObject> {
  const value = await response.json().catch(() => ({}));
  return objectValue(value) ?? {};
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      handler();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function normalizeResumeContext(source: JsonObject | null, root: JsonObject): ResumeContext {
  const value = source ?? {};
  const facts = value.confirmed_facts ?? value.confirmedFacts ?? root.confirmed_facts ?? {};
  const rawTurns = value.recent_turns ?? value.recentTurns ?? root.recent_turns ?? [];
  const recentTurns: ResumeTurn[] = Array.isArray(rawTurns)
    ? rawTurns.slice(-6).flatMap((raw) => {
        const turn = objectValue(raw);
        const role = stringValue(turn?.role);
        const text = stringValue(turn?.text) || stringValue(turn?.transcript) || stringValue(turn?.content);
        if ((role !== "user" && role !== "assistant") || !text) return [];
        return [{ role, text, createdAt: stringValue(turn?.created_at ?? turn?.createdAt) || undefined }];
      })
    : [];
  const workflow = value.current_workflow_state ?? value.currentWorkflowState ?? root.current_workflow_state;
  return {
    confirmedFacts:
      (Array.isArray(facts) || objectValue(facts) ? facts : {}) as Record<string, unknown> | unknown[],
    conversationSummary:
      stringValue(value.conversation_summary) ||
      stringValue(value.conversationSummary) ||
      stringValue(root.resume_summary) ||
      stringValue(root.resumeSummary),
    recentTurns,
    currentWorkflowState:
      typeof workflow === "string" || objectValue(workflow) ? (workflow as Record<string, unknown> | string) : null,
    currentQuestion:
      stringValue(value.current_question) ||
      stringValue(value.currentQuestion) ||
      stringValue(value.next_question) ||
      stringValue(value.nextQuestion) ||
      nextQuestionText(root.next_action ?? root.nextAction) ||
      undefined,
  };
}

function mergeResumeContexts(
  authoritative: ResumeContext | null,
  provided: ResumeContext,
): ResumeContext {
  if (!authoritative) return provided;
  return {
    confirmedFacts: factsHaveValues(authoritative.confirmedFacts)
      ? authoritative.confirmedFacts
      : provided.confirmedFacts,
    conversationSummary: authoritative.conversationSummary || provided.conversationSummary,
    recentTurns: authoritative.recentTurns.length ? authoritative.recentTurns : provided.recentTurns,
    currentWorkflowState: authoritative.currentWorkflowState ?? provided.currentWorkflowState,
    currentQuestion: authoritative.currentQuestion || provided.currentQuestion,
  };
}

function normalizeAuthRequired(value: unknown, root: JsonObject): AuthRequiredPayload | null {
  if (!value) return null;
  const auth = objectValue(value) ?? {};
  const enabled = typeof value === "boolean" ? value : auth.required !== false;
  if (!enabled) return null;
  return {
    reason: stringValue(auth.reason) || "sensitive_information",
    message:
      stringValue(auth.message) ||
      stringValue(auth.spoken_explanation) ||
      stringValue(auth.spokenExplanation) ||
      stringValue(root.spoken_response) ||
      "To save your progress and protect private details, please use the secure account card on screen. I'll pause the microphone while you enter your email and six-digit code.",
    pendingQuestion:
      stringValue(auth.pending_question) ||
      stringValue(auth.pendingQuestion) ||
      nextQuestionText(root.next_question ?? root.nextQuestion) ||
      undefined,
    pendingTurnId: stringValue(auth.pending_turn_id) || stringValue(auth.pendingTurnId) || undefined,
    sensitiveFields: stringArray(auth.sensitive_fields ?? auth.sensitiveFields),
  };
}

function nextActionSpoken(value: unknown): string {
  const action = objectValue(value);
  return stringValue(action?.spoken_response) || stringValue(action?.spokenResponse);
}

function nextQuestionText(value: unknown): string {
  if (typeof value === "string") return value;
  const question = objectValue(value);
  return (
    stringValue(question?.question) ||
    stringValue(question?.prompt) ||
    stringValue(question?.text) ||
    stringValue(question?.next_question) ||
    stringValue(question?.nextQuestion)
  );
}

function isConversationEnded(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["conversation_ended", "ended", "resident_done", "complete"].includes(value.toLowerCase());
  }
  const state = objectValue(value);
  if (!state) return false;
  if (state.is_complete === true || state.completed === true || state.ended === true) return true;
  return isConversationEnded(state.status ?? state.state);
}

function factsHaveValues(value: ResumeContext["confirmedFacts"] | undefined): boolean {
  if (!value) return false;
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
