import assert from "node:assert/strict";
import { safeOperationalPayload } from "../lib/logging/safe-operational-payload";

const payload = safeOperationalPayload({
  message: "Jane Resident lives at 123 Main Street.",
  reason: "Contact jane@example.com at 313-555-1212",
  scope: "Property 123 Main Street",
  when: "The supplied SSN was 123-45-6789",
  similarity: 0.93,
  escalated: true,
  raw_transcript: "This field must never be accepted.",
  token: "secret-value",
});

const serialized = JSON.stringify(payload);
assert.match(serialized, /\[EMAIL\]/);
assert.match(serialized, /\[PHONE\]/);
assert.match(serialized, /\[(?:SSN|GOVERNMENT_ID)\]/);
assert.match(serialized, /\[ADDRESS\]/);
assert.doesNotMatch(serialized, /jane@example\.com|313-555-1212|123-45-6789|123 Main Street/i);
assert.equal(payload.similarity, 0.93);
assert.equal(payload.escalated, true);
assert.equal("raw_transcript" in payload, false);
assert.equal("token" in payload, false);

assert.deepEqual(safeOperationalPayload(null), {});
assert.deepEqual(safeOperationalPayload(["not", "an", "object"]), {});

console.log("Operational logging allowlist and privacy-redaction contracts passed.");
