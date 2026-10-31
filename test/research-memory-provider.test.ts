import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMemoryEmbedder } from "../src/research/memory-provider.js";
import { ProviderError } from "../src/provider.js";

async function fixture(run: (workspace: string, configFile: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(tmpdir(), "dsh-sci-embedding-config-"));
  try { await run(workspace, path.join(workspace, "config.json")); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}

test("embedding config loads file defaults and independent endpoint, key, model and version overrides", async () => fixture(async (workspace, configFile) => {
  await writeFile(configFile, JSON.stringify({ DSH_SCI_API_KEY: "language-key", DSH_SCI_BASE_URL: "https://language.example/v1", DSH_SCI_EMBEDDING_BASE_URL: "https://file.example/v1" }));
  await writeFile(path.join(workspace, ".env.local"), "DSH_SCI_EMBEDDING_MODEL=file-model\n");
  const requests: Request[] = [];
  const embedder = await loadMemoryEmbedder({ workspace, configFile, env: { DSH_SCI_EMBEDDING_BASE_URL: "https://vector.example/v1/", DSH_SCI_EMBEDDING_API_KEY: "vector-key", DSH_SCI_EMBEDDING_VERSION: "v3" }, fetchImpl: async (input, init) => {
    requests.push(new Request(input, init)); return Response.json({ data: [{ embedding: [1, 0] }] });
  } });
  assert.deepEqual(await embedder.embed("source"), [1, 0]);
  assert.equal(embedder.provider, "embedding:https://vector.example/v1"); assert.equal(embedder.version, "v3");
  assert.equal(requests[0].url, "https://vector.example/v1/embeddings");
  assert.equal(requests[0].headers.get("authorization"), "Bearer vector-key");
  assert.deepEqual(await requests[0].json(), { model: "file-model", input: "source" });
}));

test("embedding endpoint rejects embedded credentials, queries, fragments and non-HTTP protocols before requests", async () => fixture(async (workspace, configFile) => {
  let calls = 0;
  for (const endpoint of ["https://user:secret@example.test", "https://example.test?key=secret", "https://example.test#secret", "file:///secret"]) {
    await assert.rejects(loadMemoryEmbedder({ workspace, configFile, env: { DSH_SCI_EMBEDDING_BASE_URL: endpoint }, fetchImpl: async () => { calls++; return Response.json({}); } }), /without credentials, query or fragment/);
  }
  assert.equal(calls, 0);
}));

test("embedding service failures are classified without leaking response bodies or independent credentials", async () => fixture(async (workspace, configFile) => {
  const embedder = await loadMemoryEmbedder({ workspace, configFile, env: { DSH_SCI_EMBEDDING_BASE_URL: "https://vector.example/v1", DSH_SCI_EMBEDDING_API_KEY: "private-vector-key" }, fetchImpl: async () => new Response("sensitive provider response", { status: 405 }) });
  await assert.rejects(embedder.embed("text"), (error: unknown) => {
    assert.ok(error instanceof ProviderError); assert.equal(error.status, 405);
    assert.doesNotMatch(error.message, /private-vector-key|sensitive provider response/); return true;
  });
}));

test("embedding adapter rejects missing or extra vectors and forwards cancellation", async () => fixture(async (workspace, configFile) => {
  const env = { DSH_SCI_EMBEDDING_BASE_URL: "https://vector.example/v1", DSH_SCI_EMBEDDING_API_KEY: "fixture-key" };
  for (const data of [[], [{ embedding: [1, 0] }, { embedding: [0, 1] }]]) {
    const embedder = await loadMemoryEmbedder({ workspace, configFile, env, fetchImpl: async () => Response.json({ data }) });
    await assert.rejects(embedder.embed("text"), /exactly one vector/);
  }
  const signal = AbortSignal.abort();
  const cancelled = await loadMemoryEmbedder({ workspace, configFile, env, fetchImpl: async (_input, init) => { assert.equal(init?.signal?.aborted, true); throw new DOMException("cancelled", "AbortError"); } });
  await assert.rejects(cancelled.embed("text", signal), (error: unknown) => error instanceof ProviderError && error.kind === "timeout");
}));
