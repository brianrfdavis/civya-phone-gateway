export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

export class PlatformConfigurationError extends Error {
  readonly code = "platform_not_configured";

  constructor(message = "The county-demo data service is not configured.") {
    super(message);
    this.name = "PlatformConfigurationError";
  }
}

export function getSupabasePublicConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

export function requireSupabasePublicConfig(): SupabasePublicConfig {
  const config = getSupabasePublicConfig();
  if (!config) {
    throw new PlatformConfigurationError(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.",
    );
  }
  return config;
}

export function getSupabaseServiceRoleKey(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

export function requireSupabaseServiceRoleKey(): string {
  const key = getSupabaseServiceRoleKey();
  if (!key) throw new PlatformConfigurationError("SUPABASE_SERVICE_ROLE_KEY is required for this operation.");
  return key;
}

export function isSupabaseConfigured(): boolean {
  return getSupabasePublicConfig() !== null;
}
