#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { sealFlowState } from "@/lib/auth/flow-state";
import {
  hashOpaqueReference,
  ENTITLEMENT_GRANT_COOKIE,
  type CaseEntitlementGrant,
} from "@/lib/entitlement/grant";
import {
  hasCaseEntitlementSession,
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import type { CivyaPlatform } from "@/lib/platform";
import { RequestError } from "@/lib/security/request";

process.env.CIVYA_AUTH_FLOW_SECRET = "synthetic-production-entitlement-boundary-secret";
process.env.CIVYA_ENVIRONMENT = "test";
process.env.CIVYA_SYNTHETIC_MODE = "true";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const USER = "00000000-0000-4000-8000-000000000101";
const OTHER_USER = "00000000-0000-4000-8000-000000000202";
const CASE = "00000000-0000-4000-8000-000000000303";
const TENANT = "00000000-0000-4000-8000-000000000404";
const ENTITLEMENT = "00000000-0000-4000-8000-000000000505";
const SCOPES = ["case.read", "case.participate", "document.read", "document.upload"] as const;
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

function platform(input: Partial<{
  userId: string;
  role: string;
  isVerified: boolean;
  authorized: boolean;
  rowVersion: number;
}> = {}): CivyaPlatform {
  return {
    principal: {
      userId: input.userId ?? USER,
      role: input.role ?? "resident",
      isVerified: input.isVerified ?? true,
    },
    validateEntitlementCache: async (grant: CaseEntitlementGrant) => ({
      authorized: input.authorized ?? true,
      accessType: grant.accessType,
      entitlementId: grant.entitlementId,
      tenantId: grant.tenantId,
      caseId: grant.caseId,
      purpose: grant.purpose,
      scopes: grant.scopes,
      rowVersion: input.rowVersion ?? grant.rowVersion,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  } as unknown as CivyaPlatform;
}

function request(grant?: Partial<CaseEntitlementGrant>, sealedOverride?: string): NextRequest {
  const value = sealedOverride ?? (grant
      ? sealFlowState({
        userId: USER,
        entitlementId: ENTITLEMENT,
        grantIdHash: hashOpaqueReference(ENTITLEMENT),
        rowVersion: 1,
        tenantId: TENANT,
        caseId: CASE,
        caseBindingHash: hashOpaqueReference(CASE),
        purpose: "case_access",
        scopes: SCOPES,
        accessType: "case_entitlement",
        method: "notice_code",
        exp: Date.now() + 60_000,
        ...grant,
      })
    : undefined);
  return new NextRequest("https://civya.invalid/api/case/private", {
    headers: value ? { cookie: `${ENTITLEMENT_GRANT_COOKIE}=${value}` } : undefined,
  });
}

async function expectGenericDenial(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "entitlement_required");
    assert.equal(error.message, "Verify Wayne County case access before continuing.");
    assert.doesNotMatch(error.message, new RegExp(`${USER}|${OTHER_USER}|${CASE}`));
    return true;
  });
}

function tamperCiphertext(sealed: string): string {
  const parts = sealed.split(".");
  const ciphertext = parts[2] || "";
  const index = Math.floor(ciphertext.length / 2);
  const replacement = ciphertext[index] === "A" ? "B" : "A";
  parts[2] = `${ciphertext.slice(0, index)}${replacement}${ciphertext.slice(index + 1)}`;
  return parts.join(".");
}

async function main() {
console.log("Production Wayne County case-entitlement boundary");

await check("a verified account without a sealed grant has no case entitlement", async () => {
  const req = request();
  assert.equal(await hasCaseEntitlementSession(req, platform()), false);
  await expectGenericDenial(() => requireCaseEntitlementSession(req, platform()));
});

await check("forged, expired, wrong-user, unverified, and non-resident grants fail identically", async () => {
  const valid = request({});
  const sealed = valid.cookies.get(ENTITLEMENT_GRANT_COOKIE)?.value || "";
  const forged = tamperCiphertext(sealed);
  const candidates: Array<() => unknown> = [
    () => requireCaseEntitlementSession(request(undefined, forged), platform()),
    () => requireCaseEntitlementSession(request({ exp: Date.now() - 1 }), platform()),
    () => requireCaseEntitlementSession(request({ userId: OTHER_USER }), platform()),
    () => requireCaseEntitlementSession(valid, platform({ isVerified: false })),
    () => requireCaseEntitlementSession(valid, platform({ role: "reviewer" })),
  ];
  for (const candidate of candidates) await expectGenericDenial(candidate as () => Promise<unknown>);
});

await check("a bound grant succeeds only for the route-supplied exact case binding", async () => {
  const req = request({});
  assert.equal((await requireCaseEntitlement(req, platform(), CASE)).userId, USER);
  await expectGenericDenial(() => requireCaseEntitlement(req, platform(), OTHER_USER));
  await expectGenericDenial(() => requireCaseEntitlement(req, platform(), ""));
});

await check("revoked and stale authoritative entitlements invalidate a valid sealed cache", async () => {
  const req = request();
  await expectGenericDenial(() => requireCaseEntitlement(req, platform({ authorized: false }), CASE));
  await expectGenericDenial(() => requireCaseEntitlement(req, platform({ rowVersion: 2 }), CASE));
});

await check("all resident case and source surfaces invoke the central binding guard", () => {
  const directlyBound = [
    "app/api/case/[caseId]/route.ts",
    "app/api/cases/activate/route.ts",
  ];
  for (const file of directlyBound) {
    const source = read(file);
    assert.match(source, /@\/lib\/entitlement\/guard/);
    assert.match(source, /requireCaseEntitlement\(req, platform, caseId\)/);
  }

  const resolvedBinding = [
    "app/api/bootstrap/route.ts",
    "app/api/conversations/turn/route.ts",
    "app/api/conversations/end/route.ts",
    "app/api/uploads/route.ts",
    "app/api/uploads/finalize/route.ts",
    "app/api/documents/[documentId]/download/route.ts",
    "app/api/tools/property-status/route.ts",
    "app/api/tools/resident-case/route.ts",
    "app/api/tools/document-checklist/route.ts",
    "app/api/tools/eligibility/route.ts",
    "app/api/tools/case-mgmt/route.ts",
    "app/api/tools/log/route.ts",
    "app/api/tools/cached-answer/route.ts",
  ];
  for (const file of resolvedBinding) {
    const source = read(file);
    assert.match(source, /@\/lib\/entitlement\/guard/);
    assert.match(source, /requireCaseEntitlement\(req, platform,/);
  }
});

await check("anonymous bootstrap and general turns remain available without adding County data", () => {
  const bootstrap = read("app/api/bootstrap/route.ts");
  const turn = read("app/api/conversations/turn/route.ts");
  const cached = read("app/api/tools/cached-answer/route.ts");
  assert.match(bootstrap, /principal\.isVerified[\s\S]*await hasCaseEntitlementSession/);
  assert.match(bootstrap, /unauthenticatedBootstrap\(\)/);
  assert.match(bootstrap, /capabilities\.uploads = false/);
  assert.match(turn, /const protectedResident = .*principal\.isVerified/);
  assert.match(turn, /protectedResident[\s\S]{0,500}await requireCaseEntitlementSession/);
  assert.match(cached, /hasCaseEntitlementSession\(req, platform\)/);
});

await check("all email verification modes stop before case access and preserve the exact pending tuple", () => {
  const source = read("app/api/auth/email/verify/route.ts");
  assert.match(source, /setPendingEntitlement/);
  assert.match(source, /transferToken: state\.transferToken/);
  assert.match(source, /caseAccess: state\.caseAccess/);
  assert.match(source, /pendingTask/);
  assert.match(source, /code: "entitlement_required"/);
  assert.match(source, /clearEntitlementGrant/);
  assert.doesNotMatch(source, /bootstrapSession\(/);
  assert.doesNotMatch(source, /redeemCaseTransferGrant/);
  assert.doesNotMatch(source, /attached_case_id|existing_active_case_id|case_selection_required/);
});

await check("verified-account auth shortcuts return entitlement state but never bootstrap case data", () => {
  const routes = [
    {
      file: "app/api/auth/anonymous/route.ts",
      marker: "if (principal.isVerified)",
      end: "await grantDemoAccessFromRequest",
    },
    {
      file: "app/api/auth/email/start/route.ts",
      marker: "if (platform.principal.isVerified)",
      end: "const limited = rateLimitRequest",
    },
    {
      file: "app/api/auth/decline/route.ts",
      marker: "if (platform.principal.isVerified)",
      end: "const { data: current }",
    },
  ];
  for (const route of routes) {
    const source = read(route.file);
    const start = source.indexOf(route.marker);
    const end = source.indexOf(route.end, start);
    assert.ok(start >= 0 && end > start, `verified shortcut missing in ${route.file}`);
    const shortcut = source.slice(start, end);
    assert.match(shortcut, /hasCaseEntitlementSession\(req, platform\)/);
    assert.match(shortcut, /entitlement:/);
    assert.doesNotMatch(shortcut, /bootstrapSession\(/);
    assert.doesNotMatch(shortcut, /active_case|resident|conversation|case_id/);
  }
});

await check("atomic exact database finalization occurs only after external verification and before a browser cache", () => {
  const source = read("app/api/entitlements/verify/route.ts");
  const repository = read("lib/platform/repository.ts");
  const migration = read("supabase/migrations/202607160023_proof_lifecycle_and_entitlement_handoff.sql");
  const recoveryIndex = source.indexOf("await platform.recoverBoundCaseEntitlementHandoff");
  const externalVerifyIndex = source.indexOf("const result = await verifyCaseEntitlement");
  const verifiedIndex = source.indexOf("if (!result)");
  const persistenceIndex = source.indexOf("await platform.finalizeBoundCaseEntitlement");
  const cookieIndex = source.indexOf("setEntitlementGrant(response", persistenceIndex);
  assert.ok(verifiedIndex >= 0 && persistenceIndex > verifiedIndex && cookieIndex > persistenceIndex);
  assert.ok(recoveryIndex >= 0 && externalVerifyIndex > recoveryIndex);
  assert.match(source, /sameCaseAccessBinding\(result\.binding, pending\.caseAccess\)/);
  assert.match(source, /caseBindingHash: hashOpaqueReference\(pending\.caseAccess\.caseId\)/);
  assert.match(source, /grantIdHash: cache\.entitlementId/);
  assert.doesNotMatch(source, /redeemCaseTransferGrant|transfer\?\.caseId/);
  assert.match(repository, /civya_service_finalize_bound_case_entitlement_handoff/);
  assert.match(repository, /civya_service_recover_bound_case_entitlement_handoff/);
  assert.match(repository, /p_selection_id: crypto\.randomUUID\(\)/);
  assert.match(migration, /bound_case_entitlement_handoffs/);
  assert.match(migration, /civya_service_recover_bound_case_entitlement_handoff/);
  assert.match(migration, /revoke all on function public\.civya_service_finalize_bound_case_entitlement\(/);
});

await check("existing-account case selection never caches the inactive transferred case", () => {
  const verify = read("app/api/entitlements/verify/route.ts");
  const selectionStart = verify.indexOf("if (finalized.requiresCaseSelection)");
  const selectionEnd = verify.indexOf("const cache = await platform.validateEntitlementCache", selectionStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  const selectionBranch = verify.slice(selectionStart, selectionEnd);
  assert.match(selectionBranch, /entitlement: \{ state: "selection_required"/);
  assert.match(selectionBranch, /case_selection_required: true/);
  assert.match(selectionBranch, /setEntitlementSelection/);
  assert.match(selectionBranch, /clearEntitlementGrant/);
  assert.doesNotMatch(selectionBranch, /setEntitlementGrant/);
  assert.doesNotMatch(selectionBranch, /createCaseEntitlementSelection/);

  const activate = read("app/api/cases/activate/route.ts");
  const selectIndex = activate.indexOf("await platform.selectEntitledCase");
  const validateIndex = activate.indexOf("await platform.validateEntitlementCache", selectIndex);
  const grantIndex = activate.indexOf("setEntitlementGrant(response", validateIndex);
  assert.ok(selectIndex >= 0 && validateIndex > selectIndex && grantIndex > validateIndex);
  assert.match(activate, /readEntitlementSelection/);
  assert.match(activate, /clearEntitlementSelection/);

  const migration = read("supabase/migrations/202607160023_proof_lifecycle_and_entitlement_handoff.sql");
  const replayMigration = read("supabase/migrations/202607160027_committed_case_selection_replay.sql");
  assert.match(migration, /alter function public\.civya_service_select_entitled_case/);
  assert.match(migration, /civya_service_select_entitled_case_unchecked/);
  assert.match(migration, /civya_entitlement_has_current_proof/);
  assert.match(replayMigration, /v_selection\.used_at is null and v_selection\.expires_at <= now\(\)/);
  assert.match(replayMigration, /v_selection\.selected_case_id <> p_selected_case_id/);
  assert.match(replayMigration, /civya_service_case_entitlement_cache_status/);

  const status = read("app/api/entitlements/status/route.ts");
  assert.match(status, /readEntitlementSelection/);
  assert.match(status, /entitlement: \{ state: "selection_required"/);
  assert.match(status, /case_selection_required: true/);
  assert.match(status, /clearEntitlementGrant\(response\)/);

  const page = read("app/page.tsx");
  assert.match(page, /status\.entitlement\?\.state === "selection_required"/);
  assert.match(page, /setCaseSelection\(\{/);
});

await check("expired or malformed proof cannot authorize RLS, cache, selection, or reminder delivery", () => {
  const migration = read("supabase/migrations/202607160023_proof_lifecycle_and_entitlement_handoff.sql");
  assert.match(migration, /civya_entitlement_has_current_proof/);
  assert.match(migration, /p\.expires_at > now\(\)/);
  assert.match(migration, /p\.assurance_level in \('substantial', 'high'\)/);
  assert.match(migration, /e\.evidence_digest = p\.evidence_digest/);
  assert.match(migration, /e\.expires_at <= p\.expires_at/);
  assert.match(migration, /create or replace function private\.civya_active_case_entitlement/);
  assert.match(migration, /create or replace function public\.civya_service_case_entitlement_cache_status/);
  assert.match(migration, /create or replace function public\.civya_service_prepare_reminder_delivery/);
  assert.match(migration, /new\.state = 'active'/);
});

await check("entitlement status uses the same hardened session validation as protected routes", () => {
  const source = read("app/api/entitlements/status/route.ts");
  assert.match(source, /hasCaseEntitlementSession\(req, platform\)/);
  assert.doesNotMatch(source, /grant\?\.userId ===/);
  assert.doesNotMatch(source, /residentId|confirmedFacts|conversation|address/i);
});

await check("synthetic mutations and production bootstraps are bound to distinct tenant-safe paths", () => {
  const sandboxGuard = read("lib/security/synthetic-sandbox.ts");
  assert.match(sandboxGuard, /!config\.syntheticMode \|\| config\.environment === "production"/);
  assert.match(sandboxGuard, /resolveTenantSlug\(request\.headers\.get\("host"\), config\)/);
  assert.match(sandboxGuard, /resolvedTenant !== expectedTenant/);

  for (const file of [
    "app/api/invitations/exchange/route.ts",
    "app/api/v1/workflows/synthetic/route.ts",
    "app/api/handoffs/route.ts",
    "app/api/handoffs/launch/route.ts",
    "app/api/handoffs/return/route.ts",
  ]) {
    assert.match(read(file), /requireSyntheticSandboxHost\(/, `${file} must prove the exact sandbox host`);
  }

  const runtimeBootstrap = read("lib/conversation/runtime-bootstrap.server.ts");
  assert.match(runtimeBootstrap, /if \(config\.syntheticMode\) return bootstrapSession/);
  assert.match(runtimeBootstrap, /requireCaseEntitlementSession\(request, platform\)/);
  assert.match(runtimeBootstrap, /bootstrapEntitledProductionCase/);
  for (const file of [
    "app/api/conversations/end/route.ts",
    "app/api/tools/log/route.ts",
    "app/api/tools/cached-answer/route.ts",
  ]) {
    assert.match(read(file), /bootstrapAuthorizedResidentCase\(/, `${file} must use the runtime-safe bootstrap`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} production entitlement boundary test${failures === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

console.log("\nAll production entitlement boundary tests passed.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
