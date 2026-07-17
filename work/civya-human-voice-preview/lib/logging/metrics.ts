import type { LoggedEvent } from "@/lib/types";

export interface TurnRow {
  ts: string;
  session_id: string;
  turn_id: string;
  user_text?: string;
  intent?: string;
  layer?: string;
  match_method?: string;
  model?: string;
  speech_to_first_audio_ms?: number;
  resolve_ms?: number;
  total_ms?: number;
  tools_called?: string[];
  escalated?: boolean;
  error?: string;
}

export interface Summary {
  total_turns: number;
  cache_hits: number;
  cache_hit_rate: number;
  avg_first_audio_ms: number | null;
  avg_cache_hit_ms: number | null;
  avg_model_ms: number | null;
  avg_profile_lookup_ms: number | null;
  slowest_first_audio_ms: number | null;
  error_count: number;
  error_rate: number;
  sessions: number;
  sessions_with_next_step: number;
  sessions_with_doc_checklist: number;
  sessions_with_human_followup: number;
  guided_action_rate: number;
}

/** Fold raw events into per-turn rows keyed by turn_id. */
export function turnRows(all: LoggedEvent[]): TurnRow[] {
  const turns = new Map<string, TurnRow>();
  for (const e of all) {
    const id = (e.turn_id as string) || "";
    if (!id) continue;
    const row =
      turns.get(id) ??
      ({ ts: e.ts, session_id: e.session_id, turn_id: id, tools_called: [] } as TurnRow);
    row.ts = row.ts || e.ts;
    switch (e.type) {
      case "turn_resolved":
        row.user_text = e.user_text as string;
        row.intent = e.intent as string | undefined;
        row.layer = e.layer as string;
        row.match_method = e.match_method as string | undefined;
        row.resolve_ms = e.resolve_ms as number;
        row.escalated = Boolean(e.escalated);
        break;
      case "latency":
        if (e.event_type === "speech_to_first_audio") {
          row.speech_to_first_audio_ms = e.milliseconds as number;
        } else if (e.event_type === "turn_total") {
          row.total_ms = e.milliseconds as number;
        }
        break;
      case "tool_called":
        row.tools_called!.push(e.tool as string);
        break;
      case "model_used":
        row.model = e.model as string;
        break;
      case "error":
        row.error = String(e.message ?? "error");
        break;
    }
    turns.set(id, row);
  }
  return [...turns.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export function summarize(events: LoggedEvent[]): { rows: TurnRow[]; summary: Summary } {
  const rows = turnRows(events);

  const cacheLayers = new Set(["L1_exact", "L2_semantic", "L3_workflow"]);
  const hits = rows.filter((r) => r.layer && cacheLayers.has(r.layer));
  const misses = rows.filter((r) => r.layer === "L4_model");
  const firstAudio = rows
    .map((r) => r.speech_to_first_audio_ms)
    .filter((n): n is number => typeof n === "number");

  const profileLookups = events
    .filter((e) => e.type === "latency" && e.event_type === "profile_lookup")
    .map((e) => e.milliseconds as number);

  // Session universe = every session seen in ANY event, so guided-action
  // events from sessions without turn rows can never push the rate past 1.
  const sessions = new Set(
    events.map((e) => e.session_id).filter((s) => s && s !== "unknown"),
  );
  const byType = (t: string) =>
    new Set(
      events
        .filter((e) => e.type === t && sessions.has(e.session_id))
        .map((e) => e.session_id),
    );
  const withNextStep = byType("next_step_delivered");
  const withChecklist = byType("doc_checklist_delivered");
  const withFollowup = byType("human_followup_created");
  const withGuidedAction = new Set([
    ...withNextStep,
    ...withChecklist,
    ...withFollowup,
  ]);

  const errors = rows.filter((r) => r.error).length;

  const summary: Summary = {
    total_turns: rows.length,
    cache_hits: hits.length,
    cache_hit_rate: rows.length ? hits.length / rows.length : 0,
    avg_first_audio_ms: avg(firstAudio),
    avg_cache_hit_ms: avg(
      hits
        .map((r) => r.speech_to_first_audio_ms)
        .filter((n): n is number => typeof n === "number"),
    ),
    avg_model_ms: avg(
      misses
        .map((r) => r.speech_to_first_audio_ms)
        .filter((n): n is number => typeof n === "number"),
    ),
    avg_profile_lookup_ms: avg(profileLookups),
    slowest_first_audio_ms: firstAudio.length ? Math.max(...firstAudio) : null,
    error_count: errors,
    error_rate: rows.length ? errors / rows.length : 0,
    sessions: sessions.size,
    sessions_with_next_step: withNextStep.size,
    sessions_with_doc_checklist: withChecklist.size,
    sessions_with_human_followup: withFollowup.size,
    guided_action_rate: sessions.size ? withGuidedAction.size / sessions.size : 0,
  };

  return { rows, summary };
}
