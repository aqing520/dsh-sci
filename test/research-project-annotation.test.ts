import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";

for (const encrypted of [false, true]) test(`personal research annotations persist without overwriting research (${encrypted ? "encrypted" : "plain"})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-annotation-"));
  const options = { metadataPassphrase: encrypted ? "annotation-fixture-passphrase" : undefined };
  try {
    const repository = new ResearchRepository(root, options);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Original research question");
    const before = await repository.exportProject(project.projectId);
    assert.equal(await repository.readProjectAnnotation(project.projectId), undefined);
    const input = { revision: 0, title: "My title", description: "My scope", notes: "Personal notes\nA second line" };
    const saved = await repository.saveProjectAnnotation(project.projectId, input);
    assert.equal(saved.revision, 1);
    const restarted = new ResearchRepository(root, options);
    assert.deepEqual(await restarted.readProjectAnnotation(project.projectId), saved);
    const after = await restarted.exportProject(project.projectId);
    assert.deepEqual({ ...after, annotation: undefined }, before);
    assert.deepEqual(after.annotation, saved);
    if (encrypted) assert.doesNotMatch(await readFile(path.join(root, "projects", project.projectId, "annotation.json"), "utf8"), /Personal notes/);
    const writes = await Promise.allSettled([
      repository.saveProjectAnnotation(project.projectId, { ...input, revision: 1, title: "First window" }),
      restarted.saveProjectAnnotation(project.projectId, { ...input, revision: 1, title: "Second window" }),
    ]);
    assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(writes.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await repository.readProjectAnnotation(project.projectId))?.revision, 2);
    await assert.rejects(repository.saveProjectAnnotation(project.projectId, { ...input, revision: 2, title: " " }), /Invalid annotation title/);
    await repository.deleteProject(project.projectId);
    await assert.rejects(restarted.saveProjectAnnotation(project.projectId, { ...input, revision: 2 }), /deleted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
