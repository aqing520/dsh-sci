// Focused P2 integration evidence. This does not replace the frozen full case
// and never performs human support review or approves experiments.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfig } from "../dist/src/provider.js";
import { loadHttpServiceConfig, HttpSearchProvider } from "../dist/src/services.js";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { runResearchWithDshAgent } from "../dist/src/research/dsh-sdk.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "research", "validation", `source-live-${Date.now()}`);
const runtime = path.join(output, "runtime");
await mkdir(runtime, { recursive: true });
const repository = new ResearchRepository(path.join(runtime, "research"));
const orchestrator = new ResearchOrchestrator(repository);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 360_000);
const summary = {
  schema: "dsh-sci.source-live.v1", startedAt: new Date().toISOString(), status: "not-started", scientificQuality: "not-reviewed",
  scope: "Focused real SDK retrieval/reading/citation probe with one developer-provided task, not autonomous planning or full scientific acceptance.",
  humanActions: [], planOrigin: "developer-provided-probe",
  sourceHintsHumanSupplied: ["https://stefvanbuuren.name/fimd/sec-simplesolutions.html", "https://scikit-learn.org/stable/modules/impute.html"],
  budget: { maxModelRequests: 16, maxModelTokens: 300000, maxTaskExecutions: 2, maxWallTimeMs: 360000 },
  codeHashes: {},
};
for (const file of ["source-content", "source-adapters", "evidence-review", "repository", "orchestrator", "bridge", "task-contract", "task-result", "dsh-sdk", "inspect"]) {
  summary.codeHashes[`dist/src/research/${file}.js`] = createHash("sha256").update(await readFile(path.join(root, "dist/src/research", `${file}.js`))).digest("hex");
}
let config, service, projectId;
const save = async (file, value) => {
  let serialized = JSON.stringify(value, null, 2);
  for (const secret of [config?.apiKey, service?.apiKey].filter(Boolean)) for (const representation of [secret, JSON.stringify(secret).slice(1, -1)]) serialized = serialized.split(representation).join("[REDACTED]");
  await writeFile(path.join(output, file), serialized.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]") + "\n");
};
try {
  config = await loadProviderConfig({ workspace: root });
  service = await loadHttpServiceConfig({ workspace: root });
  summary.provider = config.provider; summary.model = config.model;
  summary.generalSearchConfigured = Boolean(service.baseUrl && service.apiKey);
  summary.defaultSearch = summary.generalSearchConfigured ? "configured" : "crossref-public";
  const question = "What limitations of mean/median single imputation matter for comparing MSE and MAE on skewed data? Collect a small, verifiable reading record, not an experimental conclusion.";
  const task = { taskId: "read", kind: "source-review", title: "Discover and read evidence", objective: [
    "Call search at least once with a relevant scholarly query; inspect relevance and do not treat bibliographic metadata as a read paper.",
    "Resolve and read at least one relevant available source with source-read/chunk-read. If discovered metadata lacks an abstract, save that limitation and try another source rather than inventing text.",
    `Human-supplied fallback discovery hints: ${summary.sourceHintsHumanSupplied.join(", ")}. Their use must be disclosed and cannot count as autonomous discovery.`,
    "Create at least one citation with contentVersionId, locator.chunkId (and page if supplied), and a short exact quote returned by reading. Add a narrowly scoped claim and an evidence relation containing claimId, sourceId and citationId with a rationale. Any proposed support remains pending human review.",
    "Complete only this literature task with persisted citation/claim/evidence IDs in refs. State whether you read an abstract or a selected body range. Do not approve, run commands, generate scientific conclusions or pretend to perform human review."
  ].join(" "), maxAttempts: 1 };
  const created = await orchestrator.createProject(question, { budget: summary.budget, plan: { question, tasks: [task] } });
  projectId = created.project.projectId; summary.projectId = projectId;
  const result = await runResearchWithDshAgent(orchestrator, {
    projectId, sdkHome: path.join(runtime, "sdk-home"), pluginFile: path.join(root, "desktop", "dsh-sci-research-plugin.mjs"), cwd: runtime,
    provider: config.provider, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey,
    search: summary.generalSearchConfigured ? new HttpSearchProvider(service) : undefined,
    maxSteps: 1, maxModelSteps: 20, maxTokens: 3072, taskTimeoutMs: 300000, signal: controller.signal,
  });
  summary.status = result.status; summary.reason = result.reason;
} catch (error) {
  summary.status = controller.signal.aborted ? "time-budget-exhausted" : "failed";
  summary.failure = { name: error?.name ?? "Error", phase: "focused-source-probe" };
} finally {
  clearTimeout(timer); controller.abort();
  if (projectId) {
    const snapshot = await repository.exportProject(projectId);
    await save("snapshot.json", snapshot);
    summary.productBudget = snapshot.budget;
    summary.counts = Object.fromEntries(["sources", "sourceContents", "sourceReads", "searchLogs", "sourceAcquisitions", "citations", "claims", "evidence", "evidenceReviews"].map((key) => [key, snapshot[key].length]));
    summary.citations = snapshot.citations.map((citation) => ({ citationId: citation.citationId, contentVersionId: citation.contentVersionId, verification: citation.verification }));
    summary.integrationPassed = summary.status === "completed" && snapshot.searchLogs.some((log) => log.status === "completed") && snapshot.sourceReads.some((read) => read.audience === "agent") && snapshot.citations.some((citation) => citation.verification?.quoteMatches && citation.verification?.locatorValid) && snapshot.evidence.some((evidence) => evidence.citationId);
  }
  summary.finishedAt = new Date().toISOString();
  await save("summary.json", summary);
  console.log(JSON.stringify({ status: summary.status, integrationPassed: summary.integrationPassed ?? false, scientificQuality: summary.scientificQuality, counts: summary.counts, requests: summary.productBudget?.usedModelRequests, tokens: summary.productBudget?.reportedTotalTokens, evidence: output }));
  if (summary.status === "failed") process.exitCode = 1;
  else if (!summary.integrationPassed) process.exitCode = 2;
}
