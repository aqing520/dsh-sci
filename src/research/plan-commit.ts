import type { ResearchEvent, ResearchPlan, ResearchProject } from "./domain.js";
import { validateResearchDecision, type ResearchDecision } from "./decision.js";
import { contentDigest } from "./content-digest.js";

export interface ResearchPlanCommit {
  schema: "dsh-sci.research-plan-commit.v1";
  commitId: string;
  projectId: string;
  status: "prepared" | "committed";
  beforeProject: ResearchProject;
  beforePlan?: ResearchPlan;
  nextProject: ResearchProject;
  nextPlan: ResearchPlan;
  decision?: ResearchDecision;
  protocolExtension?: { proposalSha256: string; fromMaxIterations: number; toMaxIterations: number };
  events: ResearchEvent[];
  contentHash: string;
}

export function planCommitHash(commit: Omit<ResearchPlanCommit, "contentHash">): string {
  const { status: _status, ...content } = commit;
  return contentDigest(content);
}

/** protocolReviewRequired is a read-time compatibility view, not stored state. */
export function planStateDigest(plan: ResearchPlan | undefined): string {
  if (!plan) return contentDigest(null);
  const { protocolReviewRequired: _review, ...stored } = plan;
  return contentDigest(stored);
}

export function validatePlanCommit(value: unknown, projectId?: string): ResearchPlanCommit {
  const c = value as ResearchPlanCommit;
  if (!c || c.schema !== "dsh-sci.research-plan-commit.v1" || typeof c.commitId !== "string" || !/^[a-f0-9]{64}$/u.test(c.commitId) || typeof c.projectId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(c.projectId) || (projectId !== undefined && c.projectId !== projectId) || !["prepared", "committed"].includes(c.status) || !c.beforeProject || !c.nextProject || !c.nextPlan || !Array.isArray(c.events)) throw new Error("Invalid research plan commit");
  if ([c.beforeProject, c.nextProject, c.nextPlan, ...(c.beforePlan ? [c.beforePlan] : [])].some((item) => item.projectId !== c.projectId) || c.beforeProject.planId !== c.beforePlan?.planId || c.nextProject.planId !== c.nextPlan.planId || c.beforePlan?.planId === c.nextPlan.planId || c.nextPlan.status !== "draft" || c.nextProject.iteration !== c.beforeProject.iteration + (c.beforePlan ? 1 : 0) || c.events.some((event) => event.schema !== "dsh-sci.research-event.v1" || event.projectId !== c.projectId || !event.eventId || Number.isNaN(Date.parse(event.at))) || new Set(c.events.map((event) => event.eventId)).size !== c.events.length) throw new Error("Invalid research plan commit identity");
  if (c.protocolExtension !== undefined && (!/^[a-f0-9]{64}$/u.test(c.protocolExtension.proposalSha256) || !Number.isSafeInteger(c.protocolExtension.fromMaxIterations) || !Number.isSafeInteger(c.protocolExtension.toMaxIterations) || c.protocolExtension.toMaxIterations <= c.protocolExtension.fromMaxIterations)) throw new Error("Invalid protocol extension approval binding");
  if (c.commitId !== contentDigest({ projectId: c.projectId, beforePlanId: c.beforePlan?.planId, nextPlanId: c.nextPlan.planId }) || !Array.isArray(c.nextPlan.tasks) || !c.nextPlan.tasks.length || c.nextPlan.tasks.some((task) => task.projectId !== c.projectId || task.planId !== c.nextPlan.planId || task.status !== "pending") || (c.beforePlan && c.nextPlan.constraints.maxIterations > c.beforePlan.constraints.maxIterations && (!c.protocolExtension || c.protocolExtension.fromMaxIterations !== c.beforePlan.constraints.maxIterations || c.protocolExtension.toMaxIterations !== c.nextPlan.constraints.maxIterations))) throw new Error("Invalid research plan transition");
  if (!c.events.some((event) => event.type === "plan-created" && event.planId === c.nextPlan.planId)) throw new Error("Research plan commit requires a plan-created event");
  if (c.decision) {
    validateResearchDecision(c.decision, c.projectId);
    if (!c.beforePlan || c.decision.decision !== "iterate" || c.decision.planId !== c.beforePlan.planId || c.decision.resultPlanId !== c.nextPlan.planId || !c.events.some((event) => event.type === "decision-recorded" && event.data?.decisionId === c.decision!.decisionId) || !c.events.some((event) => event.type === "iteration-started" && event.planId === c.nextPlan.planId)) throw new Error("Invalid research plan decision binding");
  }
  const { contentHash, ...content } = c;
  if (planCommitHash(content) !== contentHash) throw new Error("Research plan commit hash mismatch");
  return c;
}
