import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditCaptureRoot, restoreAuditBundle } from "../src/recovery.js";

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

test("recovery audit reports counts and pending backup jobs without changing files", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-recovery-"));
  const root = path.join(parent, "capture");
  try {
    await writeJson(root, "capture-status.json", { schema: "dsh-sci.capture-status.v1", state: "idle", enabled: true });
    await writeJson(root, "capture-settings.json", { schema: "dsh-sci.capture-settings.v1", enabled: true, maxSnapshots: 10, maxResearchRecords: 10 });
    await writeJson(root, "snapshots/index.json", { schema: "dsh-sci.workspace-snapshot-index.v1", snapshots: [{ snapshotId: "s1" }] });
    await writeJson(root, "research-records.json", { schema: "dsh-sci.research-record-index.v1", records: [{ runId: "r1" }, { runId: "r2" }] });
    await writeJson(root, "sessions/index.json", { schema: "dsh-sci.session-index.v1", sessions: [{ sessionId: "session-1" }] });
    await writeJson(root, "artifacts/index.json", { schema: "dsh-sci.artifact-index.v1", artifacts: [{ artifactId: "a1" }, { artifactId: "a2" }, { artifactId: "a3" }] });
    await writeJson(root, "backups/queue.json", { schema: "dsh-sci.backup-queue.v1", items: [{ state: "queued" }, { state: "failed" }, { state: "published" }] });
    await writeJson(parent, "startup-diagnostics/latest.json", { schema: "dsh-sci.startup-diagnostic.v1" });
    const audit = await auditCaptureRoot(root);
    assert.equal(audit.healthy, true);
    assert.equal(audit.exists, true);
    assert.deepEqual(audit.summary, { snapshots: 1, researchRecords: 2, sessions: 1, researchRuns: 0, artifacts: 3, backupJobs: 3, pendingBackupJobs: 1, failedBackupJobs: 1, latestStartupDiagnostic: true });
    assert.equal(audit.files["backups/queue.json"], "ok");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery audit marks malformed indexes unhealthy and missing roots as empty", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-recovery-"));
  try {
    const missing = await auditCaptureRoot(path.join(parent, "missing"));
    assert.equal(missing.exists, false);
    assert.equal(missing.healthy, true);
    const root = path.join(parent, "capture");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "capture-status.json"), "{broken", "utf8");
    const audit = await auditCaptureRoot(root);
    assert.equal(audit.healthy, false);
    assert.equal(audit.files["capture-status.json"], "invalid");
    assert.match(audit.issues[0] ?? "", /invalid JSON/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery restore validates an audit bundle and reconstructs metadata in an empty root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-restore-"));
  try {
    const bundle = {
      schema: "dsh-sci.audit-bundle.v1",
      exportedAt: "2026-10-29T00:00:00.000Z",
      status: { schema: "dsh-sci.capture-status.v1", state: "capturing", enabled: true, lastSnapshot: "snap-1" },
      settings: { schema: "dsh-sci.capture-settings.v1", enabled: true, maxSnapshots: 10, maxResearchRecords: 10 },
      snapshots: [{ schema: "dsh-sci.workspace-snapshot.v1", snapshotId: "snap-1", workspaceRoot: "C:/workspace", projectId: "project-1", sequence: 1, capturedAt: "2026-10-29T00:00:00.000Z", files: [], changes: { added: [], removed: [], changed: [] } }],
      records: [{ schema: "dsh-sci.research-record.v1", runId: "run-1", projectId: "project-1", status: "partial", createdAt: "2026-10-29T00:00:00.000Z", workspaceSnapshotId: "snap-1", inputs: { status: "unverified", exactInputBaseline: false }, execution: { source: "background-workspace-observation", toolAttribution: "unavailable" }, outputs: { status: "background-captured", files: 0, changedFiles: 0 } }],
      sessions: [{ schema: "dsh-sci.session-index.v1", sessionId: "../session-1", status: "disposed" }],
      researchRuns: [{ schema: "dsh-sci.research-run.v1", runId: "run-observed-1", sessionId: "../session-1", startedAt: "2026-10-29T00:00:00.000Z", lastObservedAt: "2026-10-29T00:00:01.000Z", state: "disposed", outcome: "unverified", inputs: { status: "unverified", exactInputBaseline: false }, execution: { source: "dsh-session-observation", toolAttribution: "partial" }, eventCount: 1, observedPaths: [], artifactIds: [], observedCalls: [{ kind: "tool", id: "tool-123", count: 2, eventTypes: ["tool/result", "tool/error"], firstObservedAt: "2026-10-29T00:00:00.500Z", lastObservedAt: "2026-10-29T00:00:01.000Z", firstSeq: 2, lastSeq: 5, errorObserved: true }] }],
      sessionEvents: { "../session-1": [{ schema: "dsh-sci.session-event.v1", capturedAt: "2026-10-29T00:00:01.000Z" }] },
      artifacts: [{ schema: "dsh-sci.artifact.v1", artifactId: "artifact-1", path: "C:/workspace/a.txt", location: "workspace", kind: "file", firstSeenAt: "2026-10-29T00:00:00.000Z", lastSeenAt: "2026-10-29T00:00:00.000Z", observedCount: 1, sessionIds: ["../session-1"] }],
      backupPublications: [],
      backupQueue: [{ schema: "dsh-sci.backup-queue-item.v1", jobId: "job-1", projectId: "project-1", workspaceSnapshotIds: ["snap-1"], researchRunIds: ["run-1"], state: "queued", attempts: 0, maxAttempts: 3, createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z" }],
    };
    const target = path.join(parent, "restored");
    const result = await restoreAuditBundle(bundle, target);
    assert.equal(result.snapshots, 1);
    assert.equal(result.sessionEvents, 1);
    assert.equal(result.researchRuns, 1);
    const restoredRun = JSON.parse(await readFile(path.join(target, "research-runs", "run-observed-1", "run.json"), "utf8"));
    assert.deepEqual(restoredRun.observedCalls[0], bundle.researchRuns[0].observedCalls[0]);
    assert.equal((await auditCaptureRoot(target)).healthy, true);
    await assert.rejects(() => restoreAuditBundle(bundle, target), /must be empty/);
    await assert.rejects(() => restoreAuditBundle({ ...bundle, sessionEvents: { orphan: [] } }, path.join(parent, "invalid")), /missing session/);
    await assert.rejects(() => restoreAuditBundle({ ...bundle, researchRuns: [{ ...bundle.researchRuns[0], observedCalls: [{ ...bundle.researchRuns[0].observedCalls[0], count: 0 }] }] }, path.join(parent, "invalid-calls")), /observedCalls\[0\]\.count/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery audit flags missing required state files", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-recovery-"));
  try {
    const root = path.join(parent, "capture");
    await mkdir(root, { recursive: true });
    const audit = await auditCaptureRoot(root);
    assert.equal(audit.healthy, false);
    assert.match(audit.issues.join("\n"), /capture-status\.json: missing/);
    assert.match(audit.issues.join("\n"), /capture-settings\.json: missing/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery audit detects broken internal references and duplicate IDs", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-recovery-corrupt-"));
  try {
    const root = path.join(parent, "capture");
    await writeJson(root, "capture-status.json", { schema: "dsh-sci.capture-status.v1", state: "idle", enabled: true, lastSnapshot: "missing-snapshot" });
    await writeJson(root, "capture-settings.json", { schema: "dsh-sci.capture-settings.v1", enabled: true, maxSnapshots: 10, maxResearchRecords: 10 });
    await writeJson(root, "snapshots/index.json", { schema: "dsh-sci.workspace-snapshot-index.v1", snapshots: [{ snapshotId: "same" }, { snapshotId: "same" }] });
    await writeJson(root, "research-records.json", { schema: "dsh-sci.research-record-index.v1", records: [{ runId: "record-1", workspaceSnapshotId: "missing-snapshot" }] });
    await writeJson(root, "sessions/index.json", { schema: "dsh-sci.session-index.v1", sessions: [{ sessionId: "session-1" }] });
    await writeJson(root, "research-runs/index.json", { schema: "dsh-sci.research-run-index.v1", runs: [{ runId: "run-1", sessionId: "missing-session", artifactIds: ["missing-artifact"], observedCalls: [{ kind: "tool", id: "call-1", count: 0, eventTypes: [], firstObservedAt: "bad", lastObservedAt: "bad", errorObserved: false }] }] });
    await writeJson(root, "artifacts/index.json", { schema: "dsh-sci.artifact-index.v1", artifacts: [] });
    await writeJson(root, "backups/queue.json", { schema: "dsh-sci.backup-queue.v1", items: [] });
    const audit = await auditCaptureRoot(root);
    assert.equal(audit.healthy, false);
    assert.match(audit.issues.join("\n"), /duplicate same/);
    assert.match(audit.issues.join("\n"), /references missing snapshot/);
    assert.match(audit.issues.join("\n"), /references missing session/);
    assert.match(audit.issues.join("\n"), /references missing artifact/);
    assert.match(audit.issues.join("\n"), /observedCalls\[0\]\.count/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
