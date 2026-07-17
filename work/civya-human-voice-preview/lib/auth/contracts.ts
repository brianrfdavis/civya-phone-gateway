export type CivyaOAuthProvider = "google" | "apple" | "linkedin";

export type PendingAccountAction = "upload" | "paste" | "resume" | "saved_action";

export const CASE_ACCESS_SCOPES = Object.freeze([
  "case.read",
  "case.participate",
  "document.read",
  "document.upload",
] as const);

export type CaseAccessScope = (typeof CASE_ACCESS_SCOPES)[number];
export type CaseAccessPurpose = "case_access";

/** Exact authorization tuple carried through every account and proof flow. */
export interface CaseAccessBinding {
  tenantId: string;
  tenantSlug: string;
  tenantEnvironment: "sandbox" | "production";
  tenantFictional: boolean;
  residentId: string;
  caseId: string;
  purpose: CaseAccessPurpose;
  scopes: readonly CaseAccessScope[];
}

export interface PendingAccountTask {
  turnId?: string;
  question?: string;
  action?: PendingAccountAction;
  reason?: string;
}

export interface AccountFlowState {
  kind: "oauth" | "passkey";
  nonce: string;
  sourceUserId: string;
  transferToken?: string;
  caseAccess: CaseAccessBinding;
  provider?: CivyaOAuthProvider;
  pendingTask?: PendingAccountTask;
  exp: number;
}

export function isCaseAccessBinding(value: unknown): value is CaseAccessBinding {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const scopes = item.scopes;
  return typeof item.tenantId === "string" && Boolean(item.tenantId)
    && typeof item.tenantSlug === "string" && Boolean(item.tenantSlug)
    && (item.tenantEnvironment === "sandbox" || item.tenantEnvironment === "production")
    && typeof item.tenantFictional === "boolean"
    && typeof item.residentId === "string" && Boolean(item.residentId)
    && typeof item.caseId === "string" && Boolean(item.caseId)
    && item.purpose === "case_access"
    && Array.isArray(scopes)
    && scopes.length === CASE_ACCESS_SCOPES.length
    && CASE_ACCESS_SCOPES.every((scope, index) => scopes[index] === scope);
}

export function sameCaseAccessBinding(left: CaseAccessBinding, right: CaseAccessBinding): boolean {
  return left.tenantId === right.tenantId
    && left.tenantSlug === right.tenantSlug
    && left.tenantEnvironment === right.tenantEnvironment
    && left.tenantFictional === right.tenantFictional
    && left.residentId === right.residentId
    && left.caseId === right.caseId
    && left.purpose === right.purpose
    && left.scopes.length === right.scopes.length
    && left.scopes.every((scope, index) => scope === right.scopes[index]);
}

export interface AccountResumeState {
  method: CivyaOAuthProvider | "passkey" | "email";
  pendingTask?: PendingAccountTask;
  exp: number;
}

function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

export function sanitizePendingTask(value: unknown): PendingAccountTask | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const action = clipped(item.action, 32);
  const safeAction = action && ["upload", "paste", "resume", "saved_action"].includes(action)
    ? (action as PendingAccountAction)
    : undefined;
  const task: PendingAccountTask = {
    turnId: clipped(item.turn_id ?? item.turnId, 200),
    question: clipped(item.question ?? item.pending_question ?? item.pendingQuestion, 500),
    action: safeAction,
    reason: clipped(item.reason, 80),
  };
  return Object.values(task).some(Boolean) ? task : undefined;
}
