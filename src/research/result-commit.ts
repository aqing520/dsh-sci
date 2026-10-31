import { createHash } from "node:crypto";
import type { ResearchEvent, ResearchPlan, ResearchProject } from "./domain.js";
import type { ResearchClaim, ResearchEvidenceLink } from "./evidence.js";
import { parseResearchTaskResult, type ResearchTaskResult } from "./task-result.js";

export class ResearchResultCommitError extends Error {
  constructor(cause: unknown) { super("Research result persistence was interrupted; recover its journal before executing more tasks.", { cause }); this.name = "ResearchResultCommitError"; }
}
export class ResearchStaleExecutionError extends Error {
  constructor() { super("Research execution was superseded or its task state changed; its late output was not applied."); this.name = "ResearchStaleExecutionError"; }
}

/** Prepared once, replayed without invoking a model or an experiment. */
export interface ResearchResultCommit {
  schema: "dsh-sci.research-result-commit.v1";
  projectId: string;
  submissionId: string;
  payloadHash: string;
  status: "prepared" | "committed";
  result: ResearchTaskResult;
  plan: ResearchPlan;
  project: ResearchProject;
  claims: ResearchClaim[];
  evidence: ResearchEvidenceLink[];
  events: ResearchEvent[];
  activeContext?: { projectId: string; planId: string; taskId: string };
}

export function taskResultHash(result: ResearchTaskResult): string {
  const { submittedAt: _submittedAt, ...payload } = result;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function validateResultCommit(input: unknown, projectId?: string, submissionId?: string): ResearchResultCommit {
  if (!input || typeof input !== "object") throw new Error("Invalid research result commit journal");
  const commit = input as ResearchResultCommit;
  const fail = () => { throw new Error("Invalid research result commit journal"); };
  if (commit.schema !== "dsh-sci.research-result-commit.v1" || !commit.result || !commit.plan || !commit.project) fail();
  if (typeof commit.result.submittedAt !== "string" || !Number.isFinite(Date.parse(commit.result.submittedAt))) fail();
  const result = parseResearchTaskResult(commit.result, commit.result.submittedAt);
  if (commit.projectId !== result.projectId || commit.submissionId !== result.submissionId || (projectId !== undefined && commit.projectId !== projectId) || (submissionId !== undefined && commit.submissionId !== submissionId) || commit.payloadHash !== taskResultHash(result) || !["prepared", "committed"].includes(commit.status)) fail();
  if (commit.plan.projectId !== result.projectId || commit.project.projectId !== result.projectId || commit.plan.planId !== result.planId || commit.project.planId !== result.planId || commit.plan.resultProtocol !== "dsh-sci.research-task-result.v2" || !Array.isArray(commit.plan.tasks)) fail();
  const task = commit.plan.tasks.find((task) => task.taskId === result.taskId);
  if (!task || task.attemptId !== result.attemptId || !Number.isSafeInteger(task.stateVersion) || task.stateVersion! <= result.expectedTaskVersion) fail();
  const terminalStates = { completed: ["completed"], failed: ["ready", "failed"], blocked: ["blocked"], "needs-approval": ["waiting-approval"] };
  if (!terminalStates[result.status].includes(task!.status)) fail();
  if (!Array.isArray(commit.claims) || !Array.isArray(commit.evidence) || !Array.isArray(commit.events) || commit.claims.length !== result.claims.length || commit.evidence.length !== result.evidence.length) fail();
  if (commit.claims.some((claim) => claim.projectId !== result.projectId || claim.taskId !== result.taskId) || commit.evidence.some((link) => link.projectId !== result.projectId) || commit.events.some((event) => event.projectId !== result.projectId || event.planId !== result.planId || !event.eventId)) fail();
  if (new Set(commit.events.map((event) => event.eventId)).size !== commit.events.length) fail();
  if (commit.activeContext && (commit.activeContext.projectId !== result.projectId || commit.activeContext.planId !== result.planId || commit.activeContext.taskId !== commit.project.activeTaskId)) fail();
  return { ...commit, result };
}
