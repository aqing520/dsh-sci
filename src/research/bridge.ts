import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { ResearchOrchestrator } from "./orchestrator.js";
import type { ResearchSecurityAudit } from "./repository.js";
import type { SearchProvider } from "../services.js";
import { makeEvent, type ResearchProject } from "./domain.js";
import { researchTaskResultGuidance, researchTaskResultSchema, taskResultIdentity } from "./task-result.js";
import { researchInspection } from "./inspect.js";
import { codeStagingFailureCode } from "./code-staging.js";

export const researchActions = ["context", "list", "create", "inspect", "approval-queue", "activate", "start", "complete", "fail", "task-result", "source", "reference", "source-read", "chunk-read", "citation", "claim", "evidence", "hypothesis", "design", "code-stage", "code-read", "code-review", "document", "search", "experiment", "artifact", "evaluation", "evaluate", "decide-iteration", "report", "report-read", "memory", "memory-search", "memory-index-rebuild", "memory-retrievals", "memory-conflicts", "memory-review", "memory-review-batch", "iterate"] as const;

/** The desktop owns all writes. The Harness receives only a short-lived loopback capability. */
export async function startResearchBridge(orchestrator: ResearchOrchestrator, options: { search?: SearchProvider; runnerProjectId?: string; maxRequestsPerMinute?: number; access?: "research" | "read-only"; scopeProjectId?: string } = {}) {
  options = { ...options };
  if (options.access !== undefined && !["research", "read-only"].includes(options.access)) throw new Error("Invalid research bridge access");
  if (options.access === "read-only" && options.runnerProjectId) throw new Error("Read-only bridge cannot run automatic tasks");
  if (options.scopeProjectId && options.runnerProjectId && options.scopeProjectId !== options.runnerProjectId) throw new Error("Bridge project scopes conflict");
  // Permissions are fixed by the trusted host when this token is issued; request fields cannot change them.
  const readOnly = options.access === "read-only", scopeProjectId = options.scopeProjectId ?? options.runnerProjectId;
  // Source reading and searches save receipts, query logs or indexes, so they require write access.
  const readerActions = new Set(["context", "list", "inspect", "approval-queue", "report-read", "memory-retrievals", "memory-conflicts"]);
  const token = randomBytes(32).toString("hex");
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  const requestTimes: number[] = [];
  const dispatch = async (input: Record<string, any>, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const repository = orchestrator.repository;
    if (readOnly && !readerActions.has(input.action)) throw new Error("Read-only research capability refuses this action");
    if (scopeProjectId) {
      if (input.projectId !== undefined && input.projectId !== scopeProjectId) throw new Error(options.runnerProjectId ? "Research action must target the runner project" : "Research action must target the capability project");
      if (input.action === "create") throw new Error("Project-scoped capability cannot create another project");
      input = { ...input, projectId: scopeProjectId };
    }
    if (readOnly && input.action === "context") {
      const scopedProject = scopeProjectId ? await repository.readProject(scopeProjectId) : undefined;
      const active = scopeProjectId ? scopedProject?.activeTaskId ? { projectId: scopeProjectId, taskId: scopedProject.activeTaskId, planId: scopedProject.planId } : undefined : await repository.readActiveContext();
      const projectId = scopeProjectId ?? active?.projectId;
      if (!projectId) return { active: false, readOnly: true };
      const snapshot = await repository.exportProject(projectId);
      return { readOnly: true, project: snapshot.project, task: snapshot.plan?.tasks.find((task) => task.taskId === snapshot.project.activeTaskId) };
    }
    if (options.runnerProjectId) {
      const allowed = new Set(["context", "inspect", "source", "reference", "source-read", "chunk-read", "citation", "claim", "evidence", "hypothesis", "design", "code-stage", "code-read", "code-review", "document", "search", "experiment", "artifact", "evaluation", "evaluate", "decide-iteration", "report", "report-read", "memory", "memory-search", "memory-index-rebuild", "memory-retrievals", "memory-conflicts"]);
      if (!allowed.has(input.action)) throw new Error("Action is not permitted in an automatic research task");
      if (input.projectId !== undefined && input.projectId !== options.runnerProjectId) throw new Error("Research action must target the runner project");
      input = { ...input, projectId: options.runnerProjectId };
      const project = await repository.readProject(options.runnerProjectId);
      const plan = project?.planId ? await repository.readPlan(project.projectId, project.planId) : undefined;
      const task = plan?.tasks.find((item) => item.taskId === project?.activeTaskId);
      if (!project || project.status === "paused" || task?.status !== "running") throw new Error("Research action requires the runner's active task");
      if (input.taskId !== undefined && input.taskId !== task.taskId) throw new Error("Research action must target the active task");
      if (input.action !== "context" && !(task.allowedActions ?? []).includes(String(input.action))) throw new Error(`Action ${String(input.action)} is not allowed for task kind ${task.kind}`);
      if (input.action === "experiment") input = { ...input, taskId: task.taskId };
      if (input.action === "claim") input = { ...input, taskId: task.taskId };
      if (["hypothesis", "design"].includes(input.action)) input = { ...input, taskId: task.taskId };
      if (["evaluation", "evaluate"].includes(input.action)) {
        const evaluation = input.evaluation ?? input;
        if (evaluation.planId !== undefined && evaluation.planId !== plan!.planId) throw new Error("Research evaluation must target the active plan");
        input = { ...input, evaluation: { ...evaluation, planId: plan!.planId, taskId: task.taskId } };
      }
      if (input.action === "context") {
        const memoryContext = await orchestrator.taskMemoryContext(project.projectId, task, signal);
        return { projectId: project.projectId, planId: plan!.planId, taskId: task.taskId, project, task, ...memoryContext, resultIdentity: taskResultIdentity(task), taskResultSchema: researchTaskResultSchema, taskResultGuidance: researchTaskResultGuidance };
      }
    }
    if (input.action === "context") {
      const scopedProject = scopeProjectId ? await repository.readProject(scopeProjectId) : undefined;
      const active = scopeProjectId ? scopedProject?.activeTaskId ? { projectId: scopeProjectId, taskId: scopedProject.activeTaskId, planId: scopedProject.planId } : undefined : await repository.readActiveContext();
      if (!active) return { active: false };
      const snapshot = await repository.exportProject(active.projectId);
      const task = snapshot.plan?.tasks.find((task) => task.taskId === active.taskId);
      const memoryContext = task?.status === "running" && snapshot.project.status !== "paused" ? await orchestrator.taskMemoryContext(snapshot.project.projectId, task, signal) : {};
      return { ...active, project: snapshot.project, task, ...memoryContext, resultIdentity: task?.status === "running" && !snapshot.plan?.protocolReviewRequired ? taskResultIdentity(task) : undefined, taskResultSchema: researchTaskResultSchema, taskResultGuidance: researchTaskResultGuidance };
    }
    if (input.action === "list") { const scoped = scopeProjectId ? await repository.readProject(scopeProjectId) : undefined; return scopeProjectId ? scoped ? [scoped] : [] : repository.listProjects(); }
    if (input.action === "approval-queue") {
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000)) throw new Error("approval queue limit must be an integer between 1 and 10000");
      return (await repository.listApprovalQueue(scopeProjectId ? 10_000 : input.limit)).filter((item) => !scopeProjectId || item.project.projectId === scopeProjectId).slice(0, input.limit ?? 100);
    }
    if (input.action === "create") return orchestrator.createProject(required(input.question, "question"));
    if (input.action === "memory-search") return orchestrator.searchMemory(required(input.query, "query"), { projectId: input.projectId, limit: input.limit, since: input.since, until: input.until, minConfidence: input.minConfidence, rewrittenQuery: input.rewrittenQuery }, signal);
    if (input.action === "memory-index-rebuild") return orchestrator.rebuildMemoryIndex(typeof input.projectId === "string" ? input.projectId : undefined, signal);
    if (input.action === "memory-retrievals") { if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new Error("Memory retrieval limit must be 1 to 100"); return (await repository.listMemoryRetrievals(10_000)).filter((record) => input.projectId === undefined || record.projectId === input.projectId).slice(-(input.limit ?? 20)); }
    if (input.action === "memory-conflicts") return orchestrator.listMemoryConflicts(required(input.projectId, "projectId"));
    const projectId = required(input.projectId, "projectId");
    switch (input.action) {
      case "inspect": return researchInspection(await repository.exportProject(projectId), input);
      case "activate": return orchestrator.activatePlan(projectId);
      case "start": return orchestrator.startNextTask(projectId);
      case "complete": return orchestrator.completeTask(projectId, required(input.taskId, "taskId"), input.outputRefs ?? []);
      case "fail": return orchestrator.failTask(projectId, required(input.taskId, "taskId"), required(input.error, "error"));
      case "task-result": return orchestrator.submitTaskResult(projectId, input.result ?? input);
      case "source": { const source = await orchestrator.addSource(projectId, input.source ?? input); return { ...source, excerpt: undefined }; }
      case "reference": {
        const source = await orchestrator.resolveReference(projectId, required(input.reference, "reference"), { signal });
        return { ...source, excerpt: undefined, guidance: "Use source-read to read saved content; acquisition is not reading." };
      }
      case "source-read":
      case "chunk-read": return orchestrator.readSource(projectId, { sourceId: required(input.sourceId, "sourceId"), contentVersionId: input.contentVersionId, offset: input.offset, limit: input.limit }, "agent");
      case "citation": return orchestrator.addCitation(projectId, required(input.sourceId, "sourceId"), input);
      case "claim": return orchestrator.addClaim(projectId, input as any);
      case "evidence": return orchestrator.addEvidence(projectId, input as any);
      case "hypothesis": return orchestrator.createHypothesis(projectId, input as any);
      case "design": return orchestrator.createExperimentDesign(projectId, input as any);
      case "code-stage": return orchestrator.stageCode(projectId, input as any);
      case "code-read": return orchestrator.readCode(projectId, { bundleId: required(input.bundleId, "bundleId"), fileName: required(input.fileName, "fileName"), offset: input.offset, limit: input.limit });
      case "code-review": return orchestrator.reviewCode(projectId, input as any);
      case "document": {
        const result = await orchestrator.ingestDocument(projectId, required(input.file, "file"));
        const { text: _text, chunks: _chunks, ...document } = result.document;
        return { source: { ...result.source, excerpt: undefined }, document, guidance: "Content was saved, not read. Use source-read with sourceId and chunk offsets (limit 1–3)." };
      }
      case "search": {
        const found = await orchestrator.searchSources(projectId, required(input.query, "query"), options.search, { signal, actor: "agent", backend: input.backend });
        return { ...found, sources: found.sources.map((source) => ({ ...source, excerpt: source.excerpt?.slice(0, 512) })) };
      }
      // Agent may propose a command; approval and execution remain desktop actions.
      case "experiment": return orchestrator.createExperiment(projectId, input as any);
      case "artifact": return orchestrator.registerArtifact(projectId, input.artifact ?? input);
      case "evaluation": return orchestrator.recordEvaluation(projectId, input.evaluation ?? input);
      case "evaluate": return orchestrator.recordAutomaticEvaluation(projectId, input.evaluation ?? input);
      case "decide-iteration": return orchestrator.decideIteration(projectId);
      case "report": return orchestrator.generateReport(projectId);
      case "report-read": return orchestrator.readReport(projectId, typeof input.reportId === "string" ? input.reportId : undefined);
      case "memory": return orchestrator.remember(projectId, input as any);
      case "memory-review": return orchestrator.reviewMemoryConflict(projectId, { conflictKey: required(input.conflictKey, "conflictKey"), status: input.status, selectedMemoryId: input.selectedMemoryId, note: input.note });
      case "memory-review-batch": {
        if (!Array.isArray(input.reviews)) throw new Error("memory review batch requires reviews");
        return orchestrator.reviewMemoryConflicts(projectId, input.reviews.map((review: any) => ({ conflictKey: required(review?.conflictKey, "conflictKey"), status: review?.status, selectedMemoryId: review?.selectedMemoryId, note: review?.note })));
      }
      case "iterate": return orchestrator.iterate(projectId, required(input.reason, "reason"), signal);
      default: throw new Error("Unknown research action");
    }
  };
  const auditAction = async (input: Record<string, any>, project: ResearchProject | undefined, outcome: "accepted" | "rejected", error?: unknown) => {
    const repository = orchestrator.repository;
    if (!project || readOnly) return;
    // Never persist the request body, provider errors, paths, tokens or source text.
    const action = researchActions.includes(input.action) ? input.action : "unknown";
    await repository.appendEvent(makeEvent(project.projectId, outcome === "accepted" ? "research-action-accepted" : "research-action-rejected", { planId: project.planId, taskId: project.activeTaskId, values: { action, actor: options.runnerProjectId ? "automatic-runner" : "dsh-plugin", outcome, ...(outcome === "rejected" ? { reason: "Action validation or execution failed", ...(action === "code-stage" ? { failureCode: codeStagingFailureCode(error) } : {}) } : {}) } }));
  };
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => { if (!response.destroyed) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); } };
    const requestId = randomUUID();
    response.setHeader("x-research-request-id", requestId);
    let audited = false;
    const securityAudit = async (entry: { action: string; outcome: "accepted" | "rejected"; reason?: ResearchSecurityAudit["reason"]; projectId?: string }) => {
      if (audited) return; audited = true;
      const action = researchActions.includes(entry.action as typeof researchActions[number]) ? entry.action : "unknown";
      const projectId = typeof entry.projectId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry.projectId) ? entry.projectId : undefined;
      try { await orchestrator.repository.appendSecurityAudit({ requestId, action, outcome: entry.outcome, ...(projectId ? { projectId } : {}), ...(entry.reason ? { reason: entry.reason } : {}) }); }
      catch { process.emitWarning("Research security audit persistence is unavailable", { code: "DSH_SCI_SECURITY_AUDIT_UNAVAILABLE" }); }
    };
    const expected = Buffer.from(`Bearer ${token}`);
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected) || request.headers.origin) { await securityAudit({ action: "unknown", outcome: "rejected", reason: "authentication" }); send(401, { error: "Unauthorized" }); return; }
    if (closed || request.method !== "POST" || request.url !== "/research") { await securityAudit({ action: "unknown", outcome: "rejected", reason: "route" }); send(404, { error: "Not found" }); return; }
    const now = Date.now();
    while (requestTimes.length && requestTimes[0] <= now - 60_000) requestTimes.shift();
    const limit = Math.max(10, Math.min(10_000, Math.floor(options.maxRequestsPerMinute ?? 120)));
    if (requestTimes.length >= limit) { await securityAudit({ action: "unknown", outcome: "rejected", reason: "rate-limit" }); send(429, { error: "Research bridge rate limit exceeded" }); return; }
    requestTimes.push(now);
    const controller = new AbortController(); controllers.add(controller);
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    let input: Record<string, any> | undefined;
    try {
      input = await readInput(request);
      const actionInput = input;
      const operation = queue.catch(() => undefined).then(async () => {
        const projectId = scopeProjectId ?? (typeof actionInput.projectId === "string" ? actionInput.projectId.trim() : undefined);
        const project = projectId ? await orchestrator.repository.readProject(projectId) : undefined;
        let value: unknown;
        try {
          value = await dispatch(actionInput, controller.signal);
        } catch (error) {
          await auditAction(actionInput, project, "rejected", error);
          await securityAudit({ action: actionInput.action, outcome: "rejected", reason: "action-validation-or-execution", ...(project ? { projectId: project.projectId } : {}) });
          throw error;
        }
        await auditAction(actionInput, project, "accepted");
        await securityAudit({ action: actionInput.action, outcome: "accepted", ...(project ? { projectId: project.projectId } : {}) });
        return value;
      });
      queue = operation;
      send(200, await operation);
    } catch (error) {
      await securityAudit({ action: input?.action ?? "unknown", outcome: "rejected", reason: input ? "project-lookup" : "malformed-request" });
      send(400, { error: error instanceof Error ? error.message : "Research action failed" });
    }
    finally { controllers.delete(controller); }
  });
  server.requestTimeout = 30_000;
  // OS-assigned ephemeral ports can include Fetch's forbidden ports (for example
  // 6000 or 10080). The plugin uses Fetch, so bind in the high dynamic range.
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
        const onListening = () => { server.removeListener("error", onError); resolve(); };
        server.once("error", onError); server.once("listening", onListening);
        server.listen(randomInt(49152, 65536), "127.0.0.1");
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 19) throw error;
    }
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Research bridge has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/research`, token,
    close(): Promise<void> {
      closed = true;
      closePromise ??= (async () => {
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await queue.catch(() => undefined);
      })();
      return closePromise;
    },
  };
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
async function readInput(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Research request exceeds 1 MB");
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Research request must be an object");
  if (typeof input.action !== "string" || !/^[a-z][a-z0-9-]{1,63}$/u.test(input.action)) throw new Error("Research request action is invalid");
  return input;
}
