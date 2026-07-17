#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const migrations = fs.readdirSync(path.join(ROOT, "supabase/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const sql = migrations.map((name) => read(`supabase/migrations/${name}`)).join("\n");
const boundaryMigration = migrations.map((name) => ({ name, source: read(`supabase/migrations/${name}`) }))
  .reverse()
  .find((item) => item.source.includes("civya_service_bootstrap_session"));
const outcomeMigration = migrations.map((name) => ({ name, source: read(`supabase/migrations/${name}`) }))
  .reverse()
  .find((item) => item.source.includes("civya_service_reconcile_outcome"));

let failures = 0;
function check(name, condition) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}

console.log("County-ready security and continuity safeguards");

const tables = [
  "tenants", "residents", "cases", "case_facts", "conversations", "turns",
  "documents", "checklist_items", "consent", "review_tasks", "reminders",
  "audit_events", "staff_roles", "demo_invitations", "simulated_transactions",
];
for (const table of tables) {
  check(
    `${table} is normalized and protected by RLS`,
    sql.includes(`create table if not exists public.${table}`) &&
      sql.includes(`alter table public.${table} enable row level security`),
  );
}

check(
  "turns use durable idempotency constraints",
  sql.includes("unique (conversation_id, idempotency_key)") &&
    sql.includes("unique (conversation_id, client_turn_id, speaker)"),
);
check(
  "the turn transaction locks rows, replays commits, and rejects stale versions",
  /civya_commit_turn_result[\s\S]*for update/.test(sql) &&
    sql.includes("processing_status = 'committed'") &&
    sql.includes("stale case version"),
);
check(
  "raw audio has no persistence field",
  sql.includes("Redacted text only. Civya never stores raw audio.") &&
    !/\braw_audio\b|\baudio_blob\b|\baudio_url\b/i.test(sql),
);
check(
  "workflow RPCs are server-only",
  Boolean(boundaryMigration) &&
    [
      "civya_bootstrap_session(text, text)",
      "civya_append_turn(uuid, text, text, text, text, text, text)",
      "civya_commit_turn_result(uuid, bigint, text, text, text, text, text, jsonb, jsonb)",
      "civya_finish_conversation(uuid, text)",
    ].every((signature) => boundaryMigration.source.includes(`revoke all on function public.${signature} from public, anon, authenticated`)) &&
    boundaryMigration.source.includes("grant execute on function public.civya_service_bootstrap_session"),
);
check(
  "resident interactions cannot mutate authoritative outcome state",
  Boolean(outcomeMigration) &&
    outcomeMigration.source.includes("ordinary turns from writing cases.completion_state") &&
    (() => {
      const start = outcomeMigration.source.indexOf("update public.cases set");
      const end = outcomeMigration.source.indexOf("where id = v_case.id", start);
      const caseUpdate = outcomeMigration.source.slice(start, end);
      return start >= 0 && end > start && !caseUpdate.includes("completion_state");
    })(),
);
check(
  "authoritative outcome history is append-only and service-controlled",
  Boolean(outcomeMigration) &&
    [
      "authoritative_source_systems",
      "authoritative_source_batches",
      "authoritative_source_records",
      "outcome_definition_versions",
      "case_source_match_decisions",
      "outcome_reconciliation_runs",
      "outcome_verification_events",
      "case_outcome_projections",
    ].every((table) => outcomeMigration.source.includes(`create table public.${table}`)) &&
    outcomeMigration.source.includes("authoritative outcome history is append-only") &&
    outcomeMigration.source.includes("perform private.civya_service_required()") &&
    outcomeMigration.source.includes("from public, anon, authenticated") &&
    outcomeMigration.source.includes("revoke insert, update, delete on public.case_outcome_projections from service_role"),
);
check(
  "synthetic reconciliation computes integrity hashes and requires explicit reversal evidence",
  Boolean(outcomeMigration) &&
    outcomeMigration.source.includes("'stale_source_record'") &&
    outcomeMigration.source.includes("'conflicting_current_matches'") &&
    outcomeMigration.source.includes("'explicit_reversal_criteria_satisfied'") &&
    outcomeMigration.source.includes("sha256(convert_to(p_payload::text") &&
    outcomeMigration.source.includes("evidence_scope text not null check (evidence_scope = 'synthetic')"),
);
check(
  "synthetic outcome retention uses a narrow transaction-local purge boundary",
  Boolean(outcomeMigration) &&
    outcomeMigration.source.includes("civya.authorized_outcome_purge") &&
    outcomeMigration.source.includes("synthetic_retention") &&
    outcomeMigration.source.includes("civya_prepare_retention_cleanup_pre_outcome_kernel"),
);
check(
  "resident direct document and Storage writes are blocked by staff-only policies",
  Boolean(boundaryMigration) &&
    boundaryMigration.source.includes("drop policy if exists documents_verified_resident_insert") &&
    boundaryMigration.source.includes("drop policy if exists consent_owner_insert") &&
    boundaryMigration.source.includes("create policy consent_staff_insert") &&
    boundaryMigration.source.includes("drop policy if exists civya_storage_verified_insert") &&
    boundaryMigration.source.includes("create policy civya_storage_staff_insert") &&
    !boundaryMigration.source.includes("create policy documents_verified_resident_insert") &&
    !boundaryMigration.source.includes("create policy civya_storage_verified_insert"),
);
check(
  "direct Storage reads enforce clean scans for residents and review access for staff",
  Boolean(boundaryMigration) &&
    boundaryMigration.source.includes("civya_can_read_storage_object") &&
    boundaryMigration.source.includes("d.scan_status = 'clean'") &&
    boundaryMigration.source.includes("private.civya_actor_is_staff") &&
    boundaryMigration.source.includes("drop policy if exists civya_storage_member_read") &&
    boundaryMigration.source.includes("create policy civya_storage_clean_or_staff_read"),
);

const activeResidentRoutes = [
  "app/api/conversations/turn/route.ts",
  "app/api/tools/case-mgmt/route.ts",
  "app/api/tools/property-status/route.ts",
  "app/api/uploads/route.ts",
  "app/api/tools/log/route.ts",
];
check(
  "active resident routes never import the legacy JSON case store",
  activeResidentRoutes.every((file) => !read(file).includes("@/lib/cases/")),
);
check(
  "hosted metrics never use local or /tmp files",
  !read("app/api/tools/log/route.ts").includes("lib/logging/events") &&
    !fs.existsSync(path.join(ROOT, "lib/logging/events.ts")) &&
    read("app/api/tools/log/route.ts").includes("appendAuditEvent"),
);

const guard = read("lib/security/guards.ts");
check(
  "resident saved actions exclude staff roles and require verification",
  guard.includes('platform.principal.role !== "resident"') &&
    guard.includes("!platform.principal.isVerified"),
);
check(
  "staff queries are explicitly tenant-scoped",
  ["app/api/admin/cases/route.ts", "app/api/admin/review/route.ts", "app/api/staff/bootstrap/route.ts"]
    .every((file) => read(file).includes('.eq("tenant_id"')),
);
check(
  "sandbox invitation cookies are tenant-bound and cannot become a production boundary",
  read("middleware.ts").includes("claims.tenant === expectedTenant") &&
    read("middleware.ts").includes('environment === "production" && accessSetting === "true"') &&
    read("middleware.ts").includes('environment !== "production" && accessSetting === "true"') &&
    read("app/api/invitations/exchange/route.ts").includes("grant.tenantSlug !== expectedTenant"),
);
check(
  "signed invitations are also bound to the Supabase identity and expiry",
  boundaryMigration?.source.includes("private.tenant_access_grants") &&
    boundaryMigration.source.includes("civya_service_grant_tenant_access") &&
    boundaryMigration.source.includes("use_count > 0") &&
    read("lib/security/demo-access.ts").includes("grantDemoAccessFromRequest") &&
    read("app/api/auth/anonymous/route.ts").includes("grantDemoAccessFromRequest") &&
    read("app/api/bootstrap/route.ts").includes("grantDemoAccessFromRequest"),
);
const adminInvitationRoute = read("app/api/admin/invitations/route.ts");
check(
  "resident demo invitations are admin-only, tenant-derived, bounded, and shown once",
  adminInvitationRoute.includes('requireStaff("admin", req.headers.get("host"))') &&
    adminInvitationRoute.includes("const { platform, staff }") &&
    adminInvitationRoute.includes("tenantId: staff.tenant.id") &&
    !adminInvitationRoute.includes("tenantId: body") &&
    adminInvitationRoute.includes('staff.tenant.environment !== "sandbox"') &&
    adminInvitationRoute.includes("!staff.tenant.fictional") &&
    adminInvitationRoute.includes("MAX_EXPIRY_MINUTES") &&
    adminInvitationRoute.includes("MAX_INVITATION_USES") &&
    adminInvitationRoute.includes('scopes: [RESIDENT_SCOPE]') &&
    adminInvitationRoute.includes('invite_path: `/invite/${encodeURIComponent(invitation.token)}`') &&
    read("app/admin/page.tsx").includes("Invitation created. Copy the private link now.") &&
    read("app/admin/page.tsx").includes("It does not authorize real county services."),
);
check(
  "anonymous Auth delegates CAPTCHA validation to Supabase",
  read("app/api/auth/anonymous/route.ts").includes("captchaToken: turnstileToken") &&
    read("app/api/auth/anonymous/route.ts").includes("CIVYA_SUPABASE_CAPTCHA_ENFORCED"),
);
check(
  "general anonymous questions do not trigger a surprise account wall",
  read("app/api/conversations/turn/route.ts").includes("Anonymous residents can ask general questions indefinitely") &&
    !/decision\.kind === "general_answer"[\s\S]{0,120}nextFactKey/.test(read("app/api/conversations/turn/route.ts")),
);
check(
  "existing-account conflicts pause for explicit case selection",
  read("app/page.tsx").includes("case_selection_required") &&
    read("app/page.tsx").includes("Which saved case should we open?") &&
    read("app/page.tsx").includes("/api/cases/activate"),
);
check(
  "case activation is verified, versioned, and never merges cases",
  read("app/api/cases/activate/route.ts").includes("requireVerifiedResident") &&
    read("app/api/cases/activate/route.ts").includes("snapshot.rowVersion") &&
    read("app/api/cases/activate/route.ts").includes("cases_merged: false") &&
    boundaryMigration?.source.includes("civya_service_activate_case"),
);
check(
  "uploads validate signatures, deduplicate, and quarantine uncertain files",
  read("lib/documents/upload-client.ts").includes("validateDocumentContent") &&
    read("app/api/uploads/finalize/route.ts").includes("verifyDocumentUploadGrant") &&
    read("app/api/uploads/finalize/route.ts").includes("idempotent_replay") &&
    read("app/api/uploads/finalize/route.ts").includes('scanStatus: "pending"') &&
    read("app/api/documents/[documentId]/download/route.ts").includes("document_quarantined"),
);
check(
  "upload retries reuse one deterministic object and service-only cleanup",
  read("lib/documents/upload-client.ts").includes("upsert: false") &&
    read("app/api/uploads/finalize/route.ts").includes("removeUnrecordedDocumentUpload") &&
    read("lib/platform/repository.ts").includes("function documentStoragePath") &&
    read("lib/platform/repository.ts").includes("this.service().storage"),
);
check(
  "staff email-code sign-in cannot create accounts or bypass tenant roles",
  read("app/api/staff/auth/start/route.ts").includes("shouldCreateUser: false") &&
    read("app/api/staff/auth/verify/route.ts").includes("staffBootstrap") &&
    read("app/api/staff/auth/verify/route.ts").includes("denyAndSignOut") &&
    read("app/staff/sign-in/page.tsx").includes("fictional cases"),
);
check(
  "30-day cleanup is wired to an authenticated daily worker",
  read("vercel.json").includes("/api/admin/retention/run") &&
    read("app/api/admin/retention/run/route.ts").includes("CRON_SECRET") &&
    read("app/api/admin/retention/run/route.ts").includes("pruneExpiredDemoData"),
);
check(
  "case URLs rely on the authenticated session, not bearer query tokens",
  !read("app/page.tsx").includes("?t=") &&
    !read("app/case/[caseId]/page.tsx").includes("searchParams"),
);
check(
  "controlled launch stays visibly non-authoritative and activation-gated",
  read("README.md").includes("Code completeness does not activate County data") &&
    read("app/trust/page.tsx").includes("Signing in does not open Wayne County records") &&
    read("app/page.tsx").includes("not the Wayne County Treasurer") &&
    read("docs/county-demo-release-gates.md").includes("do not describe Civya as ready for real residents"),
);

console.log(
  failures === 0
    ? "\nALL COUNTY-READINESS STATIC CHECKS PASSED"
    : `\n${failures} COUNTY-READINESS STATIC CHECKS FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
