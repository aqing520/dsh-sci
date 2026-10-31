import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { contentDigest } from "../src/research/content-digest.js";
import { planCommitHash, validatePlanCommit, type ResearchPlanCommit } from "../src/research/plan-commit.js";
import { ResearchStaleExecutionError } from "../src/research/result-commit.js";
import { isEncryptedMetadataText } from "../src/metadata-crypto.js";
import { researchInspection } from "../src/research/inspect.js";
import type { ResearchPlanInput } from "../src/research/domain.js";
import type { ResearchPlanner } from "../src/research/planner.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { validateTaskCompletion } from "../src/research/task-contract.js";

const input: ResearchPlanInput = { question: "Synthetic decision reliability fixture", tasks: [{ taskId: "evaluate", title: "Evaluate", objective: "Check synthetic metrics", kind: "evaluate" }], constraints: { maxIterations: 2 } };
const limits = { maxTaskExecutions: 10, maxWallTimeMs: 60_000, maxModelRequests: 10, maxModelTokens: 10_000 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(operation: (root: string, repo: ResearchRepository, orch: ResearchOrchestrator, projectId: string) => Promise<void>, planner: ResearchPlanner = { name: "fixture", async plan() { return input; } }, encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-decision-"));
  const repo = new ResearchRepository(root, encrypted ? { metadataPassphrase: "decision-fixture-passphrase" } : {});
  const orch = new ResearchOrchestrator(repo, {}, planner, { strictPlanning: true });
  try {
    const { project, plan } = await orch.createProject(input.question, { plan: input, budget: limits });
    await repo.savePlan({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: "completed" })) });
    await orch.recordEvaluation(project.projectId, { taskId: "evaluate", metrics: [], conclusion: "inconclusive", summary: "Synthetic data require further study" });
    await operation(root, repo, orch, project.projectId);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("concurrent decisions across orchestrator instances share one metered replan and keep iteration bounds", { timeout: 10_000 }, async () => {
  let calls = 0;
  const entered = deferred(), release = deferred();
  const planner: ResearchPlanner = { name: "accounted-fixture", async plan(_question, _signal, accounting) {
    calls++;
    const id = await accounting!.reserve();
    entered.resolve(); await release.promise;
    await accounting!.settle(id, { totalTokens: 20 });
    return { ...input, constraints: { maxIterations: 100 } };
  } };
  await fixture(async (root, repo, orch, id) => {
    const oldPlanId = (await repo.readProject(id))!.planId!;
    const first = orch.decideIteration(id);
    await entered.promise;
    const second = new ResearchOrchestrator(new ResearchRepository(root), {}, planner).decideIteration(id);
    assert.equal(first, second);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.record?.decisionId, b.record?.decisionId);
    assert.equal(calls, 1);
    assert.equal(a.decision, "iterate");
    assert.equal(a.result?.project.iteration, 1);
    assert.equal(a.result?.plan.constraints.maxIterations, 2);
    assert.equal(a.result?.plan.version, 2);
    assert.equal(a.record?.planId, oldPlanId);
    assert.equal(a.record?.resultPlanId, a.result?.plan.planId);
    assert.equal(a.record?.evaluationContentHash, contentDigest(a.evaluation));
    assert.equal(a.record?.remainingBudget?.modelRequests, 9);
    assert.equal(((await repo.readBudget(id)) as any)?.usedModelRequests, 1);
    const exported = await repo.exportProject(id);
    assert.equal(exported.decisions?.length, 1);
    assert.equal(exported.events.filter((event) => event.type === "iteration-started").length, 1);
    const preview = researchInspection(exported, { collection: "decisions" }) as any;
    assert.equal(preview.records[0].evaluationContentHash, a.record?.evaluationContentHash);
    assert.equal(preview.records[0].contextHash, a.record?.contextHash);
  }, planner);
});

for (const change of ["pause", "evaluation", "conflict", "task-state", "budget-limit"] as const) test(`replanning rejects a stale decision after concurrent ${change}`, async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  await fixture(async (root, repo, orch, id) => {
    const old = (await repo.readProject(id))!;
    const pending = orch.decideIteration(id);
    const rejected = assert.rejects(pending, ResearchStaleExecutionError);
    await entered.promise;
    const other = new ResearchOrchestrator(new ResearchRepository(root));
    if (change === "pause") await other.pause(id);
    if (change === "evaluation") await other.recordEvaluation(id, { metrics: [], conclusion: "supports", summary: "A new synthetic assessment supersedes the old one" });
    if (change === "conflict") {
      await other.remember(id, { kind: "claim", text: "Synthetic claim A", conflictKey: "fixture" });
      await other.remember(id, { kind: "claim", text: "Synthetic claim B", conflictKey: "fixture" });
    }
    if (change === "task-state") {
      // A task-only write deliberately leaves the project timestamp unchanged.
      const plan = (await repo.readPlan(id, old.planId!))!;
      await repo.savePlan({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, summary: "Concurrent task edit" })) });
    }
    if (change === "budget-limit") await other.updateBudget(id, { ...limits, maxModelRequests: 20 });
    release.resolve(); await rejected;
    assert.equal((await repo.readProject(id))?.planId, old.planId);
    assert.equal((await repo.listDecisions(id)).length, 0);
    assert.equal(calls, 1);
  }, { name: "deferred-fixture", async plan() { calls++; entered.resolve(); await release.promise; return input; } });
});

test("manual replan also rejects task-only mutations while its planner is pending", async () => {
  const entered = deferred(), release = deferred();
  await fixture(async (_root, repo, orch, id) => {
    const pending = orch.replan(id), rejected = assert.rejects(pending, ResearchStaleExecutionError);
    await entered.promise;
    const project = (await repo.readProject(id))!, plan = (await repo.readPlan(id, project.planId!))!;
    await repo.savePlan({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, summary: "Changed independently" })) });
    release.resolve(); await rejected;
    assert.equal((await repo.readProject(id))?.planId, project.planId);
  }, { name: "deferred-manual", async plan() { entered.resolve(); await release.promise; return input; } });
});

for (const legacy of [false, true]) test(`current plan never reuses ${legacy ? "unbound legacy" : "previous-plan"} evaluation with the same task ID`, async () => fixture(async (_root, repo, orch, id) => {
  const oldEvaluation = (await repo.listEvaluations(id))[0];
  await orch.replan(id);
  const project = (await repo.readProject(id))!, plan = (await repo.readPlan(id, project.planId!))!;
  await repo.savePlan({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: "completed" })) });
  if (legacy) await repo.saveEvaluation({ ...oldEvaluation, planId: undefined, conclusion: "supports" });
  const result = await orch.decideIteration(id);
  assert.equal(result.decision, "review"); assert.match(result.reason, /current plan/);
  await assert.rejects(() => orch.recordEvaluation(id, { planId: oldEvaluation.planId, taskId: "evaluate", metrics: [], conclusion: "supports", summary: "Stale submission" }), ResearchStaleExecutionError);
  const current = await orch.recordEvaluation(id, { taskId: "evaluate", metrics: [], conclusion: "supports", summary: "Current plan assessment" });
  assert.equal(current.planId, plan.planId);
  assert.equal((await orch.decideIteration(id)).decision, "stop");
}));

for (const state of ["pending", "skipped", "small-sample"] as const) test(`supports requires review for ${state} evaluation`, async () => fixture(async (_root, repo, orch, id) => {
  const project = (await repo.readProject(id))!, plan = (await repo.readPlan(id, project.planId!))!;
  if (state !== "small-sample") await repo.savePlan({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: state })) });
  const metrics = state === "small-sample" ? [{ name: "Eight synthetic pairs", pairedBootstrap: { differences: Array(8).fill(1), seed: 42, resamples: 1000, direction: "positive" as const, practicalRelativeThreshold: 0.02 } }] : [];
  // The conclusion label alone cannot bypass the kernel's applicability gate.
  await orch.recordEvaluation(id, { metrics, conclusion: "supports", summary: "Synthetic proposed support" });
  assert.equal((await orch.decideIteration(id)).decision, "review");
  await assert.rejects(() => orch.iterate(id, "Must not bypass review"), /evaluation|review gates/);
}));

test("budget exhaustion pauses instead of stopping and repeated reviews are idempotent", async () => fixture(async (_root, repo, orch, id) => {
  await repo.mutateBudget(id, (budget) => ({ ...budget!, usedTaskExecutions: budget!.maxTaskExecutions, startedAt: budget!.startedAt ?? new Date().toISOString() }));
  const first = await orch.decideIteration(id), second = await orch.decideIteration(id);
  assert.equal(first.decision, "review"); assert.match(first.reason, /exhausted/);
  assert.equal((await repo.readProject(id))?.status, "paused");
  assert.equal(first.record?.decisionId, second.record?.decisionId);
  assert.equal((await repo.listDecisions(id)).length, 1);
  assert.equal((await repo.listEvents(id, 10_000)).filter((event) => event.type === "decision-recorded").length, 1);
}));

test("evaluation task completion rejects old-plan and unbound legacy output records", async () => fixture(async (_root, repo, orch, id) => {
  const historical = (await repo.listEvaluations(id))[0];
  await orch.replan(id);
  const snapshot = await repo.exportProject(id), task = snapshot.plan!.tasks[0];
  assert.throws(() => validateTaskCompletion(snapshot, task, [historical.evaluationId]), /evaluation/);
  snapshot.evaluations = [{ ...historical, planId: undefined }];
  assert.throws(() => validateTaskCompletion(snapshot, task, [historical.evaluationId]), /evaluation/);
  const current = await orch.recordEvaluation(id, { taskId: task.taskId, metrics: [], conclusion: "inconclusive", summary: "Current synthetic evaluation" });
  assert.doesNotThrow(() => validateTaskCompletion({ ...snapshot, evaluations: [current] }, task, [current.evaluationId]));
}));

test("repeated stop survives an interrupted event write without duplicating the decision", async () => fixture(async (_root, repo, orch, id) => {
  await orch.recordEvaluation(id, { metrics: [], conclusion: "supports", summary: "Synthetic support" });
  const append = repo.appendEvent.bind(repo); let fail = true;
  repo.appendEvent = async (event) => { if (event.type === "decision-recorded" && fail) { fail = false; throw new Error("event failure"); } await append(event); };
  await assert.rejects(() => orch.decideIteration(id), /event failure/);
  const first = await orch.decideIteration(id), second = await orch.decideIteration(id);
  assert.equal(first.decision, "stop"); assert.equal(first.record?.decisionId, second.record?.decisionId);
  assert.equal((await repo.listDecisions(id)).length, 1);
  assert.equal((await repo.listEvents(id, 10_000)).filter((event) => event.type === "decision-recorded").length, 1);
}));

test("manual iteration journals its evaluation-bound decision and rejects skipped evaluations", async () => fixture(async (_root, repo, orch, id) => {
  const result = await orch.iterate(id, "Synthetic result needs revision");
  assert.equal(result.project.iteration, 1);
  const decisions = await repo.listDecisions(id);
  assert.equal(decisions.length, 1); assert.equal(decisions[0].resultPlanId, result.plan.planId);
  assert.ok(decisions[0].evaluationContentHash);
}));

for (const encrypted of [false, true]) test(`failed planning without an existing plan can recover (${encrypted ? "encrypted" : "plain"})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-first-replan-"));
  const repo = new ResearchRepository(root, encrypted ? { metadataPassphrase: "decision-fixture-passphrase" } : {});
  let calls = 0;
  const orch = new ResearchOrchestrator(repo, {}, { name: "fail-once", async plan() { if (++calls === 1) throw new Error("upstream timeout"); return input; } }, { strictPlanning: true });
  try {
    await assert.rejects(() => orch.createProject(input.question, { budget: limits }), /upstream timeout/);
    const [project] = await repo.listProjects();
    assert.equal(project.planId, undefined); assert.equal(project.status, "paused");
    const recovered = await orch.replan(project.projectId);
    assert.equal(recovered.project.status, "paused"); assert.equal(recovered.project.iteration, 0);
    assert.equal(recovered.project.lastError, undefined); assert.equal(calls, 2);
    await orch.resume(project.projectId); await orch.activatePlan(project.projectId);
    assert.ok((await repo.readPlan(project.projectId, recovered.plan.planId))?.status === "active");
  } finally { await rm(root, { recursive: true, force: true }); }
});

const boundaries = ["prepared", "new-plan", "superseded-plan", "project", "index", "decision", "event", "decision-event", "iteration-event", "active-context", "committed"] as const;
for (const encrypted of [false, true]) for (const boundary of boundaries) for (const when of ["before", "after"] as const) test(`plan commit recovers ${when} ${boundary} write (${encrypted ? "encrypted" : "plain"})`, async () => {
  let calls = 0;
  await fixture(async (root, repo, orch, id) => {
    const old = (await repo.readProject(id))!, oldPlanId = old.planId!;
    await repo.saveActiveContext({ projectId: id, planId: oldPlanId, taskId: "evaluate" });
    const raw = (repo as any).writeRawText.bind(repo);
    let fired = false, journals = 0;
    const fail = async (match: boolean, write: () => Promise<void>) => {
      const chosen = match && !fired;
      if (chosen) { fired = true; if (when === "before") throw new Error("injected interruption"); }
      await write();
      if (chosen && when === "after") throw new Error("injected interruption");
    };
    (repo as any).writeRawText = async (relative: string, value: string) => {
      const parts = relative.split(/[\\/]/u);
      const journal = parts.includes("plan-commits") ? ++journals : 0;
      const match = boundary === "prepared" ? journal === 1 : boundary === "committed" ? journal === 2 : boundary === "new-plan" ? parts.includes("plans") && !relative.endsWith(`${oldPlanId}.json`) : boundary === "superseded-plan" ? relative.endsWith(`${oldPlanId}.json`) : boundary === "project" ? relative.endsWith("project.json") : boundary === "index" ? relative === "index.json" : boundary === "decision" ? parts.includes("decisions") : boundary === "event" ? relative.endsWith("events.jsonl") : false;
      await fail(match, () => raw(relative, value));
    };
    const clear = repo.clearActiveContext.bind(repo);
    repo.clearActiveContext = () => fail(boundary === "active-context", clear);
    const append = repo.appendEvent.bind(repo);
    repo.appendEvent = (event) => fail(boundary === "decision-event" && event.type === "decision-recorded" || boundary === "iteration-event" && event.type === "iteration-started", () => append(event));
    await assert.rejects(() => orch.decideIteration(id), /injected interruption/);
    assert.ok(fired);
    const reopened = new ResearchRepository(root, encrypted ? { metadataPassphrase: "decision-fixture-passphrase" } : {});
    // Recovery is entirely local and must not ask the planner again.
    const recovery = new ResearchOrchestrator(reopened, {}, { name: "must-not-run", async plan() { throw new Error("unexpected model call"); } });
    await recovery.recoverTaskResults(id); await recovery.recoverTaskResults(id);
    assert.equal(calls, 1);
    const exported = await reopened.exportProject(id);
    if (boundary === "prepared" && when === "before") {
      assert.equal(exported.project.planId, oldPlanId); assert.equal(exported.decisions?.length, 0);
      assert.equal(exported.events.filter((event) => event.type === "iteration-started").length, 0);
      return;
    }
    assert.notEqual(exported.project.planId, oldPlanId); assert.equal(exported.project.iteration, 1);
    assert.equal(exported.decisions?.length, 1);
    assert.equal(exported.decisions![0].resultPlanId, exported.plan?.planId);
    assert.equal(exported.events.filter((event) => event.type === "iteration-started").length, 1);
    assert.equal(exported.events.filter((event) => event.type === "decision-recorded").length, 1);
    assert.equal(exported.events.filter((event) => event.type === "plan-created").length, 2);
    assert.equal((await reopened.readPlan(id, oldPlanId))?.status, "superseded");
    assert.equal(await reopened.readActiveContext(), undefined);
    const directory = path.join(root, "projects", id, "plans");
    assert.equal((await readdir(directory)).filter((file) => file.endsWith(".json")).length, 2);
    const journalDirectory = path.join(root, "projects", id, "plan-commits");
    const [file] = await readdir(journalDirectory);
    const text = await readFile(path.join(journalDirectory, file), "utf8");
    if (encrypted) assert.ok(isEncryptedMetadataText(text));
    else assert.equal(JSON.parse(text).status, "committed");
  }, { name: "counted", async plan() { calls++; return input; } }, encrypted);
});

test("corrupt or misbound prepared journals block new writes rather than resetting state", async () => fixture(async (root, repo, orch, id) => {
  let accepted!: ResearchPlanCommit;
  const save = repo.savePlanCommit.bind(repo);
  repo.savePlanCommit = async (commit) => { await save(commit); accepted = commit; throw new Error("after prepare"); };
  await assert.rejects(() => orch.decideIteration(id), /after prepare/);
  assert.ok(accepted);
  const changed = { ...accepted, nextProject: { ...accepted.nextProject, title: "tampered" } };
  assert.throws(() => validatePlanCommit(changed), /hash mismatch/);
  const wrongIdentity = { ...accepted, nextPlan: { ...accepted.nextPlan, projectId: "foreign" } };
  wrongIdentity.contentHash = planCommitHash(wrongIdentity);
  assert.throws(() => validatePlanCommit(wrongIdentity), /identity/);
  await writeFile(path.join(root, "projects", id, "plan-commits", `${accepted.commitId}.json`), JSON.stringify(changed));
  const reopened = new ResearchOrchestrator(new ResearchRepository(root));
  await assert.rejects(() => reopened.pause(id), /hash mismatch/);
  assert.equal((await repo.readProject(id))?.planId, accepted.beforeProject.planId);
}));

test("automatic bridge rejects stale plan bindings and binds unversioned evaluations to its active plan", async () => fixture(async (_root, repo, orch, id) => {
  const project = (await repo.readProject(id))!, plan = (await repo.readPlan(id, project.planId!))!;
  await repo.savePlan({ ...plan, status: "active", tasks: plan.tasks.map((task) => ({ ...task, status: "running", attemptId: "bridge-attempt", stateVersion: 1 })) });
  await repo.saveProject({ ...project, status: "evaluating", activeTaskId: "evaluate" });
  const bridge = await startResearchBridge(orch, { runnerProjectId: id });
  try {
    const request = (planId?: string) => fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "evaluation", evaluation: { planId, metrics: [], conclusion: "inconclusive", summary: "Synthetic bridge evaluation" } }) });
    assert.equal((await request("foreign-plan")).status, 400);
    const response = await request(); assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.planId, plan.planId); assert.equal(body.taskId, "evaluate");
  } finally { await bridge.close(); }
}));

for (const encrypted of [false, true]) test(`real process exit after plan project write recovers without another model call (${encrypted ? "encrypted" : "plain"})`, async () => fixture(async (root, repo, _orch, id) => {
  const moduleUrl = (name: string) => pathToFileURL(path.resolve(`src/research/${name}.ts`)).href;
  const child = `import { ResearchRepository } from ${JSON.stringify(moduleUrl("repository"))};
import { ResearchOrchestrator } from ${JSON.stringify(moduleUrl("orchestrator"))};
import { writeFile } from 'node:fs/promises';
const [root, id, encrypted] = process.argv.slice(1);
const repo = new ResearchRepository(root, encrypted === 'yes' ? { metadataPassphrase: 'decision-fixture-passphrase' } : {});
const save = repo.saveProject.bind(repo);
repo.saveProject = async (project) => { await save(project); process.exit(73); };
const orch = new ResearchOrchestrator(repo, {}, { name: 'child-fixture', async plan() { await writeFile(root + '/planner-called', 'one'); return ${JSON.stringify(input)}; } });
await orch.decideIteration(id);`;
  const output = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, root, id, encrypted ? "yes" : "no"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(output.status, 73, output.stderr);
  assert.equal(await readFile(path.join(root, "planner-called"), "utf8"), "one");
  const reopened = new ResearchRepository(root, encrypted ? { metadataPassphrase: "decision-fixture-passphrase" } : {});
  await reopened.recoverInterruptedExperiments(); await reopened.recoverInterruptedExperiments();
  const exported = await reopened.exportProject(id);
  assert.equal(exported.project.iteration, 1); assert.equal(exported.decisions?.length, 1);
  assert.equal(exported.events.filter((event) => event.type === "decision-recorded").length, 1);
  assert.equal(exported.events.filter((event) => event.type === "iteration-started").length, 1);
  const [indexed] = await reopened.listProjects(); assert.equal(indexed.planId, exported.project.planId);
}, undefined, encrypted));
