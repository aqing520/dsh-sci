import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIntegrityManifest, verifyIntegrityManifest } from "../src/integrity.js";

test("integrity manifest detects changed and missing files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-integrity-"));
  try {
    await writeFile(path.join(root, "a.txt"), "one", "utf8");
    await writeFile(path.join(root, "b.txt"), "two", "utf8");
    const manifest = await createIntegrityManifest(root, ["b.txt", "a.txt"]);
    assert.deepEqual(manifest.entries.map((entry) => entry.path), ["a.txt", "b.txt"]);
    assert.equal(manifest.schema, "dsh-sci.integrity-manifest.v2");
    assert.equal(manifest.algorithm, "sha256");
    assert.deepEqual(await verifyIntegrityManifest(root, manifest), []);
    await writeFile(path.join(root, "a.txt"), "changed", "utf8");
    await rm(path.join(root, "b.txt"));
    assert.deepEqual((await verifyIntegrityManifest(root, manifest)).map((failure) => [failure.path, failure.reason]), [["a.txt", "size"], ["b.txt", "missing"]]);
    assert.deepEqual((await verifyIntegrityManifest(root, { ...manifest, entries: [{ path: "../outside.txt", bytes: 0, sha256: "" }] })).map((failure) => failure.reason), ["missing"]);
    assert.deepEqual((await verifyIntegrityManifest(root, { ...manifest, algorithm: "md5" as "sha256" })).map((failure) => failure.reason), ["algorithm"]);
    assert.deepEqual((await verifyIntegrityManifest(root, { ...manifest, appVersion: "0.2.1" }, { appVersion: "0.2.2" })).map((failure) => failure.reason), ["version"]);
    assert.deepEqual((await verifyIntegrityManifest(root, { ...manifest, generatorVersion: "other" }, { generatorVersion: "dsh-sci.integrity.v1" })).map((failure) => failure.reason), ["generator"]);
    await assert.rejects(() => createIntegrityManifest(root, ["../outside.txt"]), /escapes root/);
    const outside = await mkdtemp(path.join(os.tmpdir(), "dsh-sci-integrity-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      try { await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlink creation requires Windows developer mode"); return; } throw error; }
      await assert.rejects(() => createIntegrityManifest(root, ["link.txt"]), /escapes root/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
