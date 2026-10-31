import { loadProviderConfig } from "./provider.js";

/** Backward-compatible credential helper used by the desktop host. */
export async function loadTokenFansApiKey(options: { workspace: string; configFile?: string }): Promise<string | undefined> {
  const config = await loadProviderConfig(options);
  return config.apiKey;
}

export { loadProviderConfig } from "./provider.js";
export type { ProviderConfig, ProviderKind } from "./provider.js";
export { httpServiceConfigFromEnvironment, loadHttpServiceConfig } from "./services.js";
export type { HttpServiceConfig } from "./services.js";
