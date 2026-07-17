import assert from "node:assert/strict";
import { CivyaOperationalError } from "../lib/operations/errors";
import { listWorkflowDefinitions } from "../lib/workflows/definitions";
import { createWorkflowInstance, transitionWorkflow } from "../lib/workflows/engine";
import { runSyntheticPaymentPlanSlice } from "../lib/workflows/synthetic-slice";
import { computeCountyBatchControlTotal, validateCountyBatch } from "../lib/source/contracts";
import { evaluateRule, listRuleVersions } from "../lib/rules/registry";
import { evaluateActivation } from "../lib/workflows/activation";
import { listModelTaskPolicies } from "../lib/models/registry";

const definitions = listWorkflowDefinitions();
assert.equal(definitions.length, 5, "all five launch workflows must be registered");
for (const definition of definitions) {
  assert.ok(definition.transitions[definition.initialState], `${definition.key} has an initial state`);
  for (const [state, nextStates] of Object.entries(definition.transitions)) {
    assert.ok(definition.nextActions[state], `${definition.key}:${state} has resident-safe next action`);
    for (const next of nextStates) {
      assert.ok(definition.transitions[next], `${definition.key}:${state} references known state ${next}`);
    }
  }
}

const instance = createWorkflowInstance({
  id: "test-workflow",
  tenantId: "tenant",
  caseId: "case",
  workflowKey: "payment_plan_navigation",
  sourceVersion: "source-v1",
  ruleVersion: "rule-v1",
  contentVersion: "content-v1",
  now: "2026-07-16T00:00:00.000Z",
});

assert.throws(
  () => transitionWorkflow(instance, {
    expectedVersion: 0,
    nextState: "entitled",
    actorType: "service",
    idempotencyKey: "idempotency",
    correlationId: "correlation",
    reasonCode: "test",
  }),
  (error: unknown) => error instanceof CivyaOperationalError && error.problem.code === "workflow_concurrent_update",
);

let activeCandidate = instance;
for (const nextState of ["entitled", "handoff_created", "provider_open", "submitted", "confirming"]) {
  activeCandidate = transitionWorkflow(activeCandidate, {
    expectedVersion: activeCandidate.rowVersion,
    nextState,
    actorType: "service",
    idempotencyKey: `idempotency:${nextState}`,
    correlationId: "correlation-123",
    reasonCode: "test",
  }).instance;
}
assert.throws(
  () => transitionWorkflow(activeCandidate, {
    expectedVersion: activeCandidate.rowVersion,
    nextState: "active",
    actorType: "service",
    idempotencyKey: "idempotency:active",
    correlationId: "correlation-123",
    reasonCode: "test",
  }),
  (error: unknown) => error instanceof CivyaOperationalError && error.problem.code === "authoritative_evidence_required",
);

const result = runSyntheticPaymentPlanSlice();
assert.equal(result.workflow.state, "active");
assert.equal(result.workflow.rowVersion, 7);
assert.equal(result.staffException, "none");
assert.match(result.evidence.evidenceId, /^ce-[0-9a-f]{12}$/);
assert.equal(result.chronology.length, 7);

const countyRecords = [{
  externalRecordId: "record-1",
  recordType: "plan_status" as const,
  parcelId: "parcel-1",
  taxYear: 2026,
  effectiveAt: "2026-07-16T00:00:00.000Z",
  retracted: false,
  fields: { status: "active", nested: { authoritative: true } },
}];
const declaredControlTotal = computeCountyBatchControlTotal(countyRecords);
assert.equal(validateCountyBatch({
  tenantSlug: "wayne-county-demo",
  sourceKey: "wayne_test",
  externalBatchId: "batch-1",
  schemaVersion: "v1",
  sourceGeneratedAt: "2026-07-16T00:00:00.000Z",
  declaredRecordCount: 1,
  declaredControlTotal,
  records: countyRecords,
}).computedControlTotal, declaredControlTotal);

const rules = listRuleVersions();
assert.equal(rules.length, 5);
const paymentRule = rules.find((rule) => rule.workflowKey === "payment_plan_navigation")!;
assert.equal(evaluateRule(paymentRule, {
  now: "2026-07-16T12:00:00.000Z",
  assurance: "case",
  allowSynthetic: true,
  sourceFields: { parcel_id: "parcel-1", tax_year: 2026, case_status: "open" },
}).applicable, true);
assert.equal(evaluateRule(paymentRule, {
  now: "2026-07-16T12:00:00.000Z",
  assurance: "account",
  allowSynthetic: true,
  sourceFields: { parcel_id: "parcel-1", tax_year: 2026, case_status: "open" },
}).safeFallback, true);

assert.equal(evaluateActivation({
  workflowKey: "payment_plan_navigation",
  stage: "staff_rehearsal",
  enrolledResidents: 0,
}, "canary_50", {
  wrongCaseEvents: 0,
  unresolvedReconciliation: 0,
  urgentSlaBreachRate: 0,
  queueAgeMinutes: 0,
  securityOrAuditIncident: false,
  criticalAccessibilityBlocker: false,
}).allowed, true);
assert.equal(evaluateActivation({
  workflowKey: "payment_plan_navigation",
  stage: "canary_50",
  enrolledResidents: 25,
}, "cohort_250", {
  wrongCaseEvents: 1,
  unresolvedReconciliation: 0,
  urgentSlaBreachRate: 0,
  queueAgeMinutes: 0,
  securityOrAuditIncident: false,
  criticalAccessibilityBlocker: false,
}).nextStage, "disabled");

assert.equal(listModelTaskPolicies().length, 4);
for (const policy of listModelTaskPolicies()) {
  assert.ok(policy.prohibitedAuthority.includes("completion"), `${policy.task} forbids completion authority`);
}

console.log("workflow-kernel-tests: workflows, source controls, rules, activation gates, model authority, and synthetic slice passed");
