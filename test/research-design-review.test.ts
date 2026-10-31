import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { makeResearchHypothesis } from "../src/research/hypothesis.js";

const criteria = { hypothesisTestable: true, analysisUnitMatchesDesign: true, controlsAndComparisonAreAdequate: true, primaryMetricPreSpecified: true, repetitionCountJustified: true, analysisMethodAppropriate: true, stoppingRulePreSpecified: true };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-design-review-"));
  const repository = new ResearchRepository(root, { metadataPassphrase: "design-review-passphrase" });
  const orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject("Review an experiment design", { plan: { question: "Review an experiment design", tasks: [{ taskId: "h", title: "Hypothesis", objective: "Make a falsifiable hypothesis", kind: "hypothesis" }, { taskId: "d", title: "Design", objective: "Make a design", kind: "experiment-design", dependsOn: ["h"] }] } });
  await orchestrator.activatePlan(project.projectId); await orchestrator.startNextTask(project.projectId);
  const hypothesis = await orchestrator.createHypothesis(project.projectId, { proposition: "Median improves MAE", scope: "Fixed data", predictions: ["Paired difference is negative"], falsifiers: ["Interval favors mean"], alternativeExplanations: ["Sampling variation"] });
  await orchestrator.completeTask(project.projectId, "h", [hypothesis.hypothesisId]); await orchestrator.startNextTask(project.projectId);
  const design = await orchestrator.createExperimentDesign(project.projectId, { taskId: "d", hypothesisIds: [hypothesis.hypothesisId], dataDescription: "Fixed data", dataVersion: "v1", experimentalUnit: "paired replicate", independentVariables: ["method"], dependentVariables: ["MAE"], controls: ["same mask"], primaryMetric: "paired MAE difference", repetitions: 100, randomization: "fixed seeds", missingDataHandling: "same mask", analysisMethod: "paired bootstrap", stoppingRule: "all repetitions", randomSeed: 5 });
  return { root, repository, orchestrator, projectId: project.projectId, hypothesis, design, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("design quality review is separate from approval and binds the exact design hash", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, { contentHash: "0".repeat(64), criteria, status: "accepted", note: "Stale Workspace view" }), /refresh before review/);
    await assert.rejects(() => f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, { contentHash: f.design.contentHash, criteria: { ...criteria, repetitionCountJustified: false }, status: "accepted", note: "Cannot accept an unjustified repetition count" }), /every quality criterion/);
    assert.equal((await f.repository.listDesignReviews(f.projectId)).length, 0);
    const requested = await f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, { contentHash: f.design.contentHash, criteria: { ...criteria, repetitionCountJustified: false }, status: "changes-requested", note: "Provide a precision or power rationale for 100 repetitions." });
    assert.equal(requested.actor, "trusted-workspace");
    assert.equal((await f.repository.readExperimentDesign(f.projectId, f.design.designId))!.status, "draft");
    const input = { contentHash: f.design.contentHash, criteria, status: "accepted" as const, note: "Paired replicate, prespecified endpoint and fixed stopping rule are appropriate for this design." };
    const accepted = await f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, input);
    assert.deepEqual(await f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, input), accepted);
    assert.equal((await f.repository.listEvents(f.projectId)).filter((event) => event.type === "design-reviewed").length, 2);
    await assert.rejects(() => f.repository.saveDesignReview({ ...accepted, reviewedAt: "2025-01-01T00:00:00.000Z" }), /immutable/);
    assert.equal(accepted.designContentHash, f.design.contentHash);
    assert.equal((await f.orchestrator.currentExperimentDesignReview(f.projectId, f.design.designId)).reviews.at(-1)!.current, true);
    await f.orchestrator.approveExperimentDesign(f.projectId, f.design.designId, f.design.contentHash);
    assert.equal((await f.repository.listDesignReviews(f.projectId)).length, 2);
  } finally { await f.cleanup(); }
});

test("design review cannot be written by the Agent bridge and stale reviews are marked", async () => {
  const f = await fixture();
  const bridge = await startResearchBridge(f.orchestrator, { runnerProjectId: f.projectId });
  try {
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "design-review", designId: f.design.designId, criteria, status: "accepted", note: "forged" }) });
    assert.equal(response.status, 400);
    await f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, { contentHash: f.design.contentHash, criteria, status: "accepted", note: "Review before revision." });
    const next = await f.orchestrator.createExperimentDesign(f.projectId, { taskId: "d", hypothesisIds: f.design.hypothesisIds, dataDescription: f.design.dataDescription, dataVersion: "v2", experimentalUnit: f.design.experimentalUnit, independentVariables: f.design.independentVariables, dependentVariables: f.design.dependentVariables, controls: f.design.controls, primaryMetric: f.design.primaryMetric, repetitions: f.design.repetitions, randomization: f.design.randomization, missingDataHandling: f.design.missingDataHandling, analysisMethod: f.design.analysisMethod, stoppingRule: f.design.stoppingRule, supersedesDesignId: f.design.designId, changeReason: "Updated data version" });
    assert.equal((await f.orchestrator.currentExperimentDesignReview(f.projectId, f.design.designId)).reviews[0].current, false);
    assert.equal(next.status, "draft");
    // Simulate interruption after saving the successor but before marking the old design.
    await f.repository.saveExperimentDesign(f.design);
    await assert.rejects(() => f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, { contentHash: f.design.contentHash, criteria, status: "accepted", note: "Must not review a superseded design" }), /current design/);
    assert.equal((await f.orchestrator.currentExperimentDesignReview(f.projectId, f.design.designId)).reviews[0].current, false);
  } finally { await bridge.close(); await f.cleanup(); }
});

test("encrypted restart retains design quality reviews", async () => {
  const f = await fixture();
  try {
    const review = await f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, { contentHash: f.design.contentHash, criteria, status: "accepted", note: "Retained review." });
    const reopened = new ResearchRepository(f.root, { metadataPassphrase: "design-review-passphrase" });
    assert.deepEqual(await reopened.readDesignReview(f.projectId, review.reviewId), review);
  } finally { await f.cleanup(); }
});

test("a revised hypothesis invalidates design quality review even before the old hypothesis status is updated", async () => {
  const f = await fixture();
  try {
    const input = { contentHash: f.design.contentHash, criteria, status: "accepted" as const, note: "Review of the original hypothesis." };
    await f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, input);
    const next = makeResearchHypothesis(f.projectId, { ...f.hypothesis, scope: "Changed scope", supersedesHypothesisId: f.hypothesis.hypothesisId, changeReason: "New evidence changes the hypothesis scope" });
    await f.repository.saveHypothesis(next);
    assert.equal((await f.orchestrator.currentExperimentDesignReview(f.projectId, f.design.designId)).reviews[0].current, false);
    await assert.rejects(() => f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, input), /hypothesis binding is stale/);
    assert.equal((await f.repository.listDesignReviews(f.projectId)).length, 1);
  } finally { await f.cleanup(); }
});

test("switching the project plan invalidates old design reviews and rejects new reviews against them", async () => {
  const f = await fixture();
  try {
    const input = { contentHash: f.design.contentHash, criteria, status: "accepted" as const, note: "Review in the original plan." };
    await f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, input);
    const project = (await f.repository.readProject(f.projectId))!;
    await f.repository.saveProject({ ...project, planId: "replacement-plan" });
    assert.equal((await f.orchestrator.currentExperimentDesignReview(f.projectId, f.design.designId)).reviews[0].current, false);
    await assert.rejects(() => f.orchestrator.reviewExperimentDesign(f.projectId, f.design.designId, input), /current design/);
    assert.equal((await f.repository.listDesignReviews(f.projectId)).length, 1);
  } finally { await f.cleanup(); }
});
