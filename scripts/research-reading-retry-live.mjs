// Opt-in real SDK reading retry with an explicitly injected interruption.
// No synthetic source, human approval, scientific acceptance or execution.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfig } from "../dist/src/provider.js";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { runResearchWithDshAgent } from "../dist/src/research/dsh-sdk.js";
import { startCaseProviderProxy } from "./research-case-provider.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "research/validation", `reading-retry-live-${Date.now()}`);
const runtime = path.join(output, "runtime");
await mkdir(runtime, { recursive: true });
const repository = new ResearchRepository(path.join(runtime, "research"));
const orchestrator = new ResearchOrchestrator(repository);
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 360000);
const summary = { schema: "dsh-sci.reading-retry-live.v1", startedAt: new Date().toISOString(), scientificQuality: "not-reviewed", status: "not-started",
  scope: "Real model reads a publisher source and saves a citation; developer-injected interruption then tests real model rereading/reusing that citation in a new attempt. Not a natural timeout or full research acceptance.",
  sourceHintsOperatorSupplied: ["https://stefvanbuuren.name/fimd/sec-simplesolutions.html"], humanActions: [], operatorActions: [],
  resourceConfiguration: { version: 2, note: "Sixteen requests for a fresh isolated probe; the earlier 12-request probe stopped after rereading and before its final submission. No existing project budget is extended." },
  budget: { maxModelRequests: 16, maxModelTokens: 250000, maxTaskExecutions: 2, maxWallTimeMs: 360000 }, codeHashes: {} };
let config, proxy, projectId, monitor;
let monitoring = false, interruptionObserved = false, monitorFailure = false;
const save = async (name, value) => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of [config?.apiKey, proxy?.apiKey].filter(Boolean)) for (const representation of [secret, JSON.stringify(secret).slice(1, -1)]) text = text.split(representation).join("[REDACTED]");
  await writeFile(path.join(output, name), text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]") + "\n");
};
try {
  for (const file of ["dsh-sdk", "reading-recovery", "source-content", "task-contract", "orchestrator"]) summary.codeHashes[`dist/src/research/${file}.js`] = createHash("sha256").update(await readFile(path.join(root, `dist/src/research/${file}.js`))).digest("hex");
  config = await loadProviderConfig({ workspace: root });
  if (!config.apiKey?.trim()) throw new Error("No provider key configured");
  summary.provider = config.provider; summary.model = config.model;
  proxy = await startCaseProviderProxy({ config, budget: { maxModelRequests: summary.budget.maxModelRequests, maxOutputTokensPerRequest: 3072, taskTimeoutMs: 150000 }, signal: controller.signal });
  const question = "Read one selected passage about limitations of mean imputation; leave scientific support for human review.";
  const created = await orchestrator.createProject(question, { budget: summary.budget, plan: { question, tasks: [{ taskId: "read", title: "Read one real passage and cite it", kind: "source-review", maxAttempts: 2,
    objective: `Use only this operator-supplied discovery hint: ${summary.sourceHintsOperatorSupplied[0]}. Resolve the real page, source-read one relevant chunk and save ONE exact short citation. This task requires one source, not three. If a saved verified citation already exists, source-read its exact saved version/chunk in THIS attempt, reuse that same citationId (do not refetch or create a duplicate), then complete with sourceId and citationId in refs. No additional claims or evidence relations are needed. Do not approve, execute code or claim scientific support has been reviewed.` }] } });
  projectId = created.project.projectId; summary.projectId = projectId;
  const launch = (signal) => runResearchWithDshAgent(orchestrator, { projectId, sdkHome: path.join(runtime, "sdk-home"), pluginFile: path.join(root, "desktop/dsh-sci-research-plugin.mjs"), cwd: runtime,
    provider: config.provider, model: config.model, baseUrl: proxy.baseUrl, apiKey: proxy.apiKey, maxSteps: 1, maxModelSteps: 12, maxTokens: 3072, taskTimeoutMs: 150000, signal });
  const firstController = new AbortController();
  monitor = setInterval(async () => {
    if (monitoring || interruptionObserved || monitorFailure) return;
    monitoring = true;
    try {
      const snapshot = await repository.exportProject(projectId);
      if (snapshot.citations.some((citation) => citation.verification?.quoteMatches && citation.verification?.locatorValid) && snapshot.plan.tasks[0].status === "running") {
        interruptionObserved = true;
        firstController.abort(new Error("Developer-injected interruption after real citation save"));
      }
    } catch { monitorFailure = true; firstController.abort(new Error("Reading monitor failed")); }
    finally { monitoring = false; }
  }, 200);
  try { await launch(AbortSignal.any([controller.signal, firstController.signal])); }
  catch (error) { if (!interruptionObserved || controller.signal.aborted || monitorFailure) throw error; }
  clearInterval(monitor);
  const before = await repository.exportProject(projectId);
  await save("before-retry.json", before);
  if (!interruptionObserved || before.plan.tasks[0].status !== "running" || before.citations.length !== 1) throw new Error("Injected interruption was not observed at the required checkpoint");
  summary.firstAttemptId = before.plan.tasks[0].attemptId;
  summary.originalCitationId = before.citations[0].citationId;
  summary.operatorActions.push({ action: "inject-interruption-after-real-citation", attemptId: summary.firstAttemptId, simulated: true, grantsApproval: false });
  await orchestrator.failTask(projectId, "read", "Developer-injected interruption after citation save; reread exact saved version in the retry", before.plan.tasks[0]);
  const result = await launch(controller.signal);
  summary.status = result.status; summary.reason = result.reason;
  const after = await repository.exportProject(projectId);
  const task = after.plan.tasks[0], citation = after.citations.find((item) => item.citationId === summary.originalCitationId);
  summary.finalAttemptId = task.attemptId;
  summary.currentAttemptReads = after.sourceReads.filter((receipt) => receipt.audience === "agent" && receipt.planId === task.planId && receipt.taskId === task.taskId && receipt.attemptId === task.attemptId);
  summary.integrationPassed = result.status === "completed" && task.attemptId !== summary.firstAttemptId && after.citations.length === 1 && task.outputRefs.includes(summary.originalCitationId) && summary.currentAttemptReads.some((receipt) => receipt.contentVersionId === citation.contentVersionId && receipt.chunkIds.includes(citation.locator.chunkId)) && after.experimentRuns.length === 0;
} catch (error) {
  summary.status = controller.signal.aborted ? "time-budget-exhausted" : "failed";
  summary.failureKind = error?.name ?? "Error";
  summary.failureMessage = String(error?.message ?? "Unknown failure").slice(0, 1000);
} finally {
  clearInterval(monitor); clearTimeout(timer); controller.abort(); await proxy?.close();
  if (projectId) {
    const snapshot = await repository.exportProject(projectId);
    await save("snapshot.json", snapshot);
    summary.productBudget = snapshot.budget;
    summary.counts = { citations: snapshot.citations.length, sourceReads: snapshot.sourceReads.length, experiments: snapshot.experiments.length, experimentRuns: snapshot.experimentRuns.length };
  }
  summary.providerCalls = proxy?.state; summary.finishedAt = new Date().toISOString();
  await save("summary.json", summary);
  console.log(JSON.stringify({ status: summary.status, integrationPassed: summary.integrationPassed ?? false, evidence: output, scientificQuality: summary.scientificQuality }));
  if (!summary.integrationPassed) process.exitCode = 2;
}
