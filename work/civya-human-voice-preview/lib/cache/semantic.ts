import type { KnowledgeItem } from "@/lib/types";
import { redactTranscript } from "@/lib/platform/redaction";
import { normalize } from "./exact";

/**
 * Layer 2: semantic match. Primary path embeds intent exemplars with the
 * OpenAI embeddings API (computed once, held in memory — a few dozen vectors
 * need no vector DB). If embeddings are unavailable (no key / network), it
 * degrades to keyword-overlap (Jaccard) scoring so the demo still works.
 */

interface Exemplar {
  intent: string;
  utterance: string;
  vector?: number[];
}

let exemplars: Exemplar[] | null = null;
let embeddingsReady = false;
let initPromise: Promise<void> | null = null;
let embeddingRetryAfter = 0;

const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const configuredEmbeddingTimeout = Number(process.env.CIVYA_EMBEDDING_TIMEOUT_MS || 700);
const EMBEDDING_TIMEOUT_MS = Math.max(
  250,
  Math.min(Number.isFinite(configuredEmbeddingTimeout) ? configuredEmbeddingTimeout : 700, 1_500),
);
const SAFETY_IDENTIFIER = /^[A-Za-z0-9_-]{8,64}$/;

async function embed(texts: string[], safetyIdentifier: string): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  if (!SAFETY_IDENTIFIER.test(safetyIdentifier)) {
    throw new Error("A stable privacy-preserving safety identifier is required for embeddings.");
  }
  const redactedInputs = texts.map((text) => redactTranscript(text).slice(0, 2_000));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: redactedInputs,
          // Embeddings uses `user` for its privacy-preserving end-user safety id.
          user: safetyIdentifier,
        }),
      });
      if (!res.ok) {
        const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
        if (attempt === 0 && retryable) continue;
        throw new Error(`Embeddings API ${res.status}`);
      }
      const json = (await res.json()) as {
        data?: { index: number; embedding: number[] }[];
      };
      const vectors = (json.data ?? [])
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.embedding);
      if (
        vectors.length !== redactedInputs.length
        || vectors.some((vector) => vector.length === 0 || vector.some((value) => !Number.isFinite(value)))
      ) {
        throw new Error("Embeddings API returned invalid vectors.");
      }
      return vectors;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw new Error("Embeddings API unavailable.");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccard(a: string, b: string): number {
  const sa = new Set(normalize(a).split(" ").filter(Boolean));
  const sb = new Set(normalize(b).split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Build (or reuse) the exemplar index for the given knowledge items. */
async function ensureIndex(items: KnowledgeItem[], safetyIdentifier?: string): Promise<void> {
  if (exemplars && embeddingsReady) return;
  if (!exemplars) {
    exemplars = items.flatMap((item) =>
      item.example_utterances.map((utterance) => ({ intent: item.intent, utterance })),
    );
  }
  if (!safetyIdentifier || !SAFETY_IDENTIFIER.test(safetyIdentifier) || Date.now() < embeddingRetryAfter) return;
  if (!initPromise) {
    initPromise = (async () => {
      const list = exemplars ?? [];
      try {
        const vectors = await embed(list.map((e) => e.utterance), safetyIdentifier);
        vectors.forEach((v, i) => (list[i].vector = v));
        embeddingsReady = true;
      } catch {
        // Embeddings unavailable — keyword fallback will be used.
        embeddingsReady = false;
        embeddingRetryAfter = Date.now() + 60_000;
      }
      exemplars = list;
    })().finally(() => {
      initPromise = null;
    });
  }
  await initPromise;
}

export interface SemanticMatch {
  intent: string;
  similarity: number;
  method: "embedding" | "keyword";
}

export async function semanticMatch(
  userText: string,
  items: KnowledgeItem[],
  options: { safetyIdentifier?: string; allowExternal?: boolean } = {},
): Promise<SemanticMatch | null> {
  const safetyIdentifier = options.allowExternal ? options.safetyIdentifier : undefined;
  await ensureIndex(items, safetyIdentifier);
  if (!exemplars || exemplars.length === 0) return null;

  if (
    options.allowExternal === true
    && embeddingsReady
    && Date.now() >= embeddingRetryAfter
    && safetyIdentifier
    && SAFETY_IDENTIFIER.test(safetyIdentifier)
  ) {
    try {
      const [qv] = await embed([userText], safetyIdentifier);
      let best: SemanticMatch | null = null;
      for (const e of exemplars) {
        if (!e.vector) continue;
        const sim = cosine(qv, e.vector);
        if (!best || sim > best.similarity) {
          best = { intent: e.intent, similarity: sim, method: "embedding" };
        }
      }
      return best;
    } catch {
      embeddingRetryAfter = Date.now() + 60_000;
      // fall through to keyword scoring on transient API failure
    }
  }

  let best: SemanticMatch | null = null;
  for (const e of exemplars) {
    const sim = jaccard(userText, e.utterance);
    if (!best || sim > best.similarity) {
      best = { intent: e.intent, similarity: sim, method: "keyword" };
    }
  }
  return best;
}

/** Confidence threshold per method (keyword overlap needs a lower bar). */
export function thresholdFor(method: "embedding" | "keyword"): number {
  if (method === "embedding") {
    return Number(process.env.CIVYA_CACHE_THRESHOLD || 0.82);
  }
  return 0.5;
}
