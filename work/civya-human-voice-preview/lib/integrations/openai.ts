import { createHash } from "node:crypto";

export type ModelTask = "transcription" | "language_detection" | "bounded_extraction" | "approved_text_delivery" | "staff_draft";

export interface ModelTaskRequest {
  task: ModelTask;
  model: string;
  modelVersion: string;
  evaluationVersion: string;
  store: false;
  redactionApplied: true;
  inputReference: string;
  allowedOutputKeys: string[];
}

export interface ModelTaskResult {
  provider: "openai";
  responseReference: string;
  task: ModelTask;
  output: Record<string, unknown>;
  authority: "language_only";
  mayMutateCaseState: false;
}

const PROHIBITED_AUTHORITY_KEY = /^(?:access|amount|approval|case_status|completion|deadline|eligibility|identity|match|payment|refund|route|workflow_state)$/i;

function assertNoModelAuthority(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_AUTHORITY_KEY.test(key)) throw new Error(`Model attempted a prohibited authority field: ${path}.${key}.`);
    assertNoModelAuthority(child, `${path}.${key}`);
  }
}

export function validateModelResult(request: ModelTaskRequest, output: Record<string, unknown>): void {
  const allowed = new Set(request.allowedOutputKeys);
  for (const key of Object.keys(output)) {
    if (!allowed.has(key)) throw new Error(`Model returned an unapproved output key: ${key}.`);
    if (PROHIBITED_AUTHORITY_KEY.test(key)) throw new Error(`Model attempted a prohibited authority field: ${key}.`);
  }
  assertNoModelAuthority(output, "output");
}

export class SyntheticOpenAILanguageAdapter {
  async run(request: ModelTaskRequest, fixtureOutput: Record<string, unknown>): Promise<ModelTaskResult> {
    if (request.store !== false || request.redactionApplied !== true) {
      throw new Error("Model calls require store=false and deterministic redaction before dispatch.");
    }
    validateModelResult(request, fixtureOutput);
    const responseReference = createHash("sha256")
      .update(`${request.task}:${request.inputReference}:${JSON.stringify(fixtureOutput)}`)
      .digest("hex")
      .slice(0, 24);
    return {
      provider: "openai",
      responseReference: `syn_oai_${responseReference}`,
      task: request.task,
      output: fixtureOutput,
      authority: "language_only",
      mayMutateCaseState: false,
    };
  }
}
