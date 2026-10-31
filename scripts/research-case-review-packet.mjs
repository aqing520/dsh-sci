// Read-only checkpoint export for human research review. This is not a research
// report, approval, or acceptance verdict; no authoritative record is changed.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { verifySourceCitation } from "../dist/src/research/source-content.js";
import { inspectCaseProtocolBinding } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--case") throw new Error("Usage: research-case-review-packet.mjs --case <closed-case-directory>");
function inside(base, target) {
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Review files must remain inside the selected case");
}
const caseDirectory = await realpath(path.resolve(args[1]));
inside(await realpath(path.join(root, "research/validation/cases")), caseDirectory);
const repositoryRoot = await realpath(path.join(caseDirectory, "runtime/research"));
inside(caseDirectory, repositoryRoot);
const repository = new ResearchRepository(repositoryRoot);
const projects = await repository.listProjects(10_000);
if (projects.length !== 1) throw new Error("Expected one project in the case");
const snapshot = await repository.exportProject(projects[0].projectId);
const protocol = JSON.parse(await readFile(path.join(caseDirectory, "protocol.json"), "utf8"));
const summary = JSON.parse(await readFile(path.join(caseDirectory, "summary.json"), "utf8"));
if (summary.projectId !== snapshot.project.projectId || !summary.finishedAt) throw new Error("Export only a finished case; no live repository snapshot isolation is claimed");
const workspace = await realpath(path.join(caseDirectory, "runtime/workspace"));
inside(caseDirectory, workspace);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const before = hash(JSON.stringify(snapshot));
const citations = [];
const activeTask = snapshot.plan?.tasks.find((task) => task.taskId === snapshot.project.activeTaskId);
const activeReadingTask = activeTask && ["research", "source-review"].includes(activeTask.kind) ? activeTask : undefined;
for (const citation of snapshot.citations) {
  const content = citation.contentVersionId ? await repository.readSourceContent(snapshot.project.projectId, citation.contentVersionId) : undefined;
  const verification = verifySourceCitation(citation, content);
  const locator = citation.locator;
  const chunks = content && locator && typeof locator === "object" ? content.chunks.filter((chunk) =>
    (!locator.chunkId || chunk.chunkId === locator.chunkId) && (locator.page === undefined || chunk.page === locator.page) &&
    (locator.startOffset === undefined || chunk.endOffset > locator.startOffset) && (locator.endOffset === undefined || chunk.startOffset < locator.endOffset)) : [];
  const reads = snapshot.sourceReads.filter((receipt) => receipt.audience === "agent" && receipt.sourceId === citation.sourceId && receipt.contentVersionId === content?.contentVersionId && receipt.contentHash === content?.contentHash);
  citations.push({ citation, source: snapshot.sources.find((source) => source.sourceId === citation.sourceId), verification,
    content: content ? { contentVersionId: content.contentVersionId, contentHash: content.contentHash, scope: content.scope, truncated: content.truncated, characters: content.text.length, retrievedAt: content.retrievedAt, origin: content.origin } : null,
    quotedChunks: chunks, agentReadReceipts: reads, allLocatedChunksReadByAgent: chunks.length > 0 && chunks.every((chunk) => reads.some((receipt) => receipt.chunkIds.includes(chunk.chunkId))),
    activeReadingAttempt: activeReadingTask ? { planId: activeReadingTask.planId, taskId: activeReadingTask.taskId, attemptId: activeReadingTask.attemptId } : null,
    allLocatedChunksReadInActiveAttempt: activeReadingTask ? chunks.length > 0 && chunks.every((chunk) => reads.some((receipt) => receipt.planId === activeReadingTask.planId && receipt.taskId === activeReadingTask.taskId && receipt.attemptId === activeReadingTask.attemptId && receipt.chunkIds.includes(chunk.chunkId))) : null,
    supportReview: "required" });
}
const code = [];
for (const bundle of snapshot.codeBundles) for (const file of bundle.files) {
  const target = await realpath(file.path);
  inside(workspace, target);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > 128 * 1024 || stat.size !== file.bytes) throw new Error("Staged file is unavailable or changed; regenerate a candidate before review");
  const bytes = await readFile(target);
  if (hash(bytes) !== file.contentHash) throw new Error("Staged file hash changed; cannot export it as the candidate");
  code.push({ bundleId: bundle.bundleId, ...file, text: bytes.toString("utf8") });
}
if (before !== hash(JSON.stringify(await repository.exportProject(snapshot.project.projectId)))) throw new Error("Project changed during export; close writers and retry");
const packet = { schema: "dsh-sci.research-case-review-packet.v1", generatedAt: new Date().toISOString(), scientificQuality: "not-reviewed",
  scope: "Operator checkpoint for human review, not an Agent research report. Text and hash diagnostics do not establish scientific support or source independence. No approval or execution performed.",
  caseDirectory: path.relative(root, caseDirectory).replaceAll("\\", "/"), snapshotSha256: before,
  protocolBinding: inspectCaseProtocolBinding(protocol, snapshot.project.question),
  inputProvenance: { planOrigin: summary.planOrigin, planSource: summary.planSource, sourceHintsHumanSupplied: summary.sourceHintsHumanSupplied, supplementalSourceHintsOperatorSupplied: summary.supplementalSourceHintsOperatorSupplied, operatorActions: summary.operatorActions },
  project: snapshot.project, tasks: snapshot.plan?.tasks, budget: snapshot.budget,
  citations, searchLogs: snapshot.searchLogs, sourceRelations: snapshot.sourceRelations, claims: snapshot.claims, evidence: snapshot.evidence, evidenceReviews: snapshot.evidenceReviews,
  hypotheses: snapshot.hypotheses, designs: snapshot.experimentDesigns, designReviews: snapshot.designReviews,
  codeBundles: snapshot.codeBundles, code, codeReads: snapshot.codeReads, codeReviews: snapshot.codeReviews, proposals: snapshot.experiments, runs: snapshot.experimentRuns,
  remainingReview: ["Source relevance, independence, coverage and counterevidence", "Citation-to-claim support", "Hypothesis predictions and outcome-based falsifiers", "Design compliance with the complete frozen protocol", "Complete code, inputs and observed environment", "Exact Workspace design/code/experiment approvals before execution", "Real run, independent replay, evaluation, report and cross-session memory"],
};
// Choose a longer fence than anything in untrusted source/code text.
const fence = (text) => { const size = Math.max(3, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length + 1)); const mark = "`".repeat(size); return `${mark}\n${text}\n${mark}`; };
const json = (value) => fence(JSON.stringify(value, null, 2));
const lines = ["# 人工审阅检查点（不是研究结论）", "", packet.scope, "", "科研质量：not-reviewed。以下均为保存的候选材料及自动诊断，不代表人工通过。", "", "## 当前任务与剩余门槛", "", json({ project: packet.project, tasks: packet.tasks, remainingReview: packet.remainingReview }), "", "## 来源、正文定位与 Agent 阅读回执", "", ...citations.flatMap((item) => [json(item), ""]), "## 候选假设", "", json(packet.hypotheses), "", "## 候选设计", "", json(packet.designs), "", "## 候选代码与哈希（未批准、未执行）", "", ...code.flatMap((file) => [json({ bundleId: file.bundleId, name: file.name, bytes: file.bytes, sha256: file.contentHash }), "", fence(file.text), ""]), "## 查询与支持关系记录", "", json({ searchLogs: packet.searchLogs, sourceRelations: packet.sourceRelations, evidence: packet.evidence, evidenceReviews: packet.evidenceReviews }), "", "## 输入来源与协议", "", json({ protocolBinding: packet.protocolBinding, inputProvenance: packet.inputProvenance }), ""];
lines.push("## Agent 静态代码检查与读取回执", "", "以下检查是模型建议，可能漏检或误报；不是人工批准、执行结果或正确性证明。", "", json({ codeReads: packet.codeReads ?? [], codeReviews: packet.codeReviews ?? [] }), "");
const output = path.join(caseDirectory, `review-packet-${Date.now()}`);
await mkdir(output);
await writeFile(path.join(output, "review.json"), JSON.stringify(packet, null, 2) + "\n");
await writeFile(path.join(output, "review.md"), lines.join("\n"));
console.log(JSON.stringify({ output, scientificQuality: packet.scientificQuality, protocolBinding: packet.protocolBinding.status, citations: citations.length, codeFiles: code.length, authoritativeSnapshotUnchanged: true }));
