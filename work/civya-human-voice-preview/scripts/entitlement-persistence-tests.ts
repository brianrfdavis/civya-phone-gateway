#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CaseEntitlementPersistenceError,
  createBoundedSyntheticEntitlementStore,
  createSupabaseCaseEntitlementStore,
  persistVerifiedCaseEntitlement,
  type CaseEntitlementPersistenceStore,
  type LocalCaseSubject,
} from "@/lib/entitlement/persistence.server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER = "00000000-0000-4000-8000-000000000101";
const OTHER_USER = "00000000-0000-4000-8000-000000000202";
const CASE = "00000000-0000-4000-8000-000000000303";
const TENANT = "00000000-0000-4000-8000-000000000404";
const RESIDENT = "00000000-0000-4000-8000-000000000505";
const CHALLENGE = "00000000-0000-4000-8000-000000000606";
const ENTITLEMENT = "00000000-0000-4000-8000-000000000707";
const NOW = Date.parse("2026-07-16T16:00:00.000Z");

let failures = 0;

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

const subject: LocalCaseSubject = {
  caseId: CASE,
  tenantId: TENANT,
  tenantSlug: "wayne-county",
  tenantEnvironment: "production",
  tenantFictional: false,
  residentId: RESIDENT,
  authUserId: USER,
};

const baseInput = {
  userId: USER,
  method: "notice_code" as const,
  externalGrantId: "county-provider-grant-opaque-123",
  caseBinding: CASE,
  expectedTenantSlug: "wayne-county",
  expectedTenantEnvironment: "production" as const,
  externalExpiresAt: NOW + 20 * 60 * 1_000,
  now: NOW,
};

function errorReason(error: unknown, expected: string): boolean {
  assert.ok(error instanceof CaseEntitlementPersistenceError);
  assert.equal(error.message, "Wayne County case access could not be safely established.");
  assert.equal(error.reason, expected);
  return true;
}

function storeWith(overrides: Partial<CaseEntitlementPersistenceStore> = {}): CaseEntitlementPersistenceStore {
  return {
    async resolveLocalCase() {
      return subject;
    },
    async claimVerifiedProductionCase(input) {
      return {
        challengeId: CHALLENGE,
        entitlementId: ENTITLEMENT,
        caseId: CASE,
        residentId: RESIDENT,
        state: "active",
        scopes: ["case.read", "case.participate", "document.read", "document.upload"],
        expiresAt: input.expiresAt,
        duplicate: false,
      };
    },
    async createProof(input) {
      return {
        challengeId: CHALLENGE,
        state: "pending",
        expiresAt: input.expiresAt,
        duplicate: false,
      };
    },
    async resolveProof(input) {
      return {
        challengeId: input.challengeId,
        state: "verified",
        assuranceLevel: "substantial",
      };
    },
    async grantEntitlement(input) {
      return {
        entitlementId: ENTITLEMENT,
        caseId: CASE,
        state: "active",
        expiresAt: input.expiresAt,
        duplicate: false,
      };
    },
    async entitlementStatus() {
      return { authorized: true, accessType: "case_entitlement" };
    },
    ...overrides,
  };
}

async function main() {
console.log("Production case-entitlement persistence bridge");

await check("non-UUID and unresolvable bindings fail before any proof RPC", async () => {
  let calls = 0;
  const store = storeWith({
    async resolveLocalCase() {
      calls += 1;
      return null;
    },
    async createProof() {
      calls += 100;
      throw new Error("must not run");
    },
  });
  await assert.rejects(
    persistVerifiedCaseEntitlement({ ...baseInput, caseBinding: "county-case-not-a-local-uuid" }, store),
    (error) => errorReason(error, "case_binding_not_local_uuid"),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    persistVerifiedCaseEntitlement(baseInput, store),
    (error) => errorReason(error, "case_not_found"),
  );
  assert.equal(calls, 1);
});

await check("tenant, production-scope, and account mismatches fail before proof creation", async () => {
  let proofCalls = 0;
  const variants: Array<[Partial<LocalCaseSubject>, string]> = [
    [{ tenantSlug: "different-county" }, "tenant_mismatch"],
    [{ tenantEnvironment: "staging" }, "tenant_environment_mismatch"],
    [{ tenantEnvironment: "sandbox", tenantFictional: true }, "production_case_required"],
    [{ authUserId: OTHER_USER }, "case_account_mismatch"],
  ];
  for (const [variant, reason] of variants) {
    await assert.rejects(
      persistVerifiedCaseEntitlement(baseInput, storeWith({
        async resolveLocalCase() {
          return { ...subject, ...variant };
        },
        async createProof() {
          proofCalls += 1;
          throw new Error("must not run");
        },
      })),
      (error) => errorReason(error, reason),
    );
  }
  assert.equal(proofCalls, 0);
});

await check("a first-time unclaimed production case uses only the atomic claim RPC", async () => {
  let claimCalls = 0;
  let separateProofCalls = 0;
  const persisted = await persistVerifiedCaseEntitlement(baseInput, storeWith({
    async resolveLocalCase() {
      return { ...subject, authUserId: null };
    },
    async claimVerifiedProductionCase(input) {
      claimCalls += 1;
      assert.equal(input.tenantId, TENANT);
      assert.equal(input.caseId, CASE);
      assert.equal(input.actorUserId, USER);
      assert.equal(input.proofResult, "verified");
      assert.equal(input.providerKey, "wayne_county_case_entitlement");
      assert.match(input.verifierGrantDigest, /^[0-9a-f]{64}$/);
      assert.notEqual(input.verifierGrantDigest, baseInput.externalGrantId);
      return {
        challengeId: CHALLENGE,
        entitlementId: ENTITLEMENT,
        caseId: CASE,
        residentId: RESIDENT,
        state: "active",
        scopes: ["case.read", "case.participate", "document.read", "document.upload"],
        expiresAt: input.expiresAt,
        duplicate: false,
      };
    },
    async createProof() {
      separateProofCalls += 1;
      throw new Error("must not run for an unclaimed case");
    },
  }));
  assert.equal(persisted.entitlementId, ENTITLEMENT);
  assert.equal(claimCalls, 1);
  assert.equal(separateProofCalls, 0);
});

await check("RPC and post-grant status failures stop the browser entitlement handoff", async () => {
  let resolveCalls = 0;
  await assert.rejects(
    persistVerifiedCaseEntitlement(baseInput, storeWith({
      async createProof() {
        throw new Error("database unavailable");
      },
      async resolveProof(input) {
        resolveCalls += 1;
        return { challengeId: input.challengeId, state: "verified", assuranceLevel: "substantial" };
      },
    })),
    (error) => errorReason(error, "proof_create_error"),
  );
  assert.equal(resolveCalls, 0);

  await assert.rejects(
    persistVerifiedCaseEntitlement(baseInput, storeWith({
      async entitlementStatus() {
        return { authorized: false, reason: "case_entitlement_required" };
      },
    })),
    (error) => errorReason(error, "entitlement_not_active"),
  );
});

await check("the bounded credential-free adapter is deterministic and idempotent", async () => {
  const previousSynthetic = process.env.CIVYA_SYNTHETIC_MODE;
  const previousVercel = process.env.VERCEL;
  process.env.CIVYA_SYNTHETIC_MODE = "true";
  delete process.env.VERCEL;
  try {
    const store = createBoundedSyntheticEntitlementStore({
      marker: "civya-entitlement-tests-only",
      subjects: [subject],
    });
    const first = await persistVerifiedCaseEntitlement(baseInput, store);
    const second = await persistVerifiedCaseEntitlement(baseInput, store);
    assert.equal(first.entitlementId, second.entitlementId);
    assert.equal(first.caseId, CASE);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.deepEqual(first.scopes, [
      "case.read",
      "case.participate",
      "document.read",
      "document.upload",
    ]);
    assert.equal(first.expiresAt, baseInput.externalExpiresAt);
  } finally {
    if (previousSynthetic === undefined) delete process.env.CIVYA_SYNTHETIC_MODE;
    else process.env.CIVYA_SYNTHETIC_MODE = previousSynthetic;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

await check("synthetic persistence is impossible in a hosted runtime", () => {
  const previousSynthetic = process.env.CIVYA_SYNTHETIC_MODE;
  const previousVercel = process.env.VERCEL;
  process.env.CIVYA_SYNTHETIC_MODE = "true";
  process.env.VERCEL = "1";
  try {
    assert.throws(
      () => createBoundedSyntheticEntitlementStore({
        marker: "civya-entitlement-tests-only",
        subjects: [subject],
      }),
      (error) => errorReason(error, "synthetic_persistence_not_allowed"),
    );
  } finally {
    if (previousSynthetic === undefined) delete process.env.CIVYA_SYNTHETIC_MODE;
    else process.env.CIVYA_SYNTHETIC_MODE = previousSynthetic;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

await check("missing Supabase service configuration fails closed", () => {
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    assert.throws(
      () => createSupabaseCaseEntitlementStore(),
      (error) => errorReason(error, "supabase_service_configuration_missing"),
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

await check("the verification route persists before issuing a cookie and never redeems a legacy transfer", () => {
  const route = fs.readFileSync(path.join(ROOT, "app/api/entitlements/verify/route.ts"), "utf8");
  const persistIndex = route.indexOf("await platform.finalizeBoundCaseEntitlement");
  const responseIndex = route.indexOf("const response = NextResponse.json", persistIndex);
  const cookieIndex = route.indexOf("setEntitlementGrant(response", responseIndex);
  assert.ok(persistIndex >= 0);
  assert.ok(responseIndex > persistIndex);
  assert.ok(cookieIndex > responseIndex);
  assert.match(route, /sameCaseAccessBinding\(result\.binding, pending\.caseAccess\)/);
  assert.match(route, /grantIdHash: cache\.entitlementId/);
  assert.match(route, /caseBindingHash: hashOpaqueReference\(pending\.caseAccess\.caseId\)/);
  assert.match(route, /await platform\.validateEntitlementCache/);
  assert.doesNotMatch(route, /redeemCaseTransferGrant/);
  assert.doesNotMatch(route, /transfer\?\.caseId/);
});

await check("the production store invokes the exact service-only proof and entitlement RPCs", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/entitlement/persistence.server.ts"), "utf8");
  for (const rpc of [
    "civya_service_claim_verified_production_case",
    "civya_service_create_identity_proof_challenge",
    "civya_service_resolve_identity_proof_challenge",
    "civya_service_grant_case_entitlement",
    "civya_service_case_entitlement_status",
  ]) {
    assert.match(source, new RegExp(`rpc\\(\"${rpc}\"`));
  }
  assert.match(source, /p_staff_actor_user_id: null/);
  assert.match(source, /p_verifier_grant_digest: input\.verifierGrantDigest/);
  assert.match(source, /providerReference: `sha256:/);
});

if (failures > 0) {
  console.error(`\n${failures} entitlement persistence test${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

console.log("\nAll entitlement persistence tests passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
