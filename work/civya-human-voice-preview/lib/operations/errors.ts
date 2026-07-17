export interface ProblemDetails {
  code: string;
  title: string;
  detail: string;
  retryable: boolean;
  nextAction: string;
  docs?: string;
  correlationId: string;
}

export class CivyaOperationalError extends Error {
  constructor(readonly problem: Omit<ProblemDetails, "correlationId">) {
    super(problem.detail);
    this.name = "CivyaOperationalError";
  }

  withCorrelation(correlationId: string): ProblemDetails {
    return { ...this.problem, correlationId };
  }
}

export function newCorrelationId(existing?: string | null): string {
  if (existing && /^[a-zA-Z0-9._:-]{8,128}$/.test(existing)) return existing;
  return `cv-${crypto.randomUUID()}`;
}
