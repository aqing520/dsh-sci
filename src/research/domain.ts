import { createHash, randomUUID } from "node:crypto";
import { allowedActionsFor, successCriteriaFor, taskContractFor, type ResearchTaskContract } from "./task-contract.js";

export type ResearchProjectStatus = "created" | "planning" | "researching" | "hypothesizing" | "experimenting" | "evaluating" | "iterating" | "reporting" | "completed" | "paused" | "failed";
export type ResearchTaskStatus = "pending" | "ready" | "running" | "waiting-approval" | "blocked" | "completed" | "failed" | "skipped";
export type ResearchTaskKind = "clarify" | "research" | "source-review" | "hypothesis" | "experiment-design" | "code-preparation" | "code-review" | "experiment" | "evaluate" | "report" | "custom";

export interface ResearchTask {
  schema: "dsh-sci.research-task.v1";
  taskId: string;
  projectId: string;
  planId: string;
  title: string;
  objective: string;
  kind: ResearchTaskKind;
  completionContract?: ResearchTaskContract;
  successCriteria?: string[];
  allowedActions?: string[];
  status: ResearchTaskStatus;
  dependsOn: string[];
  attempts: number;
  stateVersion?: number;
  attemptId?: string;
  maxAttempts: number;
  requiresApproval: boolean;
  inputRefs: string[];
  outputRefs: string[];
  summary?: string;
  nextAction?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface ResearchPlan {
  schema: "dsh-sci.research-plan.v1";
  planId: string;
  projectId: string;
  title: string;
  question: string;
  version: number;
  status: "draft" | "active" | "completed" | "superseded";
  tasks: ResearchTask[];
  createdAt: string;
  updatedAt: string;
  constraints: { maxIterations: number; maxTaskAttempts: number };
  protocolReviewRequired?: boolean;
  resultProtocol?: "dsh-sci.research-task-result.v2";
  planning?: { source: "provided" | "model" | "default" | "fallback"; planner: string; reason?: string };
}

export interface ResearchProject {
  schema: "dsh-sci.research-project.v1";
  projectId: string;
  title: string;
  question: string;
  status: ResearchProjectStatus;
  planId?: string;
  activeTaskId?: string;
  iteration: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export type ResearchEventType = "planning-fallback" | "project-created" | "plan-created" | "plan-activated" | "task-ready" | "task-started" | "task-waiting-approval" | "task-result-repair-requested" | "task-result-submitted" | "task-completed" | "task-failed" | "task-blocked" | "task-skipped" | "project-paused" | "project-resumed" | "project-completed" | "project-failed" | "source-added" | "source-content-saved" | "source-read" | "source-related" | "citation-added" | "citation-reviewed" | "claim-added" | "evidence-linked" | "evidence-reviewed" | "search-completed" | "search-failed" | "experiment-interrupted" | "experiment-created" | "experiment-approved" | "code-staged" | "code-read" | "code-review-recorded" | "experiment-design-created" | "experiment-design-approved" | "design-reviewed" | "hypothesis-created" | "experiment-started" | "experiment-completed" | "artifact-registered" | "evaluation-recorded" | "decision-recorded" | "report-generated" | "report-reviewed" | "iteration-started" | "memory-conflict-reviewed" | "research-action-accepted" | "research-action-rejected" | "research-budget-exhausted" | "research-budget-updated";

export interface ResearchEvent {
  schema: "dsh-sci.research-event.v1";
  eventId: string;
  projectId: string;
  planId?: string;
  taskId?: string;
  type: ResearchEventType;
  at: string;
  data?: Record<string, unknown>;
}

export interface ResearchPlanInput {
  title?: string;
  question: string;
  tasks: Array<{
    taskId?: string;
    title: string;
    objective: string;
    kind?: ResearchTaskKind;
    dependsOn?: string[];
    requiresApproval?: boolean;
    maxAttempts?: number;
    successCriteria?: string[];
  }>;
  constraints?: Partial<ResearchPlan["constraints"]>;
}

export function projectIdFor(question: string, salt = randomUUID()): string {
  return createHash("sha256").update(`${salt}\0${question}`).digest("hex").slice(0, 32);
}

export function defaultResearchPlanInput(question: string): ResearchPlanInput {
  const text = question.trim();
  return {
    title: text.length > 80 ? `${text.slice(0, 77)}...` : text,
    question: text,
    tasks: [
      { taskId: "clarify-question", title: "Clarify the research question", objective: "State the scope, constraints, deliverables, and measurable success criteria.", kind: "clarify" },
      { taskId: "review-sources", title: "Gather and review relevant sources", objective: "Find credible sources and record claims with citations.", kind: "research", dependsOn: ["clarify-question"] },
      { taskId: "formulate-hypothesis", title: "Formulate hypotheses", objective: "Turn the question and source evidence into falsifiable hypotheses.", kind: "hypothesis", dependsOn: ["review-sources"] },
      { taskId: "design-experiment", title: "Design an experiment", objective: "Define variables, controls, measurements, data, and stopping criteria.", kind: "experiment-design", dependsOn: ["formulate-hypothesis"] },
      { taskId: "prepare-code", title: "Prepare candidate code", objective: "Save complete source, inputs, dependency declarations and test source for the design, without executing them.", kind: "code-preparation", dependsOn: ["design-experiment"] },
      { taskId: "review-code", title: "Inspect candidate code", objective: "Read every bundled file and record static findings and limitations against the current design; request revision for blockers. Agent inspection does not approve code or execution.", kind: "code-review", dependsOn: ["prepare-code"] },
      { taskId: "run-experiment", title: "Run the experiment", objective: "Execute the approved experiment and preserve inputs, outputs, and artifacts.", kind: "experiment", dependsOn: ["review-code"], requiresApproval: true },
      { taskId: "evaluate-results", title: "Evaluate the results", objective: "Compare observations with the hypothesis and decide whether another iteration is needed.", kind: "evaluate", dependsOn: ["run-experiment"] },
      { taskId: "write-report", title: "Write the evidence-based report", objective: "Generate a report whose claims link to sources, experiments, and artifacts.", kind: "report", dependsOn: ["evaluate-results"] },
    ],
    constraints: { maxIterations: 3, maxTaskAttempts: 2 },
  };
}

function cleanText(value: unknown, field: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} is too long`);
  return result;
}

function safeId(value: unknown, fallback: string): string {
  const result = typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : fallback;
  return result;
}

export function buildResearchPlan(projectId: string, input: ResearchPlanInput, now = new Date().toISOString(), planId = randomUUID()): ResearchPlan {
  const question = cleanText(input.question, "question", 16_000);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > 100) throw new Error("tasks must contain between 1 and 100 items");
  const taskIds = new Set<string>();
  const tasks: ResearchTask[] = input.tasks.map((item, index) => {
    const taskId = safeId(item.taskId, `task-${index + 1}`);
    if (taskIds.has(taskId)) throw new Error(`duplicate task ID: ${taskId}`);
    taskIds.add(taskId);
    const kind = item.kind ?? "custom";
    const objective = cleanText(item.objective, `tasks[${index}].objective`);
    const completionContract = taskContractFor(kind);
    const minimumCriteria = successCriteriaFor(kind);
    if (item.successCriteria !== undefined && (!Array.isArray(item.successCriteria) || item.successCriteria.length > 20 + minimumCriteria.length)) throw new Error("successCriteria must contain at most 20 custom items plus kernel criteria");
    const customCriteria = (item.successCriteria ?? []).map((criterion) => cleanText(criterion, "success criterion", 1000)).filter((criterion) => !minimumCriteria.includes(criterion));
    if (customCriteria.length > 20) throw new Error("successCriteria must contain at most 20 custom items plus kernel criteria");
    const successCriteria = [...new Set([...minimumCriteria, ...customCriteria])];
    return { schema: "dsh-sci.research-task.v1", taskId, projectId, planId, title: cleanText(item.title, `tasks[${index}].title`, 240), objective, kind, completionContract, successCriteria, allowedActions: allowedActionsFor(kind), status: "pending", dependsOn: [...new Set(item.dependsOn ?? [])], attempts: 0, stateVersion: 0, maxAttempts: Math.max(1, Math.min(10, Math.floor(item.maxAttempts ?? input.constraints?.maxTaskAttempts ?? 2))), requiresApproval: Boolean(item.requiresApproval), inputRefs: [], outputRefs: [], createdAt: now, updatedAt: now };
  });
  for (const task of tasks) for (const dependency of task.dependsOn) if (!taskIds.has(dependency)) throw new Error(`task ${task.taskId} depends on missing task ${dependency}`);
  assertAcyclic(tasks);
  return { schema: "dsh-sci.research-plan.v1", resultProtocol: "dsh-sci.research-task-result.v2", planId, projectId, title: cleanText(input.title ?? question.slice(0, 240), "title", 240), question, version: 1, status: "draft", tasks, createdAt: now, updatedAt: now, constraints: { maxIterations: Math.max(1, Math.min(20, Math.floor(input.constraints?.maxIterations ?? 3))), maxTaskAttempts: Math.max(1, Math.min(10, Math.floor(input.constraints?.maxTaskAttempts ?? 2))) } };
}

export function assertAcyclic(tasks: ResearchTask[]): void {
  const graph = new Map(tasks.map((task) => [task.taskId, task.dependsOn]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new Error(`task dependency cycle includes ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dependency of graph.get(id) ?? []) visit(dependency); visiting.delete(id); visited.add(id); };
  for (const task of tasks) visit(task.taskId);
}

export function readyTaskIds(plan: ResearchPlan): string[] {
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed" || task.status === "skipped").map((task) => task.taskId));
  return plan.tasks
    .filter((task) =>
      task.status === "ready" ||
      (task.status === "pending" && task.dependsOn.every((dependency) => completed.has(dependency))),
    )
    .map((task) => task.taskId);
}

export function transitionTask(plan: ResearchPlan, taskId: string, status: ResearchTaskStatus, patch: Partial<Pick<ResearchTask, "error" | "inputRefs" | "outputRefs" | "summary" | "nextAction">> = {}, now = new Date().toISOString()): ResearchPlan {
  const task = plan.tasks.find((item) => item.taskId === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const allowed: Record<ResearchTaskStatus, ResearchTaskStatus[]> = { pending: ["ready", "running", "skipped"], ready: ["running", "waiting-approval", "skipped", "blocked"], running: ["completed", "failed", "waiting-approval", "blocked"], "waiting-approval": ["running", "skipped", "blocked"], blocked: ["ready", "failed", "skipped"], completed: [], failed: ["ready", "running"], skipped: [] };
  if (!allowed[task.status].includes(status)) throw new Error(`invalid task transition ${task.status} -> ${status}`);
  if (!Number.isSafeInteger(task.stateVersion) || task.stateVersion! < 0 || task.stateVersion! >= Number.MAX_SAFE_INTEGER) throw new Error("Legacy or invalid task state version requires protocol review before transition");
  const nextTasks = plan.tasks.map((item) => item.taskId === taskId ? { ...item, ...patch, status, stateVersion: item.stateVersion! + 1, attemptId: status === "running" ? randomUUID() : item.attemptId, error: status === "completed" || status === "skipped" ? undefined : patch.error ?? item.error, attempts: status === "running" ? item.attempts + 1 : item.attempts, startedAt: status === "running" ? (item.startedAt ?? now) : item.startedAt, completedAt: status === "completed" || status === "skipped" ? now : item.completedAt, updatedAt: now } : item);
  return { ...plan, tasks: nextTasks, updatedAt: now };
}

export function projectStatusFor(plan: ResearchPlan, iteration: number): ResearchProjectStatus {
  if (plan.status === "completed") return "completed";
  if (plan.tasks.some((task) => task.status === "failed" && task.attempts >= task.maxAttempts)) return "failed";
  if (plan.tasks.every((task) => task.status === "completed" || task.status === "skipped")) return "completed";
  const active = plan.tasks.find((task) => ["running", "waiting-approval", "blocked"].includes(task.status));
  if (active) return active.kind === "experiment" || active.kind === "experiment-design" ? "experimenting" : active.kind === "research" || active.kind === "source-review" ? "researching" : active.kind === "hypothesis" ? "hypothesizing" : active.kind === "evaluate" ? "evaluating" : active.kind === "report" ? "reporting" : iteration > 0 ? "iterating" : "planning";
  return iteration > 0 ? "iterating" : "planning";
}

export function makeProject(question: string, title?: string, now = new Date().toISOString()): ResearchProject {
  const cleanQuestion = cleanText(question, "question", 16_000);
  return { schema: "dsh-sci.research-project.v1", projectId: projectIdFor(cleanQuestion), title: title?.trim() || (cleanQuestion.length > 80 ? `${cleanQuestion.slice(0, 77)}...` : cleanQuestion), question: cleanQuestion, status: "created", iteration: 0, createdAt: now, updatedAt: now };
}

export function makeEvent(projectId: string, type: ResearchEventType, data: { planId?: string; taskId?: string; values?: Record<string, unknown> } = {}, now = new Date().toISOString()): ResearchEvent {
  return { schema: "dsh-sci.research-event.v1", eventId: randomUUID(), projectId, planId: data.planId, taskId: data.taskId, type, at: now, data: data.values };
}
