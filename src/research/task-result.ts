import type { ResearchClaim, ResearchEvidenceLink } from "./evidence.js";
import type { ResearchTask } from "./domain.js";

export interface ResearchTaskResultIdentity {
  planId: string;
  attemptId: string;
  submissionId: string;
  expectedTaskVersion: number;
}

export function taskResultIdentity(task: ResearchTask): ResearchTaskResultIdentity {
  if (!task.attemptId || !Number.isSafeInteger(task.stateVersion) || task.stateVersion! < 0) throw new Error("Task requires a versioned execution attempt before submitting a result");
  return { planId: task.planId, attemptId: task.attemptId, submissionId: `result-${task.attemptId}`, expectedTaskVersion: task.stateVersion! };
}

export type ResearchTaskResultStatus = "completed" | "failed" | "blocked" | "needs-approval";

export interface ResearchTaskResultClaim {
  text: string;
  claimType?: ResearchClaim["claimType"];
  confidence?: ResearchClaim["confidence"];
  citationIds?: string[];
}

export interface ResearchTaskResultEvidence {
  claimId?: string;
  claimIndex?: number;
  relation: ResearchEvidenceLink["relation"];
  sourceId?: string;
  citationId?: string;
  artifactRef?: string;
  experimentRef?: string;
  rationale?: string;
}

export interface ResearchTaskResultInput extends ResearchTaskResultIdentity {
  projectId: string;
  taskId: string;
  status: ResearchTaskResultStatus;
  summary: string;
  refs?: string[];
  claims?: ResearchTaskResultClaim[];
  evidence?: ResearchTaskResultEvidence[];
  error?: string;
  nextAction?: string;
}

export interface ResearchTaskResult extends Omit<ResearchTaskResultInput, "refs" | "claims" | "evidence"> {
  schema: "dsh-sci.research-task-result.v2";
  refs: string[];
  claims: ResearchTaskResultClaim[];
  evidence: ResearchTaskResultEvidence[];
  submittedAt: string;
}

const statuses = new Set<ResearchTaskResultStatus>(["completed", "failed", "blocked", "needs-approval"]);
const claimTypes = new Set<ResearchClaim["claimType"]>(["observation", "interpretation", "hypothesis", "conclusion", "definition"]);
const confidences = new Set<ResearchClaim["confidence"]>(["low", "medium", "high", "unrated"]);
const relations = new Set<ResearchEvidenceLink["relation"]>(["supports", "refutes", "qualifies", "context"]);

/** The same model-facing contract is exposed by SDK prompts and bridge context. */
export const researchTaskResultSchema = {
  type: "object",
  required: ["projectId", "taskId", "planId", "attemptId", "submissionId", "expectedTaskVersion", "status", "summary"],
  additionalProperties: false,
  properties: {
    schema: { const: "dsh-sci.research-task-result.v2" },
    projectId: { type: "string", minLength: 1, maxLength: 256 },
    taskId: { type: "string", minLength: 1, maxLength: 256 },
    planId: { type: "string", minLength: 1, maxLength: 256 },
    attemptId: { type: "string", minLength: 1, maxLength: 256 },
    submissionId: { type: "string", minLength: 1, maxLength: 256 },
    expectedTaskVersion: { type: "integer", minimum: 0 },
    status: { enum: ["completed", "failed", "blocked", "needs-approval"] },
    summary: { type: "string", minLength: 1, maxLength: 20000 },
    refs: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 512 }, description: "IDs of records already persisted through tools; this includes existing claim and evidence IDs." },
    claims: {
      type: "array", maxItems: 100,
      description: "New claim objects to create with this submission. Existing claim IDs belong in refs; use [] if tools already created all claims.",
      items: { type: "object", required: ["text"], additionalProperties: false, properties: {
        text: { type: "string", minLength: 1, maxLength: 12000 },
        claimType: { enum: ["observation", "interpretation", "hypothesis", "conclusion", "definition"] },
        confidence: { enum: ["low", "medium", "high", "unrated"] },
        citationIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 512 } }
      } }
    },
    evidence: {
      type: "array", maxItems: 200,
      description: "New link objects, never existing evidence ID strings. claimIndex points into this result's new claims array; claimId identifies a persisted claim.",
      items: { type: "object", required: ["relation"], additionalProperties: false,
        anyOf: [{ required: ["claimId"] }, { required: ["claimIndex"] }],
        properties: {
          claimId: { type: "string", minLength: 1, maxLength: 256 }, claimIndex: { type: "integer", minimum: 0 },
          relation: { enum: ["supports", "refutes", "qualifies", "context"] },
          sourceId: { type: "string", minLength: 1, maxLength: 256 }, citationId: { type: "string", minLength: 1, maxLength: 256 }, artifactRef: { type: "string", minLength: 1, maxLength: 1000 }, experimentRef: { type: "string", minLength: 1, maxLength: 1000 }, rationale: { type: "string", minLength: 1, maxLength: 8000 }
        }
      }
    },
    error: { type: "string", minLength: 1, maxLength: 4000 },
    nextAction: { type: "string", minLength: 1, maxLength: 4000 }
  }
} as const;

export const researchTaskResultGuidance = [
  "Copy the exact result identity (planId, attemptId, submissionId, expectedTaskVersion) from the current task context. Never infer a new identity or reuse one from a previous plan or attempt. A submission ID names one immutable result.",
  "Complete only the current task objective. Do not perform future tasks just because they appear in the project question.",
  "refs contains IDs already returned by tools, not labels or file paths. Register files as artifacts first; artifactRef must be an artifact ID and experimentRef a persisted run ID. claims and evidence contain NEW OBJECTS, never ID strings; if already persisted with tools, put their IDs in refs and return claims: [], evidence: []. Do not recreate the same claims in the final result.",
  "For source/citation/claim/evidence actions use explicit named fields; a citation has sourceId/contentVersionId plus locator.chunkId and quotedText, a claim has text/claimType/confidence/citationIds, and an evidence link has claimId/relation/sourceId/citationId for a source support relation (or artifactRef/experimentRef for computation).",
  "If required inputs or capabilities are missing, return blocked or needs-approval with a precise nextAction. Do not invent file IDs or experimental results."
].join("\n");

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} is too long`);
  return result;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function stringList(value: unknown, field: string, maxItems: number, maxItemLength = 512): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must be an array of at most ${maxItems} items`);
  return [...new Set(value.map((item, index) => text(item, `${field}[${index}]`, maxItemLength)))];
}

/** Validate the model-facing result before it can mutate project state. */
export function parseResearchTaskResult(value: unknown, now = new Date().toISOString()): ResearchTaskResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("research task result must be an object");
  const input = value as Record<string, unknown>;
  if (input.schema !== undefined && input.schema !== "dsh-sci.research-task-result.v2") throw new Error("unsupported research task result schema; legacy results require explicit review");
  const identity = { planId: text(input.planId, "planId", 256), attemptId: text(input.attemptId, "attemptId", 256), submissionId: text(input.submissionId, "submissionId", 256), expectedTaskVersion: input.expectedTaskVersion as number };
  if (!Number.isSafeInteger(identity.expectedTaskVersion) || identity.expectedTaskVersion < 0) throw new Error("expectedTaskVersion must be a non-negative safe integer");
  const status = input.status;
  if (typeof status !== "string" || !statuses.has(status as ResearchTaskResultStatus)) throw new Error("research task result has an invalid status");
  const claimsValue = input.claims === undefined ? [] : input.claims;
  if (!Array.isArray(claimsValue) || claimsValue.length > 100) throw new Error("research task result claims must be an array of at most 100 items");
  const claims = claimsValue.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`claims[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const claimType = item.claimType === undefined ? undefined : item.claimType;
    const confidence = item.confidence === undefined ? undefined : item.confidence;
    if (claimType !== undefined && (typeof claimType !== "string" || !claimTypes.has(claimType as ResearchClaim["claimType"]))) throw new Error(`claims[${index}].claimType is invalid`);
    if (confidence !== undefined && (typeof confidence !== "string" || !confidences.has(confidence as ResearchClaim["confidence"]))) throw new Error(`claims[${index}].confidence is invalid`);
    return { text: text(item.text, `claims[${index}].text`, 12_000), claimType: claimType as ResearchClaim["claimType"] | undefined, confidence: confidence as ResearchClaim["confidence"] | undefined, citationIds: stringList(item.citationIds, `claims[${index}].citationIds`, 100) };
  });
  const evidenceValue = input.evidence === undefined ? [] : input.evidence;
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 200) throw new Error("research task result evidence must be an array of at most 200 items");
  const evidence = evidenceValue.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`evidence[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    if (typeof item.relation !== "string" || !relations.has(item.relation as ResearchEvidenceLink["relation"])) throw new Error(`evidence[${index}].relation is invalid`);
    const claimIndex = item.claimIndex;
    if (claimIndex !== undefined && (typeof claimIndex !== "number" || !Number.isInteger(claimIndex) || claimIndex < 0 || claimIndex >= claims.length)) throw new Error(`evidence[${index}].claimIndex is invalid`);
    if (item.claimId === undefined && claimIndex === undefined) throw new Error(`evidence[${index}] requires claimId or claimIndex`);
    return { claimId: item.claimId === undefined ? undefined : text(item.claimId, `evidence[${index}].claimId`, 256), claimIndex: claimIndex as number | undefined, relation: item.relation as ResearchEvidenceLink["relation"], sourceId: optionalText(item.sourceId, `evidence[${index}].sourceId`, 256), citationId: optionalText(item.citationId, `evidence[${index}].citationId`, 256), artifactRef: optionalText(item.artifactRef, `evidence[${index}].artifactRef`, 1000), experimentRef: optionalText(item.experimentRef, `evidence[${index}].experimentRef`, 1000), rationale: optionalText(item.rationale, `evidence[${index}].rationale`, 8000) };
  });
  return { schema: "dsh-sci.research-task-result.v2", ...identity, projectId: text(input.projectId, "projectId", 256), taskId: text(input.taskId, "taskId", 256), status: status as ResearchTaskResultStatus, summary: text(input.summary, "summary", 20_000), refs: stringList(input.refs, "refs", 200), claims, evidence, error: optionalText(input.error, "error", 4000), nextAction: optionalText(input.nextAction, "nextAction", 4000), submittedAt: now };
}
