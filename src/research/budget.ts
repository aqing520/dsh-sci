import { randomUUID } from "node:crypto";
import { normalizeModelUsage, type ModelUsage } from "../model-usage.js";

export interface ResearchBudgetLimits { maxTaskExecutions: number; maxWallTimeMs: number; maxModelRequests?: number; maxModelTokens?: number; }
export type BudgetExhaustion = "task-executions" | "wall-time" | "model-requests" | "model-tokens";
interface TaskBudget {
  projectId: string; revision: number; maxTaskExecutions: number; maxWallTimeMs: number;
  usedTaskExecutions: number; startedAt?: string; updatedAt: string; exhausted?: BudgetExhaustion;
}
export interface LegacyResearchBudget extends TaskBudget { schema: "dsh-sci.research-budget.v1"; }
export interface ModelRequestScope { phase: "planner" | "replan" | "task"; planId?: string; taskId?: string; attemptId?: string; }
export interface ModelRequestReservation extends ModelRequestScope {
  reservationId: string; reservedAt: string; status: "reserved" | "settled";
  settledAt?: string; usage?: ModelUsage; interrupted?: boolean;
}
export interface MeteredResearchBudget extends TaskBudget {
  schema: "dsh-sci.research-budget.v2";
  maxModelRequests: number; maxModelTokens: number; usedModelRequests: number;
  reportedInputTokens: number; reportedOutputTokens: number; reportedTotalTokens: number;
  unknownUsageRequests: number; modelRequests: ModelRequestReservation[];
  unmeteredHistory?: true;
}
export type ResearchBudget = LegacyResearchBudget | MeteredResearchBudget;
export const defaultResearchBudget: Required<ResearchBudgetLimits> = { maxTaskExecutions: 100, maxWallTimeMs: 60 * 60_000, maxModelRequests: 100, maxModelTokens: 1_000_000 };

export class ResearchBudgetConfigurationError extends Error { constructor(message = "Legacy project requires explicit model budget configuration in Research Workspace") { super(message); this.name = "ResearchBudgetConfigurationError"; } }
export class ResearchBudgetPersistenceError extends Error { constructor(options?: ErrorOptions) { super("Research budget could not be persisted; review storage before retrying", options); this.name = "ResearchBudgetPersistenceError"; } }
export class ResearchBudgetExhaustedError extends Error {
  constructor(readonly reason: BudgetExhaustion) { super(`Research budget exhausted (${reason}); explicitly increase limits before resuming.`); this.name = "ResearchBudgetExhaustedError"; }
}

export function validateBudgetLimits(input: ResearchBudgetLimits): ResearchBudgetLimits {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("research budget limits must be an object");
  for (const [key, maximum] of [["maxTaskExecutions", 10_000], ["maxWallTimeMs", 7 * 24 * 60 * 60_000], ["maxModelRequests", 10_000], ["maxModelTokens", 100_000_000]] as const) {
    const value = input[key];
    if (value === undefined && (key === "maxModelRequests" || key === "maxModelTokens")) continue;
    if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum) throw new Error(`budget.${key} must be a positive integer no greater than ${maximum}`);
  }
  return { maxTaskExecutions: input.maxTaskExecutions, maxWallTimeMs: input.maxWallTimeMs, ...(input.maxModelRequests === undefined ? {} : { maxModelRequests: input.maxModelRequests }), ...(input.maxModelTokens === undefined ? {} : { maxModelTokens: input.maxModelTokens }) };
}
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function counter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validateScope(scope: ModelRequestScope): void {
  if (!["planner", "replan", "task"].includes(scope.phase)) throw new Error("research budget model phase is invalid");
  for (const key of ["planId", "taskId", "attemptId"] as const) if (scope[key] !== undefined && (typeof scope[key] !== "string" || !scope[key]!.trim() || scope[key]!.length > 256)) throw new Error("research budget model scope is invalid");
}

export function validateResearchBudget(input: unknown, projectId?: string): ResearchBudget {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("research budget must be an object");
  const budget = input as ResearchBudget;
  if (!["dsh-sci.research-budget.v1", "dsh-sci.research-budget.v2"].includes(budget.schema)) throw new Error("unsupported research budget schema");
  if (typeof budget.projectId !== "string" || !budget.projectId || (projectId !== undefined && budget.projectId !== projectId)) throw new Error("research budget project does not match");
  validateBudgetLimits(budget);
  if (!counter(budget.revision) || budget.revision >= Number.MAX_SAFE_INTEGER) throw new Error("research budget revision is invalid");
  if (!counter(budget.usedTaskExecutions)) throw new Error("research budget counter is invalid");
  if (!validTime(budget.updatedAt) || (budget.startedAt !== undefined && !validTime(budget.startedAt)) || (budget.usedTaskExecutions > 0 && !budget.startedAt)) throw new Error("research budget timestamps are invalid");
  if (budget.exhausted !== undefined && !["task-executions", "wall-time", "model-requests", "model-tokens"].includes(budget.exhausted)) throw new Error("research budget exhaustion reason is invalid");
  if (budget.schema === "dsh-sci.research-budget.v1") return budget;
  if (budget.unmeteredHistory !== undefined && budget.unmeteredHistory !== true) throw new Error("research budget historical usage marker is invalid");
  if (!budget.maxModelRequests || !budget.maxModelTokens || !Array.isArray(budget.modelRequests) || budget.modelRequests.length > 10_000) throw new Error("research budget model limits or ledger are invalid");
  const totals = { reportedInputTokens: 0, reportedOutputTokens: 0, reportedTotalTokens: 0, unknownUsageRequests: 0 };
  const ids = new Set<string>();
  for (const request of budget.modelRequests) {
    if (!request || typeof request !== "object") throw new Error("research budget reservation is invalid");
    validateScope(request);
    if (typeof request.reservationId !== "string" || !request.reservationId || request.reservationId.length > 256 || ids.has(request.reservationId) || !validTime(request.reservedAt)) throw new Error("research budget reservation identity is invalid");
    ids.add(request.reservationId);
    if (request.status === "reserved") {
      if (request.settledAt !== undefined || request.usage !== undefined || request.interrupted !== undefined) throw new Error("research budget pending reservation is invalid");
    } else if (request.status === "settled" && validTime(request.settledAt) && (request.interrupted === undefined || request.interrupted === true)) {
      const usage = normalizeModelUsage(request.usage);
      if (request.usage !== undefined && JSON.stringify(request.usage) !== JSON.stringify(usage)) throw new Error("research budget usage is invalid");
      totals.reportedInputTokens += usage?.inputTokens ?? 0;
      totals.reportedOutputTokens += usage?.outputTokens ?? 0;
      totals.reportedTotalTokens += usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
      if (!usage || (usage.totalTokens === undefined && (usage.inputTokens === undefined || usage.outputTokens === undefined))) totals.unknownUsageRequests += 1;
    } else throw new Error("research budget reservation state is invalid");
  }
  if (!counter(budget.usedModelRequests) || budget.usedModelRequests !== budget.modelRequests.length || budget.usedModelRequests > budget.maxModelRequests) throw new Error("research budget model request counter is invalid");
  for (const key of Object.keys(totals) as Array<keyof typeof totals>) if (!counter(budget[key]) || budget[key] !== totals[key]) throw new Error(`research budget ${key} does not match its ledger`);
  return budget;
}

export function makeResearchBudget(projectId: string, limits: ResearchBudgetLimits = defaultResearchBudget): MeteredResearchBudget {
  const checked = validateBudgetLimits(limits);
  return { schema: "dsh-sci.research-budget.v2", projectId, ...checked, maxModelRequests: checked.maxModelRequests ?? defaultResearchBudget.maxModelRequests, maxModelTokens: checked.maxModelTokens ?? defaultResearchBudget.maxModelTokens, usedModelRequests: 0, reportedInputTokens: 0, reportedOutputTokens: 0, reportedTotalTokens: 0, unknownUsageRequests: 0, modelRequests: [], revision: 0, usedTaskExecutions: 0, updatedAt: new Date().toISOString() };
}

/** Task quota is checked only before starting another task, not inside its model loop. */
export function budgetExhaustion(budget: ResearchBudget, now = Date.now()): BudgetExhaustion | undefined {
  validateResearchBudget(budget);
  if (budget.usedTaskExecutions >= budget.maxTaskExecutions) return "task-executions";
  return modelBudgetExhaustion(budget, now);
}
export function modelBudgetExhaustion(budget: ResearchBudget, now = Date.now()): BudgetExhaustion | undefined {
  if (budget.startedAt && now - Date.parse(budget.startedAt) >= budget.maxWallTimeMs) return "wall-time";
  if (budget.schema === "dsh-sci.research-budget.v2") {
    if (budget.usedModelRequests >= budget.maxModelRequests) return "model-requests";
    if (budget.reportedTotalTokens >= budget.maxModelTokens) return "model-tokens";
  }
  return undefined;
}

export function reserveBudgetModelRequest(budget: MeteredResearchBudget, scope: ModelRequestScope): { budget: MeteredResearchBudget; reservation: ModelRequestReservation } {
  validateScope(scope);
  const reason = modelBudgetExhaustion(budget) ?? budget.exhausted;
  if (reason) throw new ResearchBudgetExhaustedError(reason);
  const at = new Date().toISOString();
  // Only explicit fields enter the ledger; never spread caller metadata.
  const reservation: ModelRequestReservation = { reservationId: randomUUID(), phase: scope.phase, ...(scope.planId ? { planId: scope.planId } : {}), ...(scope.taskId ? { taskId: scope.taskId } : {}), ...(scope.attemptId ? { attemptId: scope.attemptId } : {}), status: "reserved", reservedAt: at };
  return { budget: { ...budget, revision: budget.revision + 1, usedModelRequests: budget.usedModelRequests + 1, modelRequests: [...budget.modelRequests, reservation], updatedAt: at }, reservation };
}

export function settleBudgetModelRequest(budget: MeteredResearchBudget, reservationId: string, input?: ModelUsage, interrupted = false): MeteredResearchBudget {
  const request = budget.modelRequests.find((item) => item.reservationId === reservationId);
  if (!request) throw new Error("research budget reservation was not found in this project");
  const usage = normalizeModelUsage(input);
  if (request.status === "settled") {
    if (JSON.stringify(request.usage) !== JSON.stringify(usage) || Boolean(request.interrupted) !== interrupted) throw new Error("research budget reservation already settled with different usage");
    return budget;
  }
  const at = new Date().toISOString();
  const settled: ModelRequestReservation = { ...request, status: "settled", settledAt: at, ...(usage ? { usage } : {}), ...(interrupted ? { interrupted: true } : {}) };
  const unknown = !usage || (usage.totalTokens === undefined && (usage.inputTokens === undefined || usage.outputTokens === undefined));
  return { ...budget, revision: budget.revision + 1, updatedAt: at, modelRequests: budget.modelRequests.map((item) => item === request ? settled : item), reportedInputTokens: budget.reportedInputTokens + (usage?.inputTokens ?? 0), reportedOutputTokens: budget.reportedOutputTokens + (usage?.outputTokens ?? 0), reportedTotalTokens: budget.reportedTotalTokens + (usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))), unknownUsageRequests: budget.unknownUsageRequests + Number(unknown) };
}
