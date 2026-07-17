import assert from "node:assert/strict";
import type {
  ClaimProviderEventInput,
  FoundationJobClient,
  ProviderEventClaimResult,
} from "../lib/jobs";
import { readPstnRuntimeState } from "../services/call-control/config";
import {
  buildRealtimeConnectionHeaders,
  OpenAISipController,
} from "../services/call-control/openai-sip";
import { PHONE_FAST_INSTRUCTIONS } from "../services/call-control/phone-fast";
import { routePhoneTranscript, welcomePhoneRoute } from "../services/call-control/phone-router";

const state = { offeredSecureLink: false, locale: "en" as const };

assert.equal(welcomePhoneRoute().intent, "welcome");
assert.match(welcomePhoneRoute().approvedSpeech, /help you understand/i);
assert.match(welcomePhoneRoute().approvedSpeech, /best next step/i);
assert.match(welcomePhoneRoute().approvedSpeech, /AI assistant/i);
assert.doesNotMatch(
  welcomePhoneRoute().approvedSpeech,
  /not the treasurer|official record|test call|disclaimer/i,
);
assert.match(PHONE_FAST_INSTRUCTIONS, /fast, capable voice advocate/i);
assert.match(PHONE_FAST_INSTRUCTIONS, /Answer first/i);
assert.doesNotMatch(PHONE_FAST_INSTRUCTIONS, /You are not the Wayne County Treasurer/i);

const urgent = routePhoneTranscript("I got a foreclosure notice with a deadline", state);
assert.equal(urgent.intent, "urgent_notice");
assert.equal(urgent.effect, "none");
assert.equal(urgent.offerSecureLink, true);
assert.doesNotMatch(urgent.approvedSpeech, /you qualify|your deadline is|completed/i);

const payment = routePhoneTranscript("Can I pay the balance with a payment plan?", state);
assert.equal(payment.intent, "payment_plan");
assert.match(payment.approvedSpeech, /does not collect card or bank/i);

const document = routePhoneTranscript("Which documents should I upload?", state);
assert.equal(document.intent, "document_readiness");
assert.match(document.approvedSpeech, /private and quarantined/i);

const human = routePhoneTranscript("I need to talk to a person", state);
assert.equal(human.effect, "transfer_human");
for (const naturalRequest of [
  "Put me through to the Treasurer's office",
  "I need to talk to somebody",
  "Can you transfer me?",
]) {
  assert.equal(routePhoneTranscript(naturalRequest, state).effect, "transfer_human", naturalRequest);
}
for (const mentionOnly of [
  "An agent told me to call about my notice",
  "What can a person do?",
  "I don't want to speak to somebody",
]) {
  assert.notEqual(routePhoneTranscript(mentionOnly, state).effect, "transfer_human", mentionOnly);
}
assert.notEqual(routePhoneTranscript("Don't text me a link", state).effect, "send_secure_link");
assert.notEqual(routePhoneTranscript("Please don't hang up", state).effect, "end_call");

const link = routePhoneTranscript("yes", { offeredSecureLink: true, locale: "en" });
assert.equal(link.effect, "send_secure_link");
assert.match(link.approvedSpeech, /only once/i);

const account = routePhoneTranscript("Can I log in with Apple or a passkey?", state);
assert.equal(account.intent, "account_help");
assert.match(account.approvedSpeech, /does not open a County case/i);

const spanish = routePhoneTranscript("Necesito ayuda con un aviso", state);
assert.equal(spanish.locale, "es");
assert.equal(spanish.intent, "urgent_notice");

const menu = routePhoneTranscript("something else", state);
assert.equal(menu.intent, "menu");
assert.match(menu.approvedSpeech, /say person at any time/i);

process.env.CIVYA_PHONE_DIGEST_SECRET = "test-phone-digest-secret-32-bytes-minimum";
const realtimeHeaders = buildRealtimeConnectionHeaders(
  "test-openai-key",
  "call_runtime_001",
  "sip:+13135559876@example.test",
);
assert.equal(realtimeHeaders.Authorization, "Bearer test-openai-key");
assert.match(realtimeHeaders["OpenAI-Safety-Identifier"], /^[0-9a-f]{64}$/);
assert.doesNotMatch(realtimeHeaders["OpenAI-Safety-Identifier"], /13135559876|example/i);
assert.equal(
  realtimeHeaders["OpenAI-Safety-Identifier"],
  buildRealtimeConnectionHeaders(
    "test-openai-key",
    "a_different_call",
    "SIP:+13135559876@EXAMPLE.TEST",
  )["OpenAI-Safety-Identifier"],
  "the same caller must retain one privacy-preserving safety identifier across calls",
);
assert.notEqual(
  realtimeHeaders["OpenAI-Safety-Identifier"],
  buildRealtimeConnectionHeaders("test-openai-key", "call_runtime_001")["OpenAI-Safety-Identifier"],
  "the call-reference fallback must be domain-separated from a caller identity",
);

const PSTN_ENVIRONMENT_KEYS = [
  "CIVYA_ENABLE_PSTN",
  "CIVYA_TELEPHONY_MODE",
  "CIVYA_WAYNE_TENANT_ID",
  "CIVYA_TWILIO_PHONE_NUMBER",
  "CIVYA_ENVIRONMENT",
  "OPENAI_API_KEY",
  "OPENAI_WEBHOOK_SECRET",
  "CIVYA_PHONE_TURN_URL",
  "CIVYA_PHONE_TURN_SERVICE_SECRET",
  "CIVYA_PHONE_DIGEST_SECRET",
  "CIVYA_PSTN_CANARY_TESTERS_JSON",
  "CIVYA_PSTN_ACCESS_MODE",
  "CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR",
  "CIVYA_PSTN_MAX_CONCURRENT_CALLS",
  "CIVYA_PSTN_MAX_TURNS",
  "CIVYA_PSTN_MAX_DURATION_SECONDS",
  "CIVYA_CALL_RECORDING_MODE",
  "CIVYA_LANGUAGE_MODE",
  "CIVYA_PHONE_RESPONSE_MODE",
  "CIVYA_PHONE_REALTIME_MODEL",
  "CIVYA_PHONE_REALTIME_VOICE",
] as const;
const originalPstnEnvironment = Object.fromEntries(
  PSTN_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
);

function setPstnEnvironment(values: Partial<Record<(typeof PSTN_ENVIRONMENT_KEYS)[number], string>>): void {
  for (const key of PSTN_ENVIRONMENT_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

function configuredPstnEnvironment(): void {
  setPstnEnvironment({
    CIVYA_ENABLE_PSTN: "true",
    CIVYA_TELEPHONY_MODE: "live",
    CIVYA_WAYNE_TENANT_ID: "81000000-0000-4000-8000-000000000001",
    CIVYA_TWILIO_PHONE_NUMBER: "+13135550123",
    CIVYA_ENVIRONMENT: "production",
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_WEBHOOK_SECRET: "test-openai-webhook-secret",
    CIVYA_PHONE_TURN_URL: "https://civya.example/api/internal/phone/turn",
    CIVYA_PHONE_TURN_SERVICE_SECRET: "test-phone-turn-service-secret-32-bytes-minimum",
    CIVYA_PHONE_DIGEST_SECRET: "test-phone-digest-secret-32-bytes-minimum",
    CIVYA_PSTN_CANARY_TESTERS_JSON: JSON.stringify({ treasurer: "+13135559876" }),
    CIVYA_PSTN_ACCESS_MODE: "canary",
    CIVYA_CALL_RECORDING_MODE: "disabled",
    CIVYA_LANGUAGE_MODE: "live",
  });
}

function configuredPublicPstnEnvironment(): void {
  setPstnEnvironment({
    CIVYA_ENABLE_PSTN: "true",
    CIVYA_TELEPHONY_MODE: "live",
    CIVYA_WAYNE_TENANT_ID: "81000000-0000-4000-8000-000000000001",
    CIVYA_TWILIO_PHONE_NUMBER: "+13135550123",
    CIVYA_ENVIRONMENT: "production",
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_WEBHOOK_SECRET: "test-openai-webhook-secret",
    CIVYA_PHONE_TURN_URL: "https://civya.example/api/internal/phone/turn",
    CIVYA_PHONE_TURN_SERVICE_SECRET: "test-phone-turn-service-secret-32-bytes-minimum",
    CIVYA_PHONE_DIGEST_SECRET: "test-phone-digest-secret-32-bytes-minimum",
    CIVYA_PSTN_ACCESS_MODE: "public",
    CIVYA_PSTN_PUBLIC_CALLS_PER_HOUR: "1",
    CIVYA_PSTN_MAX_CONCURRENT_CALLS: "2",
    CIVYA_PSTN_MAX_TURNS: "20",
    CIVYA_PSTN_MAX_DURATION_SECONDS: "600",
    CIVYA_CALL_RECORDING_MODE: "disabled",
    CIVYA_LANGUAGE_MODE: "live",
  });
}

const incomingEvent: {
  id: string;
  type: string;
  data: { call_id: string; sip_headers: Array<{ name: string; value: string }> };
} = {
  id: "evt_call_runtime_001",
  type: "realtime.call.incoming",
  data: {
    call_id: "call_runtime_001",
    sip_headers: [
      { name: "from", value: "sip:+13135559876@example.test" },
      { name: "to", value: '"Wayne County" <sip:+13135550123@trunk.example>;tag=opaque' },
      { name: "diversion", value: "<sip:+13135550123@twilio.com>" },
    ],
  },
};

function incomingEventWithDestination(toUri: string, suffix: string) {
  return {
    ...incomingEvent,
    id: `evt_call_destination_${suffix}`,
    data: {
      ...incomingEvent.data,
      sip_headers: incomingEvent.data.sip_headers.map((header) =>
        header.name.toLowerCase() === "diversion" ? { ...header, value: toUri } : { ...header }),
    },
  };
}

const baseClaim: ProviderEventClaimResult = {
  id: "91000000-0000-4000-8000-000000000001",
  state: "processing",
  duplicate: false,
  claimed: true,
  busy: false,
  attempt: 1,
  maxAttempts: 8,
  processingToken: "92000000-0000-4000-8000-000000000001",
  leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
};

function fakeJobs(
  claim: ProviderEventClaimResult,
  finish: (
    eventId: string,
    processingOwner: string,
    processingToken: string,
    outcome: "processed" | "retry" | "failed",
    errorCode?: string,
    retryDelaySeconds?: number,
  ) => Promise<boolean> = async () => true,
): {
  jobs: FoundationJobClient;
  claims: ClaimProviderEventInput[];
} {
  const claims: ClaimProviderEventInput[] = [];
  return {
    claims,
    jobs: {
      async claimProviderEvent(input: ClaimProviderEventInput) {
        claims.push(input);
        return claim;
      },
      finishProviderEventClaim: finish,
      async createCallSession() {
        return {
          callSessionId: "93000000-0000-4000-8000-000000000001",
          status: "received",
          authorityMode: "conversational_only",
          rowVersion: 1,
          duplicate: false,
        };
      },
      async controlCall() {
        return {
          callSessionId: "93000000-0000-4000-8000-000000000001",
          status: "connected",
          authorityMode: "conversational_only",
          rowVersion: 2,
          duplicate: false,
        };
      },
    } as unknown as FoundationJobClient,
  };
}

async function assertDestinationRejected(toUri: string, suffix: string): Promise<void> {
  configuredPstnEnvironment();
  const effects: string[] = [];
  const jobs = fakeJobs(baseClaim, async (_id, _owner, _token, outcome) => {
    effects.push(`finish:${outcome}`);
    return true;
  });
  const controller = new OpenAISipController(jobs.jobs, {
    verifyWebhook: async () => incomingEventWithDestination(toUri, suffix),
    fetch: (async (input, init) => {
      assert.match(String(input), /\/call_runtime_001\/reject$/);
      assert.deepEqual(JSON.parse(String(init?.body)), { status_code: 403 });
      effects.push("reject");
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    attachCall: async () => {
      effects.push("unexpected-attach");
    },
  });
  const result = await controller.handleWebhook(`destination-${suffix}`, new Headers());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { accepted: false, code: "destination_not_allowed" });
  assert.deepEqual(effects, ["reject", "finish:processed"]);
}

async function testCallControlActivationAndClaims(): Promise<void> {
  setPstnEnvironment({ CIVYA_TELEPHONY_MODE: "disabled" });
  const disabledState = readPstnRuntimeState();
  assert.equal(disabledState.enabled, false);
  assert.equal(disabledState.configured, false);
  const disabledJobs = fakeJobs(baseClaim);
  const disabled = new OpenAISipController(disabledJobs.jobs);
  assert.deepEqual(
    await disabled.handleWebhook("{}", new Headers()),
    { status: 503, body: { accepted: false, code: "pstn_disabled" } },
  );
  assert.equal(disabledJobs.claims.length, 0);

  setPstnEnvironment({ CIVYA_ENABLE_PSTN: "true", CIVYA_TELEPHONY_MODE: "live" });
  const incompleteState = readPstnRuntimeState();
  assert.equal(incompleteState.enabled, true);
  assert.equal(incompleteState.configured, false);
  assert.ok(incompleteState.missing.includes("OPENAI_API_KEY"));
  const incompleteJobs = fakeJobs(baseClaim);
  const incomplete = new OpenAISipController(incompleteJobs.jobs);
  assert.deepEqual(
    await incomplete.handleWebhook("{}", new Headers()),
    { status: 503, body: { accepted: false, code: "call_control_not_configured" } },
  );
  assert.equal(incompleteJobs.claims.length, 0);

  for (const malformed of ["3135550123", "+1234", "+13135550123 ", "+013135550123"]) {
    configuredPstnEnvironment();
    process.env.CIVYA_TWILIO_PHONE_NUMBER = malformed;
    const malformedState = readPstnRuntimeState();
    assert.equal(malformedState.configured, false, `${malformed} activated PSTN`);
    assert.ok(malformedState.missing.includes("CIVYA_TWILIO_PHONE_NUMBER"));
  }

  for (const [key, value, expected] of [
    ["CIVYA_PHONE_RESPONSE_MODE", "anything", "CIVYA_PHONE_RESPONSE_MODE=phone_fast|renderer"],
    ["CIVYA_PHONE_REALTIME_MODEL", "unqualified-model", "CIVYA_PHONE_REALTIME_MODEL=qualified"],
    ["CIVYA_PHONE_REALTIME_VOICE", "unknown-voice", "CIVYA_PHONE_REALTIME_VOICE=cedar|marin"],
  ] as const) {
    configuredPstnEnvironment();
    process.env[key] = value;
    const invalidProfileState = readPstnRuntimeState();
    assert.equal(invalidProfileState.configured, false, `${key} must fail closed`);
    assert.ok(invalidProfileState.missing.includes(expected));
  }

  await assertDestinationRejected(
    "sip:+131355501230@trunk.example",
    "longer_prefix",
  );
  await assertDestinationRejected(
    'Wayne +13135550123 <sip:+13135550999@trunk.example>;tag=opaque',
    "display_digits",
  );
  await assertDestinationRejected(
    "Wayne County destination +13135550123",
    "display_only",
  );

  configuredPstnEnvironment();
  let killSwitchVerificationCalls = 0;
  const killSwitchJobs = fakeJobs(baseClaim);
  const killSwitch = new OpenAISipController(killSwitchJobs.jobs, {
    verifyWebhook: async () => {
      killSwitchVerificationCalls += 1;
      return incomingEvent;
    },
  });
  process.env.CIVYA_ENABLE_PSTN = "false";
  const killed = await killSwitch.handleWebhook("{}", new Headers());
  assert.equal(killed.status, 503);
  assert.equal(killed.body.code, "pstn_disabled");
  assert.equal(killSwitchVerificationCalls, 0);
  assert.equal(killSwitchJobs.claims.length, 0);

  configuredPstnEnvironment();
  let unavailableEffects = 0;
  const unavailableController = new OpenAISipController({
    async claimProviderEvent() {
      throw new Error("database unavailable");
    },
    async finishProviderEventClaim() {
      unavailableEffects += 1;
      return true;
    },
  } as unknown as FoundationJobClient, {
    verifyWebhook: async () => incomingEvent,
    fetch: (async () => {
      unavailableEffects += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    attachCall: async () => {
      unavailableEffects += 1;
    },
  });
  const unavailable = await unavailableController.handleWebhook("unavailable", new Headers());
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, "durable_event_store_unavailable");
  assert.equal(unavailable.headers?.["Retry-After"], "5");
  assert.equal(unavailableEffects, 0);

  configuredPstnEnvironment();
  const busyJobs = fakeJobs({
    ...baseClaim,
    claimed: false,
    duplicate: true,
    busy: true,
    processingToken: null,
    retryAfterSeconds: 7,
  });
  let busyEffects = 0;
  const busyController = new OpenAISipController(busyJobs.jobs, {
    verifyWebhook: async () => incomingEvent,
    fetch: (async () => {
      busyEffects += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    attachCall: async () => {
      busyEffects += 1;
    },
  });
  const busy = await busyController.handleWebhook("busy", new Headers());
  assert.equal(busy.status, 503);
  assert.equal(busy.body.code, "provider_event_in_progress");
  assert.equal(busy.headers?.["Retry-After"], "7");
  assert.equal(busyEffects, 0);

  configuredPstnEnvironment();
  const processedJobs = fakeJobs({
    ...baseClaim,
    state: "processed",
    claimed: false,
    duplicate: true,
    processingToken: null,
    leaseExpiresAt: null,
  });
  let duplicateEffects = 0;
  const processedController = new OpenAISipController(processedJobs.jobs, {
    verifyWebhook: async () => incomingEvent,
    fetch: (async () => {
      duplicateEffects += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    attachCall: async () => {
      duplicateEffects += 1;
    },
  });
  const processed = await processedController.handleWebhook("processed", new Headers());
  assert.equal(processed.status, 200);
  assert.equal(processed.body.duplicate, true);
  assert.equal(duplicateEffects, 0);

  configuredPstnEnvironment();
  const order: string[] = [];
  const acceptedJobs = fakeJobs(baseClaim, async (_id, _owner, token, outcome) => {
    assert.equal(token, baseClaim.processingToken);
    order.push(`finish:${outcome}`);
    return true;
  });
  const acceptedController = new OpenAISipController(acceptedJobs.jobs, {
    verifyWebhook: async () => incomingEvent,
    fetch: (async (input, init) => {
      assert.match(String(input), /\/call_runtime_001\/accept$/);
      assert.equal(init?.method, "POST");
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        reasoning: { effort: string };
        instructions: string;
        max_output_tokens: number;
        tools: Array<{ name: string; parameters: { additionalProperties: boolean } }>;
        tool_choice: string;
        audio: {
          input: { turn_detection: { silence_duration_ms: number; create_response: boolean } };
          output: { voice: string };
        };
      };
      assert.equal(request.model, "gpt-realtime-2.1");
      assert.deepEqual(request.reasoning, { effort: "low" });
      assert.match(request.instructions, /capable voice advocate/i);
      assert.match(request.instructions, /Answer first/i);
      assert.doesNotMatch(request.instructions, /Never originate advice|not the Treasurer/i);
      assert.equal(request.max_output_tokens, 256);
      assert.equal(request.tool_choice, "auto");
      assert.deepEqual(request.tools.map((tool) => tool.name), ["get_official_answer"]);
      assert.equal(request.tools[0]?.parameters.additionalProperties, false);
      assert.equal(request.audio.input.turn_detection.silence_duration_ms, 500);
      assert.equal(request.audio.input.turn_detection.create_response, false);
      assert.equal(request.audio.output.voice, "cedar");
      order.push("accept");
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    attachCall: async (_callId, _fromUri, sendWelcome) => {
      assert.equal(sendWelcome, true);
      await Promise.resolve();
      order.push("attach:welcome");
    },
  });
  const accepted = await acceptedController.handleWebhook("accepted", new Headers());
  assert.equal(accepted.status, 200);
  assert.deepEqual(order, ["accept", "attach:welcome", "finish:processed"]);
  assert.equal(acceptedJobs.claims.length, 1);
  assert.equal(acceptedJobs.claims[0].processingOwner.startsWith("call-control:"), true);

  configuredPstnEnvironment();
  const reclaimOrder: string[] = [];
  const reclaimJobs = fakeJobs({ ...baseClaim, duplicate: true, attempt: 2 }, async (_id, _owner, _token, outcome) => {
    reclaimOrder.push(`finish:${outcome}`);
    return true;
  });
  const reclaimController = new OpenAISipController(reclaimJobs.jobs, {
    verifyWebhook: async () => incomingEvent,
    fetch: (async () => {
      reclaimOrder.push("unexpected-accept");
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    attachCall: async (_callId, _fromUri, sendWelcome) => {
      assert.equal(sendWelcome, false);
      reclaimOrder.push("attach:resume");
    },
  });
  assert.equal((await reclaimController.handleWebhook("reclaimed", new Headers())).status, 200);
  assert.deepEqual(reclaimOrder, ["attach:resume", "finish:processed"]);

  configuredPstnEnvironment();
  const conflictOrder: string[] = [];
  const conflictJobs = fakeJobs(baseClaim, async (_id, _owner, _token, outcome) => {
    conflictOrder.push(`finish:${outcome}`);
    return true;
  });
  const conflictController = new OpenAISipController(conflictJobs.jobs, {
    verifyWebhook: async () => incomingEvent,
    fetch: (async () => {
      conflictOrder.push("accept:conflict");
      return new Response(null, { status: 409 });
    }) as typeof fetch,
    attachCall: async (_callId, _fromUri, sendWelcome) => {
      assert.equal(sendWelcome, false);
      conflictOrder.push("attach:resume");
    },
  });
  assert.equal((await conflictController.handleWebhook("conflict", new Headers())).status, 200);
  assert.deepEqual(conflictOrder, ["accept:conflict", "attach:resume", "finish:processed"]);

  configuredPstnEnvironment();
  const finishOutcomes: string[] = [];
  const lostClaimJobs = fakeJobs(baseClaim, async (_id, _owner, _token, outcome) => {
    finishOutcomes.push(outcome);
    return outcome === "retry";
  });
  const lostClaimController = new OpenAISipController(lostClaimJobs.jobs, {
    verifyWebhook: async () => incomingEvent,
    fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
    attachCall: async () => undefined,
  });
  const lostClaim = await lostClaimController.handleWebhook("lost", new Headers());
  assert.equal(lostClaim.status, 503);
  assert.equal(lostClaim.body.code, "call_control_unavailable");
  assert.deepEqual(finishOutcomes, ["processed", "retry"]);

  configuredPublicPstnEnvironment();
  assert.equal(readPstnRuntimeState().configured, true, "public admission must not require a named caller registry");
  const publicEvents = [
    {
      ...incomingEvent,
      id: "evt_public_call_001",
      data: { ...incomingEvent.data, call_id: "call_public_001" },
    },
    {
      ...incomingEvent,
      id: "evt_public_call_002",
      data: { ...incomingEvent.data, call_id: "call_public_002" },
    },
  ];
  let publicEventIndex = 0;
  const publicEffects: string[] = [];
  const publicJobs = fakeJobs(baseClaim);
  const publicController = new OpenAISipController(publicJobs.jobs, {
    verifyWebhook: async () => publicEvents[publicEventIndex++]!,
    fetch: (async (input, init) => {
      const operation = String(input).split("/").at(-1);
      publicEffects.push(`${operation}:${JSON.parse(String(init?.body)).status_code ?? ""}`);
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    attachCall: async () => undefined,
  });
  assert.deepEqual(await publicController.handleWebhook("public-one", new Headers()), { status: 200, body: { accepted: true } });
  assert.deepEqual(await publicController.handleWebhook("public-two", new Headers()), {
    status: 200,
    body: { accepted: false, code: "public_rate_limit_reached" },
  });
  assert.deepEqual(publicEffects, ["accept:", "reject:429"]);
  assert.equal(publicJobs.claims[0]?.redactedPayload?.participant_alias, "public-caller");
  assert.equal(publicJobs.claims[0]?.redactedPayload?.admission_mode, "public");
  assert.doesNotMatch(JSON.stringify(publicJobs.claims[0]?.redactedPayload), /13135559876/);
}

async function main(): Promise<void> {
  try {
    await testCallControlActivationAndClaims();
  } finally {
    for (const key of PSTN_ENVIRONMENT_KEYS) {
      const value = originalPstnEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log("Call-control router, activation, kill-switch, and durable claim safeguards passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
