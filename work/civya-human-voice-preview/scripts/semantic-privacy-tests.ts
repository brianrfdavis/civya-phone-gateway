import assert from "node:assert/strict";
import type { KnowledgeItem } from "../lib/types";

interface CapturedEmbeddingCall {
  body: {
    model: string;
    input: string[];
    user?: string;
  };
  signal?: AbortSignal | null;
}

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const calls: CapturedEmbeddingCall[] = [];
let failNextQuery = false;

async function main(): Promise<void> {
process.env.OPENAI_API_KEY = "test-openai-key-not-a-secret";
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body || "{}")) as CapturedEmbeddingCall["body"];
  calls.push({ body, signal: init?.signal });
  if (calls.length === 1) return new Response("retry", { status: 503 });
  if (failNextQuery) throw new Error("simulated embedding outage");
  return Response.json({
    data: body.input.map((_, index) => ({ index, embedding: [1, index / 10] })),
  });
};

try {
  const { semanticMatch } = await import("../lib/cache/semantic");
  const safetyIdentifier = "semantic_privacy_resident_0001";
  const items: KnowledgeItem[] = [{
    intent: "setup_payment_plan_wc",
    approved_spoken_answer: "A payment plan may be available.",
    long_answer: "A payment plan may be available.",
    disclaimer: "County approval is required.",
    next_step_prompt: "Would you like to review the steps?",
    allowed_next_questions: [],
    escalation_triggers: [],
    example_utterances: ["I need a payment plan"],
    source_url: "https://www.waynecounty.com/",
    last_reviewed: "2026-07-16",
    status: "draft",
    channels: { voice: true, sms: true, web: true },
  }];

  const match = await semanticMatch(
    "My name is Jane Resident, email jane@example.com, at 123 Main Street. I need a payment plan.",
    items,
    { safetyIdentifier, allowExternal: true },
  );
  assert.equal(match?.method, "embedding");
  assert.equal(calls.length, 3, "one retry may initialize the index, followed by one query call");
  for (const call of calls) {
    assert.equal(call.body.user, safetyIdentifier);
    assert.ok(call.signal instanceof AbortSignal, "every embedding request must carry an abort signal");
  }
  const queryPayload = JSON.stringify(calls.at(-1)?.body.input);
  assert.match(queryPayload, /\[EMAIL\]/);
  assert.match(queryPayload, /\[ADDRESS\]/);
  assert.doesNotMatch(queryPayload, /jane@example\.com|123 Main Street/i);

  const beforeNoIdentifier = calls.length;
  const withoutIdentifier = await semanticMatch("I need a payment plan", items, { allowExternal: true });
  assert.equal(withoutIdentifier?.method, "keyword");
  assert.equal(calls.length, beforeNoIdentifier, "no external embedding call is allowed without a stable safety id");

  failNextQuery = true;
  const beforeOutage = calls.length;
  await semanticMatch("I need a different payment arrangement", items, { safetyIdentifier, allowExternal: true });
  assert.equal(calls.length, beforeOutage + 2, "a query-time outage gets at most one retry");
  await semanticMatch("I still need a payment arrangement", items, { safetyIdentifier, allowExternal: true });
  assert.equal(calls.length, beforeOutage + 2, "query outage backoff prevents repeated provider calls");

  failNextQuery = false;
  const beforeDisabledResolver = calls.length;
  const { resolveAnswer } = await import("../lib/cache/resolver");
  await resolveAnswer("I need a different payment arrangement", "voice", {
    environment: "development",
    languageMode: "disabled",
    safetyIdentifier,
  });
  assert.equal(calls.length, beforeDisabledResolver, "disabled language mode must prevent embedding egress");

  console.log("Semantic privacy, timeout, retry, and outage-backoff contracts passed.");
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
