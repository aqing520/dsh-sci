import { createHash } from "node:crypto";
import type { ResearchClaim, ResearchCitation, ResearchEvidenceLink } from "./evidence.js";

export interface EvidenceReviewBinding {
  evidenceHash: string;
  claimHash: string;
  citationHash: string;
  contentHash: string;
}
export interface ResearchEvidenceReview {
  schema: "dsh-sci.evidence-review.v1";
  reviewId: string;
  projectId: string;
  evidenceId: string;
  claimId: string;
  citationId: string;
  contentVersionId: string;
  binding: EvidenceReviewBinding;
  status: "supported" | "refuted" | "insufficient" | "rejected";
  note: string;
  actor: "trusted-workspace";
  reviewedAt: string;
}
export function evidenceReviewBinding(evidence: ResearchEvidenceLink, claim: ResearchClaim, citation: ResearchCitation, contentHash: string): EvidenceReviewBinding {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { evidenceHash: hash(evidence), claimHash: hash(claim), citationHash: hash(citation), contentHash };
}
export function sameEvidenceBinding(a: EvidenceReviewBinding, b: EvidenceReviewBinding): boolean {
  return Boolean(a && b && a.evidenceHash === b.evidenceHash && a.claimHash === b.claimHash && a.citationHash === b.citationHash && a.contentHash === b.contentHash);
}
