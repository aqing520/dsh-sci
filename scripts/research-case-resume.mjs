// Resume an existing persisted research case after Workspace approvals.
// This command never approves a design, task, proposal, or experiment. Without
// --run it is a read-only checkpoint inspector; with --run it only starts the
// normal DSH runner, which will stop again at the next approval boundary.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCaseProtocolBinding } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const caseArg = args.find((value) => value.startsWith("--case="))?.slice("--case=".length)
  ?? (args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined);
const run = args.includes("--run");
if (!caseArg || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/research-case-resume.mjs --case <case-directory> [--run]");
  console.log("Default mode prints the approval checkpoint without changing files. --run resumes the DSH runner after Workspace approvals.");
  process.exit(caseArg ? 0 : 2);
}

const caseDirectory = path.resolve(caseArg);
const caseRelative = path.relative(path.join(root, "research", "validation", "cases"), caseDirectory);
if (caseRelative.startsWith("..") || path.isAbsolute(caseRelative)) throw new Error("Case directory must be inside research/validation/cases");
const runtime = path.join(caseDirectory, "runtime");
const repositoryRoot = path.join(runtime, "research");
const workspace = path.join(runtime, "workspace");
const protocol = JSON.parse(await readFile(path.join(caseDirectory, "protocol.json"), "utf8"));
const [{ ResearchRepository }, { ResearchOrchestrator }, { runResearchWithDshAgent }, { loadProviderConfig }, { loadHttpServiceConfig, HttpSearchProvider }] = await Promise.all([
  import("../dist/src/research/repository.js"),
  import("../dist/src/research/orchestrator.js"),
  import("../dist/src/research/dsh-sdk.js"),
  import("../dist/src/provider.js"),
  import("../dist/src/services.js"),
]);
const repository = new ResearchRepository(repositoryRoot);
const projects = await repository.listProjects(10_000);
if (projects.length !== 1) throw new Error(`Expected exactly one project in case, found ${projects.length}`);
const project = projects[0];
const snapshot = await repository.exportProject(project.projectId);
let taskTimeoutMs = protocol.budget.taskTimeoutMs;
let timeoutOverride;
try {
  const recoveryDirectories = (await readdir(caseDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("recovery-extension-commit-"))
    .map((entry) => path.join(caseDirectory, entry.name, "runtime-extension.json"))
    .sort().reverse();
  for (const candidate of recoveryDirectories) {
    try {
      const value = JSON.parse(await readFile(candidate, "utf8"));
      if (value.projectId === project.projectId && value.planId === project.planId && value.proposalSha256 && Number.isSafeInteger(value.taskTimeoutMs) && value.taskTimeoutMs >= protocol.budget.taskTimeoutMs && value.taskTimeoutMs <= 30 * 60_000) {
        taskTimeoutMs = value.taskTimeoutMs;
        timeoutOverride = { ...value, path: path.relative(root, candidate).replaceAll("\\", "/") };
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.name !== "SyntaxError") throw error;
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const taskRows = (snapshot.plan?.tasks ?? []).map((task) => ({ taskId: task.taskId, kind: task.kind, status: task.status, title: task.title, outputRefs: task.outputRefs, nextAction: task.nextAction }));
const approvals = await repository.listApprovalQueue();
const designs = snapshot.experimentDesigns.map((design) => ({ designId: design.designId, status: design.status, contentHash: design.contentHash, bundleIds: snapshot.codeBundles.filter((bundle) => bundle.taskId === design.taskId).map((bundle) => bundle.bundleId) }));
const checkpoint = {
  schema: "dsh-sci.research-case-resume-checkpoint.v1",
  caseDirectory: path.relative(root, caseDirectory).replaceAll("\\", "/"),
  protocolSha256: createHash("sha256").update(JSON.stringify(protocol)).digest("hex"),
  projectId: project.projectId,
  projectStatus: project.status,
  protocolBinding: inspectCaseProtocolBinding(protocol, snapshot.project.question),
  activeTaskId: project.activeTaskId,
  tasks: taskRows,
  designs,
  approvalQueue: approvals.map((item) => item.kind === "task"
    ? { kind: item.kind, taskId: item.task.taskId, title: item.task.title, projectId: item.project.projectId }
    : { kind: item.kind, experimentId: item.experiment.experimentId, title: item.experiment.title, taskId: item.experiment.taskId, proposalContentHash: item.experiment.proposalContentHash, projectId: item.project.projectId }),
  counts: Object.fromEntries(["sources", "citations", "claims", "evidence", "hypotheses", "experimentDesigns", "codeBundles", "experiments", "experimentRuns", "artifacts", "evaluations", "reports"].map((name) => [name, snapshot[name].length])),
  action: run ? "runner-requested" : "read-only",
  ...(timeoutOverride ? { taskTimeoutMs, timeoutOverride } : { taskTimeoutMs }),
};
console.log(JSON.stringify(checkpoint, null, 2));
if (!run) process.exit(0);

if (checkpoint.protocolBinding.status !== "bound") throw new Error(checkpoint.protocolBinding.issues.join(" "));

if (project.status === "paused" || project.status === "failed") throw new Error(`Project is ${project.status}; resume it in Research Workspace before --run`);
const budget = snapshot.budget;
if (!budget || (budget.startedAt && Date.now() - Date.parse(budget.startedAt) >= budget.maxWallTimeMs) || budget.exhausted || (budget.schema === "dsh-sci.research-budget.v2" && (budget.usedModelRequests >= budget.maxModelRequests || budget.reportedTotalTokens >= budget.maxModelTokens))) {
  throw new Error("Research budget is exhausted or expired; extend it in Research Workspace before --run");
}
if ((snapshot.plan?.tasks ?? []).some((task) => task.status === "waiting-approval")) {
  throw new Error("A task is still waiting for Workspace approval; approve the exact task first, then rerun with --run");
}
const config = await loadProviderConfig({ workspace: root });
if (!config.apiKey?.trim()) throw new Error("No model provider key configured");
const service = await loadHttpServiceConfig({ workspace: root });
const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { strictPlanning: true, experimentPolicy: { workspaceRoot: workspace } });
const result = await runResearchWithDshAgent(orchestrator, {
  projectId: project.projectId,
  sdkHome: path.join(runtime, "sdk-home"),
  pluginFile: path.join(root, "desktop", "dsh-sci-research-plugin.mjs"),
  cwd: workspace,
  provider: config.provider,
  model: config.model,
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  maxSteps: protocol.budget.maxTaskExecutions,
  maxModelSteps: protocol.budget.maxModelStepsPerTask,
  maxTokens: protocol.budget.maxOutputTokensPerRequest,
  taskTimeoutMs,
  sessionScope: "plan",
  search: service.baseUrl && service.apiKey ? new HttpSearchProvider(service) : undefined,
});
console.log(JSON.stringify({ schema: "dsh-sci.research-case-resume-result.v1", projectId: project.projectId, status: result.status, steps: result.steps, reason: result.reason }, null, 2));
