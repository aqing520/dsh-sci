import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderKind } from "./provider.js";

export interface RuntimeProviderSettings {
  provider?: ProviderKind;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export interface RuntimeServiceSettings {
  provider?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
}

export interface RuntimeSettings {
  schema: "dsh-sci.runtime-settings.v1";
  provider: RuntimeProviderSettings;
  service: RuntimeServiceSettings;
}

const SCHEMA = "dsh-sci.runtime-settings.v1" as const;
const PROVIDERS = new Set<ProviderKind>(["tokenfans-codex", "openai", "custom"]);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
  return value.trim();
}

function endpoint(value: unknown, name: string): string | undefined {
  const text = optionalString(value, name, 512);
  if (text === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(text); }
  catch { throw new Error(`${name} must be an HTTP(S) URL`); }
  if (!/^https?:$/iu.test(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${name} must be an HTTP(S) URL without embedded credentials`);
  parsed.search = "";
  parsed.hash = "";
  return `${parsed.origin}${parsed.pathname}`.replace(/\/$/u, "") || parsed.origin;
}

function timeout(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 1_000 || number > 600_000) throw new Error(`${name} must be an integer between 1000 and 600000`);
  return number;
}

function retries(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 5) throw new Error("service.retries must be an integer between 0 and 5");
  return number;
}

function provider(value: unknown): ProviderKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !PROVIDERS.has(value as ProviderKind)) throw new Error("provider.provider is not supported");
  return value as ProviderKind;
}

export function defaultRuntimeSettings(): RuntimeSettings {
  return { schema: SCHEMA, provider: {}, service: {} };
}

/** Validate and normalize non-sensitive desktop settings, without accepting credentials. */
export function updateRuntimeSettings(current: RuntimeSettings, input: unknown): RuntimeSettings {
  const root = objectValue(input);
  const providerInput = objectValue(root.provider);
  const serviceInput = objectValue(root.service);
  const next: RuntimeSettings = { schema: SCHEMA, provider: { ...current.provider }, service: { ...current.service } };
  const providerValue = providerInput.provider;
  const baseUrl = endpoint(providerInput.baseUrl, "provider.baseUrl");
  const model = optionalString(providerInput.model, "provider.model", 128);
  const providerTimeout = timeout(providerInput.timeoutMs, "provider.timeoutMs");
  const serviceProvider = optionalString(serviceInput.provider, "service.provider", 64);
  const serviceBaseUrl = endpoint(serviceInput.baseUrl, "service.baseUrl");
  const serviceTimeout = timeout(serviceInput.timeoutMs, "service.timeoutMs");
  const serviceRetries = retries(serviceInput.retries);
  if (providerInput.provider !== undefined) next.provider.provider = provider(providerValue);
  if (providerInput.baseUrl !== undefined) next.provider.baseUrl = baseUrl;
  if (providerInput.model !== undefined) next.provider.model = model;
  if (providerInput.timeoutMs !== undefined) next.provider.timeoutMs = providerTimeout;
  if (serviceInput.provider !== undefined) next.service.provider = serviceProvider;
  if (serviceInput.baseUrl !== undefined) next.service.baseUrl = serviceBaseUrl;
  if (serviceInput.timeoutMs !== undefined) next.service.timeoutMs = serviceTimeout;
  if (serviceInput.retries !== undefined) next.service.retries = serviceRetries;
  return next;
}

export function runtimeSettingsToEnvironment(settings: RuntimeSettings): Record<string, string> {
  const environment: Record<string, string> = {};
  if (settings.provider.provider !== undefined) environment.DSH_SCI_PROVIDER = settings.provider.provider;
  if (settings.provider.baseUrl !== undefined) environment.DSH_SCI_BASE_URL = settings.provider.baseUrl;
  if (settings.provider.model !== undefined) environment.DSH_SCI_MODEL = settings.provider.model;
  if (settings.provider.timeoutMs !== undefined) environment.DSH_SCI_PROVIDER_TIMEOUT_MS = String(settings.provider.timeoutMs);
  if (settings.service.provider !== undefined) environment.DSH_SCI_SERVICE_PROVIDER = settings.service.provider;
  if (settings.service.baseUrl !== undefined) environment.DSH_SCI_SERVICE_BASE_URL = settings.service.baseUrl;
  if (settings.service.timeoutMs !== undefined) environment.DSH_SCI_SERVICE_TIMEOUT_MS = String(settings.service.timeoutMs);
  if (settings.service.retries !== undefined) environment.DSH_SCI_SERVICE_RETRIES = String(settings.service.retries);
  return environment;
}

export async function loadRuntimeSettings(file: string): Promise<RuntimeSettings> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { schema?: unknown }).schema !== SCHEMA) throw new Error("runtime settings: unexpected schema");
    return updateRuntimeSettings(defaultRuntimeSettings(), parsed);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultRuntimeSettings();
    throw error;
  }
}

export async function saveRuntimeSettings(file: string, settings: RuntimeSettings): Promise<void> {
  const normalized = updateRuntimeSettings(defaultRuntimeSettings(), settings);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
