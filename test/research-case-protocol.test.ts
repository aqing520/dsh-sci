import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { DshResearchTaskExecutor } from "../src/research/dsh-sdk.js";
import { ResearchRunner } from "../src/research/runner.js";
import { makeProject } from "../src/research/domain.js";
import { ModelResearchPlanner } from "../src/research/planner.js";

const { appendCaseSourceHints, parseCaseLiveArgs, buildCaseQuestion, inspectCaseProtocolBinding, caseProtocolDigest, assertCaseReplayConfig, replayCasePlanInput } = await import(pathToFileURL(path.resolve("scripts/research-case-protocol.mjs")).href);
const protocol = JSON.parse(await readFile("research/benchmarks/imputation-v1.json", "utf8"));

test("plan replay preserves measurable criteria but starts fresh execution and approval state", async () => {
  const { buildResearchPlan } = await import("../src/research/domain.js");
  const saved = buildResearchPlan("old-project", { question: buildCaseQuestion(protocol, false), tasks: [
    { taskId: "code", title: "Prepare", objective: "Prepare complete candidate", kind: "code-preparation", successCriteria: ["Include executable source, test source, dependency and environment declarations"] },
    { taskId: "run", title: "Run", objective: "Execute only the approved candidate", kind: "experiment", dependsOn: ["code"], requiresApproval: true, successCriteria: ["Bind exact approved content"] },
  ] });
  saved.tasks[0].status = "completed"; saved.tasks[0].attempts = 2; saved.tasks[0].outputRefs = ["old-bundle"];
  const original = JSON.stringify(saved);
  const replay = replayCasePlanInput(saved);
  const fresh = buildResearchPlan("new-project", replay);
  assert.deepEqual(fresh.tasks.map((task) => task.successCriteria), saved.tasks.map((task) => task.successCriteria));
  assert.equal(fresh.tasks[0].attempts, 0);
  assert.deepEqual(fresh.tasks[0].outputRefs, []);
  assert.equal(fresh.tasks[0].status, "pending");
  assert.equal(fresh.tasks[1].requiresApproval, true);
  assert.equal(fresh.tasks[0].projectId, "new-project");
  assert.notEqual(fresh.planId, saved.planId);
  assert.equal(JSON.stringify(saved), original);
  assert.equal("allowedActions" in replay.tasks[0], false);
  const full = buildResearchPlan("full", { question: "All criteria", tasks: [{ title: "Full", objective: "Preserve all criteria", kind: "code-preparation", successCriteria: Array.from({ length: 20 }, (_, i) => `Requirement ${i}`) }] });
  assert.deepEqual(buildResearchPlan("replayed", replayCasePlanInput(full)).tasks[0].successCriteria, full.tasks[0].successCriteria);
  assert.throws(() => buildResearchPlan("too-many", { question: "Too many", tasks: [{ title: "Full", objective: "Over limit", kind: "custom", successCriteria: Array.from({ length: 21 }, (_, i) => `Requirement ${i}`) }] }), /20 custom items/);
});

test("supplemental accessible-version hints preserve the frozen protocol and grant no approval", () => {
  const before = JSON.stringify(protocol);
  const url = "https://publisher.example/paper?doi=10.1234/example";
  const options = parseCaseLiveArgs(["--source-hint", url, "--plan-from", "previous/plan.json", "--source-hint", url]);
  assert.equal(options.planFrom, "previous/plan.json");
  assert.deepEqual(options.sourceHints, [url]);
  const original = buildCaseQuestion(protocol, false);
  const question = appendCaseSourceHints(original, options.sourceHints);
  assert.ok(question.startsWith(original));
  assert.ok(question.includes(url));
  assert.ok(question.includes("not autonomous discovery or verified evidence"));
  assert.ok(question.includes("No research approval"));
  assert.equal(inspectCaseProtocolBinding(protocol, question).status, "bound");
  assert.equal(JSON.stringify(protocol), before);
  assert.equal(appendCaseSourceHints(original, []), original);
  for (const args of [["--source-hint"], ["--unknown", "x"], ["--source-hint", "file:///private"], ["--source-hint", "https://user:secret@example.com"], ["--plan-from", "a", "--plan-from", "b"], Array.from({ length: 6 }, (_, i) => ["--source-hint", `https://publisher.example/${i}`]).flat()]) assert.throws(() => parseCaseLiveArgs(args));
});

test("model plans preserve the explicit code-preparation contract without inferring it from prose", async () => {
  const planner = new ModelResearchPlanner({ async createResponse(request: { instructions: string }) {
    assert.match(request.instructions, /code-preparation requires a persisted complete code bundle/);
    return { output_text: JSON.stringify({ tasks: [
      { taskId: "code", title: "Candidate code", objective: "Save complete source files", kind: "code-preparation" },
      { taskId: "notes", title: "Review implementation limitations", objective: "Write prose about implementation limitations", kind: "custom", dependsOn: ["code"] },
    ] }) };
  } } as any);
  const input = await planner.plan("Prepare an implementation and its limitations");
  const { buildResearchPlan } = await import("../src/research/domain.js");
  const plan = buildResearchPlan("fixture", input);
  assert.equal(plan.tasks[0].kind, "code-preparation");
  assert.deepEqual(plan.tasks[0].completionContract?.requiredOutputs, ["code-bundle"]);
  assert.deepEqual(plan.tasks[1].completionContract?.requiredOutputs, []);
});

test("the exact frozen protocol survives persistence, planning and the SDK prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-protocol-"));
  try {
    const question = buildCaseQuestion(protocol, false);
    assert.ok(question.length > 4000);
    assert.throws(() => makeProject("q".repeat(16001)), /too long/);
    const repository = new ResearchRepository(root);
    let planningInput = "", executionInput = "";
    const orchestrator = new ResearchOrchestrator(repository, {}, new ModelResearchPlanner({
      async createResponse(request: { input: string }) {
        planningInput = request.input;
        return { output_text: JSON.stringify({ question: "Model rewrite must not replace the frozen protocol", tasks: [{ taskId: "one", title: "Check protocol", objective: "Synthetic transport test", kind: "custom" }] }) };
      },
    } as any));
    const { project } = await orchestrator.createProject(question);
    assert.ok(planningInput.includes(question), "compact model plan still receives the complete frozen protocol");
    const reopened = new ResearchRepository(root);
    assert.equal((await reopened.readProject(project.projectId))!.question, question);
    assert.equal(inspectCaseProtocolBinding(protocol, question).status, "bound");
    const client = {
      async initialize() {}, async createSession() {}, async resume() {}, async close() {}, async wait() {},
      async prompt(_session: string, input: string) { executionInput = input; return { messageId: "fixture" }; },
      lastAssistantText() { return JSON.stringify({ ...JSON.parse(executionInput.match(/^Exact execution identity: (.+)$/m)![1]), projectId: project.projectId, taskId: "one", status: "completed", summary: "Transport fixture completed" }); },
    };
    await new ResearchRunner(orchestrator).run(project.projectId, new DshResearchTaskExecutor({ client, repository }));
    assert.ok(executionInput.includes(question));
    assert.ok(executionInput.includes(protocol.data.maskRule));
    assert.ok(executionInput.includes(protocol.analysis.practicalEffect));
    assert.ok(executionInput.includes(JSON.stringify(protocol, null, 2)));
    const changed = structuredClone(protocol);
    changed.data.seed += 1;
    assert.equal(inspectCaseProtocolBinding(changed, question).status, "review-required");
    assert.equal(inspectCaseProtocolBinding(protocol, "Frozen protocol: n=2000, MCAR 30%").status, "review-required");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replay refuses declared protocol drift before processing numeric output", () => {
  const config = {
    protocolSha256: caseProtocolDigest(protocol),
    cfg: { n: 2000, repetitions: 100, B: 10000, master: 20261030, distributions: ["lognormal", "normal"], rates: [0.1, 0.3, 0.5], maskRule: "fixed-count-fisher-yates", relativeDenominator: "mean" },
  };
  assert.equal(assertCaseReplayConfig(protocol, config), config.cfg);
  for (const [field, value] of [["maskRule", "bernoulli"], ["relativeDenominator", "median"], ["B", 100], ["repetitions", 8], ["rates", [0.3]]] as const) {
    assert.throws(() => assertCaseReplayConfig(protocol, { ...config, cfg: { ...config.cfg, [field]: value } }), new RegExp(field));
  }
  assert.throws(() => assertCaseReplayConfig(protocol, { ...config, protocolSha256: "0".repeat(64) }), /protocolSha256/);
});
