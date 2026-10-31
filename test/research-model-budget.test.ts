import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startDshSdkClient } from "../src/research/dsh-sdk.js";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { ResearchRunner } from "../src/research/runner.js";
import { ModelResearchPlanner } from "../src/research/planner.js";
import { ModelGateway } from "../src/provider.js";
import { startModelBudgetProxy } from "../src/research/model-budget-proxy.js";
import { ResearchBudgetExhaustedError, ResearchBudgetPersistenceError, type MeteredResearchBudget } from "../src/research/budget.js";
import { ResearchStaleExecutionError } from "../src/research/result-commit.js";

const plan = { question: "Budget fixture", tasks: [{ taskId: "one", title: "One", objective: "Verify transport accounting", kind: "custom" as const }] };
const limits = { maxTaskExecutions: 3, maxWallTimeMs: 60_000, maxModelRequests: 3, maxModelTokens: 1000 };
async function metered(repository: ResearchRepository, projectId: string): Promise<MeteredResearchBudget> {
  const budget = await repository.readBudget(projectId);
  assert.equal(budget?.schema, "dsh-sci.research-budget.v2");
  return budget as MeteredResearchBudget;
}
async function fixture(operation: (root: string, repository: ResearchRepository, orchestrator: ResearchOrchestrator) => Promise<void>, encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-model-budget-"));
  const repository = new ResearchRepository(root, encrypted ? { metadataPassphrase: "fixture-passphrase" } : {});
  try { await operation(root, repository, new ResearchOrchestrator(repository)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("model reservations are atomic across Repository instances and retries use distinct reservations", async () => fixture(async (root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: { ...limits, maxModelRequests: 1 } });
  const other = new ResearchRepository(root);
  const results = await Promise.allSettled([repository.reserveModelRequest(project.projectId, { phase: "planner" }), other.reserveModelRequest(project.projectId, { phase: "planner" })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(failure.reason instanceof ResearchBudgetExhaustedError);
  assert.equal((await metered(repository, project.projectId)).usedModelRequests, 1);
  const id = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<string>).value;
  await repository.recordModelUsage(project.projectId, id, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  await repository.recordModelUsage(project.projectId, id, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  await assert.rejects(() => repository.recordModelUsage(project.projectId, id, { totalTokens: 7 }), ResearchBudgetPersistenceError);
  assert.equal((await metered(repository, project.projectId)).reportedTotalTokens, 5);
}));

for (const encrypted of [false, true]) test(`pending model requests recover as unknown once without refund (${encrypted ? "encrypted" : "plain"})`, async () => fixture(async (root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: limits });
  await repository.reserveModelRequest(project.projectId, { phase: "planner", secret: "must-not-persist" } as any);
  const reopened = new ResearchRepository(root, encrypted ? { metadataPassphrase: "fixture-passphrase" } : {});
  await reopened.recoverInterruptedExperiments();
  await reopened.recoverInterruptedExperiments();
  const budget = await metered(reopened, project.projectId);
  assert.equal(budget.usedModelRequests, 1);
  assert.equal(budget.unknownUsageRequests, 1);
  assert.equal(budget.modelRequests[0].interrupted, true);
  assert.equal(budget.reportedTotalTokens, 0);
  assert.doesNotMatch(JSON.stringify(budget), /must-not-persist|secret/);
  if (encrypted) assert.doesNotMatch(await readFile(path.join(root, "projects", project.projectId, "budget.json"), "utf8"), /reservationId|reportedTotalTokens/);
}, encrypted));

test("legacy model budget requires explicit limits and preserves prior task/time usage", async () => fixture(async (root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan });
  const at = new Date().toISOString();
  const legacy = { schema: "dsh-sci.research-budget.v1", projectId: project.projectId, revision: 7, maxTaskExecutions: 5, usedTaskExecutions: 2, maxWallTimeMs: 60_000, startedAt: at, updatedAt: at };
  await writeFile(path.join(root, "projects", project.projectId, "budget.json"), JSON.stringify(legacy));
  assert.deepEqual(await repository.readBudget(project.projectId), legacy);
  await assert.rejects(() => repository.reserveModelRequest(project.projectId, { phase: "planner" }), /explicit model budget/);
  const blocked = await new ResearchRunner(orchestrator).run(project.projectId, { async execute() { throw new Error("must not run"); } });
  assert.equal(blocked.status, "blocked");
  await assert.rejects(() => orchestrator.updateBudget(project.projectId, { maxTaskExecutions: 5, maxWallTimeMs: 60_000 }), /Explicit model/);
  const updated = await orchestrator.updateBudget(project.projectId, { ...limits, maxTaskExecutions: 5 });
  assert.equal(updated.startedAt, at);
  assert.equal(updated.usedTaskExecutions, 2);
  assert.equal(updated.revision, 8);
}));

test("reported token threshold includes total-only usage and does not count cache details twice", async () => fixture(async (_root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: { ...limits, maxModelTokens: 5 } });
  const id = await repository.reserveModelRequest(project.projectId, { phase: "planner" });
  await repository.recordModelUsage(project.projectId, id, { totalTokens: 5 });
  await assert.rejects(() => orchestrator.reserveModelRequest(project.projectId, { phase: "planner" }), (error: unknown) => error instanceof ResearchBudgetExhaustedError && error.reason === "model-tokens");
  const budget = await metered(repository, project.projectId);
  assert.equal(budget.reportedTotalTokens, 5);
  assert.equal(budget.unknownUsageRequests, 0);
  assert.equal((await repository.readProject(project.projectId))?.status, "paused");
}));

test("planner and replan share the persisted project budget and exhaustion cannot fall back", async () => fixture(async (_root, repository) => {
  let calls = 0;
  const gateway = new ModelGateway({ config: { provider: "custom", model: "fixture", baseUrl: "http://example.test/v1", apiKey: "private-provider-key", timeoutMs: 1000 }, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
  } });
  const orchestrator = new ResearchOrchestrator(repository, {}, new ModelResearchPlanner(gateway));
  const { project } = await orchestrator.createProject(plan.question, { budget: { ...limits, maxModelRequests: 2 } });
  await orchestrator.replan(project.projectId);
  await assert.rejects(() => orchestrator.replan(project.projectId), ResearchBudgetExhaustedError);
  assert.equal(calls, 2);
  const budget = await metered(repository, project.projectId);
  assert.equal(budget.usedModelRequests, 2);
  assert.equal(budget.reportedTotalTokens, 30);
  assert.deepEqual(budget.modelRequests.map((request) => request.phase), ["planner", "replan"]);
  assert.equal((await repository.readProject(project.projectId))?.status, "paused");
  assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "planning-fallback").length, 0);
}));

test("planner accounting failure keeps an inspectable project without a fabricated plan or network call", async () => fixture(async (_root, repository) => {
  let calls = 0;
  const gateway = new ModelGateway({ config: { provider: "custom", model: "fixture", baseUrl: "http://example.test/v1", apiKey: "private-key", timeoutMs: 1000 }, fetchImpl: async () => { calls += 1; return new Response("{}"); } });
  const orchestrator = new ResearchOrchestrator(repository, {}, new ModelResearchPlanner(gateway));
  const save = repository.saveBudget.bind(repository);
  let writes = 0;
  repository.saveBudget = async (budget) => { if (++writes > 1) throw new Error("disk-full"); return save(budget); };
  await assert.rejects(() => orchestrator.createProject(plan.question, { budget: limits }), ResearchBudgetPersistenceError);
  assert.equal(calls, 0);
  const [project] = await repository.listProjects();
  assert.equal(project.status, "paused");
  assert.equal(project.planId, undefined);
  assert.equal((await repository.exportProject(project.projectId)).plan, undefined);
  assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "planning-fallback").length, 0);
}));

test("a corrupt usage ledger blocks further reservations instead of resetting its counters", async () => fixture(async (root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan });
  const budget = await metered(repository, project.projectId);
  await writeFile(path.join(root, "projects", project.projectId, "budget.json"), JSON.stringify({ ...budget, usedModelRequests: 1 }));
  await assert.rejects(() => repository.reserveModelRequest(project.projectId, { phase: "planner" }), ResearchBudgetPersistenceError);
  await assert.rejects(() => repository.readBudget(project.projectId), /model request counter/);
}));

test("a process exits after reservation and exclusive startup recovers encrypted usage without another call", async () => fixture(async (root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: limits });
  const source = new URL("../src/research/repository.ts", import.meta.url).href;
  const program = `import { ResearchRepository } from ${JSON.stringify(source)}; const repo = new ResearchRepository(${JSON.stringify(root)}, { metadataPassphrase: 'fixture-passphrase' }); await repo.reserveModelRequest(${JSON.stringify(project.projectId)}, { phase: 'planner' }); process.exit(37);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 37, child.stderr);
  assert.equal((await metered(repository, project.projectId)).modelRequests[0].status, "reserved");
  await repository.recoverInterruptedExperiments();
  const budget = await metered(repository, project.projectId);
  assert.equal(budget.usedModelRequests, 1);
  assert.equal(budget.unknownUsageRequests, 1);
  assert.equal(budget.modelRequests[0].status, "settled");
}, true));

test("SDK child receives proxy credentials while inherited and supplied provider keys are filtered", async () => fixture(async (root) => {
  const script = path.join(root, "credential-boundary.cjs");
  await writeFile(script, `const readline = require('node:readline'); const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(root, "observed.json"))}, JSON.stringify({ rawKeyPresent: Boolean(process.env.OTHER_PROVIDER_API_KEY || process.env.CUSTOM_ACCESS_TOKEN), hasProxyCredential: process.env.OPENAI_API_KEY === 'loopback-token' && process.env.DSH_SCI_API_KEY === 'loopback-token' && process.env.TOKENFANS_API_KEY === 'loopback-token', hasBridge: process.env.DSH_SCI_RESEARCH_BRIDGE_TOKEN === 'bridge-fixture' })); readline.createInterface({ input: process.stdin }).on('line', line => { const r = JSON.parse(line); if (r.id === undefined) return; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'initialize' ? { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } : {} }) + '\\n'); if (r.method === 'shutdown') process.exit(0); });`);
  const client = await startDshSdkClient({ home: root, cwd: root, provider: "custom", model: "fixture", command: process.execPath, args: [script], isolateProviderCredentials: true, apiKey: "loopback-token", environment: { OTHER_PROVIDER_API_KEY: "do-not-inherit", CUSTOM_ACCESS_TOKEN: "do-not-inherit", DSH_SCI_API_KEY: "raw-key", DSH_SCI_RESEARCH_BRIDGE_TOKEN: "bridge-fixture" } });
  try { assert.deepEqual(JSON.parse(await readFile(path.join(root, "observed.json"), "utf8")), { rawKeyPresent: false, hasProxyCredential: true, hasBridge: true }); }
  finally { await client.close(); }
}));

test("failed planner network attempts count as unknown and fallback has explicit provenance", async () => fixture(async (_root, repository) => {
  const gateway = new ModelGateway({ config: { provider: "custom", model: "fixture", baseUrl: "http://example.test/v1", apiKey: "key", timeoutMs: 1000 }, fetchImpl: async () => { throw new Error("network-fixture"); } });
  const orchestrator = new ResearchOrchestrator(repository, {}, new ModelResearchPlanner(gateway));
  const { project, plan: fallback } = await orchestrator.createProject(plan.question, { budget: limits });
  assert.equal(fallback.planning?.source, "fallback");
  assert.equal(fallback.planning?.reason, "network");
  const budget = await metered(repository, project.projectId);
  assert.equal(budget.usedModelRequests, 1);
  assert.equal(budget.unknownUsageRequests, 1);
  assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "planning-fallback").length, 1);
}));

test("streaming gateway accounts reported usage and cancels transport when a consumer stops reading", async () => fixture(async (_root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: limits });
  let cancelled = false;
  const gateway = new ModelGateway({ config: { provider: "custom", model: "fixture", baseUrl: "http://example.test/v1", apiKey: "key", timeoutMs: 1000 }, fetchImpl: async (_url, init) => {
    init?.signal?.addEventListener("abort", () => { cancelled = true; });
    return new Response('data: {"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n');
  } });
  for await (const _event of gateway.streamResponse({ input: "private input" }, undefined, orchestrator.modelAccounting(project.projectId, { phase: "planner" }))) break;
  assert.equal(cancelled, true);
  const budget = await metered(repository, project.projectId);
  assert.equal(budget.reportedTotalTokens, 5);
  assert.equal(budget.usedModelRequests, 1);
}));

test("model proxy cancellation closes the upstream request and settles its usage as unknown", async () => fixture(async (_root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: limits });
  await orchestrator.activatePlan(project.projectId);
  await orchestrator.prepareTaskExecution(project.projectId);
  let received!: () => void;
  const started = new Promise<void>((resolve) => { received = resolve; });
  let ended!: () => void;
  const disconnected = new Promise<void>((resolve) => { ended = resolve; });
  const upstream = createServer(async (request, response) => { for await (const _chunk of request) { /* consume input */ } response.on("close", ended); received(); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const proxy = await startModelBudgetProxy(orchestrator, { projectId: project.projectId, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "private-key" });
  try {
    const pending = fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}` }, body: JSON.stringify({ input: "fixture" }) });
    await started;
    proxy.cancelActiveRequests();
    assert.equal((await pending).status, 504);
    await disconnected;
    await proxy.waitForIdle();
    const budget = await metered(repository, project.projectId);
    assert.equal(budget.usedModelRequests, 1);
    assert.equal(budget.unknownUsageRequests, 1);
    assert.equal(budget.modelRequests[0].status, "settled");
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
}));

test("a late request from a superseded task is rejected without poisoning the model proxy", async () => fixture(async (_root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: limits });
  await orchestrator.activatePlan(project.projectId);
  const prepared = await orchestrator.prepareTaskExecution(project.projectId);
  assert.equal(prepared.allowed, true);
  const proxy = await startModelBudgetProxy(orchestrator, { projectId: project.projectId, baseUrl: "http://127.0.0.1:1", apiKey: "private-key" });
  const reserve = orchestrator.reserveModelRequest.bind(orchestrator);
  orchestrator.reserveModelRequest = async () => { throw new ResearchStaleExecutionError(); };
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ input: "late" }) });
    assert.equal(response.status, 409);
    await proxy.waitForIdle();
  } finally {
    orchestrator.reserveModelRequest = reserve;
    await proxy.close();
  }
  const budget = await metered(repository, project.projectId);
  assert.equal(budget.usedModelRequests, 0);
  assert.equal((await repository.readProject(project.projectId))?.status, "planning");
}));

for (const streaming of [false, true]) test(`model proxy meters ${streaming ? "SSE" : "JSON"}, counts retries and rejects credentials/origin/path violations`, async () => fixture(async (_root, repository, orchestrator) => {
  const { project } = await orchestrator.createProject(plan.question, { plan, budget: { ...limits, maxTaskExecutions: 1, maxModelRequests: 3 } });
  await orchestrator.activatePlan(project.projectId);
  const task = await orchestrator.prepareTaskExecution(project.projectId);
  assert.equal(task.allowed, true);
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    calls += 1;
    assert.equal(request.headers.authorization, "Bearer upstream-private-key");
    assert.equal(request.headers["x-private-header"], undefined);
    let text = ""; for await (const chunk of request) text += chunk;
    assert.equal(JSON.parse(text).max_output_tokens, 64);
    if (calls === 1) { request.socket.destroy(); return; }
    if (calls === 3) { response.writeHead(200, { "content-type": "application/json" }).end('{"output_text":"no usage"}'); return; }
    const result = { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 1 } }, output_text: "response-private-text" };
    response.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" });
    if (streaming) {
      response.write('data: {"type":"response.output_text.delta","delta":"response-private-text"}\r\n\r\n');
      const event = `data: ${JSON.stringify({ type: "response.completed", response: result })}`;
      response.write(event.slice(0, 31)); response.end(event.slice(31));
    } else response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const proxy = await startModelBudgetProxy(orchestrator, { projectId: project.projectId, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "upstream-private-key", maxOutputTokens: 64 });
  const invoke = (extra: Record<string, string> = {}, url = `${proxy.baseUrl}/responses`) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}`, "content-type": "application/json", "x-private-header": "request-private-header", ...extra }, body: JSON.stringify({ input: "request-private-text", stream: streaming, max_output_tokens: 1000 }) });
  try {
    assert.equal((await invoke({ authorization: "Bearer wrong" })).status, 401);
    assert.equal((await invoke({ origin: "null" })).status, 401);
    assert.equal((await invoke({}, `${proxy.baseUrl}/responses?forward=elsewhere`)).status, 404);
    assert.equal(calls, 0);
    assert.equal((await invoke()).status, 502);
    const result = await invoke(); assert.equal(result.status, 200); await result.text();
    const unknown = await invoke(); await unknown.text();
    await proxy.waitForIdle();
    assert.equal(calls, 3);
    let budget = await metered(repository, project.projectId);
    assert.equal(budget.usedTaskExecutions, 1, "the last task quota must allow all of that task's model requests");
    assert.equal(budget.usedModelRequests, 3);
    assert.equal(budget.reportedTotalTokens, 5);
    assert.equal(budget.unknownUsageRequests, 2);
    assert.doesNotMatch(JSON.stringify(budget), /request-private|response-private|upstream-private|x-private/);
    assert.equal((await invoke()).status, 403);
    assert.equal((await invoke()).status, 403, "a retry of a denied request must preserve budget-exhausted rather than becoming a generic failure");
    await assert.rejects(() => proxy.waitForIdle(), ResearchBudgetExhaustedError);
    budget = await metered(repository, project.projectId);
    assert.equal(budget.usedModelRequests, 3);
    assert.equal(calls, 3);
    assert.equal((await repository.readProject(project.projectId))?.status, "paused");
  } finally { await proxy.close(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
}));
