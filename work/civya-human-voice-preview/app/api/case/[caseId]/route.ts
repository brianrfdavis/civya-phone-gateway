import { NextRequest, NextResponse } from "next/server";
import { createRequestPlatform, loadCaseSnapshot } from "@/lib/platform";
import { requireCaseEntitlement } from "@/lib/entitlement/guard";
import { RequestError, requestErrorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACT_LABELS: Record<string, string> = {
  property_address: "Property address",
  resident_name: "Name",
  contact: "Contact",
  owner_occupancy: "Living in the home",
  municipality: "City or township",
  notice_type: "Tax notice",
  delinquency_years: "Unpaid tax years",
  hardship: "Hardship",
  income_range: "Income range",
  household_size: "Household size",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const platform = await createRequestPlatform();
    if (!platform) return NextResponse.json({ error: "A private session is required." }, { status: 401 });
    const { caseId } = await params;
    await requireCaseEntitlement(req, platform, caseId);
    const snapshot = await loadCaseSnapshot(platform, caseId);
    const facts = Object.fromEntries(snapshot.confirmedFacts.map((fact) => [fact.key, fact.value]));
    const [residentResult, documentResult, tenantResult] = await Promise.all([
      platform.client.from("residents").select("id,first_name,last_name").eq("id", snapshot.residentId).single(),
      platform.client
        .from("documents")
        .select("id,original_file_name,document_type,review_required")
        .eq("case_id", caseId)
        .order("created_at"),
      platform.client
        .from("tenants")
        .select("name,environment,fictional,status")
        .eq("id", snapshot.tenantId)
        .single(),
    ]);
    if (residentResult.error) throw residentResult.error;
    if (documentResult.error) throw documentResult.error;
    if (tenantResult.error) throw tenantResult.error;
    const fictional = tenantResult.data.fictional === true;
    if (!fictional && [
      snapshot.status,
      snapshot.nextQuestion,
      snapshot.nextBestAction,
      ...snapshot.checklist.flatMap((item) => [item.label, item.description, item.status]),
    ].some((value) => /fictional|demo|simulat/i.test(String(value || "")))) {
      throw new RequestError(
        503,
        "The case view is temporarily unavailable while its County configuration is reviewed.",
        "case_configuration_invalid",
      );
    }
    const authorityNotice = fictional
      ? "Demonstration only — fictional data. Not an official government service."
      : "Controlled launch — confirm official status and completed actions in the County system.";
    const checklist = snapshot.checklist.map((item) => ({
      id: String(item.id),
      label: String(item.label || item.document_type || "Document"),
      description: String(item.description || ""),
      status: String(item.status || "missing"),
    }));
    const missing = checklist.filter((item) => item.status === "missing" || item.status === "needs_review");
    const expectedKeys = Object.keys(FACT_LABELS);

    return NextResponse.json(
      {
        case: {
          id: snapshot.id,
          status: snapshot.status,
          propertyAddress: facts.property_address,
          municipality: facts.municipality,
          urgencyLevel: "normal",
          nextBestAction: snapshot.nextQuestion || snapshot.nextBestAction,
          reviewRequired: checklist.some((item) => item.status === "needs_review"),
          missingDocuments: missing.map((item) => item.label),
          likelyPathways: [],
          intakeFacts: facts,
          createdAt: snapshot.updatedAt,
        },
        resident: {
          id: residentResult.data.id,
          firstName: residentResult.data.first_name || "",
          lastName: residentResult.data.last_name || "",
        },
        pathwayLabel: fictional
          ? "Fictional guided county review"
          : `${tenantResult.data.name} guided review`,
        requiresPayment: false,
        intake: {
          total: expectedKeys.length,
          collected: expectedKeys.filter((key) => facts[key]).length,
          missing: expectedKeys.filter((key) => !facts[key]).map((key) => ({ key, label: FACT_LABELS[key] })),
        },
        checklist,
        checklistSummary: missing.length
          ? `Still needed or awaiting review: ${missing.map((item) => item.label).join(", ")}.`
          : "No documents are currently listed as missing.",
        documents: (documentResult.data || []).map((document) => ({
          id: document.id,
          fileName: document.original_file_name,
          documentType: document.document_type,
          reviewRequired: document.review_required,
        })),
        authorityNotice,
        sandbox: {
          fictional,
          environment: tenantResult.data.environment,
          official_transaction: false,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return requestErrorResponse(error);
  }
}
