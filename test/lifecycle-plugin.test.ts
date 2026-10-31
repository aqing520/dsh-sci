import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error the runtime plugin is intentionally plain ESM JavaScript.
import { apply } from "../desktop/dsh-sci-lifecycle-plugin.mjs";
import { decryptMetadataText, isEncryptedMetadataText, serializeMetadataJson } from "../src/metadata-crypto.js";

test("lifecycle plugin persists sanitized session events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-lifecycle-"));
  const previousRoot = process.env.DSH_SCI_CAPTURE_ROOT;
  process.env.DSH_SCI_CAPTURE_ROOT = root;
  await writeFile(path.join(root, "workspace-index.json"), JSON.stringify({ projectId: "project-1", latest: "snapshot-1", workspaceRoot: "D:\\research", files: [{ path: "result.csv", kind: "file", bytes: 12, sha256: "abc123" }] }), "utf8");
  const listeners = new Map<string, (...args: any[]) => unknown>();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    apply({
      on(type: string, listener: (...args: any[]) => unknown) { listeners.set(type, listener); },
      effect(factory: () => (() => Promise<void>)) { cleanup = factory(); },
      logger: { warn() {} },
    } as any);
    const session = { id: "session-test", header: { cwd: "D:\\research", origin: "desktop" } };
    listeners.get("session/created")!(session);
    listeners.get("session/event")!(session, {
      type: "tool/result",
      seq: 2,
      time: 123,
       data: { token: "should-not-be-written", message: "ok", filePath: "D:\\research\\result.csv", toolCallId: "tool-123" },
    });
    listeners.get("session/event")!(session, { type: "user/input", seq: 3, time: 124, data: { message: "question" } });
    listeners.get("session/event")!(session, { type: "assistant/output", seq: 4, time: 125, data: { message: "answer", responseId: "response-123", model: "gpt-test", provider: "test-provider" } });
    listeners.get("session/event")!(session, { type: "tool/error", seq: 5, time: 126, data: { toolCallId: "tool-123", message: "failed" } });
    listeners.get("agent/status")!({ agent: { session }, status: "running" });
    await listeners.get("session/flush")!(session);
    const text = await readFile(path.join(root, "sessions", "dsh-session-events.jsonl"), "utf8");
    const sessionText = await readFile(path.join(root, "sessions", "session-test", "events.jsonl"), "utf8");
    const sessionIndex = JSON.parse(await readFile(path.join(root, "sessions", "session-test", "session.json"), "utf8"));
    const artifactIndex = JSON.parse(await readFile(path.join(root, "artifacts", "index.json"), "utf8"));
    const runIndex = JSON.parse(await readFile(path.join(root, "research-runs", "index.json"), "utf8"));
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(sessionText.trim().split("\n").length, 6);
    assert.equal(sessionIndex.eventCount, 4);
    assert.equal(sessionIndex.status, "active");
    assert.equal(records.length, 6);
    assert.equal(records[0].type, "created");
    assert.equal(records[1].event.data.token, "[redacted]");
     assert.deepEqual(records[1].event.observedPaths, ["D:\\research\\result.csv"]);
    assert.equal(records[1].event.artifacts[0].relativePath, "result.csv");
    assert.equal(records[1].event.artifacts[0].bytes, 12);
    assert.equal(records[1].event.artifacts[0].sha256, "abc123");
    assert.equal(records[1].event.artifacts[0].location, "workspace");
    assert.equal(artifactIndex.artifacts[0].path, "D:\\research\\result.csv");
    assert.equal(artifactIndex.artifacts[0].location, "workspace");
    assert.equal(records[2].classification, "input");
    assert.equal(records[3].classification, "output");
    assert.equal(records[4].classification, "error");
    assert.equal(records[5].status, "running");
    assert.equal(runIndex.schema, "dsh-sci.research-run-index.v1");
    assert.equal(runIndex.runs.length, 1);
    assert.equal(runIndex.runs[0].sessionId, "session-test");
    assert.equal(runIndex.runs[0].eventCount, 4);
    assert.equal(runIndex.runs[0].outcome, "unverified");
    assert.equal(runIndex.runs[0].execution.toolAttribution, "partial");
    assert.equal(runIndex.runs[0].observations.toolEvents, 1);
    assert.equal(runIndex.runs[0].observations.inputEvents, 1);
    assert.equal(runIndex.runs[0].observations.outputEvents, 1);
    assert.equal(runIndex.runs[0].observations.errorEvents, 1);
    assert.equal(runIndex.runs[0].eventTypes["tool/result"], 1);
    assert.equal(runIndex.runs[0].inputSummary.events, 1);
    assert.equal(runIndex.runs[0].outputSummary.events, 1);
    assert.deepEqual(runIndex.runs[0].observedCalls.map((call: any) => call.id).sort(), ["response-123", "tool-123"]);
    const toolCall = runIndex.runs[0].observedCalls.find((call: any) => call.id === "tool-123");
    assert.equal(toolCall.errorObserved, true);
    assert.equal(toolCall.count, 2);
    assert.equal(toolCall.firstSeq, 2);
    assert.equal(toolCall.lastSeq, 5);
    assert.equal(runIndex.runs[0].execution.model, "gpt-test");
    assert.equal(runIndex.runs[0].execution.provider, "test-provider");
    assert.equal(records[1].classification, "tool");
    assert.deepEqual(records[1].event.correlations, [{ kind: "tool", id: "tool-123" }]);
     assert.equal(sessionIndex.toolAttribution, "partial");
    const hostile = { id: "..", header: { cwd: "D:\\research", origin: "desktop" } };
    listeners.get("session/created")!(hostile);
    await listeners.get("session/flush")!(hostile);
    const hostileIndex = JSON.parse(await readFile(path.join(root, "sessions", "%2E%2E", "session.json"), "utf8"));
    assert.equal(hostileIndex.sessionId, "..");
    await assert.rejects(() => readFile(path.join(root, "session.json"), "utf8"), { code: "ENOENT" });
    await cleanup?.();
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_SCI_CAPTURE_ROOT;
    else process.env.DSH_SCI_CAPTURE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle plugin encrypts its metadata files when an explicit passphrase is configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-lifecycle-encrypted-"));
  const previousRoot = process.env.DSH_SCI_CAPTURE_ROOT;
  const previousPassphrase = process.env.DSH_SCI_METADATA_PASSPHRASE;
  process.env.DSH_SCI_CAPTURE_ROOT = root;
  process.env.DSH_SCI_METADATA_PASSPHRASE = "plugin passphrase";
  await writeFile(path.join(root, "workspace-index.json"), serializeMetadataJson({ projectId: "project-1", latest: "snapshot-1", workspaceRoot: "D:\\research", files: [] }, "plugin passphrase"), "utf8");
  const listeners = new Map<string, (...args: any[]) => unknown>();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    apply({ on(type: string, listener: (...args: any[]) => unknown) { listeners.set(type, listener); }, effect(factory: () => (() => Promise<void>)) { cleanup = factory(); }, logger: { warn() {} } } as any);
    const session = { id: "encrypted-session", header: { cwd: "D:\\research", origin: "desktop" } };
    listeners.get("session/created")!(session);
    listeners.get("session/event")!(session, { type: "tool/result", seq: 1, time: 1, data: { filePath: "D:\\research\\result.csv" } });
    await listeners.get("session/flush")!(session);
    const runIndex = await readFile(path.join(root, "research-runs", "index.json"), "utf8");
    const events = await readFile(path.join(root, "sessions", "dsh-session-events.jsonl"), "utf8");
    assert.equal(isEncryptedMetadataText(runIndex), true);
    assert.equal(isEncryptedMetadataText(events), true);
    const parsedEvents = decryptMetadataText(events, "plugin passphrase").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(parsedEvents[1].event.observedPaths[0], "D:\\research\\result.csv");
  } finally {
    await cleanup?.();
    if (previousRoot === undefined) delete process.env.DSH_SCI_CAPTURE_ROOT; else process.env.DSH_SCI_CAPTURE_ROOT = previousRoot;
    if (previousPassphrase === undefined) delete process.env.DSH_SCI_METADATA_PASSPHRASE; else process.env.DSH_SCI_METADATA_PASSPHRASE = previousPassphrase;
    await rm(root, { recursive: true, force: true });
  }
});
