import { NextRequest, NextResponse } from "next/server";
import { decideTurn, nextIntakeQuestion } from "@/lib/conversation/engine";
import {
  ACCOUNT_EXPLANATION,
  SENSITIVE_INTAKE_KEYS,
  authRequiredPayload,
  requiresVerifiedAccount,
} from "@/lib/conversation/policy";
import type { ResumeContext, TurnEnvelope, TurnResult } from "@/lib/conversation/contracts";
import {
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { getRuntimeConfig } from "@/lib/config/runtime";
import {
  PlatformDataError,
  appendTurn,
  bootstrapEntitledProductionCase,
  bootstrapSession,
  commitTurnResult,
  createRequestPlatform,
  loadCaseSnapshot,
} from "@/lib/platform";
import { rateLimitRequest, RequestError, readJsonObject, requestErrorResponse } from "@/lib/security/request";
import { privacyPreservingSafetyIdentifier } from "@/lib/integrations/openai-intent.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function stringField(body: Record<string, unknown>, snake: string, camel: string): string {
  const value = body[snake] ?? body[camel];
  return typeof value === "string" ? value.trim() : "";
}

function envelope(body: Record<string, unknown>): TurnEnvelope {
  const transcript = stringField(body, "transcript", "transcript");
  const clientTurnId = stringField(body, "client_turn_id", "clientTurnId");
  const idempotencyKey = stringField(body, "idempotency_key", "idempotencyKey");
  const suppliedChannel = stringField(body, "channel", "channel");
  if (!transcript || transcript.length > 12_000) throw new RequestError(400, "A transcript between 1 and 12,000 characters is required.");
  if (!clientTurnId || clientTurnId.length > 200) throw new RequestError(400, "client_turn_id is required.");
  if (!idempotencyKey || idempotencyKey.length > 200) throw new RequestError(400, "idempotency_key is required.");
  if (suppliedChannel && suppliedChannel !== "voice" && suppliedChannel !== "text") {
    throw new RequestError(400, "channel must be voice or text.");
  }
  return {
    conversation_id: stringField(body, "conversation_id", "conversationId") || undefined,
    provider_item_id: stringField(body, "provider_item_id", "providerItemId") || undefined,
    client_turn_id: clientTurnId,
    transcript,
    channel: suppliedChannel === "voice" ? "voice" : "text",
    idempotency_key: idempotencyKey,
    pending_turn_id: stringField(body, "pending_turn_id", "pendingTurnId") || undefined,
  };
}

function summary(context: ResumeContext, nextQuestion?: string): string {
  const count = context.confirmed_facts.length;
  const collected = `${count} confirmed intake ${count === 1 ? "fact" : "facts"}`;
  return nextQuestion ? `${collected}. The next guided question is pending.` : `${collected}. No guided question is pending.`;
}

function canonicalPersistedResult(value: unknown, fallback: {
  conversationId: string;
  clientTurnId: string;
}): TurnResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.spoken_response === "string") return raw as unknown as TurnResult;
  if (typeof raw.spokenResponse !== "string") return null;
  const caseUpdate = raw.caseUpdate as Record<string, unknown> | undefined;
  const interaction = (raw.interaction_state ?? raw.interactionState ?? raw.completionState) as
    Record<string, unknown> | string | undefined;
  const legacyState = typeof interaction === "string"
    ? interaction
    : typeof interaction?.state === "string"
      ? interaction.state
      : "continue";
  const interactionState = legacyState === "complete" ? "conversation_ended" : legacyState;
  return {
    conversation_id: fallback.conversationId,
    client_turn_id: fallback.clientTurnId,
    spoken_response: raw.spokenResponse,
    case_update: caseUpdate
      ? {
          id: String(caseUpdate.caseId || ""),
          status: String(caseUpdate.status || "started"),
          row_version: Number(caseUpdate.rowVersion || 1),
          next_best_action: String(raw.nextQuestion || "Continue the guided conversation."),
          likely_pathways: [],
          missing_documents: [],
        }
      : undefined,
    next_question: typeof raw.nextQuestion === "string" ? raw.nextQuestion : undefined,
    interaction_state: interactionState as TurnResult["interaction_state"],
    persistence: { state: "saved" },
    final: Boolean((interaction as Record<string, unknown> | undefined)?.final),
  };
}

async function processAuthoritativeTurn(input: {
  platform: NonNullable<Awaited<ReturnType<typeof createRequestPlatform>>>;
  turn: Awaited<ReturnType<typeof appendTurn>>;
  bootstrap: Awaited<ReturnType<typeof bootstrapSession>>;
  envelope: TurnEnvelope;
  declined: boolean;
}): Promise<TurnResult> {
  let snapshot = await loadCaseSnapshot(input.platform, input.bootstrap.active_case!.id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context: ResumeContext = {
      ...input.bootstrap.resume_context,
      confirmed_facts: snapshot.confirmedFacts,
      conversation_summary: snapshot.resumeSummary || input.bootstrap.resume_context.conversation_summary,
      current_workflow_state: snapshot.workflowState,
      next_question: snapshot.nextQuestion,
    };
    const expected = nextIntakeQuestion(context);
    const decision = await decideTurn({
      transcript: input.envelope.transcript,
      context,
      forcePendingQuestion: Boolean(input.envelope.pending_turn_id),
      safetyIdentifier: privacyPreservingSafetyIdentifier(input.platform.principal.userId),
      fictional: input.bootstrap.sandbox.fictional,
    });

    const needsAccount = requiresVerifiedAccount({
      authState: input.platform.principal.isVerified ? "verified" : input.declined ? "declined" : "anonymous",
      transcript: input.envelope.transcript,
      nextFactKey: decision.kind === "capture_fact" || decision.kind === "clarify_fact"
        ? expected?.key
        : undefined,
    });

    let spokenResponse: string;
    let nextQuestion: string | undefined;
    let workflowState = snapshot.workflowState;
    let caseStatus = snapshot.status;
    let interactionState: TurnResult["interaction_state"] = "continue";
    let facts: Record<string, unknown> = {};
    let final = false;
    let authPayload: TurnResult["auth_required"];

    if (needsAccount && !input.platform.principal.isVerified) {
      nextQuestion = expected?.question || (decision.kind === "general_answer" ? decision.nextQuestion?.question : undefined)
        || "What would you like help with next?";
      if (input.declined) {
        spokenResponse = decision.kind === "general_answer"
          ? `${decision.answer} I can keep helping with general information, but I can't collect or save personal details without a verified account.`
          : "That's completely okay. I can keep helping with general information, but I can't collect or save personal details without a verified account.";
        interactionState = "general_only";
        workflowState = "general_only";
      } else {
        spokenResponse = decision.kind === "general_answer"
          ? `${decision.answer} ${ACCOUNT_EXPLANATION}`
          : ACCOUNT_EXPLANATION;
        interactionState = "auth_required";
        workflowState = "awaiting_verification";
        authPayload = authRequiredPayload({ pendingTurnId: input.turn.id, pendingQuestion: nextQuestion });
      }
    } else if (decision.kind === "capture_fact") {
      facts = { [decision.fact.key]: decision.fact.value };
      nextQuestion = decision.nextQuestion?.question;
      const completion = input.bootstrap.sandbox.fictional
        ? " Your fictional demo intake is complete, and a reviewer can check the next step."
        : " Your intake is complete, and an authorized reviewer can check the next step.";
      spokenResponse = `${decision.acknowledgement}${nextQuestion ? ` ${nextQuestion}` : completion}`;
      workflowState = decision.nextQuestion ? `awaiting_${decision.nextQuestion.key}` : "intake_complete";
      caseStatus = decision.nextQuestion ? "intake_in_progress" : "packet_ready";
    } else if (decision.kind === "clarify_fact") {
      spokenResponse = decision.answer;
      nextQuestion = decision.question.question;
      workflowState = `awaiting_${decision.question.key}`;
    } else if (decision.kind === "general_answer") {
      // Anonymous residents can ask general questions indefinitely. Do not
      // turn a general answer into a surprise account wall merely because the
      // deterministic intake's next optional question is sensitive.
      const canAskNext = input.platform.principal.isVerified ||
        !decision.nextQuestion?.key ||
        !SENSITIVE_INTAKE_KEYS.has(decision.nextQuestion.key);
      nextQuestion = canAskNext ? decision.nextQuestion?.question : undefined;
      spokenResponse = `${decision.answer}${nextQuestion ? ` ${nextQuestion}` : ""}`;
      workflowState = nextQuestion && decision.nextQuestion
        ? `awaiting_${decision.nextQuestion.key}`
        : snapshot.workflowState;
    } else {
      spokenResponse = decision.answer;
      nextQuestion = expected?.question;
      interactionState = "conversation_ended";
      final = true;
    }

    const projectedContext: ResumeContext = facts && Object.keys(facts).length
      ? {
          ...context,
          confirmed_facts: [
            ...context.confirmed_facts.filter((fact) => !Object.hasOwn(facts, fact.key)),
            ...Object.entries(facts).map(([key, value]) => ({ key, value: String(value), confirmed_at: new Date().toISOString() })),
          ],
        }
      : context;

    try {
      const committed = await commitTurnResult(input.platform, {
        userTurnId: input.turn.id,
        expectedCaseVersion: snapshot.rowVersion,
        conversationId: input.bootstrap.conversation!.id,
        clientTurnId: input.envelope.client_turn_id,
        spokenResponse,
        nextQuestion,
        workflowState,
        caseStatus,
        conversationSummary: summary(projectedContext, nextQuestion),
        interactionState,
        confirmedFacts: facts,
        final,
      });
      return authPayload ? { ...committed, interaction_state: interactionState, auth_required: authPayload } : committed;
    } catch (error) {
      if (attempt === 0 && error instanceof PlatformDataError && error.retryable) {
        snapshot = await loadCaseSnapshot(input.platform, input.bootstrap.active_case!.id);
        continue;
      }
      throw error;
    }
  }
  throw new PlatformDataError("The case changed while this turn was being saved.", "concurrent_update", true);
}

export async function POST(req: NextRequest) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) {
      return NextResponse.json(
        { error: "Start the conversation to create a private session.", code: "authentication_required" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    const protectedResident = platform.principal.role === "resident" && platform.principal.isVerified;
    const runtimeConfig = getRuntimeConfig();
    const productionCaseRuntime = runtimeConfig.environment === "production" || !runtimeConfig.syntheticMode;
    if (productionCaseRuntime && !protectedResident) {
      throw new RequestError(
        401,
        "Sign in and verify Wayne County case access before saving this conversation.",
        "authentication_required",
      );
    }
    const entitlement = protectedResident
      ? await requireCaseEntitlementSession(req, platform)
      : null;
    const localLimit = rateLimitRequest(req, "resident-turn", 120, 60 * 1_000, platform.principal.userId);
    if (localLimit) return localLimit;
    const durableLimit = await platform.takeRateLimit({
      key: platform.principal.userId,
      bucket: "resident-turn",
      maxHits: 240,
      windowSeconds: 60,
    });
    if (!durableLimit.allowed) {
      return NextResponse.json(
        { error: "Too many turns at once. Please pause for a moment.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "2", "Cache-Control": "no-store" } },
      );
    }
    const body = await readJsonObject(req);
    const turnEnvelope = envelope(body);
    // A case has one resumable conversation across voice/text switches. Each
    // turn records its own channel, but channel switching never creates a new
    // conversation identity.
    let bootstrap;
    if (productionCaseRuntime) {
      if (entitlement?.accessType !== "case_entitlement" || !entitlement.entitlementId) {
        throw new RequestError(
          403,
          "Verify Wayne County case access before continuing.",
          "entitlement_required",
        );
      }
      bootstrap = await bootstrapEntitledProductionCase(
        platform,
        entitlement.caseId,
        entitlement.entitlementId,
        "voice",
      );
    } else {
      bootstrap = await bootstrapSession(platform, undefined, "voice");
    }
    if (!bootstrap.conversation || !bootstrap.active_case) throw new PlatformDataError("The active conversation is unavailable.");
    if (protectedResident) await requireCaseEntitlement(req, platform, bootstrap.active_case.id);
    if (turnEnvelope.conversation_id && turnEnvelope.conversation_id !== bootstrap.conversation.id) {
      throw new RequestError(403, "The conversation does not belong to this session.", "forbidden");
    }
    turnEnvelope.conversation_id = bootstrap.conversation.id;

    const persisted = await appendTurn(platform, turnEnvelope);
    const duplicate = persisted.duplicate && persisted.processingStatus === "committed"
      ? canonicalPersistedResult(persisted.processingResult, {
          conversationId: bootstrap.conversation.id,
          clientTurnId: turnEnvelope.client_turn_id,
        })
      : null;
    if (duplicate) return NextResponse.json(duplicate, { headers: { "Cache-Control": "no-store", "Idempotent-Replay": "true" } });

    const { data: userData } = await platform.client.auth.getUser();
    const declined = Boolean(userData.user?.user_metadata?.civya_intake_declined_at);
    const result = await processAuthoritativeTurn({ platform, turn: persisted, bootstrap, envelope: turnEnvelope, declined });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
