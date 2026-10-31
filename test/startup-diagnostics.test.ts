import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStartupDiagnostic, sanitizeDiagnosticText, writeStartupDiagnostic } from "../src/startup-diagnostics.js";

test("startup diagnostics redact credentials and write latest plus history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-startup-"));
  try {
    const raw = "startup failed Authorization: Bearer secret-token apiKey=abc123 token=xyz sk-live_1234567890";
    const sanitized = sanitizeDiagnosticText(raw);
    assert.doesNotMatch(sanitized, /secret-token|abc123|xyz|sk-live/);
    const diagnostic = createStartupDiagnostic(new Error(raw), { previousStartupWasUnclean: true, appVersion: "0.2.2", now: "2026-10-29T01:00:00.000Z" });
    const file = await writeStartupDiagnostic(root, diagnostic);
    assert.match(file, /startup-2026-10-29T01-00-00-000Z-/);
    const latest = JSON.parse(await readFile(path.join(root, "startup-diagnostics", "latest.json"), "utf8"));
    assert.equal(latest.schema, "dsh-sci.startup-diagnostic.v1");
    assert.equal(latest.previousStartupWasUnclean, true);
    assert.doesNotMatch(JSON.stringify(latest), /secret-token|abc123|xyz|sk-live/);
    for (let index = 0; index < 24; index += 1) await writeStartupDiagnostic(root, { ...diagnostic, createdAt: `2026-10-29T01:00:${String(index).padStart(2, "0")}.000Z` });
    const history = (await import("node:fs/promises")).readdir(path.join(root, "startup-diagnostics"));
    assert.ok((await history).filter((name) => name.startsWith("startup-") && name.endsWith(".json")).length <= 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
