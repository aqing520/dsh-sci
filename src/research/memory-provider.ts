import { EmbeddingGateway, loadConfigValues, loadProviderConfig } from "../provider.js";
import type { MemoryEmbedder } from "./memory.js";

/** Embedding credentials can be configured independently of the research language model. */
export async function loadMemoryEmbedder(options: { workspace: string; env?: Record<string, string | undefined>; configFile?: string; fetchImpl?: typeof fetch }): Promise<MemoryEmbedder> {
  const env = { ...(await loadConfigValues(options.workspace, options.configFile)), ...(options.env ?? process.env) };
  const config = await loadProviderConfig({ ...options, env });
  const baseUrl = env.DSH_SCI_EMBEDDING_BASE_URL ?? config.baseUrl;
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Embedding endpoint must be HTTP(S) without credentials, query or fragment");
  const model = env.DSH_SCI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const gateway = new EmbeddingGateway({ config: { ...config, baseUrl, apiKey: env.DSH_SCI_EMBEDDING_API_KEY ?? config.apiKey, timeoutMs: Math.max(1000, Math.min(60_000, Number(env.DSH_SCI_EMBEDDING_TIMEOUT_MS) || 15_000)) }, fetchImpl: options.fetchImpl });
  return { provider: `embedding:${url.toString().replace(/\/+$/u, "")}`, model, ...(env.DSH_SCI_EMBEDDING_VERSION ? { version: env.DSH_SCI_EMBEDDING_VERSION } : {}), async embed(text, signal) { const vectors = await gateway.embed(text, model, signal); if (vectors.length !== 1) throw new Error("Embedding provider did not return exactly one vector"); return vectors[0]; } };
}
