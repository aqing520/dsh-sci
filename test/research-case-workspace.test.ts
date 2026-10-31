import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
// @ts-expect-error Development case Workspace uses plain ESM.
import { registerCaseWorkspaceIpc, loadCaseWorkspace } from "../scripts/research-case-workspace-core.mjs";
// @ts-expect-error Frozen case protocol helper uses plain ESM.
import { caseProtocolBinding } from "../scripts/research-case-protocol.mjs";
// @ts-expect-error Production access registry uses plain ESM.
import { createResearchWindowRegistry, createResearchIpcRegistrar } from "../desktop/research-access.mjs";

function fixture(access = "owner") {
  const registry = createResearchWindowRegistry(), url = "data:text/html;charset=utf-8,case";
  const sender = Object.assign(new EventEmitter(), { mainFrame: { url }, isDestroyed: () => false, setWindowOpenHandler: () => undefined });
  registry.bind({ webContents: sender }, access, url);
  const event = { sender, senderFrame: sender.mainFrame };
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const dispatched: string[] = [];
  const snapshot = { project: { projectId: "p", planId: "plan" }, plan: { tasks: [{ taskId: "t", status: "waiting-approval" }] }, experiments: [{ experimentId: "e", projectId: "p", planId: "plan", proposalContentHash: "sha", approval: undefined as any }], experimentRuns: [] as any[] };
  const review = { proposalContentHash: "sha", files: [{ exists: true, truncated: false, sha256: "file" }] };
  const repository = { listProjects: async () => [snapshot.project], exportProject: async () => snapshot };
  const orchestrator = {
    experimentReview: async () => review,
    approveTask: async () => { dispatched.push("task"); },
    approveExperiment: async () => { dispatched.push("approve"); },
    executeExperiment: async () => { dispatched.push("execute"); },
  };
  registerCaseWorkspaceIpc(createResearchIpcRegistrar({ handle: (name: string, fn: (...args: any[]) => Promise<any>) => handlers.set(name, fn) }, registry), { repository, orchestrator, projectId: "p", summary: {} });
  const input = { projectId: "p", experimentId: "e", contentHash: "sha", approved: true };
  const call = (action: string, value: any = input, source = event) => handlers.get("research:" + action)!(source, value);
  return { call, input, snapshot, review, dispatched, sender, event, registry };
}

test("case owner must preview full current contents before approving or executing exact proposal", async () => {
  const f = fixture();
  await assert.rejects(f.call("approve-experiment"), /View every/u);
  await assert.rejects(f.call("execute-experiment"), /View every/u);
  await f.call("experiment-review");
  await f.call("approve-experiment");
  await assert.rejects(f.call("execute-experiment"), /Approve the exact/u);
  f.snapshot.experiments[0].approval = { proposalContentHash: "sha" };
  await f.call("execute-experiment");
  assert.deepEqual(f.dispatched, ["approve", "execute"]);
  f.snapshot.experimentRuns.push({ experimentId: "e" });
  await assert.rejects(f.call("execute-experiment"), /already has a run/u);
});

test("case scope, plan, preview completeness and stale proposal fail before mutation", async () => {
  const f = fixture();
  await assert.rejects(f.call("export", "other"), /scoped/u);
  await assert.rejects(f.call("approve", { projectId: "p", taskId: "t", planId: "old" }), /plan changed/u);
  await assert.rejects(f.call("approve-experiment", { ...f.input, projectId: "other" }), /scoped/u);
  await f.call("experiment-review");
  f.review.files[0].truncated = true;
  await assert.rejects(f.call("experiment-review"), /Full bound/u);
  await assert.rejects(f.call("approve-experiment"), /View every/u);
  f.review.files[0].truncated = false;
  await f.call("experiment-review");
  f.snapshot.experiments[0].proposalContentHash = "new";
  await assert.rejects(f.call("approve-experiment"), /Proposal changed/u);
  await assert.rejects(f.call("approve-experiment", { ...f.input, contentHash: "new" }), /View every/u);
  assert.deepEqual(f.dispatched, []);
});

test("read-only case registry rejects mutations and forged frames; preview never dispatches mutation", async () => {
  const f = fixture("read-only");
  await f.call("experiment-review");
  for (const action of ["approve", "approve-experiment", "execute-experiment"]) await assert.rejects(f.call(action), { reason: "capability" });
  await assert.rejects(f.call("experiment-review", f.input, { sender: f.sender, senderFrame: { url: f.sender.mainFrame.url } }), { reason: "authentication" });
  assert.deepEqual(f.dispatched, []);
});

test("case preview receipts belong to their sender and task approval is current-plan scoped", async () => {
  const f = fixture();
  await f.call("approve", { projectId: "p", taskId: "t", planId: "plan" });
  assert.deepEqual(f.dispatched, ["task"]);
  f.snapshot.plan.tasks[0].status = "running";
  await assert.rejects(f.call("approve", { projectId: "p", taskId: "t", planId: "plan" }), /Task or plan changed/u);
  await f.call("experiment-review");
  f.event.sender = Object.assign(new EventEmitter(), { mainFrame: { url: "data:text/html;charset=utf-8,case" }, isDestroyed: () => false, setWindowOpenHandler: () => undefined });
  await assert.rejects(f.call("approve-experiment"), { reason: "authentication" });
  f.registry.bind({ webContents: f.event.sender }, "owner", f.event.sender.mainFrame.url);
  f.event.senderFrame = f.event.sender.mainFrame;
  await assert.rejects(f.call("approve-experiment"), /View every/u);
  assert.deepEqual(f.dispatched, ["task"]);
});

test("loading an isolated case validates project/protocol/realpaths and leaves its repository unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-case-loader-"));
  try {
    const cases = path.join(root, "cases"), directory = path.join(cases, "fixture"), workspace = path.join(directory, "runtime/workspace");
    await mkdir(workspace, { recursive: true });
    const repository = new ResearchRepository(path.join(directory, "runtime/research"));
    const protocol = JSON.parse(await readFile(new URL("../research/benchmarks/imputation-v1.json", import.meta.url), "utf8"));
    const orchestrator = new ResearchOrchestrator(repository);
    const question = "Loader fixture only\n" + caseProtocolBinding(protocol);
    const created = await orchestrator.createProject(question, { plan: { question, tasks: [{ taskId: "t", title: "Fixture", objective: "No execution" }] } });
    const summaryPath = path.join(directory, "summary.json");
    await writeFile(summaryPath, JSON.stringify({ projectId: created.project.projectId }));
    await writeFile(path.join(directory, "protocol.json"), JSON.stringify(protocol));
    const before = JSON.stringify(await repository.exportProject(created.project.projectId));
    const loaded = await loadCaseWorkspace(directory, cases);
    assert.equal(loaded.projectId, created.project.projectId);
    assert.equal(JSON.stringify(await repository.exportProject(created.project.projectId)), before);
    await assert.rejects(loadCaseWorkspace(root, cases), /inside the selected/u);
    await writeFile(summaryPath, JSON.stringify({ projectId: "wrong" }));
    await assert.rejects(loadCaseWorkspace(directory, cases), /declared project/u);
    await writeFile(summaryPath, JSON.stringify({ projectId: created.project.projectId }));
    await writeFile(path.join(directory, "protocol.json"), JSON.stringify({ ...protocol, protocolVersion: 999 }));
    await assert.rejects(loadCaseWorkspace(directory, cases), /protocol|binding|hash/iu);
    await rm(workspace, { recursive: true });
    const outside = path.join(root, "outside"); await mkdir(outside);
    await symlink(outside, workspace, "junction");
    await assert.rejects(loadCaseWorkspace(directory, cases), /inside the selected/u);
    assert.equal(JSON.stringify(await repository.exportProject(created.project.projectId)), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
