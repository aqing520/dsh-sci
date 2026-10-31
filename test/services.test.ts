import test from "node:test";
import assert from "node:assert/strict";
import { HttpBackupPublisher, HttpQuotaProvider, HttpSearchProvider, httpServiceConfigFromEnvironment, loadHttpServiceConfig } from "../src/services.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderError } from "../src/provider.js";

const config = { baseUrl: "https://services.example", apiKey: "secret", timeoutMs: 1000, retries: 1 };

test("HTTP service config reads explicit environment names", () => {
  assert.deepEqual(httpServiceConfigFromEnvironment({ DSH_SCI_SERVICE_BASE_URL: "https://service.test/", DSH_SCI_SERVICE_API_KEY: "key", DSH_SCI_SERVICE_TIMEOUT_MS: "5000", DSH_SCI_SERVICE_RETRIES: "4", DSH_SCI_SERVICE_PROVIDER: "research" }), { baseUrl: "https://service.test", apiKey: "key", timeoutMs: 5000, retries: 4, provider: "research" });
});

test("HTTP service config does not reuse the model provider key", () => {
  const config = httpServiceConfigFromEnvironment({ DSH_SCI_SERVICE_BASE_URL: "https://service.test", DSH_SCI_API_KEY: "model-key" });
  assert.equal(config.apiKey, "");
});

test("HTTP service config loads workspace env and config values", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "dsh-sci-service-config-"));
  await writeFile(path.join(workspace, ".env.local"), "DSH_SCI_SERVICE_BASE_URL=https://env.service\nDSH_SCI_SERVICE_API_KEY=env-key\n", "utf8");
  const config = await loadHttpServiceConfig({ workspace, env: {} });
  assert.equal(config.baseUrl, "https://env.service");
  assert.equal(config.apiKey, "env-key");
});

test("HTTP search provider normalizes search results", async () => {
  let request: Request | undefined;
  const provider = new HttpSearchProvider(config, async (input, init) => { request = new Request(input, init); return new Response(JSON.stringify({ results: [{ title: "Doc", url: "https://example/doc", description: "snippet" }, { title: "ignored" }] }), { status: 200 }); });
  const result = await provider.search("  test  ", { limit: 3 });
  assert.deepEqual(result.results, [{ title: "Doc", url: "https://example/doc", snippet: "snippet", source: undefined }]);
  assert.equal(request?.url, "https://services.example/search");
  assert.deepEqual(await request?.json(), { query: "  test  ", limit: 3 });
});

test("HTTP quota and backup providers use explicit endpoints", async () => {
  const requests: Request[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => { requests.push(new Request(input, init)); return new Response(JSON.stringify({ remaining: 4, limit: 10, resetAt: "2026-10-29T00:00:00Z" }), { status: 200 }); };
  const quota = await new HttpQuotaProvider(config, fetchImpl).getQuota();
  assert.deepEqual(quota, { provider: "http", status: "available", remaining: 4, limit: 10, resetAt: "2026-10-29T00:00:00Z", message: undefined });
  const backup = await new HttpBackupPublisher(config, fetchImpl).publish({ schema: "dsh-sci.backup-manifest.v1", projectId: "p", workspaceSnapshotIds: [], researchRunIds: [], contentPolicy: "metadata-only" });
  assert.equal(backup.uploaded, true);
  assert.equal(requests[0].url, "https://services.example/quota");
  assert.equal(requests[1].url, "https://services.example/backup/manifests");
  assert.equal(requests[1].headers.get("idempotency-key"), backup.manifest.manifestId);
});

test("HTTP services retry transient failures and classify final errors", async () => {
  let calls = 0;
  const provider = new HttpSearchProvider(config, async () => { calls += 1; return new Response("busy", { status: 503 }); });
  await assert.rejects(() => provider.search("test"), (error: unknown) => error instanceof ProviderError && error.kind === "server" && error.retryable);
  assert.equal(calls, 2);
});

test("HTTP services do not retry caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = new HttpSearchProvider({ ...config, retries: 3 }, async (_input, init) => { calls += 1; assert.equal(init?.signal?.aborted, true); throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(() => provider.search("test", { signal: controller.signal }), (error: unknown) => error instanceof ProviderError && error.kind === "timeout" && error.retryable === false);
  assert.equal(calls, 1);
});

test("HTTP services stop a retry backoff when the caller cancels", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = new HttpSearchProvider({ ...config, retries: 3 }, async () => {
    calls += 1;
    if (calls === 1) {
      setTimeout(() => controller.abort(), 20);
      return new Response("busy", { status: 503 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
  await assert.rejects(() => provider.search("test", { signal: controller.signal }), (error: unknown) => error instanceof ProviderError && error.kind === "timeout" && error.retryable === false);
  assert.equal(calls, 1);
});

test("HTTP service retries preserve one backup id", async () => {
  const requests: Request[] = [];
  let calls = 0;
  const publisher = new HttpBackupPublisher({ ...config, retries: 1 }, async (input, init) => { calls += 1; requests.push(new Request(input, init)); return new Response(calls === 1 ? "busy" : "{}", { status: calls === 1 ? 503 : 200 }); });
  const result = await publisher.publish({ schema: "dsh-sci.backup-manifest.v1", projectId: "p", workspaceSnapshotIds: ["s"], researchRunIds: ["r"], contentPolicy: "metadata-only" });
  assert.equal(calls, 2);
  assert.equal(requests[0].headers.get("idempotency-key"), requests[1].headers.get("idempotency-key"));
  assert.equal(requests[1].headers.get("idempotency-key"), result.manifest.manifestId);
});

test("HTTP backup accepts an empty 204 response", async () => {
  const publisher = new HttpBackupPublisher(config, async () => new Response(null, { status: 204 }));
  const result = await publisher.publish({ schema: "dsh-sci.backup-manifest.v1", projectId: "p", workspaceSnapshotIds: [], researchRunIds: [], contentPolicy: "metadata-only" });
  assert.equal(result.uploaded, true);
});
