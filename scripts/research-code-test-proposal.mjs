// Prepare a reviewable, unapproved test-only proposal from a terminal static
// review. This command never imports candidate modules, approves, or executes.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { stageResearchCode } from "../dist/src/research/code-staging.js";
import { codeReadsCoverFiles, readStagedCodeFile } from "../dist/src/research/code-review.js";
import { checkCandidateCodeSyntax } from "../dist/src/research/code-syntax.js";
import { caseProtocolBinding, caseProtocolDigest } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--probe") throw new Error("Usage: research-code-test-proposal.mjs --probe <terminal-static-review-probe>");
const evidence = await realpath(path.join(root, "research/validation"));
const probe = await realpath(path.resolve(args[1]));
const relative = path.relative(evidence, probe);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Select a probe inside research/validation");
const sourceRoot = await realpath(path.join(probe, "runtime/research"));
const sourceWorkspace = await realpath(path.join(probe, "runtime/workspace"));
for (const target of [sourceRoot, sourceWorkspace]) {
  const relativeTarget = path.relative(probe, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) throw new Error("Source research and workspace directories must remain inside the selected probe");
}
const summary = JSON.parse(await readFile(path.join(probe, "summary.json"), "utf8"));
if (!summary.finishedAt || summary.status !== "completed" || summary.integrationPassed !== true) throw new Error("A completed static review probe is required");
const repository = new ResearchRepository(sourceRoot);
const snapshot = await repository.exportProject(summary.projectId);
const before = JSON.stringify(snapshot);
const reviewTask = snapshot.plan.tasks.find((task) => task.kind === "code-review" && task.status === "completed");
const reviews = snapshot.codeReviews.filter((review) => reviewTask?.outputRefs.includes(review.codeReviewId));
if (reviews.length !== 1) throw new Error("Require one completed-task static review");
const review = reviews[0], bundle = snapshot.codeBundles.find((item) => item.bundleId === review.bundleId);
if (!bundle || review.findings.some((finding) => finding.severity === "blocker") || !codeReadsCoverFiles(review, bundle, review.files, snapshot.codeReads)) throw new Error("Resolve static blockers and complete all reading before preparing a test proposal");
if (!bundle.files.some((file) => file.name === "imputation.test.mjs" && file.kind === "code")) throw new Error("Require the explicitly supported behavioral test entrypoint");
const files = await Promise.all(bundle.files.map(async (file) => ({ name: file.name, kind: file.kind, content: await readStagedCodeFile(sourceWorkspace, bundle, file.name) })));
const protocolText = files.find((file) => file.name === "protocol.json" && file.kind === "input")?.content;
const protocol = JSON.parse(protocolText ?? "null");
const frozen = JSON.parse(await readFile(path.join(root, "research/benchmarks/imputation-v1.json"), "utf8"));
if (JSON.stringify(protocol) !== JSON.stringify(frozen)) throw new Error("Candidate must preserve the complete frozen protocol");
const syntaxChecks = await Promise.all(files.filter((file) => file.kind === "code").map((file) => checkCandidateCodeSyntax(file.name, file.content)));
if (syntaxChecks.some((check) => check.status !== "parsed")) throw new Error("Test proposal requires every code file to parse; this is not behavioral execution");
if (before !== JSON.stringify(await repository.exportProject(summary.projectId))) throw new Error("Source changed during verification");

const output = path.join(evidence, "cases", `imputation-tests-${Date.now()}`);
const workspace = path.join(output, "runtime/workspace"), researchRoot = path.join(output, "runtime/research");
await mkdir(workspace, { recursive: true });
const targetRepo = new ResearchRepository(researchRoot);
const orchestrator = new ResearchOrchestrator(targetRepo, {}, undefined, { experimentPolicy: { workspaceRoot: workspace } });
const question = ["Operator-prepared local behavioral-test checkpoint for an externally reviewed candidate. This is not a new autonomous research case or a scientific experiment result. Only the exact test proposal may run after explicit Workspace task and proposal approval. Do not run run.mjs or generate simulation outputs. No original tasks, designs, approvals or completed states are imported.", caseProtocolBinding(protocol), `External source bundle: ${bundle.bundleId}; static review: ${review.codeReviewId}. Agent static review is not correctness or approval.`, "The only task runs imputation.test.mjs, imports pure exported functions for deterministic fixtures, reads protocol.json and records stdout/stderr. Any failure requires a new code/proposal version and review; it must not be converted into success."].join("\n");
const created = await orchestrator.createProject(question, { title: "插补候选行为测试 · 待审阅", plan: { question, tasks: [{ taskId: "behavioral-tests", title: "运行候选行为测试", kind: "experiment", objective: "Run only the approved immutable imputation.test.mjs behavior test proposal and preserve its real exit status/logs; do not run the simulation.", requiresApproval: true, maxAttempts: 1 }] } });
const staged = await stageResearchCode(workspace, { projectId: created.project.projectId, planId: created.plan.planId, taskId: "behavioral-tests" }, { files });
await targetRepo.saveCodeBundle({ ...staged, syntaxChecks });
const proposal = await orchestrator.createExperiment(created.project.projectId, { title: "候选行为测试（不运行完整模拟）", taskId: "behavioral-tests", command: process.execPath, args: ["imputation.test.mjs"], cwd: staged.directory, codeBundleId: staged.bundleId, timeoutMs: 120000 });
await orchestrator.activatePlan(created.project.projectId);
await orchestrator.startNextTask(created.project.projectId);
const checkpoint = await targetRepo.exportProject(created.project.projectId);
if (checkpoint.plan.tasks[0].status !== "waiting-approval" || checkpoint.experiments[0].approval || checkpoint.experimentRuns.length !== 0 || checkpoint.experimentDesigns.length !== 0) throw new Error("Test checkpoint must remain unapproved, unexecuted and without imported design");
await writeFile(path.join(output, "protocol.json"), protocolText, { flag: "wx" });
const sourceProvenance = { action: "prepare-test-only-proposal", actor: "operator", sourceProbe: path.relative(root, probe).replaceAll("\\", "/"), sourceBundleId: bundle.bundleId, sourceReview: review, sourceSnapshotSha256: createHash("sha256").update(before).digest("hex"), files: bundle.files.map(({ name, kind, contentHash }) => ({ name, kind, contentHash })), sourceCandidateAuthorship: summary.candidateAuthorship, grantsApproval: false };
const result = { schema: "dsh-sci.code-test-proposal.v1", startedAt: created.project.createdAt, finishedAt: new Date().toISOString(), status: "waiting-approval", scientificQuality: "not-reviewed", projectId: created.project.projectId, protocolSha256: caseProtocolDigest(protocol), planOrigin: "operator-prepared-test-checkpoint", operatorActions: [sourceProvenance], projectRoot: researchRoot, codeBundleId: staged.bundleId, experimentId: proposal.experimentId, proposalContentHash: proposal.proposalContentHash, command: proposal.command, args: proposal.args, cwd: proposal.cwd, timeoutMs: proposal.timeoutMs, counts: { experiments: 1, experimentRuns: 0 }, generatedCodeExecuted: false, originalProbeUnchanged: before === JSON.stringify(await repository.exportProject(summary.projectId)), remainingReview: ["Human review of the exact test proposal and full candidate", "Workspace task approval and proposal hash approval", "Actual test execution and independent numerical replay", "Separate main-case literature/design approval and simulation; this test checkpoint does not grant them"] };
if (!result.originalProbeUnchanged) throw new Error("Source probe changed while preparing the checkpoint; it is not ready for review");
await writeFile(path.join(output, "summary.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
await writeFile(path.join(output, "snapshot.json"), JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, projectId: result.projectId, experimentId: result.experimentId, proposalContentHash: result.proposalContentHash, status: result.status, generatedCodeExecuted: false, originalProbeUnchanged: result.originalProbeUnchanged }));
