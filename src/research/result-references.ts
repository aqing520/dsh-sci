import type { ResearchRepository } from "./repository.js";
import type { ResearchMemoryEntry } from "./memory.js";

type Snapshot = Awaited<ReturnType<ResearchRepository["exportProject"]>>;

/** The SDK preflight and the authoritative submission use the same project
 * registry. Membership is not proof of task scope, completion or approval. */
export function researchReferenceIds(snapshot: Snapshot, memory: ResearchMemoryEntry[]): Set<string> {
  return new Set([
    ...snapshot.sources.flatMap((source) => [source.sourceId, ...(source.documentId ? [source.documentId] : [])]),
    ...snapshot.sourceContents.map((record) => record.contentVersionId), ...snapshot.sourceReads.map((record) => record.readId),
    ...snapshot.citations.map((record) => record.citationId), ...snapshot.claims.map((record) => record.claimId),
    ...snapshot.evidence.map((record) => record.evidenceId), ...snapshot.experiments.map((record) => record.experimentId),
    ...snapshot.hypotheses.map((record) => record.hypothesisId), ...snapshot.experimentDesigns.map((record) => record.designId),
    ...(snapshot.codeBundles ?? []).map((record) => record.bundleId),
    ...(snapshot.codeReads ?? []).map((record) => record.codeReadId), ...(snapshot.codeReviews ?? []).map((record) => record.codeReviewId),
    ...snapshot.experimentRuns.map((record) => record.runId), ...snapshot.artifacts.map((record) => record.artifactId),
    ...snapshot.evaluations.map((record) => record.evaluationId), ...snapshot.reports.map((record) => record.reportId),
    ...(snapshot.decisions ?? []).map((record) => record.decisionId),
    ...memory.filter((record) => !record.projectId || record.projectId === snapshot.project.projectId).map((record) => record.memoryId),
  ]);
}
