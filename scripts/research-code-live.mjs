// Isolates real model -> code-stage -> completion contract. This is not the
// frozen full research case and never executes generated candidate code.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfig } from "../dist/src/provider.js";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { runResearchWithDshAgent } from "../dist/src/research/dsh-sdk.js";
import { startCaseProviderProxy } from "./research-case-provider.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "research/validation", `code-live-${Date.now()}`);
const runtime = path.join(output, "runtime"), workspace = path.join(runtime, "workspace");
await mkdir(workspace, { recursive: true });
const repository = new ResearchRepository(path.join(runtime, "research"));
const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: workspace } });
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180_000);
let config, proxy, projectId;
const summary = { schema: "dsh-sci.code-live.v1", startedAt: new Date().toISOString(), status: "not-started", scientificQuality: "not-reviewed",
  scope: "Developer-provided single-task real model probe of candidate-code staging and completion. No full-case planning, code correctness, scientific result, human review or execution acceptance.",
  humanActions: [], generatedCodeExecuted: false, budget: { maxModelRequests: 8, maxTaskExecutions: 1, maxModelTokens: 150000, maxWallTimeMs: 180000 }, codeHashes: {} };
const save = async (file, value) => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of [config?.apiKey, proxy?.apiKey].filter(Boolean)) for (const representation of [secret, JSON.stringify(secret).slice(1, -1)]) text = text.split(representation).join("[REDACTED]");
  await writeFile(path.join(output, file), text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]") + "\n");
};
try {
  for (const file of ["domain", "planner", "task-contract", "code-staging", "orchestrator", "dsh-sdk", "bridge"]) summary.codeHashes[`dist/src/research/${file}.js`] = createHash("sha256").update(await readFile(path.join(root, `dist/src/research/${file}.js`))).digest("hex");
  config = await loadProviderConfig({ workspace: root });
  if (!config.apiKey?.trim()) throw new Error("No model provider key configured");
  summary.provider = config.provider; summary.model = config.model;
  proxy = await startCaseProviderProxy({ config, budget: { maxModelRequests: 8, maxOutputTokensPerRequest: 3072, taskTimeoutMs: 120000 }, signal: controller.signal });
  const question = "Prepare one small candidate randomization module for later human research review. This isolated transport probe does not authorize any code execution or scientific conclusion.";
  const { project } = await orchestrator.createProject(question, { budget: summary.budget, plan: { question, tasks: [{ taskId: "code", title: "Stage a candidate randomization module", kind: "code-preparation", maxAttempts: 1,
    objective: "Call code-stage exactly once to save a complete randomization.mjs module exporting fnv1a32(text), mulberry32(seed) and fixedCountMask(n,p,seed). FNV-1a32 hashes ASCII bytes with Math.imul, mulberry32 must support seed zero, and fixedCountMask uses descending Fisher-Yates with j=floor(U*(i+1)) then returns the first floor(n*p) indices. Validate inputs. Keep the module concise. Do not run code or register experimental results. Use files:[{name:'randomization.mjs',kind:'code',content:<complete source string>}]. After successful staging stop tools and return the exact persisted bundleId in refs with a completed structured result; candidate correctness and all human review remain pending." }] } });
  projectId = project.projectId; summary.projectId = projectId;
  const result = await runResearchWithDshAgent(orchestrator, { projectId, sdkHome: path.join(runtime, "sdk-home"), pluginFile: path.join(root, "desktop/dsh-sci-research-plugin.mjs"), cwd: workspace,
    provider: config.provider, model: config.model, baseUrl: proxy.baseUrl, apiKey: proxy.apiKey, maxSteps: 1, maxModelSteps: 6, maxTokens: 3072, taskTimeoutMs: 120000, signal: controller.signal });
  summary.status = result.status; summary.reason = result.reason;
} catch (error) {
  summary.status = controller.signal.aborted ? "time-budget-exhausted" : "failed";
  summary.failureKind = error?.name ?? "Error";
} finally {
  clearTimeout(timer); controller.abort(); await proxy?.close();
  if (projectId) {
    const snapshot = await repository.exportProject(projectId);
    await save("snapshot.json", snapshot);
    summary.productBudget = snapshot.budget;
    summary.taskStatus = snapshot.plan?.tasks[0].status;
    summary.codeBundles = snapshot.codeBundles.map((bundle) => ({ bundleId: bundle.bundleId, files: bundle.files.map(({ name, bytes, contentHash }) => ({ name, bytes, contentHash })) }));
    summary.rejections = snapshot.events.filter((event) => event.type === "research-action-rejected").map((event) => ({ action: event.data?.action, failureCode: event.data?.failureCode ?? "unclassified" }));
    summary.experiments = snapshot.experiments.length; summary.experimentRuns = snapshot.experimentRuns.length;
    summary.integrationPassed = summary.status === "completed" && snapshot.codeBundles.length === 1 && snapshot.plan.tasks[0].outputRefs.includes(snapshot.codeBundles[0].bundleId) && snapshot.experimentRuns.length === 0;
  }
  summary.providerCalls = proxy?.state;
  summary.finishedAt = new Date().toISOString();
  await save("summary.json", summary);
  console.log(JSON.stringify({ status: summary.status, integrationPassed: summary.integrationPassed ?? false, scientificQuality: summary.scientificQuality, rejections: summary.rejections, requests: summary.productBudget?.usedModelRequests, evidence: output }));
  if (!summary.integrationPassed) process.exitCode = 2;
}
