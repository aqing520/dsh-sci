import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { researchInspection } from "../src/research/inspect.js";
import { makeResearchHypothesis } from "../src/research/hypothesis.js";
import { makeExperimentDesign } from "../src/research/experiment-design.js";
import { startResearchBridge } from "../src/research/bridge.js";

async function fixture(encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-candidate-detail-"));
  const options = encrypted ? { metadataPassphrase: "candidate-detail-fixture-key" } : {};
  const repository = new ResearchRepository(root, options), orchestrator = new ResearchOrchestrator(repository);
  const created = await orchestrator.createProject("Read saved candidates before revision");
  const projectId = created.project.projectId, planId = created.plan.planId;
  const hypothesis = makeResearchHypothesis(projectId, { planId, taskId: "formulate-hypothesis", proposition: "候选🙂\\\"\n".repeat(700), rationale: "可检验理由".repeat(1000), scope: "Fixture only", predictions: Array.from({ length: 20 }, (_, i) => `Prediction ${i}: ${"尾部需要保留🙂".repeat(200)}`), falsifiers: ["Observed contrary direction"], alternativeExplanations: ["Finite sample fluctuation"] });
  await repository.saveHypothesis(hypothesis);
  const design = makeExperimentDesign(projectId, { planId, taskId: "design-experiment", hypothesisIds: [hypothesis.hypothesisId], hypothesisBindings: [{ hypothesisId: hypothesis.hypothesisId, contentHash: hypothesis.contentHash }], dataDescription: "完整数据说明🙂".repeat(900), dataVersion: "fixture-v1", experimentalUnit: "independent replicate", independentVariables: ["method"], dependentVariables: ["error"], controls: Array.from({ length: 30 }, (_, i) => `Control ${i}: ${"配对共享数据".repeat(200)}`), primaryMetric: "paired error", repetitions: 100, randomization: "Saved stream labels", missingDataHandling: "Observed-only fit", analysisMethod: "配对方法与限制".repeat(500), stoppingRule: "Stop at preset count" });
  await repository.saveExperimentDesign(design);
  const reopened = new ResearchRepository(root, options);
  const snapshot = await reopened.exportProject(projectId);
  return { root, repository: reopened, orchestrator: new ResearchOrchestrator(reopened), projectId, snapshot, hypothesis, design, cleanup: () => rm(root, { recursive: true, force: true }) };
}

for (const encrypted of [false, true]) test(`candidate detail reconstructs long strings, arrays and bindings without truncation (${encrypted ? "encrypted" : "plain"})`, async () => {
  const f = await fixture(encrypted);
  try {
    for (const [collection, recordId, record] of [["hypotheses", f.hypothesis.hypothesisId, f.hypothesis], ["experimentDesigns", f.design.designId, f.design]] as const) {
      const inventory = researchInspection(f.snapshot, { collection }) as any;
      const entry = inventory.records[0];
      assert.equal(entry.recordId, recordId); assert.equal(entry.contentHash, record.contentHash);
      assert.ok(JSON.stringify(entry).length < 3500); assert.ok(!entry.summary?.includes("omitted"));
      for (const field of entry.detailFields) {
        let offset: number | undefined = 0, text = "", lastEnd = 0;
        while (offset !== undefined) {
          const page = researchInspection(f.snapshot, { collection, recordId, field, offset, limit: 3 }) as any;
          assert.equal(page.contentHash, record.contentHash); assert.equal(page.currentPlan, true);
          assert.ok(page.entries.length <= 3); assert.ok(JSON.stringify(page).length < 15000);
          for (const chunk of page.entries) { assert.equal(chunk.startOffset, lastEnd); assert.ok(chunk.text.length <= 2000); text += chunk.text; lastEnd = chunk.endOffset; }
          offset = page.nextOffset;
        }
        const expected = (record as any)[field];
        assert.deepEqual(text ? JSON.parse(text) : undefined, expected);
      }
    }
    assert.deepEqual(await f.repository.exportProject(f.projectId), f.snapshot, "detail reads do not create source/code receipts, revisions, reviews or approvals");
  } finally { await f.cleanup(); }
});

test("candidate details reject unsupported fields, foreign records, invalid paging and inventory whitelist mutation", async () => {
  const f = await fixture();
  try {
    const input = { collection: "hypotheses", recordId: f.hypothesis.hypothesisId, field: "predictions" };
    for (const patch of [{ field: "__proto__" }, { field: "constructor" }, { field: "approval" }, { recordId: "foreign" }, { limit: 4 }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { recordId: undefined }]) assert.throws(() => researchInspection(f.snapshot, { ...input, ...patch }));
    const inventory = researchInspection(f.snapshot, { collection: "hypotheses" }) as any;
    inventory.records[0].detailFields.push("approval");
    assert.throws(() => researchInspection(f.snapshot, { ...input, field: "approval" }), /listed detail field/u);
    const end = researchInspection(f.snapshot, { ...input, offset: 1_000_000 }) as any;
    assert.deepEqual(end.entries, []); assert.equal(end.nextOffset, undefined);
    const absent = researchInspection(f.snapshot, { ...input, field: "changeReason" }) as any;
    assert.equal(absent.present, false); assert.equal(absent.total, 0);
    const changed = structuredClone(f.snapshot); changed.project.planId = "next-plan";
    assert.equal((researchInspection(changed, input) as any).currentPlan, false);
  } finally { await f.cleanup(); }
});

test("read-only bridge exposes exact saved candidate details only within the selected project", async () => {
  const f = await fixture();
  const bridge = await startResearchBridge(f.orchestrator, { access: "read-only", scopeProjectId: f.projectId });
  try {
    const post = async (patch: object) => {
      const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "inspect", collection: "experimentDesigns", recordId: f.design.designId, field: "hypothesisBindings", ...patch }) });
      return { status: response.status, body: await response.json() as any };
    };
    const page = await post({}); assert.equal(page.status, 200);
    assert.deepEqual(JSON.parse(page.body.entries.map((entry: any) => entry.text).join("")), f.design.hypothesisBindings);
    assert.equal((await post({ projectId: "foreign" })).status, 400);
    assert.equal((await post({ field: "environment" })).status, 400);
    assert.deepEqual(await f.repository.exportProject(f.projectId), f.snapshot);
  } finally { await bridge.close(); await f.cleanup(); }
});
