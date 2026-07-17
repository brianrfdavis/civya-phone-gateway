import type { RuleEvaluationContext, RuleEvaluationResult, RuleVersion } from "./contracts";

const assuranceRank = { public: 0, account: 1, case: 2, step_up: 3 } as const;

const rules: readonly RuleVersion[] = [
  {
    key: "wayne_notice_response",
    workflowKey: "urgent_notice_response",
    version: "wayne-notice-rule-v1",
    status: "synthetic_test",
    effectiveFrom: "2026-07-16T00:00:00.000Z",
    requiredSourceFields: ["parcel_id", "tax_year", "notice_type", "notice_date"],
    requiredAssurance: "case",
    contentKeys: ["notice_next_action"],
    completionDefinitionKey: "wayne_notice_resolved_v1",
  },
  {
    key: "wayne_payment_plan_navigation",
    workflowKey: "payment_plan_navigation",
    version: "wayne-plan-rule-v1",
    status: "synthetic_test",
    effectiveFrom: "2026-07-16T00:00:00.000Z",
    requiredSourceFields: ["parcel_id", "tax_year", "case_status"],
    requiredAssurance: "case",
    contentKeys: ["payment_plan_next_action"],
    completionDefinitionKey: "wayne_active_plan_v1",
  },
  {
    key: "wayne_document_readiness",
    workflowKey: "document_readiness",
    version: "wayne-document-rule-v1",
    status: "synthetic_test",
    effectiveFrom: "2026-07-16T00:00:00.000Z",
    requiredSourceFields: ["case_id", "requested_document_types"],
    requiredAssurance: "case",
    contentKeys: ["document_readiness_next_action"],
    completionDefinitionKey: "wayne_document_ready_v1",
  },
  {
    key: "wayne_reminders_follow_through",
    workflowKey: "reminders_follow_through",
    version: "wayne-reminder-rule-v1",
    status: "synthetic_test",
    effectiveFrom: "2026-07-16T00:00:00.000Z",
    requiredSourceFields: ["case_id", "task_key"],
    requiredAssurance: "account",
    contentKeys: ["reminder_next_action"],
    completionDefinitionKey: "provider_delivery_receipt_v1",
  },
  {
    key: "wayne_human_partner_handoff",
    workflowKey: "human_partner_handoff",
    version: "wayne-handoff-rule-v1",
    status: "synthetic_test",
    effectiveFrom: "2026-07-16T00:00:00.000Z",
    requiredSourceFields: ["case_id", "assistance_reason"],
    requiredAssurance: "case",
    contentKeys: ["human_handoff_next_action"],
    completionDefinitionKey: "approved_handoff_closed_v1",
  },
];

export function listRuleVersions(): readonly RuleVersion[] {
  return rules;
}

export function evaluateRule(rule: RuleVersion, context: RuleEvaluationContext): RuleEvaluationResult {
  const now = Date.parse(context.now);
  const effective = now >= Date.parse(rule.effectiveFrom) && (!rule.effectiveTo || now < Date.parse(rule.effectiveTo));
  const missing = rule.requiredSourceFields.filter((field) => context.sourceFields[field] === undefined);
  const assuranceOk = assuranceRank[context.assurance] >= assuranceRank[rule.requiredAssurance];
  const statusOk = rule.status === "approved" || (context.allowSynthetic && rule.status === "synthetic_test");
  const reasonCodes: string[] = [];
  if (!effective) reasonCodes.push("rule_not_effective");
  if (missing.length > 0) reasonCodes.push("source_fields_missing");
  if (!assuranceOk) reasonCodes.push("assurance_insufficient");
  if (!statusOk) reasonCodes.push("rule_not_approved");
  return {
    rule,
    applicable: reasonCodes.length === 0,
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["rule_applicable"],
    safeFallback: reasonCodes.length > 0,
  };
}
