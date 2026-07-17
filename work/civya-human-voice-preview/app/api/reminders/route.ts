import { NextRequest, NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config/runtime";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { createAdminPlatform } from "@/lib/platform";
import { requireVerifiedResident } from "@/lib/security/guards";
import {
  readJsonObject,
  RequestError,
  requestErrorResponse,
  rateLimitRequest,
} from "@/lib/security/request";
import {
  REMINDER_CONSENT_POLICY_VERSION,
  REMINDER_TEMPLATE_KEY,
  REMINDER_TEMPLATE_VERSION,
} from "@/lib/reminders/contracts";
import { ReminderRepository, ReminderStoreError } from "@/lib/reminders/repository.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY = /^[A-Za-z0-9_.:-]{8,160}$/;
const ALLOWED_KEYS = new Set([
  "case_id",
  "scheduled_for",
  "timezone",
  "idempotency_key",
  "consent_policy_version",
  "confirm_sms",
  "confirm_reminder",
]);

export async function GET(request: NextRequest) {
  try {
    const platform = await requireVerifiedResident();
    const caseId = request.nextUrl.searchParams.get("case_id") ?? "";
    if (!UUID.test(caseId)) throw new RequestError(400, "Choose a valid County case.");
    const grant = await requireCaseEntitlement(request, platform, caseId);
    const tenant = await tenantForCase(platform, caseId);
    if (tenant.production) {
      if (!grant.entitlementId) throw new RequestError(403, "Case entitlement required.", "entitlement_required");
      const reminders = await new ReminderRepository(createAdminPlatform().client)
        .list(platform.principal.userId, caseId, grant.entitlementId);
      return NextResponse.json(
        { reminders, simulated: false, delivery_authority: "provider_receipt_required" },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    await platform.assertSyntheticSandboxCase(caseId);
    const { data, error } = await platform.client.from("reminders")
      .select("id,delivery_id,status,scheduled_for,channel,accepted_at,delivered_at")
      .eq("case_id", caseId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({
      reminders: (data ?? []).map((row) => ({
        reminderId: row.id,
        deliveryId: row.delivery_id,
        status: row.status,
        scheduledFor: row.scheduled_for,
        channel: row.channel,
        acceptedAt: row.accepted_at,
        deliveredAt: row.delivered_at,
        canCancel: row.status === "scheduled" || row.status === "queued",
      })),
      simulated: true,
      external_delivery: false,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return reminderErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const limited = rateLimitRequest(request, "reminder_schedule", 8, 60_000);
  if (limited) return limited;
  try {
    const platform = await requireVerifiedResident();
    const body = await readJsonObject(request, 4_000);
    for (const key of Object.keys(body)) {
      if (!ALLOWED_KEYS.has(key)) throw new RequestError(400, `Unsupported reminder field: ${key}.`);
    }
    const caseId = typeof body.case_id === "string" ? body.case_id : "";
    if (!UUID.test(caseId)) throw new RequestError(400, "Choose a valid County case.");
    const grant = await requireCaseEntitlement(request, platform, caseId);
    const tenant = await tenantForCase(platform, caseId);
    const timezone = typeof body.timezone === "string" ? body.timezone : "America/Detroit";
    if (timezone !== "America/Detroit") {
      throw new RequestError(400, "Wayne County reminders currently use Eastern Time.", "timezone_invalid");
    }
    const scheduledFor = typeof body.scheduled_for === "string"
      ? body.scheduled_for
      : nextDetroitReminderAtTen();
    assertSchedule(scheduledFor, timezone);
    const idempotencyKey = String(
      request.headers.get("idempotency-key") || body.idempotency_key || "",
    );
    if (!IDEMPOTENCY.test(idempotencyKey)) {
      throw new RequestError(400, "A valid reminder request key is required.", "idempotency_key_invalid");
    }
    if (
      body.consent_policy_version !== REMINDER_CONSENT_POLICY_VERSION
      || body.confirm_sms !== true
      || body.confirm_reminder !== true
    ) {
      throw new RequestError(
        409,
        "Confirm both SMS delivery and this reminder before scheduling it.",
        "reminder_consent_required",
      );
    }

    if (tenant.production) {
      const config = getRuntimeConfig();
      const messaging = config.providerReadiness.providers.messaging;
      if (!config.features.messages || config.providers.messaging !== "live" || !messaging.ready) {
        throw new RequestError(
          503,
          "Text reminders are not activated for this County launch.",
          "messaging_not_activation_ready",
        );
      }
      if (!grant.entitlementId) throw new RequestError(403, "Case entitlement required.", "entitlement_required");
      const result = await new ReminderRepository(createAdminPlatform().client).schedule({
        actorUserId: platform.principal.userId,
        caseId,
        entitlementId: grant.entitlementId,
        scheduledFor,
        timezone,
        templateKey: REMINDER_TEMPLATE_KEY,
        templateVersion: REMINDER_TEMPLATE_VERSION,
        consentPolicyVersion: REMINDER_CONSENT_POLICY_VERSION,
        confirmChannelConsent: true,
        confirmReminderConsent: true,
        idempotencyKey,
      });
      return NextResponse.json(
        {
          ...result,
          simulated: false,
          message: "Reminder scheduled. Delivery is confirmed only after Twilio reports delivered.",
        },
        { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    await platform.assertSyntheticSandboxCase(caseId);
    const snapshot = await platform.loadCaseSnapshot(caseId);
    const admin = createAdminPlatform().client;
    const { data: existing, error: existingError } = await admin.from("reminders")
      .select("id,status,scheduled_for")
      .eq("tenant_id", snapshot.tenantId)
      .eq("case_id", caseId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      return NextResponse.json({
        reminderId: existing.id,
        status: existing.status,
        scheduledFor: existing.scheduled_for,
        duplicate: true,
        simulated: true,
        external_delivery: false,
        message: "Simulated reminder already scheduled. No text will be sent.",
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const consentBase = idempotencyKey.slice(0, 170);
    const { data: smsConsent, error: smsError } = await admin.from("consent").insert({
      tenant_id: snapshot.tenantId,
      resident_id: snapshot.residentId,
      case_id: caseId,
      consent_type: "sms",
      consent_text: `${REMINDER_CONSENT_POLICY_VERSION}: fictional sandbox SMS consent`,
      granted: true,
      source: "resident",
      idempotency_key: `${consentBase}:sms`,
    }).select("id").single();
    if (smsError) throw smsError;
    const { data: reminderConsent, error: reminderError } = await admin.from("consent").insert({
      tenant_id: snapshot.tenantId,
      resident_id: snapshot.residentId,
      case_id: caseId,
      consent_type: "reminder",
      consent_text: `${REMINDER_CONSENT_POLICY_VERSION}: fictional sandbox reminder consent`,
      granted: true,
      source: "resident",
      idempotency_key: `${consentBase}:reminder`,
    }).select("id").single();
    if (reminderError) throw reminderError;
    const { data: reminder, error } = await admin.from("reminders").insert({
      tenant_id: snapshot.tenantId,
      resident_id: snapshot.residentId,
      case_id: caseId,
      consent_id: reminderConsent.id,
      channel_consent_id: smsConsent.id,
      channel: "sms",
      scheduled_for: scheduledFor,
      message_type: "fictional_secure_account_reminder",
      redacted_message: "Fictional Civya sandbox reminder; no message is delivered.",
      status: "scheduled",
      idempotency_key: idempotencyKey,
      quiet_hours_timezone: timezone,
      quiet_hours_policy_version: "civya-quiet-hours-0800-2100-v1",
      quiet_hours_checked_at: new Date().toISOString(),
    }).select("id,status,scheduled_for").single();
    if (error) throw error;
    return NextResponse.json({
      reminderId: reminder.id,
      status: reminder.status,
      scheduledFor: reminder.scheduled_for,
      duplicate: false,
      simulated: true,
      external_delivery: false,
      message: "Simulated reminder scheduled. No text will be sent.",
    }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return reminderErrorResponse(error);
  }
}

async function tenantForCase(
  platform: Awaited<ReturnType<typeof requireVerifiedResident>>,
  caseId: string,
): Promise<{ tenantId: string; production: boolean }> {
  const { data: row, error } = await platform.client.from("cases")
    .select("tenant_id,tenants!inner(environment,fictional,status)")
    .eq("id", caseId)
    .single();
  if (error || !row) throw new RequestError(404, "Case not found.", "case_not_found");
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  if (!tenant || tenant.status !== "active") throw new RequestError(403, "This County service is unavailable.", "forbidden");
  return {
    tenantId: String(row.tenant_id),
    production: tenant.environment === "production" && tenant.fictional === false,
  };
}

function assertSchedule(value: string, timezone: string): void {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < Date.now() + 5 * 60_000 || time > Date.now() + 90 * 86_400_000) {
    throw new RequestError(400, "Choose a reminder between five minutes and 90 days from now.", "schedule_invalid");
  }
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(time)).find((part) => part.type === "hour")?.value);
  if (!Number.isInteger(hour) || hour < 8 || hour >= 21) {
    throw new RequestError(400, "Choose a reminder between 8:00 AM and 9:00 PM Eastern Time.", "quiet_hours");
  }
}

function nextDetroitReminderAtTen(): string {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Detroit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 10));
  const zoneParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Detroit",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(tomorrow).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const represented = Date.UTC(
    zoneParts.year, zoneParts.month - 1, zoneParts.day,
    zoneParts.hour, zoneParts.minute, zoneParts.second,
  );
  return new Date(tomorrow.getTime() - (represented - tomorrow.getTime())).toISOString();
}

function reminderErrorResponse(error: unknown): NextResponse {
  if (error instanceof ReminderStoreError) {
    const status = error.code === "42501" ? 403
      : error.code === "P0002" ? 404
        : error.code === "22023" ? 400
          : error.code === "23505" || error.code === "55000" ? 409 : 503;
    return NextResponse.json({
      error: status === 503
        ? "Civya couldn't save that reminder safely. No message was sent."
        : "The reminder request no longer matches the active case access or consent.",
      code: error.code,
    }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
  return requestErrorResponse(error);
}
