import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { loadMemoryEmbedder } from "../dist/src/research/memory-provider.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out") throw new Error("Usage: node scripts/research-memory-live.mjs --out <evidence.json>");
const workspace = fileURLToPath(new URL("..", import.meta.url));
const benchmarkText = await readFile(new URL("../research/benchmarks/memory-retrieval-v1.json", import.meta.url), "utf8");
const benchmark = JSON.parse(benchmarkText);
const deadline = AbortSignal.timeout(120_000), maxRequests = 32;
const temp = await mkdtemp(path.join(tmpdir(), "dsh-sci-memory-live-"));
const result = { schema: "dsh-sci.memory-live-validation.v1", generatedAt: new Date().toISOString(), benchmarkSha256: createHash("sha256").update(benchmarkText).digest("hex"), status: "unavailable", scientificQuality: "not-reviewed; synthetic memory benchmark", maxRequests, requests: 0, topK: benchmark.topK, targetCount: benchmark.queries.length, cases: [] };
try {
  const backend = await loadMemoryEmbedder({ workspace });
  result.provider = backend.provider; result.model = backend.model; result.embeddingVersion = backend.version ?? "unspecified";
  const embedder = { ...backend, async embed(text, signal) {
    deadline.throwIfAborted();
    if (result.requests >= maxRequests) throw new Error("Memory validation request budget exhausted");
    result.requests++;
    const vector = await backend.embed(text, signal ? AbortSignal.any([deadline, signal]) : deadline);
    result.dimensions ??= vector.length;
    return vector;
  } };
  const repository = new ResearchRepository(temp), orchestrator = new ResearchOrchestrator(repository, { embedder });
  const { project } = await orchestrator.createProject("Synthetic Chinese retrieval benchmark", { plan: { question: "Synthetic Chinese retrieval benchmark", tasks: [{ taskId: "q", title: "Synthetic recall", objective: "Verify persisted retrieval only", kind: "clarify" }] } });
  const targets = [];
  for (const text of benchmark.targets) targets.push(await orchestrator.remember(project.projectId, { text, kind: "note", confidence: "high", applicability: "Synthetic benchmark only" }));
  for (const text of benchmark.distractors) await orchestrator.remember(project.projectId, { text, kind: "note", confidence: "medium" });
  for (const [index, query] of benchmark.queries.entries()) {
    const reopened = new ResearchOrchestrator(new ResearchRepository(temp), { embedder });
    const hits = await reopened.searchMemory(query, { projectId: project.projectId, limit: benchmark.topK, minConfidence: "medium" }, deadline);
    const retrieval = (await reopened.repository.listMemoryRetrievals()).findLast((item) => item.query === query);
    result.cases.push({ query, targetMemoryId: targets[index].memoryId, recalled: hits.some((hit) => hit.entry.memoryId === targets[index].memoryId), hits: hits.map((hit) => ({ memoryId: hit.entry.memoryId, score: hit.score })), indexId: retrieval?.indexId, retrievalId: retrieval?.retrievalId });
  }
  result.recalled = result.cases.filter((item) => item.recalled).length;
  result.status = result.recalled >= benchmark.minimumRecall ? "passed" : "failed-recall";
  result.crossRepositoryRestart = true;
} catch (error) {
  // Provider exceptions use classified, credential-free messages. Never persist a response body.
  result.errorKind = typeof error?.kind === "string" ? error.kind : deadline.aborted ? "timeout" : "validation";
  result.httpStatus = typeof error?.status === "number" ? error.status : undefined;
  result.reason = error instanceof Error ? error.message.slice(0, 300) : "Embedding validation failed";
  process.exitCode = 2;
} finally {
  await writeFile(path.resolve(args[1]), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  await rm(temp, { recursive: true, force: true });
}
