import { NextResponse } from "next/server";
import {
  GovernedWorkflowRepositoryError,
  type GovernedWorkflowSnapshot,
  type WorkflowMutationResult,
} from "./repository.server";

if (typeof window !== "undefined") {
  throw new Error("Workflow HTTP helpers are server-only.");
}

export function workflowErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof GovernedWorkflowRepositoryError)) {
    console.error("Governed workflow request failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      {
        error: "Civya could not safely complete that workflow request. Saved progress was not changed.",
        code: "workflow_service_error",
        retryable: true,
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const status = error.code === "workflow_access_denied"
    ? 403
    : error.code === "workflow_not_found"
      ? 404
      : error.code === "workflow_stale_state" || error.code === "workflow_idempotency_conflict"
        ? 409
        : error.code === "workflow_store_unavailable"
          ? 503
          : 400;
  return NextResponse.json(
    { error: error.message, code: error.code, retryable: error.retryable || undefined },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function workflowResponse(
  snapshot: GovernedWorkflowSnapshot,
  mutation?: WorkflowMutationResult,
  status = 200,
): NextResponse {
  return NextResponse.json(
    {
      workflow: {
        id: snapshot.id,
        case_id: snapshot.caseId,
        workflow_key: snapshot.workflowKey,
        definition_version: snapshot.definitionVersion,
        state: snapshot.state,
        status: snapshot.status,
        row_version: snapshot.rowVersion,
        correlation_id: snapshot.correlationId,
        next_action: snapshot.nextAction,
        completion_authority: snapshot.completionAuthority,
        started_at: snapshot.startedAt,
        updated_at: snapshot.updatedAt,
        completed_at: snapshot.completedAt,
        actions: snapshot.actions.map((action) => ({
          id: action.id,
          sequence_number: action.sequenceNumber,
          action_key: action.actionKey,
          from_state: action.fromState,
          to_state: action.toState,
          actor_type: action.actorType,
          reason_code: action.reasonCode,
          correlation_id: action.correlationId,
          completion_evidence_id: action.completionEvidenceId,
          created_at: action.createdAt,
        })),
        handoffs: snapshot.handoffs.map((handoff) => ({
          id: handoff.id,
          provider_key: handoff.providerKey,
          destination_origin: handoff.destinationOrigin,
          browser_state: handoff.browserState,
          authoritative_state: handoff.authoritativeState,
          row_version: handoff.rowVersion,
          expires_at: handoff.expiresAt,
          updated_at: handoff.updatedAt,
        })),
        exception: snapshot.exception
          ? {
              id: snapshot.exception.id,
              type: snapshot.exception.type,
              severity: snapshot.exception.severity,
              status: snapshot.exception.status,
              reason_code: snapshot.exception.reasonCode,
              redacted_summary: snapshot.exception.redactedSummary,
              assigned_to_auth_user_id: snapshot.exception.assignedToAuthUserId,
              resident_message: snapshot.exception.residentMessage,
              row_version: snapshot.exception.rowVersion,
              created_at: snapshot.exception.createdAt,
              updated_at: snapshot.exception.updatedAt,
            }
          : null,
      },
      mutation: mutation
        ? {
            action_id: mutation.actionId,
            duplicate: mutation.duplicate,
          }
        : undefined,
      authority: {
        state: "durable_postgres_workflow",
        browser_return: "advisory_only",
        completion: "versioned_authoritative_evidence_required",
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function bodyString(
  body: Record<string, unknown>,
  snake: string,
  camel?: string,
): string {
  const value = body[snake] ?? (camel ? body[camel] : undefined);
  return typeof value === "string" ? value : "";
}

export function bodyInteger(
  body: Record<string, unknown>,
  snake: string,
  camel?: string,
): number {
  const value = body[snake] ?? (camel ? body[camel] : undefined);
  return typeof value === "number" ? value : Number.NaN;
}

export function bodyObject(
  body: Record<string, unknown>,
  snake: string,
  camel?: string,
): Record<string, unknown> | undefined {
  const value = body[snake] ?? (camel ? body[camel] : undefined);
  if (value === undefined) return undefined;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
