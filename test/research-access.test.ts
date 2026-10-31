import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
// @ts-expect-error Production Electron access policy is intentionally plain ESM.
import { createResearchWindowRegistry, createResearchIpcRegistrar, researchIpcPolicies } from "../desktop/research-access.mjs";

function windowFixture(access: "owner" | "read-only" = "owner") {
  const registry = createResearchWindowRegistry();
  const url = "data:text/html;charset=utf-8,approved";
  const sender = Object.assign(new EventEmitter(), {
    mainFrame: { url }, destroyed: false,
    isDestroyed() { return this.destroyed; },
    setWindowOpenHandler(handler: () => { action: string }) { this.open = handler; },
    open: () => ({ action: "allow" }),
  });
  registry.bind({ webContents: sender }, access, url);
  return { registry, sender, event: { sender, senderFrame: sender.mainFrame }, url };
}

test("every production research IPC and preload method has one centralized explicit policy", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/research-preload.cjs", import.meta.url), "utf8");
  const registered = [...main.matchAll(/researchIpc\.handle\("(research:[^"]+)"/gu)].map((m) => m[1]);
  const exposed = [...preload.matchAll(/ipcRenderer\.invoke\("(research:[^"]+)"/gu)].map((m) => m[1]);
  assert.ok(registered.length > 40);
  assert.equal(new Set(registered).size, registered.length);
  assert.deepEqual(registered.sort(), Object.keys(researchIpcPolicies).sort());
  assert.deepEqual(exposed.sort(), registered.sort());
  assert.doesNotMatch(main, /ipcMain\.handle\("research:/u);
});

test("main-bound roles permit owner actions and refuse every read-only mutation before dispatch", async () => {
  for (const access of ["owner", "read-only"] as const) {
    const { registry, event } = windowFixture(access);
    const callbacks = new Map<string, (...args: any[]) => Promise<unknown>>();
    const audits: unknown[] = [];
    const registrar = createResearchIpcRegistrar({ handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => callbacks.set(channel, handler) }, registry, { auditDenied: async (record: unknown) => audits.push(record) });
    let dispatches = 0, denied = 0;
    for (const [channel, policy] of Object.entries(researchIpcPolicies)) {
      registrar.handle(channel, async () => { dispatches++; return "dispatched"; });
      const before = dispatches;
      const call = () => callbacks.get(channel)!(event, { role: "owner", access: "owner", approved: true, body: "secret-never-audited" });
      if (access === "read-only" && policy === "write") {
        await assert.rejects(call, { code: "DSH_SCI_RESEARCH_CAPABILITY_DENIED", reason: "capability" });
        assert.equal(dispatches, before); denied++;
      } else assert.equal(await call(), "dispatched");
    }
    assert.equal(audits.length, denied);
    assert.doesNotMatch(JSON.stringify(audits), /secret-never-audited|approved|body|role/u);
    assert.throws(() => registrar.handle("research:unregistered", () => undefined), /explicit permission policy/u);
    assert.throws(() => registry.require(event, "toString"), /capability/u);
  }
});

test("Workspace access rejects unbound senders, child frames, replacement documents and destroyed windows", () => {
  const { registry, sender, event, url } = windowFixture();
  const stranger = windowFixture();
  for (const invalid of [stranger.event, { sender, senderFrame: { url } }, { sender }]) {
    assert.throws(() => registry.require(invalid, "research:list"), { reason: "authentication" });
  }
  sender.mainFrame.url = "data:text/html;charset=utf-8,forged";
  assert.throws(() => registry.require(event, "research:approve"), { reason: "authentication" });
  sender.mainFrame.url = url; sender.destroyed = true;
  assert.throws(() => registry.require(event, "research:list"), { reason: "authentication" });
  sender.destroyed = false; sender.emit("destroyed");
  assert.throws(() => registry.require(event, "research:list"), { reason: "authentication" });
});

test("permitted refresh documents preserve the role, evict old documents and block navigation/popups", () => {
  const { registry, sender, event, url } = windowFixture("read-only");
  const refreshed = "data:text/html;charset=utf-8,refreshed";
  registry.permitDocument(sender, refreshed);
  sender.mainFrame.url = refreshed;
  assert.equal(registry.access(event), "read-only");
  assert.throws(() => registry.require(event, "research:approve"), { reason: "capability" });
  let prevented = 0;
  for (const name of ["will-navigate", "will-redirect"]) {
    sender.emit(name, { preventDefault: () => prevented++ }, refreshed);
    assert.equal(prevented, 0);
  }
  sender.emit("will-navigate", { preventDefault: () => prevented++ }, "https://example.invalid/");
  sender.emit("will-redirect", { preventDefault: () => prevented++ }, "file:///untrusted.html");
  assert.equal(prevented, 2);
  assert.deepEqual(sender.open(), { action: "deny" });
  registry.permitDocument(sender, "data:text/html;charset=utf-8,newest");
  sender.mainFrame.url = url;
  assert.throws(() => registry.require(event, "research:list"), { reason: "authentication" });
  assert.throws(() => registry.bind({ webContents: sender }, "owner", refreshed), /already bound/u);
  assert.throws(() => registry.permitDocument(sender, "https://example.invalid"), /Invalid/u);
});
