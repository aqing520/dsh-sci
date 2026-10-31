import type { ResearchPlan, ResearchProject, ResearchTask } from "./domain.js";
import type { ResearchTaskResult } from "./task-result.js";
import { ResearchOrchestrator } from "./orchestrator.js";
import { ResearchResultCommitError, ResearchStaleExecutionError } from "./result-commit.js";
import { ResearchBudgetExhaustedError, ResearchBudgetPersistenceError, ResearchBudgetConfigurationError } from "./budget.js";

export interface ResearchTaskExecutionContext { project: ResearchProject; plan: ResearchPlan; task: ResearchTask; }
export interface ResearchTaskExecutor { execute(context: ResearchTaskExecutionContext, signal?: AbortSignal): Promise<unknown>; }
export interface ResearchRunResult { status: "completed" | "waiting-approval" | "blocked" | "failed" | "step-limit" | "budget-exhausted"; project: ResearchProject; plan: ResearchPlan; steps: number; reason?: string; lastResult?: ResearchTaskResult; }

/** Drives tasks until a human decision, blocker, terminal failure, or step budget. */
export class ResearchRunner {
  constructor(private readonly orchestrator: ResearchOrchestrator) {}
  async run(projectId: string, executor: ResearchTaskExecutor, options: { maxSteps?: number; signal?: AbortSignal; autoActivate?: boolean } = {}): Promise<ResearchRunResult> {
    const maxSteps = Math.max(1, Math.min(100, Math.floor(options.maxSteps ?? 20)));
    let steps = 0;
    await this.orchestrator.recoverTaskResults(projectId);
    let exported = await this.orchestrator.repository.exportProject(projectId);
    if (!exported.plan) throw new Error("research project has no plan");
    if (exported.plan.protocolReviewRequired) return { status: "blocked", project: exported.project, plan: exported.plan, steps: 0, reason: "Legacy research plan requires completion-protocol review; use Replan in Research Workspace before execution." };
    if (options.autoActivate !== false && exported.plan.status === "draft") { await this.orchestrator.activatePlan(projectId); exported = await this.orchestrator.repository.exportProject(projectId); }
    while (steps < maxSteps) {
      options.signal?.throwIfAborted();
      exported = await this.orchestrator.repository.exportProject(projectId);
      const plan = exported.plan;
      if (!plan) throw new Error("research project plan is missing");
      if (exported.project.status === "paused") return { status: exported.budget?.exhausted ? "budget-exhausted" : "blocked", project: exported.project, plan, steps, reason: exported.project.lastError ?? "Project is paused; resume explicitly before execution." };
      if (exported.project.status === "completed" || plan.status === "completed") return { status: "completed", project: exported.project, plan, steps };
      const active = plan.tasks.find((task) => ["running", "waiting-approval", "blocked"].includes(task.status));
      if (active?.status === "waiting-approval") return { status: "waiting-approval", project: exported.project, plan, steps, reason: active.nextAction ?? "Approve the current task in Research Workspace." };
      if (active?.status === "blocked") return { status: "blocked", project: exported.project, plan, steps, reason: active.nextAction ?? active.summary };
      const reservation = await this.orchestrator.prepareTaskExecution(projectId);
      if (!reservation.allowed) {
        const stopped = await this.orchestrator.repository.exportProject(projectId);
        return { status: reservation.status, project: stopped.project, plan: stopped.plan!, steps, reason: reservation.reason };
      }
      const { project, plan: executionPlan, task } = reservation;
      const wallSignal = AbortSignal.timeout(reservation.remainingMs);
      const taskSignal = options.signal ? AbortSignal.any([options.signal, wallSignal]) : wallSignal;
      const deadlineAt = Date.now() + reservation.remainingMs;
      let result: ResearchTaskResult;
      try {
        const raw = await executor.execute({ project, plan: executionPlan, task }, taskSignal);
        taskSignal.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new Error("Research wall time budget exhausted");
        result = await this.orchestrator.submitTaskResult(projectId, raw);
      } catch (error) {
        if (error instanceof ResearchBudgetExhaustedError || error instanceof ResearchBudgetPersistenceError || error instanceof ResearchBudgetConfigurationError) {
          const stopped = await this.orchestrator.repository.exportProject(projectId);
          return { status: error instanceof ResearchBudgetExhaustedError ? "budget-exhausted" : "blocked", project: stopped.project, plan: stopped.plan!, steps, reason: error.message };
        }
        if (error instanceof ResearchResultCommitError) {
          const stopped = await this.orchestrator.repository.exportProject(projectId);
          return { status: "blocked", project: stopped.project, plan: stopped.plan!, steps, reason: error.message };
        }
        if (options.signal?.aborted) throw error;
        if (wallSignal.aborted || Date.now() >= deadlineAt) {
          await this.orchestrator.exhaustBudget(projectId, "wall-time");
          const stopped = await this.orchestrator.repository.exportProject(projectId);
          return { status: "budget-exhausted", project: stopped.project, plan: stopped.plan!, steps, reason: stopped.project.lastError };
        }
        const message = error instanceof Error ? error.message : String(error);
        let failed;
        try { failed = await this.orchestrator.failTask(projectId, task.taskId, message, task); }
        catch (failure) {
          if (!(failure instanceof ResearchStaleExecutionError)) throw failure;
          const stopped = await this.orchestrator.repository.exportProject(projectId);
          return { status: "blocked", project: stopped.project, plan: stopped.plan!, steps, reason: failure.message };
        }
        steps += 1;
        if (failed.project.status === "failed") return { status: "failed", project: failed.project, plan: failed.plan, steps };
        continue;
      }
      steps += 1;
      const next = await this.orchestrator.repository.exportProject(projectId);
      if (next.project.status === "completed" || next.plan?.status === "completed") return { status: "completed", project: next.project, plan: next.plan!, steps, lastResult: result };
      if (result.status === "blocked") return { status: "blocked", project: next.project, plan: next.plan!, steps, lastResult: result };
      if (result.status === "needs-approval") return { status: "waiting-approval", project: next.project, plan: next.plan!, steps, lastResult: result };
      if (result.status === "failed" && next.project.status === "failed") return { status: "failed", project: next.project, plan: next.plan!, steps, lastResult: result };
    }
    const final = await this.orchestrator.repository.exportProject(projectId);
    return { status: "step-limit", project: final.project, plan: final.plan!, steps };
  }
}
