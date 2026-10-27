import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaptureStore } from "../src/capture.js";

test("capture store writes an atomic snapshot and reports file changes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-workspace-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-capture-"));
  await writeFile(path.join(workspace, "note.txt"), "one", "utf8");
  const store = new CaptureStore(state);
  const first = await store.snapshot(workspace);
  assert.deepEqual(first.changes.added, ["note.txt"]);
  await writeFile(path.join(workspace, "note.txt"), "two", "utf8");
  const second = await store.snapshot(workspace);
  assert.deepEqual(second.changes.changed, ["note.txt"]);
  assert.equal((await store.readStatus()).lastSnapshot, second.snapshotId);
});
