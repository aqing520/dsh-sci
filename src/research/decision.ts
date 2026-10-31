import { createHash } from "node:crypto";

export type ResearchDecisionKind = "stop" | "iterate" | "review";

export interface ResearchDecision {
  schema: "dsh-sci.research-decision.v1";
  decisionId: string;
  projectId: string;
  planId: string;
  evaluationId?: string;
  evaluationContentHash?: string;
  contextHash?: string;
  decision: ResearchDecisionKind;
  reason: string;
  stoppingRule: string;
  iteration: number;
  maxIterations: number;
  remainingBudget?: {
    taskExecutions: number;
    maxTaskExecutions: number;
    modelRequests: number;
    maxModelRequests: number;
    reportedTokens: number;
    maxModelTokens: number;
    wallTimeRemainingMs?: number;
  };
  unresolvedIssues: string[];
  resultPlanId?: string;
  createdAt: string;
}

function text(value: unknown, field: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim().slice(0, max);
}

export function makeResearchDecision(projectId: string, input: Omit<ResearchDecision, "schema" | "decisionId" | "projectId" | "createdAt">, now = new Date().toISOString()): ResearchDecision {
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(projectId)) throw new Error("decision projectId is invalid");
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(input.planId)) throw new Error("decision planId is invalid");
  if (!["stop", "iterate", "review"].includes(input.decision)) throw new Error("decision kind is invalid");
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 0 || !Number.isSafeInteger(input.maxIterations) || input.maxIterations < 1) throw new Error("decision iteration bounds are invalid");
  const unresolvedIssues = [...new Set((input.unresolvedIssues ?? []).map((issue, index) => text(issue, `decision.unresolvedIssues[${index}]`, 2000)))].slice(0, 100);
  for (const hash of [input.evaluationContentHash, input.contextHash]) if (hash !== undefined && !/^[a-f0-9]{64}$/u.test(hash)) throw new Error("decision content binding is invalid");
  const value = { projectId, planId: input.planId, evaluationId: input.evaluationId, evaluationContentHash: input.evaluationContentHash, contextHash: input.contextHash, decision: input.decision, reason: text(input.reason, "decision.reason"), stoppingRule: text(input.stoppingRule, "decision.stoppingRule"), iteration: input.iteration, maxIterations: input.maxIterations, remainingBudget: input.remainingBudget, unresolvedIssues, resultPlanId: input.resultPlanId, createdAt: now };
  const decisionId = `decision-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  return { schema: "dsh-sci.research-decision.v1", decisionId, ...value };
}

export function validateResearchDecision(value: unknown, projectId?: string): ResearchDecision {
  if (!value || typeof value !== "object") throw new Error("Invalid research decision");
  const decision = value as ResearchDecision;
  if (decision.schema !== "dsh-sci.research-decision.v1" || typeof decision.decisionId !== "string" || typeof decision.projectId !== "string" || (projectId !== undefined && decision.projectId !== projectId) || typeof decision.planId !== "string" || !["stop", "iterate", "review"].includes(decision.decision) || typeof decision.reason !== "string" || typeof decision.stoppingRule !== "string" || !Array.isArray(decision.unresolvedIssues) || !Number.isSafeInteger(decision.iteration) || decision.iteration < 0 || !Number.isSafeInteger(decision.maxIterations) || decision.maxIterations < 1 || typeof decision.createdAt !== "string" || Number.isNaN(Date.parse(decision.createdAt))) throw new Error("Invalid research decision");
  const rebuilt = makeResearchDecision(decision.projectId, { planId: decision.planId, evaluationId: decision.evaluationId, evaluationContentHash: decision.evaluationContentHash, contextHash: decision.contextHash, decision: decision.decision, reason: decision.reason, stoppingRule: decision.stoppingRule, iteration: decision.iteration, maxIterations: decision.maxIterations, remainingBudget: decision.remainingBudget, unresolvedIssues: decision.unresolvedIssues, resultPlanId: decision.resultPlanId }, decision.createdAt);
  if (rebuilt.decisionId !== decision.decisionId) throw new Error("Research decision content hash mismatch");
  return decision;
}
