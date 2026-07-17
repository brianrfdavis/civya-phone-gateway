import crypto from "node:crypto";
import { z } from "zod";

export const DOCUMENT_UPLOAD_BUCKET = "civya-private-documents" as const;
export const DOCUMENT_UPLOAD_GRANT_TTL_MS = 10 * 60 * 1_000;

const uuid = z.string().uuid();
const uploadGrantClaimsSchema = z.object({
  v: z.literal(1),
  grantId: uuid,
  userId: z.string().min(1).max(128),
  tenantId: uuid,
  caseId: uuid,
  bucket: z.literal(DOCUMENT_UPLOAD_BUCKET),
  path: z.string().min(1).max(500),
  fileName: z.string().min(1).max(120),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"]),
  sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1).max(200),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();

export type DocumentUploadGrantClaims = z.infer<typeof uploadGrantClaimsSchema>;

export class DocumentUploadGrantError extends Error {
  constructor(
    message: string,
    readonly code: "upload_grant_invalid" | "upload_grant_expired" | "upload_grant_configuration_invalid",
  ) {
    super(message);
    this.name = "DocumentUploadGrantError";
  }
}

function signature(secret: string, payload: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`civya.document-upload.v1\0${payload}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function documentUploadSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const primary = env.CIVYA_DOCUMENT_UPLOAD_SECRET?.trim();
  if (primary && primary.length >= 32) return primary;

  const hosted = env.CIVYA_ENVIRONMENT === "staging" || env.CIVYA_ENVIRONMENT === "production" || Boolean(env.VERCEL);
  if (hosted) {
    throw new DocumentUploadGrantError(
      "CIVYA_DOCUMENT_UPLOAD_SECRET must be configured with at least 32 characters.",
      "upload_grant_configuration_invalid",
    );
  }

  const localFallback = env.CIVYA_AUTH_FLOW_SECRET?.trim() || env.CIVYA_DEMO_ACCESS_SECRET?.trim();
  if (localFallback && localFallback.length >= 32) return localFallback;
  throw new DocumentUploadGrantError(
    "A local upload signing secret is not configured.",
    "upload_grant_configuration_invalid",
  );
}

export function issueDocumentUploadGrant(
  input: Omit<DocumentUploadGrantClaims, "v" | "grantId" | "issuedAt" | "expiresAt">,
  options: { secret?: string; now?: number; ttlMs?: number } = {},
): { token: string; claims: DocumentUploadGrantClaims } {
  const now = options.now ?? Date.now();
  const ttlMs = Math.min(options.ttlMs ?? DOCUMENT_UPLOAD_GRANT_TTL_MS, DOCUMENT_UPLOAD_GRANT_TTL_MS);
  const claims = uploadGrantClaimsSchema.parse({
    ...input,
    v: 1,
    grantId: crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + ttlMs,
  });
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const mac = signature(options.secret ?? documentUploadSigningSecret(), payload);
  return { token: `${payload}.${mac}`, claims };
}

export function verifyDocumentUploadGrant(
  token: string,
  options: { secret?: string; now?: number } = {},
): DocumentUploadGrantClaims {
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra) {
    throw new DocumentUploadGrantError("The upload authorization is invalid.", "upload_grant_invalid");
  }
  const expected = signature(options.secret ?? documentUploadSigningSecret(), payload);
  if (!safeEqual(expected, supplied)) {
    throw new DocumentUploadGrantError("The upload authorization is invalid.", "upload_grant_invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new DocumentUploadGrantError("The upload authorization is invalid.", "upload_grant_invalid");
  }
  const parsed = uploadGrantClaimsSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new DocumentUploadGrantError("The upload authorization is invalid.", "upload_grant_invalid");
  }
  const now = options.now ?? Date.now();
  if (
    parsed.data.expiresAt <= now
    || parsed.data.issuedAt > now + 30_000
    || parsed.data.expiresAt <= parsed.data.issuedAt
    || parsed.data.expiresAt - parsed.data.issuedAt > DOCUMENT_UPLOAD_GRANT_TTL_MS
  ) {
    throw new DocumentUploadGrantError("The upload authorization expired. Start the upload again.", "upload_grant_expired");
  }
  return parsed.data;
}

export function documentUploadIdempotencyHash(idempotencyKey: string): string {
  return crypto.createHash("sha256").update(idempotencyKey).digest("hex");
}
