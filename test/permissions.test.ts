import test from "node:test";
import assert from "node:assert/strict";
import { containsPath, assertWritable } from "../src/permissions.js";

test("workspace containment is boundary safe", () => {
  assert.equal(containsPath("C:/work/project", "C:/work/project/a.txt"), true);
  assert.equal(containsPath("C:/work/project", "C:/work/project-other/a.txt"), false);
});

test("read-only rejects writes", () => {
  assert.throws(() => assertWritable("read-only", "C:/work/project", "C:/work/project/a.txt"), /read-only/);
});
