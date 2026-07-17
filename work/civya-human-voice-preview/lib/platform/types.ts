import type {
  ConversationChannel,
  InteractionState,
  ResumeContext,
  SessionBootstrap,
  TurnEnvelope,
  TurnResult,
} from "@/lib/conversation/contracts";
import type { CaseAccessBinding, CaseAccessScope } from "@/lib/auth/contracts";

export type {
  ActiveCaseSummary,
  AuthRequiredPayload,
  ConfirmedFact,
  ConversationChannel,
  EmailChallengeResult,
  RedactedTurn,
  ResidentIdentity,
  ResumeContext,
  SessionBootstrap,
  TurnEnvelope,
  TurnResult,
} from "@/lib/conversation/contracts";

export type TurnSpeaker = "user" | "assistant" | "system";

export interface SessionPrincipal {
  userId: string;
  email?: string;
  isAnonymous: boolean;
  isVerified: boolean;
  role: "resident" | "reviewer" | "admin" | "service";
  userMetadata: Record<string, unknown>;
  appMetadata: Record<string, unknown>;
}

export interface CaseTransferGrant {
  token: string;
  grantId: string;
  expiresAt: string;
}

export interface CaseTransferResult {
  caseId: string;
  residentId: string;
  requiresCaseSelection: boolean;
  existingActiveCaseId?: string;
}

export interface EntitlementCacheStatus {
  authorized: boolean;
  reason?: string;
  accessType?: "case_entitlement" | "fictional_invitation";
  entitlementId?: string;
  tenantId?: string;
  caseId?: string;
  purpose?: "case_access";
  scopes?: readonly CaseAccessScope[];
  rowVersion?: number;
  expiresAt?: string;
}

export interface FinalizedCaseEntitlement extends CaseAccessBinding {
  accessType: "case_entitlement" | "fictional_invitation";
  entitlementId?: string;
  rowVersion: number;
  expiresAt: string;
  requiresCaseSelection: boolean;
  existingActiveCaseId?: string;
  selectionId?: string;
  selectionExpiresAt?: string;
  existingCaseAvailable?: boolean;
}

export interface CaseEntitlementSelection {
  selectionId: string;
  tenantId: string;
  attachedCaseId: string;
  existingActiveCaseId: string;
  existingCaseAvailable: boolean;
  expiresAt: string;
}

export interface EntitlementAssistanceRequestStatus {
  found?: boolean;
  requestId: string;
  correlationId: string;
  state: "open" | "owned" | "approved" | "denied" | "expired" | "cancelled" | "unavailable";
  queueKey?: string;
  slaDueAt?: string;
  expiresAt?: string;
  rowVersion?: number;
  resolutionCode?: string;
  access?: EntitlementCacheStatus;
}

export interface AccountRecoveryChallenge {
  challengeId: string;
  correlationId: string;
  state: "pending" | "verified" | "cancelled" | "expired";
  expiresAt: string;
  duplicate?: boolean;
}

export interface PersistedTurn {
  id: string;
  conversationId: string;
  caseId: string;
  residentId: string;
  speaker: TurnSpeaker;
  channel: ConversationChannel;
  clientTurnId: string;
  providerItemId?: string;
  idempotencyKey: string;
  redactedText: string;
  processingStatus: "received" | "processing" | "committed" | "failed";
  processingResult?: TurnResult;
  sequenceNumber: number;
  createdAt: string;
  duplicate: boolean;
}

export interface CaseSnapshot {
  id: string;
  tenantId: string;
  residentId: string;
  status: string;
  rowVersion: number;
  workflowState: string;
  nextQuestion?: string;
  nextBestAction: string;
  resumeSummary: string;
  /** Legacy database JSON used only for nonofficial workflow detail. */
  workflowDetails: Record<string, unknown>;
  confirmedFacts: ResumeContext["confirmed_facts"];
  checklist: Array<Record<string, unknown>>;
  updatedAt: string;
}

export interface CommitTurnInput {
  userTurnId: string;
  expectedCaseVersion: number;
  conversationId: string;
  clientTurnId: string;
  spokenResponse: string;
  nextQuestion?: string;
  workflowState: string;
  caseStatus: string;
  conversationSummary: string;
  interactionState: InteractionState;
  confirmedFacts?: Record<string, unknown>;
  final?: boolean;
}

export interface DocumentUploadRequest {
  caseId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  idempotencyKey: string;
}

export interface DocumentUploadGrant {
  bucket: "civya-private-documents";
  path: string;
  token: string;
  signedUrl: string;
  expiresInSeconds: number;
}

export interface DocumentUploadObjectInfo {
  path: string;
  sizeBytes: number;
  contentType: string;
  metadata: Record<string, unknown>;
  etag?: string;
}

export interface DocumentMetadataInput extends DocumentUploadRequest {
  storagePath: string;
  documentType?: string;
  classificationConfidence?: number;
  extractionConfidence?: number;
  redactedExtraction?: Record<string, unknown>;
  scanStatus?: "pending" | "clean" | "rejected" | "failed";
  reviewRequired?: boolean;
  reviewReason?: string;
}

export interface StaffBootstrap {
  principal: SessionPrincipal;
  tenant: {
    id: string;
    slug: string;
    name: string;
    environment: "sandbox" | "development" | "staging" | "production";
    fictional: boolean;
  };
  role: "reviewer" | "admin";
  counts: { openReviews: number; activeCases: number; documentsNeedingReview: number };
}

export interface PlatformHealth {
  ok: boolean;
  configured: boolean;
  database: { ok: boolean; latencyMs: number; error?: string };
  storage: { ok: boolean; latencyMs: number; error?: string };
}

export interface DemoInvitationGrant {
  invitationId: string;
  tenantId: string;
  tenantSlug: string;
  scopes: string[];
  expiresAt: string;
}

export interface RetentionPruneResult {
  casesRemoved: number;
  residentsRemoved: number;
  storageObjectsRemoved: number;
  authUsersRemoved: number;
  failures: Array<{ kind: "storage_object" | "auth_user"; reference: string; error: string }>;
}

/** Raw JSON returned by civya_bootstrap_session before contract mapping. */
export interface DatabaseSessionBootstrap {
  authentication: { userId: string; isAnonymous: boolean; isVerified: boolean; email?: string };
  tenant: {
    id: string;
    slug: string;
    name: string;
    environment?: "sandbox" | "development" | "staging" | "production";
    fictional: boolean;
    retentionDays?: number;
  };
  resident: { id: string; identityState: "anonymous" | "verified" };
  activeCase: {
    id: string;
    status: string;
    rowVersion: number;
    workflowState: string;
    nextQuestion?: string;
    nextBestAction: string;
    updatedAt: string;
  };
  conversation: { id: string; channel: string; status: "active" | "ended" | "abandoned"; rowVersion: number };
  resumeContext: {
    confirmedFacts: Record<string, unknown>;
    conversationSummary: string;
    recentTurns: Array<{ id: string; speaker: string; channel: string; text: string; created_at?: string; createdAt?: string }>;
    currentWorkflowState: string;
    nextQuestion?: string;
  };
  nextAction: { kind: string; prompt?: string };
  authorization?: {
    entitlementId: string;
    caseId: string;
    scopes: readonly CaseAccessScope[];
    expiresAt: string;
    rowVersion: number;
  };
}

export type CanonicalContracts = {
  SessionBootstrap: SessionBootstrap;
  TurnEnvelope: TurnEnvelope;
  TurnResult: TurnResult;
  ResumeContext: ResumeContext;
};
