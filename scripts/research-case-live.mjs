// Opt-in P0: real model planning and official SDK execution, no auto-approval.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfig, ModelGateway } from "../dist/src/provider.js";
import { loadHttpServiceConfig, HttpSearchProvider } from "../dist/src/services.js";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { ModelResearchPlanner } from "../dist/src/research/planner.js";
import { runResearchWithDshAgent } from "../dist/src/research/dsh-sdk.js";
import { startCaseProviderProxy } from "./research-case-provider.mjs";
import { inspectCaseCitations } from "./research-case-quality.mjs";
import { appendCaseSourceHints, buildCaseQuestion, inspectCaseProtocolBinding, parseCaseLiveArgs, replayCasePlanInput } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseCaseLiveArgs(process.argv.slice(2));
const protocol = JSON.parse(await readFile(path.join(root, "research", "benchmarks", "imputation-v1.json"), "utf8"));
const output = path.join(root, "research", "validation", "cases", `${protocol.caseId}-${Date.now()}`);
const runtime = path.join(output, "runtime");
const workspace = path.join(runtime, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(path.join(output, "protocol.json"), JSON.stringify(protocol, null, 2) + "\n", "utf8");
const protocolSha256 = createHash("sha256").update(JSON.stringify(protocol)).digest("hex");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("Case wall budget exhausted")), protocol.budget.wallTimeoutMs);
const repository = new ResearchRepository(path.join(runtime, "research"));
let phase = "configuration";
let projectId;
let proxy;
let config;
let service;
const summary = {
  schema: "dsh-sci.research-case-live.v1", caseId: protocol.caseId, startedAt: new Date().toISOString(), protocolSha256,
  budget: protocol.budget, humanActions: [], operatorActions: [], status: "not-started", scientificQuality: "not-reviewed",
  resourceConfiguration: { version: 2, maxModelRequests: protocol.budget.maxModelRequests, reportedTokenStopThreshold: 1000000, note: "Product request accounting now includes planning. The reported-token stop threshold is new; historical baselines had no product token threshold. Unknown usage is not zero cost." },
  inputConfiguration: { version: 2, note: "Complete frozen protocol and replay output contract are now supplied verbatim. Historical questions omitted fixed-count masks and the mean-loss denominator; those cases are not protocol-compliant comparisons." },
  verificationScope: "Real model planning and official SDK research baseline. No automatic approval or experiment execution. Counts are observations, not scientific quality verification."
};
summary.runtimeCodeSha256 = {};
summary.runtimeCodeSha256["dist/src/research/reading-recovery.js"] = createHash("sha256").update(await readFile(path.join(root, "dist/src/research/reading-recovery.js"))).digest("hex");
summary.runtimeCodeSha256["dist/src/research/result-commit.js"] = createHash("sha256").update(await readFile(path.join(root, "dist/src/research/result-commit.js"))).digest("hex");
for (const file of ["dist/src/research/model-budget-proxy.js", "dist/src/model-usage.js", "dist/src/provider.js", "dist/src/research/domain.js", "dist/src/research/replay.js", "dist/src/research/dsh-sdk.js", "dist/src/research/task-result.js", "dist/src/research/task-contract.js", "dist/src/research/budget.js", "dist/src/research/repository.js", "dist/src/research/orchestrator.js", "dist/src/research/bridge.js", "dist/src/research/runner.js", "dist/src/research/planner.js", "desktop/dsh-sci-research-plugin.mjs", "scripts/research-case-live.mjs", "scripts/research-case-provider.mjs", "scripts/research-case-quality.mjs", "scripts/research-case-protocol.mjs"]) {
  summary.runtimeCodeSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
}
const redact = (value) => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of [config?.apiKey, service?.apiKey, proxy?.apiKey].filter(Boolean)) {
    for (const representation of [secret, JSON.stringify(secret).slice(1, -1)]) text = text.split(representation).join("[REDACTED]");
  }
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]") + "\n";
};
const save = async (name, value) => writeFile(path.join(output, name), redact(value), "utf8");
try {
  config = await loadProviderConfig({ workspace: root });
  service = await loadHttpServiceConfig({ workspace: root });
  summary.provider = config.provider;
  summary.model = config.model;
  summary.searchConfigured = Boolean(service.baseUrl && service.apiKey);
  summary.sourceHintsHumanSupplied = protocol.literature.seedReferences;
  summary.supplementalSourceHintsOperatorSupplied = options.sourceHints;
  if (options.sourceHints.length) {
    summary.inputConfiguration.version = 3;
    summary.inputConfiguration.supplement = "Operator-supplied accessible-version hints; frozen protocol and task objectives unchanged. Not an autonomous-discovery comparison with earlier runs.";
    summary.operatorActions.push({ action: "supplement-source-discovery-hints", urls: options.sourceHints, grantsApproval: false });
  }
  if (!config.apiKey?.trim()) throw new Error("No model provider key configured");
  proxy = await startCaseProviderProxy({ config, budget: protocol.budget, signal: controller.signal, phase: () => phase });
  const gateway = new ModelGateway({ config: { ...config, baseUrl: proxy.baseUrl, apiKey: proxy.apiKey, timeoutMs: protocol.budget.taskTimeoutMs } });
  const planner = new ModelResearchPlanner(gateway, config.model);
  const context = appendCaseSourceHints(buildCaseQuestion(protocol, summary.searchConfigured), options.sourceHints);
  phase = "planner";
  let plan;
  if (options.planFrom) {
    const source = await realpath(path.resolve(options.planFrom));
    const evidenceRoot = await realpath(path.join(root, "research", "validation", "cases"));
    const relative = path.relative(evidenceRoot, source);
    if (relative.startsWith("..") || path.isAbsolute(relative) || path.basename(source) !== "plan.json") throw new Error("Replay plan must be an existing case plan.json within the evidence directory");
    const savedText = await readFile(source, "utf8");
    const saved = JSON.parse(savedText);
    const savedProtocol = JSON.parse(await readFile(path.join(path.dirname(source), "protocol.json"), "utf8"));
    if (createHash("sha256").update(JSON.stringify(savedProtocol)).digest("hex") !== protocolSha256) throw new Error("Replay plan protocol does not match the frozen protocol");
    if (inspectCaseProtocolBinding(protocol, saved.question).status !== "bound") throw new Error("Replay plan omitted the complete frozen protocol; generate a fresh plan rather than replaying incompatible objectives");
    plan = replayCasePlanInput(saved, options.sourceHints);
    summary.planOrigin = "replay-of-live-model";
    summary.planSource = path.relative(root, source).replaceAll("\\", "/");
    summary.planSourceSha256 = createHash("sha256").update(savedText).digest("hex");
    summary.planReplayConfiguration = { version: 2, preservesSuccessCriteria: true, copiesExecutionState: false };
    summary.operatorActions.push({ action: "reuse-model-generated-plan", changedObjectives: false });
  } else {
    summary.planOrigin = "live-model";
  }
  // Acceptance uses the product planning/accounting path and rejects fallback.
  const orchestrator = new ResearchOrchestrator(repository, {}, planner, { experimentPolicy: { workspaceRoot: workspace }, strictPlanning: true });
  const created = await orchestrator.createProject(context, { plan, signal: controller.signal, budget: { maxTaskExecutions: protocol.budget.maxTaskExecutions, maxWallTimeMs: protocol.budget.wallTimeoutMs, maxModelRequests: protocol.budget.maxModelRequests, maxModelTokens: 1000000 } });
  projectId = created.project.projectId;
  summary.projectId = projectId;
  await save("plan.json", created.plan);
  phase = "agent";
  console.log(JSON.stringify({ phase, projectId, tasks: created.plan.tasks.length, output }));
  const result = await runResearchWithDshAgent(orchestrator, {
    projectId, sdkHome: path.join(runtime, "sdk-home"), pluginFile: path.join(root, "desktop", "dsh-sci-research-plugin.mjs"), cwd: workspace,
    provider: config.provider, model: config.model, baseUrl: proxy.baseUrl, apiKey: proxy.apiKey,
    maxSteps: protocol.budget.maxTaskExecutions, maxModelSteps: protocol.budget.maxModelStepsPerTask,
    maxTokens: protocol.budget.maxOutputTokensPerRequest, taskTimeoutMs: protocol.budget.taskTimeoutMs, signal: controller.signal,
    search: summary.searchConfigured ? new HttpSearchProvider(service) : undefined,
  });
  summary.status = result.status;
  summary.steps = result.steps;
  summary.stopReason = result.reason;
} catch (error) {
  summary.status = controller.signal.aborted ? "time-budget-exhausted" : "failed";
  summary.failure = { phase, kind: error?.name ?? "Error", message: String(error?.message ?? "Unknown failure").slice(0, 1500) };
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort();
  await proxy?.close();
  if (!projectId) projectId = (await repository.listProjects(1))[0]?.projectId;
  if (projectId) {
    const snapshot = await repository.exportProject(projectId);
    summary.protocolBinding = inspectCaseProtocolBinding(protocol, snapshot.project.question);
    const memory = await repository.listMemory();
    await save("snapshot.json", { ...snapshot, memory });
    const citationChecks = inspectCaseCitations(snapshot);
    await save("quality-check.json", { schema: "dsh-sci.research-case-quality.v1", citations: citationChecks, scope: "Stored-excerpt text matching and locator presence only; support and scientific interpretation require independent review." });
    await save("trace.json", { events: snapshot.events, tasks: snapshot.plan?.tasks, humanActions: summary.humanActions, operatorActions: summary.operatorActions });
    summary.productBudget = snapshot.budget;
    summary.finalProjectStatus = snapshot.project.status;
    summary.activeTask = snapshot.plan?.tasks.find((task) => task.taskId === snapshot.project.activeTaskId);
    summary.counts = Object.fromEntries(["sources", "citations", "claims", "evidence", "experiments", "experimentRuns", "artifacts", "evaluations", "reports"].map((name) => [name, snapshot[name].length]));
    summary.counts.memory = memory.length;
    summary.citationTextChecks = citationChecks;
    summary.completedTasks = snapshot.plan?.tasks.filter((task) => task.status === "completed").map(({ taskId, kind }) => ({ taskId, kind }));
    summary.gaps = [
      ...(!summary.searchConfigured ? ["General search is not configured; supplied source URLs are human discovery hints."] : []),
      ...(snapshot.experimentRuns.length === 0 ? ["No approved experiment has run; no scientific result is validated."] : []),
      ...(snapshot.evaluations.length === 0 ? ["No persisted statistical evaluation."] : []),
      ...(snapshot.reports.length === 0 ? ["No persisted research report."] : []),
      ...(memory.length === 0 ? ["No persisted research memory."] : []),
      "Source relevance, citation fidelity and scientific interpretation still require independent review."
    ];
  }
  summary.providerCalls = proxy?.state ?? { requests: [], deniedRequests: 0, budgetExhausted: false };
  summary.cost = "unknown";
  summary.finishedAt = new Date().toISOString();
  summary.runtimeRetainedLocally = true;
  await save("summary.json", summary);
  console.log(JSON.stringify({ status: summary.status, completedTasks: summary.completedTasks?.length ?? 0, requests: summary.providerCalls.requests.length, counts: summary.counts, evidence: output }));
  // Exit 2 preserves an incomplete run as evidence without reporting success.
  if (summary.status === "failed") process.exitCode = 1;
  else if (summary.status !== "completed") process.exitCode = 2;
}
