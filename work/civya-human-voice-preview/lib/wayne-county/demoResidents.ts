/**
 * Fully fictional demo residents for the Wayne County voice demo.
 * All names, addresses, parcels, balances, and phones are fabricated.
 */

export type DemoResident = {
  id: string;
  name: string;
  phone?: string;
  address: string;
  municipality: string;
  parcelId: string;
  ownerOccupied: boolean;
  preStatus: "yes" | "no" | "unknown";
  delinquentYears: number[];
  foreclosureStage:
    | "current"
    | "delinquent"
    | "forfeited"
    | "show_cause"
    | "foreclosure_judgment_pending"
    | "redeemable_before_march_31"
    | "foreclosed_after_april_1"
    | "auctioned"
    | "unknown";
  balanceDueDemo: number;
  noticesReceived: string[];
  householdSignals: string[];
  likelyPathways: string[];
  missingDocuments: string[];
  demoOutcome: string;
};

export const DEMO_RESIDENTS: DemoResident[] = [
  {
    id: "wc-001",
    name: "Eleanor Jackson",
    phone: "313-555-0101",
    address: "4172 Maplewood Street",
    municipality: "Detroit",
    parcelId: "21-004372-118",
    ownerOccupied: true,
    preStatus: "yes",
    delinquentYears: [2024, 2025],
    foreclosureStage: "delinquent",
    balanceDueDemo: 6842,
    noticesReceived: ["delinquency_notice"],
    householdSignals: ["senior", "low_income", "widowed"],
    likelyPathways: ["detroit_hope_screening", "pays_followup", "dtrf_referral"],
    missingDocuments: ["proof_of_income"],
    demoOutcome: "HOPE screening → PAYS → DTRF check; packet submitted (demo) with follow-up reminder.",
  },
  {
    id: "wc-002",
    name: "Darnell Weaver",
    phone: "313-555-0122",
    address: "6250 Rosemont Court",
    municipality: "Detroit",
    parcelId: "22-011845-006",
    ownerOccupied: true,
    preStatus: "no",
    delinquentYears: [2025],
    foreclosureStage: "delinquent",
    balanceDueDemo: 2380,
    noticesReceived: [],
    householdSignals: [],
    likelyPathways: ["pre_correction_guidance", "irspa_payment_plan"],
    missingDocuments: ["proof_of_occupancy"],
    demoOutcome: "PRE correction guidance (missing homestead exemption) + payment plan for the balance.",
  },
  {
    id: "wc-003",
    name: "Marcus Reed",
    phone: "734-555-0144",
    address: "918 Harborview Drive",
    municipality: "Wyandotte",
    parcelId: "57-330912-441",
    ownerOccupied: true,
    preStatus: "yes",
    delinquentYears: [2025],
    foreclosureStage: "delinquent",
    balanceDueDemo: 3120,
    noticesReceived: ["delinquency_notice"],
    householdSignals: [],
    likelyPathways: ["irspa_payment_plan"],
    missingDocuments: [],
    demoOutcome: "IRSPA reduced-interest plan set up with simulated first payment.",
  },
  {
    id: "wc-004",
    name: "Yolanda Pierce",
    phone: "313-555-0155",
    address: "13448 Greenlawn Avenue",
    municipality: "Detroit",
    parcelId: "16-020773-229",
    ownerOccupied: true,
    preStatus: "unknown",
    delinquentYears: [2023, 2024],
    foreclosureStage: "forfeited",
    balanceDueDemo: 8965,
    noticesReceived: ["yellow_bag"],
    householdSignals: ["hardship"],
    likelyPathways: ["detroit_hope_screening", "irspa_payment_plan", "treasurer_direct_contact"],
    missingDocuments: ["photo_id", "proof_of_income"],
    demoOutcome: "Yellow-bag urgency: HOPE screening + plan options + Treasurer contact, documents collected same call.",
  },
  {
    id: "wc-005",
    name: "Denise Alvarez",
    phone: "313-555-0166",
    address: "2306 Crescent Avenue",
    municipality: "Detroit",
    parcelId: "21-009981-220",
    ownerOccupied: true,
    preStatus: "yes",
    delinquentYears: [2023, 2024, 2025],
    foreclosureStage: "redeemable_before_march_31",
    balanceDueDemo: 11485,
    noticesReceived: ["show_cause", "court"],
    householdSignals: ["medical_burden", "hardship"],
    likelyPathways: ["irspa_payment_plan", "dooe_hardship_review", "detroit_hope_screening", "treasurer_direct_contact"],
    missingDocuments: ["proof_of_income", "proof_of_occupancy"],
    demoOutcome: "CRITICAL March-31 case: same-day plan setup + hardship review + Treasurer contact.",
  },
  {
    id: "wc-006",
    name: "Gerald Osei",
    phone: "313-555-0170",
    address: "9917 Ashbury Lane",
    municipality: "Redford Township",
    parcelId: "79-441206-013",
    ownerOccupied: false,
    preStatus: "no",
    delinquentYears: [2022, 2023],
    foreclosureStage: "auctioned",
    balanceDueDemo: 0,
    noticesReceived: ["auction", "surplus_proceeds"],
    householdSignals: [],
    likelyPathways: ["surplus_proceeds_form_5743", "legal_aid_referral"],
    missingDocuments: ["form_5743", "proof_of_prior_ownership"],
    demoOutcome: "Former owner: notarized Form 5743 (strict July 1), settlement-claim check for older foreclosures, Make It Home if occupying + legal aid.",
  },
  {
    id: "wc-007",
    name: "Terrence Whitfield",
    phone: "313-555-0177",
    address: "7751 Elmhurst Road",
    municipality: "Inkster",
    parcelId: "44-118220-476",
    ownerOccupied: true,
    preStatus: "unknown",
    delinquentYears: [2024, 2025],
    foreclosureStage: "forfeited",
    balanceDueDemo: 4930,
    noticesReceived: ["delinquency_notice"],
    householdSignals: ["hardship"],
    likelyPathways: ["probate_heirship_referral", "legal_aid_referral", "document_collection"],
    missingDocuments: ["death_certificate", "deed"],
    demoOutcome: "Heir after parent's death: facts + documents collected FIRST, then probate/legal-aid referral with review flag.",
  },
  {
    id: "wc-008",
    name: "Rosa Delgado-Mills",
    phone: "734-555-0183",
    address: "310 Veterans Parkway",
    municipality: "Taylor",
    parcelId: "60-227654-902",
    ownerOccupied: true,
    preStatus: "yes",
    delinquentYears: [2025],
    foreclosureStage: "delinquent",
    balanceDueDemo: 2710,
    noticesReceived: [],
    householdSignals: ["veteran"],
    likelyPathways: ["irspa_payment_plan", "treasurer_direct_contact"],
    missingDocuments: ["service_documentation"],
    demoOutcome: "Veteran pathway: no-down-payment Treasurer plan (DD-214), source-backed ACTIVE; sunset status of IRSPA rate confirmed with WCTO.",
  },
  {
    id: "wc-009",
    name: "Charlene Okafor",
    phone: "313-555-0188",
    address: "5583 Winthrop Street",
    municipality: "Detroit",
    parcelId: "18-006654-771",
    ownerOccupied: true,
    preStatus: "yes",
    delinquentYears: [2024, 2025],
    foreclosureStage: "forfeited",
    balanceDueDemo: 7220,
    noticesReceived: ["delinquency_notice"],
    householdSignals: ["medical_burden", "low_income", "unemployed"],
    likelyPathways: ["detroit_hope_screening", "dooe_hardship_review", "document_collection"],
    missingDocuments: ["proof_of_income", "photo_id", "hardship_documentation"],
    demoOutcome: "Hardship + incomplete documents: checklist built, uploads collected over time, reminder scheduled.",
  },
  {
    id: "wc-010",
    name: "Priya Natarajan",
    phone: "734-555-0190",
    address: "1433 Lakepointe Boulevard",
    municipality: "Livonia",
    parcelId: "46-552310-118",
    ownerOccupied: true,
    preStatus: "yes",
    delinquentYears: [2025],
    foreclosureStage: "delinquent",
    balanceDueDemo: 1240,
    noticesReceived: [],
    householdSignals: [],
    likelyPathways: ["payment_path", "irspa_payment_plan"],
    missingDocuments: [],
    demoOutcome: "Wants to pay today: demo payment completed with fake confirmation.",
  },
];

export function findDemoResident(query: string): DemoResident | undefined {
  const q = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return undefined;
  const qDigits = q.replace(/\D/g, "");
  return DEMO_RESIDENTS.find((r) => {
    const addr = `${r.address} ${r.municipality}`.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const streetWords = r.address.toLowerCase().split(" ").filter((w) => w.length > 3);
    const number = r.address.match(/^\d+/)?.[0];
    const numberHit = number ? q.includes(number) : false;
    const streetHit = streetWords.some((w) => q.includes(w));
    const parcelDigits = r.parcelId.replace(/\D/g, "");
    return (
      (parcelDigits.length >= 8 && qDigits.includes(parcelDigits)) ||
      (numberHit && streetHit) ||
      (streetHit && q.includes(r.municipality.toLowerCase())) ||
      addr.includes(q)
    );
  });
}
