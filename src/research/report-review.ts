import { randomUUID } from "node:crypto";
import type { ResearchReport, ResearchReportReview, ResearchReportReviewStatus } from "./report.js";

export function validateReportReview(review: ResearchReportReview, projectId?: string): ResearchReportReview {
  if (!review || review.schema !== "dsh-sci.research-report-review.v1" || typeof review.reviewId !== "string" || !review.reviewId || typeof review.projectId !== "string" || (projectId !== undefined && review.projectId !== projectId) || typeof review.reportId !== "string" || !review.reportId || typeof review.reportContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(review.reportContentHash) || !["accepted", "changes-requested", "rejected"].includes(review.status) || review.actor !== "trusted-workspace" || typeof review.reviewedAt !== "string" || Number.isNaN(Date.parse(review.reviewedAt))) throw new Error("Invalid research report review");
  if (review.note !== undefined && (typeof review.note !== "string" || review.note.length > 4000)) throw new Error("Report review note is invalid");
  return review;
}

export function makeReportReview(projectId: string, report: ResearchReport, input: { reportContentHash: string; status: ResearchReportReviewStatus; note?: string }, now = new Date().toISOString()): ResearchReportReview {
  const review: ResearchReportReview = { schema: "dsh-sci.research-report-review.v1", reviewId: `report-review-${randomUUID()}`, projectId, reportId: report.reportId, reportContentHash: input.reportContentHash, status: input.status, ...(input.note?.trim() ? { note: input.note.trim().slice(0, 4000) } : {}), actor: "trusted-workspace", reviewedAt: now };
  return validateReportReview(review, projectId);
}

