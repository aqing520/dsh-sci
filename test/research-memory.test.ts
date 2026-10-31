import test from "node:test";
import assert from "node:assert/strict";
import { ResearchMemoryStore } from "../src/research/memory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";

test("memory filters combine project, update time and confidence for local and embedded searches", async () => {
  const store = new ResearchMemoryStore([], { embedder: { provider: "test", model: "test", async embed() { return [1, 0]; } } });
  const first = await store.addAsync({ text: "研究 accuracy", kind: "claim", projectId: "a", confidence: "high" }, "2026-01-01T00:00:00Z");
  const selected = await store.addAsync({ text: "研究 accuracy updated", kind: "claim", projectId: "a", confidence: "medium" }, "2026-06-15T00:00:00Z");
  await store.addAsync({ text: "研究 accuracy low", kind: "claim", projectId: "a", confidence: "low" }, "2026-06-15T00:00:00Z");
  await store.addAsync({ text: "研究 accuracy other", kind: "claim", projectId: "b", confidence: "high" }, "2026-06-15T00:00:00Z");
  const options = { projectId: "a", since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z", minConfidence: "medium" as const };
  assert.deepEqual(store.search("accuracy", options).map((hit) => hit.entry.memoryId), [selected.memoryId]);
  assert.deepEqual((await store.searchAsync("accuracy", options)).map((hit) => hit.entry.memoryId), [selected.memoryId]);
  assert.ok(store.search("accuracy", { minConfidence: "high" }).some((hit) => hit.entry.memoryId === first.memoryId));
});

test("invalid memory filters are rejected consistently before embedding calls", async () => {
  let calls = 0;
  const store = new ResearchMemoryStore([], { embedder: { provider: "test", model: "test", async embed() { calls++; return [1, 0]; } } });
  for (const options of [{ since: "invalid" }, { until: 17 }, { since: "2026-12-01", until: "2026-01-01" }, { minConfidence: "highest" }, { limit: -1 }, { limit: 1.5 }]) {
    assert.throws(() => store.search("query", options as any), /memory search/);
    await assert.rejects(() => store.searchAsync("query", options as any), /memory search/);
  }
  assert.equal(calls, 0);
});

test("memory search persists a versioned index and retrieval record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-memory-index-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, { embedder: { provider: "test", model: "zh-v1", async embed(text) { return [text.includes("均值") ? 1 : 0, 1]; } } });
    const { project } = await orchestrator.createProject("Memory index", { plan: { question: "Memory index", tasks: [{ taskId: "q", title: "Question", objective: "Question", kind: "clarify" }] } });
    const entry = await orchestrator.remember(project.projectId, { text: "均值插补在主条件下误差较低", kind: "claim", confidence: "medium" });
    const hits = await orchestrator.searchMemory("主条件均值误差", { projectId: project.projectId });
    assert.equal(hits[0].entry.memoryId, entry.memoryId);
    const indexes = await repository.listMemoryIndexVersions();
    const retrievals = await repository.listMemoryRetrievals();
    assert.equal(indexes.at(-1)?.model, "zh-v1");
    assert.equal(retrievals.at(-1)?.indexId, indexes.at(-1)?.indexId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
