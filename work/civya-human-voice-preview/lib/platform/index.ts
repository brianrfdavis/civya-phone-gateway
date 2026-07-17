export { PlatformConfigurationError, isSupabaseConfigured } from "@/lib/supabase/config";
export {
  CivyaPlatform,
  PlatformDataError,
  checkPlatformHealth,
  createAccessTokenPlatform,
  createAdminPlatform,
  createRequestPlatform,
  getSessionPrincipal,
  pruneExpiredDemoData,
  redeemDemoInvitation,
} from "./repository";
export { redactTranscript } from "./redaction";
export type * from "./types";

import type { CivyaPlatform } from "./repository";
import type {
  CommitTurnInput,
  DocumentMetadataInput,
  DocumentUploadRequest,
  TurnEnvelope,
  TurnSpeaker,
} from "./types";

/** Small functional wrappers for Route Handlers that do not need the class API. */
export const ensureResidentWorkspace = (
  platform: CivyaPlatform,
  tenantSlug?: string,
  channel?: "voice" | "text",
) => platform.ensureResidentWorkspace(tenantSlug, channel);

export const bootstrapSession = ensureResidentWorkspace;

export const bootstrapEntitledProductionCase = (
  platform: CivyaPlatform,
  caseId: string,
  entitlementId: string,
  channel?: "voice" | "text",
) => platform.bootstrapEntitledProductionCase(caseId, entitlementId, channel);

export const findTurnByIdempotency = (
  platform: CivyaPlatform,
  conversationId: string,
  idempotencyKey: string,
) => platform.findTurnByIdempotency(conversationId, idempotencyKey);

export const appendTurn = (platform: CivyaPlatform, envelope: TurnEnvelope, speaker?: TurnSpeaker) =>
  platform.appendTurn(envelope, speaker);

export const loadCaseSnapshot = (platform: CivyaPlatform, caseId: string) =>
  platform.loadCaseSnapshot(caseId);

export const upsertCaseFacts = (
  platform: CivyaPlatform,
  input: Parameters<CivyaPlatform["upsertCaseFacts"]>[0],
) => platform.upsertCaseFacts(input);

export const commitTurnResult = (platform: CivyaPlatform, input: CommitTurnInput) =>
  platform.commitTurnResult(input);

export const finishConversation = (platform: CivyaPlatform, conversationId: string, summary?: string) =>
  platform.finishConversation(conversationId, summary);

export const markIdentityVerified = (platform: CivyaPlatform) => platform.markIdentityVerified();

export const createCaseTransferGrant = (platform: CivyaPlatform, caseId: string, ttlSeconds?: number) =>
  platform.createCaseTransferGrant(caseId, ttlSeconds);

export const redeemCaseTransferGrant = (platform: CivyaPlatform, token: string) =>
  platform.redeemCaseTransferGrant(token);

export const createDocumentUploadGrant = (platform: CivyaPlatform, input: DocumentUploadRequest) =>
  platform.createDocumentUploadGrant(input);

export const inspectDocumentUploadObject = (
  platform: CivyaPlatform,
  input: Parameters<CivyaPlatform["inspectDocumentUploadObject"]>[0],
) => platform.inspectDocumentUploadObject(input);

export const recordDocumentMetadata = (platform: CivyaPlatform, input: DocumentMetadataInput) =>
  platform.recordDocumentMetadata(input);

export const createDocumentDownloadUrl = (
  platform: CivyaPlatform,
  documentId: string,
  expiresInSeconds?: number,
) => platform.createDocumentDownloadUrl(documentId, expiresInSeconds);

export const staffBootstrap = (platform: CivyaPlatform, tenantSlug: string) =>
  platform.staffBootstrap(tenantSlug);

export const appendAuditEvent = (
  platform: CivyaPlatform,
  input: Parameters<CivyaPlatform["appendAuditEvent"]>[0],
) => platform.appendAuditEvent(input);

export const takeRateLimit = (
  platform: CivyaPlatform,
  input: Parameters<CivyaPlatform["takeRateLimit"]>[0],
) => platform.takeRateLimit(input);

export const createDemoInvitation = (
  platform: CivyaPlatform,
  input: Parameters<CivyaPlatform["createDemoInvitation"]>[0],
) => platform.createDemoInvitation(input);

export const resetTenantSandbox = (platform: CivyaPlatform, tenantSlug?: string) =>
  platform.resetTenantSandbox(tenantSlug);
