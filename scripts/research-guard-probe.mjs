// Loaded only by the guard smoke's isolated real Harness profile.
import { writeFile } from "node:fs/promises";
const { defineTool } = await import(process.env.DSH_SCI_TOOLS_MODULE_URL);

export const name = "dsh-sci-research-guard-probe";
export const inject = ["tools", "agents", "loader", "dshSciResearch"];

export function apply(ctx) {
  const output = process.env.DSH_SCI_GUARD_PROBE_OUTPUT;
  if (!output) throw new Error("Guard probe requires an isolated output file");
  const report = { schema: "dsh-sci.research-guard-smoke.v1", ok: false, checks: [], deniedBodies: 0, modelPromptsSubmitted: 0, verificationScope: "Real production Harness and research plugin, actual Agent creation and scoped tool registry. run_code is denied before its program runs; nested probes call the registry entry with a captured parent token. No executed PTC program, model or research quality acceptance." };
  let handle;
  let stopPolicy;
  let parentToken;
  const record = (name, ok) => {
    report.checks.push({ name, ok });
    if (!ok) throw new Error(`Guard probe failed: ${name}`);
  };
  const execute = (agent, name, args = {}, parent) => ctx.tools.execute({ callId: `guard-${report.checks.length}`, name, arguments: args, signal: AbortSignal.timeout(10_000), agent, ...(parent ? { parent } : {}) });
  const isGuardDenial = (value) => value.isError && value.content?.some((item) => item.type === "text" && item.text.includes("Automatic research must use the research bridge"));
  const sentinel = (name) => defineTool({
    name, description: "Harmless guard probe sentinel", parameters: {},
    output: { schema: { type: "boolean" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    execute: async () => { report.deniedBodies += 1; return true; },
  });
  void (async () => {
    try {
      await ctx.loader.await();
      report.globalPresentation = ctx.tools.modeFor();
      record("configured-global-presentation-active", report.globalPresentation === process.env.DSH_SCI_GUARD_EXPECT_MODE);
      // A later extensible allow must not override the production monotonic guard.
      stopPolicy = ctx.on("tools/pre-execute", async () => ({ kind: "allow" }));
      handle = await ctx.agents.create({
        sessionId: `guard-probe-${Date.now()}`, meta: { cwd: process.cwd() },
        agentOptions: { provider: "dsh-sci-custom", model: "smoke-model" },
        setup(agentCtx) { agentCtx.tools.register(sentinel("guard_scoped_write")); },
      });
      const agent = handle.agent;
      record("actual-agent-created-idle", agent.status === "idle");
      const visible = ctx.tools.schemas(agent).map((item) => item.name);
      record("research-tools-remain-visible", ["research_context", "research_record_event", "research_action"].every((item) => visible.includes(item)));
      report.agentPresentation = ctx.tools.modeFor(agent);
      record("agent-forced-to-native-presentation", report.agentPresentation === "native");
      record("only-research-and-fixture-tools-visible", visible.every((item) => ["research_context", "research_record_event", "research_action", "guard_scoped_write"].includes(item)));
      record("scoped-sentinel-visible-despite-restrict", visible.includes("guard_scoped_write"));
      const stopResult = ctx.on("tools/result", (execution) => { if (execution.name === "research_context") parentToken = execution.token; });
      try {
        const context = await execute(agent, "research_context");
        record("allowed-context-reaches-real-bridge", !context.isError && context.value && typeof context.value === "object");
      } finally { stopResult(); }
      record("registry-issued-parent-token-captured", typeof parentToken === "symbol");
      for (const tool of ["guard_scoped_write", "bash", "pwsh", "write_file", "run_code", "unknown_guard_tool"]) {
        record(`${tool}-native-denied-by-production-guard`, isGuardDenial(await execute(agent, tool, tool === "run_code" ? { code: "throw new Error('must not execute')", description: "Probe denied code transport" } : {})));
        // Uses a real registry-issued parent token at the nested-dispatch entry.
        // No PTC program is run: run_code itself is blocked above.
        record(`${tool}-nested-entry-denied-by-production-guard`, isGuardDenial(await execute(agent, tool, {}, parentToken)));
      }
      const forbidden = await execute(agent, "research_action", { request: { action: "approve", projectId: "guard-probe-project", taskId: "guard-probe-task" } });
      record("allowed-tool-cannot-approve-through-bridge", forbidden.isError === true && forbidden.content?.some((item) => item.type === "text" && item.text.includes("Unknown research action")));
      record("denied-tool-bodies-never-executed", report.deniedBodies === 0);
      report.ok = true;
    } catch {
      report.failure = "Harness guard probe failed; inspect individual fixed-name checks and Harness diagnostics";
    } finally {
      stopPolicy?.();
      if (handle) {
        await handle.dispose().catch(() => { report.ok = false; report.failure = "Guard probe Agent cleanup failed"; });
        report.agentDisposed = ctx.agents.get(handle.agent.id) === undefined;
        if (!report.agentDisposed) report.ok = false;
      }
      report.finishedAt = new Date().toISOString();
      await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
    }
  })();
}
