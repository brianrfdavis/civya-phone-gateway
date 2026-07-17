import type { EligibilityResult, ResidentProfile } from "@/lib/types";

/**
 * Deterministic path routing from a resident profile. This is intentionally
 * NOT a model call: program routing must be explainable and auditable.
 * These rules encode the demo logic only — real deployments load
 * county-verified rule sets.
 */
export function evaluateEligibility(
  profile: ResidentProfile,
): EligibilityResult {
  const reasons: string[] = [];
  const t = profile.tax_status;

  // Title complications route to legal aid before any tax program.
  if (
    profile.ownership_status === "heir" ||
    profile.eligibility_indicators.includes("title_not_transferred")
  ) {
    return {
      profile_id: profile.profile_id,
      likely_path: "legal_aid_referral",
      path_label: "Legal aid referral (title/probate)",
      reasons: [
        "Occupant is an heir; title has not been transferred",
        "Tax-relief programs require ownership in the applicant's name",
      ],
      next_step: profile.recommended_next_step,
      urgency: t.foreclosure_risk === "imminent" ? "urgent" : "elevated",
      needs_human_followup: true,
      needs_legal_referral: true,
    };
  }

  // Nothing owed → guidance only.
  if (!t.current_year_delinquent && !t.prior_year_delinquent) {
    return {
      profile_id: profile.profile_id,
      likely_path: "payment_guidance",
      path_label: "Payment and balance guidance",
      reasons: ["No delinquent taxes on record"],
      next_step: profile.recommended_next_step,
      urgency: "normal",
      needs_human_followup: false,
      needs_legal_referral: false,
    };
  }

  const isDetroit = profile.city.toLowerCase() === "detroit";
  const ownerOccupant =
    profile.ownership_status === "owner" && profile.primary_residence;
  const incomeLikely = profile.eligibility_indicators.includes(
    "income_likely_below_hope_threshold",
  );
  const hopePending = profile.programs_applied.some((p) =>
    p.toLowerCase().includes("hope"),
  );
  const urgent = t.foreclosure_risk === "imminent";

  if (ownerOccupant && isDetroit && (incomeLikely || hopePending)) {
    reasons.push("Owner-occupant of a Detroit property");
    if (hopePending) reasons.push("HOPE application already pending");
    if (incomeLikely) reasons.push("Household income likely within HOPE guidelines");
    if (urgent) reasons.push(`Foreclosure deadline near: ${t.foreclosure_deadline}`);
    return {
      profile_id: profile.profile_id,
      likely_path: "hope_pays",
      path_label: "HOPE exemption → PAYS enrollment",
      reasons,
      next_step: profile.recommended_next_step,
      urgency: urgent ? "urgent" : "elevated",
      needs_human_followup: urgent,
      needs_legal_referral: false,
    };
  }

  if (ownerOccupant) {
    reasons.push("Owner-occupant with delinquent balance");
    reasons.push("Payment plan spreads the balance with reduced interest");
    return {
      profile_id: profile.profile_id,
      likely_path: "payment_plan",
      path_label: "Wayne County Treasurer payment plan (IRSPA)",
      reasons,
      next_step: profile.recommended_next_step,
      urgency: urgent ? "urgent" : "normal",
      needs_human_followup: urgent,
      needs_legal_referral: false,
    };
  }

  return {
    profile_id: profile.profile_id,
    likely_path: "specialist_review",
    path_label: "Specialist review",
    reasons: ["Situation does not fit a standard path"],
    next_step: "A resident-support specialist should review this case.",
    urgency: urgent ? "urgent" : "elevated",
    needs_human_followup: true,
    needs_legal_referral: false,
  };
}

/** Document checklist derived from a profile's likely path + current status. */
export function documentChecklist(profile: ResidentProfile): {
  required: string[];
  already_received: string[];
  still_needed: string[];
} {
  const base = ["photo_id", "proof_of_residency", "proof_of_income", "tax_notice"];
  const heirExtras = ["death_certificate", "deed"];
  const required =
    profile.ownership_status === "heir" ? [...base, ...heirExtras] : base;

  const already_received: string[] = [];
  const still_needed: string[] = [];
  for (const doc of required) {
    const status = profile.document_status[doc];
    if (status === "received") already_received.push(doc);
    else if (status === "not_needed") continue;
    else still_needed.push(doc);
  }
  return { required, already_received, still_needed };
}
