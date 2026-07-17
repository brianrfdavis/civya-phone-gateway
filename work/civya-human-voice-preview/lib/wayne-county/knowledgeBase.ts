/**
 * Wayne County property-tax knowledge base for the Civya instant voice demo.
 *
 * PROVENANCE (reconciled 2026-07-06 against the controlling sources):
 *  - Nexus Master Operating Intelligence Report (merged June 11, 2026) —
 *    primary program/timeline source; its [V]/[S]/[?] tiers map to ours:
 *    [V]→"verified", [S]→"stable", [?]→"needs_verification".
 *  - Civya Voice & Messaging Standard v1.0 (2026-07-02) — controls all
 *    resident-facing wording. Governing standard: "Tell the truth clearly.
 *    Reduce fear. Preserve dignity. Move the resident to the next right
 *    action."
 *  - Civya Brand Guide v1.0 — tone attributes; tagline "Clear answers.
 *    Real next steps."; "Never dead-end a resident."
 *  - Wayne County proposal / Master Operating Plan / Cost Justification —
 *    deployment context (staff-facing, not resident advice).
 *
 * TIME SENSITIVITY (critical, as of the June 11, 2026 research date):
 *  - IRSPA and PAYS statutory authority SUNSET JUNE 30, 2026 absent
 *    legislative extension (Senate passed Oct 2025; stalled in House).
 *    Any conversation after that date must confirm live status with WCTO.
 *  - Form 5743 for April 1, 2026 foreclosures was due JULY 1, 2026.
 *  - A class-action settlement claims deadline of JULY 16, 2026 appears on
 *    treasurer pages for pre-2021 foreclosures. [?]
 *  - 2026 HOPE deadline: 4:30 p.m., Friday, November 6, 2026 — and NEW
 *    2025-year applications are also accepted until then.
 * NOTHING here is legal advice; resident wording never promises outcomes.
 */

export type SourceConfidence = "verified" | "stable" | "needs_verification" | "demo_only";

export type ProgramKnowledge = {
  id: string;
  name: string;
  plainLanguageName: string;
  residentFriendlySummary: string;
  whoItMayHelp: string[];
  keyEligibilitySignals: string[];
  requiredDocuments: string[];
  deadlineRules: string[];
  routingTriggers: string[];
  residentFacingApprovedAnswer: string;
  staffFacingNotes?: string[];
  sourceConfidence: SourceConfidence;
  neverPromise: string[];
};

// ── Foreclosure timeline (MCL 211.78 et seq.; Nexus Section B, [S]/[V]) ──

export interface TimelineStage {
  id: string;
  label: string;
  plainLanguage: string;
  whenRule: string;
  urgency: "normal" | "elevated" | "urgent" | "critical";
  sourceConfidence: SourceConfidence;
}

export const FORECLOSURE_TIMELINE: TimelineStage[] = [
  {
    id: "bills_issued",
    label: "Summer & winter bills issued by city/township",
    plainLanguage:
      "Tax bills come from your city or township first — summer bills around July, winter around December. Due dates vary by city.",
    whenRule: "Jul 1 / Dec 1 of the tax year (Detroit summer 2026 bills mail early July)",
    urgency: "normal",
    sourceConfidence: "stable",
  },
  {
    id: "delinquent_march_1",
    label: "Delinquency — turned over to Wayne County Treasurer",
    plainLanguage:
      "If the taxes aren't paid by March 1 of the next year, they move to the Wayne County Treasurer. A 4% administration fee is added and interest runs at 1% per month.",
    whenRule: "March 1 of year +1 (MCL 211.78a); notices mailed June 1 & Sept 1; extra $15 fee Oct 1",
    urgency: "normal",
    sourceConfidence: "stable",
  },
  {
    id: "forfeiture_year_2",
    label: "Forfeiture (year two)",
    plainLanguage:
      "After a year of delinquency the parcel is 'forfeited' to the Treasurer. That is NOT loss of title — it's a recording and escalation step. About $175 in fees is added and interest rises to 1.5% per month, applied back to the original delinquency date.",
    whenRule: "March 1 of year +2 (MCL 211.78g)",
    urgency: "elevated",
    sourceConfidence: "stable",
  },
  {
    id: "petition_and_notice",
    label: "Foreclosure petition + required notices",
    plainLanguage:
      "The Treasurer files a foreclosure petition in the Third Circuit Court, and owners get notified several ways — certified mail, newspaper publication, and a personal visit or notice posted at the property.",
    whenRule: "Petition Apr–Jun 15 of year +2 (MCL 211.78h); visit/posting fall of year +2 (MCL 211.78i)",
    urgency: "urgent",
    sourceConfidence: "stable",
  },
  {
    id: "show_cause_hearing",
    label: "Show-cause hearing",
    plainLanguage:
      "An administrative hearing before the Treasurer — the last structured chance to prove payment or an exemption, or to enroll in relief. It happens at least 7 days before the court hearing.",
    whenRule: "Jan–Feb of year +3 (MCL 211.78j)",
    urgency: "urgent",
    sourceConfidence: "stable",
  },
  {
    id: "circuit_court_hearing",
    label: "Judicial foreclosure hearing (Third Circuit Court)",
    plainLanguage:
      "A judge hears the foreclosure case; owners may file written objections. In 2026 this hearing was held remotely by Zoom on February 18–19, and the Treasurer asked for payment-plan arrangements by March 13.",
    whenRule: "February of year +3; judgment effective March 31",
    urgency: "urgent",
    sourceConfidence: "verified",
  },
  {
    id: "redemption_march_31",
    label: "March 31 redemption deadline",
    plainLanguage:
      "March 31 of the foreclosure year is the last day to pay what's owed or be safely enrolled in a qualifying plan. This is the single most important date.",
    whenRule: "March 31 of year +3 (absolute)",
    urgency: "critical",
    sourceConfidence: "verified",
  },
  {
    id: "title_vests_april_1",
    label: "April 1 — title transfers",
    plainLanguage:
      "If the balance isn't resolved by March 31, title vests with the Treasurer on April 1. After this, occupancy is not ownership — the focus shifts to the surplus-proceeds claim, the UCHC Make It Home buy-back program, and legal aid.",
    whenRule: "April 1 of year +3",
    urgency: "critical",
    sourceConfidence: "verified",
  },
  {
    id: "auction_sept_oct",
    label: "Auction (September–October)",
    plainLanguage: "Foreclosed properties are sold at public auction in September and October.",
    whenRule: "September & October 2026 auctions confirmed for the 2026 cycle",
    urgency: "critical",
    sourceConfidence: "verified",
  },
  {
    id: "surplus_proceeds",
    label: "Surplus proceeds (Form 5743)",
    plainLanguage:
      "If the auction brings more than what was owed, the former owner may claim the leftover money — but a notarized Form 5743 must reach the Treasurer by July 1 of the foreclosure year, by certified mail or hand delivery. Missing it generally ends the claim.",
    whenRule: "Notarized Form 5743 due July 1 of the foreclosure year (for April 1, 2026 foreclosures: July 1, 2026)",
    urgency: "critical",
    sourceConfidence: "verified",
  },
];

// ── Treasurer contact / routing (Nexus "Common WCTO facts" [V]) ──────

export const TREASURER_CONTACT = {
  office: "Wayne County Treasurer's Office (WCTO)",
  address: "400 Monroe Street, 5th Floor, Detroit, MI 48226",
  phone: "(313) 224-5990",
  email: "taxinfo@waynecountymi.gov",
  web: "https://treasurer.waynecounty.com",
  paymentPlanPortal: "pta.waynecounty.com (online payment-plan enrollment)",
  taxpayerAssistanceNote:
    "Staff confirm balances, plan options, and parcel-specific deadlines. Service available in ten languages; a Mobile Office program brings services into the community.",
  sourceConfidence: "verified" as SourceConfidence,
};

export const PARTNERS = [
  { id: "wayne_metro", name: "Wayne Metropolitan Community Action Agency", role: "HOPE/PAYS application help; administers the Detroit Tax Relief Fund", sourceConfidence: "verified" as SourceConfidence },
  { id: "uchc", name: "United Community Housing Coalition", role: "Foreclosure-prevention counseling; Make It Home buy-back program for occupants after April 1", sourceConfidence: "verified" as SourceConfidence },
  { id: "lakeshore_legal", name: "Lakeshore Legal Aid", role: "Free civil legal help: court objections, probate filings, settlement claims, appeals", sourceConfidence: "verified" as SourceConfidence },
  { id: "legal_aid_defender", name: "Legal Aid & Defender Association", role: "Free legal representation for court and probate matters", sourceConfidence: "verified" as SourceConfidence },
  { id: "mi_legal_help", name: "Michigan Legal Help", role: "Self-help legal information and lawyer referral", sourceConfidence: "stable" as SourceConfidence },
  { id: "gilbert_rocket", name: "Gilbert Family Foundation / Rocket Community Fund", role: "Fund the Detroit Tax Relief Fund (administered by Wayne Metro)", sourceConfidence: "verified" as SourceConfidence },
  { id: "veterans_affairs", name: "Wayne County Veterans Affairs", role: "(313) 224-5045 — discharge documentation help for the veteran no-down-payment plan", sourceConfidence: "verified" as SourceConfidence },
];

// ── Programs (Nexus Section C program inventory) ─────────────────────

export const PROGRAMS: ProgramKnowledge[] = [
  {
    id: "hope",
    name: "HOPE (Homeowners Property Exemption)",
    plainLanguageName: "Detroit property-tax exemption for lower-income homeowners",
    residentFriendlySummary:
      "HOPE can remove 100, 75, 50, 25, or 10 percent of this year's property taxes for Detroit homeowners whose income qualifies — and under a recent state-law change it can reach prior-year taxes too. Approval automatically unlocks PAYS.",
    whoItMayHelp: ["Detroit homeowners who live in their home", "Lower-income households", "Seniors on fixed incomes", "Households that lost 20%+ of income (10% tier)"],
    keyEligibilitySignals: ["detroit_property", "owner_occupant", "income_below_guidelines"],
    requiredDocuments: ["photo_id", "proof_of_occupancy", "proof_of_income", "tax_notice"],
    deadlineRules: [
      "2026 deadline: 4:30 p.m., Friday, November 6, 2026 — and NEW 2025-year applications are also accepted until then (Council resolution under amended MCL 211.7u)",
      "Board of Review decides on March, July, and December dockets",
      "Applying before/around early-July summer billing maximizes relief and unlocks PAYS before the next delinquency cycle",
    ],
    routingTriggers: ["detroit + owner_occupant + income_signal"],
    residentFacingApprovedAnswer:
      "HOPE is Detroit's Homeowners Property Exemption. If you own and live in your Detroit home and your income qualifies, it can remove some or all of this year's property taxes — from ten percent up to one hundred percent — and it can now reach last year's taxes too. Approval also automatically opens the door to PAYS, which shrinks older debt. The deadline this year is November sixth.",
    staffFacingNotes: [
      "Formerly HPTAP/PTE; decision-maker is the Property Assessment Board of Review",
      "Tiers: 100/75/50/25/10%; the 10% tier requires foreclosure threat OR ≥20% household income loss [V]",
      "Gateway effect: HOPE → automatic PAYS → DTRF ('the golden path') [V]",
      "Does NOT cover delinquent county-held taxes by itself — PAYS handles those",
    ],
    sourceConfidence: "verified",
    neverPromise: ["approval", "a specific exemption tier", "that HOPE alone erases delinquent taxes"],
  },
  {
    id: "pays",
    name: "PAYS (Pay As You Stay)",
    plainLanguageName: "Back-tax reduction for exemption-approved homeowners",
    residentFriendlySummary:
      "For homeowners granted a local poverty exemption like HOPE, PAYS cuts county-held back taxes to the base taxes only or 10% of the home's taxable value — whichever is LESS — payable over up to 3 years at 0% interest. Interest, penalties, and fees are canceled on completion.",
    whoItMayHelp: ["HOPE-approved Detroit homeowners", "Owner-occupants granted a local poverty exemption anywhere in Wayne County"],
    keyEligibilitySignals: ["hope_or_poverty_exemption_approved", "owner_occupant", "delinquent_taxes"],
    requiredDocuments: ["hope_approval", "tax_notice"],
    deadlineRules: [
      "Enrollment is automatic upon HOPE approval",
      "STATUTORY SUNSET: authority (2020 PA 33, MCL 211.78q) sunsets June 30, 2026 absent legislative extension — CONFIRM LIVE STATUS with the Treasurer before promising enrollment",
    ],
    routingTriggers: ["hope_approved + delinquent"],
    residentFacingApprovedAnswer:
      "PAYS stands for Pay As You Stay. Once you're approved for the HOPE exemption, PAYS automatically cuts your county back taxes to the base taxes or ten percent of your home's taxable value — whichever is less — with up to three years to pay and no interest. One honest caution: the law behind PAYS was set to expire at the end of June unless lawmakers extended it, so the Treasurer's office confirms today's status. Either way, the HOPE application is the right first step.",
    staffFacingNotes: [
      "Statewide enabling law 2020 PA 33 / MCL 211.78q, adopted by Wayne County [V]",
      "SUNSET June 30, 2026 absent extension; Senate passed Oct 2025, stalled in House (last heard Dec 2025); Treasurer Sabree warned June 9, 2026 [V] — track legislature.mi.gov",
      "PAYSPA agreement; does not pay current-year taxes (HOPE covers those)",
    ],
    sourceConfidence: "verified",
    neverPromise: ["a specific reduced balance", "that PAYS is available without confirming post-sunset status"],
  },
  {
    id: "dtrf",
    name: "Detroit Tax Relief Fund",
    plainLanguageName: "Philanthropic fund that can pay the remaining PAYS balance to zero",
    residentFriendlySummary:
      "Funded by the Gilbert Family Foundation and Rocket Community Fund and administered by Wayne Metro, the Detroit Tax Relief Fund pays the remaining PAYS balance to zero for eligible Detroit homeowners — the last step of the HOPE → PAYS → DTRF 'golden path.'",
    whoItMayHelp: ["Detroit homeowners approved for HOPE and enrolled in PAYS"],
    keyEligibilitySignals: ["hope_approved", "pays_enrolled", "detroit_property"],
    requiredDocuments: ["hope_approval", "pays_enrollment"],
    deadlineRules: ["Contingent on PAYS remaining authorized (the June 30, 2026 sunset risk flows through to DTRF)"],
    routingTriggers: ["hope_approved + pays_enrolled"],
    residentFacingApprovedAnswer:
      "The Detroit Tax Relief Fund is philanthropic money — from the Gilbert Family Foundation and Rocket Community Fund, run through Wayne Metro — that pays the rest of a PAYS balance down to zero for eligible Detroit homeowners. A qualifying homeowner can go from years of debt to a clean slate through one well-executed HOPE application. I can't promise the fund for your case, but I can help you take the steps that make it possible.",
    staffFacingNotes: ["Gilbert orgs publicly warned a PAYS lapse would undercut DTRF [V]"],
    sourceConfidence: "verified",
    neverPromise: ["fund availability for a specific case", "payoff amounts"],
  },
  {
    id: "irspa",
    name: "IRSPA (Interest Reduction Stipulated Payment Agreement)",
    plainLanguageName: "Reduced-interest payment plan with the Wayne County Treasurer",
    residentFriendlySummary:
      "IRSPA cuts the interest on delinquent taxes from 18% to 6% for owner-occupants and bundles all delinquent years into one plan. Requires the deed in your name and the Principal Residence Exemption on file. No income limits.",
    whoItMayHelp: ["Owner-occupants anywhere in Wayne County with delinquent taxes"],
    keyEligibilitySignals: ["owner_occupant", "deed_in_name", "pre_on_file", "delinquent_taxes"],
    requiredDocuments: ["photo_id", "deed_or_ownership", "pre_status", "plan_application"],
    deadlineRules: [
      "Rolling enrollment, but enroll before the parcel's March 31 foreclosure date to stop that cycle",
      "STATUTORY SUNSET: June 30, 2026 absent legislative extension — Treasurer Sabree warned June 9, 2026 the plan 'will end this month'; CONFIRM LIVE STATUS",
    ],
    routingTriggers: ["owner_occupant + delinquent"],
    residentFacingApprovedAnswer:
      "IRSPA is the Treasurer's reduced-interest plan: for people who own and live in their home, it drops the interest on back taxes from eighteen percent to six percent and puts every delinquent year into one plan. You'd need the deed in your name and the homestead exemption on file — and one honest caution: the law behind it was set to expire at the end of June unless lawmakers extended it, so the first step is confirming today's status with the Treasurer. I can help you get everything ready either way.",
    staffFacingNotes: [
      "Apply online at pta.waynecounty.com, PDF app (EN/AR/ES), or (313) 224-5990 [V]",
      "Down payment not stated on the official page [?] (historically ~10% — VERIFY); WAIVED for veterans and first responders [V]",
      "PRE on file is a prerequisite — run the PRE check first; missing PRE → Form 2368 packet",
    ],
    sourceConfidence: "verified",
    neverPromise: ["current post-sunset availability without confirming", "exact down-payment terms", "that foreclosure is cancelled"],
  },
  {
    id: "regspa",
    name: "REGSPA (Regular Stipulated Payment Agreement)",
    plainLanguageName: "Standard Treasurer payment plan",
    residentFriendlySummary:
      "The standard payment agreement for those who don't meet IRSPA's owner-occupant criteria. Note: sources conflict on current availability — one shows it active, another says the 2024 version was 'expected back by end of June 2026.'",
    whoItMayHelp: ["Taxpayers with delinquent taxes who don't meet IRSPA criteria", "Heirs — a REGSPA can be held while probate proceeds"],
    keyEligibilitySignals: ["delinquent_taxes"],
    requiredDocuments: ["photo_id", "tax_notice", "plan_application"],
    deadlineRules: ["Enroll before the parcel's March 31 foreclosure date; default voids the plan and the foreclosure track resumes"],
    routingTriggers: ["delinquent + not_owner_occupant", "heir_during_probate"],
    residentFacingApprovedAnswer:
      "There's also a standard payment agreement with the Treasurer that spreads payments out even when the reduced-interest plan doesn't fit — and it can even be held by an heir while an estate is being settled. The Treasurer's office confirms current availability and terms, and I can help you prepare everything they'll ask for.",
    staffFacingNotes: [
      "SOURCE CONFLICT: baseline = ACTIVE [V]; secondary pass = county page said 2024 REGSPA 'expected back by end of June 2026' [?]. Treat as needs_verification until the live WCTO page and current SPA_FORM2025 are re-pulled (punch-list item 19)",
      "Down payment governed by 'REGSPA Down Payments' flyer — percentage not captured [?]",
    ],
    sourceConfidence: "needs_verification",
    neverPromise: ["availability", "specific terms"],
  },
  {
    id: "dooe",
    name: "DOOE (Distressed Owner-Occupant Extension)",
    plainLanguageName: "Hardship extension that holds a home out of foreclosure for a year",
    residentFriendlySummary:
      "For owner-occupants in documented financial hardship, DOOE withholds the parcel from that cycle's foreclosure — a year of protected time that should be used to erase the problem (via HOPE/PAYS or a plan), not just delay it.",
    whoItMayHelp: ["Owner-occupants with documented hardship at risk of foreclosure"],
    keyEligibilitySignals: ["owner_occupant", "deed_recorded_in_name", "hardship", "foreclosure_risk"],
    requiredDocuments: ["deed_recorded_in_applicant_name", "proof_of_occupancy", "michigan_id", "hardship_documentation"],
    deadlineRules: ["Request before the cycle's foreclosure; 2025–26 policy document posted — ACTIVE"],
    routingTriggers: ["owner_occupant + hardship + urgent_stage"],
    residentFacingApprovedAnswer:
      "There's a hardship extension called DOOE. If you own and live in the home and can document real hardship, the Treasurer can hold the property out of this cycle's foreclosure — a year of breathing room. The key is using that year to fix the underlying problem, and I can help you line that up: the exemption path, a payment plan, and the documents a reviewer needs.",
    staffFacingNotes: [
      "ACTIVE — 2025–26 policy document posted [V]; MCL 211.78g(8) mechanism [S]",
      "Docs [V]: deed RECORDED in applicant's name; lives in property; proof of occupancy (utility bill or similar); valid MI driver's license or State ID; documented hardship proof",
      "Coach: 'the extension year is used to erase, not just delay'",
    ],
    sourceConfidence: "verified",
    neverPromise: ["that foreclosure stops permanently", "approval"],
  },
  {
    id: "veteran_plan",
    name: "Veteran payment-plan provision (no down payment)",
    plainLanguageName: "No-down-payment Treasurer plan for veterans",
    residentFriendlySummary:
      "Veterans may enter a Treasurer payment plan with NO down payment by providing honorable-discharge certification or a DD-214 referencing honorable discharge.",
    whoItMayHelp: ["Veterans with delinquent Wayne County taxes"],
    keyEligibilitySignals: ["veteran", "delinquent_taxes"],
    requiredDocuments: ["dd214_or_discharge_certification", "photo_id", "tax_notice"],
    deadlineRules: ["Rolling; enroll before the parcel's March 31 date to stop that cycle"],
    routingTriggers: ["veteran + delinquent"],
    residentFacingApprovedAnswer:
      "Thank you for your service — and there's something concrete here: veterans can enter a Treasurer payment plan with no down payment at all, using your DD-214 or honorable-discharge papers. Wayne County Veterans Affairs can help pull discharge documents if you don't have them handy. I can get everything else ready while that's confirmed.",
    staffFacingNotes: ["ACTIVE [V]; Wayne County Veterans Affairs (313) 224-5045; Veterans Resource Guide PDF posted"],
    sourceConfidence: "verified",
    neverPromise: ["plan terms beyond the no-down-payment provision"],
  },
  {
    id: "first_responder_plan",
    name: "First-responder payment-plan provision (no down payment)",
    plainLanguageName: "No-down-payment Treasurer plan for police, fire, and EMS",
    residentFriendlySummary:
      "Police officers, firefighters, and EMS workers employed in those roles may qualify for Treasurer payment plans with no down payment — ID and employment verification required.",
    whoItMayHelp: ["Police, firefighters, EMS with delinquent Wayne County taxes"],
    keyEligibilitySignals: ["first_responder", "delinquent_taxes"],
    requiredDocuments: ["photo_id", "employment_verification", "tax_notice"],
    deadlineRules: ["Rolling; enroll before the parcel's March 31 date to stop that cycle"],
    routingTriggers: ["first_responder + delinquent"],
    residentFacingApprovedAnswer:
      "Yes — police officers, firefighters, and EMS workers can qualify for a Treasurer payment plan with no down payment. You'd show ID and proof of employment in the role. I can help you get the rest of the paperwork lined up right now.",
    staffFacingNotes: ["ACTIVE [V], county-level provision"],
    sourceConfidence: "verified",
    neverPromise: ["plan terms beyond the no-down-payment provision"],
  },
  {
    id: "pre_correction",
    name: "PRE (Principal Residence Exemption) correction",
    plainLanguageName: "Fixing a missing homestead exemption",
    residentFriendlySummary:
      "The PRE exempts up to 18 mills of school operating tax on the home you live in. Its absence inflates every bill AND blocks IRSPA (and HOPE prerequisites) — so checking it is an early step for every owner-occupant.",
    whoItMayHelp: ["Owner-occupants whose PRE was never filed or was wrongly removed"],
    keyEligibilitySignals: ["owner_occupant", "pre_not_on_file"],
    requiredDocuments: ["photo_id", "proof_of_occupancy", "form_2368"],
    deadlineRules: ["Filing deadlines: June 1 (summer levy) / November 1 (winter levy)", "Denial appeals and conditional rescission exist (Form 4640 / petition routes)"],
    routingTriggers: ["owner_occupant + pre_missing"],
    residentFacingApprovedAnswer:
      "The Principal Residence Exemption — the homestead exemption — keeps up to eighteen mills of school tax off the home you live in. If it's missing, every bill has been higher than it should be, and it also blocks the reduced-interest payment plan. Filing Form 2368 with your city assessor fixes it going forward — June first is the deadline for the summer bill — and I can help you put that packet together.",
    staffFacingNotes: ["PRE check is an early intake step for EVERY owner-occupant; missing PRE → generate Form 2368 packet [S]"],
    sourceConfidence: "stable",
    neverPromise: ["retroactive approval", "specific savings"],
  },
  {
    id: "mi_1040cr",
    name: "MI-1040CR Homestead Property Tax Credit",
    plainLanguageName: "State tax credit that refunds part of your property taxes",
    residentFriendlySummary:
      "Michigan's refundable homestead property tax credit returns part of the property taxes lower- and moderate-income households pay — claimable even without owing income tax, and often for prior years.",
    whoItMayHelp: ["Lower/moderate-income homeowners and renters", "Seniors and people with disabilities"],
    keyEligibilitySignals: ["income_below_guidelines"],
    requiredDocuments: ["income_records", "property_tax_statements"],
    deadlineRules: ["Filed with (or without) the state income-tax return; prior-year claims possible"],
    routingTriggers: ["income_signal"],
    residentFacingApprovedAnswer:
      "Michigan has a homestead property tax credit that can refund a meaningful part of the property taxes you've paid, based on income — and it can often be claimed for past years too. It's filed with the state, and free tax-prep partners can help. It stacks with everything else we're working on.",
    sourceConfidence: "stable",
    neverPromise: ["credit amounts"],
  },
  {
    id: "senior_relief",
    name: "Senior deferment / senior discounts",
    plainLanguageName: "Extra time and discounts for senior homeowners",
    residentFriendlySummary:
      "Seniors may qualify for the state summer-tax deferment (MCL 211.51, Form 471). Detroit also lists a Senior Property Tax Deferred Payment Program (defers summer and winter taxes to February 14) and a Senior Citizen Solid Waste Discount (65+, PRE on file, 50% off) — whether these are distinct lanes needs confirmation.",
    whoItMayHelp: ["Senior homeowners on fixed incomes"],
    keyEligibilitySignals: ["senior", "owner_occupant"],
    requiredDocuments: ["photo_id", "income_records"],
    deadlineRules: ["State summer deferment via Form 471 through the local treasurer", "Detroit senior deferral defers to February 14 [?]"],
    routingTriggers: ["senior + owner_occupant"],
    residentFacingApprovedAnswer:
      "Seniors have a few extra tools: the state lets qualifying seniors defer summer taxes without penalty using a simple form, Detroit lists a senior deferral that moves both bills to mid-February, and there's a fifty-percent senior discount on Detroit's solid-waste fee. I'll flag the details for confirmation — they stack with the bigger programs we're working on.",
    staffFacingNotes: ["Source flags a possible coverage gap: confirm whether Detroit's senior deferral and 65+ discount are distinct lanes from the state deferment (Nexus merge note 2) [?]"],
    sourceConfidence: "needs_verification",
    neverPromise: ["eligibility", "amounts"],
  },
  {
    id: "surplus_proceeds",
    name: "Surplus proceeds claim (Form 5743)",
    plainLanguageName: "Claiming leftover money after a tax-foreclosure sale",
    residentFriendlySummary:
      "If a foreclosed home sells for more than what was owed, the former owner may claim the difference. A NOTARIZED Form 5743 must reach the Treasurer by July 1 of the foreclosure year — certified mail with return receipt, or hand delivery to 400 Monroe, 5th Floor. Missing the deadline generally extinguishes the claim.",
    whoItMayHelp: ["Former owners whose homes were tax-foreclosed"],
    keyEligibilitySignals: ["former_owner", "foreclosed_after_april_1"],
    requiredDocuments: ["form_5743_notarized", "photo_id", "proof_of_prior_ownership"],
    deadlineRules: [
      "Notarized Form 5743 due July 1 of the foreclosure year (for April 1, 2026 foreclosures: July 1, 2026) — strict",
      "Separate class-action settlement claims deadline of July 16, 2026 appears on treasurer pages for pre-2021 foreclosures [?] — route to legal aid immediately",
    ],
    routingTriggers: ["already_foreclosed"],
    residentFacingApprovedAnswer:
      "Even after a foreclosure, money may still be owed to you: if the home sold for more than the debt, you may have a right to the difference. The claim form — Form 5743 — has to be notarized and reach the Treasurer by July first of the foreclosure year, and for older foreclosures there may be a separate settlement claim with its own deadline. These dates are strict, so let's treat this as urgent and get legal aid involved today.",
    staffFacingNotes: [
      "Highest-stakes, simplest workflow: identify affected former owners, solve notarization logistics, confirm delivery [V]",
      "For pre-2021 foreclosures: class-action settlement claims deadline July 16, 2026 on treasurer pages [?] — whether specific parcels qualify needs review (punch item 8)",
      "MCL 211.78t; Rafaeli v. Oakland County (2020)",
    ],
    sourceConfidence: "verified",
    neverPromise: ["that money exists", "amounts", "deadline exceptions"],
  },
  {
    id: "probate_heirship",
    name: "Probate / heirship referral",
    plainLanguageName: "Getting the home into your name after an owner dies",
    residentFriendlySummary:
      "When the owner has died, most tax programs require title to be settled — but not everything waits: an heir can hold a standard payment agreement while probate proceeds, and PRE corrections can move in parallel. Free legal-aid partners handle the probate filings.",
    whoItMayHelp: ["Heirs living in a family home", "Occupants after an owner's death"],
    keyEligibilitySignals: ["owner_deceased", "heir_occupant"],
    requiredDocuments: ["photo_id", "death_certificate_if_available", "any_deed_or_will", "tax_notice"],
    deadlineRules: ["Foreclosure deadlines keep running against the property while title is being settled"],
    routingTriggers: ["owner_deceased", "title_dispute"],
    residentFacingApprovedAnswer:
      "I'm sorry — that's a lot to carry. Here's what's true: the legal side runs through settling the title, and free legal-aid partners handle that. But we don't have to wait on everything — an heir can often hold a standard payment agreement while the estate is settled, and I can collect your information and documents now so the right person starts with a full picture.",
    staffFacingNotes: ["Warm handoff (Actionability 2): Lakeshore Legal Aid, UCHC, Legal Aid & Defender", "Stacking: heir can hold a REGSPA during probate; PRE correction can proceed in parallel"],
    sourceConfidence: "verified",
    neverPromise: ["legal outcomes", "title timelines"],
  },
  {
    id: "legal_aid",
    name: "Legal aid referral",
    plainLanguageName: "Free legal help",
    residentFriendlySummary:
      "Free legal help in Wayne County for court objections, probate filings, settlement claims, and appeals: Lakeshore Legal Aid, United Community Housing Coalition, and Legal Aid & Defender.",
    whoItMayHelp: ["Anyone facing legal questions Civya cannot answer"],
    keyEligibilitySignals: ["legal_question", "court_notice", "title_dispute"],
    requiredDocuments: ["photo_id", "relevant_notices"],
    deadlineRules: [],
    routingTriggers: ["legal_advice_request", "court_matter"],
    residentFacingApprovedAnswer:
      "I don't give legal advice — some situations need human judgment, and free legal advocates exist for exactly this: Lakeshore Legal Aid, the United Community Housing Coalition, and Legal Aid and Defender. I can send your information to the review team and keep helping you gather documents and protect deadlines while that's arranged.",
    sourceConfidence: "verified",
    neverPromise: ["legal outcomes", "representation"],
  },
];

// ── Guardrails (Voice & Messaging Standard v1.0 + Brand Guide) ───────

export const GUARDRAILS = {
  governingStandard:
    "Tell the truth clearly. Reduce fear. Preserve dignity. Move the resident to the next right action.",
  mustSay: [
    "Simulated/demo framing whenever a submission or payment is simulated",
    "Risk paired with an immediate, doable next step (never threat-only)",
    "Why each piece of information is needed, when asking for it",
    "One question at a time, plain language, dignity-first",
  ],
  neverSay: [
    "You are officially approved.",
    "Your foreclosure is cancelled.",
    "The county has accepted your payment plan.",
    "This is legal advice.",
    "You definitely qualify. (unless a deterministic demo rule marks demo-qualified)",
    "You will lose your home.",
    "You failed to pay your taxes. (say: 'There are unpaid taxes connected to this property.')",
    "Final warning. (say: 'This deadline matters.')",
    "You are delinquent. (say: 'The property has unpaid taxes.')",
    "Unfortunately, you do not qualify. (say: 'This option may not fit, but we can check another path.')",
    "Don't worry. (say: 'There may still be steps available.')",
    "Give me your real card or bank number.",
  ],
  approvedPatterns: {
    risk: "Your property may be at risk. There may still be steps available. Let's check what applies today.",
    noFit: "This option may not fit based on what you told us. That does not mean you are out of options.",
    dataAsk: "We use this to match your property and check which options may apply.",
    documentAsk: "Upload one document that shows you live at the property. A driver's license, utility bill, or bank statement may work.",
    humanReview: "Some situations need human judgment. We can send your information to the review team — and I'll keep helping you gather what's needed meanwhile.",
    deadline: "This deadline matters. Acting sooner may protect more options.",
    completion: "You completed this step. We saved your progress. Your next step is below.",
  },
  disclaimers: {
    general:
      "Civya explains public program information in plain language. It does not give legal or tax advice, and programs make their own decisions.",
    demo: "This is a demonstration with fictional data. Simulated submissions and payments do not reach any county system.",
    timeSensitive:
      "Program details reflect source material dated June–July 2026. The IRSPA/PAYS statutory sunset (June 30, 2026), Form 5743 and settlement deadlines, and REGSPA status must be confirmed live before resident-facing use.",
  },
};
