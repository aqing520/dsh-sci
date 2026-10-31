import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CaptureStore, WorkspaceCaptureMonitor } from "../src/capture.js";
import { BackupQueue } from "../src/backup-queue.js";
import { auditCaptureRoot, restoreAuditBundle } from "../src/recovery.js";
import { decryptMetadataText, MetadataLockedError, encryptMetadataText, isEncryptedMetadataText, parseMetadataJson, serializeMetadataJson } from "../src/metadata-crypto.js";
import { LocalManifestPublisher } from "../src/services.js";

test("metadata crypto round-trips, rejects missing or wrong keys, and preserves plaintext compatibility", () => {
  const plaintext = `${JSON.stringify({ schema: "test", value: "metadata" })}\n`;
  const encrypted = encryptMetadataText(plaintext, "correct horse battery staple");
  assert.equal(isEncryptedMetadataText(encrypted), true);
  assert.equal(decryptMetadataText(encrypted, "correct horse battery staple"), plaintext);
  assert.throws(() => decryptMetadataText(encrypted), MetadataLockedError);
  assert.throws(() => decryptMetadataText(encrypted, "wrong passphrase"), MetadataLockedError);
  assert.equal(decryptMetadataText(plaintext, "any key"), plaintext);
  assert.deepEqual(parseMetadataJson(serializeMetadataJson({ answer: 42 }, "correct horse battery staple"), "correct horse battery staple"), { answer: 42 });
});

test("CaptureStore reads old plaintext and persists encrypted metadata when explicitly unlocked", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-metadata-"));
  const workspace = path.join(parent, "workspace");
  const root = path.join(parent, "capture");
  try {
    await writeFile(path.join(parent, "plain.txt"), "safe", "utf8");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "note.txt"), "one", "utf8");
    const plainStore = new CaptureStore(root);
    await plainStore.snapshot(workspace);
    const encryptedStore = new CaptureStore(root, { metadataPassphrase: "capture passphrase" });
    assert.equal((await encryptedStore.listSnapshots()).length, 1);
    await encryptedStore.updateSettings({ maxSnapshots: 5 });
    assert.equal(isEncryptedMetadataText(await readFile(path.join(root, "capture-settings.json"), "utf8")), true);
    assert.equal((await new CaptureStore(root, { metadataPassphrase: "capture passphrase" }).readStatus()).enabled, true);
    const lockedStore = new CaptureStore(root);
    assert.equal((await lockedStore.readStatus()).state, "locked");
    const monitor = new WorkspaceCaptureMonitor(lockedStore, workspace, 60_000);
    await monitor.start();
    monitor.stop();
    assert.equal((await lockedStore.readStatus()).state, "locked");
    await assert.rejects(() => lockedStore.snapshot(workspace), MetadataLockedError);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("encrypted recovery restore writes a readable root and audits with the same key", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-encrypted-restore-"));
  try {
    const bundle = {
      schema: "dsh-sci.audit-bundle.v1",
      exportedAt: "2026-10-29T00:00:00.000Z",
      status: { schema: "dsh-sci.capture-status.v1", state: "idle", enabled: true },
      settings: { schema: "dsh-sci.capture-settings.v1", enabled: true, maxSnapshots: 10, maxResearchRecords: 10 },
      snapshots: [], records: [], sessions: [], researchRuns: [], sessionEvents: {}, artifacts: [], backupPublications: [], backupQueue: [],
    };
    const target = path.join(parent, "restored");
    await restoreAuditBundle(bundle, target, { metadataPassphrase: "restore passphrase" });
    assert.equal(isEncryptedMetadataText(await readFile(path.join(target, "capture-status.json"), "utf8")), true);
    assert.equal((await auditCaptureRoot(target, { metadataPassphrase: "restore passphrase" })).healthy, true);
    assert.equal((await auditCaptureRoot(target)).healthy, false);
    const lockedStore = new CaptureStore(target, { metadataPassphrase: "wrong" });
    assert.equal((await lockedStore.readStatus()).state, "locked");
    await assert.rejects(() => lockedStore.snapshot(path.join(parent, "workspace")), MetadataLockedError);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("encrypted backup queue and local manifest publisher survive a process boundary", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-encrypted-queue-"));
  const workspace = path.join(parent, "workspace");
  const root = path.join(parent, "capture");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "result.txt"), "metadata only", "utf8");
    const store = new CaptureStore(root, { metadataPassphrase: "queue passphrase" });
    await store.snapshot(workspace);
    const queue = new BackupQueue(store, new LocalManifestPublisher(root, { metadataPassphrase: "queue passphrase" }), { baseDelayMs: 0 });
    await queue.enqueue();
    await queue.process();
    assert.equal(isEncryptedMetadataText(await readFile(path.join(root, "backups", "queue.json"), "utf8")), true);
    const manifestNames = await readdir(path.join(root, "backups", "manifests"));
    assert.equal(manifestNames.length, 1);
    assert.equal(isEncryptedMetadataText(await readFile(path.join(root, "backups", "manifests", manifestNames[0]), "utf8")), true);
    const reopened = new BackupQueue(new CaptureStore(root, { metadataPassphrase: "queue passphrase" }), new LocalManifestPublisher(root, { metadataPassphrase: "queue passphrase" }));
    assert.equal((await reopened.list())[0]?.state, "published");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
