const PLACEHOLDER_PATTERNS = [
  /^(?:replace|placeholder|your)(?:[-_ ]|$)/i,
  /^(?:change[-_ ]?me|changeme)(?:[-_ ]|$)/i,
  /^(?:test|testing|synthetic|development|dev|example|sample|dummy|fake)(?:[-_ ]|$)/i,
  /^civya-local-/i,
  /change-before-(?:hosting|production)/i,
  /^(?:sk|whsec)[-_]?\.\.\.$/i,
] as const;

export interface ProductionSecretRequirement {
  name: string;
  minimumBytes: number;
  required: boolean;
}

/**
 * Keys that protect Civya-owned browser state or server-to-server authority.
 * Provider-issued API credentials are validated by their adapters instead.
 */
export const PRODUCTION_SECRET_REQUIREMENTS: readonly ProductionSecretRequirement[] = Object.freeze([
  { name: "CIVYA_AUTH_FLOW_SECRET", minimumBytes: 32, required: true },
  { name: "CIVYA_AUTH_UPGRADE_SECRET", minimumBytes: 32, required: true },
  { name: "CIVYA_STAFF_AUTH_SECRET", minimumBytes: 32, required: true },
  { name: "CIVYA_ENTITLEMENT_VERIFY_SECRET", minimumBytes: 32, required: true },
  { name: "CIVYA_DOCUMENT_UPLOAD_SECRET", minimumBytes: 32, required: true },
  { name: "CIVYA_TELEMETRY_INGEST_SECRET", minimumBytes: 32, required: true },
  { name: "CIVYA_DEMO_ACCESS_SECRET", minimumBytes: 32, required: false },
  { name: "CIVYA_INTERNAL_SERVICE_SECRET", minimumBytes: 32, required: false },
  { name: "CIVYA_PHONE_TURN_SERVICE_SECRET", minimumBytes: 32, required: false },
  { name: "CIVYA_PHONE_DIGEST_SECRET", minimumBytes: 32, required: false },
  { name: "CIVYA_SECURE_LINK_SECRET", minimumBytes: 32, required: false },
  { name: "CIVYA_PAYMENT_LINK_SECRET", minimumBytes: 32, required: false },
  { name: "CRON_SECRET", minimumBytes: 32, required: false },
  { name: "OPENAI_WEBHOOK_SECRET", minimumBytes: 24, required: false },
  { name: "JPM_CHECKOUT_WEBHOOK_SECRET", minimumBytes: 24, required: false },
  { name: "DOCUSIGN_WEBHOOK_SECRET", minimumBytes: 24, required: false },
]);

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isKnownDevelopmentSecret(value: string | undefined): boolean {
  const candidate = value?.trim();
  return Boolean(candidate && PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(candidate)));
}

export function validateProductionSecrets(env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  const configured = new Map<string, string>();

  for (const requirement of PRODUCTION_SECRET_REQUIREMENTS) {
    const value = env[requirement.name]?.trim() ?? "";
    if (!value) {
      if (requirement.required) issues.push(`Production requires ${requirement.name}.`);
      continue;
    }
    configured.set(requirement.name, value);
    if (utf8ByteLength(value) < requirement.minimumBytes) {
      issues.push(`Production secret ${requirement.name} must contain at least ${requirement.minimumBytes} bytes.`);
    }
    if (isKnownDevelopmentSecret(value)) {
      issues.push(`Production secret ${requirement.name} is a known development or placeholder value.`);
    }
  }

  const namesByValue = new Map<string, string[]>();
  for (const [name, value] of configured) {
    const names = namesByValue.get(value) ?? [];
    names.push(name);
    namesByValue.set(value, names);
  }
  for (const names of namesByValue.values()) {
    if (names.length > 1) {
      issues.push(`Production secrets must be distinct; duplicate value configured for ${names.sort().join(", ")}.`);
    }
  }

  return issues;
}

export function requireProductionNamedSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  minimumBytes = 32,
): string {
  const value = env[name]?.trim() ?? "";
  if (env.CIVYA_ENVIRONMENT !== "production") {
    if (!value) throw new Error(`${name} is not configured.`);
    return value;
  }
  if (!value || utf8ByteLength(value) < minimumBytes || isKnownDevelopmentSecret(value)) {
    throw new Error(`${name} is not securely configured for production.`);
  }
  return value;
}
