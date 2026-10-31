import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaptureStore } from "../src/capture.js";

test("capture store writes an atomic snapshot and reports file changes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-workspace-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-capture-"));
  await writeFile(path.join(workspace, "note.txt"), "one", "utf8");
  const store = new CaptureStore(state);
  const first = await store.snapshot(workspace, { sessionId: "session-1", provider: "test", model: "mock" });
  assert.deepEqual(first.changes.added, ["note.txt"]);
  assert.equal(first.projectId.length, 32);
  await writeFile(path.join(workspace, "note.txt"), "two", "utf8");
  const second = await store.snapshot(workspace, { sessionId: "session-1" });
  assert.deepEqual(second.changes.changed, ["note.txt"]);
  assert.equal(second.sequence, 2);
  assert.equal((await store.readStatus()).lastSnapshot, second.snapshotId);
  assert.equal((await store.queryResearchRecords({ sessionId: "session-1" })).length, 2);
  assert.match(await store.exportResearchRecords("jsonl"), /session-1/);
  await mkdir(path.join(state, "sessions"), { recursive: true });
  await writeFile(path.join(state, "sessions", "index.json"), JSON.stringify({ schema: "dsh-sci.session-index.v1", sessions: [{ schema: "dsh-sci.session-index.v1", sessionId: "session-1", status: "active", eventCount: 2 }] }), "utf8");
  assert.equal((await store.listSessions()).length, 1);
  const audit = JSON.parse(await store.exportAuditBundle());
  assert.equal(audit.schema, "dsh-sci.audit-bundle.v1");
  assert.equal(audit.sessions[0].sessionId, "session-1");
  assert.deepEqual(audit.sessionEvents["session-1"], []);
  assert.ok(Array.isArray(audit.backupQueue));
  assert.ok(Array.isArray(audit.artifacts));
  assert.deepEqual(audit.researchRuns, []);
  assert.deepEqual(await store.listResearchRuns(), []);
  const published = await store.publishMetadataManifest({ provider: "test-local", publish: async (manifest) => ({ manifest: { ...manifest, manifestId: "manifest-1", createdAt: "2026-10-28T00:00:00Z" }, uploaded: false }) });
  assert.equal(published.manifest.manifestId, "manifest-1");
  assert.equal((await store.listBackupPublications())[0].provider, "test-local");
  const explicitProject = await store.publishMetadataManifest({ publish: async (manifest) => ({ manifest: { ...manifest, manifestId: "manifest-project", createdAt: "2026-10-28T00:00:00Z" }, uploaded: false }) }, { projectId: "project-explicit" });
  assert.equal(explicitProject.manifest.projectId, "project-explicit");
  assert.equal((await store.listBackupPublications())[0].status, "published");
  await assert.rejects(() => store.publishMetadataManifest({ publish: async () => { throw new Error("offline"); } }));
  assert.equal((await store.listBackupPublications())[0].status, "failed");
  await writeFile(path.join(state, "sessions", "index.json"), "{}", "utf8");
  await mkdir(path.join(state, "sessions", "session-1"), { recursive: true });
  await writeFile(path.join(state, "sessions", "session-1", "session.json"), JSON.stringify({ schema: "dsh-sci.session-index.v1", sessionId: "session-1", createdAt: "2026-10-28T00:00:00Z" }), "utf8");
  await writeFile(path.join(state, "sessions", "session-1", "events.jsonl"), `${JSON.stringify({ type: "created", safe: true })}\ntruncated{\n${JSON.stringify({ type: "disposed" })}\n`, "utf8");
  assert.equal((await store.listSessions()).length, 1);
  assert.deepEqual(await store.listSessionEvents("session-1"), [{ type: "created", safe: true }, { type: "disposed" }]);
  const eventAudit = JSON.parse(await store.exportAuditBundle());
  assert.deepEqual(eventAudit.sessionEvents["session-1"], [{ type: "created", safe: true }, { type: "disposed" }]);
  const reopened = new CaptureStore(state);
  const third = await reopened.snapshot(workspace);
  assert.deepEqual(third.changes, { added: [], removed: [], changed: [] });
  assert.equal((await reopened.listResearchRecords()).length, 3);
  await mkdir(path.join(state, "sessions", "old-session"), { recursive: true });
  await writeFile(path.join(state, "sessions", "old-session", "session.json"), JSON.stringify({ schema: "dsh-sci.session-index.v1", sessionId: "old-session", createdAt: "2020-01-01T00:00:00Z", disposedAt: "2020-01-02T00:00:00Z" }), "utf8");
  await writeFile(path.join(state, "sessions", "dsh-session-events.jsonl"), "{}\n", "utf8");
  await writeFile(path.join(state, "sessions", "index.json"), JSON.stringify({ schema: "dsh-sci.session-index.v1", sessions: [{ sessionId: "old-session" }, { sessionId: "session-1" }] }), "utf8");
  await reopened.cleanup({ before: "2021-01-01T00:00:00Z" });
  assert.deepEqual(await reopened.listArtifacts(), []);
  assert.deepEqual((await reopened.listSessions()).map((session) => session.sessionId), ["session-1"]);
  const settings = await reopened.updateSettings({ maxSnapshots: 1, maxResearchRecords: 1, retentionDays: 0 });
  assert.deepEqual(settings, { schema: "dsh-sci.capture-settings.v1", enabled: true, maxSnapshots: 1, maxResearchRecords: 1 });
  assert.equal((await reopened.listSnapshots()).length, 1);
  assert.equal((await reopened.listResearchRecords()).length, 1);
  await reopened.setEnabled(false);
  const disabled = await reopened.snapshot(workspace);
  assert.equal((await reopened.readStatus()).state, "disabled");
  assert.equal(disabled.snapshotId, third.snapshotId);
});

test("workspace snapshots skip common credential files", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-sensitive-workspace-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-sensitive-capture-"));
  await writeFile(path.join(workspace, ".env.local"), "TOKEN=secret", "utf8");
  await writeFile(path.join(workspace, "credentials.json"), "{\"token\":\"secret\"}", "utf8");
  await writeFile(path.join(workspace, "notes.txt"), "safe", "utf8");
  const snapshot = await new CaptureStore(state).snapshot(workspace);
  assert.deepEqual(snapshot.files.map((file) => file.path), ["notes.txt"]);
});

test("workspace snapshots skip generated release archives", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-release-workspace-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-release-capture-"));
  try {
    await mkdir(path.join(workspace, "release", "win-unpacked", "resources"), { recursive: true });
    await writeFile(path.join(workspace, "release", "win-unpacked", "resources", "app.asar"), "virtual archive", "utf8");
    await mkdir(path.join(workspace, "artifacts"), { recursive: true });
    await writeFile(path.join(workspace, "artifacts", "debug.blockmap"), "generated archive map", "utf8");
    await writeFile(path.join(workspace, "source.ts"), "export {}", "utf8");
    const snapshot = await new CaptureStore(state).snapshot(workspace);
    assert.deepEqual(snapshot.files.map((file) => file.path), ["artifacts", "source.ts"]);
  } finally {
    await Promise.all([rm(workspace, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
  }
});

test("capture store searches records, snapshots, and session events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-search-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-search-workspace-"));
  await writeFile(path.join(workspace, "needle-result.txt"), "captured", "utf8");
  const store = new CaptureStore(root);
  const snapshot = await store.snapshot(workspace, { sessionId: "session-search" });
  await mkdir(path.join(root, "sessions", encodeURIComponent("session-search")), { recursive: true });
  await writeFile(path.join(root, "sessions", encodeURIComponent("session-search"), "session.json"), JSON.stringify({ schema: "dsh-sci.session-index.v1", sessionId: "session-search", projectId: snapshot.projectId, createdAt: new Date().toISOString(), status: "active" }));
  await writeFile(path.join(root, "sessions", encodeURIComponent("session-search"), "events.jsonl"), JSON.stringify({ capturedAt: new Date().toISOString(), event: { type: "tool/result", data: { path: "needle-result.txt" } } }) + "\n");
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(path.join(root, "artifacts", "index.json"), JSON.stringify({ schema: "dsh-sci.artifact-index.v1", artifacts: [{ schema: "dsh-sci.artifact.v1", artifactId: "artifact-needle", path: "needle-result.txt", location: "workspace", kind: "file", projectId: snapshot.projectId, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), observedCount: 1, sessionIds: ["session-search"] }] }));
  const hits = await store.searchHistory("needle-result", { limit: 10 });
  assert.ok(hits.some((hit) => hit.kind === "workspace-snapshot"));
  assert.ok(hits.some((hit) => hit.kind === "session-event"));
  assert.ok(hits.some((hit) => hit.kind === "artifact"));
  assert.equal((await store.searchHistory("needle-result", { kind: "session-event", sessionId: "session-search" })).length, 1);
  assert.equal((await store.searchHistory("needle-result", { offset: 1, limit: 1 })).length, 1);
  assert.ok((await store.searchHistory("needle result", { kind: "session-event" })).length > 0);
  assert.equal((await store.searchHistory("session-search", { kind: "research-run", sessionId: "session-search" })).length, 0);
  await mkdir(path.join(root, "sessions", "%2E%2E"), { recursive: true });
  await writeFile(path.join(root, "sessions", "%2E%2E", "events.jsonl"), JSON.stringify({ safe: true }) + "\n");
  await writeFile(path.join(root, "outside-events.jsonl"), JSON.stringify({ unsafe: true }) + "\n");
  assert.deepEqual(await store.listSessionEvents(".."), [{ safe: true }]);
});

test("capture store serializes concurrent snapshots and cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-mutation-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-mutation-workspace-"));
  await writeFile(path.join(workspace, "file.txt"), "one", "utf8");
  const store = new CaptureStore(root);
  const [first, second, cleaned] = await Promise.all([store.snapshot(workspace), store.snapshot(workspace), store.cleanup({ maxSnapshots: 10, maxResearchRecords: 10 })]);
  assert.equal(first.projectId, second.projectId);
  assert.equal(second.sequence, 2);
  assert.equal((await store.listSnapshots()).length, 1);
  assert.equal(cleaned.snapshotsRemoved, 0);
});

test("capture store serializes settings updates with snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-settings-race-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-settings-workspace-"));
  await writeFile(path.join(workspace, "file.txt"), "one", "utf8");
  const store = new CaptureStore(root);
  await Promise.all([store.snapshot(workspace), store.updateSettings({ maxSnapshots: 2 })]);
  assert.equal((await store.readSettings()).maxSnapshots, 2);
  assert.equal((await store.listSnapshots()).length, 1);
});

test("capture store serializes error status with settings updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-error-race-"));
  const store = new CaptureStore(root);
  await Promise.all([store.updateSettings({ enabled: true }), store.markError(new Error("capture failed"))]);
  const status = await store.readStatus();
  assert.equal(status.state, "error");
  assert.equal(status.error, "capture failed");
  assert.equal(status.enabled, true);
});

test("capture store serializes concurrent publication history writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-publication-race-"));
  const store = new CaptureStore(root);
  const publisher = { provider: "test", publish: async (manifest: any) => ({ manifest: { ...manifest, manifestId: `manifest-${manifest.projectId}`, createdAt: "2026-10-28T00:00:00Z" }, uploaded: false }) };
  await Promise.all([store.publishMetadataManifest(publisher, { projectId: "one" }), store.publishMetadataManifest(publisher, { projectId: "two" })]);
  assert.equal((await store.listBackupPublications(10)).length, 2);
});
