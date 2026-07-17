import assert from "node:assert/strict";
import fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createPhoneResumeUrl,
  derivePhoneResumeToken,
  ProductionSecureLinkStore,
  secureLinkTokenDigest,
} from "../lib/secure-links/production";
import {
  phoneFromSipDestination,
  phoneReferenceDigest,
  secureLinkMessage,
} from "../lib/integrations/twilio-messaging-live";

async function main() {
const secret = "a-production-shaped-secret-with-at-least-thirty-two-bytes";
const tenantId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = `phone_resume_${"a".repeat(64)}`;
const token = derivePhoneResumeToken({ secret, tenantId, idempotencyKey });

assert.equal(token.length, 43);
assert.equal(token, derivePhoneResumeToken({ secret, tenantId, idempotencyKey }));
assert.notEqual(token, derivePhoneResumeToken({ secret, tenantId, idempotencyKey: `phone_resume_${"b".repeat(64)}` }));
assert.match(secureLinkTokenDigest(token), /^[0-9a-f]{64}$/);

const url = createPhoneResumeUrl("https://civya.example", token);
assert.match(url, /^https:\/\/civya\.example\/phone\/resume#token=/);
assert.equal(new URL(url).search, "");
assert.equal(new URL(url).hash.includes(token), true);

const phone = phoneFromSipDestination('"Caller" <sip:+13135551212@trunk.example>;tag=opaque');
assert.equal(phone, "+13135551212");
assert.equal(phoneFromSipDestination("tel:+13135551212"), phone);
assert.equal(
  phoneFromSipDestination("Display sip:+13135550000@decoy.example <sip:+13135551212@trunk.example>"),
  phone,
  "display text must not override the URI inside the name-address brackets",
);
assert.throws(() => phoneFromSipDestination("sip:anonymous@trunk.example"));
assert.throws(() => phoneFromSipDestination("Display +13135551212 without a SIP URI"));
assert.throws(() => phoneFromSipDestination("<sip:+13135551212@trunk.example>\r\nX-Decoy: yes"));
assert.match(phoneReferenceDigest(phone), /^[0-9a-f]{64}$/);
assert.doesNotMatch(phoneReferenceDigest(phone), /13135551212/);
assert.match(secureLinkMessage(url), /never ask for card, bank, password, or security-code/i);

const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
const fake = {
  rpc: async (operation: string, args: Record<string, unknown>) => {
    calls.push({ operation, args });
    if (operation === "civya_service_create_secure_link") {
      return { data: { secureLinkId: "22222222-2222-4222-8222-222222222222", purpose: "staff_callback", expiresAt: "2030-01-01T00:10:00.000Z" }, error: null };
    }
    return { data: { consumed: true, purpose: "staff_callback", caseId: null, handoffSessionId: null }, error: null };
  },
} as unknown as SupabaseClient;
const store = new ProductionSecureLinkStore(fake);
await store.createPhoneResume({
  tenantId,
  tokenDigest: secureLinkTokenDigest(token),
  expiresAt: "2030-01-01T00:10:00.000Z",
  idempotencyKey,
});
await store.consumePhoneResume({ tenantId, token });
assert.equal(calls[0]?.operation, "civya_service_create_secure_link");
assert.equal(calls[0]?.args.p_token_digest, secureLinkTokenDigest(token));
assert.equal(JSON.stringify(calls[0]?.args).includes(token), false, "plaintext token must never be persisted");
assert.equal(calls[0]?.args.p_case_id, null, "phone resume cannot bind a County case");
assert.equal(calls[0]?.args.p_audience_auth_user_id, null);
assert.equal(calls[1]?.operation, "civya_service_consume_secure_link");

const root = process.cwd();
const issuerRoute = fs.readFileSync(`${root}/app/api/internal/secure-links/phone/route.ts`, "utf8");
const consumeRoute = fs.readFileSync(`${root}/app/api/secure-links/phone-resume/route.ts`, "utf8");
const page = fs.readFileSync(`${root}/app/phone/resume/page.tsx`, "utf8");
assert.match(issuerRoute, /timingSafeEqual/);
assert.match(issuerRoute, /claimExternalOperation/);
assert.match(issuerRoute, /finishExternalOperationClaim/);
assert.match(issuerRoute, /operation\.acquired/);
assert.match(issuerRoute, /operation\.claimToken/);
assert.doesNotMatch(issuerRoute, /reserveExternalOperation/);
assert.match(issuerRoute, /state === "failed_unknown"/);
assert.match(issuerRoute, /ProductionSecureLinkStore/);
const claimMigration = fs.readFileSync(`${root}/supabase/migrations/202607160026_external_operation_claim_fencing.sql`, "utf8");
assert.match(claimMigration, /for update/);
assert.match(claimMigration, /claim_token/);
assert.match(claimMigration, /claim_expires_at <= now\(\)/);
assert.match(claimMigration, /state = 'failed_unknown'/);
assert.match(claimMigration, /claimed external operation requires token-fenced completion/);
assert.match(consumeRoute, /result\.caseId \|\| result\.handoffSessionId/);
assert.match(page, /window\.location\.hash/);
assert.match(page, /replaceState/);
assert.match(page, /does not verify your identity or open a County case/i);

console.log("Durable phone secure-link safeguards passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
