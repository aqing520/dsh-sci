import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { serializeMetadataJson } from "./metadata-crypto.js";
import { ProviderError, type ProviderErrorKind } from "./provider.js";

export interface SearchResult { title: string; url: string; snippet?: string; source?: string; }
export interface SearchProvider { readonly provider?: string; search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<{ results: SearchResult[]; provider: string }> }
export interface QuotaSnapshot { provider: string; status: "available" | "unknown"; remaining?: number; limit?: number; resetAt?: string; message?: string; }
export interface QuotaProvider { getQuota(signal?: AbortSignal): Promise<QuotaSnapshot> }

export interface BackupManifest {
  schema: "dsh-sci.backup-manifest.v1";
  manifestId: string;
  createdAt: string;
  projectId: string;
  workspaceSnapshotIds: string[];
  researchRunIds: string[];
  contentPolicy: "metadata-only";
}
export interface BackupPublisher { readonly provider?: string; publish(manifest: Omit<BackupManifest, "manifestId" | "createdAt">): Promise<{ manifest: BackupManifest; uploaded: boolean }> }

export interface HttpServiceConfig { baseUrl: string; apiKey: string; timeoutMs?: number; retries?: number; provider?: string; }
export interface HttpServiceClientOptions { config: HttpServiceConfig; fetchImpl?: typeof fetch; }

export function httpServiceConfigFromEnvironment(env: Record<string, string | undefined> = process.env): HttpServiceConfig {
  return {
    baseUrl: (env.DSH_SCI_SERVICE_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: env.DSH_SCI_SERVICE_API_KEY ?? "",
    timeoutMs: Math.max(1000, Number.parseInt(env.DSH_SCI_SERVICE_TIMEOUT_MS ?? "30000", 10) || 30000),
    retries: Math.max(0, Math.min(5, Number.parseInt(env.DSH_SCI_SERVICE_RETRIES ?? "2", 10) || 0)),
    provider: env.DSH_SCI_SERVICE_PROVIDER ?? "http",
  };
}

export async function loadHttpServiceConfig(options: { workspace: string; configFile?: string; env?: Record<string, string | undefined> }): Promise<HttpServiceConfig> {
  const fileValues: Record<string, string> = {};
  const candidates = options.configFile ? [options.configFile] : [path.join(options.workspace, "dsh-sci.config.json"), path.join(options.workspace, "config", "dsh-sci.config.json"), path.join(process.cwd(), "dsh-sci.config.json")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") fileValues[key] = value;
      if (Object.keys(fileValues).length) break;
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try {
    const text = await readFile(path.join(options.workspace, ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) fileValues[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const env = { ...fileValues, ...(options.env ?? process.env) };
  return httpServiceConfigFromEnvironment(env);
}

function baseUrl(value: string): string { return value.replace(/\/+$/, ""); }
function serviceKind(status: number): ProviderErrorKind { return status === 401 ? "authentication" : status === 403 ? "permission" : status === 429 ? "rate-limit" : status >= 500 ? "server" : "protocol"; }
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new DOMException("aborted", "AbortError")); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class HttpServiceClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: HttpServiceClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }
  get provider(): string { return this.options.config.provider ?? "http"; }
  async json<T>(endpoint: string, init: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string; allowEmpty?: boolean } = {}): Promise<T> {
    const config = this.options.config;
    if (!config.baseUrl || !config.apiKey) throw new ProviderError("configuration", "Service base URL and API key are required", { retryable: false });
    const retries = Math.max(0, Math.min(5, config.retries ?? 2));
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1000, config.timeoutMs ?? 30_000));
      const abort = () => controller.abort();
      if (init.signal?.aborted) controller.abort();
      init.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await this.fetchImpl(`${baseUrl(config.baseUrl)}${endpoint}`, { method: init.method ?? "GET", headers: { accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}), authorization: `Bearer ${config.apiKey}` }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal: controller.signal });
        if (!response.ok) {
          const error = new ProviderError(serviceKind(response.status), `Service request failed with HTTP ${response.status}`, { status: response.status });
          if (error.retryable && init.signal?.aborted !== true && attempt < retries) { await wait(250 * (2 ** attempt), init.signal); continue; }
          throw error;
        }
        try {
          if (init.allowEmpty) {
            const text = await response.text();
            return (text.trim() ? JSON.parse(text) : undefined) as T;
          }
          return await response.json() as T;
        } catch (error) { throw new ProviderError("protocol", "Service returned invalid JSON", { status: response.status, cause: error }); }
      } catch (error: unknown) {
        if (error instanceof ProviderError) { if (error.retryable && init.signal?.aborted !== true && attempt < retries) { await wait(250 * (2 ** attempt), init.signal); continue; } throw error; }
        const mapped = error instanceof DOMException && error.name === "AbortError" ? new ProviderError("timeout", "Service request timed out", { retryable: init.signal?.aborted !== true, cause: error }) : new ProviderError("network", "Service request failed", { retryable: init.signal?.aborted !== true, cause: error });
        if (init.signal?.aborted !== true && attempt < retries) { await wait(250 * (2 ** attempt), init.signal); continue; }
        throw mapped;
      } finally { clearTimeout(timeout); init.signal?.removeEventListener("abort", abort); }
    }
  }
}

export class HttpSearchProvider implements SearchProvider {
  get provider(): string { return this.client.provider; }
  private readonly client: HttpServiceClient;
  constructor(config: HttpServiceConfig, fetchImpl?: typeof fetch) { this.client = new HttpServiceClient({ config, fetchImpl }); }
  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<{ results: SearchResult[]; provider: string }> {
    if (!query.trim()) return { results: [], provider: this.client.provider };
    const body = await this.client.json<unknown>("/search", { method: "POST", body: { query, limit: Math.max(1, Math.min(50, options.limit ?? 10)) }, signal: options.signal });
    const value = body && typeof body === "object" ? body as { results?: unknown; items?: unknown } : {};
    const raw = Array.isArray(value.results) ? value.results : Array.isArray(value.items) ? value.items : [];
    const results = raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const url = typeof entry.url === "string" ? entry.url : typeof entry.link === "string" ? entry.link : undefined;
      if (!url) return [];
      return [{ title: typeof entry.title === "string" ? entry.title : url, url, snippet: typeof entry.snippet === "string" ? entry.snippet : typeof entry.description === "string" ? entry.description : undefined, source: typeof entry.source === "string" ? entry.source : undefined }];
    });
    return { results, provider: this.client.provider };
  }
}

export class HttpQuotaProvider implements QuotaProvider {
  private readonly client: HttpServiceClient;
  constructor(config: HttpServiceConfig, fetchImpl?: typeof fetch) { this.client = new HttpServiceClient({ config, fetchImpl }); }
  async getQuota(signal?: AbortSignal): Promise<QuotaSnapshot> {
    const value = await this.client.json<{ remaining?: unknown; limit?: unknown; resetAt?: unknown; message?: unknown }>("/quota", { signal });
    return { provider: this.client.provider, status: "available", remaining: typeof value.remaining === "number" ? value.remaining : undefined, limit: typeof value.limit === "number" ? value.limit : undefined, resetAt: typeof value.resetAt === "string" ? value.resetAt : undefined, message: typeof value.message === "string" ? value.message : undefined };
  }
}

export class LocalManifestPublisher implements BackupPublisher {
  readonly provider = "local";
  constructor(private readonly root: string, private readonly options: { metadataPassphrase?: string } = {}) {}
  async publish(input: Omit<BackupManifest, "manifestId" | "createdAt">): Promise<{ manifest: BackupManifest; uploaded: false }> {
    const createdAt = new Date().toISOString();
    const manifestId = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const manifest: BackupManifest = { ...input, manifestId, createdAt, contentPolicy: "metadata-only" };
    const directory = path.join(path.resolve(this.root), "backups", "manifests");
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${manifestId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, serializeMetadataJson(manifest, this.options.metadataPassphrase), "utf8");
    await rename(temporary, target);
    return { manifest, uploaded: false };
  }
}

export class HttpBackupPublisher implements BackupPublisher {
  private readonly client: HttpServiceClient;
  constructor(config: HttpServiceConfig, fetchImpl?: typeof fetch) { this.client = new HttpServiceClient({ config, fetchImpl }); }
  get provider(): string { return this.client.provider; }
  async publish(input: Omit<BackupManifest, "manifestId" | "createdAt">): Promise<{ manifest: BackupManifest; uploaded: true }> {
    const createdAt = new Date().toISOString();
    const manifestId = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const manifest: BackupManifest = { ...input, manifestId, createdAt, contentPolicy: "metadata-only" };
    await this.client.json("/backup/manifests", { method: "POST", body: manifest, idempotencyKey: manifestId, allowEmpty: true });
    return { manifest, uploaded: true };
  }
}

export class UnavailableSearchProvider implements SearchProvider {
  async search(_query: string): Promise<{ results: SearchResult[]; provider: string }> { throw new ProviderError("configuration", "Web search is not configured", { retryable: false }); }
}
export class UnavailableQuotaProvider implements QuotaProvider {
  async getQuota(): Promise<QuotaSnapshot> { return { provider: "unknown", status: "unknown", message: "Quota is not available for the configured provider" }; }
}
