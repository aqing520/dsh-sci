import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { researchActions, startResearchBridge } from "../src/research/bridge.js";
import { makeEvent } from "../src/research/domain.js";

test("concurrent research audit events retain every accepted and rejected action", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-event-writes-"));
  try {
    const repository = new ResearchRepository(root);
    const { project } = await new ResearchOrchestrator(repository).createProject("Retain concurrent audit records");
    const events = Array.from({ length: 30 }, (_, index) => makeEvent(project.projectId, index % 2 ? "research-action-accepted" : "research-action-rejected"));
    await Promise.all(events.map((event) => repository.appendEvent(event)));
    const saved = await repository.listEvents(project.projectId);
    for (const event of events) assert.equal(saved.filter((record) => record.eventId === event.eventId).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("approval queue survives restart and keeps task approval separate from experiment execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-approval-"));
  try {
    const repository = new ResearchRepository(path.join(root, "store"));
    const orchestrator = new ResearchOrchestrator(repository);
    const first = await orchestrator.createProject("First experiment", { plan: { question: "First experiment", tasks: [{ taskId: "experiment", title: "Run experiment", objective: "Compare data", kind: "experiment", requiresApproval: true }] } });
    const second = await orchestrator.createProject("Second experiment", { plan: { question: "Second experiment", tasks: [{ taskId: "other", title: "Review", objective: "Review data", requiresApproval: true }] } });
    for (const item of [first, second]) { await orchestrator.activatePlan(item.project.projectId); await orchestrator.startNextTask(item.project.projectId); }
    const experiment = await orchestrator.createExperiment(first.project.projectId, { title: "Count samples", taskId: "experiment", command: process.execPath, args: ["-e", "console.log(42)"], cwd: root });
    const reopened = new ResearchOrchestrator(new ResearchRepository(repository.root));
    const queue = await reopened.listApprovalQueue();
    assert.equal(queue.filter((item) => item.kind === "task").length, 2);
    assert.equal(queue.filter((item) => item.kind === "experiment").length, 1);
    await assert.rejects(() => reopened.executeExperiment(first.project.projectId, experiment.experimentId, { approved: true }), /task requires approval/);
    await reopened.approveTask(first.project.projectId, "experiment");
    assert.equal((await repository.listExperimentRuns(first.project.projectId)).length, 0);
    await assert.rejects(() => reopened.executeExperiment(first.project.projectId, experiment.experimentId), /explicit approval/);
    await reopened.approveExperiment(first.project.projectId, experiment.experimentId, experiment.proposalContentHash!);
    const run = await reopened.executeExperiment(first.project.projectId, experiment.experimentId, { approved: true });
    assert.equal(run.state, "completed");
    assert.match(run.stdout, /42/);
    const remaining = await reopened.listApprovalQueue();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].project.projectId, second.project.projectId);
    const event = (await repository.listEvents(first.project.projectId)).find((event) => event.type === "experiment-started");
    assert.equal(event?.data?.approved, true);
    assert.equal(event?.taskId, "experiment");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("experiment proposals from superseded plans cannot use approvals from a newer plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-stale-approval-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Replan an experiment");
    const experiment = await orchestrator.createExperiment(project.projectId, { title: "Old proposal", command: process.execPath, args: ["-e", "console.log(42)"] });
    await orchestrator.replan(project.projectId);
    assert.equal((await orchestrator.listApprovalQueue()).length, 0);
    await assert.rejects(() => orchestrator.executeExperiment(project.projectId, experiment.experimentId, { approved: true }), /superseded plan/);
    assert.equal((await repository.listExperimentRuns(project.projectId)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing report reads do not write reports or events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-report-read-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Read a saved report");
    await assert.rejects(() => orchestrator.readReport(project.projectId), /no generated report/);
    const report = await orchestrator.generateReport(project.projectId);
    const eventsBefore = await readFile(path.join(root, "projects", project.projectId, "events.jsonl"), "utf8");
    const reopened = new ResearchOrchestrator(new ResearchRepository(root));
    assert.deepEqual(await reopened.readReport(project.projectId), report);
    assert.deepEqual(await reopened.readReport(project.projectId, report.reportId), report);
    await assert.rejects(() => reopened.readReport(project.projectId, "missing"), /not found/);
    assert.equal((await repository.listReports(project.projectId)).length, 1);
    assert.equal(await readFile(path.join(root, "projects", project.projectId, "events.jsonl"), "utf8"), eventsBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("experiment execution rejects concurrent duplicate starts and paused projects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-duplicate-experiment-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Avoid duplicate experiment launches");
    const experiment = await orchestrator.createExperiment(project.projectId, { title: "Wait briefly", command: process.execPath, args: ["-e", "setTimeout(() => console.log('done'), 100)"], cwd: root });
    await orchestrator.approveExperiment(project.projectId, experiment.experimentId, experiment.proposalContentHash!);
    const first = orchestrator.executeExperiment(project.projectId, experiment.experimentId, { approved: true });
    await assert.rejects(() => orchestrator.executeExperiment(project.projectId, experiment.experimentId, { approved: true }), /already running/);
    assert.equal((await first).state, "completed");
    assert.equal((await repository.listExperimentRuns(project.projectId)).length, 1);
    await orchestrator.pause(project.projectId);
    await assert.rejects(() => orchestrator.executeExperiment(project.projectId, experiment.experimentId, { approved: true }), /resumed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic bridge audits allowed and denied actions without copying request bodies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-action-audit-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Audit task permissions", { plan: { question: "Audit task permissions", tasks: [{ taskId: "design", title: "Design", objective: "Propose an experiment without execution", kind: "experiment-design" }] } });
    await orchestrator.activatePlan(project.projectId);
    const { task } = await orchestrator.startNextTask(project.projectId);
    const bridge = await startResearchBridge(orchestrator, { runnerProjectId: project.projectId });
    const post = (input: object) => fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    try {
      assert.equal((await post({ action: "context" })).status, 200);
      assert.equal((await post({ action: "memory-review", projectId: "other-project", note: "secret-token-value" })).status, 400);
      assert.equal((await post({ action: "experiment", title: "Proposed only", command: process.execPath })).status, 200);
      assert.equal((await repository.listExperiments(project.projectId))[0].taskId, task.taskId);
      assert.equal((await repository.listExperimentRuns(project.projectId)).length, 0);
      const audit = (await repository.listEvents(project.projectId)).filter((event) => event.type.startsWith("research-action-"));
      assert.deepEqual(audit.map((event) => event.type), ["research-action-accepted", "research-action-rejected", "research-action-accepted"]);
      assert.equal(audit.every((event) => event.taskId === task.taskId && event.data?.actor === "automatic-runner"), true);
      assert.doesNotMatch(JSON.stringify(audit), /secret-token-value|other-project/);
      assert.equal(await repository.readProject("other-project"), undefined);
    } finally { await bridge.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task completion audit retains the task that received the action", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-task-audit-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Keep accurate task attribution");
    await orchestrator.activatePlan(project.projectId);
    const { task } = await orchestrator.startNextTask(project.projectId);
    const bridge = await startResearchBridge(orchestrator);
    try {
      const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "complete", projectId: project.projectId, taskId: task.taskId }) });
      assert.equal(response.status, 200);
      const audit = (await repository.listEvents(project.projectId)).find((event) => event.type === "research-action-accepted");
      assert.equal(audit?.taskId, task.taskId);
      assert.notEqual((await repository.readProject(project.projectId))?.activeTaskId, task.taskId);
    } finally { await bridge.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bridge writes bounded global security audits for unauthenticated and projectless requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-security-audit-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const bridge = await startResearchBridge(orchestrator, { maxRequestsPerMinute: 10 });
    try {
      const unauthenticated = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) });
      assert.equal(unauthenticated.status, 401);
      const projectless = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) });
      assert.equal(projectless.status, 200);
      const malformed = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: "[]" });
      assert.equal(malformed.status, 400);
      const audits = await repository.listSecurityAudits();
      assert.equal(audits.length, 3);
      assert.deepEqual(audits.map((audit) => [audit.action, audit.outcome, audit.reason]), [["unknown", "rejected", "authentication"], ["list", "accepted", undefined], ["unknown", "rejected", "malformed-request"]]);
      assert.ok(audits.every((audit) => !Object.prototype.hasOwnProperty.call(audit, "body") && !Object.prototype.hasOwnProperty.call(audit, "token")));
    } finally { await bridge.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("security audit rotation is bounded and encrypted repositories recover it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-security-audit-rotation-"));
  try {
    const repository = new ResearchRepository(root, { metadataPassphrase: "audit-passphrase" });
    for (let index = 0; index < 25; index++) await repository.appendSecurityAudit({ requestId: `req-${index}`, action: "list", outcome: "accepted" }, 10);
    const saved = await repository.listSecurityAudits(100);
    assert.equal(saved.length, 10);
    assert.equal(saved[0].requestId, "req-15");
    const reopened = new ResearchRepository(root, { metadataPassphrase: "audit-passphrase" });
    assert.deepEqual(await reopened.listSecurityAudits(), saved);
    await assert.rejects(() => reopened.listSecurityAudits(0), /between 1 and 10000/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only bridge capability refuses writes, approvals, memory mutations and cross-project reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-readonly-bridge-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const first = await orchestrator.createProject("Read-only project");
    const second = await orchestrator.createProject("Foreign project");
    const report = await orchestrator.generateReport(first.project.projectId);
    await orchestrator.activatePlan(first.project.projectId); await orchestrator.startNextTask(first.project.projectId);
    const before = await repository.exportProject(first.project.projectId);
    const bridge = await startResearchBridge(orchestrator, { access: "read-only", scopeProjectId: first.project.projectId });
    const post = (input: object) => fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    try {
      assert.equal((await post({ action: "context" })).status, 200);
      assert.equal((await post({ action: "inspect", projectId: second.project.projectId })).status, 400);
      const allowed = new Set(["context", "list", "inspect", "approval-queue", "report-read", "memory-retrievals", "memory-conflicts"]);
      for (const action of [...researchActions.filter((value) => !allowed.has(value)), "approve", "approve-experiment", "execute-experiment"]) {
        const response = await post({ action, role: "owner", access: "research", projectId: first.project.projectId, text: "must not write", query: "must not search", kind: "note" });
        assert.equal(response.status, 400, `${action} must be rejected by the read-only capability`);
        assert.match((await response.json()).error, /Read-only research capability/);
      }
      const read = await post({ action: "report-read", reportId: report.reportId });
      assert.equal(read.status, 200); assert.equal((await read.json()).reportId, report.reportId);
      assert.equal((await post({ action: "list" })).status, 200);
      const listed = await (await post({ action: "list" })).json();
      assert.deepEqual(listed.map((project: any) => project.projectId), [first.project.projectId]);
      assert.equal((await repository.listMemory()).length, 0);
      assert.deepEqual(await repository.exportProject(first.project.projectId), before, "reads and denied writes do not change project records or trigger recovery");
      assert.equal((await repository.listMemoryIndexVersions()).length, 0);
      assert.equal((await repository.listMemoryRetrievals()).length, 0);
    } finally { await bridge.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("security audits whitelist fields, coalesce each failed request and limit flood writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-audit-flood-"));
  try {
    const repository = new ResearchRepository(root), other = new ResearchRepository(root);
    const bridge = await startResearchBridge(new ResearchOrchestrator(repository));
    try {
      const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "secret-token-string", projectId: "private-candidate-id", body: "private-body" }) });
      assert.equal(response.status, 400);
      const audits = await repository.listSecurityAudits();
      assert.equal(audits.length, 1); assert.equal(audits[0].requestId, response.headers.get("x-research-request-id"));
      assert.equal(audits[0].action, "unknown"); assert.doesNotMatch(JSON.stringify(audits), /secret-token-string|private-candidate-id|private-body/);
    } finally { await bridge.close(); }
    const writes = Array.from({ length: 260 }, (_, index) => (index % 2 ? repository : other).appendSecurityAudit({ requestId: `flood-${index}`, action: "unknown", outcome: "rejected", reason: "authentication", ...{ body: "private-extra-field" } }, 10));
    await Promise.all(writes);
    const entries = await repository.listSecurityAudits();
    assert.equal(entries.length, 10); assert.equal(entries.at(-1)!.requestId, "flood-238", "same-root instances share a 240-write/minute bound including the first bridge request");
    assert.doesNotMatch(await readFile(path.join(root, "security-audit.jsonl"), "utf8"), /private-extra-field/);
    const single = await mkdtemp(path.join(tmpdir(), "dsh-sci-audit-single-"));
    try {
      const one = new ResearchRepository(single);
      await one.appendSecurityAudit({ requestId: "one", action: "list", outcome: "accepted" }, 1);
      await one.appendSecurityAudit({ requestId: "two", action: "list", outcome: "accepted" }, 1);
      assert.deepEqual((await one.listSecurityAudits()).map((entry) => entry.requestId), ["two"]);
      assert.throws(() => one.appendSecurityAudit({ requestId: "invalid", action: "list", outcome: "accepted" }, 0), /Invalid/);
    } finally { await rm(single, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
