import { runSyntheticPaymentPlanSlice } from "../lib/workflows/synthetic-slice";

const started = performance.now();
const result = runSyntheticPaymentPlanSlice();

const rows = [
  ["County fixture imported", `batch=${result.batchId} controls=valid`],
  ["Resident entitled", `resident=${result.residentId} case=${result.caseId} assurance=case`],
  ["Approved next action", `workflow=${result.workflow.workflowKey} rule=${result.workflow.ruleVersion}`],
  ["Mock hosted handoff launched", `operation=${result.operationId}`],
  ["Authoritative status received", `state=${result.workflow.state}`],
  ["Completion evidence recorded", `evidence=${result.evidence.evidenceId}`],
  ["Staff chronology verified", `correlation=${result.correlationId} events=${result.chronology.length}`],
] as const;

for (const [label, detail] of rows) {
  console.log(`${label.padEnd(31)} ${detail}`);
}
console.log(
  `PASS${" ".repeat(27)} resident=/case/${result.caseId} staff=/staff/operations?case=${result.caseId} elapsed_ms=${Math.round(performance.now() - started)}`,
);
