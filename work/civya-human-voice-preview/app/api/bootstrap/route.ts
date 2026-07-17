import { NextRequest, NextResponse } from "next/server";
import { unauthenticatedBootstrap, withAuthenticationState } from "@/lib/conversation/bootstrap";
import { authRequiredPayload } from "@/lib/conversation/policy";
import { maskEmail } from "@/lib/conversation/privacy";
import {
  hasCaseEntitlementSession,
  requireCaseEntitlement,
  requireCaseEntitlementSession,
} from "@/lib/entitlement/guard";
import { getRuntimeConfig } from "@/lib/config/runtime";
import {
  bootstrapEntitledProductionCase,
  bootstrapSession,
  createRequestPlatform,
  isSupabaseConfigured,
} from "@/lib/platform";
import { grantDemoAccessFromRequest } from "@/lib/security/demo-access";
import { requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function emptyBootstrap(syntheticMode: boolean) {
  return syntheticMode
    ? unauthenticatedBootstrap()
    : unauthenticatedBootstrap({ fictional: false });
}

export async function GET(req: NextRequest) {
  try {
    const runtimeConfig = getRuntimeConfig();
    if (!isSupabaseConfigured()) {
      const result = emptyBootstrap(runtimeConfig.syntheticMode);
      result.persistence = {
        state: "unavailable",
        message: "Durable memory is not configured. Civya is available only after Supabase is connected.",
      };
      result.capabilities.voice = false;
      return NextResponse.json(result, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    const platform = await createRequestPlatform();
    if (!platform) return NextResponse.json(emptyBootstrap(runtimeConfig.syntheticMode), { headers: { "Cache-Control": "no-store" } });
    const protectedResident = platform.principal.role === "resident" && platform.principal.isVerified;
    const productionCaseRuntime = runtimeConfig.environment === "production" || !runtimeConfig.syntheticMode;
    if (
      protectedResident
      && !(await hasCaseEntitlementSession(req, platform))
    ) {
      const result = emptyBootstrap(runtimeConfig.syntheticMode);
      result.auth = {
        state: "verified",
        masked_email: platform.principal.email ? maskEmail(platform.principal.email) : undefined,
      };
      result.persistence = { state: "saved" };
      result.capabilities.voice = false;
      result.capabilities.uploads = false;
      result.capabilities.reminders = false;
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (productionCaseRuntime && !protectedResident) {
      const result = withAuthenticationState(emptyBootstrap(false), "anonymous");
      result.persistence = { state: "saved" };
      result.capabilities.voice = false;
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    }
    let result;
    if (productionCaseRuntime) {
      const grant = await requireCaseEntitlementSession(req, platform);
      if (grant.accessType !== "case_entitlement" || !grant.entitlementId) {
        throw new Error("A production case entitlement is required.");
      }
      result = await bootstrapEntitledProductionCase(
        platform,
        grant.caseId,
        grant.entitlementId,
        "voice",
      );
    } else {
      await grantDemoAccessFromRequest(req, platform);
      result = await bootstrapSession(platform);
    }
    if (protectedResident) {
      await requireCaseEntitlement(req, platform, result.active_case?.id || "");
    }
    const { data } = await platform.client.auth.getUser();
    if (!platform.principal.isVerified && data.user?.user_metadata?.civya_intake_declined_at) {
      result = withAuthenticationState(result, "declined");
    }
    if (
      result.auth.state === "anonymous"
      && result.resume_context.current_workflow_state === "awaiting_verification"
    ) {
      const pendingTurn = [...result.resume_context.recent_turns].reverse().find((turn) => turn.role === "user");
      const payload = authRequiredPayload({
        pendingTurnId: pendingTurn?.id || `pending:${result.conversation?.id || "conversation"}`,
        pendingQuestion: result.resume_context.next_question || result.next_action.question,
      });
      result.auth_required = payload;
      result.next_action = { kind: "auth_required", question: payload.pending_question };
    }
    result.capabilities.voice = runtimeConfig.features.browserVoice && Boolean(process.env.OPENAI_API_KEY);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
