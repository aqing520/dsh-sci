import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderOptions } from "./provider.js";

export interface ProviderProfile {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

export const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: "tokenfans-codex",
    label: "TokenFans Codex",
    baseUrl: "https://tokenfans.ai/codex",
    model: "gpt-6.1-sol",
    apiKeyEnv: "DSH_SCI_TOKENFANS_API_KEY",
  },
  {
    id: "openai",
    label: "OpenAI Responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "http://localhost:8000/v1",
    model: "gpt-4.1-mini",
    apiKeyEnv: "DSH_SCI_API_KEY",
  },
];

export interface ProviderSelection extends ProviderOptions {
  providerId: string;
  label: string;
}

async function readDotEnv(workspace: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(path.join(workspace, ".env.local"), "utf8");
    const values: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return values;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function readJsonConfig(file: string | undefined): Promise<Record<string, string>> {
  if (!file) return {};
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Record<string, string>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadProviderSelection(options: {
  workspace: string;
  providerId?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  configFile?: string;
}): Promise<ProviderSelection> {
  const candidates = options.configFile ? [options.configFile] : [
    path.join(options.workspace, "dsh-sci.config.json"),
    path.join(options.workspace, "config", "dsh-sci.config.json"),
    path.join(process.cwd(), "dsh-sci.config.json"),
  ];
  let fileConfig: Record<string, string> = {};
  for (const candidate of candidates) {
    fileConfig = await readJsonConfig(candidate);
    if (Object.keys(fileConfig).length > 0) break;
  }
  const dotEnv = await readDotEnv(options.workspace);
  const env = { ...fileConfig, ...dotEnv, ...process.env };
  const providerId = options.providerId ?? env.DSH_SCI_PROVIDER ?? env.provider ?? "tokenfans-codex";
  const profile = PROVIDER_PROFILES.find((item) => item.id === providerId) ?? PROVIDER_PROFILES[2];
  const apiKey = options.apiKey ?? env.DSH_SCI_API_KEY ?? env.DSH_SCI_TOKENFANS_API_KEY ?? env.apiKey ?? env[profile.apiKeyEnv];
  return {
    providerId: profile.id,
    label: profile.label,
    baseUrl: options.baseUrl ?? env.DSH_SCI_BASE_URL ?? env.baseUrl ?? profile.baseUrl,
    model: options.model ?? env.DSH_SCI_MODEL ?? env.model ?? profile.model,
    apiKey,
  };
}
