// Apply an explicitly approved wall-clock restart without resetting the
// historical model ledger. A proposal SHA and expected budget revision are
// required for mutation; default mode is read-only preview.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDirectory = path.join(root, "research", "validation", "cases", "imputation-v1-1793358639679");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const proposalPath = path.resolve(value("--proposal") ?? path.join(caseDirectory, "wall-clock-restart-proposal-revision-93.json"));
const suppliedSha = value("--proposal-sha256");
const expectedRevision = Number(value("--expected-revision") ?? "93");
const commit = args.includes("--commit");
if (args.includes("--help") || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
  console.log("Usage: node scripts/research-case-authorized-wall-clock-restart.mjs --proposal <proposal.json> --proposal-sha256 <sha256> --expected-revision <revision> [--commit]");
  process.exit(0);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proposalBytes = await readFile(proposalPath);
const proposalSha256 = sha256(proposalBytes);
const proposal = JSON.parse(proposalBytes);
if (suppliedSha !== proposalSha256) throw new Error("Proposal SHA does not match the current immutable proposal bytes");
if (proposal.schema !== "dsh-sci.authorized-wall-clock-restart-proposal.v1" || proposal.expectedBudgetRevision !== expectedRevision) throw new Error("Proposal schema or expected budget revision mismatch");
const { ResearchRepository } = await import("../dist/src/research/repository.js");
const { ResearchOrchestrator } = await import("../dist/src/research/orchestrator.js");
const repository = new ResearchRepository(path.join(caseDirectory, "runtime", "research"));
const [project] = await repository.listProjects(10_000);
if (!project) throw new Error("Main case project not found");
const before = await repository.exportProject(project.projectId);
const budget = before.budget;
if (!budget || budget.schema !== "dsh-sci.research-budget.v2") throw new Error("Main case must use a metered budget");
if (budget.revision !== expectedRevision) throw new Error(`Budget revision changed; expected ${expectedRevision}, found ${budget.revision}`);
if (budget.modelRequests.some((request) => request.status === "reserved")) throw new Error("Pending model reservations must settle before restart");
const result = { schema: "dsh-sci.authorized-wall-clock-restart-preview.v1", proposalSha256, projectId: project.projectId, planId: project.planId, revisionBefore: budget.revision, maxWallTimeMsBefore: budget.maxWallTimeMs, usedModelRequestsBefore: budget.usedModelRequests, reportedTotalTokensBefore: budget.reportedTotalTokens, pendingReservationsBefore: budget.modelRequests.filter((request) => request.status === "reserved").length, commit, historicalLedgerPreserved: true, approvalsChanged: false, experimentsStarted: 0 };
if (commit) {
  const updated = await new ResearchOrchestrator(repository).updateBudget(project.projectId, { maxTaskExecutions: budget.maxTaskExecutions, maxWallTimeMs: proposal.requestedChange.maxWallTimeMs, maxModelRequests: budget.maxModelRequests, maxModelTokens: budget.maxModelTokens }, { restartWallClock: true });
  if (updated.usedModelRequests !== budget.usedModelRequests || updated.reportedTotalTokens !== budget.reportedTotalTokens || updated.modelRequests.length !== budget.modelRequests.length) throw new Error("Historical model ledger changed during wall-clock restart");
  result.revisionAfter = updated.revision; result.startedAtAfter = updated.startedAt; result.maxWallTimeMsAfter = updated.maxWallTimeMs; result.remainingRequests = updated.maxModelRequests - updated.usedModelRequests; result.remainingTokens = updated.maxModelTokens - updated.reportedTotalTokens;
  const outputDirectory = path.join(caseDirectory, `wall-clock-restart-${Date.now()}`);
  await mkdir(outputDirectory, { recursive: false });
  await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify({ ...result, schema: "dsh-sci.authorized-wall-clock-restart.v1" }, null, 2) + "\n", { flag: "wx" });
  result.evidencePath = path.relative(root, outputDirectory).replaceAll("\\", "/");
}
console.log(JSON.stringify(result, null, 2));
