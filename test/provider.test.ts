import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingGateway, ModelGateway, ProviderError, providerConfigFromEnvironment } from "../src/provider.js";

test("provider config applies safe defaults and strips trailing slash", () => {
  const config = providerConfigFromEnvironment({ DSH_SCI_PROVIDER: "tokenfans-codex", DSH_SCI_BASE_URL: "https://example.test///", DSH_SCI_TOKENFANS_API_KEY: "secret", DSH_SCI_MODEL: "model" });
  assert.deepEqual(config, { provider: "tokenfans-codex", baseUrl: "https://example.test", model: "model", apiKey: "secret", timeoutMs: 120000 });
});

test("model gateway sends Responses requests and classifies auth errors", async () => {
  const requests: Request[] = [];
  const gateway = new ModelGateway({ config: { provider: "custom", baseUrl: "https://example.test", model: "mock", apiKey: "secret", timeoutMs: 1000 }, fetchImpl: async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ id: "resp-1", output_text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await gateway.createResponse({ input: "hello" });
  assert.equal(result.output_text, "ok");
  assert.equal(requests[0].url, "https://example.test/responses");
  assert.equal(requests[0].headers.get("authorization"), "Bearer secret");
  assert.deepEqual(await requests[0].json(), { input: "hello", model: "mock", stream: false });

  const failing = new ModelGateway({ config: { provider: "custom", baseUrl: "https://example.test", model: "mock", apiKey: "secret", timeoutMs: 1000 }, fetchImpl: async () => new Response("unauthorized", { status: 401 }) });
  await assert.rejects(() => failing.createResponse({ input: "hello" }), (error: unknown) => error instanceof ProviderError && error.kind === "authentication" && error.retryable === false);
});

test("model gateway parses event stream", async () => {
  const gateway = new ModelGateway({ config: { provider: "custom", baseUrl: "https://example.test", model: "mock", apiKey: "secret", timeoutMs: 1000 }, fetchImpl: async () => new Response("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\ndata: [DONE]\n\n", { status: 200 }) });
  const events = [];
  for await (const event of gateway.streamResponse({ input: "hello" })) events.push(event);
  assert.deepEqual(events, [{ type: "response.output_text.delta", delta: "hi" }]);
});

test("model gateway parses an unterminated final SSE event", async () => {
  const gateway = new ModelGateway({ config: { provider: "custom", baseUrl: "https://example.test", model: "mock", apiKey: "secret", timeoutMs: 1000 }, fetchImpl: async () => new Response("data: {\"type\":\"response.completed\"}", { status: 200 }) });
  const events = [];
  for await (const event of gateway.streamResponse({ input: "hello" })) events.push(event);
  assert.deepEqual(events, [{ type: "response.completed" }]);
});

test("model gateway propagates an already-aborted signal", async () => {
  const signal = AbortSignal.abort();
  const gateway = new ModelGateway({ config: { provider: "custom", baseUrl: "https://example.test", model: "mock", apiKey: "secret", timeoutMs: 1000 }, fetchImpl: async (_input, init) => { assert.equal(init?.signal?.aborted, true); throw new DOMException("aborted", "AbortError"); } });
  await assert.rejects(() => gateway.createResponse({ input: "hello" }, signal), (error: unknown) => error instanceof ProviderError && error.kind === "timeout");
});

test("embedding gateway sends OpenAI-compatible embedding requests", async () => {
  const requests: Request[] = [];
  const gateway = new EmbeddingGateway({ config: { provider: "custom", baseUrl: "https://example.test", model: "mock", apiKey: "secret", timeoutMs: 1000 }, fetchImpl: async (input, init) => { requests.push(new Request(input, init)); return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }); } });
  assert.deepEqual(await gateway.embed("paper", "embed-model"), [[0.1, 0.2, 0.3]]);
  assert.equal(requests[0].url, "https://example.test/embeddings");
  assert.deepEqual(await requests[0].json(), { model: "embed-model", input: "paper" });
});
