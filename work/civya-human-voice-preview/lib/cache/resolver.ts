import type { CacheResult, KnowledgeItem } from "@/lib/types";
import {
  OpenAIResponsesIntentClassifier,
  type IntentDecision,
  type IntentTaxonomyItem,
} from "@/lib/integrations/openai-intent.server";
import { loadKnowledge } from "@/lib/knowledge/loader";
import { exactMatch, normalize } from "./exact";
import { semanticMatch, thresholdFor } from "./semantic";

/**
 * Layered answer resolution:
 *   L1 exact        — normalized (near-)exact match on example utterances
 *   L2 semantic     — embedding cosine (or keyword fallback) above threshold
 *   L5 human review — matched item that must always escalate, or trigger words
 *   L4 model        — miss: the Realtime model answers within persona limits
 * (L3, guided intake, is driven by the workflow engine, not this resolver.)
 */
export async function resolveAnswer(
  userText: string,
  channel: "voice" | "sms" | "web" = "voice",
  options: {
    safetyIdentifier?: string;
    environment?: string;
    languageMode?: string;
    classifyIntent?: (input: {
      residentText: string;
      taxonomy: readonly IntentTaxonomyItem[];
      safetyIdentifier: string;
    }) => Promise<IntentDecision>;
  } = {},
): Promise<CacheResult> {
  const t0 = performance.now();
  const environment = options.environment
    ?? process.env.CIVYA_ENVIRONMENT
    ?? (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production" ? "production" : "development");
  const items = loadKnowledge().filter((item) =>
    item.channels[channel] && (environment !== "production" || item.status === "approved")
  );

  // Hard escalation phrases checked before anything else.
  const escalationPhrases = [
    "sue",
    "lawsuit",
    "court date",
    "probate",
    "bankruptcy",
    "eviction",
  ];
  const q = normalize(userText);
  const languageMode = options.languageMode ?? process.env.CIVYA_LANGUAGE_MODE ?? "synthetic";

  if (escalationPhrases.some((p) => q.includes(p))) {
    return finish(
      {
        hit: false,
        layer: "L5_human_review",
        escalated: true,
        answer:
          "I don't want to guess on that — it may need human review. I can help collect the basic details so the right person can follow up.",
      },
      t0,
    );
  }

  const l1 = exactMatch(userText, items);
  if (l1) {
    return finish(hitFrom(l1.item, "L1_exact", 1, "exact"), t0);
  }

  const l2 = await semanticMatch(userText, items, {
    safetyIdentifier: options.safetyIdentifier,
    allowExternal: languageMode === "live",
  });
  if (l2 && l2.similarity >= thresholdFor(l2.method)) {
    const item = items.find((k) => k.intent === l2.intent);
    if (item) {
      return finish(
        hitFrom(item, "L2_semantic", l2.similarity, l2.method),
        t0,
      );
    }
  }

  if (languageMode === "live" && options.safetyIdentifier && items.length > 0) {
    try {
      const classify = options.classifyIntent ?? ((input) => new OpenAIResponsesIntentClassifier().classify(input));
      const decision = await classify({
        residentText: userText,
        taxonomy: items.map((item) => ({ intent: item.intent, examples: item.example_utterances })),
        safetyIdentifier: options.safetyIdentifier,
      });
      const requiresHumanReview = decision.requires_human_review
        || decision.reason_code === "sensitive"
        || decision.reason_code === "unsafe";
      if (requiresHumanReview) {
        return finish({
          hit: false,
          layer: "L5_human_review",
          escalated: true,
          answer: "I don't want to guess on that. A person should review it, and I can help preserve your place while they do.",
        }, t0);
      }
      if (decision.reason_code === "matched" && decision.intent && decision.confidence >= 0.85) {
        const item = items.find((candidate) => candidate.intent === decision.intent);
        if (item) return finish(hitFrom(item, "L4_model", decision.confidence, "model"), t0);
      }
    } catch {
      // A model outage, timeout, refusal, or invalid schema must not break the
      // resident turn. The caller receives the deterministic no-answer path.
    }
  }

  return finish({ hit: false, layer: "L4_model", escalated: false }, t0);
}

function hitFrom(
  item: KnowledgeItem,
  layer: CacheResult["layer"],
  similarity: number,
  method: "exact" | "embedding" | "keyword" | "model",
): Omit<CacheResult, "resolve_ms"> {
  // Items marked "always" escalate even on a cache hit (legal/title/estate):
  // the approved answer is still spoken, but the case is flagged.
  const alwaysEscalate = item.escalation_triggers.includes("always");
  return {
    hit: true,
    layer: alwaysEscalate ? "L5_human_review" : layer,
    intent: item.intent,
    answer: item.approved_spoken_answer,
    next_step_prompt: item.next_step_prompt,
    disclaimer: item.disclaimer,
    source_url: item.source_url,
    status: item.status,
    escalated: alwaysEscalate,
    similarity,
    match_method: method,
  };
}

function finish(
  partial: Omit<CacheResult, "resolve_ms">,
  t0: number,
): CacheResult {
  return { ...partial, resolve_ms: Math.round(performance.now() - t0) };
}
