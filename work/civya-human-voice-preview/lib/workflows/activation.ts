import type { WorkflowKey } from "./contracts";

export type ActivationStage = "disabled" | "staff_rehearsal" | "canary_50" | "cohort_250" | "cohort_500";

export interface WorkflowActivation {
  workflowKey: WorkflowKey;
  stage: ActivationStage;
  enrolledResidents: number;
  pauseReason?: string;
  lastEvidenceAt?: string;
}

export interface LaunchSignals {
  wrongCaseEvents: number;
  unresolvedReconciliation: number;
  urgentSlaBreachRate: number;
  queueAgeMinutes: number;
  securityOrAuditIncident: boolean;
  criticalAccessibilityBlocker: boolean;
}

export interface ActivationDecision {
  allowed: boolean;
  nextStage: ActivationStage;
  reasons: readonly string[];
}

const stageLimits: Record<ActivationStage, number> = {
  disabled: 0,
  staff_rehearsal: 0,
  canary_50: 50,
  cohort_250: 250,
  cohort_500: 500,
};

export function evaluateActivation(
  activation: WorkflowActivation,
  requested: ActivationStage,
  signals: LaunchSignals,
): ActivationDecision {
  const reasons: string[] = [];
  if (signals.wrongCaseEvents > 0) reasons.push("wrong_case_event");
  if (signals.unresolvedReconciliation > 0) reasons.push("unresolved_reconciliation");
  if (signals.urgentSlaBreachRate > 0.1) reasons.push("urgent_sla_breach_rate");
  if (signals.queueAgeMinutes > 240) reasons.push("queue_age");
  if (signals.securityOrAuditIncident) reasons.push("security_or_audit_incident");
  if (signals.criticalAccessibilityBlocker) reasons.push("critical_accessibility_blocker");
  if (activation.pauseReason) reasons.push("manual_pause");
  if (stageLimits[requested] < activation.enrolledResidents) reasons.push("requested_stage_below_enrollment");
  return {
    allowed: reasons.length === 0,
    nextStage: reasons.length === 0 ? requested : "disabled",
    reasons: reasons.length === 0 ? ["evidence_gate_passed"] : reasons,
  };
}
