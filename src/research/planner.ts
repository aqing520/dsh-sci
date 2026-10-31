import type { ModelGateway } from "../provider.js";
import type { ModelRequestAccounting } from "../model-usage.js";
import { buildResearchPlan, defaultResearchPlanInput, type ResearchPlanInput, type ResearchTaskKind } from "./domain.js";

export interface ResearchPlanner {
  readonly name: string;
  plan(question: string, signal?: AbortSignal, accounting?: ModelRequestAccounting): Promise<ResearchPlanInput>;
}

export class DefaultResearchPlanner implements ResearchPlanner {
  readonly name = "default-research-planner";
  async plan(question: string): Promise<ResearchPlanInput> { return defaultResearchPlanInput(question); }
}

/** Model-backed planner. The model only proposes JSON; domain validation remains local and authoritative. */
export class ModelResearchPlanner implements ResearchPlanner {
  readonly name = "model-research-planner";
  constructor(private readonly gateway: ModelGateway, private readonly model?: string) {}
  async plan(question: string, signal?: AbortSignal, accounting?: ModelRequestAccounting): Promise<ResearchPlanInput> {
    const response = await this.gateway.createResponse({ model: this.model, instructions: "You are a research planner. Return only valid JSON with keys title, tasks, constraints. Do not echo the question, frozen protocol or code: the kernel preserves the complete original input. Write concise task objectives that refer to that protocol and measurable success criteria without copying it. Each task must have taskId, title, objective, kind, dependsOn, requiresApproval, maxAttempts and successCriteria (an array of measurable criteria). Use kinds clarify, research, source-review, hypothesis, experiment-design, code-preparation, code-review, experiment, evaluate, report, custom. Reading/research requires real source and citation records; hypothesis requires a persisted structured hypothesis with scope, predictions and falsifiers; experiment-design requires a separate structured design with hypothesis bindings, controls, metrics, analysis and stopping rule; code-preparation requires a persisted complete code bundle for the current task; never label implementation or code preparation as custom. Static candidate-code review must use code-review, not source-review or custom; it requires a persisted Agent code review bound to the exact bundle, complete current-attempt code reads, findings and explicit limitations. Agent review never grants human approval or scientific acceptance. Staging a candidate is not approval or execution; experiment requires a completed approved run; evaluate requires a persisted evaluation; report requires a generated report. The kernel adds structural minimum requirements which your plan cannot remove. Choose custom only for other kinds of work, not to bypass these requirements.", input: `Decompose this research question into a falsifiable, executable plan with source review, hypotheses, experiment design, evaluation, and reporting. Question: ${question}` }, signal, accounting);
    const raw = typeof response.output_text === "string" ? response.output_text : extractText(response.output);
    const parsed = parseJsonObject(raw);
    const input: ResearchPlanInput = { question, title: typeof parsed.title === "string" ? parsed.title : undefined, tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((task) => ({ taskId: typeof task?.taskId === "string" ? task.taskId : undefined, title: String(task?.title ?? "Research task"), objective: String(task?.objective ?? "Complete this research task."), kind: isTaskKind(task?.kind) ? task.kind : "custom", dependsOn: Array.isArray(task?.dependsOn) ? task.dependsOn.filter((value: unknown): value is string => typeof value === "string") : [], requiresApproval: task?.requiresApproval === true, maxAttempts: typeof task?.maxAttempts === "number" ? task.maxAttempts : undefined, successCriteria: task?.successCriteria })) : [], constraints: parsed.constraints && typeof parsed.constraints === "object" ? parsed.constraints : undefined };
    // Validate all IDs, dependencies, cycles, and bounds before returning to the orchestrator.
    buildResearchPlan("planner-validation", input);
    return input;
  }
}

function isTaskKind(value: unknown): value is ResearchTaskKind { return ["clarify", "research", "source-review", "hypothesis", "experiment-design", "code-preparation", "code-review", "experiment", "evaluate", "report", "custom"].includes(String(value)); }
function parseJsonObject(value: string): Record<string, any> {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1] ?? value;
  try { const parsed = JSON.parse(fenced); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw new Error("research planner returned invalid JSON"); }
}
function extractText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [item]).map((item: any) => typeof item?.text === "string" ? item.text : typeof item?.output_text === "string" ? item.output_text : "").filter(Boolean).join("\n");
}
