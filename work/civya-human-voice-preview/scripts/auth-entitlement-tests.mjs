#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("Resident account and Wayne County case-entitlement contracts");

await check("pending tasks preserve an exact bounded resume target", async () => {
  const { sanitizePendingTask } = await load("lib/auth/contracts.ts");
  const task = sanitizePendingTask({
    turn_id: "turn_123",
    pending_question: "Which notice date appears at the top?",
    action: "upload",
    reason: "document_upload",
    ignored: "never copied",
  });
  assert.deepEqual(task, {
    turnId: "turn_123",
    question: "Which notice date appears at the top?",
    action: "upload",
    reason: "document_upload",
  });
  assert.equal(sanitizePendingTask({ action: "arbitrary_admin_action" }), undefined);
  assert.equal(sanitizePendingTask({ question: "x".repeat(900) }).question.length, 500);
});

await check("browser-carried flow state is encrypted, authenticated, and expiring", async () => {
  process.env.CIVYA_AUTH_FLOW_SECRET = "synthetic-auth-flow-secret-for-focused-tests";
  const { openFlowState, sealFlowState } = await load("lib/auth/flow-state.ts");
  const original = {
    exp: Date.now() + 60_000,
    nonce: "nonce_123",
    pendingTask: { question: "private pending question" },
  };
  const sealed = sealFlowState(original);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(sealed.includes("private pending question"), false);
  assert.equal(openFlowState(sealed).nonce, original.nonce);
  const segments = sealed.split(".");
  const ciphertext = segments[2];
  const midpoint = Math.floor(ciphertext.length / 2);
  segments[2] = `${ciphertext.slice(0, midpoint)}${ciphertext[midpoint] === "A" ? "B" : "A"}${ciphertext.slice(midpoint + 1)}`;
  const tampered = segments.join(".");
  assert.equal(openFlowState(tampered), null);
  assert.equal(openFlowState(sealFlowState({ exp: Date.now() - 1 })), null);
});

await check("OAuth starts provider-aware state and resumes through a nonce-bound callback", () => {
  const providers = read("lib/auth/providers.ts");
  const start = read("app/api/auth/oauth/start/route.ts");
  const callback = read("app/api/auth/oauth/callback/route.ts");
  for (const provider of ["google", "apple", "linkedin_oidc"]) {
    assert.match(providers, new RegExp(`\\b${provider}\\b`));
  }
  assert.match(start, /sanitizePendingTask\(body\.pending_task\)/);
  assert.match(start, /flow=.*nonce/);
  assert.match(callback, /nonce !== flow\.nonce/);
  assert.match(callback, /setPendingEntitlement/);
  assert.doesNotMatch(callback, /redeemCaseTransferGrant/);
});

await check("passkey support is feature detected and fails explicitly when unavailable", () => {
  const client = read("lib/auth/passkey-client.ts");
  const capability = read("app/api/auth/passkeys/capabilities/route.ts");
  const start = read("app/api/auth/passkeys/start/route.ts");
  assert.match(client, /PublicKeyCredential/);
  assert.match(client, /window\.isSecureContext/);
  assert.match(capability, /unavailable_reason/);
  assert.match(start, /passkey_unavailable/);
});

await check("entitlement status restores only sealed selection metadata and no case facts", () => {
  const status = read("app/api/entitlements/status/route.ts");
  assert.match(status, /account: \{ state: "verified" \}/);
  assert.match(status, /entitlement: grant/);
  assert.match(status, /await hasCaseEntitlementSession/);
  assert.match(status, /fictional_invitation/);
  assert.match(status, /readEntitlementSelection/);
  assert.match(status, /case_selection_required: true/);
  assert.doesNotMatch(status, /residentId|confirmedFacts|conversation|address/i);
});

await check("case access persists only after external verification and never redeems a legacy transfer", () => {
  const verify = read("app/api/entitlements/verify/route.ts");
  const successIndex = verify.indexOf("if (!result)");
  const persistIndex = verify.indexOf("await platform.finalizeBoundCaseEntitlement");
  const cookieIndex = verify.indexOf("setEntitlementGrant(response", persistIndex);
  assert.ok(successIndex >= 0 && persistIndex > successIndex && cookieIndex > persistIndex);
  assert.match(verify, /We could not verify access from that information/);
  assert.match(verify, /sameCaseAccessBinding\(result\.binding, pending\.caseAccess\)/);
  assert.match(verify, /await platform\.validateEntitlementCache/);
  assert.doesNotMatch(verify, /redeemCaseTransferGrant/);
  assert.doesNotMatch(verify.slice(0, successIndex), /attached_case_id|existing_active_case_id/);
});

await check("the resident shell separates account readiness from case access", () => {
  const page = read("app/page.tsx");
  assert.match(page, /Step 1 of 2 · Civya account/);
  assert.match(page, /Step 2 of 2 · Wayne County case access/);
  assert.match(page, /Signing in does not open or confirm a Wayne County case/);
  assert.match(page, /auth\.state === "verified" && entitlementVerifiedRef\.current/);
  assert.match(page, /canShowCase && casePanel/);
  assert.match(page, /Continue with general information only/);
  assert.match(page, /Ask a person to verify access/);
});

if (failures > 0) {
  console.error(`\n${failures} focused contract test${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

console.log("\nAll focused auth and entitlement contract tests passed.");
