import { readFile } from "node:fs/promises";
import path from "node:path";
import { readModelUsage, type ModelRequestAccounting, type ModelUsage } from "./model-usage.js";

export type ProviderKind = "deepseek" | "tokenfans-codex" | "openai" | "custom";

export interface ProviderConfig {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface ResponsesRequest {
  model?: string;
  input: string | Array<Record<string, unknown>>;
  instructions?: string;
  temperature?: number;
  metadata?: Record<string, string>;
  max_output_tokens?: number;
}

export interface ResponsesResult {
  id?: string;
  status?: string;
  output_text?: string;
  output?: unknown[];
  [key: string]: unknown;
}

export interface EmbeddingsResult { data?: Array<{ embedding?: unknown }>; model?: string; }

export type ProviderErrorKind = "configuration" | "authentication" | "permission" | "rate-limit" | "timeout" | "network" | "server" | "protocol";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(kind: ProviderErrorKind, message: string, options: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? ["rate-limit", "timeout", "network", "server"].includes(kind);
  }
}

const DEFAULTS: Record<ProviderKind, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  "tokenfans-codex": { baseUrl: "https://tokenfans.ai/codex", model: "gpt-6.1-sol" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" },
  custom: { baseUrl: "http://127.0.0.1:8080/v1", model: "default" },
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function providerConfigFromEnvironment(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const rawProvider = env.DSH_SCI_PROVIDER ?? "deepseek";
  const provider: ProviderKind = rawProvider === "deepseek" || rawProvider === "openai" || rawProvider === "custom" || rawProvider === "tokenfans-codex" ? rawProvider : "custom";
  const defaults = DEFAULTS[provider];
  return {
    provider,
    baseUrl: normalizeBaseUrl(env.DSH_SCI_BASE_URL ?? defaults.baseUrl),
    model: env.DSH_SCI_MODEL ?? defaults.model,
    apiKey: env.DSH_SCI_API_KEY ?? env.DSH_SCI_TOKENFANS_API_KEY ?? env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY,
    timeoutMs: Math.max(1000, Number.parseInt(env.DSH_SCI_PROVIDER_TIMEOUT_MS ?? "120000", 10) || 120000),
  };
}

export async function loadProviderConfig(options: { workspace: string; configFile?: string; env?: Record<string, string | undefined> }): Promise<ProviderConfig> {
  const fileValues = await loadConfigValues(options.workspace, options.configFile);
  return providerConfigFromEnvironment({ ...fileValues, ...(options.env ?? process.env) });
}

export async function loadConfigValues(workspace: string, configFile?: string): Promise<Record<string, string>> {
  const candidates = configFile ? [configFile] : [path.join(workspace, "dsh-sci.config.json"), path.join(workspace, "config", "dsh-sci.config.json"), path.join(process.cwd(), "dsh-sci.config.json")];
  const values: Record<string, string> = {};
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") values[key] = value;
      if (Object.keys(values).length) break;
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try {
    const text = await readFile(path.join(workspace, ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return values;
}

export interface ProviderClientOptions {
  config: ProviderConfig;
  fetchImpl?: typeof fetch;
}

/** Backend-neutral OpenAI Responses client. It never includes credentials in thrown errors. */
export class ModelGateway {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: ProviderClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async createResponse(request: ResponsesRequest, signal?: AbortSignal, accounting?: ModelRequestAccounting): Promise<ResponsesResult> {
    this.assertConfigured();
    if (accounting) signal?.throwIfAborted();
    const reservationId = await accounting?.reserve();
    let usage: ModelUsage | undefined;
    let pending: Awaited<ReturnType<ModelGateway["request"]>> | undefined;
    try {
      pending = await this.request(request, false, signal);
      let body: unknown;
      try { body = await pending.response.json(); } catch (error) { throw new ProviderError("protocol", "Provider returned invalid JSON", { status: pending.response.status, cause: error }); }
      if (!body || typeof body !== "object") throw new ProviderError("protocol", "Provider returned an invalid response", { status: pending.response.status });
      usage = readModelUsage(body);
      return body as ResponsesResult;
    } catch (error: unknown) { throw this.bodyError(error, pending?.response.status, signal); }
    finally { pending?.cleanup(); if (reservationId) await accounting!.settle(reservationId, usage); }
  }

  async *streamResponse(request: ResponsesRequest, signal?: AbortSignal, accounting?: ModelRequestAccounting): AsyncGenerator<Record<string, unknown>, void, void> {
    this.assertConfigured();
    if (accounting) signal?.throwIfAborted();
    const reservationId = await accounting?.reserve();
    let usage: ModelUsage | undefined;
    try {
      const pending = await this.request(request, true, signal);
      const response = pending.response;
      if (!response.body) { pending.cleanup(); throw new ProviderError("protocol", "Provider returned no response stream", { status: response.status }); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const event = JSON.parse(data) as Record<string, unknown>;
              usage = readModelUsage(event) ?? usage;
              yield event;
            } catch (error) { throw new ProviderError("protocol", "Provider returned malformed stream data", { status: response.status, cause: error }); }
          }
        }
        buffer += decoder.decode();
        if (buffer.startsWith("data:")) {
          const data = buffer.slice(5).trim();
          if (data && data !== "[DONE]") {
            try { const event = JSON.parse(data) as Record<string, unknown>; usage = readModelUsage(event) ?? usage; yield event; }
            catch (error) { throw new ProviderError("protocol", "Provider returned malformed stream data", { status: response.status, cause: error }); }
          }
        }
      } catch (error: unknown) { throw this.bodyError(error, response.status, signal); }
      finally { reader.releaseLock(); pending.cleanup(); }
    } finally { if (reservationId) await accounting!.settle(reservationId, usage); }
  }

  private assertConfigured(): void {
    const config = this.options.config;
    if (!config.baseUrl || !config.model) throw new ProviderError("configuration", "Provider base URL and model are required", { retryable: false });
    if (!config.apiKey) throw new ProviderError("authentication", "Provider API key is not configured", { retryable: false });
  }

  private async request(request: ResponsesRequest, stream: boolean, signal?: AbortSignal): Promise<{ response: Response; cleanup: () => void }> {
    const config = this.options.config;
    if (!config.baseUrl || !config.model) throw new ProviderError("configuration", "Provider base URL and model are required", { retryable: false });
    if (!config.apiKey) throw new ProviderError("authentication", "Provider API key is not configured", { retryable: false });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort); controller.abort(); };
    try {
      const response = await this.fetchImpl(`${normalizeBaseUrl(config.baseUrl)}/responses`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ ...request, model: request.model ?? config.model, stream }),
        signal: controller.signal,
      });
      if (!response.ok) { cleanup(); throw this.httpError(response); }
      return { response, cleanup };
    } catch (error: unknown) { cleanup(); if (error instanceof ProviderError) throw error; if (error instanceof DOMException && error.name === "AbortError") throw new ProviderError("timeout", `Provider request timed out after ${config.timeoutMs} ms`, { retryable: signal?.aborted !== true, cause: error }); throw new ProviderError("network", "Provider request failed", { retryable: true, cause: error }); }
  }

  private httpError(response: Response): ProviderError {
    const kind: ProviderErrorKind = response.status === 401 ? "authentication" : response.status === 403 ? "permission" : response.status === 429 ? "rate-limit" : response.status >= 500 ? "server" : "protocol";
    return new ProviderError(kind, `Provider request failed with HTTP ${response.status}`, { status: response.status });
  }

  private bodyError(error: unknown, status?: number, signal?: AbortSignal): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof DOMException && error.name === "AbortError") return new ProviderError("timeout", `Provider response timed out after ${this.options.config.timeoutMs} ms`, { status, retryable: signal?.aborted !== true, cause: error });
    return new ProviderError("network", "Provider response stream failed", { status, retryable: true, cause: error });
  }
}

/** OpenAI-compatible embedding boundary used by optional research memory backends. */
export class EmbeddingGateway {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: ProviderClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }
  async embed(input: string | string[], model = "text-embedding-3-small", signal?: AbortSignal): Promise<number[][]> {
    const config = this.options.config;
    if (!config.baseUrl || !config.apiKey) throw new ProviderError("configuration", "Embedding provider is not configured", { retryable: false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(`${normalizeBaseUrl(config.baseUrl)}/embeddings`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model, input }), signal: controller.signal });
      if (!response.ok) throw this.httpError(response);
      const body = await response.json() as EmbeddingsResult;
      const values = Array.isArray(body.data) ? body.data.map((item) => Array.isArray(item?.embedding) ? item.embedding.map(Number) : undefined) : [];
      if (values.some((value) => !value || value.length < 2 || value.some((item) => !Number.isFinite(item)))) throw new ProviderError("protocol", "Embedding provider returned invalid vectors", { retryable: false });
      return values as number[][];
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new ProviderError("timeout", "Embedding request timed out", { retryable: signal?.aborted !== true, cause: error });
      throw new ProviderError("network", "Embedding request failed", { retryable: true, cause: error });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  private httpError(response: Response): ProviderError { const kind: ProviderErrorKind = response.status === 401 ? "authentication" : response.status === 403 ? "permission" : response.status === 429 ? "rate-limit" : response.status >= 500 ? "server" : "protocol"; return new ProviderError(kind, `Embedding provider failed with HTTP ${response.status}`, { status: response.status }); }
}
