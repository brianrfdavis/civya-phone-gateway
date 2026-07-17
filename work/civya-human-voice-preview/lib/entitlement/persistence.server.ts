import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

if (typeof window !== "undefined") {
  throw new Error("The case-entitlement persistence bridge is server-only.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENTITLEMENT_MS = 30 * 60 * 1_000;
const MIN_ENTITLEMENT_MS = 60 * 1_000;
const PROVIDER_KEY = "wayne_county_case_entitlement";
const SCOPES = Object.freeze([
  "case.read",
  "case.participate",
  "document.read",
  "document.upload",
] as const);

type EntitlementMethod = "notice_code" | "invitation_code";
type DatabaseProofMethod = "county_notice" | "knowledge";
type EntitlementScope = (typeof SCOPES)[number];

export interface LocalCaseSubject {
  caseId: string;
  tenantId: string;
  tenantSlug: string;
  tenantEnvironment: string;
  tenantFictional: boolean;
  residentId: string;
  authUserId: string | null;
}

export interface ClaimVerifiedProductionCaseInput {
  tenantId: string;
  caseId: string;
  actorUserId: string;
  method: DatabaseProofMethod;
  providerKey: string;
  proofResult: "verified";
  verifierGrantDigest: string;
  expiresAt: string;
}

export interface ClaimedProductionCaseEntitlement {
  challengeId: string;
  entitlementId: string;
  caseId: string;
  residentId: string;
  state: "active";
  scopes: readonly EntitlementScope[];
  expiresAt: string;
  duplicate: boolean;
}

export interface CreateProofInput {
  actorUserId: string;
  caseId: string;
  method: DatabaseProofMethod;
  providerKey: string;
  challengeDigest: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface CreatedProof {
  challengeId: string;
  state: "pending" | "verified";
  expiresAt: string;
  duplicate: boolean;
}

export interface ResolveProofInput {
  challengeId: string;
  result: "verified";
  assuranceLevel: "substantial";
  evidenceDigest: string;
  providerReference: string;
}

export interface ResolvedProof {
  challengeId: string;
  state: "verified";
  assuranceLevel: "substantial";
}

export interface GrantEntitlementInput {
  challengeId: string;
  scopes: readonly EntitlementScope[];
  expiresAt: string;
  grantReasonCode: "external_case_identity_verified";
  idempotencyKey: string;
}

export interface GrantedEntitlement {
  entitlementId: string;
  caseId: string;
  state: "active";
  expiresAt: string;
  duplicate: boolean;
}

export interface EntitlementStatus {
  authorized: boolean;
  accessType?: string;
  reason?: string;
}

/**
 * Narrow service-role boundary used by the identity-verification route. Keeping
 * this interface small makes the production sequence testable without a live
 * County database and prevents callers from receiving a general admin client.
 */
export interface CaseEntitlementPersistenceStore {
  resolveLocalCase(caseId: string): Promise<LocalCaseSubject | null>;
  claimVerifiedProductionCase(
    input: ClaimVerifiedProductionCaseInput,
  ): Promise<ClaimedProductionCaseEntitlement>;
  createProof(input: CreateProofInput): Promise<CreatedProof>;
  resolveProof(input: ResolveProofInput): Promise<ResolvedProof>;
  grantEntitlement(input: GrantEntitlementInput): Promise<GrantedEntitlement>;
  entitlementStatus(actorUserId: string, caseId: string): Promise<EntitlementStatus>;
}

export interface PersistVerifiedCaseEntitlementInput {
  userId: string;
  method: EntitlementMethod;
  externalGrantId: string;
  caseBinding: string;
  expectedTenantSlug: string;
  expectedTenantEnvironment: "development" | "test" | "staging" | "production";
  externalExpiresAt: number;
  now?: number;
}

export interface PersistedCaseEntitlement {
  entitlementId: string;
  caseId: string;
  tenantId: string;
  residentId: string;
  scopes: readonly EntitlementScope[];
  expiresAt: number;
  duplicate: boolean;
}

export class CaseEntitlementPersistenceError extends Error {
  readonly code = "entitlement_persistence_failed";

  constructor(readonly reason: string) {
    super("Wayne County case access could not be safely established.");
    this.name = "CaseEntitlementPersistenceError";
  }
}

function fail(reason: string): never {
  throw new CaseEntitlementPersistenceError(reason);
}

function hexDigest(...parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)), "utf8");
    hash.update(":", "utf8");
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function requireUuid(value: unknown, reason: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail(reason);
  return value.toLowerCase();
}

function requireIsoFuture(value: unknown, now: number, reason: string): string {
  if (typeof value !== "string") fail(reason);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now) fail(reason);
  return new Date(timestamp).toISOString();
}

function requireObject(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(reason);
  return value as Record<string, unknown>;
}

function bool(value: unknown): boolean {
  return value === true;
}

function databaseMethod(method: EntitlementMethod): DatabaseProofMethod {
  return method === "notice_code" ? "county_notice" : "knowledge";
}

/**
 * Convert an external provider result into the database proof -> entitlement
 * chain. No browser grant may be issued until this function returns.
 */
export async function persistVerifiedCaseEntitlement(
  input: PersistVerifiedCaseEntitlementInput,
  store: CaseEntitlementPersistenceStore = createSupabaseCaseEntitlementStore(),
): Promise<PersistedCaseEntitlement> {
  const now = input.now ?? Date.now();
  const caseId = requireUuid(input.caseBinding, "case_binding_not_local_uuid");
  const userId = requireUuid(input.userId, "account_subject_not_uuid");
  if (!input.expectedTenantSlug || !/^[a-z0-9-]+$/.test(input.expectedTenantSlug)) {
    fail("expected_tenant_invalid");
  }
  if (!["development", "test", "staging", "production"].includes(input.expectedTenantEnvironment)) {
    fail("expected_tenant_environment_invalid");
  }
  if (!input.externalGrantId || input.externalGrantId.length > 500) fail("external_grant_invalid");
  if (!Number.isFinite(input.externalExpiresAt) || input.externalExpiresAt < now + MIN_ENTITLEMENT_MS) {
    fail("external_grant_expired");
  }

  let subject: LocalCaseSubject | null;
  try {
    subject = await store.resolveLocalCase(caseId);
  } catch {
    fail("case_resolution_error");
  }
  if (!subject) fail("case_not_found");
  if (
    requireUuid(subject.caseId, "resolved_case_invalid") !== caseId
    || requireUuid(subject.tenantId, "resolved_tenant_invalid") !== subject.tenantId.toLowerCase()
    || requireUuid(subject.residentId, "resolved_resident_invalid") !== subject.residentId.toLowerCase()
  ) {
    fail("case_resolution_mismatch");
  }
  if (subject.tenantSlug !== input.expectedTenantSlug) fail("tenant_mismatch");
  if (subject.tenantFictional || subject.tenantEnvironment === "sandbox") fail("production_case_required");
  if (subject.tenantEnvironment !== input.expectedTenantEnvironment) fail("tenant_environment_mismatch");
  const linkedAuthUserId = subject.authUserId === null
    ? null
    : requireUuid(subject.authUserId, "case_account_invalid");
  if (linkedAuthUserId !== null && linkedAuthUserId !== userId) fail("case_account_mismatch");

  const expiresAt = Math.min(input.externalExpiresAt, now + MAX_ENTITLEMENT_MS);
  const externalGrantDigest = hexDigest(PROVIDER_KEY, input.externalGrantId);
  const proofDigest = hexDigest(
    "civya-case-proof-v1",
    subject.tenantId,
    caseId,
    userId,
    input.method,
    externalGrantDigest,
  );
  const evidenceDigest = hexDigest(
    "civya-case-evidence-v1",
    subject.tenantId,
    caseId,
    userId,
    externalGrantDigest,
  );
  const proofIdempotencyKey = `identity-proof:${proofDigest}`;
  const entitlementIdempotencyKey = `case-entitlement:${hexDigest(
    proofDigest,
    SCOPES.join(","),
  )}`;
  const proofExpiresAt = new Date(expiresAt).toISOString();

  // A governed County source can stage a case before its resident creates a
  // Civya account. That first binding uses one database RPC so ownership,
  // successful proof, entitlement, and audit evidence either all commit or all
  // roll back. Already-linked cases continue through the narrower proof/grant
  // RPCs below; the claim RPC cannot be used to reassign them.
  if (linkedAuthUserId === null) {
    let claimed: ClaimedProductionCaseEntitlement;
    try {
      claimed = await store.claimVerifiedProductionCase({
        tenantId: subject.tenantId,
        caseId,
        actorUserId: userId,
        method: databaseMethod(input.method),
        providerKey: PROVIDER_KEY,
        proofResult: "verified",
        verifierGrantDigest: externalGrantDigest,
        expiresAt: proofExpiresAt,
      });
    } catch {
      fail("case_claim_error");
    }
    const entitlementId = requireUuid(claimed.entitlementId, "case_claim_response_invalid");
    requireUuid(claimed.challengeId, "case_claim_response_invalid");
    if (
      requireUuid(claimed.caseId, "case_claim_case_invalid") !== caseId
      || requireUuid(claimed.residentId, "case_claim_resident_invalid") !== subject.residentId.toLowerCase()
      || claimed.state !== "active"
      || claimed.scopes.length !== SCOPES.length
      || claimed.scopes.some((scope, index) => scope !== SCOPES[index])
    ) {
      fail("case_claim_response_invalid");
    }
    const persistedExpiry = Date.parse(requireIsoFuture(
      claimed.expiresAt,
      now,
      "case_claim_response_expired",
    ));
    if (persistedExpiry > expiresAt + 1_000) fail("entitlement_expiry_mismatch");

    let status: EntitlementStatus;
    try {
      status = await store.entitlementStatus(userId, caseId);
    } catch {
      fail("entitlement_status_error");
    }
    if (!status.authorized || status.accessType !== "case_entitlement") {
      fail("entitlement_not_active");
    }

    return Object.freeze({
      entitlementId,
      caseId,
      tenantId: subject.tenantId,
      residentId: subject.residentId,
      scopes: SCOPES,
      expiresAt: Math.min(expiresAt, persistedExpiry),
      duplicate: claimed.duplicate,
    });
  }

  let proof: CreatedProof;
  try {
    proof = await store.createProof({
      actorUserId: userId,
      caseId,
      method: databaseMethod(input.method),
      providerKey: PROVIDER_KEY,
      challengeDigest: proofDigest,
      expiresAt: proofExpiresAt,
      idempotencyKey: proofIdempotencyKey,
    });
  } catch {
    fail("proof_create_error");
  }
  const challengeId = requireUuid(proof.challengeId, "proof_response_invalid");
  requireIsoFuture(proof.expiresAt, now, "proof_response_expired");
  if (proof.state !== "pending" && proof.state !== "verified") fail("proof_state_invalid");

  let resolved: ResolvedProof;
  try {
    resolved = await store.resolveProof({
      challengeId,
      result: "verified",
      assuranceLevel: "substantial",
      evidenceDigest,
      providerReference: `sha256:${externalGrantDigest}`,
    });
  } catch {
    fail("proof_resolve_error");
  }
  if (
    requireUuid(resolved.challengeId, "proof_resolution_invalid") !== challengeId
    || resolved.state !== "verified"
    || resolved.assuranceLevel !== "substantial"
  ) {
    fail("proof_resolution_invalid");
  }

  let entitlement: GrantedEntitlement;
  try {
    entitlement = await store.grantEntitlement({
      challengeId,
      scopes: SCOPES,
      expiresAt: new Date(expiresAt).toISOString(),
      grantReasonCode: "external_case_identity_verified",
      idempotencyKey: entitlementIdempotencyKey,
    });
  } catch {
    fail("entitlement_grant_error");
  }
  const entitlementId = requireUuid(entitlement.entitlementId, "entitlement_response_invalid");
  if (
    requireUuid(entitlement.caseId, "entitlement_case_invalid") !== caseId
    || entitlement.state !== "active"
  ) {
    fail("entitlement_response_invalid");
  }
  const persistedExpiry = Date.parse(requireIsoFuture(
    entitlement.expiresAt,
    now,
    "entitlement_response_expired",
  ));
  if (persistedExpiry > expiresAt + 1_000) fail("entitlement_expiry_mismatch");

  let status: EntitlementStatus;
  try {
    status = await store.entitlementStatus(userId, caseId);
  } catch {
    fail("entitlement_status_error");
  }
  if (!status.authorized || status.accessType !== "case_entitlement") {
    fail("entitlement_not_active");
  }

  return Object.freeze({
    entitlementId,
    caseId,
    tenantId: subject.tenantId,
    residentId: subject.residentId,
    scopes: SCOPES,
    expiresAt: Math.min(expiresAt, persistedExpiry),
    duplicate: entitlement.duplicate,
  });
}

class SupabaseCaseEntitlementStore implements CaseEntitlementPersistenceStore {
  constructor(private readonly client: SupabaseClient) {}

  async resolveLocalCase(caseId: string): Promise<LocalCaseSubject | null> {
    const caseResult = await this.client
      .from("cases")
      .select("id,tenant_id,resident_id")
      .eq("id", caseId)
      .maybeSingle();
    if (caseResult.error) throw caseResult.error;
    if (!caseResult.data) return null;
    const row = caseResult.data as Record<string, unknown>;
    const tenantId = requireUuid(row.tenant_id, "case_tenant_invalid");
    const residentId = requireUuid(row.resident_id, "case_resident_invalid");
    const [tenantResult, residentResult] = await Promise.all([
      this.client
        .from("tenants")
        .select("id,slug,environment,fictional")
        .eq("id", tenantId)
        .maybeSingle(),
      this.client
        .from("residents")
        .select("id,tenant_id,auth_user_id")
        .eq("id", residentId)
        .maybeSingle(),
    ]);
    if (tenantResult.error) throw tenantResult.error;
    if (residentResult.error) throw residentResult.error;
    if (!tenantResult.data || !residentResult.data) return null;
    const tenant = tenantResult.data as Record<string, unknown>;
    const resident = residentResult.data as Record<string, unknown>;
    if (
      requireUuid(tenant.id, "tenant_record_invalid") !== tenantId
      || requireUuid(resident.id, "resident_record_invalid") !== residentId
      || requireUuid(resident.tenant_id, "resident_tenant_invalid") !== tenantId
    ) {
      fail("case_tenant_chain_mismatch");
    }
    return {
      caseId: requireUuid(row.id, "case_record_invalid"),
      tenantId,
      tenantSlug: typeof tenant.slug === "string" ? tenant.slug : "",
      tenantEnvironment: typeof tenant.environment === "string" ? tenant.environment : "",
      tenantFictional: bool(tenant.fictional),
      residentId,
      authUserId: resident.auth_user_id === null
        ? null
        : requireUuid(resident.auth_user_id, "resident_account_invalid"),
    };
  }

  async claimVerifiedProductionCase(
    input: ClaimVerifiedProductionCaseInput,
  ): Promise<ClaimedProductionCaseEntitlement> {
    const { data, error } = await this.client.rpc("civya_service_claim_verified_production_case", {
      p_tenant_id: input.tenantId,
      p_case_id: input.caseId,
      p_actor_user_id: input.actorUserId,
      p_method: input.method,
      p_provider_key: input.providerKey,
      p_proof_result: input.proofResult,
      p_verifier_grant_digest: input.verifierGrantDigest,
      p_expires_at: input.expiresAt,
    });
    if (error) throw error;
    const row = requireObject(data, "case_claim_rpc_empty");
    const scopes = Array.isArray(row.scopes)
      ? row.scopes.filter((scope): scope is EntitlementScope => typeof scope === "string")
      : [];
    return {
      challengeId: String(row.challengeId || ""),
      entitlementId: String(row.entitlementId || ""),
      caseId: String(row.caseId || ""),
      residentId: String(row.residentId || ""),
      state: row.state as ClaimedProductionCaseEntitlement["state"],
      scopes,
      expiresAt: String(row.expiresAt || ""),
      duplicate: bool(row.duplicate),
    };
  }

  async createProof(input: CreateProofInput): Promise<CreatedProof> {
    const { data, error } = await this.client.rpc("civya_service_create_identity_proof_challenge", {
      p_actor_user_id: input.actorUserId,
      p_case_id: input.caseId,
      p_method: input.method,
      p_provider_key: input.providerKey,
      p_challenge_digest: input.challengeDigest,
      p_expires_at: input.expiresAt,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw error;
    const row = requireObject(data, "proof_rpc_empty");
    return {
      challengeId: String(row.challengeId || ""),
      state: row.state as CreatedProof["state"],
      expiresAt: String(row.expiresAt || ""),
      duplicate: bool(row.duplicate),
    };
  }

  async resolveProof(input: ResolveProofInput): Promise<ResolvedProof> {
    const { data, error } = await this.client.rpc("civya_service_resolve_identity_proof_challenge", {
      p_challenge_id: input.challengeId,
      p_result: input.result,
      p_assurance_level: input.assuranceLevel,
      p_evidence_digest: input.evidenceDigest,
      p_provider_reference: input.providerReference,
    });
    if (error) throw error;
    const row = requireObject(data, "proof_resolution_rpc_empty");
    return {
      challengeId: String(row.challengeId || ""),
      state: row.state as ResolvedProof["state"],
      assuranceLevel: row.assuranceLevel as ResolvedProof["assuranceLevel"],
    };
  }

  async grantEntitlement(input: GrantEntitlementInput): Promise<GrantedEntitlement> {
    const { data, error } = await this.client.rpc("civya_service_grant_case_entitlement", {
      p_staff_actor_user_id: null,
      p_challenge_id: input.challengeId,
      p_scopes: [...input.scopes],
      p_expires_at: input.expiresAt,
      p_grant_reason_code: input.grantReasonCode,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw error;
    const row = requireObject(data, "entitlement_rpc_empty");
    return {
      entitlementId: String(row.entitlementId || ""),
      caseId: String(row.caseId || ""),
      state: row.state as GrantedEntitlement["state"],
      expiresAt: String(row.expiresAt || ""),
      duplicate: bool(row.duplicate),
    };
  }

  async entitlementStatus(actorUserId: string, caseId: string): Promise<EntitlementStatus> {
    const { data, error } = await this.client.rpc("civya_service_case_entitlement_status", {
      p_actor_user_id: actorUserId,
      p_case_id: caseId,
    });
    if (error) throw error;
    const row = requireObject(data, "entitlement_status_rpc_empty");
    return {
      authorized: bool(row.authorized),
      accessType: typeof row.accessType === "string" ? row.accessType : undefined,
      reason: typeof row.reason === "string" ? row.reason : undefined,
    };
  }
}

export function createSupabaseCaseEntitlementStore(): CaseEntitlementPersistenceStore {
  try {
    return new SupabaseCaseEntitlementStore(createSupabaseAdminClient());
  } catch {
    fail("supabase_service_configuration_missing");
  }
}

/**
 * Credential-free tests may opt into this store only with a fixed set of
 * synthetic subjects. It cannot be selected by a hosted runtime or resolve an
 * arbitrary case binding.
 */
export function createBoundedSyntheticEntitlementStore(input: {
  marker: "civya-entitlement-tests-only";
  subjects: readonly LocalCaseSubject[];
}): CaseEntitlementPersistenceStore {
  if (
    input.marker !== "civya-entitlement-tests-only"
    || process.env.NODE_ENV === "production"
    || Boolean(process.env.VERCEL)
    || process.env.CIVYA_SYNTHETIC_MODE !== "true"
  ) {
    fail("synthetic_persistence_not_allowed");
  }
  const subjects = new Map(input.subjects.map((subject) => [subject.caseId.toLowerCase(), { ...subject }]));
  const proofs = new Map<string, CreatedProof & { caseId: string; evidenceDigest?: string }>();
  const entitlements = new Map<string, GrantedEntitlement>();
  const claims = new Map<string, ClaimedProductionCaseEntitlement & {
    tenantId: string;
    actorUserId: string;
    method: DatabaseProofMethod;
  }>();
  const authorized = new Set<string>();

  return {
    async resolveLocalCase(caseId) {
      return subjects.get(caseId.toLowerCase()) || null;
    },
    async claimVerifiedProductionCase(claimInput) {
      const claimKey = `${claimInput.providerKey}:${claimInput.verifierGrantDigest}`;
      const existing = claims.get(claimKey);
      if (existing) {
        if (
          existing.tenantId !== claimInput.tenantId
          || existing.caseId !== claimInput.caseId
          || existing.actorUserId !== claimInput.actorUserId
          || existing.method !== claimInput.method
          || existing.expiresAt !== claimInput.expiresAt
        ) {
          throw new Error("synthetic claim idempotency conflict");
        }
        return { ...existing, duplicate: true };
      }
      const subject = subjects.get(claimInput.caseId.toLowerCase());
      if (
        !subject
        || subject.tenantId !== claimInput.tenantId
        || subject.authUserId !== null
        || claimInput.proofResult !== "verified"
        || claimInput.providerKey !== PROVIDER_KEY
        || !SHA256.test(claimInput.verifierGrantDigest)
      ) {
        throw new Error("synthetic verified production case claim rejected");
      }
      subject.authUserId = claimInput.actorUserId;
      const claim: ClaimedProductionCaseEntitlement & {
        tenantId: string;
        actorUserId: string;
        method: DatabaseProofMethod;
      } = {
        challengeId: syntheticUuid(`claim-proof:${claimKey}`, 4),
        entitlementId: syntheticUuid(`claim-entitlement:${claimKey}`, 4),
        caseId: subject.caseId,
        residentId: subject.residentId,
        state: "active",
        scopes: SCOPES,
        expiresAt: claimInput.expiresAt,
        duplicate: false,
        tenantId: claimInput.tenantId,
        actorUserId: claimInput.actorUserId,
        method: claimInput.method,
      };
      claims.set(claimKey, claim);
      authorized.add(`${claimInput.actorUserId.toLowerCase()}:${subject.caseId.toLowerCase()}`);
      return claim;
    },
    async createProof(proofInput) {
      const existing = proofs.get(proofInput.idempotencyKey);
      if (existing) return { ...existing, duplicate: true };
      const proof: CreatedProof = {
        challengeId: syntheticUuid(proofInput.idempotencyKey, 4),
        state: "pending",
        expiresAt: proofInput.expiresAt,
        duplicate: false,
      };
      proofs.set(proofInput.idempotencyKey, { ...proof, caseId: proofInput.caseId });
      return proof;
    },
    async resolveProof(resolveInput) {
      const proof = [...proofs.values()].find((candidate) => candidate.challengeId === resolveInput.challengeId);
      if (!proof) throw new Error("synthetic proof missing");
      if (proof.evidenceDigest && proof.evidenceDigest !== resolveInput.evidenceDigest) {
        throw new Error("synthetic proof idempotency conflict");
      }
      proof.state = "verified";
      proof.evidenceDigest = resolveInput.evidenceDigest;
      return {
        challengeId: proof.challengeId,
        state: "verified",
        assuranceLevel: "substantial",
      };
    },
    async grantEntitlement(grantInput) {
      const existing = entitlements.get(grantInput.idempotencyKey);
      if (existing) return { ...existing, duplicate: true };
      const proof = [...proofs.values()].find((candidate) => candidate.challengeId === grantInput.challengeId);
      if (!proof || proof.state !== "verified") throw new Error("synthetic verified proof required");
      const subject = subjects.get(proof.caseId.toLowerCase());
      if (!subject || !subject.authUserId) throw new Error("synthetic subject missing");
      const entitlement: GrantedEntitlement = {
        entitlementId: syntheticUuid(grantInput.idempotencyKey, 4),
        caseId: subject.caseId,
        state: "active",
        expiresAt: grantInput.expiresAt,
        duplicate: false,
      };
      entitlements.set(grantInput.idempotencyKey, entitlement);
      authorized.add(`${subject.authUserId.toLowerCase()}:${subject.caseId.toLowerCase()}`);
      return entitlement;
    },
    async entitlementStatus(actorUserId, caseId) {
      const active = authorized.has(`${actorUserId.toLowerCase()}:${caseId.toLowerCase()}`);
      return active
        ? { authorized: true, accessType: "case_entitlement" }
        : { authorized: false, reason: "case_entitlement_required" };
    },
  };
}

function syntheticUuid(seed: string, version: 4 | 5): string {
  const bytes = Buffer.from(hexDigest("synthetic-uuid", seed).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | (version << 4);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  if (!SHA256.test(hexDigest(hex))) fail("synthetic_uuid_generation_failed");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
