import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDecipheriv, randomUUID, scryptSync } from "node:crypto";
let defineTool;
let toolDependencyError;
try { ({ defineTool } = await import(process.env.DSH_SCI_TOOLS_MODULE_URL ?? "@deepseek-ai/dsh-tools")); } catch (error) { toolDependencyError = String(error); }

export const name = "dsh-sci-research";
// The tools service is optional in unit-test contexts, but must be injected by
// Cordis in the real DSH profile before ctx.tools is accessed.
export const inject = ["tools"];

function makeTool(options) {
  if (!defineTool) throw new Error(`Research tools dependency is unavailable: ${toolDependencyError}`);
  return defineTool(options);
}

function rootDirectory() {
  return path.resolve(process.env.DSH_SCI_RESEARCH_ROOT ?? path.join(process.env.DSH_SCI_CAPTURE_ROOT ?? path.join(process.env.DSH_HOME ?? ".", "dsh-sci-capture"), "research"));
}
function idOf(value) { return String(value?.id ?? value?.sessionId ?? value?.session?.id ?? "unknown").slice(0, 256); }
function safeTask(value) {
  if (!value || typeof value !== "object") return undefined;
  const projectId = typeof value.projectId === "string" ? value.projectId.slice(0, 128) : undefined;
  const taskId = typeof value.taskId === "string" ? value.taskId.slice(0, 128) : undefined;
  return projectId && taskId ? { projectId, taskId } : undefined;
}
function decryptMetadataText(text) {
  let value; try { value = JSON.parse(text); } catch { return text; }
  if (!value || value.schema !== "dsh-sci.encrypted-metadata.v1") return text;
  const passphrase = process.env.DSH_SCI_METADATA_PASSPHRASE;
  if (!passphrase) throw new Error("research metadata is locked");
  const key = scryptSync(passphrase, Buffer.from(value.salt, "base64"), 32, { N: value.kdfParams.N, r: value.kdfParams.r, p: value.kdfParams.p, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
async function bridgeRequest(input, signal) {
  const url = process.env.DSH_SCI_RESEARCH_BRIDGE_URL;
  const token = process.env.DSH_SCI_RESEARCH_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("research bridge is unavailable");
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `research bridge failed with HTTP ${response.status}`);
  return value;
}

/** DSH bridge for research task/session context and durable boundary events. */
export function apply(ctx) {
  const root = rootDirectory();
  const eventsFile = path.join(root, "plugin-events.jsonl");
  const sessions = new Map();
  let queue = Promise.resolve();
  let closed = false;
  const registeredToolNames = [];
  const externalRunner = process.env.DSH_SCI_EXTERNAL_RUNNER === "1";
  if (externalRunner && ["guard", "restrict", "presentAs", "register"].some((method) => typeof ctx.tools?.[method] !== "function")) {
    throw new Error("Automatic research requires DSH tool guard, restriction, presentation and registration support; refusing to start without the execution boundary.");
  }
  if (externalRunner) {
    // Automatic research uses the local bridge as its execution boundary.
    // Scoped restriction hides inherited shell/file tools; the guard also
    // prevents scoped or PTC transports from bypassing that capability set.
    const allowedTools = new Set(["research_context", "research_record_event", "research_action"]);
    ctx.tools.guard((execution) => allowedTools.has(execution.name) ? undefined : "Automatic research must use the research bridge; experiment execution requires desktop approval.");
    ctx.on("agent/created", ({ agent }) => {
      agent.ctx.tools.restrict({ allow: [...allowedTools] });
      agent.ctx.tools.presentAs("native");
    });
    const modelSteps = Number(process.env.DSH_SCI_AGENT_MAX_STEPS ?? 30);
    const limit = Number.isSafeInteger(modelSteps) && modelSteps > 0 ? Math.min(100, modelSteps) : 30;
    ctx.on("agent/pre-step", async ({ step }, next) => {
      if (step > limit) throw new Error(`Research model step limit exceeded (${limit})`);
      return next();
    });
  }
  const service = {
    getContext(session) { return sessions.get(idOf(session)); },
    setContext(session, value) { const task = safeTask(value); if (!task) throw new Error("research context requires projectId and taskId"); sessions.set(idOf(session), task); return task; },
    clearContext(session) { sessions.delete(idOf(session)); },
    async flush() { await queue; },
    recordTaskEvent(session, type, data = {}) { write(type, session, data); },
  };
  ctx.provide("dshSciResearch", service);
  if (ctx.tools?.register) {
    ctx.tools.register(makeTool({
      name: "research_context",
      description: "Read the active research project and task context. Use this before producing research claims, citations, experiment records, or report sections.",
      parameters: {},
      output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      execute(_args, exec) { return externalRunner ? bridgeRequest({ action: "context" }, exec.signal) : Promise.resolve(service.getContext(exec.agent) ?? { active: false }); },
    }));
    registeredToolNames.push("research_context");
    ctx.tools.register(makeTool({
      name: "research_record_event",
      description: "Record a bounded research task event for the active session. This is an audit marker and does not complete a task or approve an experiment.",
      parameters: { type: { type: "string", required: true, description: "Short event type such as claim-drafted, source-reviewed, or experiment-observed." }, summary: { type: "string", description: "Optional concise event summary." } },
      output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      execute(args, exec) { const context = service.getContext(exec.agent); if (!context) return Promise.resolve({ recorded: false, reason: "no active research task" }); service.recordTaskEvent(exec.agent, "research-task-event", { eventType: String(args.type).slice(0, 128), summary: typeof args.summary === "string" ? args.summary.slice(0, 2000) : undefined }); return Promise.resolve({ recorded: true, ...context }); },
    }));
    registeredToolNames.push("research_record_event");
    ctx.tools.register(makeTool({
      name: "research_action",
      description: "Execute a validated research action through the local research orchestrator. Supported actions include context, list, inspect, reference, source, document, source-read, chunk-read, citation, claim, evidence, hypothesis, design, code-stage, code-read, code-review, search, task-result, evaluation, evaluate, decide-iteration, report, memory, memory-search, memory-index-rebuild, memory-retrievals, memory-review-batch, experiment, artifact, and iterate. Submit task-result only after completing the active task; experiments are only created here and execution still requires desktop approval. Use code-stage to create a new bounded, content-addressed code bundle; it cannot overwrite existing files. Use code-read for bounded hash-verified reads of registered bundle files; code-review saves Agent static findings and limitations after complete current-attempt reading, never human approval or execution. Use source-read/chunk-read with sourceId, optional contentVersionId, chunk offset and limit 1–3; cite a returned chunkId and verbatim quote. Acquisition is not reading. Inspect supports collection/offset/limit; codeReviews supports recordId and field findings or limitations, with offset and limit 1–3. Hypotheses and experimentDesigns inventories list detailFields; use recordId/field and offset/limit 1–3, follow nextOffset, join entries.text and JSON.parse for exact candidate fields. Details never grant source reading receipts or approval. Register generated files as artifacts with their content hashes and use evaluations to record metrics and uncertainty.",
      parameters: { request: { type: "json", required: true, description: "JSON request with an action and the fields required by that action. Never include secrets." } },
      output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      execute(args, exec) { return bridgeRequest(args.request, exec.signal); },
    }));
    registeredToolNames.push("research_action");
  }
  void mkdir(root, { recursive: true }).then(() => writeFile(path.join(root, "plugin-state.json"), JSON.stringify({ schema: "dsh-sci.research-plugin-state.v1", plugin: name, tools: registeredToolNames, toolHelper: toolDependencyError ? "raw-fallback" : "defineTool", loadedAt: new Date().toISOString() }, null, 2), "utf8")).catch((error) => ctx.logger?.warn?.(`dsh-sci research plugin state write failed: ${String(error)}`));
  const loadActiveContext = async () => {
    try { const value = JSON.parse(decryptMetadataText(await readFile(path.join(root, "active-context.json"), "utf8"))); const task = safeTask(value); return task; }
    catch (error) { if (error?.code !== "ENOENT") ctx.logger?.warn?.(`dsh-sci research context unavailable: ${String(error)}`); return undefined; }
  };
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const result = await next();
    const session = context?.agent;
    const task = session ? (externalRunner ? await loadActiveContext() : sessions.get(idOf(session)) ?? await loadActiveContext()) : undefined;
    if (!task) return result;
    let injectedMemory = [];
    if (externalRunner) {
      try {
        const contextValue = await bridgeRequest({ action: "context" }, undefined);
        injectedMemory = Array.isArray(contextValue?.memory) ? contextValue.memory.slice(0, 5) : [];
      } catch { /* The task tools remain available if read-only memory injection is unavailable. */ }
    }
    const text = [
      "## Active research task",
      `Project: ${task.projectId}`,
      `Task: ${task.taskId}`,
      "Use this task as the current research scope. Preserve source IDs, claim IDs, experiment IDs, and artifact references in outputs.",
      externalRunner ? "An external ResearchRunner owns task state. After using research_action tools, return only a JSON object matching dsh-sci.research-task-result.v2 with the exact planId, attemptId, submissionId and expectedTaskVersion from context; do not call task-result yourself. Include a concise summary, claim citation IDs, evidence links, and output references." : "When the active task is complete, submit a structured task-result through research_action. Include the exact execution identity from context, a concise summary, claim citation IDs, evidence links, and output references.",
      "Use hypothesis to persist proposition/scope/predictions/falsifiers and design to persist hypothesisIds/dataDescription/dataVersion/experimentalUnit/independentVariables/dependentVariables/controls/primaryMetric/repetitions/randomization/missingDataHandling/analysisMethod/stoppingRule. Return hypothesisId/designId in refs. Design approval and execution approval require the trusted Workspace. Do not claim an experiment ran unless an experiment run record exists.",
      "Read taskResultSchema/taskResultGuidance from research_context. In the final task result, refs holds persisted IDs; claims/evidence must be arrays of new objects, never arrays of existing IDs. Return empty claims/evidence when tools already persisted them. Work only on the current objective.",
      injectedMemory.length ? `## Retrieved research memory (read-only; verify scope and conflicts before relying on it)\n${injectedMemory.map((entry) => `- ${entry.memoryId} [${entry.confidence}] ${entry.text} (refs: ${(entry.refs ?? []).join(", ") || "none"})`).join("\n")}` : "## Retrieved research memory\nNo medium-or-higher-confidence memory was retrieved for this task.",
    ].join("\n");
    return { ...result, contexts: [...(result.contexts ?? []).filter((item) => item.name !== "dsh-sci-research-task"), { name: "dsh-sci-research-task", text, order: 130 }] };
  });
  const write = (type, session, data = {}) => {
    if (closed) return;
    const sessionId = idOf(session);
    const context = sessions.get(sessionId);
    const record = { schema: "dsh-sci.research-plugin-event.v1", eventId: randomUUID(), at: new Date().toISOString(), type, sessionId, ...(context ?? {}), data };
    queue = queue.then(async () => { await mkdir(root, { recursive: true }); await appendFile(eventsFile, `${JSON.stringify(record)}\n`, "utf8"); }).catch((error) => ctx.logger?.warn?.(`dsh-sci research plugin write failed: ${String(error)}`));
  };
  ctx.on("session/created", (session) => { write("session-created", session); void loadActiveContext().then((task) => { if (task) sessions.set(idOf(session), task); }); });
  ctx.on("session/event", (session, event) => { const data = { eventType: String(event?.type ?? "unknown"), seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : undefined }; write("session-event", session, data); if (!sessions.has(idOf(session))) void loadActiveContext().then((task) => { if (task) sessions.set(idOf(session), task); }); });
  ctx.on("session/disposed", (session) => { write("session-disposed", session); service.clearContext(session); });
  ctx.on("session/flush", () => queue);
  ctx.effect(() => async () => { closed = true; await queue; });
}
