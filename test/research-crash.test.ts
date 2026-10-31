import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { makeExperimentDefinition, runExperiment, type ExperimentRun } from "../src/research/experiment.js";
import { ResearchRunner } from "../src/research/runner.js";

test("experiment launch waits for durable preparation and never starts after a journal failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-start-journal-"));
  try {
    const definition = makeExperimentDefinition("project", { title: "Must not run", command: process.execPath, args: ["-e", "require('fs').writeFileSync('launched.txt','bad')"], cwd: root });
    await assert.rejects(() => runExperiment(definition, { onPrepared: async (run) => {
      assert.equal(run.state, "running");
      assert.equal(run.processId, undefined);
      assert.equal(run.manifest.command, process.execPath);
      throw new Error("Journal unavailable");
    } }), /Journal unavailable/);
    await assert.rejects(() => access(path.join(root, "launched.txt")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup interruption recovery is idempotent, preserves evidence, and blocks automatic reuse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-startup-recover-"));
  try {
    const repository = new ResearchRepository(root, { metadataPassphrase: "fixture-only-passphrase" });
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Recover a journaled experiment");
    const experiment = await orchestrator.createExperiment(project.projectId, { title: "Unconfirmed", command: process.execPath });
    const run: ExperimentRun = { schema: "dsh-sci.experiment-run.v1", runId: "unfinished", projectId: project.projectId, experimentId: experiment.experimentId, state: "running", startedAt: new Date().toISOString(), processId: process.pid, stdout: "", stderr: "", truncated: false, manifest: { schema: "dsh-sci.experiment-manifest.v1", command: process.execPath, args: [], environment: {}, inputs: [], outputs: [] } };
    await repository.saveExperimentRun(run);
    await orchestrator.remember(project.projectId, { text: "Confirmed evidence survives the crash", kind: "note" });
    const reopened = new ResearchRepository(root, { metadataPassphrase: "fixture-only-passphrase" });
    assert.equal((await reopened.recoverInterruptedExperiments()).length, 1);
    assert.deepEqual(await reopened.recoverInterruptedExperiments(), []);
    assert.equal((await reopened.readProject(project.projectId))?.status, "paused");
    assert.equal((await reopened.readExperimentRun(project.projectId, run.runId))?.state, "interrupted");
    assert.equal((await reopened.listEvents(project.projectId)).filter((event) => event.type === "experiment-interrupted").length, 1);
    const next = new ResearchOrchestrator(reopened);
    const runner = await new ResearchRunner(next).run(project.projectId, { execute: async () => { throw new Error("Paused project must not invoke its executor"); } }, { autoActivate: false });
    assert.equal(runner.status, "blocked");
    assert.equal((await next.searchMemory("Confirmed evidence")).length, 1);
    await next.resume(project.projectId);
    await assert.rejects(() => next.executeExperiment(project.projectId, experiment.experimentId, { approved: true }), /unfinished execution/);
    await assert.rejects(() => next.recordEvaluation(project.projectId, { experimentRunIds: [run.runId], metrics: [], conclusion: "supports", summary: "Unverified" }), /no confirmed terminal result/);
    assert.ok((await next.generateReport(project.projectId)).warnings.some((warning) => warning.includes("no confirmed terminal result")));
    // A recorded PID can be reused. Recovery updates records without killing it.
    assert.equal(process.kill(process.pid, 0), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery can resume after interruption between its audit and terminal record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-recovery-commit-"));
  try {
    const repository = new ResearchRepository(root);
    const { project } = await new ResearchOrchestrator(repository).createProject("Recover a partial recovery");
    const run: ExperimentRun = { schema: "dsh-sci.experiment-run.v1", runId: "one", projectId: project.projectId, experimentId: "experiment", state: "running", startedAt: new Date().toISOString(), stdout: "", stderr: "", truncated: false, manifest: { schema: "dsh-sci.experiment-manifest.v1", command: "node", args: [], environment: {}, inputs: [], outputs: [] } };
    await repository.saveExperimentRun(run);
    const save = repository.saveExperimentRun.bind(repository);
    repository.saveExperimentRun = async () => { throw new Error("Simulated recovery interruption"); };
    await assert.rejects(() => repository.recoverInterruptedExperiments(), /Simulated recovery interruption/);
    repository.saveExperimentRun = save;
    await repository.recoverInterruptedExperiments();
    assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "experiment-interrupted").length, 1);
    assert.equal((await repository.readExperimentRun(project.projectId, run.runId))?.state, "interrupted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("graceful experiment shutdown saves a single terminal record after the launch journal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-experiment-shutdown-"));
  try {
    const repository = new ResearchRepository(path.join(root, "store"));
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Cancel before application exit");
    const experiment = await orchestrator.createExperiment(project.projectId, { title: "Long task", command: process.execPath, args: ["-e", "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"], cwd: root });
    await orchestrator.approveExperiment(project.projectId, experiment.experimentId, experiment.proposalContentHash!);
    const operation = orchestrator.executeExperiment(project.projectId, experiment.experimentId, { approved: true });
    try {
      const deadline = Date.now() + 5000;
      while (true) { try { await access(path.join(root, "started")); break; } catch { if (Date.now() > deadline) throw new Error("Experiment did not start"); await delay(25); } }
      const runs = await repository.listExperimentRuns(project.projectId);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].state, "running");
      await orchestrator.cancelRunningExperiments();
      const result = await operation;
      assert.equal(result.state, "cancelled");
      assert.equal((await repository.listExperimentRuns(project.projectId)).length, 1);
      assert.equal((await repository.readExperimentRun(project.projectId, result.runId))?.state, "cancelled");
      assert.equal(await readFile(path.join(root, "started"), "utf8"), "yes");
    } finally { await orchestrator.cancelRunningExperiments(); await operation.catch(() => undefined); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
