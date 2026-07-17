import type { WorkflowState, WorkflowStepResult } from "@/lib/types";
// Static import so the JSON is bundled into serverless functions.
import guidedIntake from "@/data/workflows/guided-intake.json";

type WorkflowOutcome = NonNullable<WorkflowState["outcome"]> & { id: string };

interface WorkflowDef {
  id: string;
  start: string;
  states: WorkflowState[];
  outcomes: WorkflowOutcome[];
}

function load(): WorkflowDef {
  return guidedIntake as unknown as WorkflowDef;
}

/** Map a free-form spoken answer onto one of a state's expected keys. */
function interpretAnswer(state: WorkflowState, answer: string): string {
  const a = answer.toLowerCase();
  const keys = Object.keys(state.next ?? {});

  const yesWords = ["yes", "yeah", "yep", "i am", "i do", "correct", "right", "sure"];
  const noWords = ["no", "nope", "not", "don't", "dont", "never"];

  // "Not behind at all" must be checked before key words like "current",
  // which would otherwise match inside "I am current on my taxes".
  if (
    keys.includes("none") &&
    /\b(not behind|neither|nothing owed|current on|paid up|up to date)\b/.test(a)
  ) {
    return "none";
  }

  // Direct key mention wins ("both", "prior", "detroit", "hope"...).
  for (const k of keys) {
    if (k !== "yes" && k !== "no" && k !== "other" && a.includes(k)) return k;
  }
  if (keys.includes("deceased") && /(died|passed|deceased|late )/.test(a)) {
    return "deceased";
  }
  if (keys.includes("family_living") && /(mother|father|mom|dad|sister|brother|aunt|uncle|grand|family)/.test(a)) {
    return "family_living";
  }
  if (keys.includes("detroit")) {
    return a.includes("detroit") ? "detroit" : "other";
  }
  if (keys.includes("yes") && yesWords.some((w) => a.includes(w))) return "yes";
  if (keys.includes("no") && noWords.some((w) => a.includes(w))) return "no";
  return keys.includes("other") ? "other" : keys[0];
}

/**
 * Advance the guided intake. Pass current_state="" to start.
 * Deterministic: the model narrates, this engine decides.
 */
export function nextStep(
  currentStateId: string,
  userAnswer: string,
): WorkflowStepResult {
  const wf = load();

  if (!currentStateId) {
    const start = wf.states.find((s) => s.id === wf.start)!;
    return { state_id: start.id, question: start.question, done: false };
  }

  const state = wf.states.find((s) => s.id === currentStateId);
  if (!state || !state.next) {
    return { state_id: currentStateId, done: true };
  }

  const key = interpretAnswer(state, userAnswer);
  const target = state.next[key] ?? Object.values(state.next)[0];

  if (target.startsWith("outcome:")) {
    const outcomeId = target.slice("outcome:".length);
    const outcome = wf.outcomes.find((o) => o.id === outcomeId);
    return {
      state_id: target,
      done: true,
      outcome: outcome as WorkflowStepResult["outcome"],
    };
  }

  const nextState = wf.states.find((s) => s.id === target)!;
  return { state_id: nextState.id, question: nextState.question, done: false };
}
