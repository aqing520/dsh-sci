import type { ResearchRepository } from "./repository.js";

const collections = ["sources", "sourceContents", "sourceRelations", "designReviews", "citations", "claims", "evidence", "hypotheses", "experimentDesigns", "codeBundles", "codeReads", "codeReviews", "experiments", "experimentRuns", "artifacts", "evaluations", "decisions", "reports", "reportReviews", "sourceReads", "searchLogs", "evidenceReviews", "sourceAcquisitions", "events"] as const;
type Snapshot = Awaited<ReturnType<ResearchRepository["exportProject"]>>;
const fields = new Set(["searchId", "query", "provider", "startedAt", "finishedAt", "failureKind", "pagination", "resultCount", "sourceId", "contentVersionId", "citationId", "claimId", "evidenceId", "hypothesisId", "designId", "bundleId", "experimentId", "runId", "artifactId", "evaluationId", "reportId", "readId", "eventId", "taskId", "planId", "title", "url", "authors", "publishedAt", "retrievedAt", "latestContentVersionId", "reading", "provenance", "scope", "characters", "chunkCount", "truncated", "contentHash", "text", "quotedText", "locator", "verification", "claimType", "confidence", "citationIds", "relation", "rationale", "artifactRef", "experimentRef", "fromSourceId", "toSourceId", "kind", "countsAsIndependent", "note", "state", "status", "relativePath", "conclusion", "summary", "generatedAt", "createdAt", "readAt", "audience", "type", "at", "proposition", "predictions", "falsifiers", "experimentalUnit", "primaryMetric", "repetitions", "analysisMethod", "stoppingRule", "directory", "files", "codeBundleId", "proposalContentHash", "approval"]);
for (const field of ["codeReadId", "codeReviewId", "attemptId", "bundleContentHash", "fileName", "characters", "offset", "endOffset", "designBinding", "codeReadIds", "scientificQuality", "findings", "limitations", "relationId", "reviewId", "actor", "reviewedAt", "designContentHash", "criteria", "decisionId", "decision", "reason", "evaluationContentHash", "contextHash", "stoppingRule", "iteration", "maxIterations", "resultPlanId", "unresolvedIssues", "remainingBudget"]) fields.add(field);

function bounded(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 1000 ? value.slice(0, 1000) + " [truncated]" : value;
  if (value === null || typeof value !== "object") return value;
  if (depth > 3) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => bounded(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, entry]) => [key, bounded(entry, depth + 1)]));
}

const hypothesisFields = ["proposition", "rationale", "scope", "predictions", "falsifiers", "alternativeExplanations", "claimIds", "citationIds", "changeReason"];
const designFields = ["hypothesisIds", "hypothesisBindings", "dataRefs", "dataDescription", "dataVersion", "experimentalUnit", "independentVariables", "dependentVariables", "controls", "primaryMetric", "secondaryMetrics", "repetitions", "randomization", "missingDataHandling", "analysisMethod", "stoppingRule", "randomSeed", "changeReason"];

function candidateDetail(snapshot: Snapshot, input: { collection: "hypotheses" | "experimentDesigns"; recordId?: string; field?: string; offset: number; limit: number }) {
  const allowedFields = input.collection === "hypotheses" ? hypothesisFields : designFields;
  if (typeof input.recordId !== "string" || !allowedFields.includes(input.field ?? "")) throw new Error("Candidate details require a recordId and a listed detail field");
  if (input.limit > 3) throw new Error("Candidate detail limit must be between 1 and 3");
  const record = input.collection === "hypotheses" ? snapshot.hypotheses.find((item) => item.hypothesisId === input.recordId) : snapshot.experimentDesigns.find((item) => item.designId === input.recordId);
  if (!record || record.projectId !== snapshot.project.projectId) throw new Error("Research candidate is not present in this project");
  const field = input.field!, value = (record as unknown as Record<string, unknown>)[field];
  const present = value !== undefined, serialized = present ? JSON.stringify(value) : "";
  const chunkSize = 2000, total = Math.ceil(serialized.length / chunkSize);
  const entries = [];
  for (let index = input.offset; index < Math.min(total, input.offset + input.limit); index += 1) {
    const startOffset = index * chunkSize, endOffset = Math.min(serialized.length, startOffset + chunkSize);
    entries.push({ index, startOffset, endOffset, text: serialized.slice(startOffset, endOffset) });
  }
  return { schema: "dsh-sci.research-candidate-detail.v1", projectId: snapshot.project.projectId, collection: input.collection, recordId: input.recordId, contentHash: record.contentHash, planId: record.planId, taskId: record.taskId, status: record.status, currentPlan: record.planId === snapshot.project.planId, field, present, encoding: "json", offset: input.offset, total, totalCharacters: serialized.length, entries,
    ...(input.offset + entries.length < total ? { nextOffset: input.offset + entries.length } : {}),
    guidance: "Join entries.text in index order across all pages, then JSON.parse to recover the exact field. These are saved candidate details, not source reading receipts, approval, correctness or execution. Preserve the recordId/contentHash across pages; restart reading if they change." };
}

/** Agent inventory is explicitly paged. Full exports stay on the Workspace API. */
export function researchInspection(snapshot: Snapshot, input: { collection?: string; offset?: number; limit?: number; recordId?: string; field?: string } = {}) {
  const offset = input.offset ?? 0, limit = input.limit ?? 10;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Inspect requires a nonnegative offset and a limit between 1 and 20");
  if (input.collection !== undefined && !collections.includes(input.collection as typeof collections[number])) throw new Error("Unknown inspect collection");
  if (input.recordId !== undefined || input.field !== undefined) {
    if (input.collection === "hypotheses" || input.collection === "experimentDesigns") return candidateDetail(snapshot, { collection: input.collection, recordId: input.recordId, field: input.field, offset, limit: input.limit ?? 1 });
    if (input.collection !== "codeReviews" || typeof input.recordId !== "string" || !["findings", "limitations"].includes(input.field ?? "")) throw new Error("Inspect details require codeReviews, a recordId and field findings or limitations");
    const detailLimit = input.limit ?? 1;
    if (detailLimit > 3) throw new Error("Code review detail limit must be between 1 and 3");
    const review = (snapshot.codeReviews ?? []).find((record) => record.codeReviewId === input.recordId);
    if (!review) throw new Error("Code review is not present in this project");
    const field = input.field as "findings" | "limitations";
    const entries = review[field].slice(offset, offset + detailLimit);
    return { projectId: snapshot.project.projectId, collection: "codeReviews", recordId: review.codeReviewId, bundleId: review.bundleId, bundleContentHash: review.bundleContentHash, planId: review.planId, taskId: review.taskId, attemptId: review.attemptId, actor: review.actor, scientificQuality: review.scientificQuality, status: review.status, field, offset, total: review[field].length, entries,
      ...(offset + entries.length < review[field].length ? { nextOffset: offset + entries.length } : {}),
      guidance: "Saved Agent static suggestions only; details do not establish code reading, approval, correctness or execution. Use code-read for current-attempt source receipts." };
  }
  const counts = Object.fromEntries(collections.map((key) => [key, (snapshot[key] ?? []).length]));
  const project = bounded(snapshot.project);
  const budget = snapshot.budget ? { ...snapshot.budget, modelRequests: undefined } : undefined;
  const plan = snapshot.plan ? { planId: snapshot.plan.planId, status: snapshot.plan.status, taskCount: snapshot.plan.tasks.length, tasks: snapshot.plan.tasks.slice(0, 20).map((task) => bounded(task)), tasksTruncated: snapshot.plan.tasks.length > 20 } : undefined;
  if (!input.collection) return { project, plan, budget, counts, collections, guidance: "Use inspect with collection/offset/limit to list records. Use source-read/chunk-read to read versioned source content. Inventory does not count as reading." };
  const collection = input.collection as typeof collections[number];
  const records = (snapshot[collection] ?? []).slice(offset, offset + limit).map((record) => {
    if (collection === "hypotheses" || collection === "experimentDesigns") {
      const hypothesis = collection === "hypotheses" ? record as Snapshot["hypotheses"][number] : undefined;
      const design = collection === "experimentDesigns" ? record as Snapshot["experimentDesigns"][number] : undefined;
      const item = (hypothesis ?? design)!;
      return { recordId: hypothesis ? hypothesis.hypothesisId : design!.designId, ...(hypothesis ? { hypothesisId: hypothesis.hypothesisId, proposition: hypothesis.proposition.slice(0, 240) } : { designId: design!.designId, primaryMetric: design!.primaryMetric.slice(0, 240), hypothesisCount: design!.hypothesisIds.length }), contentHash: item.contentHash, planId: item.planId, taskId: item.taskId, status: item.status, currentPlan: item.planId === snapshot.project.planId,
        ...(hypothesis?.supersedesHypothesisId ? { supersedesHypothesisId: hypothesis.supersedesHypothesisId } : {}), ...(design?.supersedesDesignId ? { supersedesDesignId: design.supersedesDesignId } : {}), detailFields: [...(hypothesis ? hypothesisFields : designFields)],
        guidance: "Use inspect with this collection, recordId, a listed field, offset:0,limit:1; follow nextOffset. Candidate detail pages reconstruct exact JSON without changing the record or granting approval." };
    }
    if (collection === "codeReviews") {
      const review = record as NonNullable<Snapshot["codeReviews"]>[number];
      return { codeReviewId: review.codeReviewId, bundleId: review.bundleId, bundleContentHash: review.bundleContentHash, planId: review.planId, taskId: review.taskId, attemptId: review.attemptId, actor: review.actor, scientificQuality: review.scientificQuality, status: review.status, createdAt: review.createdAt, summary: bounded(review.summary), designBinding: review.designBinding, findingCount: review.findings.length, limitationCount: review.limitations.length,
        guidance: "Read complete findings/limitations with inspect {collection:'codeReviews',recordId:codeReviewId,field:'findings'|'limitations',offset:0,limit:1}; follow nextOffset. Inventory is not code reading or approval." };
    }
    const result = bounded(Object.fromEntries(Object.entries(record).filter(([key]) => fields.has(key))));
    // Bound each item independently; an adversarial candidate cannot inflate inventory.
    return JSON.stringify(result).length <= 3500 ? result : { recordId: Object.entries(record).find(([key]) => /Id$/u.test(key))?.[1], summary: "Record preview omitted because it exceeds the inventory limit." };
  });
  return { projectId: snapshot.project.projectId, collection, counts, records, ...(offset + records.length < counts[collection] ? { nextOffset: offset + records.length } : {}) };
}
