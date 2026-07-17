import { NextResponse } from "next/server";
import { listWorkflowDefinitions } from "@/lib/workflows/definitions";
import { workflowImplementationStatus } from "@/lib/workflows/repository.server";

export const dynamic = "force-dynamic";

export async function GET() {
  const workflows = listWorkflowDefinitions().map((definition) => ({
    key: definition.key,
    version: definition.version,
    display_name: definition.displayName,
    initial_action: definition.nextActions[definition.initialState],
    completion_authority: definition.completionAuthority,
    implementation_status: workflowImplementationStatus(definition.key),
    persisted_resident_api: definition.key === "payment_plan_navigation",
  }));
  return NextResponse.json(
    {
      workflows,
      authority: "deterministic_server",
      count: workflows.length,
      verified_persisted_slices: ["payment_plan_navigation"],
      activation_note: "Definitions describe the approved state machines; only verified_persisted_slice is exposed as a durable resident workflow API.",
    },
    { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } },
  );
}
