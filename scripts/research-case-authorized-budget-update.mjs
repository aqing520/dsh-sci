// Apply the explicitly approved budget-window extension for the main case.
// Historical request/token counters are never reset. The update is idempotent
// for the same active limits and only restarts the persisted wall-clock window.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDirectory = path.join(root, "research", "validation", "cases", "imputation-v1-1793358639679");
const repositoryRoot = path.join(caseDirectory, "runtime", "research");
const { ResearchRepository } = await import("../dist/src/research/repository.js");
const { ResearchOrchestrator } = await import("../dist/src/research/orchestrator.js");
const repository = new ResearchRepository(repositoryRoot);
const projects = await repository.listProjects(10_000);
if (projects.length !== 1) throw new Error(`Expected one main case project, found ${projects.length}`);
const before = await repository.exportProject(projects[0].projectId);
const authorization = "批准：在保留全部历史账本的基础上新增30分钟窗口，并把请求上限提高到48次";
const authorizationSha256 = createHash("sha256").update(authorization).digest("hex");
const limits = { maxTaskExecutions: 12, maxWallTimeMs: 30 * 60_000, maxModelRequests: 48, maxModelTokens: 2_000_000 };
if (before.budget.schema !== "dsh-sci.research-budget.v2") throw new Error("Main case must use the metered budget schema");
if (before.budget.usedModelRequests !== 29 || before.budget.reportedTotalTokens !== 1_340_293) throw new Error("Budget baseline changed; review before applying the approved extension");
if (before.budget.modelRequests.some((request) => request.status === "reserved")) throw new Error("Pending reservations must be settled before budget update");
const orchestrator = new ResearchOrchestrator(repository);
const updated = await orchestrator.updateBudget(projects[0].projectId, limits, { restartWallClock: true });
const after = await repository.exportProject(projects[0].projectId);
if (after.budget.usedModelRequests !== before.budget.usedModelRequests || after.budget.reportedTotalTokens !== before.budget.reportedTotalTokens || after.budget.modelRequests.length !== before.budget.modelRequests.length) throw new Error("Historical budget ledger changed during extension");
if (after.budget.maxModelRequests !== 48 || after.budget.maxModelTokens !== 2_000_000 || after.budget.maxWallTimeMs !== 30 * 60_000 || after.budget.exhausted) throw new Error("Approved budget limits were not persisted");
const outputDirectory = path.join(caseDirectory, `budget-extension-${Date.now()}`);
await mkdir(outputDirectory, { recursive: false });
const result = {
  schema: "dsh-sci.authorized-budget-extension.v1",
  authorization,
  authorizationSha256,
  projectId: projects[0].projectId,
  planId: after.project.planId,
  before: { revision: before.budget.revision, maxModelRequests: before.budget.maxModelRequests, maxModelTokens: before.budget.maxModelTokens, maxWallTimeMs: before.budget.maxWallTimeMs, startedAt: before.budget.startedAt, usedModelRequests: before.budget.usedModelRequests, reportedTotalTokens: before.budget.reportedTotalTokens },
  after: { revision: after.budget.revision, maxModelRequests: after.budget.maxModelRequests, maxModelTokens: after.budget.maxModelTokens, maxWallTimeMs: after.budget.maxWallTimeMs, startedAt: after.budget.startedAt, usedModelRequests: after.budget.usedModelRequests, reportedTotalTokens: after.budget.reportedTotalTokens, unknownUsageRequests: after.budget.unknownUsageRequests, pendingReservations: after.budget.modelRequests.filter((request) => request.status === "reserved").length },
  historicalLedgerPreserved: true,
  approvalsChanged: false,
  experimentsStarted: 0,
  scientificQuality: "not-reviewed",
};
await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...result, evidencePath: path.relative(root, outputDirectory).replaceAll("\\", "/") }, null, 2));
