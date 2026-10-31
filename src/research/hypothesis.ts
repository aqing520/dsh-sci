import { createHash, randomUUID } from "node:crypto";

export interface ResearchHypothesis {
  schema: "dsh-sci.research-hypothesis.v1";
  hypothesisId: string;
  projectId: string;
  planId?: string;
  taskId?: string;
  proposition: string;
  rationale?: string;
  scope: string;
  predictions: string[];
  falsifiers: string[];
  alternativeExplanations: string[];
  claimIds: string[];
  citationIds: string[];
  supersedesHypothesisId?: string;
  changeReason?: string;
  status: "candidate" | "accepted" | "rejected" | "superseded";
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

const text = (value: unknown, field: string, max = 8000) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`); const result = value.trim(); if (result.length > max) throw new Error(`${field} is too long`); return result; };
const list = (value: unknown, field: string, min: number, max: number) => { if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${field} must contain between ${min} and ${max} items`); return value.map((item, index) => text(item, `${field}[${index}]`, 4000)); };

export function makeResearchHypothesis(projectId: string, input: { planId?: string; taskId?: string; proposition: string; rationale?: string; scope: string; predictions: string[]; falsifiers: string[]; alternativeExplanations?: string[]; claimIds?: string[]; citationIds?: string[]; supersedesHypothesisId?: string; changeReason?: string }, now = new Date().toISOString(), hypothesisId: string = randomUUID()): ResearchHypothesis {
  if (Boolean(input.supersedesHypothesisId) !== Boolean(input.changeReason)) throw new Error("Hypothesis revision requires supersedesHypothesisId and changeReason together");
  const value = { proposition: text(input.proposition, "hypothesis.proposition"), rationale: input.rationale ? text(input.rationale, "hypothesis.rationale") : undefined, scope: text(input.scope, "hypothesis.scope", 4000), predictions: list(input.predictions, "hypothesis.predictions", 1, 20), falsifiers: list(input.falsifiers, "hypothesis.falsifiers", 1, 20), alternativeExplanations: input.alternativeExplanations === undefined ? [] : list(input.alternativeExplanations, "hypothesis.alternativeExplanations", 0, 20), claimIds: list(input.claimIds ?? [], "hypothesis.claimIds", 0, 100), citationIds: list(input.citationIds ?? [], "hypothesis.citationIds", 0, 100), supersedesHypothesisId: input.supersedesHypothesisId ? text(input.supersedesHypothesisId, "hypothesis.supersedesHypothesisId", 256) : undefined, changeReason: input.changeReason ? text(input.changeReason, "hypothesis.changeReason", 4000) : undefined };
  const contentHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { schema: "dsh-sci.research-hypothesis.v1", hypothesisId, projectId, planId: input.planId, taskId: input.taskId, ...value, status: "candidate", contentHash, createdAt: now, updatedAt: now };
}

export function validateResearchHypothesis(value: ResearchHypothesis, projectId: string): ResearchHypothesis {
  if (!value || value.schema !== "dsh-sci.research-hypothesis.v1" || value.projectId !== projectId || !value.hypothesisId || !value.planId || !value.taskId || !["candidate", "accepted", "rejected", "superseded"].includes(value.status)) throw new Error("Invalid research hypothesis identity or status");
  const reconstructed = makeResearchHypothesis(projectId, value, value.createdAt, value.hypothesisId);
  if (reconstructed.contentHash !== value.contentHash) throw new Error("Research hypothesis hash mismatch");
  return value;
}
