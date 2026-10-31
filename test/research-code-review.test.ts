import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { taskResultIdentity } from "../src/research/task-result.js";
import { ModelResearchPlanner } from "../src/research/planner.js";
import { readStagedCodeFile } from "../src/research/code-review.js";
import { allowedActionsFor, taskContractFor } from "../src/research/task-contract.js";
import { researchInspection } from "../src/research/inspect.js";
import { contentDigest } from "../src/research/content-digest.js";

async function fixture(encrypted = false, withDesign = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-code-review-"));
  const options = { metadataPassphrase: encrypted ? "fixture-review-passphrase" : undefined };
  const repository = new ResearchRepository(root, options);
  const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root } });
  const { project } = await orchestrator.createProject("Inspect candidate code without execution", { plan: { question: "Inspect candidate code without execution", tasks: [
    ...(withDesign ? [
      { taskId: "hypothesis", title: "Hypothesis", objective: "State a testable prediction", kind: "hypothesis" as const },
      { taskId: "design", title: "Design", objective: "Save a candidate design", kind: "experiment-design" as const, dependsOn: ["hypothesis"] },
    ] : []),
    { taskId: "code", title: "Prepare", objective: "Save candidate files", kind: "code-preparation", dependsOn: withDesign ? ["design"] : [] },
    { taskId: "review", title: "Static review", objective: "Read all candidate files and record limitations", kind: "code-review", dependsOn: ["code"] },
    { taskId: "run", title: "Run", objective: "Wait for explicit approval", kind: "experiment", dependsOn: ["review"], requiresApproval: true },
  ] } });
  const projectId = project.projectId;
  await orchestrator.activatePlan(projectId); await orchestrator.startNextTask(projectId);
  let design;
  if (withDesign) {
    const hypothesis = await orchestrator.createHypothesis(projectId, { proposition: "A changes the error", scope: "Synthetic fixture only", predictions: ["Paired difference is nonzero"], falsifiers: ["Interval includes zero"] });
    await orchestrator.completeTask(projectId, "hypothesis", [hypothesis.hypothesisId]); await orchestrator.startNextTask(projectId);
    design = await orchestrator.createExperimentDesign(projectId, { hypothesisIds: [hypothesis.hypothesisId], dataDescription: "Synthetic fixture", dataVersion: "v1", experimentalUnit: "independent replicate", independentVariables: ["method"], dependentVariables: ["error"], controls: ["same mask"], primaryMetric: "paired MSE", repetitions: 100, randomization: "fixed seeds", missingDataHandling: "shared mask", analysisMethod: "paired bootstrap", stoppingRule: "all replicates" });
    await orchestrator.completeTask(projectId, "design", [design.designId]); await orchestrator.startNextTask(projectId);
  }
  const source = "import fs from 'node:fs';\n" + "// Long review section.\n".repeat(600) + "fs.writeFileSync('must-not-execute.txt','未经批准');\n";
  const bundle = await orchestrator.stageCode(projectId, { files: [
    { name: "run.mjs", kind: "code", content: source },
    { name: "config.json", kind: "input", content: '{"master":"20261030"}' },
    { name: "dependencies.lock", kind: "dependency", content: "node-builtins-only\n" },
  ] });
  await orchestrator.completeTask(projectId, "code", [bundle.bundleId]);
  await orchestrator.startNextTask(projectId);
  const input = { bundleId: bundle.bundleId, summary: "Found an output configuration type mismatch; no tests or simulation executed", findings: [{ severity: "blocker" as const, fileName: "config.json", startOffset: 10, endOffset: 20, message: "Master seed is a string", recommendation: "Use the frozen numeric configuration" }], limitations: ["Agent static inspection only; independent correctness and human approval remain pending"] };
  const readAll = async () => {
    for (const file of bundle.files) {
      let offset: number | undefined = 0;
      while (offset !== undefined) { const read = await orchestrator.readCode(projectId, { bundleId: bundle.bundleId, fileName: file.name, offset }); offset = read.nextOffset; }
    }
  };
  return { root, options, repository, orchestrator, projectId, bundle, design, source, input, readAll, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("planner and task permissions distinguish static code review from literature and preparation", async () => {
  const planner = new ModelResearchPlanner({ async createResponse(request: { instructions: string }) {
    assert.match(request.instructions, /Static candidate-code review must use code-review/);
    return { output_text: JSON.stringify({ tasks: [{ taskId: "review", title: "Review", objective: "Record static findings", kind: "code-review" }] }) };
  } } as any);
  assert.equal((await planner.plan("Review a candidate")).tasks[0].kind, "code-review");
  assert.deepEqual(taskContractFor("code-review").requiredOutputs, ["code-review"]);
  for (const kind of ["source-review", "custom"] as const) assert.equal(allowedActionsFor(kind).includes("code-review"), false);
  for (const action of ["code-stage", "experiment", "source", "citation", "evaluate"]) assert.equal(allowedActionsFor("code-review").includes(action), false);
});

test("all saved findings and limitations remain readable through bounded project-scoped detail pages", async () => {
  const f = await fixture();
  let bridge: Awaited<ReturnType<typeof startResearchBridge>> | undefined;
  try {
    await f.readAll();
    const findings = Array.from({ length: 14 }, (_, i) => ({ ...f.input.findings[0], message: `Finding ${i}: ` + "证据待核对".repeat(300), recommendation: `Recommendation ${i}: ` + "检查实际行为".repeat(300) }));
    const limitations = Array.from({ length: 14 }, (_, i) => `Limitation ${i}: ` + "未执行未批准".repeat(300));
    const review = await f.orchestrator.reviewCode(f.projectId, { ...f.input, findings, limitations });
    const reopened = new ResearchRepository(f.root);
    const before = await reopened.exportProject(f.projectId);
    const inventory = researchInspection(before, { collection: "codeReviews" });
    const record = (inventory as any).records[0];
    assert.equal(record.codeReviewId, review.codeReviewId);
    assert.equal(record.findingCount, 14);
    assert.equal(record.limitationCount, 14);
    assert.ok(JSON.stringify(record).length < 3500);
    bridge = await startResearchBridge(f.orchestrator, { access: "read-only", scopeProjectId: f.projectId });
    const request = async (extra: Record<string, unknown>) => {
      const response = await fetch(bridge!.url, { method: "POST", headers: { authorization: `Bearer ${bridge!.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "inspect", collection: "codeReviews", recordId: review.codeReviewId, ...extra }) });
      return { status: response.status, body: await response.json() as any };
    };
    for (const field of ["findings", "limitations"] as const) {
      const collected = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const { status, body } = await request({ field, offset, limit: 3 });
        assert.equal(status, 200);
        assert.equal(body.total, 14);
        assert.equal(body.scientificQuality, "not-reviewed");
        assert.ok(body.entries.length <= 3);
        assert.ok(JSON.stringify(body).length < 26000, "long persisted findings cannot inflate one page beyond bounded fields");
        collected.push(...body.entries);
        offset = body.nextOffset;
      }
      assert.deepEqual(collected, review[field]);
    }
    const defaultPage = await request({ field: "findings" });
    assert.equal(defaultPage.body.entries.length, 1);
    assert.equal((await request({ field: "findings", recordId: "missing-review" })).status, 400);
    assert.equal((await request({ field: "findings", projectId: "foreign-project" })).status, 400);
    for (const extra of [{ field: "findings", limit: 4 }, { field: "findings", offset: -1 }, { field: "findings", limit: 0 }, { field: "other" }, { field: "findings", collection: "sources" }]) assert.equal((await request(extra)).status, 400);
    assert.deepEqual(await reopened.exportProject(f.projectId), before, "detail inspection creates no code-read receipts, reviews, approvals or task transitions");
  } finally { await bridge?.close(); await f.cleanup(); }
});

test("a review requires complete bounded reads of code, inputs and dependencies and never runs the source", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.orchestrator.completeTask(f.projectId, "review", [f.bundle.bundleId]), /missing required outputs: code-review/);
    await assert.rejects(f.orchestrator.reviewCode(f.projectId, f.input), /complete current-attempt reads/);
    const first = await f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "run.mjs", limit: 12000 });
    assert.equal(first.text, f.source.slice(0, 12000)); assert.equal(first.nextOffset, 12000);
    assert.equal(first.receipt.endOffset - first.receipt.offset, 12000);
    await assert.rejects(f.orchestrator.reviewCode(f.projectId, f.input), /complete current-attempt reads/);
    await f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "run.mjs", offset: 12000 });
    await f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "config.json" });
    await assert.rejects(f.orchestrator.reviewCode(f.projectId, f.input), /complete current-attempt reads/);
    await f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "dependencies.lock" });
    const review = await f.orchestrator.reviewCode(f.projectId, f.input);
    assert.equal(review.actor, "agent"); assert.equal(review.status, "findings-recorded"); assert.equal(review.scientificQuality, "not-reviewed");
    assert.equal((await f.orchestrator.reviewCode(f.projectId, f.input)).codeReviewId, review.codeReviewId);
    await f.orchestrator.completeTask(f.projectId, "review", [review.codeReviewId, f.bundle.bundleId]);
    const snapshot = await f.repository.exportProject(f.projectId);
    assert.equal(snapshot.plan!.tasks[1].status, "completed");
    assert.equal(snapshot.plan!.tasks[2].requiresApproval, true);
    assert.equal(snapshot.experimentRuns.length, 0); assert.equal(snapshot.citations.length, 0);
    assert.equal(snapshot.codeReviews!.length, 1);
    await assert.rejects(readFile(path.join(f.bundle.directory, "must-not-execute.txt")), /ENOENT/);
  } finally { await f.cleanup(); }
});

test("reading gaps, file mutation and unregistered paths cannot produce an accepted static review", async () => {
  const f = await fixture();
  try {
    for (const input of [{ limit: 12001 }, { limit: 0 }, { offset: -1 }, { offset: 1.5 }, { offset: f.source.length }]) await assert.rejects(f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "run.mjs", ...input }));
    for (const fileName of ["../project.json", "missing.mjs", path.join(f.root, "index.json")]) await assert.rejects(f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName }));
    // Matching head and tail receipts cannot conceal an unread gap.
    await f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "run.mjs", limit: 200 });
    await f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "run.mjs", offset: 5000 });
    for (const fileName of ["config.json", "dependencies.lock"]) await f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName });
    await assert.rejects(f.orchestrator.reviewCode(f.projectId, f.input), /complete current-attempt reads/);
    await f.readAll();
    const review = await f.orchestrator.reviewCode(f.projectId, f.input);
    await writeFile(f.bundle.files.find((file) => file.name === "config.json")!.path, '{"master":202610300}');
    await assert.rejects(f.orchestrator.readCode(f.projectId, { bundleId: f.bundle.bundleId, fileName: "config.json" }), /changed/);
    await assert.rejects(f.orchestrator.completeTask(f.projectId, "review", [review.codeReviewId]), /changed/);
    assert.equal((await f.repository.exportProject(f.projectId)).plan!.tasks[1].status, "running");
  } finally { await f.cleanup(); }
});

test("a retried code review cannot reuse old-attempt reads or reviews", async () => {
  const f = await fixture();
  try {
    await f.readAll();
    const old = await f.orchestrator.reviewCode(f.projectId, f.input);
    await f.orchestrator.failTask(f.projectId, "review", "Injected test interruption");
    await f.orchestrator.startNextTask(f.projectId);
    await assert.rejects(f.orchestrator.completeTask(f.projectId, "review", [old.codeReviewId]), /missing required outputs/);
    await assert.rejects(f.orchestrator.reviewCode(f.projectId, f.input), /current-attempt reads/);
    await f.readAll();
    const current = await f.orchestrator.reviewCode(f.projectId, f.input);
    assert.notEqual(current.attemptId, old.attemptId); assert.notEqual(current.codeReviewId, old.codeReviewId);
    await f.orchestrator.completeTask(f.projectId, "review", [current.codeReviewId]);
  } finally { await f.cleanup(); }
});

test("design-driven review binds a current draft design and refuses completion after supersession", async () => {
  const f = await fixture(false, true);
  try {
    await f.readAll();
    await assert.rejects(f.orchestrator.reviewCode(f.projectId, f.input), /current design binding/);
    const review = await f.orchestrator.reviewCode(f.projectId, { ...f.input, designId: f.design!.designId });
    assert.deepEqual(review.designBinding, { designId: f.design!.designId, contentHash: f.design!.contentHash });
    assert.equal((await f.repository.readExperimentDesign(f.projectId, f.design!.designId))!.status, "draft");
    // Fixture mutation represents a trusted design revision arriving before submit.
    await f.repository.saveExperimentDesign({ ...f.design!, status: "superseded" });
    await assert.rejects(f.orchestrator.completeTask(f.projectId, "review", [review.codeReviewId]), /current design/);
    assert.equal((await f.repository.exportProject(f.projectId)).plan!.tasks.find((task) => task.taskId === "review")!.status, "running");
  } finally { await f.cleanup(); }
});

test("invalid finding ranges and foreign-plan bundles are refused before recording a review", async () => {
  const f = await fixture();
  try {
    await f.readAll();
    for (const patch of [{ limitations: [] }, { findings: [{ ...f.input.findings[0], fileName: "missing.mjs" }] }, { findings: [{ ...f.input.findings[0], startOffset: 1000 }] }, { findings: [{ ...f.input.findings[0], severity: "approved" }] }]) await assert.rejects(f.orchestrator.reviewCode(f.projectId, { ...f.input, ...patch } as any));
    await f.repository.saveCodeBundle({ ...f.bundle, bundleId: "old-bundle", planId: "old-plan" });
    await assert.rejects(f.orchestrator.readCode(f.projectId, { bundleId: "old-bundle", fileName: "run.mjs" }), /current-plan dependencies/);
    assert.equal((await f.repository.listCodeReviews(f.projectId)).length, 0);
  } finally { await f.cleanup(); }
});

test("automatic bridge enforces code review scope and ignores forged approval and receipt identities", async () => {
  const f = await fixture();
  const bridge = await startResearchBridge(f.orchestrator, { runnerProjectId: f.projectId });
  const readOnly = await startResearchBridge(f.orchestrator, { access: "read-only", scopeProjectId: f.projectId });
  const request = async (input: unknown, target = bridge) => { const response = await fetch(target.url, { method: "POST", headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
  try {
    assert.equal((await request({ action: "code-read", bundleId: f.bundle.bundleId, fileName: "config.json", projectId: "another-project" })).status, 400);
    assert.equal((await request({ action: "code-stage", files: [{ name: "replacement.mjs", kind: "code", content: "x" }] })).status, 400);
    assert.equal((await request({ action: "code-read", bundleId: f.bundle.bundleId, fileName: "config.json" }, readOnly)).status, 400);
    const read = await request({ action: "code-read", bundleId: f.bundle.bundleId, fileName: "config.json", attemptId: "forged", actor: "trusted-workspace" });
    assert.equal(read.status, 200); assert.notEqual(read.body.receipt.attemptId, "forged"); assert.equal(read.body.receipt.actor, "agent");
    await f.readAll();
    const review = await request({ action: "code-review", ...f.input, actor: "trusted-workspace", status: "approved", scientificQuality: "reviewed", codeReadIds: ["forged"] });
    assert.equal(review.status, 200); assert.equal(review.body.actor, "agent"); assert.equal(review.body.scientificQuality, "not-reviewed"); assert.equal(review.body.status, "findings-recorded");
    const task = (await f.repository.exportProject(f.projectId)).plan!.tasks[1];
    await f.orchestrator.submitTaskResult(f.projectId, { ...taskResultIdentity(task), projectId: f.projectId, taskId: task.taskId, status: "completed", summary: "Static findings only", refs: [review.body.codeReviewId] });
    assert.equal((await f.repository.exportProject(f.projectId)).experimentRuns.length, 0);
  } finally { await bridge.close(); await readOnly.close(); await f.cleanup(); }
});

test("code review records survive encrypted repository restart without granting acceptance", async () => {
  const f = await fixture(true);
  try {
    await f.readAll(); const review = await f.orchestrator.reviewCode(f.projectId, f.input);
    const stored = await readFile(path.join(f.root, "projects", f.projectId, "code-reviews", `${review.codeReviewId}.json`), "utf8");
    assert.equal(stored.includes(review.summary), false);
    const reopened = new ResearchRepository(f.root, f.options);
    assert.deepEqual((await reopened.exportProject(f.projectId)).codeReviews, [review]);
    await assert.rejects(reopened.saveCodeReview({ ...review, summary: "changed" }), /hash/);
    const reads = await reopened.listCodeReads(f.projectId);
    await assert.rejects(reopened.saveCodeRead({ ...reads[0], endOffset: reads[0].endOffset - 1 }), /immutable/);
  } finally { await f.cleanup(); }
});

test("rehashing an oversized or malformed stored review cannot bypass bounded detail validation", async () => {
  const f = await fixture();
  try {
    await f.readAll();
    const review = await f.orchestrator.reviewCode(f.projectId, f.input);
    for (const patch of [
      { findings: Array.from({ length: 51 }, () => review.findings[0]) },
      { limitations: [] },
      { findings: [{ ...review.findings[0], message: "x".repeat(4001) }] },
      { findings: [{ ...review.findings[0], endOffset: 1000000 }] },
      { files: [{ ...review.files[0], name: "../outside.mjs" }] },
    ]) {
      const { codeReviewId: _id, createdAt, ...record } = { ...review, ...patch };
      await assert.rejects(f.repository.saveCodeReview({ ...record, createdAt, codeReviewId: `code-review-${contentDigest(record)}` }), /code review|safe relative/);
    }
    assert.deepEqual((await f.repository.exportProject(f.projectId)).codeReviews, [review]);
  } finally { await f.cleanup(); }
});

test("reading rejects a forged bundle path and symbolic links even when bytes match", async (t) => {
  const f = await fixture();
  try {
    const code = f.bundle.files.find((file) => file.name === "run.mjs")!;
    await assert.rejects(readStagedCodeFile(f.root, { ...f.bundle, files: f.bundle.files.map((file) => file === code ? { ...file, path: path.join(f.root, "private.mjs") } : file) }, "run.mjs"), /staging location/);
    const copy = path.join(f.root, "copy.mjs"); await writeFile(copy, f.source);
    await unlink(code.path);
    try { await symlink(copy, code.path, "file"); } catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Windows symbolic link privilege unavailable"); return; } throw error; }
    await assert.rejects(readStagedCodeFile(f.root, f.bundle, "run.mjs"), /symbolic links/);
  } finally { await f.cleanup(); }
});
