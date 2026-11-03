import path from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ResearchOrchestrator } from "./orchestrator.js";
import type { ResearchConversationBinding } from "./repository.js";
import { allowedActionsFor } from "./task-contract.js";
import { researchReferenceIds } from "./result-references.js";
import { normalizeModelUsage } from "../model-usage.js";
import { makeEvent } from "./domain.js";

type Request = Record<string, any>;
type Dispatch = (orchestrator: ResearchOrchestrator, input: Request) => Promise<unknown>;
const scientificActions = new Set(allowedActionsFor("conversation"));

/** Trusted Harness supplies conversation identity, never the model's tool arguments.
 * All persistence and execution still go through the existing kernel. */
export class ResearchConversations {
  constructor(readonly base: ResearchOrchestrator, readonly options: { observeWorkspace?: (workspaceRoot: string, sessionId: string, force: boolean) => Promise<void> } = {}) {}

  private async scope(input: Request) {
    const { sessionId, cwd } = input.conversation ?? {};
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256 || typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Research requires a real session and absolute workspace directory");
    const resolved = await realpath(cwd);
    const workspaceRoot = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    await this.options.observeWorkspace?.(workspaceRoot, sessionId, input.action === "conversation-checkpoint");
    const key = createHash("sha256").update(JSON.stringify([sessionId, workspaceRoot])).digest("hex");
    const orchestrator = new ResearchOrchestrator(this.base.repository, this.base.memoryOptions, this.base.planner, { ...this.base.options, sessionScoped: true, experimentPolicy: { ...this.base.options.experimentPolicy, workspaceRoot } });
    const binding = await this.base.repository.readConversationBinding(key);
    if (binding && (binding.schema !== "dsh-sci.research-conversation.v1" || binding.sessionId !== sessionId || binding.workspaceRoot !== workspaceRoot)) throw new Error("Research conversation binding does not match this session/workspace");
    return { sessionId, workspaceRoot, key, orchestrator, binding };
  }

  async dispatch(input: Request, signal: AbortSignal, next: Dispatch): Promise<unknown> {
    signal.throwIfAborted();
    const scope = await this.scope(input);
    const repository = this.base.repository;
    let binding = scope.binding;
    if (input.action === "conversation-begin") {
      if (binding && (input.newResearch === true || (input.projectId !== undefined && input.projectId !== binding.projectId))) {
        if (!input.trustedApproval) throw new Error("This session already has research; switching projects requires an explicit host action");
        const budget = await repository.readBudget(binding.projectId);
        if (budget?.schema === "dsh-sci.research-budget.v2" && budget.modelRequests.some((item) => item.status === "reserved")) throw new Error("Wait for the current model request to settle before switching research");
      }
      if (input.projectId !== undefined) {
        let project = await repository.readProject(input.projectId);
        if (project && project.mode !== "conversation" && input.trustedApproval) project = await scope.orchestrator.adoptConversation(project.projectId, scope.workspaceRoot);
        if (!project || project.mode !== "conversation" || project.workspaceRoot !== scope.workspaceRoot) throw new Error("Only a conversation research project from this workspace can be resumed");
        binding = binding?.projectId === project.projectId ? binding : { schema: "dsh-sci.research-conversation.v1", sessionId: scope.sessionId, workspaceRoot: scope.workspaceRoot, projectId: project.projectId, updatedAt: new Date().toISOString() };
      } else if (!binding || input.newResearch === true) {
        if (typeof input.question !== "string" || !input.question.trim()) throw new Error("A research question is required to begin");
        const created = await scope.orchestrator.createProject(input.question, { plan: { question: input.question, tasks: [{ taskId: "conversation", title: "Research in this conversation", objective: input.question, kind: "conversation" }] } });
        await repository.saveProject({ ...created.project, mode: "conversation", workspaceRoot: scope.workspaceRoot });
        await scope.orchestrator.activatePlan(created.project.projectId);
        const reservation = await scope.orchestrator.prepareTaskExecution(created.project.projectId);
        if (!reservation.allowed) throw new Error(reservation.reason);
        binding = { schema: "dsh-sci.research-conversation.v1", sessionId: scope.sessionId, workspaceRoot: scope.workspaceRoot, projectId: created.project.projectId, updatedAt: new Date().toISOString() };
      }
      await repository.saveConversationBinding(scope.key, binding!);
    }
    if (!binding) {
      if (input.action === "context") return { active: false, workspaceRoot: scope.workspaceRoot, availableResearch: (await repository.listProjects()).filter((item) => item.mode === "conversation" && item.workspaceRoot === scope.workspaceRoot).slice(0, 5).map(({ projectId, title, status, updatedAt }) => ({ projectId, title, status, updatedAt })), guidance: "Resume an available project with research_begin(projectId) when continuing prior work. Begin a new question only when needed. Ordinary chat needs no project." };
      throw new Error("No research is bound to this conversation; call research_begin first");
    }
    if (input.projectId !== undefined && input.projectId !== binding.projectId) throw new Error("Research action must target this conversation's project");
    const project = await repository.readProject(binding.projectId);
    if (!project || project.mode !== "conversation" || project.workspaceRoot !== scope.workspaceRoot) throw new Error("Research project workspace does not match the conversation");
    scope.orchestrator = await this.base.forProject(project.projectId);
    const plan = project.planId ? await repository.readPlan(project.projectId, project.planId) : undefined;
    const task = plan?.tasks.find((item) => item.taskId === project.activeTaskId);
    if (input.action === "context" || input.action === "conversation-begin") {
      const memory = task?.status === "running" && project.status !== "paused" ? await scope.orchestrator.taskMemoryContext(project.projectId, task, signal) : {};
      const budget = await repository.readBudget(project.projectId);
      const { modelRequests: _requests, ...budgetSummary } = budget?.schema === "dsh-sci.research-budget.v2" ? budget : { ...budget, modelRequests: undefined };
      const [sources, claims, runs] = await Promise.all([repository.listSources(project.projectId), repository.listClaims(project.projectId), repository.listExperimentRuns(project.projectId)]);
      const recentEvidence = { sources: sources.slice(-5).map(({ sourceId, title, reading, latestContentVersionId }) => ({ sourceId, title, reading, latestContentVersionId })), claims: claims.slice(-3).map(({ claimId, text, citationIds, confidence }) => ({ claimId, text: text.slice(0, 1000), citationIds, confidence })), runs: runs.slice(-3).map(({ runId, experimentId, state, exitCode, finishedAt }) => ({ runId, experimentId, state, exitCode, finishedAt })) };
      return { active: true, projectId: project.projectId, taskId: task?.taskId, project, task: task ? { taskId: task.taskId, kind: task.kind, status: task.status, objective: task.objective } : undefined, workspaceRoot: scope.workspaceRoot, checkpoint: await repository.readConversationCheckpoint(project.projectId) ?? binding.checkpoint, recentEvidence, budget: budgetSummary, ...memory, guidance: "Continue in this conversation with scientific tools. Reply normally; checkpoints are durable notes, never proof that a scientific claim or experiment is validated." };
    }
    if (input.action === "conversation-checkpoint") {
      if (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 4000 || !Array.isArray(input.refs) || input.refs.length > 100 || input.refs.some((ref: unknown) => typeof ref !== "string")) throw new Error("Checkpoint needs a bounded summary and registered reference IDs");
      const snapshot = await repository.exportProject(project.projectId);
      const known = researchReferenceIds(snapshot, await repository.listMemory());
      if (input.refs.some((ref: string) => !known.has(ref))) throw new Error("Checkpoint contains unregistered references");
      const at = new Date().toISOString();
      const checkpoint = { summary: input.summary, refs: [...new Set<string>(input.refs)], at };
      await repository.saveConversationCheckpoint(project.projectId, checkpoint);
      await repository.appendEvent(makeEvent(project.projectId, "research-action-accepted", { planId: plan?.planId, taskId: task?.taskId, values: { action: "conversation-checkpoint", ...checkpoint } }));
      await repository.saveConversationBinding(scope.key, { ...binding, checkpoint, updatedAt: at });
      return { projectId: project.projectId, checkpoint, scientificAcceptance: "not-implied" };
    }
    if (input.action === "conversation-reserve") {
      if (!task?.attemptId || !plan) throw new Error("Research has no active execution identity");
      return { projectId: project.projectId, reservationId: await scope.orchestrator.reserveModelRequest(project.projectId, { phase: "task", planId: plan.planId, taskId: task.taskId, attemptId: task.attemptId }) };
    }
    if (input.action === "conversation-settle") {
      if (typeof input.reservationId !== "string") throw new Error("Missing model reservation");
      await scope.orchestrator.recordModelUsage(project.projectId, input.reservationId, normalizeModelUsage(input.usage));
      return { settled: true };
    }
    if (input.action === "conversation-design-review") {
      const design = await repository.readExperimentDesign(project.projectId, input.designId);
      if (!design || design.planId !== plan?.planId) throw new Error("Design does not belong to this research plan");
      return { projectId: project.projectId, design, scientificAcceptance: "not-implied" };
    }
    if (input.action === "conversation-approve-design") {
      if (!input.trustedApproval) throw new Error("Design approval requires the trusted Harness approval capability");
      return scope.orchestrator.approveExperimentDesign(project.projectId, input.designId, input.contentHash);
    }
    if (input.action === "conversation-experiment-review" || input.action === "conversation-execute") {
      const experiment = await repository.readExperiment(project.projectId, input.experimentId);
      if (!experiment || experiment.planId !== plan?.planId) throw new Error("Experiment does not belong to this research plan");
      const runs = (await repository.listExperimentRuns(project.projectId)).filter((run) => run.experimentId === experiment.experimentId);
      if (runs.length) {
        if (runs.length === 1 && runs[0].state === "completed") return { reused: true, run: runs[0] };
        throw new Error("This proposal already ran; review its records and create a new proposal before another execution");
      }
      const review = await scope.orchestrator.experimentReview(project.projectId, input.experimentId);
      if (input.action === "conversation-experiment-review") return { projectId: project.projectId, experiment, ...review };
      if (!input.trustedApproval) throw new Error("Experiment execution requires the trusted Harness approval capability");
      if (review.files.some((file) => file.truncated)) throw new Error("Experiment files exceed the in-conversation review limit; inspect complete files before execution");
      await scope.orchestrator.approveExperiment(project.projectId, input.experimentId, input.contentHash);
      const run = await scope.orchestrator.executeExperiment(project.projectId, input.experimentId, { approved: true, signal });
      await this.options.observeWorkspace?.(scope.workspaceRoot, scope.sessionId, true);
      return run;
    }
    if (input.action === "conversation-budget") {
      if (!input.trustedApproval) throw new Error("Budget changes require the trusted Harness approval capability");
      const budget = await scope.orchestrator.updateBudget(project.projectId, input.limits, { restartWallClock: input.restartWallClock === true });
      if (project.status === "paused" && project.lastError?.startsWith("Research budget exhausted")) {
        await scope.orchestrator.resume(project.projectId);
        if (task?.status !== "running") await scope.orchestrator.prepareTaskExecution(project.projectId);
      }
      return { projectId: project.projectId, budget };
    }
    if (input.action === "conversation-pause" || input.action === "conversation-resume") {
      if (!input.trustedApproval) throw new Error("Research state changes require an explicit host action");
      if (input.action === "conversation-pause") return scope.orchestrator.pause(project.projectId);
      const resumed = await scope.orchestrator.resume(project.projectId);
      if (task?.status !== "running") {
        const execution = await scope.orchestrator.prepareTaskExecution(project.projectId);
        if (!execution.allowed) throw new Error(execution.reason);
      }
      return resumed;
    }
    if (!scientificActions.has(input.action)) throw new Error("Action is not available to conversation research tools");
    if (project.status === "paused" || task?.status !== "running") throw new Error("Research is paused or not running; review the budget and saved state before resuming");
    if (input.taskId !== undefined && input.taskId !== task.taskId) throw new Error("Research action must target this conversation's task");
    if (input.action === "document") {
      if (typeof input.file !== "string") throw new Error("Document path is required");
      const file = await realpath(path.resolve(scope.workspaceRoot, input.file));
      const relative = path.relative(scope.workspaceRoot, file);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Research document must belong to this conversation's workspace");
      input = { ...input, file };
    }
    if (input.action === "artifact") {
      const artifact = input.artifact ?? input;
      if (typeof artifact.path !== "string") throw new Error("Artifact path is required");
      input = { ...input, artifact: { ...artifact, path: path.resolve(scope.workspaceRoot, artifact.path) } };
    }
    if (input.action === "citation") {
      const chunkId = input.locator?.chunkId;
      const content = typeof input.contentVersionId === "string" ? await repository.readSourceContent(project.projectId, input.contentVersionId) : undefined;
      const chunk = content?.chunks.find((item) => item.chunkId === chunkId);
      const reads = await repository.listSourceReads(project.projectId);
      if (!content || content.sourceId !== input.sourceId || !chunk || typeof input.quotedText !== "string" || !input.quotedText.trim() || !chunk.text.includes(input.quotedText)
        || !reads.some((read) => read.audience === "agent" && read.contentVersionId === content.contentVersionId && read.taskId === task.taskId && read.attemptId === task.attemptId && read.chunkIds.includes(chunkId))) throw new Error("Citation must quote a chunk read by this research task from the exact saved version");
    }
    // A native proposal always binds code/design to the current conversation task.
    if (["evaluation", "evaluate"].includes(input.action)) input = { ...input, evaluation: { ...(input.evaluation ?? input), planId: plan!.planId, taskId: task.taskId } };
    return next(scope.orchestrator, { ...input, projectId: project.projectId, ...(["hypothesis", "design", "experiment", "claim"].includes(input.action) ? { taskId: task.taskId } : {}) });
  }
}
