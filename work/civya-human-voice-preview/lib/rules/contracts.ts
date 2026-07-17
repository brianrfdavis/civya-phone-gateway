import type { WorkflowKey } from "@/lib/workflows/contracts";

export interface ApprovedContentBlock {
  key: string;
  locale: "en" | "es";
  version: string;
  status: "draft" | "synthetic_test" | "approved" | "retired";
  effectiveFrom: string;
  effectiveTo?: string;
  plainLanguage: string;
  sourceCitation: string;
}

export interface RuleVersion {
  key: string;
  workflowKey: WorkflowKey;
  version: string;
  status: "draft" | "synthetic_test" | "approved" | "retired";
  effectiveFrom: string;
  effectiveTo?: string;
  requiredSourceFields: readonly string[];
  requiredAssurance: "public" | "account" | "case" | "step_up";
  contentKeys: readonly string[];
  completionDefinitionKey: string;
}

export interface RuleEvaluationContext {
  now: string;
  sourceFields: Readonly<Record<string, unknown>>;
  assurance: "public" | "account" | "case" | "step_up";
  allowSynthetic: boolean;
}

export interface RuleEvaluationResult {
  rule: RuleVersion;
  applicable: boolean;
  reasonCodes: readonly string[];
  safeFallback: boolean;
}
