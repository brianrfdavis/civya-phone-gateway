import type { RuntimeConfig } from "./runtime";

export interface RuntimeRequestDescriptor {
  pathname: string;
  method: string;
}

export interface RuntimeGateDenial {
  allowed: false;
  status: 503;
  code: "resident_web_paused" | "platform_paused" | "browser_voice_disabled";
  message: string;
}

export interface RuntimeGateAllowance {
  allowed: true;
}

export type RuntimeGateDecision = RuntimeGateAllowance | RuntimeGateDenial;

const OPERATIONAL_PREFIXES = [
  "/api/health",
  "/api/runtime",
  "/api/webhooks/",
  "/api/internal/",
  "/api/admin/",
  "/api/staff/",
  "/api/v1/staff/",
  "/admin",
  "/staff",
] as const;

const PUBLIC_INFORMATION_PATHS = ["/services", "/trust"] as const;
const BROWSER_VOICE_PATHS = ["/api/realtime/session"] as const;
const AI_PATHS = [
  "/api/conversations/turn",
  "/api/turn",
  "/api/tools/cached-answer",
  "/api/tools/document-checklist",
  "/api/tools/eligibility",
  "/api/tools/intent",
  "/api/tools/program",
  "/api/tools/property-status",
  "/api/tools/workflow",
] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * Operations that must remain reachable while resident traffic is paused.
 * Their route handlers still enforce staff sessions, service credentials, and
 * provider webhook signatures; this gate grants no authorization by itself.
 */
export function isRuntimeOperationalPath(pathname: string): boolean {
  return OPERATIONAL_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

function isPublicInformationPath(pathname: string): boolean {
  return PUBLIC_INFORMATION_PATHS.some((prefix) => matchesPrefix(pathname, prefix));
}

function isBrowserVoicePath(pathname: string): boolean {
  return BROWSER_VOICE_PATHS.some((prefix) => matchesPrefix(pathname, prefix));
}

function isAiPath(pathname: string): boolean {
  return AI_PATHS.some((prefix) => matchesPrefix(pathname, prefix));
}

function isResidentSurface(pathname: string): boolean {
  if (isRuntimeOperationalPath(pathname) || isPublicInformationPath(pathname)) return false;
  return pathname === "/" || pathname.startsWith("/api/") || pathname.startsWith("/case/")
    || pathname.startsWith("/invite/") || pathname.startsWith("/phone/")
    || matchesPrefix(pathname, "/access") || matchesPrefix(pathname, "/results");
}

/**
 * Central runtime circuit breaker. Staff/admin recovery, signed webhooks,
 * internal reconciliation, runtime inspection, and health checks bypass only
 * this availability gate and remain subject to their own authorization.
 */
export function evaluateRuntimeGate(
  config: Pick<RuntimeConfig, "features">,
  request: RuntimeRequestDescriptor,
): RuntimeGateDecision {
  const pathname = request.pathname || "/";
  if (isRuntimeOperationalPath(pathname) || isPublicInformationPath(pathname)) return { allowed: true };

  if (!config.features.residentWeb && isResidentSurface(pathname)) {
    return {
      allowed: false,
      status: 503,
      code: "resident_web_paused",
      message: "The resident service is temporarily unavailable. County staff operations remain available.",
    };
  }

  if (config.features.pauseAll && isResidentSurface(pathname)) {
    return {
      allowed: false,
      status: 503,
      code: "platform_paused",
      message: "Civya resident actions are temporarily paused. Your existing saved progress has not changed.",
    };
  }

  if (!config.features.browserVoice && isBrowserVoicePath(pathname)) {
    return {
      allowed: false,
      status: 503,
      code: "browser_voice_disabled",
      message: "Browser voice is unavailable. Continue with text or contact a County staff member.",
    };
  }

  // This explicit branch documents that the all-platform breaker covers model
  // calls even if a new read-style AI endpoint is introduced later.
  if (config.features.pauseAll && isAiPath(pathname)) {
    return {
      allowed: false,
      status: 503,
      code: "platform_paused",
      message: "Civya resident actions are temporarily paused. Your existing saved progress has not changed.",
    };
  }

  return { allowed: true };
}
