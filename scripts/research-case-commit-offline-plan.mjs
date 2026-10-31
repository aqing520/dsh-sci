// Preview or commit a previously saved plan proposal without using a
// model. This preserves the old plan as superseded history and leaves the
// project paused. It never updates budget limits, approves tasks, or executes
// code/experiments.
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildResearchPlan, makeEvent } from "../dist/src/research/domain.js";
import { planCommitHash } from "../dist/src/research/plan-commit.js";
import { contentDigest } from "../dist/src/research/content-digest.js";
import { loadCaseWorkspace } from "./research-case-workspace-core.mjs";
import { inspectCaseProtocolBinding } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const casesRoot = path.join(root, "research", "validation", "cases");
const args = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < args.length; index += 1) {
  const [flag, ...suffix] = args[index].split("=");
  if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
  if (["--case", "--proposal", "--expected-plan", "--proposal-sha256"].includes(flag)) {
    const value = suffix.length ? suffix.join("=") : args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    flags.set(flag, value);
  } else if (["--write", "--commit", "--help", "-h"].includes(flag) && !suffix.length) flags.set(flag, true);
  else throw new Error(`Unknown option: ${flag}`);
}
const caseArg = flags.get("--case"), proposalArg = flags.get("--proposal");
const writeOutput = flags.has("--write"), shouldCommit = flags.has("--commit");
if (!caseArg || flags.has("--help") || flags.has("-h")) {
  console.log("Usage: node scripts/research-case-commit-offline-plan.mjs --case <case-directory> [--proposal <proposed-plan-input.json>] [--write] [--commit --expected-plan <planId> --proposal-sha256 <hash>]");
  console.log("Default: read-only preview. --write only saves the preview. --commit requires the reviewed source plan ID and proposal hash; close other writers first.");
  process.exit(caseArg ? 0 : 2);
}
if (shouldCommit && (!flags.get("--expected-plan") || !/^[a-f0-9]{64}$/u.test(flags.get("--proposal-sha256") ?? ""))) throw new Error("--commit requires --expected-plan and --proposal-sha256 from the preview");

const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const { directory, repository, projectId } = await loadCaseWorkspace(path.resolve(caseArg), casesRoot);
const protocol = JSON.parse(await readFile(path.join(directory, "protocol.json"), "utf8"));
const frozen = JSON.parse(await readFile(path.join(root, "research/benchmarks/imputation-v1.json"), "utf8"));
if (contentDigest(protocol) !== contentDigest(frozen)) throw new Error("Case differs from the frozen benchmark protocol");
const projects = await repository.listProjects(10_000);
const beforeProject = projects.find((project) => project.projectId === projectId);
if (!beforeProject?.planId) throw new Error("Offline plan commit requires a project with an existing plan");
const beforePlan = await repository.readPlan(projectId, beforeProject.planId);
if (!beforePlan) throw new Error("Current project plan is missing");
if (await repository.hasPendingPlanCommit(projectId)) throw new Error("A prepared plan commit already exists; recover or review it before creating another");
if (!["paused", "failed"].includes(beforeProject.status)) throw new Error(`Offline plan commit requires a paused or failed project; found ${beforeProject.status}`);
if (beforeProject.iteration >= beforePlan.constraints.maxIterations) throw new Error(`Offline plan commit would exceed the frozen iteration limit (${beforePlan.constraints.maxIterations})`);
const snapshot = await repository.exportProject(projectId);
if (snapshot.budget?.modelRequests?.some((request) => request.status === "reserved")) throw new Error("Pending model reservations must be settled or recovered before a plan commit");

let proposalPath = proposalArg ? path.resolve(proposalArg) : undefined;
if (!proposalPath) {
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("material-revision-"))
    .map((entry) => path.join(directory, entry.name, "proposed-plan-input.json"))
    .sort().reverse();
  for (const candidate of candidates) { try { await readFile(candidate); proposalPath = candidate; break; } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
if (!proposalPath) throw new Error("No saved proposed-plan-input.json found");
const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
const proposalSha256 = sha256(proposal);
if (shouldCommit && flags.get("--proposal-sha256") !== proposalSha256) throw new Error("Proposal changed after preview; inspect its current hash before committing");
if (inspectCaseProtocolBinding(protocol, proposal.question).status !== "bound") throw new Error("Proposal must contain the complete frozen protocol binding");
const kinds = ["source-review", "hypothesis", "experiment-design"];
if (!Array.isArray(proposal.tasks) || proposal.tasks.length < 3 || proposal.tasks.length > 12 || proposal.tasks.slice(0, 3).some((task, index) => task.kind !== kinds[index])) throw new Error("Proposal must start with source-review, hypothesis, experiment-design");
if (proposal.tasks[0].dependsOn?.length || JSON.stringify(proposal.tasks[1].dependsOn ?? []) !== JSON.stringify([proposal.tasks[0].taskId]) || JSON.stringify(proposal.tasks[2].dependsOn ?? []) !== JSON.stringify([proposal.tasks[1].taskId])) throw new Error("The first three proposal tasks must be strictly sequential");
if (proposal.tasks.some((task) => task.maxAttempts !== undefined && (!Number.isSafeInteger(task.maxAttempts) || task.maxAttempts < 1 || task.maxAttempts > protocol.budget.maxTaskAttempts))) throw new Error("Proposal task attempts exceed the frozen protocol limits");
const previousCommit = (await repository.listEvents(projectId, 10_000)).find((event) => event.type === "plan-created" && event.planId === beforePlan.planId && event.data?.offline === true && event.data?.proposalSha256 === proposalSha256);
const committedSourcePlanId = previousCommit?.data?.supersedesPlanId;
if (shouldCommit && flags.get("--expected-plan") !== beforePlan.planId) {
  if (!previousCommit || previousCommit.data.supersedesPlanId !== flags.get("--expected-plan")) throw new Error("Source plan changed after preview; no new plan committed");
}

const nextPlan = buildResearchPlan(projectId, {
  title: proposal.title,
  question: proposal.question,
  tasks: proposal.tasks,
  constraints: { maxIterations: Math.min(beforePlan.constraints.maxIterations, protocol.stopping.maxResearchIterations), maxTaskAttempts: protocol.budget.maxTaskAttempts },
}, new Date().toISOString());
nextPlan.version = beforePlan.version + 1;
nextPlan.planning = { source: "provided", planner: "offline-saved-proposal", reason: `Committed from ${path.relative(root, proposalPath).replaceAll("\\", "/")}; no model call. Previous plan ${beforePlan.planId} retained as superseded history.` };
const nextProject = { ...beforeProject, planId: nextPlan.planId, activeTaskId: undefined, status: "paused", iteration: beforeProject.iteration + 1, lastError: "Offline plan committed; configure a new valid budget window before resuming.", updatedAt: nextPlan.updatedAt };
const events = [makeEvent(projectId, "plan-created", { planId: nextPlan.planId, values: { taskCount: nextPlan.tasks.length, replanned: true, offline: true, supersedesPlanId: beforePlan.planId, proposalSha256: sha256(proposal), protocolSha256: sha256(protocol) } })];
const content = { schema: "dsh-sci.research-plan-commit.v1", commitId: contentDigest({ projectId, beforePlanId: beforePlan.planId, nextPlanId: nextPlan.planId }), projectId, status: "prepared", beforeProject, beforePlan, nextProject, nextPlan, events };
const commit = { ...content, contentHash: planCommitHash(content) };
if (shouldCommit && !previousCommit) {
  if (contentDigest(await repository.exportProject(projectId)) !== contentDigest(snapshot)) throw new Error("Research state changed during preparation; stop writers and preview again");
  await repository.savePlanCommit(commit);
  await repository.applyPlanCommit(commit);
}
const after = await repository.exportProject(projectId);
if (shouldCommit && !previousCommit && (after.project.planId !== nextPlan.planId || after.project.status !== "paused")) throw new Error("Offline plan commit did not persist the expected paused plan");
const result = {
  schema: "dsh-sci.offline-plan-commit.v1",
  generatedAt: new Date().toISOString(),
  action: previousCommit ? "already-committed" : shouldCommit ? "committed" : "preview",
  caseDirectory: path.relative(root, directory).replaceAll("\\", "/"),
  projectId,
  previousPlanId: committedSourcePlanId ?? (shouldCommit ? beforePlan.planId : null),
  newPlanId: previousCommit ? beforePlan.planId : shouldCommit ? nextPlan.planId : null,
  sourcePlanId: committedSourcePlanId ?? beforePlan.planId,
  proposalSha256,
  protocolSha256: sha256(protocol),
  projectStatus: after.project.status,
  constraints: previousCommit || shouldCommit ? after.plan.constraints : nextPlan.constraints,
  constraintNormalization: { actor: "operator", originalConstraints: proposal.constraints, structuredConstraints: nextPlan.constraints },
  oldPlanPreservedAs: committedSourcePlanId ? (await repository.readPlan(projectId, committedSourcePlanId))?.status : undefined,
  budget: { usedModelRequests: after.budget.usedModelRequests, reportedTotalTokens: after.budget.reportedTotalTokens, maxModelRequests: after.budget.maxModelRequests, maxModelTokens: after.budget.maxModelTokens, wallBudgetExpired: Boolean(after.budget.startedAt && Date.now() - Date.parse(after.budget.startedAt) >= after.budget.maxWallTimeMs) },
  counts: { claims: after.claims.length, evidence: after.evidence.length, experiments: after.experiments.length, experimentRuns: after.experimentRuns.length },
  modelCalls: 0,
  approvalsChanged: false,
  experimentsStarted: 0,
  scientificQuality: "not-reviewed",
  nextStep: "Configure a new budget window in Workspace, then approve/resume the first task through normal gates.",
};
if (writeOutput) { const output = path.join(directory, `offline-plan-commit-${Date.now()}.json`); await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); result.outputPath = path.relative(root, output).replaceAll("\\", "/"); }
console.log(JSON.stringify(result, null, 2));
