import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CaptureStore } from "../src/capture.js";
import { BackupQueue } from "../src/backup-queue.js";

test("backup queue persists retry state and publishes after the next attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-queue-"));
  const store = new CaptureStore(root);
  let attempts = 0;
  const publishedInputs: any[] = [];
  const publisher = { publish: async (input: any) => {
    publishedInputs.push(input);
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("temporary outage"), { retryable: true });
    return { manifest: { ...input, manifestId: "manifest-queue", createdAt: "2026-10-28T00:00:00Z" }, uploaded: true };
  } };
  const queue = new BackupQueue(store, publisher, { baseDelayMs: 0, maxAttempts: 3 });
  const enqueued = await queue.enqueue({ projectId: "project-1" });
  assert.equal((await queue.enqueue({ projectId: "project-1" })).jobId, enqueued.jobId);
  const first = await queue.process();
  assert.deepEqual(first, { processed: 1, published: 0, retrying: 1, failed: 0, pending: 1 });
  assert.equal((await queue.list())[0].state, "retrying");
  const second = await queue.process();
  assert.deepEqual(second, { processed: 1, published: 1, retrying: 0, failed: 0, pending: 0 });
  assert.equal((await queue.list())[0].manifestId, "manifest-queue");
  assert.deepEqual(publishedInputs[0].workspaceSnapshotIds, []);
  assert.deepEqual(publishedInputs[0].researchRunIds, []);
  const reopened = new BackupQueue(store, publisher, { baseDelayMs: 0, maxAttempts: 3 });
  assert.equal((await reopened.list())[0].state, "published");
  assert.match(await reopened.exportState(), /dsh-sci\.backup-queue\.v1/);
});

test("backup queue does not retry a permanent provider failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-queue-"));
  const store = new CaptureStore(root);
  const queue = new BackupQueue(store, { publish: async () => { throw Object.assign(new Error("unauthorized"), { retryable: false }); } }, { baseDelayMs: 0 });
  await queue.enqueue();
  const result = await queue.process();
  assert.deepEqual(result, { processed: 1, published: 0, retrying: 0, failed: 1, pending: 0 });
  assert.equal((await queue.list())[0].state, "failed");
  const retryJob = await queue.enqueue();
  assert.notEqual(retryJob.jobId, (await queue.list())[1]?.jobId);
  assert.equal(retryJob.state, "queued");
});

test("backup queue manually resets a failed job for retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-manual-retry-"));
  const queue = new BackupQueue(new CaptureStore(root), { publish: async () => { throw Object.assign(new Error("offline"), { retryable: false }); } }, { baseDelayMs: 0 });
  const item = await queue.enqueue();
  await queue.process();
  const retried = await queue.retry(item.jobId);
  assert.equal(retried.state, "queued");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.lastError, undefined);
});

test("backup queue waits for an active processor before manual retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-retry-race-"));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue = new BackupQueue(new CaptureStore(root), { publish: async () => { await gate; throw Object.assign(new Error("offline"), { retryable: false }); } }, { baseDelayMs: 0 });
  const item = await queue.enqueue();
  const processing = queue.process();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const retrying = queue.retry(item.jobId);
  release!();
  await processing;
  assert.equal((await retrying).state, "queued");
});

test("backup queue reports idle after the active processor completes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-idle-"));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue = new BackupQueue(new CaptureStore(root), { publish: async (input: any) => { await gate; return { manifest: { ...input, manifestId: "idle", createdAt: "2026-10-28T00:00:00Z" }, uploaded: false }; } });
  await queue.enqueue();
  const processing = queue.process();
  assert.equal(await queue.waitForIdle(0), false);
  release!();
  await processing;
  assert.equal(await queue.waitForIdle(10), true);
});

test("backup queue waits for an active processor before enqueue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-enqueue-race-"));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue = new BackupQueue(new CaptureStore(root), { publish: async (input: any) => { await gate; return { manifest: { ...input, manifestId: "enqueue-race", createdAt: "2026-10-28T00:00:00Z" }, uploaded: false }; } });
  const first = await queue.enqueue();
  const processing = queue.process();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const enqueuing = queue.enqueue({ force: true });
  release!();
  await processing;
  const second = await enqueuing;
  assert.notEqual(second.jobId, first.jobId);
  assert.equal((await queue.list()).filter((item) => item.state === "published").length, 1);
});

test("backup queue pins the captured metadata set at enqueue time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-queue-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "dsh-sci-backup-workspace-"));
  await writeFile(path.join(workspace, "result.txt"), "before", "utf8");
  const store = new CaptureStore(root);
  const first = await store.snapshot(workspace);
  const inputs: any[] = [];
  const queue = new BackupQueue(store, { publish: async (input: any) => { inputs.push(input); return { manifest: { ...input, manifestId: "pinned", createdAt: "2026-10-28T00:00:00Z" }, uploaded: false }; } }, { baseDelayMs: 0 });
  await queue.enqueue();
  await writeFile(path.join(workspace, "result.txt"), "after", "utf8");
  await store.snapshot(workspace);
  await queue.process();
  assert.deepEqual(inputs[0].workspaceSnapshotIds, [first.snapshotId]);
});
