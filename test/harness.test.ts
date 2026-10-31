import test from "node:test";
import assert from "node:assert/strict";
import { parseHarnessUrl } from "../src/harness.js";

test("parses the authenticated official dsh web URL", () => {
  assert.equal(
    parseHarnessUrl("dsh web: http://127.0.0.1:3080/?token=abc123"),
    "http://127.0.0.1:3080/?token=abc123",
  );
});

test("ignores non-authenticated or non-loopback URLs", () => {
  assert.equal(parseHarnessUrl("dsh web: http://localhost:3080/"), undefined);
  assert.equal(parseHarnessUrl("dsh web: http://192.168.1.10:3080/?token=abc"), undefined);
});
test("parses a URL even when the harness writes the line without a trailing newline", () => {
  assert.equal(parseHarnessUrl("dsh web: http://127.0.0.1:3080/?token=abc123"), "http://127.0.0.1:3080/?token=abc123");
});
