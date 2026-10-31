import { createHash } from "node:crypto";

export interface DesignReviewCriteria {
  hypothesisTestable: boolean;
  analysisUnitMatchesDesign: boolean;
  controlsAndComparisonAreAdequate: boolean;
  primaryMetricPreSpecified: boolean;
  repetitionCountJustified: boolean;
  analysisMethodAppropriate: boolean;
  stoppingRulePreSpecified: boolean;
}

export type DesignReviewStatus = "accepted" | "changes-requested" | "insufficient";

export interface ResearchDesignReview {
  schema: "dsh-sci.research-design-review.v1";
  reviewId: string;
  projectId: string;
  planId: string;
  designId: string;
  designContentHash: string;
  criteria: DesignReviewCriteria;
  status: DesignReviewStatus;
  note: string;
  actor: "trusted-workspace";
  reviewedAt: string;
}

const fields: (keyof DesignReviewCriteria)[] = ["hypothesisTestable", "analysisUnitMatchesDesign", "controlsAndComparisonAreAdequate", "primaryMetricPreSpecified", "repetitionCountJustified", "analysisMethodAppropriate", "stoppingRulePreSpecified"];
const text = (value: unknown, field: string, max = 6000) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`); if (value.trim().length > max) throw new Error(`${field} is too long`); return value.trim(); };

export function designReviewId(projectId: string, designId: string, designContentHash: string, criteria: DesignReviewCriteria, status: DesignReviewStatus, note: string): string {
  return `design-review-${createHash("sha256").update(JSON.stringify({ projectId, designId, designContentHash, criteria, status, note })).digest("hex")}`;
}

export function makeDesignReview(projectId: string, input: Omit<ResearchDesignReview, "schema" | "reviewId" | "projectId" | "actor" | "reviewedAt">, now = new Date().toISOString()): ResearchDesignReview {
  if (!/^\w[\w-]{0,255}$/u.test(input.designId) || !/^\w[\w-]{0,255}$/u.test(input.planId)) throw new Error("Design review identity is invalid");
  if (!/^[a-f0-9]{64}$/u.test(input.designContentHash)) throw new Error("Design review requires the current design content hash");
  if (!["accepted", "changes-requested", "insufficient"].includes(input.status)) throw new Error("Unknown design review status");
  const criteria = {} as DesignReviewCriteria;
  for (const field of fields) { if (typeof input.criteria?.[field] !== "boolean") throw new Error(`Design review criterion ${field} must be boolean`); criteria[field] = input.criteria[field]; }
  if (input.status === "accepted" && fields.some((field) => !criteria[field])) throw new Error("An accepted design review requires every quality criterion");
  const note = text(input.note, "design review note");
  return { schema: "dsh-sci.research-design-review.v1", reviewId: designReviewId(projectId, input.designId, input.designContentHash, criteria, input.status, note), projectId, planId: input.planId, designId: input.designId, designContentHash: input.designContentHash, criteria, status: input.status, note, actor: "trusted-workspace", reviewedAt: now };
}

export function validateDesignReview(value: unknown, projectId?: string): ResearchDesignReview {
  const review = value as Partial<ResearchDesignReview>;
  if (!review || review.schema !== "dsh-sci.research-design-review.v1" || typeof review.projectId !== "string" || (projectId !== undefined && review.projectId !== projectId) || typeof review.planId !== "string" || typeof review.designId !== "string" || typeof review.designContentHash !== "string" || !review.criteria || typeof review.criteria !== "object" || !["accepted", "changes-requested", "insufficient"].includes(String(review.status)) || review.actor !== "trusted-workspace" || typeof review.note !== "string" || typeof review.reviewedAt !== "string") throw new Error("Invalid research design review");
  const rebuilt = makeDesignReview(review.projectId, { planId: review.planId, designId: review.designId, designContentHash: review.designContentHash, criteria: review.criteria as DesignReviewCriteria, status: review.status as DesignReviewStatus, note: review.note }, review.reviewedAt);
  if (rebuilt.reviewId !== review.reviewId) throw new Error("Design review identity mismatch");
  return review as ResearchDesignReview;
}
