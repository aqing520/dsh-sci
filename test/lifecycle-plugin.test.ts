import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error the runtime plugin is intentionally plain ESM JavaScript.
import { apply } from "../desktop/dsh-sci-lifecycle-plugin.mjs";

test("lifecycle plugin persists sanitized session events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-lifecycle-"));
  const previousRoot = process.env.DSH_SCI_CAPTURE_ROOT;
  process.env.DSH_SCI_CAPTURE_ROOT = root;
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
      data: { token: "should-not-be-written", message: "ok" },
    });
    listeners.get("agent/status")!({ agent: { session }, status: "running" });
    await listeners.get("session/flush")!(session);
    const text = await readFile(path.join(root, "sessions", "dsh-session-events.jsonl"), "utf8");
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.equal(records[0].type, "created");
    assert.equal(records[1].event.data.token, "[redacted]");
    assert.equal(records[2].status, "running");
    await cleanup?.();
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_SCI_CAPTURE_ROOT;
    else process.env.DSH_SCI_CAPTURE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
