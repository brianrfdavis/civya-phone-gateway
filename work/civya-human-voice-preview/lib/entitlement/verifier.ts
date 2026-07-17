import crypto from "node:crypto";
import {
  sameCaseAccessBinding,
  type CaseAccessBinding,
} from "@/lib/auth/contracts";
import { requireProductionNamedSecret } from "@/lib/security/runtime-secrets";

export type EntitlementMethod = "notice_code" | "invitation_code";

export interface EntitlementVerification {
  verified: true;
  grantId: string;
  binding: CaseAccessBinding;
  expiresAt: number;
}

function adapterConfiguration(): { url: URL; secret: string } | null {
  const rawUrl = process.env.CIVYA_ENTITLEMENT_VERIFY_URL?.trim();
  const secret = process.env.CIVYA_ENVIRONMENT === "production"
    ? requireProductionNamedSecret("CIVYA_ENTITLEMENT_VERIFY_SECRET")
    : process.env.CIVYA_ENTITLEMENT_VERIFY_SECRET?.trim();
  if (!rawUrl || !secret) return null;
  const url = new URL(rawUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!local && url.protocol !== "https:") throw new Error("The entitlement adapter must use HTTPS.");
  return { url, secret };
}

export function entitlementCapabilities() {
  let configured = false;
  try {
    configured = adapterConfiguration() !== null;
  } catch {
    configured = false;
  }
  return {
    notice_code: configured,
    invitation_code: configured,
    staff_assisted: true,
    unavailable_reason: configured
      ? undefined
      : "Digital Wayne County case verification is not connected for this deployment.",
  };
}

export function normalizeEntitlementCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/\s+/g, "").slice(0, 40);
}

export function validEntitlementCode(value: string): boolean {
  return /^[A-Z0-9-]{6,40}$/.test(value);
}

export async function verifyCaseEntitlement(input: {
  userId: string;
  method: EntitlementMethod;
  code: string;
  binding: CaseAccessBinding;
}): Promise<EntitlementVerification | null> {
  const config = adapterConfiguration();
  if (!config) return null;
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    version: "2",
    account_subject: crypto.createHash("sha256").update(input.userId).digest("base64url"),
    method: input.method,
    code: input.code,
    expected_binding: {
      tenant_id: input.binding.tenantId,
      tenant_slug: input.binding.tenantSlug,
      tenant_environment: input.binding.tenantEnvironment,
      tenant_fictional: input.binding.tenantFictional,
      resident_id: input.binding.residentId,
      case_id: input.binding.caseId,
      purpose: input.binding.purpose,
      scopes: [...input.binding.scopes],
    },
  });
  const signature = crypto.createHmac("sha256", config.secret).update(`${timestamp}.${body}`).digest("base64url");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Civya-Timestamp": timestamp,
        "X-Civya-Signature": `v1=${signature}`,
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!result || result.verified !== true || typeof result.grant_id !== "string" || !result.grant_id.trim()) {
      return null;
    }
    const rawBinding = result.binding;
    if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) return null;
    const bindingRow = rawBinding as Record<string, unknown>;
    if (typeof bindingRow.tenant_id !== "string"
      || typeof bindingRow.tenant_slug !== "string"
      || (bindingRow.tenant_environment !== "sandbox" && bindingRow.tenant_environment !== "production")
      || typeof bindingRow.tenant_fictional !== "boolean"
      || typeof bindingRow.resident_id !== "string"
      || typeof bindingRow.case_id !== "string"
      || bindingRow.purpose !== "case_access"
      || !Array.isArray(bindingRow.scopes)) return null;
    const returnedBinding: CaseAccessBinding = {
      tenantId: bindingRow.tenant_id,
      tenantSlug: bindingRow.tenant_slug,
      tenantEnvironment: bindingRow.tenant_environment === "sandbox" ? "sandbox" : "production",
      tenantFictional: bindingRow.tenant_fictional,
      residentId: bindingRow.resident_id,
      caseId: bindingRow.case_id,
      purpose: "case_access",
      scopes: bindingRow.scopes as CaseAccessBinding["scopes"],
    };
    if (bindingRow.purpose !== "case_access" || !sameCaseAccessBinding(returnedBinding, input.binding)) {
      return null;
    }
    const requestedExpiry = typeof result.expires_at === "string" ? Date.parse(result.expires_at) : NaN;
    const maxExpiry = Date.now() + 30 * 60 * 1_000;
    return {
      verified: true,
      grantId: result.grant_id.slice(0, 500),
      binding: returnedBinding,
      expiresAt: Number.isFinite(requestedExpiry)
        ? Math.min(Math.max(requestedExpiry, Date.now() + 60_000), maxExpiry)
        : maxExpiry,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function humanEntitlementHelp(): string {
  return process.env.CIVYA_ENTITLEMENT_HUMAN_HELP?.trim()
    || "A trained person can verify access without asking you to share account credentials. Ask Civya for a person to continue.";
}
