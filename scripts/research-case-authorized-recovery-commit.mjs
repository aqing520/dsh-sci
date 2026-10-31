// Commit an explicitly approved operational recovery extension.
// The failed plan remains immutable history; a new plan identity gets fresh
// task attempt counters, while the model budget ledger is never reset.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildResearchPlan, makeEvent } from "../dist/src/research/domain.js";
import { contentDigest } from "../dist/src/research/content-digest.js";
import { planCommitHash } from "../dist/src/research/plan-commit.js";
import { ResearchRepository } from "../dist/src/research/repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDirectory = path.join(root, "research", "validation", "cases", "imputation-v1-1793358639679");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const proposalPath = path.resolve(value("--proposal") ?? path.join(caseDirectory, "recovery-extension-proposal.json"));
const suppliedSha = value("--proposal-sha256");
const commit = args.includes("--commit");
if (args.includes("--help") || !suppliedSha) {
  console.log("Usage: node scripts/research-case-authorized-recovery-commit.mjs --proposal <proposal.json> --proposal-sha256 <sha256> [--commit]");
  process.exit(suppliedSha ? 0 : 2);
}
const proposalBytes = await readFile(proposalPath);
const proposalSha256 = createHash("sha256").update(proposalBytes).digest("hex");
if (suppliedSha !== proposalSha256) throw new Error("Proposal SHA does not match immutable proposal bytes");
const proposal = JSON.parse(proposalBytes);
if (proposal.schema !== "dsh-sci.authorized-recovery-extension-proposal.v1") throw new Error("Unexpected recovery proposal schema");
const repository = new ResearchRepository(path.join(caseDirectory, "runtime", "research"));
const projects = await repository.listProjects(10_000);
if (projects.length !== 1) throw new Error(`Expected one main case project, found ${projects.length}`);
const beforeProject = projects[0];
if (beforeProject.projectId !== proposal.projectId) throw new Error("Proposal project does not match the case");
if (beforeProject.planId !== proposal.currentPlanId || beforeProject.iteration !== proposal.currentPlanIteration || beforeProject.status !== "failed") throw new Error("Recovery proposal no longer matches the authoritative failed plan");
const beforePlan = await repository.readPlan(beforeProject.projectId, beforeProject.planId);
if (!beforePlan || beforePlan.status !== "active") throw new Error("Current failed plan is missing or not active");
if (beforePlan.constraints.maxIterations !== 3 || beforePlan.constraints.maxTaskAttempts !== 2) throw new Error("Current plan constraints differ from the approved recovery baseline");
const snapshot = await repository.exportProject(beforeProject.projectId);
const budget = snapshot.budget;
if (!budget || budget.revision !== proposal.currentPlanRevision || budget.usedTaskExecutions !== proposal.currentLedger.usedTaskExecutions || budget.usedModelRequests !== proposal.currentLedger.usedModelRequests || budget.reportedTotalTokens !== proposal.currentLedger.reportedTotalTokens || budget.unknownUsageRequests !== proposal.currentLedger.unknownUsageRequests) throw new Error("Budget ledger changed since the approved recovery proposal");
if (budget.modelRequests.some((request) => request.status === "reserved")) throw new Error("Pending reservations must settle before recovery commit");
if (await repository.hasPendingPlanCommit(beforeProject.projectId)) throw new Error("A pending plan commit already exists; recover it before creating another");

const tasks = beforePlan.tasks.map((task) => ({ taskId: task.taskId, title: task.title, objective: task.objective, kind: task.kind, dependsOn: task.dependsOn, requiresApproval: task.requiresApproval, successCriteria: task.successCriteria }));
const nextPlan = buildResearchPlan(beforeProject.projectId, { title: beforePlan.title, question: beforePlan.question, tasks, constraints: { maxIterations: 4, maxTaskAttempts: 3 } }, new Date().toISOString());
nextPlan.version = beforePlan.version + 1;
nextPlan.planning = { source: "provided", planner: "operator-approved-recovery-extension", reason: `Recovery extension ${proposalSha256}; supersedes failed plan ${beforePlan.planId}; preserves failed task history.` };
const nextProject = { ...beforeProject, planId: nextPlan.planId, activeTaskId: undefined, status: "paused", iteration: 4, lastError: "Recovery extension committed; resume through the normal DSH runner.", updatedAt: nextPlan.updatedAt };
const events = [makeEvent(beforeProject.projectId, "plan-created", { planId: nextPlan.planId, values: { taskCount: nextPlan.tasks.length, replanned: true, offline: true, recoveryExtension: true, supersedesPlanId: beforePlan.planId, proposalSha256 } }, nextPlan.createdAt)];
const content = { schema: "dsh-sci.research-plan-commit.v1", commitId: contentDigest({ projectId: beforeProject.projectId, beforePlanId: beforePlan.planId, nextPlanId: nextPlan.planId }), projectId: beforeProject.projectId, status: "prepared", beforeProject, beforePlan, nextProject, nextPlan, protocolExtension: { proposalSha256, fromMaxIterations: 3, toMaxIterations: 4 }, events };
const planCommit = { ...content, contentHash: planCommitHash(content) };
const result = { schema: "dsh-sci.authorized-recovery-extension-preview.v1", proposalSha256, projectId: beforeProject.projectId, previousPlanId: beforePlan.planId, nextPlanId: nextPlan.planId, revisionBefore: budget.revision, currentLedgerPreserved: true, commit, timeoutMsBefore: 120000, timeoutMsAfter: 300000, maxTaskAttemptsBefore: 2, maxTaskAttemptsAfter: 3, maxIterationsBefore: 3, maxIterationsAfter: 4, experimentsStarted: 0, approvalsChanged: false };
if (commit) {
  await repository.savePlanCommit(planCommit);
  await repository.applyPlanCommit(planCommit);
  const after = await repository.exportProject(beforeProject.projectId);
  if (after.project.planId !== nextPlan.planId || after.project.status !== "paused" || after.plan.constraints.maxIterations !== 4 || after.plan.constraints.maxTaskAttempts !== 3) throw new Error("Recovery plan commit did not persist expected state");
  if (after.budget.usedTaskExecutions !== budget.usedTaskExecutions || after.budget.usedModelRequests !== budget.usedModelRequests || after.budget.reportedTotalTokens !== budget.reportedTotalTokens || after.budget.modelRequests.length !== budget.modelRequests.length) throw new Error("Recovery commit changed historical budget ledger");
  result.schema = "dsh-sci.authorized-recovery-extension.v1";
  result.committedAt = new Date().toISOString();
  result.outputPlanId = after.project.planId;
  result.budgetRevisionAfter = after.budget.revision;
  result.timeoutOverride = { projectId: beforeProject.projectId, planId: nextPlan.planId, proposalSha256, taskTimeoutMs: 300000 };
  const outputDirectory = path.join(caseDirectory, `recovery-extension-commit-${Date.now()}`);
  await mkdir(outputDirectory, { recursive: false });
  await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  await writeFile(path.join(outputDirectory, "runtime-extension.json"), JSON.stringify(result.timeoutOverride, null, 2) + "\n", { flag: "wx" });
  result.evidencePath = path.relative(root, outputDirectory).replaceAll("\\", "/");
}
console.log(JSON.stringify(result, null, 2));
