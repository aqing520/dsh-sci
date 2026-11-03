import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { ResearchConversations } from "../src/research/conversation.js";
import { makeEvent } from "../src/research/domain.js";
import { makeExperimentDefinition, runExperiment } from "../src/research/experiment.js";

for (const encrypted of [false, true]) test(`deletion detaches every conversation and rejects delayed writes after restart (${encrypted ? "encrypted" : "plain"})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-delete-"));
  const options = encrypted ? { metadataPassphrase: "deletion-fixture" } : {};
  try {
    const repository = new ResearchRepository(path.join(root, "research"), options);
    const conversations = new ResearchConversations(new ResearchOrchestrator(repository));
    const signal = new AbortController().signal;
    const dispatch = (action: string, sessionId: string, args = {}) => conversations.dispatch({ action, ...args, conversation: { sessionId, cwd: root } }, signal, async () => { throw new Error("Unexpected dispatch"); });
    const begun: any = await dispatch("conversation-begin", "first", { question: "Deletion fixture" });
    await dispatch("conversation-begin", "second", { projectId: begun.projectId });
    const project = (await repository.readProject(begun.projectId))!;
    await repository.saveActiveContext({ projectId: project.projectId, taskId: "conversation" });
    await repository.deleteProject(project.projectId);
    assert.equal(await repository.readActiveContext(), undefined);
    assert.equal((await dispatch("context", "first") as any).active, false);
    assert.equal((await dispatch("context", "second") as any).active, false);
    assert.deepEqual(await readdir(path.join(repository.root, "conversations")), []);
    const restarted = new ResearchRepository(repository.root, options);
    await assert.rejects(restarted.saveProject(project), /deleted/);
    await assert.rejects(restarted.saveConversationCheckpoint(project.projectId, { summary: "late checkpoint", refs: [], at: new Date().toISOString() }), /deleted/);
    await assert.rejects(restarted.appendEvent(makeEvent(project.projectId, "task-completed")), /deleted/);
    await assert.rejects(restarted.saveActiveContext({ projectId: project.projectId, taskId: "conversation" }), /deleted/);
    assert.equal(await restarted.readProject(project.projectId), undefined);
    await assert.rejects(access(path.join(repository.root, "projects", project.projectId)), { code: "ENOENT" });
    assert.equal((await restarted.listProjects()).length, 0);
    await restarted.deleteProject(project.projectId); // Interrupted cleanup is safe to retry.
    const replacement: any = await dispatch("conversation-begin", "first", { question: "New research after deletion" });
    assert.notEqual(replacement.projectId, project.projectId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deletion waits for model settlement and cannot race a new reservation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-delete-budget-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Budget deletion fixture");
    const reservation = await repository.reserveModelRequest(project.projectId, { phase: "planner" });
    await assert.rejects(repository.deleteProject(project.projectId), /pending model/);
    assert.ok(await repository.readProject(project.projectId));
    await repository.recordModelUsage(project.projectId, reservation);
    const [deletion, request] = await Promise.allSettled([
      repository.deleteProject(project.projectId),
      new ResearchRepository(root).reserveModelRequest(project.projectId, { phase: "planner" }),
    ]);
    assert.ok(deletion.status === "rejected" || request.status === "rejected", "deletion and a live reservation cannot both succeed");
    if (request.status === "fulfilled") {
      await repository.recordModelUsage(project.projectId, request.value);
      await repository.deleteProject(project.projectId);
    }
    assert.equal(await repository.readProject(project.projectId), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live experiment blocks deletion until cancellation is durably recorded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-delete-run-"));
  const controller = new AbortController();
  try {
    const repository = new ResearchRepository(root);
    const { project } = await new ResearchOrchestrator(repository).createProject("Running deletion fixture");
    const definition = makeExperimentDefinition(project.projectId, { title: "hold", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 15000 });
    let prepared!: () => void;
    const ready = new Promise<void>((resolve) => { prepared = resolve; });
    const pending = runExperiment(definition, { signal: controller.signal, onPrepared: async (run) => { await repository.saveExperimentRun(run); prepared(); } });
    try {
      await ready;
      await assert.rejects(repository.deleteProject(project.projectId), /running experiments/);
    } finally { controller.abort(); }
    const run = await pending;
    await repository.saveExperimentRun(run);
    assert.equal(run.state, "cancelled");
    await repository.deleteProject(project.projectId);
    assert.equal(await repository.readProject(project.projectId), undefined);
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});

test("deleting one project while saving another preserves the other index entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-delete-index-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project: removed } = await orchestrator.createProject("Remove this");
    const { project: kept } = await orchestrator.createProject("Keep this");
    await Promise.all([repository.deleteProject(removed.projectId), new ResearchRepository(root).saveProject({ ...kept, title: "Updated title" })]);
    assert.deepEqual((await repository.listProjects()).map((project) => project.projectId), [kept.projectId]);
    assert.equal((await repository.listProjects())[0].title, "Updated title");
  } finally { await rm(root, { recursive: true, force: true }); }
});
