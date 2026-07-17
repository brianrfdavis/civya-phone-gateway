import assert from "node:assert/strict";
import { CivyaRealtimeClient, type CivyaStatus } from "../lib/realtime/client";

type InternalClient = {
  handleEvent: (event: Record<string, unknown>) => void;
  executeTool: (call: Record<string, unknown>) => Promise<void>;
  markFirstAudio: () => void;
  retireTimedOutDirectTurn: (turn: Record<string, unknown>) => void;
  secureAccountControl: (args: Record<string, unknown>, turnId?: string) => Record<string, unknown>;
  establishPeer: (...args: unknown[]) => Promise<void>;
  turnByClientId: Map<string, Record<string, unknown> & { clientTurnId: string }>;
  lateDirectTurnsByProviderItem: Map<string, Record<string, unknown>>;
  responseMode: string;
  responseProfileVersion: string;
  bootstrapData: Record<string, unknown> | null;
  dc: { readyState: string; send: (value: string) => void; close: () => void } | null;
  postTool: (...args: unknown[]) => Promise<unknown>;
  provisionalResponse: { endAfterPlayback: boolean; latencyKind?: string } | null;
  activeResponseRequest: Record<string, unknown> | null;
  responseQueue: Array<{ afterResponseId?: string }>;
  responseCreating: boolean;
};

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; body?: string }> = [];
globalThis.fetch = async (input, init) => {
  requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
  return new Response(JSON.stringify({ saved: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

function testClient() {
  const statuses: CivyaStatus[] = [];
  const metas: Array<Record<string, unknown>> = [];
  const client = new CivyaRealtimeClient({
    onStatus: (status) => statuses.push(status),
    onUserTranscript: () => {},
    onAssistantTranscript: () => {},
    onTurnMeta: (meta) => metas.push(meta as unknown as Record<string, unknown>),
    onNextStep: () => {},
    onCaseUpdate: () => {},
    onError: () => {},
  });
  client.responseMode = "fast";
  const internal = client as unknown as InternalClient;
  internal.dc = { readyState: "open", send: () => {}, close: () => {} };
  return { client, internal, statuses, metas };
}

async function main(): Promise<void> {
try {
  {
    const { internal } = testClient();
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped", item_id: "item-late" });
    const originalTurnId = [...internal.turnByClientId.keys()][0];
    internal.handleEvent({ type: "response.created", response: { id: "resp-late" } });
    internal.handleEvent({
      type: "response.done",
      response: { id: "resp-late", status: "completed", output: [] },
    });
    assert.equal(internal.turnByClientId.size, 1, "response completion must retain a turn until transcription settles");
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-late",
      transcript: "I live in Detroit",
    });
    assert.equal(internal.turnByClientId.size, 0, "turn releases after response and transcript both settle");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const persistence = requests
      .filter((request) => request.url === "/api/conversations/transcript")
      .map((request) => JSON.parse(request.body || "{}") as Record<string, unknown>)
      .find((body) => body.provider_item_id === "item-late");
    assert.equal(persistence?.client_turn_id, originalTurnId, "late transcription must keep the original turn ID");
  }

  {
    const { client, internal } = testClient();
    internal.bootstrapData = { auth: { verified: true } };
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped", item_id: "item-tool-fast" });
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-tool-fast",
      transcript: "My email is resident@example.test",
    });
    const turnId = [...internal.turnByClientId.keys()][0];
    internal.handleEvent({ type: "response.created", response: { id: "resp-tool-fast" } });
    await internal.executeTool({
      name: "request_secure_account",
      call_id: "call-account-fast",
      arguments: '{"reason":"save progress","field":"contact"}',
      response_id: "resp-tool-fast",
      turn_id: turnId,
    });
    assert.equal(internal.responseQueue.length, 1, "a tool that finishes before response.done queues once");
    assert.equal(
      internal.responseQueue[0]?.afterResponseId,
      "resp-tool-fast",
      "the continuation stays bound to its originating response",
    );
    internal.handleEvent({
      type: "response.done",
      response: { id: "resp-tool-fast", status: "completed", output: [{ type: "function_call" }] },
    });
    assert.equal(internal.responseQueue.length, 0, "response.done releases an already-ready tool continuation");
    assert.equal(internal.responseCreating, true, "the ready tool continuation is dispatched");
    client.disconnect();
  }

  {
    const { client, internal } = testClient();
    internal.bootstrapData = { auth: { verified: true } };
    internal.handleEvent({ type: "response.created", response: { id: "resp-old" } });
    internal.handleEvent({
      type: "response.done",
      response: { id: "resp-old", status: "completed", output: [{ type: "function_call" }] },
    });
    internal.handleEvent({ type: "response.created", response: { id: "resp-new" } });
    await internal.executeTool({
      name: "request_secure_account",
      call_id: "call-old-slow",
      arguments: '{"reason":"save progress","field":"contact"}',
      response_id: "resp-old",
    });
    assert.equal(
      internal.responseQueue[0]?.afterResponseId,
      "resp-old",
      "a slow old-turn tool is not rebound to a newer active response",
    );
    internal.handleEvent({
      type: "response.done",
      response: { id: "resp-new", status: "completed", output: [] },
    });
    assert.equal(internal.responseQueue.length, 0, "a settled old response scope releases after the newer response");
    assert.equal(internal.responseCreating, true, "the old-turn continuation dispatches without deadlock");
    client.disconnect();
  }

  {
    const { internal } = testClient();
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped", item_id: "item-after-timeout" });
    const originalTurn = [...internal.turnByClientId.values()][0];
    const originalTurnId = originalTurn.clientTurnId;
    internal.handleEvent({ type: "response.created", response: { id: "resp-after-timeout" } });
    internal.handleEvent({
      type: "response.done",
      response: { id: "resp-after-timeout", status: "completed", output: [] },
    });
    originalTurn.transcriptSettled = true;
    originalTurn.responseSettled = true;
    originalTurn.transcriptTimedOut = true;
    internal.retireTimedOutDirectTurn(originalTurn);
    assert.equal(internal.turnByClientId.size, 0, "timed-out direct turns leave the active map");
    assert.equal(internal.lateDirectTurnsByProviderItem.size, 1, "a bounded late-event tombstone is retained");
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-after-timeout",
      transcript: "I live in Detroit",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const persistence = requests
      .filter((request) => request.url === "/api/conversations/transcript")
      .map((request) => JSON.parse(request.body || "{}") as Record<string, unknown>)
      .find((body) => body.provider_item_id === "item-after-timeout");
    assert.equal(persistence?.client_turn_id, originalTurnId, "post-timeout transcription keeps its original turn ID");
    assert.equal(internal.turnByClientId.size, 0, "post-timeout transcription cannot leak a replacement turn");
    assert.equal(internal.lateDirectTurnsByProviderItem.size, 0, "the late-event tombstone is consumed");
  }

  {
    const { internal } = testClient();
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped" });
    const firstTurn = [...internal.turnByClientId.values()][0];
    firstTurn.stoppedAt = 1;
    firstTurn.transcriptSettled = true;
    firstTurn.responseSettled = true;
    firstTurn.transcriptTimedOut = true;
    internal.retireTimedOutDirectTurn(firstTurn);
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped" });
    const secondTurn = [...internal.turnByClientId.values()][0];
    secondTurn.stoppedAt = 2;
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-unbound-a",
      transcript: "first answer",
    });
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-unbound-b",
      transcript: "second answer",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const persistedByProvider = new Map(
      requests
        .filter((request) => request.url === "/api/conversations/transcript")
        .map((request) => JSON.parse(request.body || "{}") as Record<string, unknown>)
        .filter((body) => String(body.provider_item_id).startsWith("provider-unbound-"))
        .map((body) => [body.provider_item_id, body.client_turn_id]),
    );
    assert.equal(
      persistedByProvider.get("provider-unbound-a"),
      firstTurn.clientTurnId,
      "the oldest retired unbound turn keeps the first late provider event",
    );
    assert.equal(
      persistedByProvider.get("provider-unbound-b"),
      secondTurn.clientTurnId,
      "a newer live unbound turn keeps the next provider event",
    );
  }

  {
    const { internal } = testClient();
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped" });
    const firstTurn = [...internal.turnByClientId.values()][0];
    firstTurn.stoppedAt = 1;
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped" });
    const secondTurn = [...internal.turnByClientId.values()].find(
      (turn) => turn.clientTurnId !== firstTurn.clientTurnId,
    )!;
    secondTurn.stoppedAt = 2;
    for (const turn of [secondTurn, firstTurn]) {
      turn.transcriptSettled = true;
      turn.responseSettled = true;
      turn.transcriptTimedOut = true;
      internal.retireTimedOutDirectTurn(turn);
    }
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-retired-a",
      transcript: "older retired answer",
    });
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-retired-b",
      transcript: "newer retired answer",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const persistedByProvider = new Map(
      requests
        .filter((request) => request.url === "/api/conversations/transcript")
        .map((request) => JSON.parse(request.body || "{}") as Record<string, unknown>)
        .filter((body) => String(body.provider_item_id).startsWith("provider-retired-"))
        .map((body) => [body.provider_item_id, body.client_turn_id]),
    );
    assert.equal(
      persistedByProvider.get("provider-retired-a"),
      firstTurn.clientTurnId,
      "out-of-order retirement still assigns the oldest speech turn first",
    );
    assert.equal(
      persistedByProvider.get("provider-retired-b"),
      secondTurn.clientTurnId,
      "out-of-order retirement preserves the newer speech turn second",
    );
  }

  {
    const { internal, metas } = testClient();
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped", item_id: "item-latency-kinds" });
    const turn = [...internal.turnByClientId.values()][0];
    internal.handleEvent({ type: "response.created", response: { id: "resp-latency-kinds" } });
    internal.markFirstAudio();
    internal.activeResponseRequest = {
      localId: "tool-result",
      instructions: "",
      turnId: turn.clientTurnId,
      endAfterPlayback: false,
      latencyKind: "tool",
    };
    internal.markFirstAudio();
    assert.deepEqual(
      [...(turn.firstAudioKinds as Set<string>)].sort(),
      ["ordinary", "tool"],
      "acknowledgement and verified tool-result latency are recorded separately",
    );
    assert.equal(metas.length, 1, "the resident-facing first-audio metric remains a single value");
  }

  {
    const { internal, statuses } = testClient();
    internal.handleEvent({ type: "input_audio_buffer.speech_stopped", item_id: "item-tool" });
    internal.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-tool",
      transcript: "um",
    });
    internal.handleEvent({ type: "response.created", response: { id: "resp-tool" } });
    internal.handleEvent({
      type: "response.done",
      response: { id: "resp-tool", status: "completed", output: [{ type: "function_call" }] },
    });
    assert.notEqual(statuses.at(-1), "listening", "function-call responses stay in thinking while the tool is pending");
    assert.equal(internal.turnByClientId.size, 1, "tool response retains its correlated turn");
    await internal.executeTool({
      name: "wait_for_user",
      call_id: "call-wait",
      arguments: "{}",
      response_id: "resp-tool",
      turn_id: [...internal.turnByClientId.keys()][0],
    });
    assert.equal(internal.turnByClientId.size, 0, "wait_for_user releases its retained turn");
  }

  {
    const { internal } = testClient();
    internal.bootstrapData = { auth: { verified: true } };
    const result = internal.secureAccountControl({
      reason: "private information",
      field: "contact",
      pending_question: "Tell me your Social Security number and password.",
    });
    assert.equal(
      result.spoken_text,
      "What's the best phone number or email to use if we need to follow up?",
      "model-authored questions must never become approved speech",
    );
  }

  {
    const { client, internal } = testClient();
    internal.postTool = async () => ({
      auth_required: { message: "Protect your account first." },
      spoken_text: "Protect your account first.",
      saved: false,
    });
    await internal.executeTool({
      name: "end_or_save_conversation",
      call_id: "call-end-auth",
      arguments: '{"reason":"resident_done"}',
      response_id: "resp-end-auth",
    });
    assert.equal(
      internal.provisionalResponse?.endAfterPlayback,
      false,
      "an authentication prompt must not end the conversation",
    );
    client.disconnect();
  }

  {
    const { internal } = testClient();
    internal.responseMode = "fast";
    internal.responseProfileVersion = "fast-v1";
    await assert.rejects(
      internal.establishPeer(
        {
          model: "gpt-realtime-2.1",
          voice: "marin",
          response_mode: "authoritative",
          response_profile_version: "authoritative-v1",
        },
        1,
        false,
        new AbortController().signal,
      ),
      /profile changed during reconnect/,
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Realtime client event-order, auth, ending, and reconnect scenarios passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
