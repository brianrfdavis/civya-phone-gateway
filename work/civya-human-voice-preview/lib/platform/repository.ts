import crypto from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { CaseAccessBinding, CaseAccessScope } from "@/lib/auth/contracts";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { configuredSyntheticTenantSlug } from "@/lib/security/synthetic-sandbox";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  PlatformConfigurationError,
  getSupabaseServiceRoleKey,
  isSupabaseConfigured,
} from "@/lib/supabase/config";
import { createSupabaseAccessTokenClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { redactTranscript } from "./redaction";
import type {
  CaseSnapshot,
  CaseEntitlementSelection,
  CaseTransferGrant,
  CaseTransferResult,
  AccountRecoveryChallenge,
  CommitTurnInput,
  DatabaseSessionBootstrap,
  DemoInvitationGrant,
  DocumentMetadataInput,
  DocumentUploadGrant,
  DocumentUploadObjectInfo,
  DocumentUploadRequest,
  EntitlementAssistanceRequestStatus,
  EntitlementCacheStatus,
  FinalizedCaseEntitlement,
  PersistedTurn,
  PlatformHealth,
  RetentionPruneResult,
  SessionBootstrap,
  SessionPrincipal,
  StaffBootstrap,
  TurnEnvelope,
  TurnResult,
  TurnSpeaker,
} from "./types";

const PRIVATE_DOCUMENT_BUCKET = "civya-private-documents" as const;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

type Row = Record<string, unknown>;

export class PlatformDataError extends Error {
  constructor(
    message: string,
    readonly code = "platform_data_error",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PlatformDataError";
  }
}

function databaseChannel(channel: "voice" | "text"): "voice" | "chat" {
  return channel === "text" ? "chat" : "voice";
}

function canonicalChannel(channel: unknown): "voice" | "text" {
  return channel === "voice" ? "voice" : "text";
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new PlatformDataError(`Missing ${field} in data response.`);
  return value;
}

function boundEntitlementHandoffIdentity(input: {
  userId: string;
  transferToken?: string;
  binding: CaseAccessBinding;
  method: "notice_code" | "invitation_code";
}) {
  const transferDigest = input.transferToken
    ? crypto.createHash("sha256").update(input.transferToken).digest("hex")
    : null;
  const idempotencyKey = `bound-entitlement:${crypto.createHash("sha256").update([
    input.userId,
    input.binding.tenantId,
    input.binding.caseId,
    input.binding.purpose,
    input.binding.scopes.join(","),
    transferDigest || "direct",
    input.method,
  ].join("\0")).digest("hex")}`;
  return { transferDigest, idempotencyKey };
}

function snakeOrCamel(row: Row, snake: string, camel: string): unknown {
  return row[snake] ?? row[camel];
}

function mapTurn(row: Row, duplicate = false): PersistedTurn {
  const rawResult = snakeOrCamel(row, "processing_result", "processingResult") as Record<string, unknown> | null;
  return {
    id: requiredString(row.id, "turn id"),
    conversationId: requiredString(snakeOrCamel(row, "conversation_id", "conversationId"), "conversation id"),
    caseId: requiredString(snakeOrCamel(row, "case_id", "caseId"), "case id"),
    residentId: requiredString(snakeOrCamel(row, "resident_id", "residentId"), "resident id"),
    speaker: (row.speaker as TurnSpeaker) || "user",
    channel: canonicalChannel(row.channel),
    clientTurnId: requiredString(snakeOrCamel(row, "client_turn_id", "clientTurnId"), "client turn id"),
    providerItemId: (snakeOrCamel(row, "provider_item_id", "providerItemId") as string | undefined) || undefined,
    idempotencyKey: requiredString(snakeOrCamel(row, "idempotency_key", "idempotencyKey"), "idempotency key"),
    redactedText: requiredString(snakeOrCamel(row, "redacted_text", "redactedText"), "redacted text"),
    processingStatus: (snakeOrCamel(row, "processing_status", "processingStatus") as PersistedTurn["processingStatus"]) || "received",
    processingResult: rawResult ? normalizeStoredTurnResult(row, rawResult) : undefined,
    sequenceNumber: Number(snakeOrCamel(row, "sequence_number", "sequenceNumber") || 0),
    createdAt: requiredString(snakeOrCamel(row, "created_at", "createdAt"), "created at"),
    duplicate,
  };
}

function normalizeStoredTurnResult(row: Row, raw: Record<string, unknown>): TurnResult {
  const rawCase = (raw.case_update || raw.caseUpdate) as Record<string, unknown> | undefined;
  const interaction = raw.interaction_state ?? raw.interactionState ?? raw.completion_state ?? raw.completionState;
  const interactionRecord = typeof interaction === "object" && interaction ? (interaction as Record<string, unknown>) : undefined;
  const rawState = typeof interaction === "string" ? interaction : interactionRecord?.state;
  const state = (rawState === "complete" ? "conversation_ended" : rawState) as TurnResult["interaction_state"] | undefined;
  return {
    conversation_id: requiredString(snakeOrCamel(row, "conversation_id", "conversationId"), "conversation id"),
    client_turn_id: requiredString(snakeOrCamel(row, "client_turn_id", "clientTurnId"), "client turn id"),
    spoken_response: String(raw.spoken_response ?? raw.spokenResponse ?? ""),
    case_update: rawCase
      ? {
          id: String(rawCase.id ?? rawCase.caseId ?? snakeOrCamel(row, "case_id", "caseId")),
          status: String(rawCase.status || "intake_in_progress"),
          row_version: Number(rawCase.row_version ?? rawCase.rowVersion ?? 0),
          next_best_action: String(rawCase.next_best_action ?? raw.nextQuestion ?? "Continue the guided conversation."),
          likely_pathways: Array.isArray(rawCase.likely_pathways) ? (rawCase.likely_pathways as string[]) : [],
          missing_documents: Array.isArray(rawCase.missing_documents) ? (rawCase.missing_documents as string[]) : [],
        }
      : undefined,
    next_question: (raw.next_question ?? raw.nextQuestion) as string | undefined,
    interaction_state: state || "continue",
    persistence: {
      state: "saved",
      saved_at: (snakeOrCamel(row, "committed_at", "committedAt") as string | undefined) || undefined,
    },
    final: Boolean(raw.final ?? interactionRecord?.final),
  };
}

function errorCode(error: { code?: string; message?: string }): PlatformDataError {
  const retryable = error.code === "40001" || error.code === "57014" || error.code === "PGRST003";
  return new PlatformDataError(error.message || "The data service could not complete the request.", error.code, retryable);
}

function userIsAnonymous(user: User): boolean {
  const typed = user as User & { is_anonymous?: boolean };
  return typed.is_anonymous ?? user.app_metadata?.provider === "anonymous";
}

export async function getSessionPrincipal(
  client: SupabaseClient,
  accessToken?: string,
): Promise<SessionPrincipal | null> {
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) return null;

  const isAnonymous = userIsAnonymous(data.user);
  let role: SessionPrincipal["role"] = "resident";
  const { data: staff } = await client
    .from("staff_roles")
    .select("role")
    .eq("auth_user_id", data.user.id)
    .eq("status", "active")
    .in("role", ["reviewer", "admin"])
    .limit(1)
    .maybeSingle();
  if (staff?.role === "admin" || staff?.role === "reviewer") role = staff.role;

  const hasConfirmedEmail = Boolean(
    data.user.email && (data.user.email_confirmed_at || data.user.confirmed_at),
  );

  return {
    userId: data.user.id,
    email: data.user.email || undefined,
    isAnonymous,
    isVerified: !isAnonymous && hasConfirmedEmail,
    role,
    userMetadata: (data.user.user_metadata as Record<string, unknown>) || {},
    appMetadata: (data.user.app_metadata as Record<string, unknown>) || {},
  };
}

function mapBootstrap(raw: DatabaseSessionBootstrap, principal: SessionPrincipal): SessionBootstrap {
  const now = new Date().toISOString();
  const confirmedFacts = Object.entries(raw.resumeContext.confirmedFacts || {}).map(([key, value]) => ({
    key,
    value: stringValue(value),
    confirmed_at: now,
  }));
  const recentTurns = (raw.resumeContext.recentTurns || [])
    .filter((turn) => turn.speaker === "user" || turn.speaker === "assistant")
    .map((turn) => ({
      id: turn.id,
      role: turn.speaker as "user" | "assistant",
      text: turn.text,
      channel: canonicalChannel(turn.channel),
      created_at: turn.created_at || turn.createdAt || now,
      redacted: true as const,
    }));
  const state = raw.authentication.isVerified ? "verified" : "anonymous";

  return {
    auth: {
      state,
      masked_email: raw.authentication.email ? maskEmail(raw.authentication.email) : undefined,
      staff_role: principal.role === "admin" || principal.role === "reviewer" ? principal.role : undefined,
    },
    resident: {
      id: raw.resident.id,
      authentication_state: state,
      masked_email: raw.authentication.email ? maskEmail(raw.authentication.email) : undefined,
    },
    active_case: {
      id: raw.activeCase.id,
      status: raw.activeCase.status,
      row_version: raw.activeCase.rowVersion,
      next_best_action: raw.activeCase.nextBestAction,
      likely_pathways: [],
      missing_documents: [],
    },
    conversation: {
      id: raw.conversation.id,
      status: raw.conversation.status === "ended" ? "ended" : "active",
    },
    resume_context: {
      confirmed_facts: confirmedFacts,
      conversation_summary: raw.resumeContext.conversationSummary || "",
      recent_turns: recentTurns,
      current_workflow_state: raw.resumeContext.currentWorkflowState,
      next_question: raw.resumeContext.nextQuestion,
    },
    next_action: {
      kind: raw.activeCase.nextQuestion ? "ask_question" : "general",
      question: raw.activeCase.nextQuestion || raw.nextAction.prompt,
    },
    persistence: { state: "saved" },
    capabilities: {
      voice: true,
      uploads: principal.isVerified,
      reminders: principal.isVerified,
      staff: principal.role === "admin" || principal.role === "reviewer",
    },
    tenant: {
      id: raw.tenant.id,
      slug: raw.tenant.slug,
      name: raw.tenant.name,
      environment: raw.tenant.environment || "sandbox",
      fictional: raw.tenant.fictional,
    },
    sandbox: {
      fictional: raw.tenant.fictional,
      retention_days: Number(raw.tenant.retentionDays || 30),
    },
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

export class CivyaPlatform {
  private serviceClient?: SupabaseClient;

  constructor(
    readonly client: SupabaseClient,
    readonly principal: SessionPrincipal,
    serviceClient?: SupabaseClient,
  ) {
    this.serviceClient = serviceClient;
  }

  private service(): SupabaseClient {
    this.serviceClient ||= createSupabaseAdminClient();
    return this.serviceClient;
  }

  private actorRpcContext(): {
    p_actor_user_id: string;
    p_actor_email: string;
    p_actor_is_anonymous: boolean;
  } {
    return {
      p_actor_user_id: this.principal.userId,
      p_actor_email: this.principal.email || "",
      p_actor_is_anonymous: this.principal.isAnonymous,
    };
  }

  private async assertCaseAccess(caseId: string): Promise<Row> {
    const { data, error } = await this.client
      .from("cases")
      .select("id,tenant_id,resident_id,row_version")
      .eq("id", caseId)
      .single();
    if (error) throw errorCode(error);
    return data as Row;
  }

  private async assertConversationAccess(conversationId: string): Promise<Row> {
    const { data, error } = await this.client
      .from("conversations")
      .select("id,case_id,resident_id")
      .eq("id", conversationId)
      .single();
    if (error) throw errorCode(error);
    return data as Row;
  }

  private async assertTurnAccess(turnId: string): Promise<Row> {
    const { data, error } = await this.client
      .from("turns")
      .select("id,conversation_id,case_id,resident_id")
      .eq("id", turnId)
      .single();
    if (error) throw errorCode(error);
    return data as Row;
  }

  private async assertResidentAccess(residentId: string): Promise<Row> {
    const { data, error } = await this.client
      .from("residents")
      .select("id,tenant_id")
      .eq("id", residentId)
      .single();
    if (error) throw errorCode(error);
    return data as Row;
  }

  async assertSyntheticSandboxCase(caseId: string): Promise<void> {
    const runtime = getRuntimeConfig();
    if (!runtime.syntheticMode || runtime.environment === "production") {
      throw new PlatformDataError(
        "This operation is available only in Civya's fictional sandbox.",
        "sandbox_only",
      );
    }
    const caseResult = await this.client
      .from("cases")
      .select("id,tenant_id")
      .eq("id", caseId)
      .single();
    if (caseResult.error) throw errorCode(caseResult.error);
    const tenantResult = await this.client
      .from("tenants")
      .select("id,slug,environment,fictional,status")
      .eq("id", caseResult.data.tenant_id)
      .single();
    if (tenantResult.error) throw errorCode(tenantResult.error);
    if (
      tenantResult.data.slug !== configuredSyntheticTenantSlug()
      || !Object.values(runtime.tenantHosts).includes(tenantResult.data.slug)
      || tenantResult.data.environment !== "sandbox"
      || tenantResult.data.fictional !== true
      || tenantResult.data.status !== "active"
    ) {
      throw new PlatformDataError(
        "This operation is available only in Civya's fictional sandbox.",
        "sandbox_only",
      );
    }
  }

  private requireVerifiedResident(message = "Verified Supabase identity required."): void {
    if (this.principal.role === "resident" && !this.principal.isVerified) {
      throw new PlatformDataError(message, "verification_required");
    }
  }

  async grantTenantAccess(input: {
    tenantSlug: string;
    invitationId: string;
    expiresAt: string;
  }): Promise<{ tenantId: string; tenantSlug: string; invitationId: string; expiresAt: string }> {
    const expiresAt = new Date(input.expiresAt);
    if (!input.invitationId || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new PlatformDataError("The county demo invitation is invalid or expired.", "demo_access_required");
    }
    const { data, error } = await this.service().rpc("civya_service_grant_tenant_access", {
      ...this.actorRpcContext(),
      p_tenant_slug: input.tenantSlug,
      p_invitation_id: input.invitationId,
      p_cookie_expires_at: expiresAt.toISOString(),
    });
    if (error) throw errorCode(error);
    return data as { tenantId: string; tenantSlug: string; invitationId: string; expiresAt: string };
  }

  async ensureResidentWorkspace(
    tenantSlug = process.env.CIVYA_DEMO_TENANT_SLUG || "wayne-county-demo",
    channel: "voice" | "text" = "voice",
  ): Promise<SessionBootstrap> {
    const { data, error } = await this.service().rpc("civya_service_bootstrap_session", {
      ...this.actorRpcContext(),
      p_actor_is_verified: this.principal.isVerified,
      p_tenant_slug: tenantSlug,
      p_channel: databaseChannel(channel),
    });
    if (error) throw errorCode(error);
    if (!data || typeof data !== "object") throw new PlatformDataError("Bootstrap returned no workspace.");
    const raw = data as DatabaseSessionBootstrap;
    // Conversation IDs may rotate after a clean ending, and residents may
    // switch between voice and text. Resume from the case's six latest
    // redacted turns rather than only the currently open transport record.
    const { data: recent, error: recentError } = await this.client
      .from("turns")
      .select("id,speaker,channel,redacted_text,created_at,sequence_number")
      .eq("case_id", raw.activeCase.id)
      .neq("processing_status", "failed")
      .order("sequence_number", { ascending: false })
      .limit(6);
    if (recentError) throw errorCode(recentError);
    raw.resumeContext.recentTurns = (recent || []).reverse().map((turn) => ({
      id: turn.id,
      speaker: turn.speaker,
      channel: turn.channel,
      text: turn.redacted_text,
      created_at: turn.created_at,
    }));
    return mapBootstrap(raw, this.principal);
  }

  async bootstrapEntitledProductionCase(
    caseId: string,
    entitlementId: string,
    channel: "voice" | "text" = "voice",
  ): Promise<SessionBootstrap> {
    this.requireVerifiedResident();
    const { data, error } = await this.service().rpc(
      "civya_service_bootstrap_entitled_production_case",
      {
        ...this.actorRpcContext(),
        p_actor_is_verified: this.principal.isVerified,
        p_case_id: caseId,
        p_entitlement_id: entitlementId,
        p_channel: databaseChannel(channel),
      },
    );
    if (error) throw errorCode(error);
    if (!data || typeof data !== "object") {
      throw new PlatformDataError("Production bootstrap returned no workspace.");
    }
    const raw = data as DatabaseSessionBootstrap;
    if (
      raw.activeCase?.id !== caseId
      || raw.authorization?.caseId !== caseId
      || raw.authorization?.entitlementId !== entitlementId
      || raw.tenant?.environment !== "production"
      || raw.tenant?.fictional !== false
    ) {
      throw new PlatformDataError(
        "Production bootstrap authorization did not match the requested case.",
        "entitlement_required",
      );
    }
    return mapBootstrap(raw, this.principal);
  }

  async bootstrap(
    tenantSlug = process.env.CIVYA_DEMO_TENANT_SLUG || "wayne-county-demo",
    channel: "voice" | "text" = "voice",
  ): Promise<SessionBootstrap> {
    return this.ensureResidentWorkspace(tenantSlug, channel);
  }

  async createOrGetConversation(caseId: string, channel: "voice" | "text") {
    await this.assertCaseAccess(caseId);
    const { data, error } = await this.service().rpc("civya_service_create_or_get_conversation", {
      ...this.actorRpcContext(),
      p_case_id: caseId,
      p_channel: databaseChannel(channel),
    });
    if (error) throw errorCode(error);
    return data as Row;
  }

  async findTurnByIdempotency(conversationId: string, idempotencyKey: string): Promise<PersistedTurn | null> {
    const { data, error } = await this.client
      .from("turns")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw errorCode(error);
    return data ? mapTurn(data as Row, true) : null;
  }

  async appendTurn(envelope: TurnEnvelope, speaker: TurnSpeaker = "user"): Promise<PersistedTurn> {
    if (!envelope.conversation_id) throw new PlatformDataError("conversation_id is required after bootstrap.");
    await this.assertConversationAccess(envelope.conversation_id);
    const redactedText = redactTranscript(envelope.transcript);
    if (!redactedText) throw new PlatformDataError("A non-empty transcript is required.");
    const { data, error } = await this.service().rpc("civya_service_append_turn", {
      ...this.actorRpcContext(),
      p_conversation_id: envelope.conversation_id,
      p_provider_item_id: envelope.provider_item_id || "",
      p_client_turn_id: envelope.client_turn_id,
      p_idempotency_key: envelope.idempotency_key,
      p_speaker: speaker,
      p_channel: databaseChannel(envelope.channel),
      p_redacted_text: redactedText,
    });
    if (error) throw errorCode(error);
    const response = data as { turn?: Row; duplicate?: boolean } | null;
    if (!response?.turn) throw new PlatformDataError("Turn persistence returned no turn.");
    return mapTurn(response.turn, Boolean(response.duplicate));
  }

  async loadCaseSnapshot(caseId: string): Promise<CaseSnapshot> {
    const [caseResult, factsResult, checklistResult] = await Promise.all([
      this.client.from("cases").select("*").eq("id", caseId).single(),
      this.client.from("case_facts").select("fact_key,fact_value,confirmed_at").eq("case_id", caseId).eq("confirmation_state", "confirmed"),
      this.client.from("checklist_items").select("*").eq("case_id", caseId).order("created_at"),
    ]);
    if (caseResult.error) throw errorCode(caseResult.error);
    if (factsResult.error) throw errorCode(factsResult.error);
    if (checklistResult.error) throw errorCode(checklistResult.error);
    const row = caseResult.data as Row;
    return {
      id: requiredString(row.id, "case id"),
      tenantId: requiredString(row.tenant_id, "tenant id"),
      residentId: requiredString(row.resident_id, "resident id"),
      status: requiredString(row.status, "case status"),
      rowVersion: Number(row.row_version),
      workflowState: requiredString(row.workflow_state, "workflow state"),
      nextQuestion: (row.next_question as string | null) || undefined,
      nextBestAction: requiredString(row.next_best_action, "next best action"),
      resumeSummary: (row.resume_summary as string) || "",
      workflowDetails: (row.completion_state as Record<string, unknown>) || {},
      confirmedFacts: (factsResult.data || []).map((fact) => ({
        key: fact.fact_key,
        value: stringValue(fact.fact_value),
        confirmed_at: fact.confirmed_at || new Date().toISOString(),
      })),
      checklist: (checklistResult.data || []) as Array<Record<string, unknown>>,
      updatedAt: requiredString(row.updated_at, "updated at"),
    };
  }

  async upsertCaseFacts(input: {
    caseId: string;
    expectedRowVersion: number;
    facts: Record<string, unknown>;
    sourceTurnId: string;
    idempotencyKey: string;
  }): Promise<{ caseId: string; rowVersion: number }> {
    await this.assertCaseAccess(input.caseId);
    const sourceTurn = await this.assertTurnAccess(input.sourceTurnId);
    if (stringValue(sourceTurn.case_id) !== input.caseId) {
      throw new PlatformDataError("The source turn does not belong to this case.", "forbidden");
    }
    const { data, error } = await this.service().rpc("civya_service_upsert_case_facts", {
      ...this.actorRpcContext(),
      p_case_id: input.caseId,
      p_expected_row_version: input.expectedRowVersion,
      p_facts: input.facts,
      p_source_turn_id: input.sourceTurnId,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw errorCode(error);
    return data as { caseId: string; rowVersion: number };
  }

  async commitTurnResult(input: CommitTurnInput): Promise<TurnResult> {
    const userTurn = await this.assertTurnAccess(input.userTurnId);
    if (stringValue(userTurn.conversation_id) !== input.conversationId) {
      throw new PlatformDataError("The turn does not belong to this conversation.", "forbidden");
    }
    const { data, error } = await this.service().rpc("civya_service_commit_turn_result", {
      ...this.actorRpcContext(),
      p_user_turn_id: input.userTurnId,
      p_expected_case_version: input.expectedCaseVersion,
      p_spoken_response: redactTranscript(input.spokenResponse),
      p_next_question: input.nextQuestion || null,
      p_workflow_state: input.workflowState,
      p_case_status: input.caseStatus,
      p_conversation_summary: redactTranscript(input.conversationSummary),
      // The legacy database parameter name is retained for migration compatibility.
      // Its value is interaction lifecycle data and must never mutate outcome state.
      p_completion_state: { state: input.interactionState, final: Boolean(input.final) },
      p_facts: input.confirmedFacts || {},
      p_finish_conversation: Boolean(input.final),
    });
    if (error) throw errorCode(error);
    const raw = data as Record<string, unknown>;
    const caseUpdate = raw.caseUpdate as Record<string, unknown> | undefined;
    return {
      conversation_id: input.conversationId,
      client_turn_id: input.clientTurnId,
      spoken_response: String(raw.spokenResponse || input.spokenResponse),
      case_update: caseUpdate
        ? {
            id: String(caseUpdate.caseId),
            status: String(caseUpdate.status),
            row_version: Number(caseUpdate.rowVersion),
            next_best_action: input.nextQuestion || "Continue the guided conversation.",
            likely_pathways: [],
            missing_documents: [],
          }
        : undefined,
      next_question: (raw.nextQuestion as string | null) || input.nextQuestion,
      interaction_state: input.interactionState,
      persistence: { state: "saved", saved_at: new Date().toISOString() },
      final: input.final,
    };
  }

  async finishConversation(conversationId: string, summary?: string): Promise<void> {
    await this.assertConversationAccess(conversationId);
    const { error } = await this.service().rpc("civya_service_finish_conversation", {
      ...this.actorRpcContext(),
      p_conversation_id: conversationId,
      p_summary: summary ? redactTranscript(summary) : null,
    });
    if (error) throw errorCode(error);
  }

  async markIdentityVerified(): Promise<{ residentId: string; email?: string }> {
    this.requireVerifiedResident();
    if (!this.principal.email) throw new PlatformDataError("A confirmed email identity is required.", "verification_required");
    const resident = await this.client
      .from("residents")
      .select("id")
      .eq("auth_user_id", this.principal.userId)
      .limit(1)
      .maybeSingle();
    if (resident.error) throw errorCode(resident.error);
    if (!resident.data) throw new PlatformDataError("Resident workspace not found.", "P0002");
    const { data, error } = await this.service().rpc("civya_service_mark_identity_verified", {
      ...this.actorRpcContext(),
    });
    if (error) throw errorCode(error);
    const row = data as Row;
    return {
      residentId: requiredString(snakeOrCamel(row, "resident_id", "residentId"), "resident id"),
      email: (row.email as string | null) || undefined,
    };
  }

  async createCaseTransferGrant(caseId: string, ttlSeconds = 600): Promise<CaseTransferGrant> {
    await this.assertCaseAccess(caseId);
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const { data, error } = await this.service().rpc("civya_service_create_case_transfer_grant", {
      ...this.actorRpcContext(),
      p_case_id: caseId,
      p_token_hash: tokenHash,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw errorCode(error);
    const grant = data as { grantId: string; expiresAt: string };
    return { token, grantId: grant.grantId, expiresAt: grant.expiresAt };
  }

  async getCaseAccessBinding(caseId: string): Promise<CaseAccessBinding> {
    const { data, error } = await this.service().rpc("civya_service_case_access_binding", {
      p_actor_user_id: this.principal.userId,
      p_case_id: caseId,
    });
    if (error) throw errorCode(error);
    return data as CaseAccessBinding;
  }

  async getRecoveryCaseAccessBinding(): Promise<CaseAccessBinding | null> {
    this.requireVerifiedResident();
    const { data, error } = await this.service().rpc("civya_service_recovery_case_access_binding", {
      p_actor_user_id: this.principal.userId,
    });
    if (error) throw errorCode(error);
    return (data || null) as CaseAccessBinding | null;
  }

  async validateEntitlementCache(input: {
    entitlementId?: string;
    rowVersion: number;
    tenantId: string;
    caseId: string;
    purpose: "case_access";
    scopes: readonly CaseAccessScope[];
  }): Promise<EntitlementCacheStatus> {
    const { data, error } = await this.service().rpc("civya_service_case_entitlement_cache_status", {
      p_actor_user_id: this.principal.userId,
      p_entitlement_id: input.entitlementId || null,
      p_expected_row_version: input.rowVersion,
      p_tenant_id: input.tenantId,
      p_case_id: input.caseId,
      p_purpose: input.purpose,
      p_required_scopes: [...input.scopes],
    });
    if (error) throw errorCode(error);
    return data as EntitlementCacheStatus;
  }

  async finalizeBoundCaseEntitlement(input: {
    transferToken?: string;
    binding: CaseAccessBinding;
    method: "notice_code" | "invitation_code";
    verifierGrantId: string;
    expiresAt: number;
  }): Promise<FinalizedCaseEntitlement> {
    this.requireVerifiedResident();
    if (!this.principal.email) {
      throw new PlatformDataError("A confirmed email identity is required.", "verification_required");
    }
    const { transferDigest, idempotencyKey } = boundEntitlementHandoffIdentity({
      userId: this.principal.userId,
      ...input,
    });
    const verifierGrantDigest = crypto
      .createHash("sha256")
      .update(input.verifierGrantId)
      .digest("hex");
    const { data, error } = await this.service().rpc(
      "civya_service_finalize_bound_case_entitlement_handoff",
      {
        ...this.actorRpcContext(),
        p_transfer_digest: transferDigest,
        p_expected_tenant_id: input.binding.tenantId,
        p_expected_case_id: input.binding.caseId,
        p_expected_purpose: input.binding.purpose,
        p_expected_scopes: [...input.binding.scopes],
        p_method: input.method,
        p_provider_key: "wayne_county_case_entitlement",
        p_verifier_grant_digest: verifierGrantDigest,
        p_expires_at: new Date(input.expiresAt).toISOString(),
        p_idempotency_key: idempotencyKey,
        p_selection_id: crypto.randomUUID(),
      },
    );
    if (error) throw errorCode(error);
    return data as FinalizedCaseEntitlement;
  }

  async recoverBoundCaseEntitlementHandoff(input: {
    transferToken?: string;
    binding: CaseAccessBinding;
    method: "notice_code" | "invitation_code";
  }): Promise<FinalizedCaseEntitlement | null> {
    this.requireVerifiedResident();
    if (!this.principal.email) {
      throw new PlatformDataError("A confirmed email identity is required.", "verification_required");
    }
    const { transferDigest, idempotencyKey } = boundEntitlementHandoffIdentity({
      userId: this.principal.userId,
      ...input,
    });
    const { data, error } = await this.service().rpc(
      "civya_service_recover_bound_case_entitlement_handoff",
      {
        ...this.actorRpcContext(),
        p_transfer_digest: transferDigest,
        p_expected_tenant_id: input.binding.tenantId,
        p_expected_case_id: input.binding.caseId,
        p_expected_purpose: input.binding.purpose,
        p_expected_scopes: [...input.binding.scopes],
        p_method: input.method,
        p_provider_key: "wayne_county_case_entitlement",
        p_idempotency_key: idempotencyKey,
        p_selection_id: crypto.randomUUID(),
      },
    );
    if (error) throw errorCode(error);
    return (data || null) as FinalizedCaseEntitlement | null;
  }

  async createCaseEntitlementSelection(input: {
    selectionId: string;
    attachedCaseId: string;
    attachedEntitlementId?: string;
    existingActiveCaseId: string;
    accessType: "case_entitlement" | "fictional_invitation";
    purpose: "case_access";
    scopes: readonly CaseAccessScope[];
    expiresAt: number;
  }): Promise<CaseEntitlementSelection> {
    this.requireVerifiedResident();
    const { data, error } = await this.service().rpc(
      "civya_service_create_case_entitlement_selection",
      {
        p_actor_user_id: this.principal.userId,
        p_selection_id: input.selectionId,
        p_attached_case_id: input.attachedCaseId,
        p_attached_entitlement_id: input.attachedEntitlementId || null,
        p_existing_case_id: input.existingActiveCaseId,
        p_access_type: input.accessType,
        p_purpose: input.purpose,
        p_scopes: [...input.scopes],
        p_expires_at: new Date(input.expiresAt).toISOString(),
      },
    );
    if (error) throw errorCode(error);
    return data as CaseEntitlementSelection;
  }

  async selectEntitledCase(
    selectionId: string,
    selectedCaseId: string,
  ): Promise<EntitlementCacheStatus> {
    this.requireVerifiedResident();
    const { data, error } = await this.service().rpc("civya_service_select_entitled_case", {
      p_actor_user_id: this.principal.userId,
      p_selection_id: selectionId,
      p_selected_case_id: selectedCaseId,
    });
    if (error) throw errorCode(error);
    return data as EntitlementCacheStatus;
  }

  async createEntitlementAssistance(input: {
    binding: CaseAccessBinding;
    transferToken?: string;
    correlationId: string;
  }): Promise<EntitlementAssistanceRequestStatus> {
    this.requireVerifiedResident();
    const transferDigest = input.transferToken
      ? crypto.createHash("sha256").update(input.transferToken).digest("hex")
      : null;
    const idempotencyKey = `assistance:${crypto.createHash("sha256").update([
      this.principal.userId, input.binding.tenantId, input.binding.caseId,
      input.binding.purpose, input.binding.scopes.join(","),
      transferDigest || "direct", input.correlationId,
    ].join("\0")).digest("hex")}`;
    const { data, error } = await this.service().rpc(
      "civya_service_create_entitlement_assistance_request",
      {
        p_actor_user_id: this.principal.userId,
        p_tenant_id: input.binding.tenantId,
        p_case_id: input.binding.caseId,
        p_purpose: input.binding.purpose,
        p_scopes: [...input.binding.scopes],
        p_transfer_digest: transferDigest,
        p_correlation_id: input.correlationId,
        p_idempotency_key: idempotencyKey,
      },
    );
    if (error) throw errorCode(error);
    return data as EntitlementAssistanceRequestStatus;
  }

  async entitlementAssistanceStatus(requestId: string): Promise<EntitlementAssistanceRequestStatus> {
    this.requireVerifiedResident();
    const { data, error } = await this.service().rpc("civya_service_entitlement_assistance_status", {
      p_actor_user_id: this.principal.userId,
      p_request_id: requestId,
    });
    if (error) throw errorCode(error);
    return data as EntitlementAssistanceRequestStatus;
  }

  async listEntitlementAssistance(tenantId: string, limit = 50): Promise<EntitlementAssistanceRequestStatus[]> {
    const { data, error } = await this.service().rpc("civya_service_list_entitlement_assistance", {
      p_staff_actor_user_id: this.principal.userId,
      p_tenant_id: tenantId,
      p_limit: limit,
    });
    if (error) throw errorCode(error);
    return (data || []) as EntitlementAssistanceRequestStatus[];
  }

  async resolveEntitlementAssistance(input: {
    requestId: string;
    expectedRowVersion: number;
    decision: "claim" | "approve" | "deny";
    resolutionCode?: string;
  }): Promise<EntitlementAssistanceRequestStatus> {
    const { data, error } = await this.service().rpc("civya_service_resolve_entitlement_assistance", {
      p_staff_actor_user_id: this.principal.userId,
      p_request_id: input.requestId,
      p_expected_row_version: input.expectedRowVersion,
      p_decision: input.decision,
      p_resolution_code: input.resolutionCode || null,
    });
    if (error) throw errorCode(error);
    return data as EntitlementAssistanceRequestStatus;
  }

  async createAccountRecoveryChallenge(input: {
    emailDigest: string;
    nonceDigest: string;
    correlationId: string;
    expiresAt: number;
    idempotencyKey: string;
  }): Promise<AccountRecoveryChallenge> {
    const { data, error } = await this.service().rpc("civya_service_create_account_recovery_challenge", {
      p_email_digest: input.emailDigest,
      p_nonce_digest: input.nonceDigest,
      p_correlation_id: input.correlationId,
      p_expires_at: new Date(input.expiresAt).toISOString(),
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw errorCode(error);
    return data as AccountRecoveryChallenge;
  }

  async resolveAccountRecoveryChallenge(input: {
    challengeId: string;
    nonceDigest: string;
    result: "verified" | "failed";
    actorUserId?: string;
  }): Promise<{ challengeId: string; correlationId?: string; state: string; usedAt?: string }> {
    const { data, error } = await this.service().rpc("civya_service_resolve_account_recovery_challenge", {
      p_challenge_id: input.challengeId,
      p_nonce_digest: input.nonceDigest,
      p_result: input.result,
      p_actor_user_id: input.actorUserId || null,
    });
    if (error) throw errorCode(error);
    return data as { challengeId: string; correlationId?: string; state: string; usedAt?: string };
  }

  async redeemCaseTransferGrant(token: string): Promise<CaseTransferResult> {
    this.requireVerifiedResident();
    if (!this.principal.email) throw new PlatformDataError("A confirmed email identity is required.", "verification_required");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const { data, error } = await this.service().rpc("civya_service_redeem_case_transfer_grant", {
      ...this.actorRpcContext(),
      p_token_hash: tokenHash,
    });
    if (error) throw errorCode(error);
    const result = data as CaseTransferResult;
    return { ...result, existingActiveCaseId: result.existingActiveCaseId || undefined };
  }

  async createDocumentUploadGrant(input: DocumentUploadRequest): Promise<DocumentUploadGrant> {
    this.requireVerifiedResident("Email verification is required before document upload.");
    validateDocument(input);
    const { data: caseRow, error: caseError } = await this.client
      .from("cases")
      .select("id,tenant_id,resident_id")
      .eq("id", input.caseId)
      .single();
    if (caseError) throw errorCode(caseError);
    const path = documentStoragePath(caseRow, input.idempotencyKey);
    const { data, error } = await this.service().storage
      .from(PRIVATE_DOCUMENT_BUCKET)
      .createSignedUploadUrl(path, { upsert: false });
    if (error) throw errorCode(error);
    return {
      bucket: PRIVATE_DOCUMENT_BUCKET,
      path,
      token: data.token,
      signedUrl: data.signedUrl,
      expiresInSeconds: 120,
    };
  }

  async inspectDocumentUploadObject(input: {
    caseId: string;
    idempotencyKey: string;
    storagePath: string;
  }): Promise<DocumentUploadObjectInfo> {
    this.requireVerifiedResident("Email verification is required before document upload.");
    const caseRow = await this.assertCaseAccess(input.caseId) as {
      id: string;
      tenant_id: string;
      resident_id: string;
    };
    const expectedPath = documentStoragePath(caseRow, input.idempotencyKey);
    if (input.storagePath !== expectedPath) {
      throw new PlatformDataError("Storage path does not belong to this upload request.", "forbidden");
    }
    const { data, error } = await this.service().storage
      .from(PRIVATE_DOCUMENT_BUCKET)
      .info(input.storagePath);
    if (error || !data) throw errorCode(error || { code: "P0002", message: "The uploaded object was not found." });
    const metadata = data.metadata && typeof data.metadata === "object"
      ? data.metadata as Record<string, unknown>
      : {};
    const metadataSize = Number(metadata.size ?? metadata.contentLength ?? 0);
    const sizeBytes = Number(data.size ?? metadataSize);
    const contentType = String(data.contentType ?? metadata.mimetype ?? "").split(";")[0].trim().toLowerCase();
    return {
      path: input.storagePath,
      sizeBytes,
      contentType,
      metadata,
      etag: data.etag || (typeof metadata.eTag === "string" ? metadata.eTag : undefined),
    };
  }

  async recordDocumentMetadata(input: DocumentMetadataInput): Promise<Record<string, unknown>> {
    this.requireVerifiedResident("Email verification is required before document upload.");
    validateDocument(input);
    const { data: caseRow, error: caseError } = await this.client
      .from("cases")
      .select("id,tenant_id,resident_id")
      .eq("id", input.caseId)
      .single();
    if (caseError) throw errorCode(caseError);
    const expectedPath = documentStoragePath(caseRow, input.idempotencyKey);
    if (input.storagePath !== expectedPath) throw new PlatformDataError("Storage path does not belong to this upload request.");
    const lowConfidence = input.classificationConfidence === undefined || input.classificationConfidence < 0.85;
    const canClassify = this.principal.role !== "resident";
    const record = {
      tenant_id: caseRow.tenant_id,
      resident_id: caseRow.resident_id,
      case_id: caseRow.id,
      storage_bucket: PRIVATE_DOCUMENT_BUCKET,
      storage_path: input.storagePath,
      original_file_name: input.fileName.slice(0, 255),
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      document_type: canClassify ? input.documentType || "unknown" : "unknown",
      classification_confidence: canClassify ? input.classificationConfidence ?? null : null,
      extraction_confidence: canClassify ? input.extractionConfidence ?? null : null,
      redacted_extraction: canClassify ? input.redactedExtraction || null : null,
      scan_status: canClassify ? input.scanStatus || "pending" : "pending",
      review_required: canClassify
        ? input.reviewRequired ?? (lowConfidence || input.scanStatus !== "clean")
        : true,
      review_reason: canClassify
        ? input.reviewReason || (lowConfidence ? "Classification confidence below 0.85." : null)
        : "Awaiting server-side scan and classification.",
      idempotency_key: input.idempotencyKey,
    };
    const { data: existing, error: existingError } = await this.client
      .from("documents")
      .select("*")
      .eq("case_id", input.caseId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (existingError) throw errorCode(existingError);
    if (existing) return existing as Record<string, unknown>;
    const { data, error } = await this.service().from("documents").insert(record).select("*").single();
    if (error?.code === "23505") {
      const retry = await this.service()
        .from("documents")
        .select("*")
        .eq("case_id", input.caseId)
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      if (retry.error) throw errorCode(retry.error);
      return retry.data as Record<string, unknown>;
    }
    if (error) throw errorCode(error);
    return data as Record<string, unknown>;
  }

  async removeUnrecordedDocumentUpload(input: {
    caseId: string;
    idempotencyKey: string;
    storagePath: string;
  }): Promise<boolean> {
    const caseRow = await this.assertCaseAccess(input.caseId) as {
      id: string;
      tenant_id: string;
      resident_id: string;
    };
    const expectedPath = documentStoragePath(caseRow, input.idempotencyKey);
    if (input.storagePath !== expectedPath) {
      throw new PlatformDataError("Storage path does not belong to this upload request.", "forbidden");
    }
    const { data: recorded, error: recordedError } = await this.client
      .from("documents")
      .select("id")
      .eq("case_id", input.caseId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (recordedError) throw errorCode(recordedError);
    if (recorded) return false;
    const { error } = await this.service().storage
      .from(PRIVATE_DOCUMENT_BUCKET)
      .remove([input.storagePath]);
    if (error) throw errorCode(error);
    return true;
  }

  async createDocumentDownloadUrl(documentId: string, expiresInSeconds = 60): Promise<string> {
    const ttl = Math.max(30, Math.min(expiresInSeconds, 300));
    const { data: document, error: documentError } = await this.client
      .from("documents")
      .select("storage_bucket,storage_path")
      .eq("id", documentId)
      .single();
    if (documentError) throw errorCode(documentError);
    const { data, error } = await this.service().storage.from(document.storage_bucket).createSignedUrl(document.storage_path, ttl);
    if (error) throw errorCode(error);
    return data.signedUrl;
  }

  async staffBootstrap(tenantSlug: string): Promise<StaffBootstrap> {
    if (!tenantSlug || !/^[a-z0-9-]+$/.test(tenantSlug)) {
      throw new PlatformDataError("A valid tenant workspace is required.", "forbidden");
    }
    if (this.principal.isAnonymous || !this.principal.isVerified) {
      throw new PlatformDataError("Confirmed county staff access is required.", "forbidden");
    }
    const { data: roleRow, error: roleError } = await this.client
      .from("staff_roles")
      .select("role,tenant_id,tenants!inner(id,slug,name,environment,fictional,status)")
      .eq("auth_user_id", this.principal.userId)
      .eq("status", "active")
      .in("role", ["reviewer", "admin"])
      .eq("tenants.slug", tenantSlug)
      .eq("tenants.status", "active")
      .single();
    if (roleError) throw errorCode(roleError);
    const tenant = (Array.isArray(roleRow.tenants) ? roleRow.tenants[0] : roleRow.tenants) as Row;
    if (!tenant || String(tenant.slug) !== tenantSlug || String(tenant.status) !== "active") {
      throw new PlatformDataError("County staff access is not active for this workspace.", "forbidden");
    }
    const tenantId = String(roleRow.tenant_id);
    const [reviews, cases, documents] = await Promise.all([
      this.client.from("review_tasks").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).in("status", ["open", "in_review"]),
      this.client.from("cases").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true),
      this.client.from("documents").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("review_required", true),
    ]);
    for (const result of [reviews, cases, documents]) if (result.error) throw errorCode(result.error);
    return {
      principal: this.principal,
      tenant: {
        id: String(tenant.id),
        slug: String(tenant.slug),
        name: String(tenant.name),
        environment: String(tenant.environment) as StaffBootstrap["tenant"]["environment"],
        fictional: tenant.fictional === true,
      },
      role: roleRow.role as "reviewer" | "admin",
      counts: {
        openReviews: reviews.count || 0,
        activeCases: cases.count || 0,
        documentsNeedingReview: documents.count || 0,
      },
    };
  }

  async appendAuditEvent(input: {
    tenantId: string;
    residentId?: string;
    caseId?: string;
    eventType: string;
    payload?: Record<string, unknown>;
    source: "agent" | "system" | "admin" | "resident";
    requestId?: string;
  }): Promise<void> {
    if (input.caseId) {
      const ownedCase = await this.assertCaseAccess(input.caseId);
      if (stringValue(ownedCase.tenant_id) !== input.tenantId) {
        throw new PlatformDataError("The case does not belong to this tenant.", "forbidden");
      }
    } else if (input.residentId) {
      const ownedResident = await this.assertResidentAccess(input.residentId);
      if (stringValue(ownedResident.tenant_id) !== input.tenantId) {
        throw new PlatformDataError("The resident does not belong to this tenant.", "forbidden");
      }
    } else if (this.principal.role !== "admin" && this.principal.role !== "service") {
      throw new PlatformDataError("A case or resident is required for this audit event.", "forbidden");
    }
    const { error } = await this.service().rpc("civya_service_append_audit_event", {
      ...this.actorRpcContext(),
      p_tenant_id: input.tenantId,
      p_resident_id: input.residentId || null,
      p_case_id: input.caseId || null,
      p_event_type: input.eventType,
      p_redacted_payload: redactPayload(input.payload || {}),
      p_source: input.source,
      p_request_id: input.requestId || null,
    });
    if (error) throw errorCode(error);
  }

  async takeRateLimit(input: { key: string; bucket: string; maxHits: number; windowSeconds: number }) {
    const keyHash = crypto.createHash("sha256").update(input.key).digest("hex");
    const { data, error } = await this.service().rpc("civya_service_take_rate_limit", {
      ...this.actorRpcContext(),
      p_key_hash: keyHash,
      p_bucket: input.bucket,
      p_max_hits: input.maxHits,
      p_window_seconds: input.windowSeconds,
    });
    if (error) throw errorCode(error);
    return data as { allowed: boolean; remaining: number; resetAt: string };
  }

  async activateCase(
    caseId: string,
    expectedRowVersion: number,
  ): Promise<{ caseId: string; residentId: string; rowVersion: number; deactivatedCaseIds: string[] }> {
    this.requireVerifiedResident();
    await this.assertCaseAccess(caseId);
    const { data, error } = await this.service().rpc("civya_service_activate_case", {
      ...this.actorRpcContext(),
      p_case_id: caseId,
      p_expected_row_version: expectedRowVersion,
    });
    if (error) throw errorCode(error);
    return data as { caseId: string; residentId: string; rowVersion: number; deactivatedCaseIds: string[] };
  }

  async createDemoInvitation(input: {
    tenantId: string;
    label: string;
    expiresAt: string;
    maxUses?: number;
    scopes?: string[];
  }): Promise<{ token: string; invitationId: string }> {
    if (this.principal.role !== "admin" && this.principal.role !== "service") {
      throw new PlatformDataError("County-demo admin access required.", "forbidden");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const { data, error } = await this.client
      .from("demo_invitations")
      .insert({
        tenant_id: input.tenantId,
        token_hash: tokenHash,
        label: input.label,
        expires_at: input.expiresAt,
        max_uses: input.maxUses || 1,
        scopes: input.scopes || ["resident_demo"],
        created_by: this.principal.role === "service" ? null : this.principal.userId,
      })
      .select("id")
      .single();
    if (error) throw errorCode(error);
    return { token, invitationId: data.id };
  }

  async resetTenantSandbox(
    tenantSlug = process.env.CIVYA_DEMO_TENANT_SLUG || "wayne-county-demo",
  ): Promise<{ tenantId: string; tenantSlug: string; residentsRemoved: number; casesRemoved: number }> {
    if (this.principal.role !== "admin" && this.principal.role !== "service") {
      throw new PlatformDataError("County-demo admin access required.", "forbidden");
    }
    const { data, error } = await this.client.rpc("civya_reset_tenant_sandbox", {
      p_tenant_slug: tenantSlug,
    });
    if (error) throw errorCode(error);
    return data as { tenantId: string; tenantSlug: string; residentsRemoved: number; casesRemoved: number };
  }
}

export async function createRequestPlatform(): Promise<CivyaPlatform | null> {
  if (!isSupabaseConfigured()) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
      throw new PlatformConfigurationError("Supabase must be configured in the hosted county sandbox.");
    }
    return null;
  }
  const client = await createSupabaseServerClient();
  const principal = await getSessionPrincipal(client);
  return principal ? new CivyaPlatform(client, principal) : null;
}

export async function createAccessTokenPlatform(accessToken: string): Promise<CivyaPlatform | null> {
  const client = createSupabaseAccessTokenClient(accessToken);
  const principal = await getSessionPrincipal(client, accessToken);
  return principal ? new CivyaPlatform(client, principal) : null;
}

export function createAdminPlatform(): CivyaPlatform {
  const client = createSupabaseAdminClient();
  return new CivyaPlatform(client, {
    userId: "service-role",
    isAnonymous: false,
    isVerified: true,
    role: "service",
    userMetadata: {},
    appMetadata: {},
  }, client);
}

export async function redeemDemoInvitation(
  token: string,
  expectedTenantSlug: string,
  client?: SupabaseClient,
): Promise<DemoInvitationGrant> {
  const platformClient = client || createSupabaseAdminClient();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const { data, error } = await platformClient.rpc("civya_service_redeem_demo_invitation", {
    p_token_hash: tokenHash,
    p_expected_tenant_slug: expectedTenantSlug,
  });
  if (error) throw errorCode(error);
  return data as DemoInvitationGrant;
}

export async function checkPlatformHealth(): Promise<PlatformHealth> {
  if (!isSupabaseConfigured() || !getSupabaseServiceRoleKey()) {
    return {
      ok: false,
      configured: false,
      database: { ok: false, latencyMs: 0, error: "Supabase environment is incomplete." },
      storage: { ok: false, latencyMs: 0, error: "Supabase environment is incomplete." },
    };
  }
  const client = createSupabaseAdminClient();
  const dbStart = Date.now();
  const databaseResult = await client.from("tenants").select("id", { count: "exact", head: true }).limit(1);
  const database = {
    ok: !databaseResult.error,
    latencyMs: Date.now() - dbStart,
    error: databaseResult.error?.message,
  };
  const storageStart = Date.now();
  const storageResult = await client.storage.getBucket(PRIVATE_DOCUMENT_BUCKET);
  const storage = {
    ok: !storageResult.error && storageResult.data?.public === false,
    latencyMs: Date.now() - storageStart,
    error: storageResult.error?.message || (storageResult.data?.public ? "Private bucket is public." : undefined),
  };
  return { ok: database.ok && storage.ok, configured: true, database, storage };
}

export async function pruneExpiredDemoData(): Promise<RetentionPruneResult> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.rpc("civya_prepare_retention_cleanup");
  if (error) throw errorCode(error);
  const prepared = data as {
    casesRemoved?: number;
    residentsRemoved?: number;
    deletions?: Array<{ id: string; kind: "storage_object" | "auth_user"; reference: string }>;
  };
  const result: RetentionPruneResult = {
    casesRemoved: Number(prepared.casesRemoved || 0),
    residentsRemoved: Number(prepared.residentsRemoved || 0),
    storageObjectsRemoved: 0,
    authUsersRemoved: 0,
    failures: [],
  };
  const deletions = prepared.deletions || [];
  const storage = deletions.filter((item) => item.kind === "storage_object");
  for (let index = 0; index < storage.length; index += 100) {
    const batch = storage.slice(index, index + 100);
    const removed = await client.storage.from(PRIVATE_DOCUMENT_BUCKET).remove(batch.map((item) => item.reference));
    if (removed.error) {
      result.failures.push(...batch.map((item) => ({ kind: item.kind, reference: item.reference, error: removed.error!.message })));
      await completeRetentionDeletions(client, batch.map((item) => item.id), removed.error.message);
    } else {
      result.storageObjectsRemoved += batch.length;
      await completeRetentionDeletions(client, batch.map((item) => item.id));
    }
  }
  for (const item of deletions.filter((candidate) => candidate.kind === "auth_user")) {
    const removed = await client.auth.admin.deleteUser(item.reference, false);
    if (removed.error) {
      result.failures.push({ kind: item.kind, reference: item.reference, error: removed.error.message });
      await completeRetentionDeletions(client, [item.id], removed.error.message);
    } else {
      result.authUsersRemoved += 1;
      await completeRetentionDeletions(client, [item.id]);
    }
  }
  return result;
}

async function completeRetentionDeletions(client: SupabaseClient, ids: string[], error?: string): Promise<void> {
  if (!ids.length) return;
  const completed = await client.rpc("civya_complete_retention_deletions", {
    p_ids: ids,
    p_error: error || null,
  });
  if (completed.error) throw errorCode(completed.error);
}

function validateDocument(input: DocumentUploadRequest): void {
  if (!ALLOWED_MIME_TYPES.has(input.contentType)) throw new PlatformDataError("This file type is not allowed.", "unsupported_media_type");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_DOCUMENT_BYTES) {
    throw new PlatformDataError("Document size must be between 1 byte and 10 MB.", "document_too_large");
  }
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new PlatformDataError("A valid idempotency key is required.");
}

function documentStoragePath(
  caseRow: { id: string; tenant_id: string; resident_id: string },
  idempotencyKey: string,
): string {
  const objectKey = crypto
    .createHash("sha256")
    .update(`${caseRow.id}\0${idempotencyKey}`)
    .digest("hex");
  return `${caseRow.tenant_id}/${caseRow.resident_id}/${caseRow.id}/${objectKey}`;
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (/email|phone|address|parcel|name|transcript|document|token|secret/i.test(key)) return [key, "[REDACTED]"];
      return [key, typeof value === "string" ? redactTranscript(value) : value];
    }),
  );
}
