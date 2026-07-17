/**
 * Deterministic routing for the Wayne County demo. The LLM never decides
 * eligibility routing — it feeds facts in and narrates the result.
 * Outcomes are ordered by priority; multiple outcomes can apply
 * (e.g. urgent redemption + HOPE screening + document collection).
 */

export type ForeclosureStage =
  | "current"
  | "delinquent"
  | "forfeited"
  | "show_cause"
  | "foreclosure_judgment_pending"
  | "redeemable_before_march_31"
  | "foreclosed_after_april_1"
  | "auctioned"
  | "unknown";

export interface RoutingInput {
  municipality?: string;
  relationship?: "owner" | "occupant" | "heir" | "renter" | "family_member" | "former_owner" | "unknown";
  ownerOccupied?: boolean;
  preOnFile?: "yes" | "no" | "unknown";
  delinquentYears?: number[];
  foreclosureStage?: ForeclosureStage;
  noticesReceived?: string[]; // e.g. yellow_bag, show_cause, court, auction, surplus_proceeds
  householdSignals?: string[]; // low_income, senior, disabled, veteran, first_responder, unemployed, widowed, medical_burden, hardship
  appliedHopeBefore?: boolean;
  appliedPaysBefore?: boolean;
  documentsReady?: boolean;
  legalComplexity?: string[]; // deceased_owner, probate, title_dispute, divorce, land_contract, bankruptcy, eviction, fraud, legal_dispute
}

export type RoutingOutcome =
  | "detroit_hope_screening"
  | "pays_followup"
  | "dtrf_referral"
  | "irspa_payment_plan"
  | "regspa_payment_plan"
  | "dooe_hardship_review"
  | "pre_correction_guidance"
  | "surplus_proceeds_form_5743"
  | "legal_aid_referral"
  | "probate_heirship_referral"
  | "treasurer_direct_contact"
  | "payment_path"
  | "document_collection"
  | "human_review_required";

export interface RoutingResult {
  outcomes: { outcome: RoutingOutcome; reason: string }[];
  urgency: "normal" | "elevated" | "urgent" | "critical";
  /** Review is ADDITIVE — the journey continues while flagged. */
  continueJourney: boolean;
  spokenFraming: string;
}

const URGENT_STAGES: ForeclosureStage[] = [
  "show_cause",
  "foreclosure_judgment_pending",
  "redeemable_before_march_31",
];

export function evaluateRouting(input: RoutingInput): RoutingResult {
  const out: { outcome: RoutingOutcome; reason: string }[] = [];
  const add = (outcome: RoutingOutcome, reason: string) => {
    if (!out.some((o) => o.outcome === outcome)) out.push({ outcome, reason });
  };

  const detroit = (input.municipality ?? "").toLowerCase() === "detroit";
  const ownerOcc = input.ownerOccupied === true;
  const signals = new Set(input.householdSignals ?? []);
  const notices = new Set(input.noticesReceived ?? []);
  const legal = new Set(input.legalComplexity ?? []);
  const stage = input.foreclosureStage ?? "unknown";
  const delinquent = (input.delinquentYears ?? []).length > 0 || stage !== "current";
  const incomeSignal =
    signals.has("low_income") || signals.has("senior") || signals.has("disabled") ||
    signals.has("unemployed") || signals.has("widowed") || signals.has("medical_burden") ||
    signals.has("hardship");

  // Urgency first.
  let urgency: RoutingResult["urgency"] = "normal";
  if (stage === "forfeited" || notices.has("yellow_bag")) urgency = "elevated";
  if (URGENT_STAGES.includes(stage) || notices.has("show_cause") || notices.has("court")) urgency = "urgent";
  if (stage === "redeemable_before_march_31") urgency = "critical";
  if (stage === "foreclosed_after_april_1" || stage === "auctioned") urgency = "urgent";

  // 1. Already foreclosed → surplus proceeds path (+ settlement + buy-back).
  if (stage === "foreclosed_after_april_1" || stage === "auctioned" || input.relationship === "former_owner" || notices.has("surplus_proceeds")) {
    add("surplus_proceeds_form_5743", "Home already foreclosed/auctioned — protect any surplus-proceeds claim (NOTARIZED Form 5743, strict July 1 deadline; pre-2021 foreclosures may also have a settlement claim [verify]).");
    add("legal_aid_referral", "Post-foreclosure: legal aid handles Form 5743 logistics, settlement claims, and (if still occupying) the UCHC Make It Home buy-back.");
  }

  // 2. Legal complexity → referral + review (ADDITIVE, journey continues).
  const probateLike = legal.has("deceased_owner") || legal.has("probate") || input.relationship === "heir";
  if (probateLike) {
    add("probate_heirship_referral", "Owner deceased/heirship — title must be settled; legal-aid partners assist.");
    add("human_review_required", "Probate/heirship requires a human reviewer (additive — keep collecting facts).");
  }
  if (legal.has("title_dispute") || legal.has("divorce") || legal.has("land_contract") || legal.has("bankruptcy") || legal.has("eviction") || legal.has("fraud") || legal.has("legal_dispute")) {
    add("legal_aid_referral", "Legal complexity present — route to legal aid.");
    add("human_review_required", "Legal complexity requires human review (additive).");
  }

  // 3. Detroit exemption ladder: HOPE → PAYS → DTRF.
  if (detroit && ownerOcc && incomeSignal && stage !== "foreclosed_after_april_1" && stage !== "auctioned") {
    if (input.appliedHopeBefore && input.appliedPaysBefore) {
      add("dtrf_referral", "HOPE + PAYS already in motion — check Detroit Tax Relief Fund (funding status needs verification).");
    } else if (input.appliedHopeBefore) {
      add("pays_followup", "HOPE already applied — follow up with PAYS enrollment.");
    } else {
      add("detroit_hope_screening", "Detroit owner-occupant with income signals — screen for HOPE first (it unlocks PAYS).");
    }
  }

  // 4. Payment plans for delinquency (any Wayne County municipality).
  if (delinquent && stage !== "foreclosed_after_april_1" && stage !== "auctioned") {
    const vetOrResponder = signals.has("veteran") || signals.has("first_responder");
    if (ownerOcc) {
      add(
        "irspa_payment_plan",
        vetOrResponder
          ? "Owner-occupant — IRSPA reduced-interest plan; veteran/first-responder NO-DOWN-PAYMENT provision applies (DD-214 or employment proof). Confirm post-June-30 sunset status with WCTO."
          : "Owner-occupant with delinquent taxes — IRSPA reduced-interest plan (requires deed in name + PRE on file; confirm post-June-30 sunset status with WCTO).",
      );
      if (signals.has("hardship") || signals.has("medical_burden") || (incomeSignal && URGENT_STAGES.includes(stage))) {
        add("dooe_hardship_review", "Documented hardship — DOOE extension is ACTIVE: withholds the parcel from this cycle's foreclosure for a year (deed recorded in name + occupancy + MI ID + hardship proof).");
      }
    } else {
      add(
        "regspa_payment_plan",
        vetOrResponder
          ? "Standard payment agreement; veteran/first-responder no-down-payment provision applies. REGSPA live status needs verification."
          : "Not owner-occupied — standard payment agreement (REGSPA live status needs verification; an heir can hold one during probate).",
      );
    }
  }

  // 5. PRE correction.
  if (ownerOcc && input.preOnFile === "no") {
    add("pre_correction_guidance", "Owner-occupied but no PRE on file — a correction may cut the bill retroactively.");
  }

  // 6. Wants to pay now / simple payment.
  if (stage === "current" || (!delinquent && out.length === 0)) {
    add("payment_path", "No delinquency issue — payment/balance guidance.");
  }

  // 7. Documents.
  if (input.documentsReady === false) {
    add("document_collection", "Documents incomplete — build the checklist and collect as you go.");
  }

  // 8. Urgent stages always add direct Treasurer contact.
  if (urgency === "urgent" || urgency === "critical") {
    add("treasurer_direct_contact", "Urgent timeline — the Treasurer's office should confirm parcel-specific deadlines directly.");
  }

  if (out.length === 0) {
    add("document_collection", "Not enough facts yet — keep asking one question at a time.");
  }

  const reviewFlagged = out.some((o) => o.outcome === "human_review_required");
  return {
    outcomes: out,
    urgency,
    continueJourney: true, // review never dead-ends the journey (voice standard rule 8)
    spokenFraming: reviewFlagged
      ? "I'm going to keep helping you gather what's needed, and I'll also mark this for a specialist to review."
      : urgency === "critical"
        ? "This deadline matters, so let's move together right now — acting sooner protects more options."
        : "This may fit your situation — let's keep going one step at a time.",
  };
}
