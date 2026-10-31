import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { researchInspection } from "../src/research/inspect.js";

async function fixture(encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-source-relations-"));
  const repository = new ResearchRepository(root, encrypted ? { metadataPassphrase: "source-relation-passphrase" } : {});
  const orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject("Compare source versions");
  const first = await orchestrator.addSource(project.projectId, { kind: "paper", title: "A preprint", url: "https://example.test/preprint" });
  const second = await orchestrator.addSource(project.projectId, { kind: "paper", title: "The formal paper", url: "https://example.test/paper" });
  return { root, repository, orchestrator, projectId: project.projectId, first, second, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("trusted source relations are explicit, idempotent and preserve independence semantics", async () => {
  const f = await fixture();
  try {
    const input = { fromSourceId: f.first.sourceId, toSourceId: f.second.sourceId, kind: "preprint-of" as const, countsAsIndependent: false, note: "Same study identifier and matching author list; treat as one evidence family." };
    const relation = await f.orchestrator.relateSources(f.projectId, input);
    assert.equal(relation.actor, "trusted-workspace");
    assert.equal(relation.countsAsIndependent, false);
    assert.deepEqual(await f.orchestrator.relateSources(f.projectId, input), relation);
    assert.equal((await f.repository.listSourceRelations(f.projectId)).length, 1);
    assert.equal((await f.repository.listEvents(f.projectId)).filter((event) => event.type === "source-related").length, 1);
    const report = await f.orchestrator.generateReport(f.projectId);
    assert.match(report.markdown, /Source relationships/);
    assert.match(report.markdown, /preprint-of/);
    const inventory = researchInspection(await f.repository.exportProject(f.projectId), { collection: "sourceRelations" }) as { records: Array<{ countsAsIndependent: boolean }> };
    assert.equal(inventory.records.length, 1);
    assert.equal(inventory.records[0].countsAsIndependent, false);
  } finally { await f.cleanup(); }
});

test("source relation validation rejects self, foreign and unreviewed decisions", async () => {
  const f = await fixture();
  const other = await f.orchestrator.createProject("Other project");
  try {
    await assert.rejects(() => f.orchestrator.relateSources(f.projectId, { fromSourceId: f.first.sourceId, toSourceId: f.first.sourceId, kind: "same-work", countsAsIndependent: false, note: "self" }), /itself/);
    await assert.rejects(() => f.orchestrator.relateSources(f.projectId, { fromSourceId: f.first.sourceId, toSourceId: f.second.sourceId, kind: "preprint-of", countsAsIndependent: true, note: "same work cannot be independent" }), /cannot count as independent/);
    await assert.rejects(() => f.orchestrator.relateSources(f.projectId, { fromSourceId: f.first.sourceId, toSourceId: "missing", kind: "same-work", countsAsIndependent: false, note: "missing" }), /two sources/);
    const foreign = await new ResearchOrchestrator(f.repository).addSource(other.project.projectId, { kind: "paper", title: "Foreign", url: "https://example.test/foreign" });
    await assert.rejects(() => f.orchestrator.relateSources(f.projectId, { fromSourceId: f.first.sourceId, toSourceId: foreign.sourceId, kind: "related", countsAsIndependent: true, note: "foreign" }), /two sources/);
    const bridge = await startResearchBridge(f.orchestrator, { runnerProjectId: f.projectId });
    try {
      const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "source-relation", fromSourceId: f.first.sourceId, toSourceId: f.second.sourceId, kind: "same-work", countsAsIndependent: false, note: "agent attempt" }) });
      assert.equal(response.status, 400);
    } finally { await bridge.close(); }
  } finally { await f.cleanup(); }
});

test("encrypted restart preserves reviewed source relations", async () => {
  const f = await fixture(true);
  try {
    const relation = await f.orchestrator.relateSources(f.projectId, { fromSourceId: f.first.sourceId, toSourceId: f.second.sourceId, kind: "version-of", countsAsIndependent: false, note: "Formal version supersedes the preprint." });
    const reopened = new ResearchRepository(f.root, { metadataPassphrase: "source-relation-passphrase" });
    assert.deepEqual(await reopened.readSourceRelation(f.projectId, relation.relationId), relation);
    assert.equal((await reopened.exportProject(f.projectId)).sourceRelations?.length, 1);
  } finally { await f.cleanup(); }
});
