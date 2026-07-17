import { NextRequest, NextResponse } from "next/server";
import { DisabledClearIdentityAdapter } from "@/lib/identity/providers";
import type { IdentityProofingRequest, ProofingAction } from "@/lib/identity/providers";

export const runtime = "nodejs";

const ACTIONS = new Set<ProofingAction>([
  "save_nonsensitive_draft",
  "view_sensitive_case",
  "document_access",
  "change_contact",
  "external_handoff",
  "delegate_access",
  "assisted_recovery",
]);
const ALLOWED_KEYS = new Set(["action", "case_reference", "consent_reference", "locale", "policy_version", "proofing_reference"]);

export async function GET() {
  return NextResponse.json(
    {
      providers: [{ provider: "clear", enabled: false, reason: "pending_county_approval" }],
      assisted_alternatives_required: true,
      raw_evidence_stored: false,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) throw new Error(`Unsupported proofing field: ${key}.`);
    const action = String(body.action ?? "") as ProofingAction;
    if (!ACTIONS.has(action)) throw new Error("Unsupported proofing action.");
    const proofingRequest: IdentityProofingRequest = {
      proofingReference: String(body.proofing_reference ?? ""),
      caseReference: String(body.case_reference ?? ""),
      action,
      policyVersion: String(body.policy_version ?? ""),
      consentReference: String(body.consent_reference ?? ""),
      sessionBinding: request.headers.get("x-civya-session-binding") ?? "",
      locale: String(body.locale ?? "en-US"),
    };
    const result = await new DisabledClearIdentityAdapter().start(proofingRequest);
    return NextResponse.json(
      { result, error: "CLEAR proofing is not enabled. Use an approved assisted or non-PSTN path." },
      { status: 409, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid proofing request." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
