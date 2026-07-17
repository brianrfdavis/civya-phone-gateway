export const VOICE_RESPONSE_MODES = ["fast", "legacy_fast", "authoritative"] as const;

export type VoiceResponseMode = (typeof VOICE_RESPONSE_MODES)[number];

export interface VoiceModeSelection {
  requested: VoiceResponseMode;
  effective: VoiceResponseMode;
  forcedAuthoritative: boolean;
}

export function parseVoiceResponseMode(value?: string | null): VoiceResponseMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "fast";
  if ((VOICE_RESPONSE_MODES as readonly string[]).includes(normalized)) {
    return normalized as VoiceResponseMode;
  }
  throw new Error(
    `CIVYA_VOICE_MODE must be one of ${VOICE_RESPONSE_MODES.join(", ")}.`,
  );
}

export function resolveVoiceResponseMode(input: {
  configuredMode?: string | null;
  syntheticMode: boolean;
  environment: string;
}): VoiceModeSelection {
  const requested = parseVoiceResponseMode(input.configuredMode);
  const forcedAuthoritative = !input.syntheticMode || input.environment === "production";
  return {
    requested,
    effective: forcedAuthoritative ? "authoritative" : requested,
    forcedAuthoritative,
  };
}

export function isDirectVoiceMode(mode: VoiceResponseMode): boolean {
  return mode === "fast" || mode === "legacy_fast";
}

export function isVoiceResponseMode(value: unknown): value is VoiceResponseMode {
  return typeof value === "string" &&
    (VOICE_RESPONSE_MODES as readonly string[]).includes(value);
}
