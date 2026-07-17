import type { KnowledgeItem } from "@/lib/types";

/** Normalize an utterance for exact/near-exact comparison. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ExactMatch {
  item: KnowledgeItem;
  utterance: string;
}

/**
 * Layer 1: exact / near-exact match against each item's example utterances.
 * "Near-exact" = normalized equality, or one string containing the other when
 * both are reasonably short (handles "can i get on a payment plan please").
 */
export function exactMatch(
  userText: string,
  items: KnowledgeItem[],
): ExactMatch | null {
  const q = normalize(userText);
  if (!q) return null;
  for (const item of items) {
    for (const u of item.example_utterances) {
      const cand = normalize(u);
      if (q === cand) return { item, utterance: u };
      // Near-exact containment: only when lengths are close enough that the
      // extra words are filler, not a different question.
      const shorter = q.length < cand.length ? q : cand;
      const longer = q.length < cand.length ? cand : q;
      if (
        shorter.length >= 8 &&
        longer.includes(shorter) &&
        longer.length - shorter.length <= 12
      ) {
        return { item, utterance: u };
      }
    }
  }
  return null;
}
