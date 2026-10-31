import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { DshResearchTaskExecutor, type DshSdkClient } from "../src/research/dsh-sdk.js";
import { taskResultIdentity } from "../src/research/task-result.js";

test("SDK asks the model to correct a mistyped bundle ID while preserving its saved static review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-ref-repair-review-"));
  try {
    const repository = new ResearchRepository(root), orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Read and inspect candidate", { plan: { question: "Read and inspect candidate", tasks: [
      { taskId: "prepare", title: "Prepare", objective: "Save candidate", kind: "code-preparation" },
      { taskId: "review", title: "Review", objective: "Read and record limitations", kind: "code-review", dependsOn: ["prepare"] },
    ] } });
    await orchestrator.activatePlan(project.projectId); await orchestrator.startNextTask(project.projectId);
    const bundle = await orchestrator.stageCode(project.projectId, { files: [{ name: "run.mjs", kind: "code", content: "export const candidate = 1;\n" }] });
    await orchestrator.completeTask(project.projectId, "prepare", [bundle.bundleId]);
    const context = await orchestrator.startNextTask(project.projectId);
    await orchestrator.readCode(project.projectId, { bundleId: bundle.bundleId, fileName: "run.mjs" });
    const review = await orchestrator.reviewCode(project.projectId, { bundleId: bundle.bundleId, summary: "Static inspection only", findings: [], limitations: ["No execution, correctness acceptance or human review"] });
    const base = { ...taskResultIdentity(context.task!), projectId: project.projectId, taskId: "review", status: "completed", summary: "Static review recorded with limitations", refs: [review.codeReviewId, "bundle-mistyped"], claims: [], evidence: [] };
    let assistant = JSON.stringify(base), prompts = 0;
    const client: DshSdkClient = {
      async initialize() {}, async createSession() {}, async resume() {}, async wait() {}, async close() {},
      async prompt(_session, text) {
        if (++prompts === 2) {
          assert.match(text, /unregistered record IDs at indexes \[1\]/);
          assert.ok(text.includes(review.codeReviewId) && text.includes(bundle.bundleId));
          assert.ok(!text.includes("bundle-mistyped"), "untrusted invalid refs are not quoted into repair instructions");
          assert.equal((await repository.exportProject(project.projectId)).plan!.tasks[1].status, "running");
          assistant = JSON.stringify({ ...base, refs: [review.codeReviewId, bundle.bundleId] });
        }
        return { messageId: String(prompts) };
      },
      lastAssistantText() { return assistant; },
    };
    const result = await new DshResearchTaskExecutor({ client, repository }).execute(context as any);
    const beforeSubmit = await repository.exportProject(project.projectId);
    assert.equal(beforeSubmit.codeReviews!.length, 1); assert.equal(beforeSubmit.plan!.tasks[1].status, "running");
    assert.deepEqual(result.refs, [review.codeReviewId, bundle.bundleId]);
    await orchestrator.submitTaskResult(project.projectId, result);
    const final = await repository.exportProject(project.projectId);
    assert.equal(prompts, 2); assert.equal(final.project.status, "completed");
    assert.equal(final.plan!.tasks[1].attempts, 1); assert.equal(final.codeReviews!.length, 1);
    assert.equal(final.events.filter((event) => event.type === "task-completed" && event.taskId === "review").length, 1);
    const repairs = final.events.filter((event) => event.type === "task-result-repair-requested");
    assert.equal(repairs.length, 1); assert.equal(repairs[0].data?.reason, "unregistered-result-references");
    assert.equal(final.experimentRuns.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SDK reconnect and a new executor cannot reset the persisted one-repair limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-ref-repair-reconnect-"));
  try {
    const repository = new ResearchRepository(root), orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Keep the repair bound across a transport failure", { plan: { question: "Keep the repair bound", tasks: [{ taskId: "task", title: "Task", objective: "Return a registered ref", kind: "custom" }] } });
    await orchestrator.activatePlan(project.projectId);
    const context = await orchestrator.startNextTask(project.projectId);
    let prompts = 0, reconnects = 0;
    const assistant = JSON.stringify({ ...taskResultIdentity(context.task!), projectId: project.projectId, taskId: "task", status: "completed", summary: "Unregistered ref", refs: ["missing-record"], claims: [], evidence: [] });
    const client: DshSdkClient = {
      async initialize() {}, async createSession() {}, async resume() {}, async wait() {}, async close() {},
      async prompt() { if (++prompts === 2) throw new Error("SDK child process exited during repair"); return { messageId: String(prompts) }; },
      lastAssistantText() { return assistant; },
    };
    await assert.rejects(new DshResearchTaskExecutor({ client, repository, reconnect: async () => { reconnects++; return client; } }).execute(context as any), /repair limit reached/);
    assert.equal(reconnects, 1); assert.equal(prompts, 3, "only the initial repaired turn and one resumed original turn");
    await assert.rejects(new DshResearchTaskExecutor({ client, repository: new ResearchRepository(root) }).execute(context as any), /repair limit reached/);
    assert.equal(prompts, 4, "a new executor may read the result but cannot request another repair");
    const snapshot = await repository.exportProject(project.projectId);
    assert.equal(snapshot.events.filter((event) => event.type === "task-result-repair-requested").length, 1);
    assert.equal(snapshot.plan!.tasks[0].status, "running"); assert.equal(snapshot.plan!.tasks[0].attempts, 1);
    assert.equal(snapshot.events.filter((event) => event.type === "task-completed").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reference correction is bounded, project-scoped, cancellation-aware and cannot manufacture required outputs", async (t) => {
  for (const scenario of ["still-wrong", "foreign-memory", "paused", "cancelled", "identity-and-refs", "missing-output"] as const) await t.test(scenario, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-ref-repair-bound-"));
    try {
      const repository = new ResearchRepository(root), orchestrator = new ResearchOrchestrator(repository);
      const { project } = await orchestrator.createProject("Bounded reference correction", { plan: { question: "Bounded reference correction", tasks: [{ taskId: "task", title: "Task", objective: "Save the required artifact", kind: scenario === "missing-output" ? "code-preparation" : "custom" }] } });
      const foreign = await orchestrator.createProject("Other research project");
      const foreignMemory = await orchestrator.remember(foreign.project.projectId, { text: "Private research memory", kind: "note", confidence: "high" });
      await orchestrator.activatePlan(project.projectId);
      const context = await orchestrator.startNextTask(project.projectId);
      const controller = new AbortController();
      const base = { ...taskResultIdentity(context.task!), projectId: project.projectId, taskId: "task", status: "completed", summary: "Candidate result", refs: [scenario === "foreign-memory" ? foreignMemory.memoryId : "unregistered-private-value"], claims: [], evidence: [] };
      let assistant = JSON.stringify({ ...base, ...(scenario === "identity-and-refs" ? { attemptId: "wrong-attempt" } : {}) }), prompts = 0;
      const client: DshSdkClient = {
        async initialize() {}, async createSession() {}, async resume() {}, async close() {},
        async prompt(_session, text) {
          if (++prompts === 2) {
            assert.ok(!text.includes(foreignMemory.memoryId));
            assert.ok(!text.includes("unregistered-private-value"));
            if (["identity-and-refs", "missing-output"].includes(scenario)) assistant = JSON.stringify({ ...base, refs: [] });
          }
          return { messageId: String(prompts) };
        },
        async wait() { if (scenario === "paused") await orchestrator.pause(project.projectId); if (scenario === "cancelled") controller.abort(new Error("cancelled")); },
        lastAssistantText() { return assistant; },
      };
      const execution = new DshResearchTaskExecutor({ client, repository }).execute(context as any, controller.signal);
      if (scenario === "identity-and-refs") await orchestrator.submitTaskResult(project.projectId, await execution);
      else if (scenario === "missing-output") await assert.rejects(orchestrator.submitTaskResult(project.projectId, await execution), /missing required outputs: code-bundle/);
      else await assert.rejects(execution, scenario === "paused" ? /superseded|state changed/ : scenario === "cancelled" ? /cancelled/ : /unregistered output references/);
      const snapshot = await repository.exportProject(project.projectId);
      assert.equal(prompts, ["paused", "cancelled"].includes(scenario) ? 1 : 2);
      assert.equal(snapshot.events.filter((event) => event.type === "task-result-repair-requested").length, ["paused", "cancelled"].includes(scenario) ? 0 : 1);
      assert.equal(snapshot.plan!.tasks[0].attempts, 1);
      assert.equal(snapshot.plan!.tasks[0].status, scenario === "identity-and-refs" ? "completed" : "running");
      assert.equal(snapshot.claims.length, 0); assert.equal(snapshot.experimentRuns.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
