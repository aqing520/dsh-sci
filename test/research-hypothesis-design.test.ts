import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { taskResultIdentity } from "../src/research/task-result.js";

const hInput = { proposition: "Median imputation lowers MAE", scope: "Fixed lognormal data under MCAR at 20% missingness", predictions: ["Paired MAE difference median minus mean is negative"], falsifiers: ["The pre-registered interval includes zero or favors the mean"], alternativeExplanations: ["Sampling variability"] };
const dInput = { dataDescription: "Fixed synthetic dataset", dataVersion: "generator-v1-seed-7", experimentalUnit: "Independent dataset; both methods share the mask", independentVariables: ["imputation method"], dependentVariables: ["error on masked cells"], controls: ["complete data", "identical missing cells"], primaryMetric: "paired MAE difference", repetitions: 100, randomization: "Pre-registered per-repetition seeds", missingDataHandling: "Score only cells in the shared missingness mask", analysisMethod: "Paired interval on dataset-level differences", stoppingRule: "After all 100 repetitions, regardless of effect", randomSeed: 7 };

async function fixture(revise = false, encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-design-"));
  const repository = new ResearchRepository(root, encrypted ? { metadataPassphrase: "test-passphrase" } : {});
  const orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject("Compare imputation", { plan: { question: "Compare imputation", tasks: [
    { taskId: "h", title: "Hypothesis", objective: "State a falsifiable hypothesis", kind: "hypothesis" },
    { taskId: "d", title: "Design", objective: "Pre-register experiment", kind: "experiment-design", dependsOn: ["h"] },
    ...(revise ? [{ taskId: "revise", title: "Revise", objective: "Revise with new evidence", kind: "hypothesis" as const, dependsOn: ["d"] }] : []),
    { taskId: "run", title: "Run", objective: "Execute approved design", kind: "experiment", dependsOn: [revise ? "revise" : "d"], requiresApproval: true },
  ] } });
  const id = project.projectId;
  await orchestrator.activatePlan(id);
  await orchestrator.startNextTask(id);
  const cleanup = () => rm(root, { recursive: true, force: true });
  const designStage = async () => {
    const h = await orchestrator.createHypothesis(id, hInput);
    await orchestrator.completeTask(id, "h", [h.hypothesisId]);
    await orchestrator.startNextTask(id);
    return h;
  };
  return { root, repository, orchestrator, id, cleanup, designStage };
}

test("hypotheses require predictions, falsifiers and revision reasons; a tag cannot complete the task", async () => {
  const { id, orchestrator: o, repository: r, cleanup } = await fixture();
  try {
    for (const patch of [{ predictions: [] }, { falsifiers: [] }, { scope: " " }, { supersedesHypothesisId: "missing" }, { changeReason: "reason without predecessor" }]) await assert.rejects(() => o.createHypothesis(id, { ...hInput, ...patch }));
    assert.equal((await r.listHypotheses(id)).length, 0);
    const claim = await o.addClaim(id, { text: "Only a hypothesis tag", claimType: "hypothesis" });
    await assert.rejects(() => o.completeTask(id, "h", [claim.claimId]), /missing required outputs: hypothesis/);
  } finally { await cleanup(); }
});

test("identical concurrent hypothesis and design submissions reuse IDs and events", async () => {
  const { id, orchestrator: o, repository: r, cleanup, designStage } = await fixture();
  try {
    const hypotheses = await Promise.all(Array.from({ length: 3 }, () => o.createHypothesis(id, hInput)));
    assert.equal(new Set(hypotheses.map((h) => h.hypothesisId)).size, 1);
    const h = await designStage();
    const designs = await Promise.all(Array.from({ length: 3 }, () => o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId] })));
    assert.equal(new Set(designs.map((d) => d.designId)).size, 1);
    assert.equal((await r.listHypotheses(id)).length, 1);
    assert.equal((await r.listExperimentDesigns(id)).length, 1);
    for (const type of ["hypothesis-created", "experiment-design-created"]) assert.equal((await r.listEvents(id)).filter((e) => e.type === type).length, 1);
  } finally { await cleanup(); }
});

test("designs reject missing design fields, unknown hypotheses and unregistered data refs", async () => {
  const { id, orchestrator: o, repository: r, cleanup, designStage } = await fixture();
  try {
    const h = await designStage();
    for (const patch of [{ controls: [] }, { primaryMetric: "" }, { repetitions: 0 }, { repetitions: 1.5 }, { stoppingRule: "" }, { analysisMethod: "" }, { hypothesisIds: ["missing"] }, { dataRefs: ["unregistered-data"] }, { supersedesDesignId: "missing" }]) await assert.rejects(() => o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId], ...patch }));
    assert.equal((await r.listExperimentDesigns(id)).length, 0);
  } finally { await cleanup(); }
});

test("commands cannot complete design tasks; structured refs work in the result protocol", async () => {
  const { id, orchestrator: o, repository: r, cleanup, designStage } = await fixture();
  try {
    const h = await designStage();
    const command = await o.createExperiment(id, { title: "Only a command", command: process.execPath, taskId: "d", args: ["-e", "console.log(1)"] });
    await assert.rejects(() => o.completeTask(id, "d", [command.experimentId]), /experiment-proposal/);
    await assert.rejects(() => o.executeExperiment(id, command.experimentId, { approved: true }), /approved design/);
    const d = await o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId] });
    const task = (await r.exportProject(id)).plan!.tasks.find((t) => t.taskId === "d")!;
    await o.submitTaskResult(id, { ...taskResultIdentity(task), projectId: id, taskId: "d", status: "completed", summary: "Candidate design", refs: [d.designId], claims: [], evidence: [] });
    assert.equal((await r.exportProject(id)).plan!.tasks.find((t) => t.taskId === "d")!.status, "completed");
    assert.equal((await r.readExperimentDesign(id, d.designId))!.status, "draft");
  } finally { await cleanup(); }
});

test("design and execution approvals stay separate and restart retains encrypted bindings", async () => {
  const { root, id, orchestrator: o, cleanup, designStage } = await fixture(false, true);
  try {
    const h = await designStage();
    const d = await o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId] });
    const input = { title: "Bound execution", command: process.execPath, taskId: "run", designId: d.designId, args: ["-e", "console.log(42)"] };
    await assert.rejects(() => o.createExperiment(id, input), /approved design/);
    await assert.rejects(() => o.approveExperimentDesign(id, d.designId, "stale-hash"), /changed/);
    assert.ok((await o.approveExperimentDesign(id, d.designId, d.contentHash)).approvedAt);
    const reopenedRepository = new ResearchRepository(root, { metadataPassphrase: "test-passphrase" });
    const reopened = new ResearchOrchestrator(reopenedRepository);
    const e = await reopened.createExperiment(id, input);
    assert.deepEqual(e.hypothesisIds, [h.hypothesisId]);
    assert.equal(e.designContentHash, d.contentHash);
    await reopened.completeTask(id, "d", [d.designId]);
    await reopened.startNextTask(id);
    await assert.rejects(() => reopened.createExperiment(id, { ...input, designId: undefined }), /approved design/);
    await assert.rejects(() => reopened.executeExperiment(id, e.experimentId), /explicit approval/);
    await assert.rejects(() => reopened.executeExperiment(id, e.experimentId, { approved: true }), /task requires approval/);
    await reopened.approveTask(id, "run");
    await reopened.approveExperiment(id, e.experimentId, e.proposalContentHash!);
    const run = await reopened.executeExperiment(id, e.experimentId, { approved: true });
    assert.equal(run.state, "completed");
    assert.match(run.stdout, /42/);
    await reopenedRepository.saveExperiment({ ...e, designContentHash: "wrong" });
    await assert.rejects(() => reopened.completeTask(id, "run", [run.runId]), /completed-run/);
    await reopenedRepository.saveExperiment(e);
    await reopened.completeTask(id, "run", [run.runId]);
  } finally { await cleanup(); }
});

test("revising a design creates a fresh draft and invalidates the previous approval", async () => {
  const { id, orchestrator: o, repository: r, cleanup, designStage } = await fixture();
  try {
    const h = await designStage();
    const d = await o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId] });
    await o.approveExperimentDesign(id, d.designId, d.contentHash);
    const e = await o.createExperiment(id, { title: "Old design", command: process.execPath, taskId: "d", designId: d.designId, args: ["-e", "console.log(1)"] });
    const next = await o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId], repetitions: 200, supersedesDesignId: d.designId, changeReason: "Pre-run precision review" });
    assert.notEqual(next.designId, d.designId);
    assert.equal(next.status, "draft");
    assert.equal(next.approvedAt, undefined);
    assert.equal((await r.readExperimentDesign(id, d.designId))!.status, "superseded");
    await assert.rejects(() => o.executeExperiment(id, e.experimentId, { approved: true }), /approved design/);
    await assert.rejects(() => o.completeTask(id, "d", [d.designId]), /experiment-proposal/);
  } finally { await cleanup(); }
});

test("revising a hypothesis makes the old approved design stale before launch", async () => {
  const { id, orchestrator: o, repository: r, cleanup, designStage } = await fixture(true);
  try {
    const h = await designStage();
    const d = await o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId] });
    await o.approveExperimentDesign(id, d.designId, d.contentHash);
    const e = await o.createExperiment(id, { title: "Old hypothesis", command: process.execPath, taskId: "run", designId: d.designId, args: ["-e", "console.log(1)"] });
    await o.completeTask(id, "d", [d.designId]);
    await o.startNextTask(id);
    const next = await o.createHypothesis(id, { ...hInput, scope: "MCAR at 40%", supersedesHypothesisId: h.hypothesisId, changeReason: "Updated scope from evidence review" });
    assert.equal((await r.readHypothesis(id, h.hypothesisId))!.status, "superseded");
    assert.notEqual(next.contentHash, h.contentHash);
    await assert.rejects(() => o.executeExperiment(id, e.experimentId, { approved: true }), /hypothesis binding is stale/);
    assert.equal((await r.listExperimentRuns(id)).length, 0);
  } finally { await cleanup(); }
});

test("persisted design content corruption fails closed before approval", async () => {
  const { root, id, orchestrator: o, cleanup, designStage } = await fixture();
  try {
    const h = await designStage();
    const d = await o.createExperimentDesign(id, { ...dInput, hypothesisIds: [h.hypothesisId] });
    const file = path.join(root, "projects", id, "experiment-designs", d.designId + ".json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...saved, primaryMetric: "post-hoc metric" }));
    await assert.rejects(() => o.approveExperimentDesign(id, d.designId, d.contentHash), /hash mismatch/);
  } finally { await cleanup(); }
});

test("Agent can propose hypotheses and designs but cannot forge approval or execute", async () => {
  const { id, orchestrator: o, cleanup } = await fixture();
  const bridge = await startResearchBridge(o, { runnerProjectId: id });
  const call = async (input: Record<string, unknown>) => {
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    assert.ok(Number(new URL(bridge.url).port) >= 49152);
    const h = await call({ action: "hypothesis", ...hInput });
    assert.equal(h.status, 200);
    await o.completeTask(id, "h", [h.body.hypothesisId]);
    await o.startNextTask(id);
    const d = await call({ action: "design", ...dInput, hypothesisIds: [h.body.hypothesisId], status: "approved", approvedAt: "2026-01-01", hypothesisBindings: [{ hypothesisId: "forged", contentHash: "forged" }] });
    assert.equal(d.status, 200);
    assert.equal(d.body.status, "draft");
    assert.deepEqual(d.body.hypothesisBindings, [{ hypothesisId: h.body.hypothesisId, contentHash: h.body.contentHash }]);
    for (const action of ["approve-design", "approve-experiment-design", "execute-experiment"]) assert.equal((await call({ action, designId: d.body.designId })).status, 400);
    assert.equal((await call({ action: "hypothesis", ...hInput })).status, 400);
  } finally { await bridge.close(); await cleanup(); }
});
