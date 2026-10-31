import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error the runtime plugin is intentionally plain ESM JavaScript.
import { apply } from "../desktop/dsh-sci-research-plugin.mjs";

test("research plugin exposes task context and records session boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-plugin-"));
  const listeners = new Map<string, (...args: any[]) => any>();
  let service: any;
  const registeredTools: any[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  try {
    process.env.DSH_SCI_RESEARCH_ROOT = root;
    apply({
      provide(name: string, value: any) { if (name === "dshSciResearch") service = value; },
      on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener); },
      effect(factory: () => () => Promise<void>) { cleanups.push(factory()); },
      tools: { register(definition: any) { registeredTools.push(definition); return () => undefined; } },
      logger: { warn() {} },
    });
    const session = { id: "session-1" };
    listeners.get("session/created")!(session);
    assert.deepEqual(service.setContext(session, { projectId: "project-1", taskId: "task-1" }), { projectId: "project-1", taskId: "task-1" });
    assert.deepEqual(service.getContext(session), { projectId: "project-1", taskId: "task-1" });
    assert.deepEqual(registeredTools.map((tool) => tool.name), ["research_context", "research_record_event", "research_action"]);
    const assemble = listeners.get("system-prompt/assemble");
    assert.ok(assemble);
    const assembled = await assemble!({ contexts: [] }, { agent: { id: session.id, session } }, async () => ({ sections: [], contexts: [], tools: [], variables: {} }));
    assert.match(assembled.contexts[0].text, /task-1/);
    listeners.get("session/event")!(session, { type: "tool/result", seq: 4 });
    listeners.get("session/disposed")!(session);
    await service.flush();
    const records = (await readFile(path.join(root, "plugin-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].type, "session-created");
    assert.equal(records[1].taskId, "task-1");
    assert.equal(records[1].data.eventType, "tool/result");
    assert.equal(records[2].type, "session-disposed");
    assert.equal(service.getContext(session), undefined);
    await cleanups[0]();
  } finally {
    delete process.env.DSH_SCI_RESEARCH_ROOT;
    await rm(root, { recursive: true, force: true });
  }
});

test("research plugin restores the active task context from its bridge file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-plugin-context-"));
  try {
    process.env.DSH_SCI_RESEARCH_ROOT = root;
    await writeFile(path.join(root, "active-context.json"), JSON.stringify({ schema: "dsh-sci.research-active-context.v1", projectId: "project-2", taskId: "task-2" }), "utf8");
    const listeners = new Map<string, (...args: any[]) => any>();
    let service: any;
    const ctx = { provide(name: string, value: any) { if (name === "dshSciResearch") service = value; }, on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener); }, effect() {}, logger: { warn() {} } };
    apply(ctx as any);
    const session = { id: "session-2" };
    listeners.get("session/created")!(session);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(service.getContext(session), { projectId: "project-2", taskId: "task-2" });
  } finally { delete process.env.DSH_SCI_RESEARCH_ROOT; await rm(root, { recursive: true, force: true }); }
});

test("external runner restricts the agent to research bridge tools and step budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-plugin-runner-"));
  const previous = process.env.DSH_SCI_EXTERNAL_RUNNER;
  const previousLimit = process.env.DSH_SCI_AGENT_MAX_STEPS;
  try {
    process.env.DSH_SCI_RESEARCH_ROOT = root;
    process.env.DSH_SCI_EXTERNAL_RUNNER = "1";
    process.env.DSH_SCI_AGENT_MAX_STEPS = "2";
    const listeners = new Map<string, (...args: any[]) => any>();
    let guard: ((execution: { name: string }) => string | undefined) | undefined;
    let restriction: any;
    let presentation: any;
    const ctx: any = {
      provide() {},
      on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener); },
      effect() {},
      logger: { warn() {} },
      tools: {
        register() {},
        guard(value: any) { guard = value; },
        restrict(value: any) { restriction = value; return () => undefined; },
        presentAs(value: any) { presentation = value; },
      },
    };
    apply(ctx);
    assert.equal(guard?.({ name: "research_action" }), undefined);
    assert.match(guard?.({ name: "shell" }) ?? "", /research bridge/iu);
    const agent = { ctx: { tools: { restrict(value: any) { restriction = value; }, presentAs(value: any) { presentation = value; } } } };
    await listeners.get("agent/created")?.({ agent });
    assert.deepEqual(restriction, { allow: ["research_context", "research_record_event", "research_action"] });
    assert.equal(presentation, "native");
    const next = async () => "ok";
    assert.equal(await listeners.get("agent/pre-step")?.({ step: 2 }, next), "ok");
    await assert.rejects(() => listeners.get("agent/pre-step")?.({ step: 3 }, next), /step limit exceeded/iu);
  } finally {
    if (previous === undefined) delete process.env.DSH_SCI_EXTERNAL_RUNNER; else process.env.DSH_SCI_EXTERNAL_RUNNER = previous;
    if (previousLimit === undefined) delete process.env.DSH_SCI_AGENT_MAX_STEPS; else process.env.DSH_SCI_AGENT_MAX_STEPS = previousLimit;
    delete process.env.DSH_SCI_RESEARCH_ROOT;
    await rm(root, { recursive: true, force: true });
  }
});

test("external runner refuses to initialize when tool execution boundary APIs are missing", () => {
  const previous = process.env.DSH_SCI_EXTERNAL_RUNNER;
  try {
    process.env.DSH_SCI_EXTERNAL_RUNNER = "1";
    for (const missing of ["tools", "guard", "restrict", "presentAs", "register"]) {
      let initialized = false;
      const tools: Record<string, unknown> = { guard() {}, restrict() {}, presentAs() {}, register() {} };
      if (missing !== "tools") tools[missing] = undefined;
      const ctx = { ...(missing === "tools" ? {} : { tools }), provide() { initialized = true; } };
      assert.throws(() => apply(ctx), /refusing to start without the execution boundary/iu, missing);
      assert.equal(initialized, false, "no research service published without enforcement");
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_SCI_EXTERNAL_RUNNER;
    else process.env.DSH_SCI_EXTERNAL_RUNNER = previous;
  }
});
