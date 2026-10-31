import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildResearchPlan, defaultResearchPlanInput, readyTaskIds, transitionTask } from "../src/research/domain.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { ResearchRepository } from "../src/research/repository.js";
import { isEncryptedMetadataText } from "../src/metadata-crypto.js";
import { canonicalizeUrl, makeClaim, makeResearchSource } from "../src/research/evidence.js";
import { writeFile } from "node:fs/promises";
import { DefaultResearchPlanner, ModelResearchPlanner } from "../src/research/planner.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { taskResultIdentity } from "../src/research/task-result.js";
import { ResearchRunner } from "../src/research/runner.js";
import { startDshSdkClient, DshResearchTaskExecutor } from "../src/research/dsh-sdk.js";
import { checkIndependentNumericResult, evaluatePairedBootstrap, evaluateResearchMetrics, evaluateStatisticalMetric, makeResearchEvaluation } from "../src/research/evaluation.js";
import { resolveResearchReference } from "../src/research/source-adapters.js";
import { aggregateProcessTreeMemory, makeExperimentDefinition, processTreeMemoryBytes, runExperiment } from "../src/research/experiment.js";
import { createCommandOcrProvider, createHttpOcrProvider, createTesseractOcrProvider } from "../src/research/ocr.js";

test("research plan validates dependencies, cycles, and ready tasks", () => {
  const plan = buildResearchPlan("How does method A compare with method B?", defaultResearchPlanInput("How does method A compare with method B?"));
  assert.equal(plan.tasks.length, 9);
  assert.equal(plan.tasks.find((task) => task.taskId === "prepare-code")!.kind, "code-preparation");
  assert.equal(plan.tasks.find((task) => task.taskId === "review-code")!.kind, "code-review");
  assert.deepEqual(plan.tasks.find((task) => task.taskId === "run-experiment")!.dependsOn, ["review-code"]);
  assert.equal(plan.tasks.find((task) => task.taskId === "run-experiment")!.requiresApproval, true);
  assert.deepEqual(readyTaskIds(plan), ["clarify-question"]);
  const ready = transitionTask(plan, "clarify-question", "ready");
  const running = transitionTask(ready, "clarify-question", "running");
  assert.equal(running.tasks[0].attempts, 1);
  assert.throws(() => buildResearchPlan("cycle", { question: "cycle", tasks: [{ taskId: "a", title: "A", objective: "A", dependsOn: ["b"] }, { taskId: "b", title: "B", objective: "B", dependsOn: ["a"] }] }), /cycle/);
});

test("research orchestrator persists, resumes, and advances a dependency plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-"));
  try {
    const orchestrator = new ResearchOrchestrator(new ResearchRepository(root));
    const created = await orchestrator.createProject("Which preprocessing method is better?");
    const active = await orchestrator.activatePlan(created.project.projectId);
    assert.deepEqual(active.readyTaskIds, ["clarify-question"]);
    const started = await orchestrator.startNextTask(created.project.projectId);
    assert.equal(started.task.status, "running");
    const scope = await orchestrator.addClaim(created.project.projectId, { text: "The comparison scope has been recorded.", taskId: started.task.taskId, claimType: "definition" });
    const completed = await orchestrator.completeTask(created.project.projectId, started.task.taskId, [scope.claimId]);
    assert.deepEqual(completed.readyTaskIds, ["review-sources"]);
    const reopened = new ResearchRepository(root);
    const exported = await reopened.exportProject(created.project.projectId);
    assert.equal(exported.project.activeTaskId, "review-sources");
    assert.equal(exported.plan?.tasks.find((task) => task.taskId === "clarify-question")?.status, "completed");
    assert.ok(exported.events.some((event) => event.type === "task-completed"));
    const activeContext = await reopened.readActiveContext();
    assert.equal(activeContext?.projectId, created.project.projectId);
    assert.equal(activeContext?.planId, exported.plan?.planId);
    assert.equal(activeContext?.taskId, "review-sources");
    assert.equal(JSON.parse(await readFile(path.join(root, "active-context.json"), "utf8")).schema, "dsh-sci.research-active-context.v1");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research repository encrypts plans and events when configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-encrypted-"));
  try {
    const repository = new ResearchRepository(root, { metadataPassphrase: "research-secret" });
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Can an encrypted plan be recovered?");
    assert.equal(isEncryptedMetadataText(await readFile(path.join(root, "projects", created.project.projectId, "project.json"), "utf8")), true);
    assert.equal((await new ResearchRepository(root, { metadataPassphrase: "research-secret" }).exportProject(created.project.projectId)).project.question, "Can an encrypted plan be recovered?");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research orchestrator retries a failed task until its attempt limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-retry-"));
  try {
    const orchestrator = new ResearchOrchestrator(new ResearchRepository(root));
    const created = await orchestrator.createProject("Can this task retry?");
    await orchestrator.activatePlan(created.project.projectId);
    const started = await orchestrator.startNextTask(created.project.projectId);
    const retried = await orchestrator.failTask(created.project.projectId, started.task.taskId, "temporary");
    assert.equal(retried.task.status, "ready");
    const startedAgain = await orchestrator.startNextTask(created.project.projectId);
    const failed = await orchestrator.failTask(created.project.projectId, startedAgain.task.taskId, "permanent");
    assert.equal(failed.task.status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research evidence chain persists sources, citations, claims, and links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-evidence-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Which source supports this claim?");
    const source = await orchestrator.addSource(created.project.projectId, { kind: "paper", title: "A reproducible paper", url: "https://example.test/paper", authors: ["Author"], excerpt: "A useful result" });
    const citation = await orchestrator.addCitation(created.project.projectId, source.sourceId, { locator: "p. 4", quotedText: "A useful result" });
    const claim = await orchestrator.addClaim(created.project.projectId, { text: "The method improves accuracy.", claimType: "conclusion", confidence: "medium", citationIds: [citation.citationId] });
    await orchestrator.addEvidence(created.project.projectId, { claimId: claim.claimId, sourceId: source.sourceId, relation: "supports", rationale: "The cited experiment reports the improvement." });
    const exported = await repository.exportProject(created.project.projectId);
    assert.equal(exported.sources.length, 1);
    assert.equal(exported.citations[0].sourceId, source.sourceId);
    assert.equal(exported.claims[0].citationIds[0], citation.citationId);
    assert.equal(exported.evidence[0].claimId, claim.claimId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research orchestrator ingests search results as stable sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-search-"));
  try {
    const orchestrator = new ResearchOrchestrator(new ResearchRepository(root));
    const created = await orchestrator.createProject("Find primary sources");
    const sources = await orchestrator.ingestSearchResults(created.project.projectId, "primary sources", [{ title: "Paper", url: "https://example.test/paper", snippet: "Summary" }, { title: "No URL", url: "" }], "local-search");
    assert.equal(sources.length, 1);
    assert.equal((await orchestrator.repository.listSources(created.project.projectId))[0].metadata.provider, "local-search");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research sources canonicalize and deduplicate equivalent URLs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-dedupe-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Deduplicate sources");
    const first = await orchestrator.addSource(created.project.projectId, { title: "Paper", url: "HTTPS://Example.test/paper/?utm_source=news#results" });
    const second = await orchestrator.addSource(created.project.projectId, { title: "Same paper", url: "https://example.test/paper" });
    assert.equal(first.sourceId, second.sourceId);
    assert.equal(first.url, "https://example.test/paper");
    assert.equal(canonicalizeUrl("https://example.test/paper/?utm_medium=x#top"), "https://example.test/paper");
    assert.equal((await repository.listSources(created.project.projectId)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy sources without quality metadata are normalized on read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-legacy-source-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Read legacy source");
    const source = makeResearchSource(created.project.projectId, { title: "Legacy", url: "https://example.test/legacy" });
    const legacy = { ...source } as any;
    delete legacy.quality;
    const sourcePath = path.join(root, "projects", encodeURIComponent(created.project.projectId), "sources", `${encodeURIComponent(source.sourceId)}.json`);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, JSON.stringify(legacy), "utf8");
    const loaded = await repository.readSource(created.project.projectId, source.sourceId);
    assert.equal(loaded?.quality.authority, "unknown");
    assert.equal(loaded?.quality.accessibility, "unknown");
    assert.equal(typeof loaded?.quality.score, "number");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research document parser strips HTML noise and records a content hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-document-"));
  try {
    const file = path.join(root, "paper.html");
    await writeFile(file, "<style>.x{}</style><h1>Paper title</h1><p>Evidence <b>text</b>.</p><script>alert(1)</script>", "utf8");
    const orchestrator = new ResearchOrchestrator(new ResearchRepository(path.join(root, "store")));
    const created = await orchestrator.createProject("Read a paper");
    const result = await orchestrator.ingestDocument(created.project.projectId, file);
    assert.equal(result.document.title, "Paper title");
    assert.match(result.document.text, /Evidence text/);
    assert.doesNotMatch(result.document.text, /alert/);
    assert.equal(result.document.chunks.length, 1);
    assert.equal(result.document.chunks[0].locator, `characters 0-${result.document.text.length}`);
    assert.match(result.source.url ?? "", /^file:\/\//);
    assert.equal(result.source.documentId, result.document.documentId);
    assert.equal(result.source.quality.accessibility, "open");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research document parser extracts text from a basic PDF", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-pdf-"));
  try {
    const file = path.join(root, "paper.pdf");
    await writeFile(file, "%PDF-1.4\nBT (PDF evidence text) Tj ET\n%%EOF", "utf8");
    const document = await (await import("../src/research/document.js")).parseResearchDocument(file);
    assert.equal(document.mediaType, "application/pdf");
    assert.equal(document.extraction, "text");
    assert.match(document.text, /PDF evidence text/);
    assert.equal(document.chunks.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research document parser uses an explicit OCR provider for scanned PDFs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-pdf-ocr-"));
  try {
    const file = path.join(root, "scanned.pdf");
    await writeFile(file, "%PDF-1.4\n% scanned image only\n%%EOF", "utf8");
    const document = await (await import("../src/research/document.js")).parseResearchDocument(file, { ocr: { provider: "test-ocr", async recognize() { return { text: "OCR extracted result", pages: [{ text: "OCR extracted result", confidence: 0.91 }], confidence: 0.91 }; } } });
    assert.equal(document.extraction, "ocr");
    assert.equal(document.ocrProvider, "test-ocr");
    assert.equal(document.ocrConfidence, 0.91);
    assert.deepEqual(document.ocrPageConfidences, [0.91]);
    assert.match(document.text, /OCR extracted result/);
    assert.equal(document.chunks[0].confidence, 0.91);
    assert.equal(document.chunks[0].locator, `page 1, characters 0-${document.text.length}`);
    const failed = await (await import("../src/research/document.js")).parseResearchDocument(file, { ocr: { provider: "broken-ocr", async recognize() { throw new Error("provider unavailable"); } } });
    assert.equal(failed.extraction, "ocr-required");
    assert.match(failed.ocrError ?? "", /provider unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("command OCR provider runs without a shell and accepts JSON page output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-command-ocr-"));
  try {
    const file = path.join(root, "scan.pdf");
    await writeFile(file, "%PDF-1.4 scanned", "utf8");
    const provider = createCommandOcrProvider({ provider: "test-command-ocr", command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({text:'command OCR',pageTexts:['page one']}))"] });
    const result = await provider.recognize({ filePath: file, data: new Uint8Array(), maxText: 1000 });
    assert.equal(result.text, "command OCR");
    assert.deepEqual(result.pageTexts, ["page one"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Tesseract OCR provider renders pages and OCRs them without a shell", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-tesseract-ocr-"));
  try {
    const file = path.join(root, "scan.pdf");
    await writeFile(file, "%PDF-1.4 scanned", "utf8");
    const provider = createTesseractOcrProvider({
      provider: "test-tesseract",
      rendererCommand: process.execPath,
      rendererArgs: ({ outputPrefix }) => ["-e", `require("node:fs").writeFileSync(${JSON.stringify(`${outputPrefix}-1.png`)}, "rendered")`],
      tesseractCommand: process.execPath,
      tesseractArgs: ({ imagePath }) => ["-e", `if (!require("node:fs").existsSync(process.argv[1])) process.exit(2); process.stdout.write("OCR page")`, imagePath],
      maxPages: 2,
    });
    const result = await provider.recognize({ filePath: file, data: new Uint8Array(), maxText: 1000 });
    assert.equal(result.text, "OCR page");
    assert.deepEqual(result.pageTexts, ["OCR page"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("HTTP OCR provider sends a bounded base64 request and parses page JSON", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const provider = createHttpOcrProvider({ endpoint: "https://ocr.example.test/v1/recognize", apiKey: "ocr-secret", provider: "cloud-ocr", fetchImpl: async (input, init) => { requests.push({ input: String(input), init }); return new Response(JSON.stringify({ text: "cloud OCR", pages: [{ text: "page one", confidence: 0.88 }, { text: "page two", confidence: 0.76 }], confidence: 0.82 }), { status: 200 }); } });
  const result = await provider.recognize({ filePath: "paper.pdf", data: new Uint8Array([1, 2, 3]), maxText: 1000 });
  assert.equal(result.text, "cloud OCR");
  assert.deepEqual(result.pages, [{ text: "page one", confidence: 0.88 }, { text: "page two", confidence: 0.76 }]);
  assert.equal(result.confidence, 0.82);
  assert.equal(requests[0].input, "https://ocr.example.test/v1/recognize");
  assert.equal((requests[0].init?.headers as Record<string, string>).authorization, "Bearer ocr-secret");
  assert.match(String(requests[0].init?.body), /contentBase64/);
});

test("research experiments require approval and persist bounded execution results", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-experiment-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Run a safe experiment");
    const input = path.join(root, "input.txt");
    const output = path.join(root, "output.txt");
    await writeFile(input, "input-v1", "utf8");
    const definition = await orchestrator.createExperiment(created.project.projectId, { title: "Echo result", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(output)}, 'result'); process.stdout.write('result')`], inputPaths: [input], outputPaths: [output], randomSeed: 42, timeoutMs: 5000 });
    await assert.rejects(() => orchestrator.executeExperiment(created.project.projectId, definition.experimentId), /approval/);
    await orchestrator.approveExperiment(created.project.projectId, definition.experimentId, definition.proposalContentHash!);
    const run = await orchestrator.executeExperiment(created.project.projectId, definition.experimentId, { approved: true });
    assert.equal(run.state, "completed");
    assert.equal(run.stdout, "result");
    assert.equal(run.manifest.randomSeed, 42);
    assert.equal(run.manifest.inputs[0].sha256?.length, 64);
    assert.equal(run.manifest.outputs[0].sha256?.length, 64);
    assert.equal(run.manifest.outputs[0].exists, true);
    assert.equal(run.manifest.resourceUsage?.inputBytes, 8);
    assert.equal(run.manifest.resourceUsage?.outputBytes, 6);
    assert.equal(run.manifest.resourceUsage?.memoryLimitEnforced, undefined);
    assert.equal((await repository.listExperimentRuns(created.project.projectId)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research artifacts register reproducible file hashes inside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-artifact-"));
  try {
    const file = path.join(root, "result.csv");
    await writeFile(file, "x,y\n1,2\n", "utf8");
    const repository = new ResearchRepository(path.join(root, "store"));
    const orchestrator = new ResearchOrchestrator(repository, {}, new DefaultResearchPlanner(), { experimentPolicy: { workspaceRoot: root } });
    const created = await orchestrator.createProject("Register an artifact");
    const artifact = await orchestrator.registerArtifact(created.project.projectId, { path: file, kind: "table" });
    assert.equal(artifact.mediaType, "text/csv");
    assert.equal(artifact.bytes, 8);
    assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);
    assert.equal((await repository.listArtifacts(created.project.projectId)).length, 1);
    const outside = `${root}-outside.txt`;
    await writeFile(outside, "outside", "utf8");
    try { await assert.rejects(() => orchestrator.registerArtifact(created.project.projectId, { path: outside }), /artifact path/); } finally { await rm(outside, { force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research evaluations persist metrics and validate experiment references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-evaluation-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, new DefaultResearchPlanner(), { experimentPolicy: { workspaceRoot: root, allowedCommands: [process.execPath] } });
    const created = await orchestrator.createProject("Evaluate a result");
    const definition = await orchestrator.createExperiment(created.project.projectId, { title: "Deterministic", command: process.execPath, args: ["-e", "process.stdout.write('ok')"], cwd: root });
    await orchestrator.approveExperiment(created.project.projectId, definition.experimentId, definition.proposalContentHash!);
    const run = await orchestrator.executeExperiment(created.project.projectId, definition.experimentId, { approved: true });
    const evaluation = await orchestrator.recordEvaluation(created.project.projectId, { experimentRunIds: [run.runId], metrics: [{ name: "accuracy", observed: 0.9, expected: 0.8, uncertainty: 0.02, sampleSize: 100 }], conclusion: "supports", summary: "Observed accuracy exceeds the expected baseline.", limitations: ["Single deterministic run"], nextAction: "write report" });
    assert.equal(evaluation.metrics[0].sampleSize, 100);
    const ranged = await orchestrator.recordAutomaticEvaluation(created.project.projectId, { metrics: [{ name: "latency", observed: 120, criterion: "in-range", lowerBound: 100, upperBound: 150 }], summary: "Within target interval" });
    assert.equal(ranged.conclusion, "supports");
    assert.equal(ranged.metrics[0].upperBound, 150);
    await assert.rejects(() => orchestrator.recordAutomaticEvaluation(created.project.projectId, { metrics: [{ name: "invalid interval", observed: 120, criterion: "in-range", lowerBound: 150, upperBound: 100 }], summary: "Invalid" }), /ordered lowerBound/);
    const exported = await repository.exportProject(created.project.projectId);
    assert.equal(exported.evaluations[0].conclusion, "supports");
    const report = await orchestrator.generateReport(created.project.projectId);
    assert.equal(report.evaluationIds.includes(evaluation.evaluationId), true);
    assert.equal(report.evaluationIds.includes(ranged.evaluationId), true);
    assert.match(report.markdown, /accuracy=0.9 expected 0.8/);
    await assert.rejects(() => orchestrator.recordEvaluation(created.project.projectId, { experimentRunIds: ["missing"], metrics: [], conclusion: "inconclusive", summary: "missing run" }), /experiment run not found/);
    await assert.rejects(() => orchestrator.recordEvaluation(created.project.projectId, { metrics: [{ name: "bad sample", observed: 1, sampleSize: 1.5 }], conclusion: "inconclusive", summary: "bad sample" }), /positive integer/);
    assert.equal((await repository.listEvaluations(created.project.projectId)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("experiment cancellation terminates the process tree and records cancelled state", async () => {
  const controller = new AbortController();
  const definition = makeExperimentDefinition("project", { title: "cancel", command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 30_000 });
  const pending = runExperiment(definition, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;
  assert.equal(result.state, "cancelled");
  assert.equal(result.manifest.schema, "dsh-sci.experiment-manifest.v1");
});

test("experiment resource monitor reports process-tree memory on supported hosts", async () => {
  if (!["win32", "linux"].includes(process.platform)) return;
  const bytes = await processTreeMemoryBytes(process.pid);
  assert.equal(typeof bytes, "number");
  assert.ok((bytes ?? 0) > 0);
});

test("process-tree memory aggregation handles Windows and Linux shaped rows", () => {
  assert.equal(aggregateProcessTreeMemory([{ pid: 10, parentPid: 1, bytes: 100 }, { pid: 11, parentPid: 10, bytes: 200 }, { pid: 12, parentPid: 11, bytes: 300 }], 10), 600);
  assert.equal(aggregateProcessTreeMemory([{ pid: 20, parentPid: 1, bytes: 1024 }, { pid: 21, parentPid: 20, bytes: 2048 }, { pid: 22, parentPid: 20, bytes: 4096 }], 20), 7168);
  assert.equal(aggregateProcessTreeMemory([{ pid: 30, parentPid: 1, bytes: 1 }], 999), undefined);
});

test("experiment memory quota terminates a process tree and records the peak", async () => {
  if (!["win32", "linux"].includes(process.platform)) return;
  const definition = makeExperimentDefinition("project", { title: "memory quota", command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 10_000 });
  const result = await runExperiment(definition, { policy: { maxMemoryBytes: 1 } });
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /memory/iu);
  assert.equal(result.manifest.resourceUsage?.memoryLimitEnforced, true);
  assert.ok((result.manifest.resourceUsage?.peakMemoryBytes ?? 0) > 1);
});

test("deterministic evaluator classifies metric thresholds", () => {
  assert.equal(evaluateResearchMetrics([{ name: "accuracy", observed: 0.9, expected: 0.8 }]), "supports");
  assert.equal(evaluateResearchMetrics([{ name: "error", observed: 0.3, expected: 0.2, criterion: "at-most" }]), "refutes");
  assert.equal(evaluateResearchMetrics([{ name: "score", observed: 0.81, expected: 0.8, criterion: "close", tolerance: 0.02 }]), "supports");
  assert.equal(evaluateResearchMetrics([{ name: "latency", observed: 120, criterion: "in-range", lowerBound: 100, upperBound: 150 }]), "supports");
  assert.equal(evaluateResearchMetrics([{ name: "latency", observed: 180, criterion: "in-range", lowerBound: 100, upperBound: 150 }]), "refutes");
  assert.equal(evaluateResearchMetrics([{ name: "unknown", observed: 1 }]), "inconclusive");
});

test("statistical evaluators calculate reproducible differences, intervals, proportions, and effect sizes", () => {
  const means = evaluateStatisticalMetric({ method: "mean-difference", treatmentMean: 12, treatmentStandardDeviation: 2, treatmentSampleSize: 40, controlMean: 10, controlStandardDeviation: 2, controlSampleSize: 40, direction: "positive" });
  assert.equal(means.version, "dsh-sci.stats.v1");
  assert.equal(means.estimate, 2);
  assert.ok((means.lowerBound ?? 0) < 2 && (means.upperBound ?? 0) > 2);
  assert.equal(means.conclusion, "supports");
  assert.equal(evaluateResearchMetrics([{ name: "mean difference", statistical: { method: "mean-difference", treatmentMean: 12, treatmentStandardDeviation: 2, treatmentSampleSize: 40, controlMean: 10, controlStandardDeviation: 2, controlSampleSize: 40, direction: "positive" } }]), "supports");
  const proportions = evaluateStatisticalMetric({ method: "proportion-difference", treatmentSuccesses: 80, treatmentTrials: 100, controlSuccesses: 50, controlTrials: 100, direction: "positive" });
  assert.ok(Math.abs(proportions.estimate - 0.3) < 1e-12);
  assert.equal(proportions.inputs.treatmentSuccesses, 80);
  const interval = evaluateStatisticalMetric({ method: "confidence-interval", estimate: 5, standardError: 1, confidenceLevel: 0.95 });
  assert.ok((interval.lowerBound ?? 0) < 5 && (interval.upperBound ?? 0) > 5);
  const evaluation = makeResearchEvaluation("project", { metrics: [{ name: "effect", statistical: { method: "cohens-d", treatmentMean: 12, treatmentStandardDeviation: 2, treatmentSampleSize: 40, controlMean: 10, controlStandardDeviation: 2, controlSampleSize: 40 } }], conclusion: "supports", summary: "computed" });
  assert.equal(evaluation.metrics[0].computed?.schema, "dsh-sci.statistical-result.v1");
  assert.equal(evaluation.metrics[0].observed, 1);
  const welch = evaluateStatisticalMetric({ method: "welch-t", treatmentMean: 12, treatmentStandardDeviation: 2, treatmentSampleSize: 40, controlMean: 10, controlStandardDeviation: 3, controlSampleSize: 35, direction: "positive" });
  assert.equal(welch.method, "welch-t");
  assert.ok((welch.degreesOfFreedom ?? 0) > 40);
  assert.equal(welch.reviewRequired, true);
  assert.match(welch.reviewReasons.join(" "), /normality/);
  const ranks = evaluateStatisticalMetric({ method: "mann-whitney-u", treatmentValues: [5, 6, 7, 8], controlValues: [1, 2, 3, 4], direction: "positive" });
  assert.equal(ranks.method, "mann-whitney-u");
  assert.ok((ranks.effectSize ?? 0) > 0.9);
  assert.equal(ranks.reviewRequired, true);
  assert.match(ranks.reviewReasons.join(" "), /rank-based|Sample size/);
});

test("paired bootstrap is deterministic, paired, and flags the eight-repeat control as inconclusive", () => {
  const input = { differences: [1, 2, 3, 4, 5, 6, 7, 8], resamples: 1000, seed: 20261030, direction: "positive" as const, practicalRelativeThreshold: 0.02, baselineMagnitude: 10 };
  const first = evaluatePairedBootstrap(input);
  const second = evaluatePairedBootstrap(input);
  assert.deepEqual(first, second);
  assert.equal(first.sampleSize, 8);
  assert.equal(first.reviewRequired, true);
  assert.equal(first.conclusion, "inconclusive");
  const full = evaluatePairedBootstrap({ differences: Array.from({ length: 100 }, (_, index) => 0.5 + index / 100), resamples: 1000, seed: 7, direction: "positive" });
  assert.equal(full.reviewRequired, false);
  assert.equal(full.conclusion, "supports");
  const evaluation = makeResearchEvaluation("project", { metrics: [{ name: "paired effect", pairedBootstrap: input }], conclusion: "inconclusive", summary: "paired bootstrap" });
  assert.equal(evaluation.metrics[0].computedBootstrap?.version, "dsh-sci.bootstrap.v2");
  assert.equal(checkIndependentNumericResult(1, 1 + 1e-12, 1e-9).matches, true);
  assert.equal(checkIndependentNumericResult(1, 1.1, 1e-9).matches, false);
});

test("automatic evaluation can trigger a bounded next iteration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-auto-evaluation-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, new DefaultResearchPlanner());
    const created = await orchestrator.createProject("Automatically decide iteration");
    const loaded = await repository.readPlan(created.project.projectId, created.project.planId!);
    const evaluatedPlan = { ...loaded!, tasks: loaded!.tasks.map((task) => task.kind === "evaluate" ? { ...task, status: "completed" as const } : task) };
    await repository.savePlan(evaluatedPlan);
    const evaluation = await orchestrator.recordAutomaticEvaluation(created.project.projectId, { metrics: [{ name: "error", observed: 0.4, expected: 0.2, criterion: "at-most" }], summary: "Error remains above the target." });
    assert.equal(evaluation.conclusion, "refutes");
    const decision = await orchestrator.decideIteration(created.project.projectId);
    assert.equal(decision.decision, "iterate");
    assert.equal(decision.result?.project.iteration, 1);
    assert.equal(decision.record?.decision, "iterate");
    assert.equal(decision.record?.evaluationId, evaluation.evaluationId);
    assert.equal(decision.record?.resultPlanId, decision.result?.plan.planId);
    assert.equal((await repository.listDecisions(created.project.projectId)).length, 1);
    assert.equal((await repository.exportProject(created.project.projectId)).decisions?.length, 1);
    assert.equal((await repository.readPlan(created.project.projectId, created.project.planId!))?.status, "superseded");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unresolved memory conflicts require review before final evaluation decisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-conflict-decision-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, new DefaultResearchPlanner());
    const created = await orchestrator.createProject("Review evidence conflict before stopping");
    const loaded = await repository.readPlan(created.project.projectId, created.project.planId!);
    await repository.savePlan({ ...loaded!, tasks: loaded!.tasks.map((task) => task.kind === "evaluate" ? { ...task, status: "completed" as const } : task) });
    await orchestrator.remember(created.project.projectId, { kind: "claim", text: "A is better", conflictKey: "comparison" });
    await orchestrator.remember(created.project.projectId, { kind: "claim", text: "B is better", conflictKey: "comparison" });
    const evaluation = await orchestrator.recordAutomaticEvaluation(created.project.projectId, { metrics: [{ name: "score", observed: 1, expected: 0.5 }], summary: "The metric supports the hypothesis." });
    const blockedDecision = await orchestrator.decideIteration(created.project.projectId);
    assert.equal(blockedDecision.decision, "review");
    assert.equal(blockedDecision.conflicts?.length, 1);
    assert.equal((await repository.listDecisions(created.project.projectId)).at(-1)?.decision, "review");
    const group = (await orchestrator.listMemoryConflicts(created.project.projectId))[0];
    await orchestrator.reviewMemoryConflict(created.project.projectId, { conflictKey: group.conflictKey, status: "ignored" });
    const finalDecision = await orchestrator.decideIteration(created.project.projectId);
    assert.equal(finalDecision.decision, "stop");
    assert.equal(finalDecision.evaluation?.evaluationId, evaluation.evaluationId);
    assert.equal((await repository.listDecisions(created.project.projectId)).at(-1)?.decision, "stop");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reference adapters resolve DOI, arXiv, and web metadata into sources", async () => {
  const fakeFetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.crossref.org")) return new Response(JSON.stringify({ message: { title: ["Crossref paper"], author: [{ given: "Ada", family: "Lovelace" }], published: { "date-parts": [[2024, 2, 3]] }, abstract: "<p>Abstract text.</p>", publisher: "Example Press" } }), { status: 200 });
    if (url.includes("export.arxiv.org")) return new Response("<entry><title> arXiv paper </title><summary>Summary text</summary><published>2023-01-02T00:00:00Z</published><author><name>Ada Lovelace</name></author></entry>", { status: 200 });
    return new Response("<html><title>Web title</title><body>Web text</body></html>", { status: 200 });
  };
  const doi = await resolveResearchReference("project", "doi:10.1234/example", { fetchImpl: fakeFetch as typeof fetch });
  assert.equal(doi.source.title, "Crossref paper");
  assert.equal(doi.source.quality.authority, "high");
  const arxiv = await resolveResearchReference("project", "arxiv:2401.01234", { fetchImpl: fakeFetch as typeof fetch });
  assert.equal(arxiv.source.title, "arXiv paper");
  const web = await resolveResearchReference("project", "https://example.test/paper", { fetchImpl: fakeFetch as typeof fetch });
  assert.equal(web.source.title, "Web title");
  assert.match(web.source.contentHash ?? "", /^[a-f0-9]{64}$/u);
});

test("experiment policy constrains commands and workspace roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-experiment-policy-"));
  try {
    const repository = new ResearchRepository(path.join(root, "store"));
    const orchestrator = new ResearchOrchestrator(repository, {}, new DefaultResearchPlanner(), { experimentPolicy: { workspaceRoot: root, allowedCommands: [process.execPath], maxTimeoutMs: 1000, maxInputBytes: 4, maxWorkspaceBytes: 16 } });
    const created = await orchestrator.createProject("Policy test");
    const disallowed = await orchestrator.createExperiment(created.project.projectId, { title: "Disallowed", command: "cmd.exe", args: ["/c", "echo nope"], cwd: root });
    await assert.rejects(() => orchestrator.executeExperiment(created.project.projectId, disallowed.experimentId, { approved: true }), /not allowed/);
    const outside = await orchestrator.createExperiment(created.project.projectId, { title: "Outside", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: path.dirname(root), timeoutMs: 500 });
    await assert.rejects(() => orchestrator.executeExperiment(created.project.projectId, outside.experimentId, { approved: true }), /workspace/);
    const tooLong = await orchestrator.createExperiment(created.project.projectId, { title: "Too long", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, timeoutMs: 5000 });
    await assert.rejects(() => orchestrator.executeExperiment(created.project.projectId, tooLong.experimentId, { approved: true }), /timeout/);
    const input = path.join(root, "large-input.txt");
    await writeFile(input, "0123456789", "utf8");
    const tooMuchInput = await orchestrator.createExperiment(created.project.projectId, { title: "Too much input", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, inputPaths: [input], timeoutMs: 500 });
    await orchestrator.approveExperiment(created.project.projectId, tooMuchInput.experimentId, tooMuchInput.proposalContentHash!);
    await assert.rejects(() => orchestrator.executeExperiment(created.project.projectId, tooMuchInput.experimentId, { approved: true }), /inputs exceed/);
    const outputOrchestrator = new ResearchOrchestrator(repository, {}, new DefaultResearchPlanner(), { experimentPolicy: { workspaceRoot: root, allowedCommands: [process.execPath], maxTimeoutMs: 1000, maxOutputBytes: 4 } });
    const output = path.join(root, "large-output.txt");
    const tooMuchOutput = await outputOrchestrator.createExperiment(created.project.projectId, { title: "Too much output", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(output)}, '0123456789')`], cwd: root, outputPaths: [output], timeoutMs: 500 });
    await outputOrchestrator.approveExperiment(created.project.projectId, tooMuchOutput.experimentId, tooMuchOutput.proposalContentHash!);
    const outputRun = await outputOrchestrator.executeExperiment(created.project.projectId, tooMuchOutput.experimentId, { approved: true });
    assert.equal(outputRun.state, "failed");
    assert.match(outputRun.error ?? "", /outputs exceed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research report and semantic memory are persisted and searchable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-report-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Compare two methods");
    const source = await orchestrator.addSource(created.project.projectId, { title: "Benchmark paper", url: "https://example.test/benchmark", authors: [] });
    const citation = await orchestrator.addCitation(created.project.projectId, source.sourceId, { locator: "Table 1" });
    await orchestrator.addClaim(created.project.projectId, { text: "Method A improves accuracy.", citationIds: [citation.citationId], claimType: "conclusion" });
    const report = await orchestrator.generateReport(created.project.projectId);
    assert.match(report.markdown, /Method A improves accuracy/);
    assert.match(report.html, /Evidence graph/);
    assert.match(report.html, /Method A improves accuracy/);
    assert.doesNotMatch(report.html, /javascript:/iu);
    assert.match(report.markdown, /Benchmark paper/);
    assert.match(report.markdown, /Evidence warnings/);
    assert.ok(report.warnings.some((warning) => warning.includes("not been rated authoritative")));
    await orchestrator.remember(created.project.projectId, { kind: "claim", text: "Method A improves accuracy", refs: [source.sourceId], confidence: "high", conflictKey: "accuracy-method-a" });
    const duplicate = await orchestrator.remember(created.project.projectId, { kind: "claim", text: "  Method A improves accuracy  ", refs: [citation.citationId], confidence: "medium", conflictKey: "accuracy-method-a" });
    assert.equal(duplicate.confidence, "medium");
    const conflicting = await orchestrator.remember(created.project.projectId, { kind: "claim", text: "Method A does not improve accuracy", refs: [citation.citationId], confidence: "medium", conflictKey: "accuracy-method-a" });
    assert.equal(conflicting.conflictIds.length, 1);
    assert.equal((await repository.listMemory()).find((entry) => entry.memoryId !== conflicting.memoryId && entry.conflictKey === "accuracy-method-a")?.conflictIds.includes(conflicting.memoryId), true);
    const conflicts = await orchestrator.listMemoryConflicts(created.project.projectId);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].entries.length, 2);
    const hits = await orchestrator.searchMemory("accuracy method A", { projectId: created.project.projectId });
    assert.equal(hits.length, 2);
    assert.equal(hits.some((hit) => hit.entry.confidence === "medium"), true);
    assert.equal((await orchestrator.searchMemory("accuracy method A", { projectId: created.project.projectId, minConfidence: "high" })).length, 0);
    const reviewed = await orchestrator.reviewMemoryConflict(created.project.projectId, { conflictKey: "accuracy-method-a", status: "accepted", selectedMemoryId: conflicting.memoryId, note: "Newer benchmark evidence selected." });
    assert.equal(reviewed.reviewStatus, "accepted");
    assert.equal(reviewed.entries.find((entry) => entry.memoryId === conflicting.memoryId)?.review?.status, "accepted");
    assert.equal(reviewed.entries.find((entry) => entry.memoryId !== conflicting.memoryId)?.review?.status, "superseded");
    assert.ok((await repository.listEvents(created.project.projectId)).some((event) => event.type === "memory-conflict-reviewed"));
    const postReviewHits = await orchestrator.searchMemory("accuracy method A", { projectId: created.project.projectId });
    assert.deepEqual(postReviewHits.map((hit) => hit.entry.memoryId), [conflicting.memoryId]);
    const reviewedReport = await orchestrator.generateReport(created.project.projectId);
    assert.match(reviewedReport.markdown, /Memory review/);
    assert.match(reviewedReport.markdown, /accepted/);
    await orchestrator.recordAutomaticEvaluation(created.project.projectId, { metrics: [{ name: "benchmark difference", statistical: { method: "welch-t", treatmentMean: 12, treatmentStandardDeviation: 2, treatmentSampleSize: 8, controlMean: 10, controlStandardDeviation: 3, controlSampleSize: 7, direction: "positive" } }], summary: "Small benchmark comparison" });
    const statsReport = await orchestrator.generateReport(created.project.projectId);
    assert.match(statsReport.markdown, /manual statistical review/);
    const expired = await orchestrator.remember(created.project.projectId, { kind: "note", text: "Expired note", expiresAt: "2000-01-01T00:00:00Z" });
    assert.equal((await orchestrator.searchMemory("Expired note", { projectId: created.project.projectId })).some((hit) => hit.entry.memoryId === expired.memoryId), false);
    assert.equal((await repository.listReports(created.project.projectId)).length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("citations retain structured page and chunk locators in reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-citation-locator-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Locate evidence");
    const source = await orchestrator.addSource(created.project.projectId, { title: "Located paper", url: "https://example.test/located" });
    const citation = await orchestrator.addCitation(created.project.projectId, source.sourceId, { locator: { page: 4, section: "Results", chunkId: "chunk-2", startOffset: 120, endOffset: 260 } });
    await orchestrator.addClaim(created.project.projectId, { text: "The result is located.", citationIds: [citation.citationId] });
    const report = await orchestrator.generateReport(created.project.projectId);
    assert.match(report.markdown, /p\. 4/);
    assert.match(report.markdown, /Results/);
    assert.match(report.markdown, /characters 120-260/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research iteration replans only after evaluation and increments iteration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-iteration-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, new DefaultResearchPlanner());
    const created = await orchestrator.createProject("Iterate after evaluation");
    await assert.rejects(() => orchestrator.iterate(created.project.projectId, "not evaluated"), /evaluation/);
    const loaded = await repository.readPlan(created.project.projectId, created.project.planId!);
    const evaluated = { ...loaded!, tasks: loaded!.tasks.map((task) => task.kind === "evaluate" ? { ...task, status: "completed" as const } : task) };
    await repository.savePlan(evaluated);
    await orchestrator.recordEvaluation(created.project.projectId, { metrics: [], conclusion: "inconclusive", summary: "Synthetic iteration fixture requires further evaluation." });
    const result = await orchestrator.iterate(created.project.projectId, "results need another run");
    assert.equal(result.project.iteration, 1);
    assert.equal(result.plan.status, "draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("model research planner validates structured JSON before accepting it", async () => {
  const planner = new ModelResearchPlanner({ createResponse: async () => ({ output_text: JSON.stringify({ title: "Model plan", tasks: [{ taskId: "one", title: "One", objective: "Do one", kind: "research", dependsOn: [] }] }) }) } as any);
  const plan = await planner.plan("What should be researched?");
  assert.equal(plan.title, "Model plan");
  assert.equal(plan.tasks[0].kind, "research");
  const invalid = new ModelResearchPlanner({ createResponse: async () => ({ output_text: "not json" }) } as any);
  await assert.rejects(() => invalid.plan("bad"), /invalid JSON/);
});

test("research bridge authenticates and routes agent research actions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-bridge-"));
  const orchestrator = new ResearchOrchestrator(new ResearchRepository(root));
  const bridge = await startResearchBridge(orchestrator);
  try {
    const unauthorized = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) });
    assert.equal(unauthorized.status, 401);
    const createdResponse = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "create", question: "Bridge question" }) });
    const created = await createdResponse.json() as any;
    assert.equal(created.project.question, "Bridge question");
    const inspect = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "inspect", projectId: created.project.projectId }) });
    assert.equal((await inspect.json() as any).plan.tasks.length, 9);
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

test("research bridge validates action schema and applies a request rate limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-bridge-limit-"));
  try {
    const orchestrator = new ResearchOrchestrator(new ResearchRepository(root));
    const bridge = await startResearchBridge(orchestrator, { maxRequestsPerMinute: 10 });
    try {
      const request = (body: unknown) => fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const invalid = await request({ action: "bad action" });
      assert.equal(invalid.status, 400);
      const burst = await Promise.all(Array.from({ length: 10 }, () => request({ action: "list" })));
      assert.ok(burst.some((response) => response.status === 429));
    } finally { await bridge.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research bridge persists memory conflict reviews", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-bridge-memory-review-"));
  try {
    const orchestrator = new ResearchOrchestrator(new ResearchRepository(root));
    const created = await orchestrator.createProject("Review conflicting memory");
    await orchestrator.remember(created.project.projectId, { kind: "claim", text: "Result is positive", conflictKey: "result" });
    const second = await orchestrator.remember(created.project.projectId, { kind: "claim", text: "Result is negative", conflictKey: "result" });
    await orchestrator.remember(created.project.projectId, { kind: "claim", text: "Evidence quality is high", conflictKey: "quality" });
    await orchestrator.remember(created.project.projectId, { kind: "claim", text: "Evidence quality is low", conflictKey: "quality" });
    const bridge = await startResearchBridge(orchestrator);
    try {
      const request = (body: unknown) => fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const response = await request({ action: "memory-review", projectId: created.project.projectId, conflictKey: "result", status: "accepted", selectedMemoryId: second.memoryId, note: "Reviewed" });
      assert.equal(response.status, 200);
      const group = await response.json() as any;
      assert.equal(group.reviewStatus, "accepted");
      const conflicts = await request({ action: "memory-conflicts", projectId: created.project.projectId });
      const groups = await conflicts.json() as Array<{ entries: Array<{ memoryId: string; review?: { status: string } }> }>;
      assert.equal(groups.flatMap((group) => group.entries).find((entry) => entry.memoryId === second.memoryId)?.review?.status, "accepted");
      const batch = await request({ action: "memory-review-batch", projectId: created.project.projectId, reviews: [{ conflictKey: "result", status: "accepted", selectedMemoryId: second.memoryId, note: "Reviewed again" }, { conflictKey: "quality", status: "ignored", note: "Quality review deferred" }] });
      assert.equal(batch.status, 200);
      assert.equal((await batch.json() as any[]).length, 2);
    } finally { await bridge.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic research bridge scopes actions to the active runner task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-bridge-runner-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Runner-scoped bridge", { plan: { question: "Runner-scoped bridge", tasks: [{ taskId: "one", title: "One", objective: "Collect evidence", kind: "research" }] } });
    await orchestrator.activatePlan(created.project.projectId);
    await orchestrator.startNextTask(created.project.projectId);
    const bridge = await startResearchBridge(orchestrator, { runnerProjectId: created.project.projectId });
    try {
      const request = (body: unknown) => fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const contextResponse = await request({ action: "context" });
      assert.equal(contextResponse.status, 200);
      assert.equal((await contextResponse.json() as any).taskId, "one");
      const sourceResponse = await request({ action: "source", source: { title: "Runner source", url: "https://example.test/runner" } });
      assert.equal(sourceResponse.status, 200);
      assert.equal((await sourceResponse.json() as any).title, "Runner source");
      const forbidden = await request({ action: "complete", taskId: "one", outputRefs: [] });
      assert.equal(forbidden.status, 400);
      assert.match((await forbidden.json() as any).error, /not permitted/iu);
      const wrongProject = await request({ action: "inspect", projectId: "other-project" });
      assert.equal(wrongProject.status, 400);
      assert.match((await wrongProject.json() as any).error, /runner project/iu);
      const wrongTask = await request({ action: "artifact", taskId: "other-task", artifact: { path: path.join(root, "missing.txt") } });
      assert.equal(wrongTask.status, 400);
      assert.match((await wrongTask.json() as any).error, /active task/iu);
    } finally { await bridge.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("structured task results persist claims and advance the active task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-task-result-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Submit a structured result", {
      plan: {
        question: "Submit a structured result",
        tasks: [{ taskId: "one", title: "One", objective: "Produce one result", kind: "research" }],
      },
    });
    await orchestrator.activatePlan(created.project.projectId);
    await orchestrator.startNextTask(created.project.projectId);
    const notes = path.join(root, "review-notes.md");
    await writeFile(notes, "Synthetic source review notes for the task-result persistence test.");
    const artifact = await orchestrator.registerArtifact(created.project.projectId, { path: notes });
    const file = path.join(root, "source.txt");
    await writeFile(file, "A fixture for result persistence.");
    const { source } = await orchestrator.ingestDocument(created.project.projectId, file);
    const read = await orchestrator.readSource(created.project.projectId, { sourceId: source.sourceId }, "agent");
    const citation = await orchestrator.addCitation(created.project.projectId, source.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "A fixture for result persistence." });
    const result = await orchestrator.submitTaskResult(created.project.projectId, {
      ...taskResultIdentity((await repository.exportProject(created.project.projectId)).plan!.tasks[0]),
      projectId: created.project.projectId,
      taskId: "one",
      status: "completed",
      summary: "The source review is complete.",
      claims: [{ text: "The reviewed method is reproducible.", claimType: "conclusion", confidence: "medium" }],
      evidence: [{ claimIndex: 0, relation: "supports", artifactRef: artifact.artifactId }],
      refs: [artifact.artifactId, citation.citationId],
      nextAction: "write the report",
    });
    assert.equal(result.schema, "dsh-sci.research-task-result.v2");
    const exported = await repository.exportProject(created.project.projectId);
    assert.equal(exported.claims.length, 1);
    assert.equal(exported.evidence.length, 1);
    assert.equal(exported.plan?.tasks[0].status, "completed");
    assert.equal(exported.plan?.tasks[0].summary, "The source review is complete.");
    assert.equal(exported.plan?.tasks[0].nextAction, "write the report");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid structured result references are rejected before claims are persisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-task-result-atomic-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Reject invalid result references", { plan: { question: "Reject invalid result references", tasks: [{ taskId: "one", title: "One", objective: "Produce one result", kind: "research" }] } });
    await orchestrator.activatePlan(created.project.projectId);
    await orchestrator.startNextTask(created.project.projectId);
    const identity = taskResultIdentity((await repository.exportProject(created.project.projectId)).plan!.tasks[0]);
    await assert.rejects(() => orchestrator.submitTaskResult(created.project.projectId, { ...identity, projectId: created.project.projectId, taskId: "one", status: "completed", summary: "bad citation", claims: [{ text: "Unpersisted claim", citationIds: ["missing-citation"] }] }), /citation not found/);
    const exported = await repository.exportProject(created.project.projectId);
    assert.equal(exported.claims.length, 0);
    assert.equal(exported.evidence.length, 0);
    assert.equal(exported.plan?.tasks[0].status, "running");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research runner executes structured tasks until the plan completes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-runner-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Run a small plan", { plan: { question: "Run a small plan", tasks: [
      { taskId: "one", title: "One", objective: "First synthetic control-flow step", kind: "custom" },
      { taskId: "two", title: "Two", objective: "Second synthetic control-flow step", kind: "custom", dependsOn: ["one"] },
    ] } });
    const runner = new ResearchRunner(orchestrator);
    const result = await runner.run(created.project.projectId, { execute: async ({ task }) => ({ ...taskResultIdentity(task), projectId: created.project.projectId, taskId: task.taskId, status: "completed", summary: `completed ${task.taskId}` }) }, { maxSteps: 2 });
    assert.equal(result.status, "completed");
    assert.equal(result.steps, 2);
    assert.equal(result.plan.tasks.every((task) => task.status === "completed"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("research runner records executor failures and retries within the task budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-runner-retry-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Retry an executor failure", { plan: { question: "Retry an executor failure", tasks: [{ taskId: "one", title: "One", objective: "Retry a synthetic transport step", kind: "custom", maxAttempts: 2 }] } });
    let attempts = 0;
    const result = await new ResearchRunner(orchestrator).run(created.project.projectId, { execute: async ({ project, task }) => { attempts += 1; if (attempts === 1) throw new Error("temporary model failure"); return { ...taskResultIdentity(task), projectId: project.projectId, taskId: task.taskId, status: "completed", summary: "Recovered" }; } }, { maxSteps: 2 });
    assert.equal(result.status, "completed");
    assert.equal(attempts, 2);
    assert.equal((await repository.listEvents(created.project.projectId)).some((event) => event.type === "task-failed"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DSH executor resumes the persisted session in a new executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-resume-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Resume SDK research");
    await orchestrator.activatePlan(created.project.projectId);
    let current = await orchestrator.startNextTask(created.project.projectId);
    const calls: string[] = [];
    const client = {
      async initialize() {},
      async createSession(sessionId: string) { calls.push(`create:${sessionId}`); },
      async resume(sessionId: string) { calls.push(`resume:${sessionId}`); },
      async prompt() { return { messageId: "message" }; },
      async wait() {},
      lastAssistantText() { return JSON.stringify({ ...taskResultIdentity(current.task), projectId: current.project.projectId, taskId: current.task.taskId, status: "completed", summary: "Resumed result" }); },
      async close() {},
    };
    await new DshResearchTaskExecutor({ client, repository }).execute(current);
    const reopened = new ResearchRepository(root);
    await new DshResearchTaskExecutor({ client, repository: reopened }).execute(current);
    const sessionId = `dsh-sci-research-${current.project.projectId}`;
    assert.deepEqual(calls, [`create:${sessionId}`, `resume:${sessionId}`]);
    assert.deepEqual(await reopened.readAgentSession(current.project.projectId), { sessionId });
    await assert.rejects(() => new DshResearchTaskExecutor({ client, repository: reopened, sessionId: () => "other-session" }).execute(current), /identity does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DSH executor can bind a persisted session to the current plan version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-plan-session-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Bind SDK research to a plan");
    await orchestrator.activatePlan(created.project.projectId);
    let current = await orchestrator.startNextTask(created.project.projectId);
    const legacySessionId = `dsh-sci-research-${created.project.projectId}`;
    await repository.saveAgentSession(created.project.projectId, legacySessionId);
    const calls: string[] = [];
    const client = {
      async initialize() {},
      async createSession(sessionId: string) { calls.push(`create:${sessionId}`); },
      async resume(sessionId: string) { calls.push(`resume:${sessionId}`); },
      async prompt() { return { messageId: "message" }; },
      async wait() {},
      lastAssistantText() { return JSON.stringify({ ...taskResultIdentity(current.task), projectId: current.project.projectId, taskId: current.task.taskId, status: "completed", summary: "Plan-scoped result" }); },
      async close() {},
    };
    const scoped = (project: typeof current.project) => `dsh-sci-research-${project.projectId}-${project.planId}`;
    const firstPlanId = current.plan.planId, firstSessionId = scoped(current.project);
    await new DshResearchTaskExecutor({ client, repository, sessionId: scoped, sessionScope: "plan" }).execute(current);
    const reopened = new ResearchRepository(root);
    await new DshResearchTaskExecutor({ client, repository: reopened, sessionId: scoped, sessionScope: "plan" }).execute(current);
    assert.deepEqual(calls, [`create:${scoped(current.project)}`, `resume:${scoped(current.project)}`]);
    assert.deepEqual(await reopened.readAgentSession(current.project.projectId), { sessionId: legacySessionId });
    assert.deepEqual(await reopened.readAgentSession(current.project.projectId, current.plan.planId), { sessionId: scoped(current.project) });
    await orchestrator.replan(current.project.projectId);
    await orchestrator.activatePlan(current.project.projectId);
    current = await orchestrator.startNextTask(current.project.projectId);
    const secondSessionId = scoped(current.project);
    assert.notEqual(firstSessionId, secondSessionId);
    await new DshResearchTaskExecutor({ client, repository: reopened, sessionScope: "plan" }).execute(current);
    await new DshResearchTaskExecutor({ client, repository: new ResearchRepository(root), sessionScope: "plan" }).execute(current);
    assert.deepEqual(calls, [`create:${firstSessionId}`, `resume:${firstSessionId}`, `create:${secondSessionId}`, `resume:${secondSessionId}`]);
    assert.deepEqual(await reopened.readAgentSession(current.project.projectId, firstPlanId), { sessionId: firstSessionId });
    assert.deepEqual(await reopened.readAgentSession(current.project.projectId, current.plan.planId), { sessionId: secondSessionId });
    assert.deepEqual(await reopened.readAgentSession(current.project.projectId), { sessionId: legacySessionId });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DSH executor repairs one stale task-result identity without weakening the kernel check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-result-repair-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Repair a stale task result", { plan: { question: "Repair a stale task result", tasks: [{ taskId: "one", title: "One", objective: "Return a bounded result", kind: "custom" }] } });
    await orchestrator.activatePlan(created.project.projectId);
    const current = await orchestrator.startNextTask(created.project.projectId);
    let assistant = JSON.stringify({ ...taskResultIdentity(current.task), attemptId: "stale-attempt", submissionId: "result-stale-attempt", projectId: current.project.projectId, taskId: current.task.taskId, status: "completed", summary: "stale", refs: [], claims: [], evidence: [] });
    let prompts = 0;
    const client = {
      async initialize() {}, async createSession() {}, async resume() {},
      async prompt(_session: string, text: string) {
        prompts += 1;
        if (prompts === 2) {
          assert.match(text, /previous task-result JSON was rejected/);
          const exact = JSON.parse(text.match(/(\{"projectId"[\s\S]+\})$/u)![1]);
          assistant = JSON.stringify({ ...exact, status: "completed", summary: "repaired", refs: [], claims: [], evidence: [] });
        }
        return { messageId: `message-${prompts}` };
      },
      async wait() {}, lastAssistantText() { return assistant; }, async close() {},
    };
    const result = await new DshResearchTaskExecutor({ client, repository }).execute(current);
    assert.equal(result.summary, "repaired");
    assert.equal(prompts, 2);
    const events = await repository.listEvents(created.project.projectId);
    assert.equal(events.filter((event) => event.type === "task-result-repair-requested").length, 1);
    await orchestrator.submitTaskResult(created.project.projectId, result);
    assert.equal((await repository.exportProject(created.project.projectId)).plan!.tasks[0].status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity repair is bounded, refuses paused execution and cannot replace required outputs", async () => {
  for (const scenario of ["still-wrong", "paused", "missing-bundle"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-result-bound-"));
    try {
      const repository = new ResearchRepository(root), orchestrator = new ResearchOrchestrator(repository);
      const { project } = await orchestrator.createProject("Bounded result repair", { plan: { question: "Bounded result repair", tasks: [{ taskId: "code", title: "Code", objective: "Save complete source", kind: "code-preparation" }] } });
      await orchestrator.activatePlan(project.projectId);
      const context = await orchestrator.startNextTask(project.projectId);
      let prompts = 0;
      const result = { ...taskResultIdentity(context.task), projectId: project.projectId, taskId: "code", status: "completed", summary: "No code was saved", refs: [], claims: [], evidence: [] };
      let assistant = JSON.stringify({ ...result, attemptId: "old-attempt" });
      const client = {
        async initialize() {}, async createSession() {}, async resume() {}, async close() {},
        async prompt() { prompts += 1; if (prompts === 2 && scenario === "missing-bundle") assistant = JSON.stringify(result); return { messageId: String(prompts) }; },
        async wait() { if (scenario === "paused") await orchestrator.pause(project.projectId); },
        lastAssistantText() { return assistant; },
      };
      const execution = new DshResearchTaskExecutor({ client, repository }).execute(context);
      if (scenario === "missing-bundle") await assert.rejects(orchestrator.submitTaskResult(project.projectId, await execution), /missing required outputs: code-bundle/);
      else await assert.rejects(execution, scenario === "paused" ? /superseded|state changed/ : /exact current plan/);
      const snapshot = await repository.exportProject(project.projectId);
      assert.equal(prompts, scenario === "paused" ? 1 : 2);
      assert.equal(snapshot.plan!.tasks[0].status, "running");
      assert.equal(snapshot.plan!.tasks[0].attempts, 1);
      assert.equal(snapshot.events.filter((event) => event.type === "task-result-repair-requested").length, scenario === "paused" ? 0 : 1);
      assert.equal(snapshot.events.some((event) => event.type === "task-completed"), false);
      assert.equal(snapshot.codeBundles?.length, 0);
      assert.equal(snapshot.experimentRuns.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("DSH executor reconnects after a mid-run SDK crash and completes a 20-step plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-reconnect-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const tasks = Array.from({ length: 20 }, (_, index) => ({ taskId: `task-${String(index + 1).padStart(2, "0")}`, title: `Task ${index + 1}`, objective: "Complete one synthetic transport checkpoint", kind: "custom" as const }));
    const created = await orchestrator.createProject("Recover a long SDK run", { plan: { question: "Recover a long SDK run", tasks } });
    const sessionId = `dsh-sci-research-${created.project.projectId}`;
    let reconnects = 0;
    let prompts = 0;
    let crashed = false;
    const makeClient = (name: string) => {
      let assistant: string | undefined;
      return {
        async initialize() {},
        async createSession() {},
        async resume() {},
        async prompt(_id: string, text: string) {
          prompts += 1;
          if (name === "first" && !crashed && prompts === 7) { crashed = true; throw new Error("JSON-RPC input closed after SDK crash"); }
          const projectId = /Project: ([^\n]+)/.exec(text)?.[1] ?? "";
          const taskId = /Task: ([^ ]+)/.exec(text)?.[1] ?? "";
          assistant = JSON.stringify({ ...JSON.parse(text.match(/^Exact execution identity: (.+)$/m)![1]), projectId, taskId, status: "completed", summary: `completed by ${name}`, refs: [], claims: [], evidence: [], nextAction: "continue" });
          return { messageId: `${name}-${taskId}` };
        },
        async wait() {},
        lastAssistantText() { return assistant; },
        async close() {},
      };
    };
    let client = makeClient("first");
    const executor = new DshResearchTaskExecutor({ client, repository, sessionId: () => sessionId, maxReconnectAttempts: 1, reconnect: async () => { reconnects += 1; client = makeClient("reconnected"); return client; } });
    const result = await new ResearchRunner(orchestrator).run(created.project.projectId, executor, { maxSteps: 20 });
    assert.equal(result.status, "completed");
    assert.equal(result.steps, 20);
    assert.equal(reconnects, 1);
    assert.equal((await repository.readAgentSession(created.project.projectId))?.sessionId, sessionId);
    assert.equal(result.plan.tasks.every((task) => task.status === "completed"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DSH executor rebuilds a crashed SDK child process and resumes its persisted session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-child-reconnect-"));
  try {
    const fake = path.join(root, "crash-once-sdk.mjs");
    const marker = path.join(root, "crashed.marker");
    await writeFile(fake, `import readline from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
const marker = process.env.DSH_SCI_CRASH_MARKER;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line); const id = request.id;
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "1" } } });
  if (request.method === "session/working-directory/get" || request.method === "session/resume") return send({ jsonrpc: "2.0", id, result: {} });
  if (request.method === "session/prompt") {
    if (!existsSync(marker)) { writeFileSync(marker, "crashed"); setTimeout(() => process.exit(17), 5); return; }
    const prompt = request.params.contentBlocks[0].text;
    const projectId = /Project: ([^\\n]+)/.exec(prompt)?.[1] ?? "PROJECT";
    const taskId = /Task: ([^ ]+)/.exec(prompt)?.[1] ?? "TASK";
    const result = { ...JSON.parse(prompt.split("Exact execution identity: ")[1].split("\\n")[0]), projectId, taskId, status: "completed", summary: "Recovered after child crash", refs: [], claims: [], evidence: [], nextAction: "continue" };
    send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: request.params.sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: JSON.stringify(result) }] } } } } });
    return send({ jsonrpc: "2.0", id, result: { messageId: "recovered-message" } });
  }
  if (request.method === "session/wait") { send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: request.params.sessionId, event: { type: "turn/end", data: { reason: { kind: "completed" } } } } }); return send({ jsonrpc: "2.0", id, result: {} }); }
  if (request.method === "shutdown") { send({ jsonrpc: "2.0", id, result: {} }); setTimeout(() => process.exit(0), 5); }
});`, "utf8");
    const repository = new ResearchRepository(path.join(root, "store"));
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Recover a crashed SDK child", { plan: { question: "Recover a crashed SDK child", tasks: [{ taskId: "one", title: "One", objective: "Recover a synthetic transport step", kind: "custom" }] } });
    const clientOptions = { home: path.join(root, "home"), cwd: root, provider: "custom", model: "fake", command: process.execPath, args: [fake], environment: { DSH_SCI_CRASH_MARKER: marker } };
    let client = await startDshSdkClient(clientOptions);
    let reconnects = 0;
    const executor = new DshResearchTaskExecutor({ client, repository, maxReconnectAttempts: 1, reconnect: async () => { reconnects += 1; client = await startDshSdkClient(clientOptions); return client; } });
    try {
      const result = await new ResearchRunner(orchestrator).run(created.project.projectId, executor, { maxSteps: 1 });
      assert.equal(result.status, "completed");
      assert.equal(reconnects, 1);
      assert.ok(await repository.readAgentSession(created.project.projectId));
    } finally { await client.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SDK request cancellation releases a pending wait and closes its process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-cancel-"));
  try {
    const fake = path.join(root, "waiting-sdk.mjs");
    await writeFile(fake, `import readline from "node:readline";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send(request.id, { serverInfo: { name: "deepseek-harness-sdk-runtime" } });
  if (request.method === "shutdown") { send(request.id, {}); setTimeout(() => process.exit(0), 5); }
});`, "utf8");
    const client = await startDshSdkClient({ home: root, cwd: root, provider: "custom", model: "fake", command: process.execPath, args: [fake] });
    try {
      const controller = new AbortController();
      const waiting = client.wait("pending-session", controller.signal);
      const rejected = assert.rejects(waiting, /Research run cancelled/);
      controller.abort(new DOMException("Research run cancelled", "AbortError"));
      await rejected;
    } finally { await client.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("aborting an SDK task force-closes its owned process before a retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-timeout-boundary-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const created = await orchestrator.createProject("Enforce SDK timeout boundary", { plan: { question: "Enforce SDK timeout boundary", tasks: [{ taskId: "one", title: "One", objective: "Abort a synthetic SDK turn", kind: "custom", maxAttempts: 2 }] } });
    await orchestrator.activatePlan(created.project.projectId);
    const current = await orchestrator.startNextTask(created.project.projectId);
    const closed: boolean[] = [];
    const makeClient = (name: string) => {
      let assistant: string | undefined;
      return {
        async initialize() {},
        async createSession() {},
        async resume() {},
        async prompt(_sessionId: string, text: string) {
          if (name === "retry") {
            const identity = JSON.parse(text.match(/^Exact execution identity: (.+)$/m)![1]);
            const projectId = /Project: ([^\n]+)/.exec(text)?.[1] ?? current.project.projectId;
            const taskId = /Task: ([^ ]+)/.exec(text)?.[1] ?? current.task.taskId;
            assistant = JSON.stringify({ ...identity, projectId, taskId, status: "completed", summary: "Recovered after timeout", refs: [], claims: [], evidence: [] });
          }
          return { messageId: name };
        },
        async wait(_sessionId: string, signal?: AbortSignal) {
          if (name === "retry") return;
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) { reject(signal.reason); return; }
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        lastAssistantText() { return assistant; },
        async close(force?: boolean) { closed.push(force === true); },
      };
    };
    let client = makeClient("first");
    let reconnects = 0;
    const executor = new DshResearchTaskExecutor({ client, repository, maxReconnectAttempts: 0, reconnect: async () => { reconnects += 1; client = makeClient("retry"); return client; } });
    const controller = new AbortController();
    const pending = executor.execute(current, controller.signal);
    setTimeout(() => controller.abort(new Error("task timeout")), 10);
    await assert.rejects(pending, /task timeout/);
    assert.deepEqual(closed, [true]);
    const second = await executor.execute(current);
    assert.equal(second.status, "completed");
    assert.equal(reconnects, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SDK client surfaces a Harness process crash during a research turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-sdk-crash-"));
  try {
    const fake = path.join(root, "crash-sdk.mjs");
    await writeFile(fake, `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => { const request = JSON.parse(line); if (request.method === "initialize") send(request.id, { serverInfo: { name: "deepseek-harness-sdk-runtime" } }); if (request.method === "session/prompt") setTimeout(() => process.exit(17), 15); });`, "utf8");
    const client = await startDshSdkClient({ home: path.join(root, "home"), cwd: root, provider: "custom", model: "fake", command: process.execPath, args: [fake] });
    try {
      await assert.rejects(() => client.prompt("crash-session", "start"), /JSON-RPC input closed|transport closed/);
    } finally { await client.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("official DSH SDK executor drives a task through the JSON-RPC loop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-sdk-"));
  try {
    const fake = path.join(root, "fake-sdk.mjs");
    await writeFile(fake, `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => { const request = JSON.parse(line); const id = request.id;
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "1" } } });
  if (request.method === "session/working-directory/get") return send({ jsonrpc: "2.0", id, result: { cwd: process.cwd() } });
  if (request.method === "session/prompt") { const prompt = request.params.contentBlocks[0].text; const projectId = /Project: ([^\\n]+)/.exec(prompt)?.[1] ?? "PROJECT"; const result = { schema: "dsh-sci.research-task-result.v2", ...JSON.parse(prompt.split("Exact execution identity: ")[1].split("\\n")[0]), projectId, taskId: "one", status: "completed", summary: "Agent completed the task", refs: [], claims: [], evidence: [], nextAction: "continue", submittedAt: new Date().toISOString() }; send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: request.params.sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: JSON.stringify(result) }] } } } } }); return send({ jsonrpc: "2.0", id, result: { messageId: "message-1" } }); }
  if (request.method === "session/wait") { send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: request.params.sessionId, event: { type: "turn/end", data: { reason: { kind: "completed" } } } } }); return send({ jsonrpc: "2.0", id, result: {} }); }
  if (request.method === "shutdown") { send({ jsonrpc: "2.0", id, result: {} }); setTimeout(() => process.exit(0), 5); }
});`, "utf8");
    const client = await startDshSdkClient({ home: path.join(root, "home"), cwd: root, provider: "custom", model: "fake", command: process.execPath, args: [fake] });
    try {
      const repository = new ResearchRepository(path.join(root, "store"));
      const orchestrator = new ResearchOrchestrator(repository);
      const created = await orchestrator.createProject("Drive an SDK task", { plan: { question: "Drive an SDK task", tasks: [{ taskId: "one", title: "One", objective: "Complete a synthetic protocol step", kind: "custom" }] } });
      const executor = new DshResearchTaskExecutor({ client, repository });
      const result = await new ResearchRunner(orchestrator).run(created.project.projectId, executor);
      assert.equal(result.status, "completed");
      assert.equal(result.steps, 1);
      assert.equal(result.plan.tasks[0].summary, "Agent completed the task");
    } finally { await client.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
