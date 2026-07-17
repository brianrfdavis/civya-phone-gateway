import { CIVYA_INSTRUCTIONS } from "@/lib/realtime/persona";

/**
 * Runtime addendum — key Wayne County facts only, one line each.
 * Full source-backed detail stays in knowledgeBase.ts (build-time
 * grounding + tool responses), NOT in the live prompt.
 */
export const WAYNE_COUNTY_ADDENDUM = `
WAYNE COUNTY LAUNCH CONTEXT:
- Program and foreclosure timelines can change. Speak a date, availability
  status, rate, address, phone number, or deadline only when it is present in
  the current server-approved response.
- HOPE, PAYS, payment plans, hardship review, surplus claims, and legal-aid
  referrals are possible topics, not promises or eligibility decisions.
- Never infer provider activation from this prompt. The server-approved
  response states whether a step is synthetic, pending, or source-confirmed.
`.trim();

export const WAYNE_COUNTY_SYSTEM_PROMPT = `${CIVYA_INSTRUCTIONS}\n\n${WAYNE_COUNTY_ADDENDUM}`;

const PRODUCTION_INSTRUCTIONS = CIVYA_INSTRUCTIONS.replace(
  "When an adapter is synthetic, label its\ncallbacks, submissions, payments, and staff queues as simulated. Never infer\nthat a hosted return means an external action completed.",
  "Describe a callback, submission, payment, or staff request as completed only\nwhen the current server-approved response contains authoritative confirmation.\nNever infer that a hosted return means an external action completed.",
);

export const PRODUCTION_WAYNE_COUNTY_SYSTEM_PROMPT = `${PRODUCTION_INSTRUCTIONS}\n\n${WAYNE_COUNTY_ADDENDUM.replace(
  "whether a step is synthetic, pending, or source-confirmed.",
  "whether a step is available, pending, or source-confirmed.",
)}`;
