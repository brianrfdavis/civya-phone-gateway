import type { RuntimeConfig } from "./runtime";

export interface PublicRuntimeConfig {
  environment: RuntimeConfig["environment"];
  releaseVersion: string;
  configVersion: string;
  syntheticMode: boolean;
  paused: boolean;
  channels: {
    residentWeb: boolean;
    browserVoice: boolean;
    pstn: boolean;
  };
}

export function toPublicRuntimeConfig(config: RuntimeConfig): PublicRuntimeConfig {
  return {
    environment: config.environment,
    releaseVersion: config.releaseVersion,
    configVersion: config.configVersion,
    syntheticMode: config.syntheticMode,
    paused: config.features.pauseAll,
    channels: {
      residentWeb: config.features.residentWeb,
      browserVoice: config.features.browserVoice,
      pstn: config.features.pstn,
    },
  };
}
