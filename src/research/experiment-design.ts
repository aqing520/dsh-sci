import { createHash, randomUUID } from "node:crypto";

export interface ResearchExperimentDesign {
  schema: "dsh-sci.research-experiment-design.v1";
  designId: string;
  projectId: string;
  planId?: string;
  taskId?: string;
  hypothesisIds: string[];
  dataRefs: string[];
  dataDescription: string;
  dataVersion: string;
  hypothesisBindings: Array<{ hypothesisId: string; contentHash: string }>;
  experimentalUnit: string;
  independentVariables: string[];
  dependentVariables: string[];
  controls: string[];
  primaryMetric: string;
  secondaryMetrics: string[];
  repetitions: number;
  randomization: string;
  missingDataHandling: string;
  analysisMethod: string;
  stoppingRule: string;
  randomSeed?: number;
  supersedesDesignId?: string;
  changeReason?: string;
  status: "draft" | "approved" | "superseded";
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}

const text = (value: unknown, field: string, max = 4000) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`); const result = value.trim(); if (result.length > max) throw new Error(`${field} is too long`); return result; };
const list = (value: unknown, field: string, min = 0, max = 50) => { if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${field} must contain between ${min} and ${max} items`); return value.map((item, index) => text(item, `${field}[${index}]`, 2000)); };

export function makeExperimentDesign(projectId: string, input: { planId?: string; taskId?: string; hypothesisIds: string[]; hypothesisBindings: Array<{ hypothesisId: string; contentHash: string }>; dataRefs?: string[]; dataDescription: string; dataVersion: string; experimentalUnit: string; independentVariables: string[]; dependentVariables: string[]; controls: string[]; primaryMetric: string; secondaryMetrics?: string[]; repetitions: number; randomization: string; missingDataHandling: string; analysisMethod: string; stoppingRule: string; randomSeed?: number; supersedesDesignId?: string; changeReason?: string }, now = new Date().toISOString(), designId: string = randomUUID()): ResearchExperimentDesign {
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 1_000_000) throw new Error("experiment design repetitions must be a positive integer");
  if (input.randomSeed !== undefined && (!Number.isSafeInteger(input.randomSeed) || input.randomSeed < 0)) throw new Error("experiment design randomSeed must be a non-negative integer");
  if (Boolean(input.supersedesDesignId) !== Boolean(input.changeReason)) throw new Error("Design revision requires supersedesDesignId and changeReason together");
  const hypothesisIds = list(input.hypothesisIds, "experiment design hypothesisIds", 1);
  if (new Set(hypothesisIds).size !== hypothesisIds.length || !Array.isArray(input.hypothesisBindings) || input.hypothesisBindings.length !== hypothesisIds.length || input.hypothesisBindings.some((binding, index) => binding.hypothesisId !== hypothesisIds[index] || !/^[a-f0-9]{64}$/u.test(binding.contentHash))) throw new Error("Experiment design hypothesis bindings are invalid");
  const value = { hypothesisIds, hypothesisBindings: input.hypothesisBindings.map(({ hypothesisId, contentHash }) => ({ hypothesisId, contentHash })), dataRefs: list(input.dataRefs ?? [], "experiment design dataRefs"), dataDescription: text(input.dataDescription, "experiment design dataDescription", 8000), dataVersion: text(input.dataVersion, "experiment design dataVersion", 256), experimentalUnit: text(input.experimentalUnit, "experiment design experimentalUnit"), independentVariables: list(input.independentVariables, "experiment design independentVariables", 1), dependentVariables: list(input.dependentVariables, "experiment design dependentVariables", 1), controls: list(input.controls, "experiment design controls", 1), primaryMetric: text(input.primaryMetric, "experiment design primaryMetric"), secondaryMetrics: list(input.secondaryMetrics ?? [], "experiment design secondaryMetrics"), repetitions: input.repetitions, randomization: text(input.randomization, "experiment design randomization"), missingDataHandling: text(input.missingDataHandling, "experiment design missingDataHandling"), analysisMethod: text(input.analysisMethod, "experiment design analysisMethod"), stoppingRule: text(input.stoppingRule, "experiment design stoppingRule"), randomSeed: input.randomSeed, supersedesDesignId: input.supersedesDesignId ? text(input.supersedesDesignId, "experiment design supersedesDesignId", 256) : undefined, changeReason: input.changeReason ? text(input.changeReason, "experiment design changeReason", 4000) : undefined };
  const contentHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { schema: "dsh-sci.research-experiment-design.v1", designId, projectId, planId: input.planId, taskId: input.taskId, ...value, status: "draft", contentHash, createdAt: now, updatedAt: now };
}

export function validateExperimentDesign(value: ResearchExperimentDesign, projectId: string): ResearchExperimentDesign {
  if (!value || value.schema !== "dsh-sci.research-experiment-design.v1" || value.projectId !== projectId || !value.designId || !value.planId || !value.taskId || !["draft", "approved", "superseded"].includes(value.status)) throw new Error("Invalid experiment design identity or status");
  const reconstructed = makeExperimentDesign(projectId, value, value.createdAt, value.designId);
  if (reconstructed.contentHash !== value.contentHash) throw new Error("Experiment design hash mismatch");
  return value;
}
