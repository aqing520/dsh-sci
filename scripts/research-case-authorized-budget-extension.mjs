// Apply the explicitly approved immutable budget-extension proposal.
// Historical counters and reservations are preserved; commit mode is required
// for mutation and the proposal SHA/revision are checked before every write.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDirectory = path.join(root, "research", "validation", "cases", "imputation-v1-1793358639679");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const proposalPath = path.resolve(value("--proposal") ?? path.join(caseDirectory, "budget-extension-proposal-revision-146.json"));
const suppliedSha = value("--proposal-sha256");
const expectedRevision = Number(value("--expected-revision") ?? "146");
const commit = args.includes("--commit");
if (args.includes("--help") || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
  console.log("Usage: node scripts/research-case-authorized-budget-extension.mjs --proposal <proposal.json> --proposal-sha256 <sha256> --expected-revision <revision> [--commit]");
  process.exit(0);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proposalBytes = await readFile(proposalPath);
const proposalSha256 = sha256(proposalBytes);
if (suppliedSha !== proposalSha256) throw new Error("Proposal SHA does not match the immutable proposal bytes");
const proposal = JSON.parse(proposalBytes);
if (proposal.schema !== "dsh-sci.authorized-budget-extension-proposal.v1") throw new Error("Unexpected proposal schema");
if (proposal.expectedBudgetRevision !== expectedRevision) throw new Error("Proposal revision does not match expected revision");
const requested = proposal.requestedChange;
if (!requested || !Number.isSafeInteger(requested.maxTaskExecutions) || !Number.isSafeInteger(requested.maxModelRequests) || !Number.isSafeInteger(requested.maxModelTokens) || requested.maxWallTimeMs !== 1_800_000 || requested.restartWallClock !== true || requested.preserveHistoricalCounters !== true) throw new Error("Proposal requested change is invalid");

const { ResearchRepository } = await import("../dist/src/research/repository.js");
const { ResearchOrchestrator } = await import("../dist/src/research/orchestrator.js");
const repository = new ResearchRepository(path.join(caseDirectory, "runtime", "research"));
const projects = await repository.listProjects(10_000);
if (projects.length !== 1) throw new Error(`Expected one main case project, found ${projects.length}`);
const project = projects[0];
const before = await repository.exportProject(project.projectId);
const budget = before.budget;
if (!budget || budget.schema !== "dsh-sci.research-budget.v2") throw new Error("Main case must use a metered budget");
if (budget.revision !== expectedRevision) throw new Error(`Budget revision changed; expected ${expectedRevision}, found ${budget.revision}`);
if (requested.maxTaskExecutions < budget.maxTaskExecutions || requested.maxModelRequests < budget.maxModelRequests || requested.maxModelTokens < budget.maxModelTokens) throw new Error("Budget extension cannot lower an existing limit");
for (const key of ["usedModelRequests", "reportedTotalTokens", "unknownUsageRequests"]) {
  if (budget[key] !== proposal.currentLedger[key]) throw new Error(`Current ledger ${key} differs from immutable proposal baseline`);
}
if (budget.usedTaskExecutions < proposal.currentLedger.usedTaskExecutions) throw new Error("Current task execution ledger moved backwards");
if (budget.modelRequests.some((request) => request.status === "reserved")) throw new Error("Pending reservations must settle before budget update");
const result = {
  schema: "dsh-sci.authorized-budget-extension-preview.v1",
  proposalSha256,
  proposalId: proposal.proposalId,
  projectId: project.projectId,
  planId: project.planId,
  revisionBefore: budget.revision,
  limitsBefore: { maxTaskExecutions: budget.maxTaskExecutions, maxModelRequests: budget.maxModelRequests, maxModelTokens: budget.maxModelTokens, maxWallTimeMs: budget.maxWallTimeMs },
  usedTaskExecutionsBefore: budget.usedTaskExecutions,
  approvedBaselineTaskExecutions: proposal.currentLedger.usedTaskExecutions,
  taskExecutionBaselineDrift: budget.usedTaskExecutions - proposal.currentLedger.usedTaskExecutions,
  usedModelRequestsBefore: budget.usedModelRequests,
  reportedTotalTokensBefore: budget.reportedTotalTokens,
  unknownUsageRequestsBefore: budget.unknownUsageRequests,
  pendingReservationsBefore: budget.modelRequests.filter((request) => request.status === "reserved").length,
  commit,
  historicalLedgerPreserved: true,
  approvalsChanged: false,
  experimentsStarted: 0,
};
if (commit) {
  const updated = await new ResearchOrchestrator(repository).updateBudget(project.projectId, {
    maxTaskExecutions: requested.maxTaskExecutions,
    maxWallTimeMs: requested.maxWallTimeMs,
    maxModelRequests: requested.maxModelRequests,
    maxModelTokens: requested.maxModelTokens,
  }, { restartWallClock: true });
  if (updated.usedTaskExecutions !== budget.usedTaskExecutions || updated.usedModelRequests !== budget.usedModelRequests || updated.reportedTotalTokens !== budget.reportedTotalTokens || updated.unknownUsageRequests !== budget.unknownUsageRequests || updated.modelRequests.length !== budget.modelRequests.length) throw new Error("Historical budget ledger changed during extension");
  if (updated.maxTaskExecutions !== requested.maxTaskExecutions || updated.maxModelRequests !== requested.maxModelRequests || updated.maxModelTokens !== requested.maxModelTokens || updated.maxWallTimeMs !== requested.maxWallTimeMs || updated.exhausted) throw new Error("Approved budget limits were not persisted");
  result.schema = "dsh-sci.authorized-budget-extension.v1";
  result.revisionAfter = updated.revision;
  result.startedAtAfter = updated.startedAt;
  result.limitsAfter = { maxTaskExecutions: updated.maxTaskExecutions, maxModelRequests: updated.maxModelRequests, maxModelTokens: updated.maxModelTokens, maxWallTimeMs: updated.maxWallTimeMs };
  result.remainingTaskExecutions = updated.maxTaskExecutions - updated.usedTaskExecutions;
  result.remainingRequests = updated.maxModelRequests - updated.usedModelRequests;
  result.remainingTokens = updated.maxModelTokens - updated.reportedTotalTokens;
  const outputDirectory = path.join(caseDirectory, `budget-extension-${Date.now()}`);
  await mkdir(outputDirectory, { recursive: false });
  await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  result.evidencePath = path.relative(root, outputDirectory).replaceAll("\\", "/");
}
console.log(JSON.stringify(result, null, 2));
