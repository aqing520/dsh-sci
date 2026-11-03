import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { ResearchConversations } from "../src/research/conversation.js";
import { startResearchBridge } from "../src/research/bridge.js";
// @ts-expect-error the Harness plugin is plain ESM.
import { apply } from "../desktop/dsh-sci-research-plugin.mjs";

async function fixture(run: (f: any) => Promise<void>, encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-conversation-"));
  const workspace = path.join(root, "workspace"), other = path.join(root, "other");
  await Promise.all([mkdir(workspace), mkdir(other)]);
  const repository = new ResearchRepository(path.join(root, "research"), encrypted ? { metadataPassphrase: "conversation-fixture" } : {});
  const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: other, allowedCommands: [process.execPath] } });
  const bridge = await startResearchBridge(orchestrator, { conversations: new ResearchConversations(orchestrator) });
  const keys = ["DSH_SCI_RESEARCH_ROOT", "DSH_SCI_RESEARCH_BRIDGE_URL", "DSH_SCI_RESEARCH_BRIDGE_TOKEN", "DSH_SCI_RESEARCH_APPROVAL_TOKEN", "DSH_SCI_EXTERNAL_RUNNER"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DSH_SCI_RESEARCH_ROOT = repository.root;
  process.env.DSH_SCI_RESEARCH_BRIDGE_URL = bridge.url;
  process.env.DSH_SCI_RESEARCH_BRIDGE_TOKEN = bridge.token;
  process.env.DSH_SCI_RESEARCH_APPROVAL_TOKEN = bridge.approvalToken;
  delete process.env.DSH_SCI_EXTERNAL_RUNNER;
  const listeners = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const cleanups: Array<() => Promise<void>> = [];
  let service: any;
  const approval = { outcome: "allowed-once", reasons: [] as string[], async request(request: any) { this.reasons.push(request.reason); return this.outcome; } };
  apply({ inject(_deps: string[], callback: any) { callback({ effect(factory: any) { cleanups.push(factory()); }, commands: { register(command: any) { commands.set(command.name, command); return () => undefined; } } }); }, get(name: string) { return name === "approval" ? approval : undefined; }, tools: { register(tool: any) { tools.set(tool.name, tool); } }, provide(_name: string, value: any) { service = value; }, on(name: string, handler: any) { listeners.set(name, handler); }, effect(factory: any) { cleanups.push(factory()); }, logger: { warn() {} } });
  const agent = { id: "agent-not-session", session: { id: "session-a", header: { cwd: workspace } } };
  const invoke = (name: string, args: any = {}, caller = agent) => tools.get(name).execute(args, { agent: caller, signal: new AbortController().signal, callId: `call-${name}`, deferContext() {}, concludeTurn() {} });
  const request = async (action: string, args: any = {}, sessionId = "session-a", cwd = workspace) => {
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...args, action, conversation: { sessionId, cwd } }) });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(value.error);
    return value;
  };
  try { await run({ root, workspace, other, repository, orchestrator, bridge, agent, tools, commands, invoke, request, listeners, service, approval }); }
  finally {
    for (const cleanup of cleanups) await cleanup();
    await bridge.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
}

for (const encrypted of [false, true]) test(`native conversation reads, cites and checkpoints two documents without a dashboard (${encrypted ? "encrypted" : "plain"})`, async () => fixture(async (f) => {
  await f.repository.saveActiveContext({ projectId: "unrelated-global-project", taskId: "unrelated-task" });
  const globalBefore = await readFile(path.join(f.repository.root, "active-context.json"), "utf8");
  assert.equal((await f.invoke("research_context")).active, false);
  const context = await f.invoke("research_begin", { question: "Compare the methods and limitations of these two local fixture papers." });
  assert.equal(context.task.kind, "conversation");
  assert.equal((await f.repository.exportProject(context.projectId)).plan.tasks.length, 1);
  assert.equal(context.task.status, "running");
  assert.equal(await readFile(path.join(f.repository.root, "active-context.json"), "utf8"), globalBefore, "native research never borrows or replaces global task context");
  await writeFile(path.join(f.workspace, "a.md"), "# Fixture A\nWe compare paired observations. The sample is synthetic, not scientific evidence.");
  await writeFile(path.join(f.workspace, "b.md"), "# Fixture B\nWe compare independent observations. Dependence would violate this fixture's assumption.");
  const acquired = await f.orchestrator.ingestDocument(context.projectId, path.join(f.workspace, "a.md"));
  const unread = await f.repository.readSourceContent(context.projectId, acquired.source.latestContentVersionId);
  await assert.rejects(() => f.invoke("research_cite", { sourceId: acquired.source.sourceId, contentVersionId: unread.contentVersionId, chunkId: unread.chunks[0].chunkId, quotedText: "paired observations" }), /read by this research task/, "acquisition and metadata are not an Agent reading receipt");
  const citations = [];
  for (const file of ["a.md", "b.md"]) {
    const result = await f.invoke("research_read", { file });
    const { content, chunks, receipt } = result;
    assert.equal(receipt.audience, "agent");
    const citation = await f.invoke("research_cite", { sourceId: content.sourceId, contentVersionId: content.contentVersionId, chunkId: chunks[0].chunkId, quotedText: chunks[0].text.slice(0, 70) });
    assert.equal(citation.verification.status, "verbatim-match");
    citations.push(citation.citationId);
    await assert.rejects(() => f.invoke("research_cite", { sourceId: content.sourceId, contentVersionId: content.contentVersionId, chunkId: chunks[0].chunkId, quotedText: "A fabricated statement not in either paper." }), /quote a chunk/);
  }
  const claim = await f.invoke("research_claim", { text: "The fixture methods assume different observation dependence; this is a textual comparison, not a validation of either method.", claimType: "interpretation", citationIds: citations });
  const checkpoint = await f.invoke("research_checkpoint", { summary: "Read both fixture documents and compared assumptions. No experiments have run; scientific validity is not assessed.", refs: [claim.claimId, ...citations] });
  assert.equal(checkpoint.scientificAcceptance, "not-implied");
  const snapshot = await f.repository.exportProject(context.projectId);
  assert.equal(snapshot.sourceReads.length, 2);
  assert.equal(snapshot.citations.length, 2, "fabricated citation rejected before persistence");
  assert.equal(snapshot.experimentRuns.length, 0);
  const reopened = new ResearchConversations(new ResearchOrchestrator(new ResearchRepository(f.repository.root, encrypted ? { metadataPassphrase: "conversation-fixture" } : {})));
  const restored: any = await reopened.dispatch({ action: "context", conversation: { sessionId: "session-a", cwd: f.workspace } }, new AbortController().signal, async () => { throw new Error("context cannot use global dispatcher"); });
  assert.equal(restored.projectId, context.projectId);
  assert.equal(restored.checkpoint.summary, checkpoint.checkpoint.summary);
  const otherSession = await f.request("conversation-begin", { projectId: context.projectId }, "session-resume");
  assert.equal(otherSession.checkpoint.summary, checkpoint.checkpoint.summary, "another session in the same workspace can recover the project's checkpoint");
  const assembled = await f.listeners.get("system-prompt/assemble")({}, { agent: f.agent }, async () => ({ contexts: [] }));
  assert.match(assembled.contexts[0].text, /Reply to the user in normal prose/);
  assert.doesNotMatch(assembled.contexts[0].text, /unrelated-global-project/);
}, encrypted));

test("real-model empty optional fields and first-start newResearch do not require a replacement approval", async () => fixture(async (f) => {
  const context = await f.invoke("research_begin", { question: "Read the actual local fixture", projectId: "", newResearch: true });
  assert.equal(context.active, true);
  assert.equal(f.approval.reasons.length, 0);
  await writeFile(path.join(f.workspace, "empty-options.md"), "This is actual saved text for an empty-option regression.");
  const read = await f.invoke("research_read", { file: "empty-options.md", reference: "", sourceId: "", contentVersionId: "", offset: 0, limit: 3 });
  assert.match(read.chunks[0].text, /actual saved text/);
  f.approval.outcome = "rejected";
  const replacement = await f.invoke("research_begin", { question: "A different research question", projectId: "", newResearch: true });
  assert.equal(replacement.changed, false);
  assert.equal((await f.invoke("research_context")).projectId, context.projectId);
  assert.equal(f.approval.reasons.length, 1);
}));

test("native session/workspace scopes reject cross-project access and global control actions", async () => fixture(async (f) => {
  const a = await f.invoke("research_begin", { question: "Question A" });
  assert.equal((await f.request("context", {}, "session-b")).active, false);
  assert.equal((await f.request("context", {}, "session-a", f.other)).active, false);
  const b = await f.request("conversation-begin", { question: "Question B" }, "session-b", f.other);
  assert.notEqual(a.projectId, b.projectId);
  await assert.rejects(() => f.request("inspect", { collection: "sources", projectId: b.projectId }), /conversation's project/);
  await assert.rejects(() => f.request("conversation-begin", { projectId: b.projectId }, "new-session"), /from this workspace/);
  await assert.rejects(() => f.request("conversation-begin", { newResearch: true, question: "Reset my budget" }), /explicit host action/);
  await assert.rejects(() => f.invoke("research_action", { request: { action: "conversation-reserve" } }), /not available/);
  await assert.rejects(() => f.request("complete", { taskId: "conversation" }), /not available/);
  await assert.rejects(() => f.invoke("research_read", { file: path.join(f.other, "private.md") }), /ENOENT/);
  await writeFile(path.join(f.other, "private.md"), "outside this workspace");
  await assert.rejects(() => f.invoke("research_read", { file: path.join(f.other, "private.md") }), /must belong/);
  const bundle = await f.invoke("research_code", { operation: "stage", files: [{ name: "run.mjs", kind: "code", content: "console.log('fixture only');\n" }] });
  assert.ok(bundle.directory.startsWith((await realpath(f.workspace)).toLowerCase()) || bundle.directory.startsWith(await realpath(f.workspace)));
  const restored = await f.invoke("research_context");
  assert.equal(restored.projectId, a.projectId);
}));

test("native request hook preserves current provider and accounts reported, unknown and retried usage", async () => fixture(async (f) => {
  const context = await f.invoke("research_begin", { question: "Account current-model research requests" });
  const hook = f.listeners.get("agent/request");
  const event = f.listeners.get("session/event");
  const config = { provider: "deepseek", model: "current-model-from-DSH" };
  assert.equal(await hook({ agent: f.agent, signal: new AbortController().signal }, async () => config), config, "native hook never replaces DSH provider/model or reads another key");
  event(f.agent.session, { type: "assistant/message", data: { usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } } });
  await f.service.flush();
  await hook({ agent: f.agent }, async () => ({ provider: "different-provider", model: "new-selection" }));
  event(f.agent.session, { type: "assistant/attempt", data: {} });
  await f.service.flush();
  await hook({ agent: f.agent }, async () => config);
  event(f.agent.session, { type: "assistant/message", data: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } });
  await f.service.flush();
  const budget = await f.repository.readBudget(context.projectId);
  assert.equal(budget.usedModelRequests, 3);
  assert.equal(budget.reportedTotalTokens, 13);
  assert.equal(budget.unknownUsageRequests, 1);
  assert.equal(budget.modelRequests.every((item: any) => item.status === "settled"), true);
  assert.equal(await hook({ agent: { session: { id: "ordinary-helper-no-cwd" } } }, async () => config), config);
}));

test("compaction summaries share the session research budget and preserve stream routing and durable evidence", async () => fixture(async (f) => {
  const context = await f.invoke("research_begin", { question: "Keep scientific evidence through context compaction" });
  await f.invoke("research_checkpoint", { summary: "Original prediction remains unresolved; resume by checking saved evidence.", refs: [] });
  const stream = f.listeners.get("llm/stream");
  const options = Object.freeze({ sessionId: f.agent.session.id, purpose: "compaction", provider: "current-selection", model: "luna", messages: [] });
  const chunks = [{ type: "text-delta", index: 0, text: "summary" }, { type: "usage", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }, { type: "finish", reason: "stop" }];
  const collected = [];
  for await (const chunk of stream(options, async function* () { yield* chunks; })) collected.push(chunk);
  assert.deepEqual(collected, chunks);
  assert.equal((await f.repository.readBudget(context.projectId)).reportedTotalTokens, 12);
  assert.equal((await f.repository.readBudget(context.projectId)).usedModelRequests, 1);
  const reopened = await f.invoke("research_context");
  assert.match(reopened.checkpoint.summary, /Original prediction remains unresolved/);
  await assert.rejects(async () => { for await (const _ of stream(options, async function* () { throw new Error("summarizer disconnected"); })) {} }, /disconnected/);
  const budget = await f.repository.readBudget(context.projectId);
  assert.equal(budget.usedModelRequests, 2);
  assert.equal(budget.unknownUsageRequests, 1);
  // Ordinary Agent calls are already charged at agent/request, never twice.
  for await (const _ of stream({ ...options, purpose: undefined }, async function* () { yield* chunks; })) {}
  assert.equal((await f.repository.readBudget(context.projectId)).usedModelRequests, 2);
}));

test("native budgets stop requests before calling the model and cannot be reset by research tools", async () => fixture(async (f) => {
  const context = await f.invoke("research_begin", { question: "Bound research requests" });
  await f.orchestrator.updateBudget(context.projectId, { maxTaskExecutions: 10, maxWallTimeMs: 60000, maxModelRequests: 1, maxModelTokens: 1000 });
  const hook = f.listeners.get("agent/request");
  await hook({ agent: f.agent }, async () => ({ provider: "deepseek", model: "current" }));
  f.listeners.get("session/event")(f.agent.session, { type: "assistant/attempt", data: {} });
  await f.service.flush();
  await assert.rejects(() => hook({ agent: f.agent }, async () => ({ provider: "deepseek", model: "current" })), /budget exhausted/);
  await assert.rejects(() => f.invoke("research_action", { request: { action: "budget-update", maxModelRequests: 1000 } }), /not available/);
  assert.equal((await f.invoke("research_context")).project.status, "paused");
  assert.equal((await f.repository.readBudget(context.projectId)).usedModelRequests, 1);
  const changed = await f.commands.get("research-budget").handler({ agent: f.agent, signal: new AbortController().signal, rawInput: "2 2000 60" });
  assert.equal(changed.kind, "success", "an explicit human slash command can extend exhausted limits without a model request");
  assert.equal((await f.repository.readBudget(context.projectId)).usedModelRequests, 1);
  assert.equal((await f.repository.readBudget(context.projectId)).maxModelRequests, 2);
  assert.equal((await f.invoke("research_context")).project.status, "researching");
}));

test("native experiment uses in-conversation approvals, bound code, real outputs and idempotent recovery", async () => fixture(async (f) => {
  const context = await f.invoke("research_begin", { question: "Check a deterministic fixture prediction using saved code and a real local run." });
  const hypothesis = await f.invoke("research_hypothesis", { proposition: "The fixture returns a sum of 7.", scope: "A deliberately incorrect prediction for a deterministic transport fixture, not a scientific result.", predictions: ["Observed sum equals 7."], falsifiers: ["Observed sum differs from 7."] });
  const design = await f.invoke("research_design", { hypothesisIds: [hypothesis.hypothesisId], dataDescription: "Fixed fixture values 1,2,3.", dataVersion: "fixture-v1", experimentalUnit: "One deterministic computation", independentVariables: ["Input vector"], dependentVariables: ["Sum"], controls: ["Known arithmetic result"], primaryMetric: "sum", repetitions: 1, randomization: "Not applicable to deterministic arithmetic", missingDataHandling: "Fail on missing input", analysisMethod: "Exact equality; no population inference", stoppingRule: "One computation" });
  await assert.rejects(() => f.request("conversation-approve-design", { designId: design.designId, contentHash: design.contentHash, trustedApproval: true }), /trusted Harness/);
  f.approval.outcome = "rejected";
  assert.equal((await f.invoke("research_approve_design", { designId: design.designId })).approved, false);
  assert.equal((await f.repository.readExperimentDesign(context.projectId, design.designId)).status, "draft");
  f.approval.outcome = "allowed-once";
  await f.invoke("research_approve_design", { designId: design.designId });
  const bundle = await f.invoke("research_code", { operation: "stage", files: [{ name: "run.mjs", kind: "code", content: "import fs from 'node:fs'; const sum=[1,2,3].reduce((a,b)=>a+b,0); fs.writeFileSync('result.json',JSON.stringify({sum})); console.log(sum);\n" }] });
  await f.invoke("research_code", { operation: "read", bundleId: bundle.bundleId, fileName: "run.mjs" });
  await f.invoke("research_code", { operation: "review", bundleId: bundle.bundleId, designId: design.designId, summary: "The fixture sums fixed values and writes a JSON result.", findings: [], limitations: ["Static review only; no scientific interpretation or runtime correctness established."] });
  const experiment = await f.invoke("research_experiment", { title: "Arithmetic fixture", command: process.execPath, args: ["run.mjs"], codeBundleId: bundle.bundleId, designId: design.designId, inputPaths: [], outputPaths: ["result.json"], timeoutMs: 10000 });
  const reviewView = await f.orchestrator.forProject(context.projectId);
  assert.equal(await f.orchestrator.forProject(context.projectId), reviewView, "review UI and conversation share an execution owner");
  assert.equal((await reviewView.experimentReview(context.projectId, experiment.experimentId)).files[0].sha256, experiment.codeManifest[0].sha256);
  f.approval.outcome = "rejected";
  assert.equal((await f.invoke("research_execute", { experimentId: experiment.experimentId })).executed, false);
  assert.equal((await f.repository.listExperimentRuns(context.projectId)).length, 0);
  f.approval.outcome = "allowed-once";
  const run = await f.invoke("research_execute", { experimentId: experiment.experimentId });
  assert.equal(run.state, "completed");
  assert.equal(run.exitCode, 0);
  assert.equal(JSON.parse(await readFile(path.join(bundle.directory, "result.json"), "utf8")).sum, 6);
  assert.ok(run.manifest.outputs[0].sha256);
  assert.equal((await f.invoke("research_execute", { experimentId: experiment.experimentId })).run.runId, run.runId);
  assert.equal((await reviewView.executeExperiment(context.projectId, experiment.experimentId, { approved: true })).runId, run.runId);
  assert.equal((await f.repository.listExperimentRuns(context.projectId)).length, 1, "saved completion is reused, never executed twice");
  assert.match(f.approval.reasons.at(-1), /run.mjs/);
  assert.match(f.approval.reasons.at(-1), /result.json/);
  const evaluation = await f.invoke("research_analyze", { experimentRunIds: [run.runId], metrics: [{ name: "sum", observed: 6, expected: 7, criterion: "close", tolerance: 0 }], summary: "The observed result contradicts the predeclared prediction.", limitations: ["Synthetic deterministic arithmetic does not validate scientific research quality."] });
  assert.equal(evaluation.taskId, "conversation");
  assert.equal(evaluation.conclusion, "refutes");
  assert.deepEqual((await f.repository.readHypothesis(context.projectId, hypothesis.hypothesisId)).predictions, ["Observed sum equals 7."], "contradictory results do not rewrite the saved prediction");
  await f.invoke("research_checkpoint", { summary: "The fixture ran once and contradicted the saved prediction. No scientific claims were tested.", refs: [run.runId, evaluation.evaluationId] });
}));

test("explicit migration keeps legacy evidence, budgets and plan history without importing global context", async () => fixture(async (f) => {
  const legacy = await f.orchestrator.createProject("A legacy research question", { plan: { question: "A legacy research question", tasks: [{ title: "Old task", objective: "Old objective", kind: "custom" }] } });
  const source = await f.orchestrator.addSource(legacy.project.projectId, { title: "Legacy source", kind: "paper" });
  await f.repository.saveActiveContext({ projectId: "unrelated", taskId: "other" });
  const before = await f.repository.readBudget(legacy.project.projectId);
  const migrated = await f.commands.get("research-adopt").handler({ agent: f.agent, signal: new AbortController().signal, rawInput: legacy.project.projectId });
  assert.equal(migrated.kind, "success", migrated.text);
  const context = await f.invoke("research_context");
  assert.equal(context.projectId, legacy.project.projectId);
  assert.equal(context.project.conversationOriginPlanId, legacy.plan.planId);
  const snapshot = await f.repository.exportProject(context.projectId);
  assert.equal(snapshot.sources[0].sourceId, source.sourceId);
  assert.equal(snapshot.plan.tasks[0].kind, "conversation");
  assert.equal(snapshot.budget.maxModelRequests, before.maxModelRequests);
  assert.equal(snapshot.budget.maxModelTokens, before.maxModelTokens);
  assert.equal((await f.repository.readPlan(context.projectId, legacy.plan.planId)).status, "superseded");
  assert.equal((await f.repository.readActiveContext()).projectId, "unrelated");
}));

test("native no-progress detection stops repeated context loops without charging a ninth call", async () => fixture(async (f) => {
  const context = await f.invoke("research_begin", { question: "A bounded no-progress fixture" });
  const hook = f.listeners.get("agent/request");
  for (let i = 0; i < 8; i++) {
    await hook({ agent: f.agent, turn: 1 }, async () => ({ provider: "deepseek", model: "current" }));
    f.listeners.get("session/event")(f.agent.session, { type: "assistant/attempt", data: {} });
    await f.service.flush();
    await f.invoke("research_context");
  }
  await assert.rejects(() => hook({ agent: f.agent, turn: 1 }, async () => ({ provider: "deepseek", model: "current" })), /eight model requests/);
  assert.equal((await f.repository.readBudget(context.projectId)).usedModelRequests, 8);
  await hook({ agent: f.agent, turn: 2 }, async () => ({ provider: "deepseek", model: "current" }));
  f.listeners.get("session/event")(f.agent.session, { type: "assistant/attempt", data: {} });
  await f.service.flush();
}));
