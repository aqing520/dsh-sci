import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { DshResearchTaskExecutor } from "../src/research/dsh-sdk.js";
import { ResearchRunner } from "../src/research/runner.js";
import { parseResearchTaskResult, taskResultIdentity } from "../src/research/task-result.js";
import { buildResearchPlan } from "../src/research/domain.js";
import { taskContractFor, validateTaskCompletion } from "../src/research/task-contract.js";
import { budgetExhaustion } from "../src/research/budget.js";
import { isEncryptedMetadataText } from "../src/metadata-crypto.js";
import { createHash } from "node:crypto";

const { startCaseProviderProxy } = await import(pathToFileURL(path.resolve("scripts/research-case-provider.mjs")).href);
const { inspectCaseCitations } = await import(pathToFileURL(path.resolve("scripts/research-case-quality.mjs")).href);

test("case provider counts retries against a hard request budget and forwards only the configured credential", async () => {
  let upstreamCalls = 0;
  const upstream = createServer(async (request, response) => {
    upstreamCalls += 1;
    assert.equal(request.headers.authorization, "Bearer upstream-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.max_output_tokens, 64);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output_text: "private-provider-content", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startCaseProviderProxy({ config: { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "upstream-secret" }, budget: { maxModelRequests: 1, maxOutputTokensPerRequest: 64, taskTimeoutMs: 2000 }, signal: new AbortController().signal });
  try {
    const call = (apiKey: string) => fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ input: "private-task", max_output_tokens: 1000 }) });
    assert.equal((await call("wrong-credential")).status, 401);
    assert.equal((await call(proxy.apiKey)).status, 200);
    assert.equal((await call(proxy.apiKey)).status, 403);
    assert.equal(upstreamCalls, 1);
    assert.equal(proxy.state.budgetExhausted, true);
    assert.equal(proxy.state.requests.length, 1);
    assert.equal(proxy.state.requests[0].usage.totalTokens, 14);
    for (const secret of ["upstream-secret", "private-task", "private-provider-content", proxy.apiKey]) assert.ok(!JSON.stringify(proxy.state).includes(secret));
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("case provider observes usage from split SSE frames without storing response text", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"response.completed","response":{"usage":{"input_');
    response.end('tokens":6,"output_tokens":3,"total_tokens":9}}}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const proxy = await startCaseProviderProxy({ config: { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "secret" }, budget: { maxModelRequests: 2, maxOutputTokensPerRequest: 64, taskTimeoutMs: 2000 }, signal: controller.signal });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}` }, body: JSON.stringify({ stream: true }) });
    assert.ok((await response.text()).includes("response.completed"));
    assert.equal(proxy.state.requests[0].usage.totalTokens, 9);
    controller.abort();
    const cancelled = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}` }, body: "{}" });
    assert.equal(cancelled.status, 403);
    assert.equal(proxy.state.requests.length, 1);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("case proxy distinguishes local transport failure, timeout and actual upstream HTTP errors without private diagnostics", async (t) => {
  for (const scenario of ["reset", "timeout", "http-502", "redirect", "invalid-request"]) await t.test(scenario, async () => {
    let calls = 0;
    const upstream = createServer((request, response) => {
      calls += 1;
      if (scenario === "reset") { request.socket.destroy(); return; }
      if (scenario === "timeout") return;
      if (scenario === "redirect") { response.writeHead(302, { location: "/private-location-do-not-log" }).end(); return; }
      response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "private-provider-error-do-not-log" }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const proxy = await startCaseProviderProxy({ config: { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, apiKey: "private-upstream-key" }, budget: { maxModelRequests: 1, maxOutputTokensPerRequest: 64, taskTimeoutMs: scenario === "timeout" ? 100 : 2000 }, signal: new AbortController().signal });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${proxy.apiKey}` }, body: scenario === "invalid-request" ? "private-malformed-input" : JSON.stringify({ input: "private-research-question" }) });
      await response.text();
      assert.equal(response.status, 502);
      const entry = proxy.state.requests[0];
      assert.equal(proxy.state.requests.length, 1);
      assert.equal(entry.status, scenario === "http-502" ? 502 : null);
      if (scenario === "http-502") assert.equal(entry.failure, undefined, "upstream HTTP status must not become a local connection failure");
      else {
        assert.equal(entry.failureOrigin, "local-proxy-before-upstream-response");
        assert.equal(entry.failureStage, scenario === "invalid-request" ? "read-client-request" : "upstream-connect-or-headers");
        if (scenario === "reset") assert.equal(entry.transportCode, "UND_ERR_SOCKET");
        if (scenario === "timeout") assert.equal(entry.abortCause, "request-timeout");
      }
      assert.equal(calls, scenario === "invalid-request" ? 0 : 1, "redirects are not followed, and no automatic retry is hidden");
      for (const privateValue of ["private-upstream-key", "private-provider-error-do-not-log", "private-location-do-not-log", "private-research-question", "private-malformed-input", proxy.apiKey]) assert.ok(!JSON.stringify(proxy.state).includes(privateValue));
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

test("SDK retry receives the rejected contract and reuses persisted claim IDs without duplication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-contract-retry-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Correct a result envelope", { plan: { question: "Correct a result envelope", tasks: [{ taskId: "one", title: "One", objective: "Preserve an existing claim reference", kind: "custom", maxAttempts: 2 }] } });
    const claim = await orchestrator.addClaim(project.projectId, { text: "Synthetic fixture, not a scientific finding", claimType: "hypothesis" });
    const prompts: string[] = [];
    const client = {
      async initialize() {}, async createSession() {}, async resume() {}, async close() {}, async wait() {},
      async prompt(_session: string, text: string) { prompts.push(text); return { messageId: "fixture" }; },
      lastAssistantText() { return JSON.stringify({ ...JSON.parse(prompts.at(-1)!.match(/^Exact execution identity: (.+)$/m)![1]), projectId: project.projectId, taskId: "one", status: "completed", summary: "Existing claim retained", refs: [claim.claimId], claims: prompts.length === 1 ? [claim.claimId] : [], evidence: [] }); }
    };
    const result = await new ResearchRunner(orchestrator).run(project.projectId, new DshResearchTaskExecutor({ client, repository }));
    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Exact task-result JSON Schema/);
    assert.match(prompts[1], /claims\[0\] must be an object/);
    assert.match(prompts[1], /Existing claim IDs belong in refs/);
    const snapshot = await repository.exportProject(project.projectId);
    assert.equal(snapshot.claims.length, 1);
    assert.equal(snapshot.events.filter((event) => event.type === "task-completed").length, 1);
    assert.deepEqual(snapshot.plan?.tasks[0].outputRefs, [claim.claimId]);
    assert.equal(snapshot.plan?.tasks[0].error, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task result rejects unsupported schema and oversized reference lists rather than silently dropping entries", () => {
  const base = { planId: "plan", attemptId: "attempt", submissionId: "submission", expectedTaskVersion: 1, projectId: "project", taskId: "task", status: "completed", summary: "fixture" };
  assert.throws(() => parseResearchTaskResult({ ...base, schema: "invented.v99" }), /unsupported/);
  assert.throws(() => parseResearchTaskResult({ ...base, refs: Array.from({ length: 201 }, (_, index) => `ref-${index}`) }), /at most 200/);
});

test("citation diagnostics distinguish ordered omissions from invented or reordered quotes", () => {
  const checks = inspectCaseCitations({ sources: [{ sourceId: "source", excerpt: "First statement. Middle detail. Final statement." }], citations: [
    { citationId: "one", sourceId: "source", quotedText: "First statement.", locator: "paragraph 1" },
    { citationId: "two", sourceId: "source", quotedText: "First statement. ... Final statement." },
    { citationId: "three", sourceId: "source", quotedText: "Final statement. ... First statement." },
    { citationId: "four", sourceId: "source", quotedText: "Invented statement" },
    { citationId: "five", sourceId: "missing", quotedText: "First statement." }
  ] });
  assert.deepEqual(checks.map((check: { match: string }) => check.match), ["verbatim-in-stored-excerpt", "ordered-ellipsis-fragments-in-stored-excerpt", "not-verified-in-stored-excerpt", "not-verified-in-stored-excerpt", "source-missing"]);
  assert.ok(checks.every((check: { supportReview: string }) => check.supportReview === "required"));
});

test("task contracts add structural requirements and cannot be weakened by a custom proposal", () => {
  const plan = buildResearchPlan("Contract fixture", { question: "Contract fixture", tasks: [
    { taskId: "sources", title: "Sources", objective: "Read sources", kind: "research", successCriteria: ["At least one source"] },
    { taskId: "hypothesis", title: "Hypothesis", objective: "Make a hypothesis", kind: "hypothesis" },
    { taskId: "run", title: "Run", objective: "Run approved code", kind: "experiment", requiresApproval: true }
  ] });
  assert.deepEqual(taskContractFor("research").requiredOutputs, ["source", "citation"]);
  assert.ok(plan.tasks[0].successCriteria?.some((value) => /persisted source/i.test(value)));
  assert.ok(plan.tasks[0].allowedActions?.includes("reference"));
  assert.ok(plan.tasks[2].completionContract?.requiredOutputs.includes("completed-run"));
  const weakened = { ...plan.tasks[1], completionContract: { schema: "dsh-sci.research-task-contract.v1" as const, requiredOutputs: [] } };
  assert.throws(() => validateTaskCompletion({ sources: [], sourceContents: [], sourceReads: [], searchLogs: [], evidenceReviews: [], sourceAcquisitions: [], citations: [], claims: [], evidence: [], experiments: [], experimentRuns: [], artifacts: [], evaluations: [], reports: [], project: { } as any, events: [] }, weakened, []), /hypothesis/);
});

test("task completion rejects invented and foreign-project refs before persisting any claims", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-output-ref-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Resolve all output IDs", { plan: { question: "Resolve all output IDs", tasks: [{ taskId: "one", title: "One", objective: "Keep provenance", kind: "custom" }] } });
    const other = await orchestrator.createProject("Other project");
    const foreign = await orchestrator.addSource(other.project.projectId, { title: "Foreign fixture", url: "https://example.test/foreign" });
    await orchestrator.activatePlan(project.projectId);
    await orchestrator.startNextTask(project.projectId);
    const identity = taskResultIdentity((await repository.exportProject(project.projectId)).plan!.tasks[0]);
    for (const ref of ["unregistered-notes.md", foreign.sourceId]) {
      await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, { ...identity, projectId: project.projectId, taskId: "one", status: "completed", summary: "Invalid output", refs: [ref], claims: [{ text: "Must not be written" }] }), /reference at index 0 was not found/);
    }
    await assert.rejects(() => orchestrator.completeTask(project.projectId, "one", ["invented-id"]), /reference at index 0 was not found/);
    const snapshot = await repository.exportProject(project.projectId);
    assert.equal(snapshot.claims.length, 0);
    assert.equal(snapshot.plan?.tasks[0].status, "running");
    assert.equal(snapshot.events.filter((event) => event.type === "task-result-submitted").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed runs may be documented as context but cannot confirm or refute scientific claims", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-evidence-run-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root, allowedCommands: [process.execPath] } });
    const { project } = await orchestrator.createProject("Do not treat execution failure as science");
    const claim = await orchestrator.addClaim(project.projectId, { text: "Execution failure is not a valid measurement", claimType: "hypothesis" });
    const experiment = await orchestrator.createExperiment(project.projectId, { title: "Expected fixture failure", command: process.execPath, args: ["-e", "process.exit(2)"], cwd: root });
    await orchestrator.approveExperiment(project.projectId, experiment.experimentId, experiment.proposalContentHash!);
    const run = await orchestrator.executeExperiment(project.projectId, experiment.experimentId, { approved: true });
    assert.equal(run.state, "failed");
    for (const relation of ["supports", "refutes"] as const) await assert.rejects(() => orchestrator.addEvidence(project.projectId, { claimId: claim.claimId, relation, experimentRef: run.runId }), /only a completed experiment run/);
    await assert.rejects(() => orchestrator.addEvidence(project.projectId, { claimId: claim.claimId, relation: "context", artifactRef: "unregistered.txt" }), /artifact reference was not found/);
    const context = await orchestrator.addEvidence(project.projectId, { claimId: claim.claimId, relation: "context", experimentRef: run.runId });
    assert.equal(context.relation, "context");
    assert.equal((await repository.listEvidenceLinks(project.projectId)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source-review completion checks real citation outputs before any new claims or completion events are written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-completion-gate-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("A summary is not source review", { plan: { question: "A summary is not source review", tasks: [{ taskId: "read", title: "Read", objective: "Read a source with a citation", kind: "source-review" }] } });
    await orchestrator.activatePlan(project.projectId);
    await orchestrator.startNextTask(project.projectId);
    const result = { ...taskResultIdentity((await repository.exportProject(project.projectId)).plan!.tasks[0]), projectId: project.projectId, taskId: "read", status: "completed", summary: "Unsupported completion", claims: [{ text: "Do not persist this incomplete result" }] };
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, result), /missing required outputs: source, citation/);
    await assert.rejects(() => orchestrator.completeTask(project.projectId, "read"), /missing required outputs/);
    assert.equal((await repository.listClaims(project.projectId)).length, 0);
    assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "task-result-submitted").length, 0);
    const file = path.join(root, "fixture.txt");
    await writeFile(file, "One verifiable fixture sentence.");
    const { source } = await orchestrator.ingestDocument(project.projectId, file);
    const read = await orchestrator.readSource(project.projectId, { sourceId: source.sourceId }, "agent");
    const citation = await orchestrator.addCitation(project.projectId, source.sourceId, { contentVersionId: read.content.contentVersionId, locator: { chunkId: read.chunks[0].chunkId }, quotedText: "One verifiable fixture sentence." });
    await orchestrator.submitTaskResult(project.projectId, { ...result, refs: [citation.citationId], claims: [] });
    assert.equal((await repository.exportProject(project.projectId)).plan?.tasks[0].status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("old plans remain readable without silently gaining completion contracts and automatic execution stops", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-legacy-contract-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project, plan } = await orchestrator.createProject("Legacy contract fixture");
    for (const task of plan.tasks) { delete task.completionContract; delete task.allowedActions; delete task.successCriteria; }
    await repository.savePlan(plan);
    const legacy = await repository.readPlan(project.projectId, plan.planId);
    assert.equal(legacy?.protocolReviewRequired, true);
    assert.equal(legacy?.tasks[0].completionContract, undefined);
    let calls = 0;
    const run = await new ResearchRunner(orchestrator).run(project.projectId, { async execute() { calls += 1; throw new Error("must not execute"); } });
    assert.equal(run.status, "blocked");
    assert.equal(calls, 0);
    await assert.rejects(() => orchestrator.activatePlan(project.projectId), /Legacy research plan/);
    const replanned = await orchestrator.replan(project.projectId);
    assert.ok(replanned.plan.tasks.every((task) => task.completionContract));
    assert.equal((await repository.readPlan(project.projectId, plan.planId))?.status, "superseded");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project budget counts retries, survives restart and replanning, and requires explicit extension", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-budget-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Budgeted synthetic run", { budget: { maxTaskExecutions: 1, maxWallTimeMs: 60_000 }, plan: { question: "Budgeted synthetic run", tasks: [{ taskId: "one", title: "One", objective: "Retry bounded work", kind: "custom", maxAttempts: 3 }] } });
    let calls = 0;
    const first = await new ResearchRunner(orchestrator).run(project.projectId, { execute: async () => { calls += 1; throw new Error("fixture retry"); } });
    assert.equal(first.status, "budget-exhausted");
    assert.equal(calls, 1);
    assert.equal(first.plan.tasks[0].attempts, 1, "budget rejection must not start an unexecuted retry");
    assert.equal(first.plan.tasks[0].status, "ready");
    assert.equal((await repository.readBudget(project.projectId))?.usedTaskExecutions, 1);
    const reopened = new ResearchOrchestrator(new ResearchRepository(root));
    await assert.rejects(() => reopened.resume(project.projectId), /budget exhausted/);
    const second = await new ResearchRunner(reopened).run(project.projectId, { execute: async () => { throw new Error("must not run"); } });
    assert.equal(second.status, "budget-exhausted");
    assert.equal((await reopened.repository.listEvents(project.projectId)).filter((event) => event.type === "research-budget-exhausted").length, 1);
    await reopened.replan(project.projectId);
    assert.equal((await reopened.repository.readBudget(project.projectId))?.usedTaskExecutions, 1);
    const updated = await reopened.updateBudget(project.projectId, { maxTaskExecutions: 2, maxWallTimeMs: 60_000 });
    assert.equal(updated.usedTaskExecutions, 1);
    assert.equal(updated.startedAt, (await repository.readBudget(project.projectId))?.startedAt);
    assert.equal(budgetExhaustion(updated), undefined);
    await reopened.resume(project.projectId);
    assert.equal((await reopened.repository.readBudget(project.projectId))?.usedTaskExecutions, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authorized wall-clock restart preserves the ledger and clears the prior deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-wall-restart-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Wall restart fixture", {
      budget: { maxTaskExecutions: 3, maxWallTimeMs: 60_000, maxModelRequests: 5, maxModelTokens: 10_000 },
      plan: { question: "Wall restart fixture", tasks: [{ taskId: "one", title: "One", objective: "Preserve ledger", kind: "custom" }] },
    });
    await repository.mutateBudget(project.projectId, (budget) => ({ ...budget!, startedAt: "2020-01-01T00:00:00.000Z", exhausted: "wall-time" }));
    const before = await repository.readBudget(project.projectId);
    assert.ok(before && before.schema === "dsh-sci.research-budget.v2");
    assert.equal(before?.usedTaskExecutions, 0);
    assert.equal(before?.usedModelRequests, 0);
    const restarted = await orchestrator.updateBudget(project.projectId, { maxTaskExecutions: 3, maxWallTimeMs: 1_800_000, maxModelRequests: 5, maxModelTokens: 10_000 }, { restartWallClock: true });
    assert.equal(restarted.schema, "dsh-sci.research-budget.v2");
    assert.equal(restarted.usedTaskExecutions, before?.usedTaskExecutions);
    assert.equal(restarted.usedModelRequests, before?.usedModelRequests);
    assert.equal(restarted.reportedTotalTokens, before?.reportedTotalTokens);
    assert.equal(restarted.exhausted, undefined);
    assert.notEqual(restarted.startedAt, before?.startedAt);
    assert.equal(budgetExhaustion(restarted), undefined);
    const events = await repository.listEvents(project.projectId);
    const update = events.filter((event) => event.type === "research-budget-updated").at(-1);
    assert.equal(update?.data?.wallClockRestarted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy project without a budget is blocked before a task starts and can be configured explicitly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-missing-budget-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Budget migration", { plan: { question: "Budget migration", tasks: [{ taskId: "one", title: "One", objective: "Explicit limits", kind: "custom" }] } });
    await rm(path.join(root, "projects", project.projectId, "budget.json"));
    const runner = new ResearchRunner(orchestrator);
    const executor = { execute: async () => { throw new Error("must not execute"); } };
    const blocked = await runner.run(project.projectId, executor);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason!, /explicit budget configuration/);
    assert.equal(blocked.plan.tasks[0].attempts, 0);
    assert.equal(blocked.plan.tasks[0].status, "ready");
    assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "task-started").length, 0);
    await orchestrator.updateBudget(project.projectId, { maxTaskExecutions: 2, maxWallTimeMs: 60_000, maxModelRequests: 10, maxModelTokens: 10000 });
    assert.equal((await repository.exportProject(project.projectId)).budget?.usedTaskExecutions, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("waiting for task approval does not reserve budget or start its wall clock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-approval-budget-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Approval budget", { plan: { question: "Approval budget", tasks: [{ taskId: "one", title: "One", objective: "Wait for approval", kind: "custom", requiresApproval: true }] } });
    const result = await new ResearchRunner(orchestrator).run(project.projectId, { execute: async () => { throw new Error("must not run before approval"); } });
    assert.equal(result.status, "waiting-approval");
    const budget = await repository.readBudget(project.projectId);
    assert.equal(budget?.usedTaskExecutions, 0);
    assert.equal(budget?.startedAt, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository rejects corrupted and cross-project budget files instead of granting fresh limits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-corrupt-budget-"));
  try {
    const repository = new ResearchRepository(root);
    const { project } = await new ResearchOrchestrator(repository).createProject("Budget validation");
    const original = await repository.readBudget(project.projectId);
    const file = path.join(root, "projects", project.projectId, "budget.json");
    for (const change of [{ schema: "unknown" }, { projectId: "other-project" }, { revision: -1 }, { usedTaskExecutions: -1 }, { usedTaskExecutions: 1, startedAt: undefined }, { updatedAt: "invalid" }, { exhausted: "unknown" }]) {
      await writeFile(file, JSON.stringify({ ...original, ...change }));
      await assert.rejects(() => repository.readBudget(project.projectId), /research budget/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persisted wall deadline cancels a task and rejects a late result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-wall-budget-"));
  try {
    const orchestrator = new ResearchOrchestrator(new ResearchRepository(root));
    const { project } = await orchestrator.createProject("Wall time fixture", { budget: { maxTaskExecutions: 3, maxWallTimeMs: 30 }, plan: { question: "Wall time fixture", tasks: [{ taskId: "one", title: "One", objective: "Stop on deadline", kind: "custom" }] } });
    let aborted = false;
    const result = await new ResearchRunner(orchestrator).run(project.projectId, { async execute({ task }, signal) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      aborted = Boolean(signal?.aborted);
      return { ...taskResultIdentity(task), projectId: project.projectId, taskId: task.taskId, status: "completed", summary: "Too late" };
    } });
    assert.equal(result.status, "budget-exhausted");
    assert.equal(aborted, true);
    assert.equal(result.project.status, "paused");
    assert.equal(result.plan.tasks[0].status, "running");
    assert.equal((await orchestrator.repository.listEvents(project.projectId)).filter((event) => event.type === "task-completed").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task results are bound to one plan attempt and duplicate submissions are idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-result-identity-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project, plan } = await orchestrator.createProject("Versioned result", { plan: { question: "Versioned result", tasks: [{ taskId: "one", title: "One", objective: "Complete once", kind: "custom" }] } });
    await orchestrator.activatePlan(project.projectId);
    const started = await orchestrator.startNextTask(project.projectId);
    const task = started.task;
    const source = await orchestrator.addSource(project.projectId, { title: "Concurrent result fixture" });
    const result = { schema: "dsh-sci.research-task-result.v2", projectId: project.projectId, taskId: task.taskId, planId: plan.planId, attemptId: task.attemptId, submissionId: `result-${task.attemptId}`, expectedTaskVersion: task.stateVersion, status: "completed", summary: "Completed once", refs: [], claims: [{ text: "A concurrent fixture statement" }], evidence: [{ claimIndex: 0, relation: "context", sourceId: source.sourceId }] };
    const [first, second] = await Promise.all([orchestrator.submitTaskResult(project.projectId, result), orchestrator.submitTaskResult(project.projectId, result)]);
    assert.deepEqual(second, first);
    const reopened = new ResearchOrchestrator(new ResearchRepository(root));
    assert.deepEqual(await reopened.submitTaskResult(project.projectId, result), first);
    assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "task-completed").length, 1);
    assert.equal((await repository.listClaims(project.projectId)).length, 1);
    assert.equal((await repository.listEvidenceLinks(project.projectId)).length, 1);
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, { ...result, summary: "Changed after commit" }), /different immutable result/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unversioned, wrong-plan, stale-attempt and stale-version results cannot write research records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-stale-result-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("No stale writes", { plan: { question: "No stale writes", tasks: [{ taskId: "one", title: "One", objective: "Current attempt only", kind: "custom" }] } });
    await orchestrator.activatePlan(project.projectId);
    const first = await orchestrator.startNextTask(project.projectId);
    const oldIdentity = taskResultIdentity(first.task);
    const base = { projectId: project.projectId, taskId: "one", status: "completed", summary: "Stale result", claims: [{ text: "Must never be persisted" }] };
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, base), /planId/);
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, { ...base, ...oldIdentity, planId: "other-plan" }), /planId/);
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, { ...base, ...oldIdentity, expectedTaskVersion: oldIdentity.expectedTaskVersion + 1 }), /stale execution/);
    await orchestrator.failTask(project.projectId, "one", "retry fixture");
    const second = await orchestrator.startNextTask(project.projectId);
    assert.notEqual(second.task.attemptId, first.task.attemptId);
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, { ...base, ...oldIdentity }), /stale execution/);
    const latest = taskResultIdentity(second.task);
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, { ...base, ...latest, schema: "dsh-sci.research-task-result.v1" }), /unsupported/);
    assert.equal((await repository.listClaims(project.projectId)).length, 0);
    assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "task-result-submitted").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("late executor result and exception cannot fail a replanned task with the same task ID", async () => {
  for (const throws of [false, true]) {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-replan-result-"));
    try {
      const repository = new ResearchRepository(root);
      const input = { question: "Replan race", tasks: [{ taskId: "one", title: "One", objective: "Current plan only", kind: "custom" as const }] };
      const orchestrator = new ResearchOrchestrator(repository, {}, { name: "fixture-planner", async plan() { return input; } });
      const { project } = await orchestrator.createProject(input.question, { plan: input });
      const result = await new ResearchRunner(orchestrator).run(project.projectId, { async execute({ task }) {
        await orchestrator.replan(project.projectId);
        await orchestrator.activatePlan(project.projectId);
        await orchestrator.startNextTask(project.projectId);
        if (throws) throw new Error("Old transport failed");
        return { ...taskResultIdentity(task), projectId: project.projectId, taskId: task.taskId, status: "completed", summary: "Old plan result", claims: [{ text: "Must not be written" }] };
      } });
      assert.equal(result.status, "blocked");
      assert.equal(result.plan.tasks[0].status, "running");
      assert.equal(result.plan.tasks[0].attempts, 1);
      assert.equal((await repository.listClaims(project.projectId)).length, 0);
      assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "task-failed").length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("accepted result journals recover after each write boundary without repeating records or model work", async (t) => {
  for (const boundary of ["journal", "claim", "evidence", "plan", "project", "event", "receipt"] as const) await t.test(boundary, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-result-journal-"));
    try {
      const repository = new ResearchRepository(root);
      const orchestrator = new ResearchOrchestrator(repository);
      const { project } = await orchestrator.createProject("Recover accepted result", { plan: { question: "Recover accepted result", tasks: [{ taskId: "one", title: "One", objective: "Exactly one committed result", kind: "custom" }] } });
      const source = await orchestrator.addSource(project.projectId, { title: "Journal fixture", excerpt: "One fixture statement" });
      let calls = 0;
      let submitted: unknown;
      const original = {
        journal: repository.saveResultCommit.bind(repository), claim: repository.saveClaim.bind(repository), evidence: repository.saveEvidenceLink.bind(repository), plan: repository.savePlan.bind(repository), project: repository.saveProject.bind(repository), event: repository.appendEvent.bind(repository),
      };
      let armed = false;
      let injected = false;
      const inject = () => { if (armed && !injected) { injected = true; throw new Error(`Injected post-${boundary} failure`); } };
      repository.saveResultCommit = async (commit) => { await original.journal(commit); if ((boundary === "journal" && commit.status === "prepared") || (boundary === "receipt" && commit.status === "committed")) inject(); };
      repository.saveClaim = async (claim) => { await original.claim(claim); if (boundary === "claim") inject(); };
      repository.saveEvidenceLink = async (link) => { await original.evidence(link); if (boundary === "evidence") inject(); };
      repository.savePlan = async (plan) => { await original.plan(plan); if (boundary === "plan") inject(); };
      repository.saveProject = async (value) => { await original.project(value); if (boundary === "project") inject(); };
      repository.appendEvent = async (event) => { await original.event(event); if (boundary === "event") inject(); };
      const interrupted = await new ResearchRunner(orchestrator).run(project.projectId, { async execute({ task }) {
        calls += 1;
        submitted = { ...taskResultIdentity(task), projectId: project.projectId, taskId: task.taskId, status: "completed", summary: "One accepted fixture", claims: [{ text: "One fixture statement" }], evidence: [{ claimIndex: 0, relation: "context", sourceId: source.sourceId }] };
        armed = true;
        return submitted;
      } });
      assert.equal(interrupted.status, "blocked");
      assert.equal(injected, true);
      assert.equal(calls, 1);
      const reopened = new ResearchOrchestrator(new ResearchRepository(root));
      const resumed = await new ResearchRunner(reopened).run(project.projectId, { async execute() { calls += 1; throw new Error("must recover without model work"); } });
      assert.equal(resumed.status, "completed");
      assert.equal(calls, 1);
      await reopened.submitTaskResult(project.projectId, submitted);
      const snapshot = await reopened.repository.exportProject(project.projectId);
      assert.equal(snapshot.claims.length, 1);
      assert.equal(snapshot.evidence.length, 1);
      for (const type of ["task-result-submitted", "claim-added", "evidence-linked", "task-completed", "project-completed"]) assert.equal(snapshot.events.filter((event) => event.type === type).length, 1, type);
      assert.equal(snapshot.budget?.usedTaskExecutions, 1);
      const receipt = await reopened.repository.readResultCommit(project.projectId, (submitted as any).submissionId);
      assert.equal(receipt?.status, "committed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("a real process exit during result persistence recovers plaintext and encrypted journals", async (t) => {
  for (const encrypted of [false, true]) await t.test(encrypted ? "encrypted" : "plaintext", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-process-result-"));
    try {
      const options = encrypted ? { metadataPassphrase: "test-result-journal-passphrase" } : {};
      const repository = new ResearchRepository(root, options);
      const orchestrator = new ResearchOrchestrator(repository);
      const { project } = await orchestrator.createProject("Crash journal fixture", { plan: { question: "Crash journal fixture", tasks: [{ taskId: "one", title: "One", objective: "Recover without another model run", kind: "custom" }] } });
      await orchestrator.activatePlan(project.projectId);
      const started = await orchestrator.startNextTask(project.projectId);
      const result = { ...taskResultIdentity(started.task), projectId: project.projectId, taskId: started.task.taskId, status: "completed", summary: "Recovered process fixture", claims: [{ text: "A fixture claim saved exactly once" }] };
      const child = path.join(root, "crash-result.mjs");
      const repositoryUrl = pathToFileURL(path.resolve("src/research/repository.ts")).href;
      const orchestratorUrl = pathToFileURL(path.resolve("src/research/orchestrator.ts")).href;
      await writeFile(child, `import { ResearchRepository } from ${JSON.stringify(repositoryUrl)};
import { ResearchOrchestrator } from ${JSON.stringify(orchestratorUrl)};
const repository = new ResearchRepository(${JSON.stringify(root)}, ${JSON.stringify(options)});
const original = repository.saveClaim.bind(repository);
repository.saveClaim = async (claim) => { await original(claim); process.exit(37); };
await new ResearchOrchestrator(repository).submitTaskResult(${JSON.stringify(project.projectId)}, ${JSON.stringify(result)});
process.exit(2);
`);
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const process = spawn(globalThis.process.execPath, ["--import", "tsx", child], { cwd: globalThis.process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        let diagnostics = "";
        process.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
        const timer = setTimeout(() => { process.kill(); reject(new Error("Result crash child timed out")); }, 10_000);
        process.once("error", (error) => { clearTimeout(timer); reject(error); });
        process.once("close", (code) => { clearTimeout(timer); if (code !== 37) reject(new Error(`Result crash child exited ${code}: ${diagnostics}`)); else resolve(code); });
      });
      assert.equal(exitCode, 37);
      const reopened = new ResearchRepository(root, options);
      assert.equal((await reopened.listClaims(project.projectId)).length, 1);
      assert.equal((await reopened.readResultCommit(project.projectId, result.submissionId))?.status, "prepared");
      const key = createHash("sha256").update(result.submissionId).digest("hex");
      const journalText = await readFile(path.join(root, "projects", project.projectId, "result-commits", key + ".json"), "utf8");
      assert.equal(isEncryptedMetadataText(journalText), encrypted);
      if (encrypted) assert.equal(journalText.includes("A fixture claim"), false);
      await reopened.recoverInterruptedExperiments();
      const recovered = await new ResearchRunner(new ResearchOrchestrator(reopened)).run(project.projectId, { async execute() { throw new Error("must not rerun model after committed recovery"); } });
      assert.equal(recovered.status, "completed");
      assert.equal((await reopened.listClaims(project.projectId)).length, 1);
      assert.equal((await reopened.listEvents(project.projectId)).filter((event) => event.type === "task-completed").length, 1);
      assert.equal((await reopened.readResultCommit(project.projectId, result.submissionId))?.status, "committed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("failure before the acceptance journal creates no research records and a new invocation gets a fresh identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-unaccepted-result-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Unaccepted retry", { plan: { question: "Unaccepted retry", tasks: [{ taskId: "one", title: "One", objective: "Commit only accepted records", kind: "custom" }] } });
    const original = repository.saveResultCommit.bind(repository);
    repository.saveResultCommit = async (commit) => { repository.saveResultCommit = original; throw new Error("Injected failure before journal acceptance"); };
    let stale: any;
    let calls = 0;
    const first = await new ResearchRunner(orchestrator).run(project.projectId, { async execute({ task }) {
      calls += 1;
      stale = { ...taskResultIdentity(task), projectId: project.projectId, taskId: task.taskId, status: "completed", summary: "Not accepted", claims: [{ text: "Not accepted" }] };
      return stale;
    } });
    assert.equal(first.status, "blocked");
    assert.equal(await repository.hasPendingResultCommit(project.projectId), false);
    assert.equal((await repository.listClaims(project.projectId)).length, 0);
    const result = await new ResearchRunner(orchestrator).run(project.projectId, { async execute({ task }) {
      calls += 1;
      assert.notEqual(task.attemptId, stale.attemptId);
      await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, stale), /stale execution/);
      return { ...taskResultIdentity(task), projectId: project.projectId, taskId: task.taskId, status: "completed", summary: "Accepted retry" };
    } });
    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal((await repository.readBudget(project.projectId))?.usedTaskExecutions, 2);
    assert.equal((await repository.listClaims(project.projectId)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("idempotent receipts for failed, blocked and approval results do not repeat state transitions", async (t) => {
  for (const status of ["failed", "blocked", "needs-approval"] as const) await t.test(status, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-result-status-"));
    try {
      const repository = new ResearchRepository(root);
      const orchestrator = new ResearchOrchestrator(repository);
      const { project } = await orchestrator.createProject("Result status fixture", { plan: { question: "Result status fixture", tasks: [{ taskId: "one", title: "One", objective: "One transition", kind: "custom" }] } });
      await orchestrator.activatePlan(project.projectId);
      const started = await orchestrator.startNextTask(project.projectId);
      const result = { ...taskResultIdentity(started.task), projectId: project.projectId, taskId: started.task.taskId, status, summary: "Explicit status fixture", nextAction: "Review fixture" };
      const accepted = await orchestrator.submitTaskResult(project.projectId, result);
      assert.deepEqual(await orchestrator.submitTaskResult(project.projectId, result), accepted);
      if (status === "failed") {
        const retry = await orchestrator.startNextTask(project.projectId);
        await orchestrator.submitTaskResult(project.projectId, result);
        const task = (await repository.exportProject(project.projectId)).plan!.tasks[0];
        assert.equal(task.status, "running");
        assert.equal(task.attemptId, retry.task.attemptId);
      }
      assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "task-result-submitted").length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("corrupt result journals block execution instead of being skipped or assigned a new receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-corrupt-result-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Journal validation", { plan: { question: "Journal validation", tasks: [{ taskId: "one", title: "One", objective: "Validate journal before work", kind: "custom" }] } });
    await orchestrator.activatePlan(project.projectId);
    const started = await orchestrator.startNextTask(project.projectId);
    const result = { ...taskResultIdentity(started.task), projectId: project.projectId, taskId: started.task.taskId, status: "completed", summary: "Fixture receipt" };
    await orchestrator.submitTaskResult(project.projectId, result);
    const key = createHash("sha256").update(result.submissionId).digest("hex");
    const file = path.join(root, "projects", project.projectId, "result-commits", key + ".json");
    const valid = JSON.parse(await readFile(file, "utf8"));
    for (const corrupt of [null, { ...valid, payloadHash: "incorrect" }, { ...valid, projectId: "another-project" }]) {
      await writeFile(file, JSON.stringify(corrupt));
      let called = false;
      await assert.rejects(() => new ResearchRunner(new ResearchOrchestrator(new ResearchRepository(root))).run(project.projectId, { async execute() { called = true; } }), /Invalid research result commit journal/);
      assert.equal(called, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
