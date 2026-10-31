import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { buildMemoryIndex, validateMemoryIndex } from "../src/research/memory-index.js";
import { ResearchMemoryStore, type MemoryEmbedder } from "../src/research/memory.js";
import { startResearchBridge } from "../src/research/bridge.js";

async function fixture(encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-memory-v2-"));
  const repository = new ResearchRepository(root, encrypted ? { metadataPassphrase: "memory-test-only" } : {}), orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject("均值插补的误差与适用条件", { plan: { question: "均值插补的误差与适用条件", tasks: [{ taskId: "q", title: "回顾均值插补", objective: "检索前期记忆并核对来源", kind: "clarify" }] } });
  return { root, repository, orchestrator, project, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function embedding(provider: string, model: string, version: string, dimensions: number, calls: string[]): MemoryEmbedder {
  return { provider, model, version, async embed(text) { calls.push(text); return Array.from({ length: dimensions }, (_, i) => i === dimensions - 1 ? 1 : 0); } };
}

test("Chinese character fragments and explicit query rewrites survive restart with an audited immutable index", async () => {
  const f = await fixture();
  try {
    const entry = await f.orchestrator.remember(f.project.projectId, { text: "均值插补在主条件下误差较低", kind: "claim", confidence: "high", applicability: "仅限当前数据与缺失机制" });
    const reopened = new ResearchOrchestrator(new ResearchRepository(f.root));
    assert.equal((await reopened.searchMemory("主条件下插补误差", { projectId: f.project.projectId }))[0].entry.memoryId, entry.memoryId);
    const hits = await reopened.searchMemory("平均值填补的损失", { projectId: f.project.projectId, rewrittenQuery: "均值插补主条件误差" });
    assert.equal(hits[0].entry.memoryId, entry.memoryId); assert.match(hits[0].warnings.join(" "), /Candidate/);
    const retrieval = (await f.repository.listMemoryRetrievals()).at(-1)!;
    assert.equal(retrieval.query, "平均值填补的损失"); assert.equal(retrieval.rewrittenQuery, "均值插补主条件误差");
    const index = (await f.repository.readMemoryIndexVersion(retrieval.indexId))!;
    assert.equal(index.schema, "dsh-sci.research-memory-index.v2"); assert.equal(index.entries![0].applicability, entry.applicability);
    assert.equal(retrieval.entryBindings![0].memoryId, entry.memoryId);
    await f.orchestrator.remember(f.project.projectId, { text: entry.text, kind: "claim", confidence: "medium", applicability: "changed applicability" });
    await reopened.searchMemory("插补误差", { projectId: f.project.projectId });
    assert.equal((await f.repository.readMemoryIndexVersion(index.indexId))!.entries![0].confidence, "high");
    assert.notEqual((await f.repository.listMemoryRetrievals()).find((value) => value.query === "插补误差")!.indexId, index.indexId);
  } finally { await f.cleanup(); }
});

test("rebuild embeds the entire selected corpus into isolated provider/model/version/dimension snapshots", async () => {
  const f = await fixture();
  try {
    const a = await f.orchestrator.remember(f.project.projectId, { text: "legacy local memory A", kind: "note" });
    const entriesBefore = await f.repository.listMemory();
    const indexes = [];
    for (const [provider, model, version, dimensions] of [["p1", "m1", "v1", 3], ["p2", "m1", "v1", 2], ["p2", "m2", "v1", 2], ["p2", "m2", "v2", 4]] as const) {
      const calls: string[] = [], orchestrator = new ResearchOrchestrator(new ResearchRepository(f.root), { embedder: embedding(provider, model, version, dimensions, calls) });
      const index = await orchestrator.rebuildMemoryIndex(f.project.projectId); indexes.push(index);
      assert.deepEqual(calls, [a.text]); assert.equal(index.dimensions, dimensions); assert.equal(index.embeddingVersion, version);
      assert.equal(index.entries!.length, 1); assert.equal(index.entries![0].vector.length, dimensions);
      const hits = await orchestrator.searchMemory("legacy memory", { projectId: f.project.projectId });
      assert.equal(hits[0].entry.memoryId, a.memoryId); assert.equal(calls.length, 2, "cached search embeds the query only");
    }
    assert.equal(new Set(indexes.map((index) => index.indexId)).size, 4);
    assert.deepEqual(await f.repository.listMemory(), entriesBefore, "derived rebuilds preserve original source entries");
    for (const index of indexes) assert.deepEqual(await f.repository.readMemoryIndexVersion(index.indexId), index);
    const local = await f.orchestrator.rebuildMemoryIndex(f.project.projectId); assert.equal(local.dimensions, 64); assert.equal(local.provider, "local-hash");
  } finally { await f.cleanup(); }
});

test("embedding failure and dimension drift cannot publish partial indexes or alter previous snapshots", async () => {
  const f = await fixture();
  try {
    await f.orchestrator.remember(f.project.projectId, { text: "First memory A", kind: "note" });
    await f.orchestrator.remember(f.project.projectId, { text: "Second memory B", kind: "note" });
    const old = await f.orchestrator.rebuildMemoryIndex(f.project.projectId), entries = await f.repository.listMemory();
    let count = 0;
    const drift = new ResearchOrchestrator(f.repository, { embedder: { provider: "drift", model: "m", async embed() { return ++count === 1 ? [1, 0] : [1, 0, 0]; } } });
    await assert.rejects(() => drift.rebuildMemoryIndex(f.project.projectId), /dimensions changed/);
    assert.equal((await f.repository.listMemoryIndexVersions()).length, 1); assert.deepEqual(await f.repository.listMemory(), entries);
    const failure = new ResearchOrchestrator(f.repository, { embedder: { provider: "fail", model: "m", async embed() { throw new Error("service unavailable"); } } });
    await assert.rejects(() => failure.searchMemory("query", { projectId: f.project.projectId }), /service unavailable/);
    assert.equal((await f.repository.listMemoryRetrievals()).length, 0);
    assert.deepEqual(await f.repository.readMemoryIndexVersion(old.indexId), old);
  } finally { await f.cleanup(); }
});

test("mixed direct-store vectors are excluded and real cosine normalizes vector magnitudes", async () => {
  const calls: string[] = [], embedder = embedding("p", "m", "v1", 2, calls);
  const store = new ResearchMemoryStore([], { embedder });
  const entry = await store.addAsync({ text: "valid memory", kind: "note", projectId: "a" });
  store.add({ text: "legacy vector", kind: "note", projectId: "a" });
  const foreign = await store.addAsync({ text: "foreign model", kind: "note", projectId: "a" }); foreign.embedding!.model = "other";
  entry.vector = [0, 100];
  const results = await store.searchAsync("query", { projectId: "a" });
  assert.deepEqual(results.map((hit) => hit.entry.memoryId), [entry.memoryId]); assert.ok(results[0].score <= 1.23);
  for (const vector of [[0, 0], [NaN, 1], Array(4097).fill(1)]) await assert.rejects(() => buildMemoryIndex(store.all(), { embedder: { provider: "invalid", model: "m", async embed() { return vector; } }, force: true }), /invalid vector/);
});

test("index hash corruption and forged retrieval bindings are rejected", async () => {
  const f = await fixture();
  try {
    await f.orchestrator.remember(f.project.projectId, { text: "bounded memory", kind: "note" });
    await f.orchestrator.searchMemory("bounded memory", { projectId: f.project.projectId });
    const index = (await f.repository.listMemoryIndexVersions())[0], retrieval = (await f.repository.listMemoryRetrievals())[0];
    assert.throws(() => validateMemoryIndex({ ...index, entries: [{ ...index.entries![0], text: "changed" }] }), /hash|binding/);
    await assert.rejects(() => f.repository.saveMemoryRetrieval({ ...retrieval, retrievalId: "forged", memoryIds: ["missing"] }), /does not match/);
    await assert.rejects(() => f.repository.saveMemoryRetrieval({ ...retrieval, query: "changed" }), /immutable/);
    const file = path.join(f.root, "memory-indexes", `${index.indexId}.json`);
    const value = JSON.parse(await readFile(file, "utf8")); value.entries[0].vector[0] += 1; await writeFile(file, JSON.stringify(value));
    await assert.rejects(() => f.repository.readMemoryIndexVersion(index.indexId), /hash|binding/);
  } finally { await f.cleanup(); }
});

test("restarted runner context binds task attempt, excludes stale/superseded/foreign memories and warns on unresolved conflict", async () => {
  const f = await fixture(true); let bridge: Awaited<ReturnType<typeof startResearchBridge>> | undefined;
  try {
    const id = f.project.projectId;
    const relevant = await f.orchestrator.remember(id, { text: "均值插补主条件误差较低", kind: "claim", confidence: "high", refs: ["source-fixture"], conflictKey: "finding", applicability: "Only under fixed missing mechanism" });
    await f.orchestrator.remember(id, { text: "均值插补主条件误差较高", kind: "claim", confidence: "high", conflictKey: "finding" });
    await f.orchestrator.remember(id, { text: "均值插补过期结论", kind: "note", confidence: "high", expiresAt: "2000-01-01" });
    const superseded = await f.orchestrator.remember(id, { text: "均值插补旧方法", kind: "note", confidence: "high" });
    await f.orchestrator.remember(id, { text: "均值插补新方法", kind: "note", confidence: "high", supersedes: [superseded.memoryId] });
    const other = (await f.orchestrator.createProject("Other project")).project;
    await f.orchestrator.remember(other.projectId, { text: "均值插补外国项目", kind: "note", confidence: "high" });
    await f.orchestrator.activatePlan(id); await f.orchestrator.startNextTask(id);
    const reopened = new ResearchOrchestrator(new ResearchRepository(f.root, { metadataPassphrase: "memory-test-only" }));
    bridge = await startResearchBridge(reopened, { runnerProjectId: id });
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "context" }) });
    assert.equal(response.status, 200); const context = await response.json() as any;
    const memory = context.memory as Array<{ memoryId: string; text: string; warnings: string[]; refs: string[] }>;
    assert.ok(memory.some((entry) => entry.memoryId === relevant.memoryId));
    assert.ok(memory.every((entry) => !/过期|旧方法|外国项目/u.test(entry.text)));
    assert.match(memory.find((entry) => entry.memoryId === relevant.memoryId)!.warnings.join(" "), /Unresolved/);
    assert.ok(memory.length <= 5); assert.match(context.memoryGuidance, /Candidate/);
    const record = (await reopened.repository.listMemoryRetrievals())[0];
    assert.equal(record.retrievalId, context.memoryRetrievalId); assert.equal(record.purpose, "task-context"); assert.equal(record.attemptId, context.task.attemptId); assert.deepEqual(record.injectedMemoryIds, memory.map((entry) => entry.memoryId));
  } finally { await bridge?.close(); await f.cleanup(); }
});

test("concurrent memory writes across kernel instances retain both conflict links and project separation", async () => {
  const f = await fixture();
  try {
    const second = new ResearchOrchestrator(new ResearchRepository(f.root));
    await Promise.all([f.orchestrator.remember(f.project.projectId, { text: "均值较好", kind: "claim", conflictKey: "finding" }), second.remember(f.project.projectId, { text: "中位数较好", kind: "claim", conflictKey: "finding" })]);
    const group = (await f.orchestrator.listMemoryConflicts(f.project.projectId))[0];
    assert.equal(group.entries.length, 2); assert.ok(group.entries.every((entry) => entry.conflictIds.length === 1));
    const before = (await f.repository.listMemoryIndexVersions()).length;
    await assert.rejects(() => f.orchestrator.searchMemory("query", { limit: -1 }), /memory search/);
    assert.equal((await f.repository.listMemoryIndexVersions()).length, before);
  } finally { await f.cleanup(); }
});

test("memory references bind saved source content and warn after the source receives a new version", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, "source.txt");
    await writeFile(file, "Version one says the bounded method is stable.");
    const acquired = await f.orchestrator.ingestDocument(f.project.projectId, file);
    const memory = await f.orchestrator.remember(f.project.projectId, { text: "The bounded method is stable", kind: "claim", refs: [acquired.source.sourceId], confidence: "high" });
    assert.equal(memory.sourceBindings?.[0].kind, "source"); assert.equal(memory.sourceBindings?.[0].contentVersionId, acquired.source.latestContentVersionId);
    await writeFile(file, "Version two changes the bounded method conclusion.");
    await f.orchestrator.ingestDocument(f.project.projectId, file);
    const hits = await f.orchestrator.searchMemory("bounded method", { projectId: f.project.projectId });
    assert.equal(hits[0].entry.memoryId, memory.memoryId); assert.match(hits[0].warnings.join(" "), /changed after this memory was saved/);
    const context = await f.orchestrator.repository.exportProject(f.project.projectId);
    assert.notEqual(context.sources[0].latestContentVersionId, memory.sourceBindings?.[0].contentVersionId);
  } finally { await f.cleanup(); }
});

test("aborting an embedding query leaves no index or retrieval record", async () => {
  const f = await fixture();
  try {
    await f.orchestrator.remember(f.project.projectId, { text: "Slow embedding memory", kind: "note" });
    const controller = new AbortController();
    const embedder = { provider: "slow", model: "slow", version: "v1", async embed(_text: string, signal?: AbortSignal) { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 1000); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true }); }); return [1, 0]; } };
    const slow = new ResearchOrchestrator(new ResearchRepository(f.root), { embedder });
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(() => slow.searchMemory("cancelled", { projectId: f.project.projectId }, controller.signal), /cancelled/);
    assert.equal((await f.repository.listMemoryIndexVersions()).length, 0); assert.equal((await f.repository.listMemoryRetrievals()).length, 0);
  } finally { await f.cleanup(); }
});

test("cancelling a pending embedding rebuild preserves old snapshots and releases the memory queue", async () => {
  const f = await fixture();
  try {
    await f.orchestrator.remember(f.project.projectId, { text: "Cancellation fixture memory", kind: "note" });
    const old = await f.orchestrator.rebuildMemoryIndex(f.project.projectId);
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const slow = new ResearchOrchestrator(f.repository, { embedder: { provider: "pending", model: "fixture", async embed(_text, signal) {
      entered();
      await new Promise<void>((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); });
      return [1, 0];
    } } });
    const pending = assert.rejects(slow.rebuildMemoryIndex(f.project.projectId, controller.signal), /cancel pending embedding/);
    await started; controller.abort(new Error("cancel pending embedding")); await pending;
    assert.deepEqual(await f.repository.listMemoryIndexVersions(), [old]);
    assert.equal((await f.repository.listMemoryRetrievals()).length, 0);
    const hits = await f.orchestrator.searchMemory("Cancellation fixture", { projectId: f.project.projectId });
    assert.equal(hits.length, 1, "next operation can acquire the released memory queue");
  } finally { await f.cleanup(); }
});

test("ten-query Chinese retrieval set recalls at least eight targets in top five", async (t) => {
  const f = await fixture();
  try {
    const benchmark = JSON.parse(await readFile(new URL("../research/benchmarks/memory-retrieval-v1.json", import.meta.url), "utf8")) as { targets: string[]; distractors: string[]; queries: string[]; topK: number; minimumRecall: number };
    const { targets, distractors, queries } = benchmark;
    for (const text of targets) await f.orchestrator.remember(f.project.projectId, { text, kind: "claim", confidence: "high" });
    for (const text of distractors) await f.orchestrator.remember(f.project.projectId, { text, kind: "note", confidence: "medium" });
    let recalled = 0;
    for (const [index, query] of queries.entries()) {
      const hits = await f.orchestrator.searchMemory(query, { projectId: f.project.projectId, limit: benchmark.topK, minConfidence: "medium" });
      if (hits.some((hit) => hit.entry.text === targets[index])) recalled += 1;
    }
    assert.ok(recalled >= benchmark.minimumRecall, `expected at least ${benchmark.minimumRecall}/${queries.length} query recalls, got ${recalled}`);
    t.diagnostic(`local Chinese query recall: ${recalled}/10 in top 5 (hash/ngram baseline only)`);
  } finally { await f.cleanup(); }
});
