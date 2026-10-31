// Prepare an offline, reviewable continuation checkpoint for a paused case.
// This script never calls a model, creates a plan, changes the research store,
// approves anything, or starts an experiment. A later approved run must use
// the normal case-resume command after a fresh budget window is configured.
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCaseWorkspace } from "./research-case-workspace-core.mjs";
import { inspectCaseProtocolBinding } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const casesRoot = path.join(root, "research", "validation", "cases");
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const caseArg = valueAfter("--case") ?? args.find((value) => value.startsWith("--case="))?.slice(7);
const proposalArg = valueAfter("--proposal") ?? args.find((value) => value.startsWith("--proposal="))?.slice(11);
const shouldWrite = args.includes("--write");

if (!caseArg || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/research-case-prepare-resume.mjs --case <case-directory> [--proposal <proposed-plan-input.json>] [--write]");
  console.log("Default mode prints a checkpoint. --write saves a new offline-resume-preparation-<timestamp>.json file.");
  process.exit(caseArg ? 0 : 2);
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
function sha256(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }

const { directory: caseDirectory, repository, projectId } = await loadCaseWorkspace(path.resolve(caseArg), casesRoot);
const protocol = await readJson(path.join(caseDirectory, "protocol.json"));
const protocolSha256 = sha256(protocol);
const snapshot = await repository.exportProject(projectId);
const snapshotSha256 = sha256(snapshot);
let resolvedProposalPath = proposalArg ? path.resolve(proposalArg) : undefined;
if (!resolvedProposalPath) {
  const directories = (await readdir(caseDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("material-revision-"))
    .map((entry) => path.join(caseDirectory, entry.name, "proposed-plan-input.json"))
    .sort()
    .reverse();
  for (const candidate of directories) {
    try { await readFile(candidate); resolvedProposalPath = candidate; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
if (!resolvedProposalPath) throw new Error("No proposed-plan-input.json found; pass --proposal explicitly");
const proposal = await readJson(resolvedProposalPath);

const tasks = Array.isArray(proposal.tasks) ? proposal.tasks : [];
const expectedKinds = ["source-review", "hypothesis", "experiment-design"];
const proposalIssues = [];
if (tasks.length < 3 || tasks.length > 12) proposalIssues.push(`proposal must contain 3..12 tasks (found ${tasks.length})`);
for (let index = 0; index < expectedKinds.length; index += 1) {
  if (tasks[index]?.kind !== expectedKinds[index]) proposalIssues.push(`task ${index + 1} must be ${expectedKinds[index]}`);
}
if (tasks[0]?.dependsOn?.length) proposalIssues.push("task 1 must have no dependencies");
if (tasks[1] && JSON.stringify(tasks[1].dependsOn ?? []) !== JSON.stringify([tasks[0]?.taskId])) proposalIssues.push("task 2 must depend only on task 1");
if (tasks[2] && JSON.stringify(tasks[2].dependsOn ?? []) !== JSON.stringify([tasks[1]?.taskId])) proposalIssues.push("task 3 must depend only on task 2");
if (inspectCaseProtocolBinding(protocol, proposal.question).status !== "bound") proposalIssues.push("proposal question does not bind the full case protocol and hash");
const constraintsNeedNormalization = !proposal.constraints || Array.isArray(proposal.constraints)
  || proposal.constraints.maxIterations !== 2 || proposal.constraints.maxTaskAttempts !== 2;
const exhaustedTasks = (snapshot.plan?.tasks ?? [])
  .filter((task) => task.status === "failed" && task.attempts >= task.maxAttempts)
  .map(({ taskId, attempts, maxAttempts }) => ({ taskId, attempts, maxAttempts }));

const countNames = ["sources", "citations", "claims", "evidence", "hypotheses", "experimentDesigns", "codeBundles", "experiments", "experimentRuns", "artifacts", "evaluations", "reports", "memory"];
const counts = Object.fromEntries(countNames.map((name) => [name, Array.isArray(snapshot[name]) ? snapshot[name].length : 0]));
const budget = snapshot.budget ?? null;
const checkpoint = {
  schema: "dsh-sci.offline-resume-preparation.v1",
  generatedAt: new Date().toISOString(),
  caseDirectory: path.relative(root, caseDirectory).replaceAll("\\", "/"),
  proposalPath: path.relative(root, resolvedProposalPath).replaceAll("\\", "/"),
  proposalSha256: sha256(proposal),
  protocolSha256,
  snapshotSha256,
  projectId: snapshot.project?.projectId ?? snapshot.projectId,
  planId: snapshot.plan?.planId ?? null,
  projectStatus: snapshot.project?.status ?? "unknown",
  stateSource: "authoritative-research-repository",
  tasks: (snapshot.plan?.tasks ?? []).map(({ taskId, kind, status, attempts, maxAttempts }) => ({ taskId, kind, status, attempts, maxAttempts })),
  proposalValidation: { ok: proposalIssues.length === 0, issues: proposalIssues, scope: "First three task kinds, dependencies, count and exact protocol binding only; not plan approval or scientific review." },
  recoveryRequirements: {
    exhaustedTasks,
    newPlanRequired: exhaustedTasks.length > 0,
    iterationLimitReached: Boolean(snapshot.plan && snapshot.project && snapshot.project.iteration >= snapshot.plan.constraints.maxIterations),
    replanningAllowed: Boolean(snapshot.plan && snapshot.project && snapshot.project.iteration < snapshot.plan.constraints.maxIterations),
    constraintsNeedNormalization,
    requiredConstraints: { maxIterations: 2, maxTaskAttempts: 2 },
    note: "The saved proposal has not been committed. Preserve the old failed tasks; use the formal plan commit flow for a new plan. Normalize prose constraints to the kernel constraint object with explicit operator attribution; do not silently use default limits.",
  },
  budget: budget ? {
    schema: budget.schema,
    maxModelRequests: budget.maxModelRequests,
    usedModelRequests: budget.usedModelRequests,
    maxModelTokens: budget.maxModelTokens,
    reportedTotalTokens: budget.reportedTotalTokens,
    unknownUsageRequests: budget.unknownUsageRequests,
    pendingReservations: Array.isArray(budget.modelRequests) ? budget.modelRequests.filter((request) => request.status === "reserved").length : 0,
    wallBudgetExpired: Boolean(budget.startedAt && Number.isFinite(Date.parse(budget.startedAt)) && Date.now() - Date.parse(budget.startedAt) >= budget.maxWallTimeMs),
  } : null,
  counts,
  action: "offline-checkpoint-only",
  modelCalls: 0,
  planCreated: false,
  approvalsChanged: false,
  experimentsStarted: 0,
  scientificQuality: "not-reviewed",
    nextStep: "The exhausted task requires a new plan identity, but the frozen iteration limit must be checked first. Only continue through a formally valid plan transition; otherwise preserve this failed case for operator re-planning. No simulation is authorized.",
};
if (sha256(await repository.exportProject(projectId)) !== snapshotSha256) throw new Error("Research state changed while preparing checkpoint; stop writers and retry");
if (shouldWrite) {
  const output = path.join(caseDirectory, `offline-resume-preparation-${Date.now()}.json`);
  await writeFile(output, JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx" });
  checkpoint.outputPath = path.relative(root, output).replaceAll("\\", "/");
}
console.log(JSON.stringify(checkpoint, null, 2));
if (!checkpoint.proposalValidation.ok) process.exitCode = 1;
