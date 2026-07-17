import type { KnowledgeItem } from "@/lib/types";
// Static imports so the JSON is bundled into serverless functions —
// dynamic fs reads are not traced by the Next.js build on Vercel.
import programs from "@/data/knowledge/programs.json";
import situations from "@/data/knowledge/situations.json";
import logistics from "@/data/knowledge/logistics.json";
import { APPROVED_ANSWERS } from "@/lib/wayne-county/approvedAnswers";
import { GUARDRAILS, PROGRAMS } from "@/lib/wayne-county/knowledgeBase";

let cache: KnowledgeItem[] | null = null;

/** Map Wayne County approved answers + programs into cacheable items. */
function wayneCountyItems(): KnowledgeItem[] {
  const answers: KnowledgeItem[] = APPROVED_ANSWERS.map((a) => ({
    intent: a.intent,
    approved_spoken_answer: a.spokenAnswer,
    long_answer: a.followUp ? `${a.spokenAnswer} ${a.followUp}` : a.spokenAnswer,
    disclaimer: GUARDRAILS.disclaimers.general,
    next_step_prompt: a.followUp ?? "",
    allowed_next_questions: [],
    escalation_triggers: a.escalate ? ["always"] : [],
    example_utterances: a.utterances,
    source_url: a.sourceUrl,
    last_reviewed: "2026-07-06",
    status: "draft",
    channels: { voice: true, sms: true, web: true },
  }));
  const existingIntents = new Set(answers.map((a) => a.intent));
  const programItems: KnowledgeItem[] = PROGRAMS.filter(
    (p) => !existingIntents.has(`program_${p.id}`),
  ).map((p) => ({
    intent: `program_${p.id}`,
    approved_spoken_answer: p.residentFacingApprovedAnswer,
    long_answer: p.residentFriendlySummary,
    disclaimer: GUARDRAILS.disclaimers.general,
    next_step_prompt: "",
    allowed_next_questions: [],
    escalation_triggers: [],
    example_utterances: [p.name, p.plainLanguageName],
    source_url: "https://treasurer.waynecounty.com",
    last_reviewed: "2026-07-06",
    status: p.sourceConfidence === "needs_verification" ? "draft" : "draft",
    channels: { voice: true, sms: true, web: true },
  }));
  return [...answers, ...programItems];
}

/** Load and validate every knowledge item. */
export function loadKnowledge(): KnowledgeItem[] {
  if (cache) return cache;
  const items = [
    ...(programs as KnowledgeItem[]),
    ...(situations as KnowledgeItem[]),
    ...(logistics as KnowledgeItem[]),
    ...wayneCountyItems(),
  ];
  for (const item of items) validate(item);
  cache = items;
  return items;
}

export function getByIntent(intent: string): KnowledgeItem | undefined {
  return loadKnowledge().find((k) => k.intent === intent);
}

function validate(item: KnowledgeItem): void {
  const required: (keyof KnowledgeItem)[] = [
    "intent",
    "approved_spoken_answer",
    "long_answer",
    "disclaimer",
    "next_step_prompt",
    "example_utterances",
    "source_url",
    "last_reviewed",
    "status",
    "channels",
  ];
  for (const key of required) {
    if (item[key] === undefined || item[key] === null) {
      throw new Error(`Knowledge item "${item.intent}" missing "${key}"`);
    }
  }
}
