import type { VoiceResponseMode } from "./mode";
import {
  FAST_REALTIME_TOOLS,
  LEGACY_FAST_REALTIME_TOOLS,
  REALTIME_TOOLS,
} from "./tools";
import {
  FAST_WAYNE_COUNTY_SYSTEM_PROMPT,
  LEGACY_FAST_WAYNE_COUNTY_SYSTEM_PROMPT,
  WAYNE_COUNTY_SYSTEM_PROMPT,
} from "@/lib/wayne-county/systemPrompt";

export interface RealtimeVoiceProfile {
  mode: VoiceResponseMode;
  version: string;
  instructions: string;
  tools: readonly unknown[];
  automaticResponseCreation: boolean;
  turnDetection: {
    type: "server_vad";
    threshold: 0.5;
    prefix_padding_ms: 300;
    silence_duration_ms: 500;
    create_response: boolean;
    interrupt_response: true;
  };
}

function turnDetection(createResponse: boolean): RealtimeVoiceProfile["turnDetection"] {
  return {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: createResponse,
    interrupt_response: true,
  };
}

export const REALTIME_VOICE_PROFILES: Readonly<Record<VoiceResponseMode, RealtimeVoiceProfile>> =
  Object.freeze({
    fast: Object.freeze({
      mode: "fast",
      version: "fast-v1-2026-07-17",
      instructions: FAST_WAYNE_COUNTY_SYSTEM_PROMPT,
      tools: FAST_REALTIME_TOOLS,
      automaticResponseCreation: true,
      turnDetection: Object.freeze(turnDetection(true)),
    }),
    legacy_fast: Object.freeze({
      mode: "legacy_fast",
      version: "legacy-fast-compat-v1-2026-07-17",
      instructions: LEGACY_FAST_WAYNE_COUNTY_SYSTEM_PROMPT,
      tools: LEGACY_FAST_REALTIME_TOOLS,
      automaticResponseCreation: true,
      turnDetection: Object.freeze(turnDetection(true)),
    }),
    authoritative: Object.freeze({
      mode: "authoritative",
      version: "authoritative-v1-2026-07-16",
      instructions: WAYNE_COUNTY_SYSTEM_PROMPT,
      tools: REALTIME_TOOLS,
      automaticResponseCreation: false,
      turnDetection: Object.freeze(turnDetection(false)),
    }),
  });

export function getRealtimeVoiceProfile(mode: VoiceResponseMode): RealtimeVoiceProfile {
  return REALTIME_VOICE_PROFILES[mode];
}
