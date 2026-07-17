import { createHash } from "node:crypto";
import { createWorkflowInstance, transitionWorkflow } from "./engine";
import type { AuthoritativeEvidence, WorkflowInstance } from "./contracts";

const NOW = "2026-07-16T12:00:00.000Z";

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export interface SyntheticSliceResult {
  batchId: string;
  residentId: string;
  caseId: string;
  workflow: WorkflowInstance;
  operationId: string;
  evidence: AuthoritativeEvidence;
  correlationId: string;
  chronology: readonly string[];
  staffException: "none";
}

export function runSyntheticPaymentPlanSlice(): SyntheticSliceResult {
  const batchId = "synthetic-001";
  const residentId = "synthetic-resident-01";
  const caseId = "case-01";
  const correlationId = stableId("cv", `${batchId}:${caseId}`);
  const operationId = stableId("hp", `${caseId}:wayne-payment-plan-v1`);
  const evidence: AuthoritativeEvidence = {
    evidenceId: stableId("ce", `${operationId}:active`),
    source: "wayne-authoritative-status-synthetic",
    sourceRecordId: "wayne-plan-status-001",
    observedAt: NOW,
    status: "active",
    reversible: true,
  };
  let workflow = createWorkflowInstance({
    id: "workflow-payment-plan-01",
    tenantId: "wayne-county-demo",
    caseId,
    workflowKey: "payment_plan_navigation",
    sourceVersion: "wayne-source-fixture-v1",
    ruleVersion: "wayne-plan-rule-v1",
    contentVersion: "wayne-content-en-v1",
    now: NOW,
  });
  const chronology: string[] = [`${workflow.rowVersion}:${workflow.state}`];
  const states = ["entitled", "handoff_created", "provider_open", "submitted", "confirming"];
  for (const nextState of states) {
    workflow = transitionWorkflow(workflow, {
      expectedVersion: workflow.rowVersion,
      nextState,
      actorType: nextState === "provider_open" || nextState === "submitted" ? "provider" : "service",
      idempotencyKey: `${workflow.id}:${nextState}`,
      correlationId,
      reasonCode: `synthetic_${nextState}`,
      now: NOW,
    }).instance;
    chronology.push(`${workflow.rowVersion}:${workflow.state}`);
  }
  workflow = transitionWorkflow(workflow, {
    expectedVersion: workflow.rowVersion,
    nextState: "active",
    actorType: "service",
    idempotencyKey: `${workflow.id}:active:${evidence.sourceRecordId}`,
    correlationId,
    reasonCode: "authoritative_plan_active",
    evidence,
    now: NOW,
  }).instance;
  chronology.push(`${workflow.rowVersion}:${workflow.state}:${evidence.evidenceId}`);

  return {
    batchId,
    residentId,
    caseId,
    workflow,
    operationId,
    evidence,
    correlationId,
    chronology,
    staffException: "none",
  };
}
