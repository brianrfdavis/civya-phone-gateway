import { resolveAnswer } from "@/lib/cache/resolver";
import { findDemoResident } from "@/lib/wayne-county/demoResidents";
import type { ConfirmedFact, ResumeContext } from "./contracts";

export interface IntakeQuestion {
  key: string;
  question: string;
  sensitive: boolean;
}

export interface CapturedFact {
  key: string;
  value: string;
  displayValue: string;
}

export type EngineDecision =
  | { kind: "general_answer"; answer: string; nextQuestion?: IntakeQuestion }
  | { kind: "capture_fact"; fact: CapturedFact; nextQuestion?: IntakeQuestion; acknowledgement: string }
  | { kind: "clarify_fact"; question: IntakeQuestion; answer: string }
  | { kind: "end"; answer: string };

export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  { key: "property_address", question: "What's the address of the property?", sensitive: true },
  { key: "resident_name", question: "Can I get your first and last name?", sensitive: true },
  { key: "contact", question: "What's the best phone number or email to use if we need to follow up?", sensitive: true },
  { key: "owner_occupancy", question: "Are you currently living in the home?", sensitive: false },
  { key: "municipality", question: "Which city or township is the property in?", sensitive: false },
  { key: "notice_type", question: "What kind of tax notice, if any, did you receive?", sensitive: false },
  { key: "delinquency_years", question: "Which tax years are still unpaid?", sensitive: false },
  { key: "hardship", question: "What has made it hard to keep up with the taxes?", sensitive: false },
  { key: "income_range", question: "About what is the household's monthly income range?", sensitive: true },
  { key: "household_size", question: "How many people live in the household?", sensitive: false },
];

export const INTAKE_FACT_KEYS = new Set(INTAKE_QUESTIONS.map((question) => question.key));

const ENDING = /\b(?:end the conversation|i(?:'m| am) done|goodbye|stop now|that's all)\b/i;
const ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9\s.'-]{1,50}\b(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|place|pl|parkway|pkwy)\b[^.!?\n]*/i;
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

export function factsMap(facts: ConfirmedFact[]): Record<string, string> {
  return Object.fromEntries(facts.map((fact) => [fact.key, fact.value]));
}

export function nextIntakeQuestion(context: ResumeContext): IntakeQuestion | undefined {
  const facts = factsMap(context.confirmed_facts);
  const question = INTAKE_QUESTIONS.find((candidate) => !facts[candidate.key]);
  if (!question) return undefined;
  if (question.key === "owner_occupancy" && facts.property_address) {
    return { ...question, question: `Are you currently living in the home at ${facts.property_address}?` };
  }
  return question;
}

const NON_ANSWER_OPENING = /^(?:why|what|which|who|where|when|how|can|could|would|will|do|does|did|is|are|am|may|should)\b/i;
const REFUSAL = /\b(?:prefer not|rather not|don't want|do not want|won't share|will not share|not comfortable|skip (?:it|that)|none of your business)\b/i;
const REPAIR = /\b(?:say that again|repeat (?:that|the question)|what did you (?:say|ask)|didn't (?:hear|understand)|not what i said|that's not what i said)\b/i;

export function isLikelyNonAnswer(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  return value.endsWith("?") || NON_ANSWER_OPENING.test(value) || REFUSAL.test(value) || REPAIR.test(value);
}

export function normalizeIntakeFact(field: string, sourceText: string): CapturedFact | null {
  const question = INTAKE_QUESTIONS.find((candidate) => candidate.key === field);
  if (!question || isLikelyNonAnswer(sourceText)) return null;
  return normalizedFact(question, sourceText);
}

function normalizedFact(question: IntakeQuestion, transcript: string): CapturedFact | null {
  const value = transcript.trim().replace(/[.!?]+$/, "").trim();
  if (!value) return null;

  switch (question.key) {
    case "property_address": {
      const address = value.match(ADDRESS)?.[0]?.replace(/^(?:it(?:'s| is)|the address is|my address is)\s+/i, "").trim();
      return address && address.length >= 8
        ? { key: question.key, value: address.slice(0, 160), displayValue: address }
        : null;
    }
    case "resident_name": {
      const name = value.replace(/^(?:my name is|i am|i'm|it's)\s+/i, "").trim();
      const parts = name.split(/\s+/).filter(Boolean);
      return parts.length >= 2 && parts.every((part) => /^[A-Za-zÀ-ž.'-]+$/.test(part))
        ? { key: question.key, value: parts.join(" ").slice(0, 120), displayValue: parts.join(" ") }
        : null;
    }
    case "contact": {
      const contact = value.match(EMAIL)?.[0] || value.match(PHONE)?.[0];
      return contact ? { key: question.key, value: contact, displayValue: contact } : null;
    }
    case "owner_occupancy": {
      if (/\b(?:yes|yeah|yep|i do|living there|live there)\b/i.test(value)) {
        return { key: question.key, value: "owner_occupant", displayValue: "Yes" };
      }
      if (/\b(?:heir|inherited|passed away|deceased)\b/i.test(value)) {
        return { key: question.key, value: "heir", displayValue: "Heir or inherited property" };
      }
      if (/\b(?:no|don't|do not|not living|tenant|renter)\b/i.test(value)) {
        return { key: question.key, value: "occupant_non_owner", displayValue: "No" };
      }
      return null;
    }
    case "delinquency_years": {
      const years = value.match(/20\d{2}/g);
      return years?.length
        ? { key: question.key, value: [...new Set(years)].join(", "), displayValue: [...new Set(years)].join(", ") }
        : { key: question.key, value: value.slice(0, 120), displayValue: value };
    }
    case "household_size": {
      const count = value.match(/\b\d{1,2}\b/)?.[0];
      return count ? { key: question.key, value: count, displayValue: count } : null;
    }
    case "municipality": {
      const municipality = value
        .replace(/^(?:no[,\s]+)?(?:i (?:live|am) in|it's|it is|the (?:city|township) is)\s+/i, "")
        .trim();
      return municipality
        ? { key: question.key, value: municipality.slice(0, 120), displayValue: municipality.slice(0, 120) }
        : null;
    }
    default:
      return { key: question.key, value: value.slice(0, 500), displayValue: value.slice(0, 160) };
  }
}

export async function decideTurn(input: {
  transcript: string;
  context: ResumeContext;
  forcePendingQuestion?: boolean;
  safetyIdentifier?: string;
  fictional?: boolean;
}): Promise<EngineDecision> {
  const text = input.transcript.trim();
  const next = nextIntakeQuestion(input.context);
  const fictional = input.fictional !== false;

  if (ENDING.test(text)) {
    const nextLine = next
      ? `Your next step is: ${next.question}`
      : fictional
        ? "Your intake is complete for this fictional demo."
        : "Your intake is complete.";
    return { kind: "end", answer: `I've saved your progress. ${nextLine} You can come back any time and we'll pick up here. Take care.` };
  }

  if (!input.forcePendingQuestion) {
    const cached = await resolveAnswer(text, "voice", { safetyIdentifier: input.safetyIdentifier });
    if ((cached.hit || cached.escalated) && cached.answer) {
      return { kind: "general_answer", answer: cached.answer, nextQuestion: next };
    }
  }

  if (!next) {
    const cached = await resolveAnswer(text, "voice", { safetyIdentifier: input.safetyIdentifier });
    const answer = (cached.hit || cached.escalated) && cached.answer
      ? cached.answer
      : fictional
        ? "I can help explain the fictional county process, but a person must review any legal, title, or eligibility decision."
        : "I can help explain the Wayne County process, but an authorized person must review any legal, title, or eligibility decision.";
    return { kind: "general_answer", answer };
  }

  const fact = normalizedFact(next, text);
  if (!fact) {
    return {
      kind: "clarify_fact",
      question: next,
      answer: `I want to make sure I heard that correctly. ${next.question}`,
    };
  }

  const projectedContext: ResumeContext = {
    ...input.context,
    confirmed_facts: [
      ...input.context.confirmed_facts.filter((item) => item.key !== fact.key),
      { key: fact.key, value: fact.value, confirmed_at: new Date().toISOString() },
    ],
  };
  const following = nextIntakeQuestion(projectedContext);
  let acknowledgement = "Thank you. I saved that.";
  if (fact.key === "property_address") {
    if (fictional) {
      const matched = findDemoResident(fact.value);
      acknowledgement = matched
        ? `I found the fictional demo property in ${matched.municipality}. I saved the address.`
        : "Thank you. I saved that address.";
    } else {
      acknowledgement = "Thank you. I saved that address.";
    }
  }

  return { kind: "capture_fact", fact, nextQuestion: following, acknowledgement };
}

export function confirmedFactsSummary(facts: ConfirmedFact[]): string {
  if (!facts.length) return "No personal intake facts have been confirmed yet.";
  return facts.map((fact) => `${fact.key.replace(/_/g, " ")}: ${fact.value}`).join("; ");
}
