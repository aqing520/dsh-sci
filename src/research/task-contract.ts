import type { ResearchPlan, ResearchTask, ResearchTaskKind } from "./domain.js";
import type { ResearchClaim } from "./evidence.js";
import type { ResearchRepository } from "./repository.js";
import { codeReadsCoverFiles } from "./code-review.js";

export type ResearchOutputKind = "source" | "citation" | "hypothesis" | "experiment-proposal" | "code-bundle" | "code-review" | "completed-run" | "evaluation" | "report";
export interface ResearchTaskContract {
  schema: "dsh-sci.research-task-contract.v1";
  requiredOutputs: ResearchOutputKind[];
}

const outputs: Record<ResearchTaskKind, ResearchOutputKind[]> = {
  clarify: [], custom: [], research: ["source", "citation"], "source-review": ["source", "citation"],
  hypothesis: ["hypothesis"], "experiment-design": ["experiment-proposal"], "code-preparation": ["code-bundle"], "code-review": ["code-review"], experiment: ["completed-run"], evaluate: ["evaluation"], report: ["report"]
};
const common = ["context", "inspect", "source-read", "chunk-read", "report-read", "memory-search", "memory-conflicts"];
const actions: Record<ResearchTaskKind, string[]> = {
  clarify: ["claim", "memory"],
  research: ["source", "reference", "source-read", "chunk-read", "citation", "claim", "evidence", "document", "search", "memory"],
  "source-review": ["source", "reference", "source-read", "chunk-read", "citation", "claim", "evidence", "document", "search", "memory"],
  hypothesis: ["hypothesis", "claim", "evidence", "memory"],
  "experiment-design": ["design", "code-stage", "experiment", "artifact", "claim", "evidence", "memory"],
  "code-preparation": ["code-stage", "code-read", "artifact", "claim", "memory"],
  "code-review": ["code-read", "code-review", "claim", "memory"],
  experiment: ["code-stage", "experiment", "artifact", "claim", "evidence", "memory"],
  evaluate: ["evaluation", "evaluate", "decide-iteration", "claim", "evidence", "memory"],
  report: ["report", "decide-iteration", "claim", "evidence", "memory"],
  custom: ["source", "reference", "source-read", "chunk-read", "citation", "claim", "evidence", "document", "search", "code-stage", "experiment", "artifact", "evaluation", "evaluate", "decide-iteration", "report", "memory"]
};

export function taskContractFor(kind: ResearchTaskKind): ResearchTaskContract {
  if (!Object.hasOwn(outputs, kind)) throw new Error("unknown research task kind");
  return { schema: "dsh-sci.research-task-contract.v1", requiredOutputs: [...outputs[kind]] };
}
export function allowedActionsFor(kind: ResearchTaskKind): string[] { return [...common, ...actions[kind]]; }
export function successCriteriaFor(kind: ResearchTaskKind): string[] {
  return ["Return a valid result for the active task with registered output IDs.", ...taskContractFor(kind).requiredOutputs.map((output) => `Provide a persisted ${output} record linked to the result.`)];
}

export function taskRequiresExperimentDesign(plan: ResearchPlan | undefined, taskId?: string): boolean {
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    const task = plan?.tasks.find((item) => item.taskId === id);
    return task?.kind === "experiment-design" || Boolean(task?.dependsOn.some(visit));
  };
  return taskId !== undefined && visit(taskId);
}

type Snapshot = Awaited<ReturnType<ResearchRepository["exportProject"]>>;
type SnapshotInput = Omit<Snapshot, "hypotheses" | "experimentDesigns"> & Partial<Pick<Snapshot, "hypotheses" | "experimentDesigns">>;

/** Structural completion checks. These validate registered research artifacts,
 * not scientific soundness or human acceptance of the conclusions. */
export function validateTaskCompletion(snapshot: SnapshotInput, task: ResearchTask, refs: string[], pendingClaims: ResearchClaim[] = []): void {
  if (!task.completionContract || task.completionContract.schema !== "dsh-sci.research-task-contract.v1") throw new Error("Legacy task needs completion-protocol review or replanning before completion");
  // The kernel's minimum requirements cannot be weakened by a saved proposal.
  const required = new Set([...taskContractFor(task.kind).requiredOutputs, ...task.completionContract.requiredOutputs]);
  const selected = new Set(refs);
  const claims = [...snapshot.claims, ...pendingClaims];
  for (const claim of claims) if (selected.has(claim.claimId)) for (const citationId of claim.citationIds) selected.add(citationId);
  for (const link of snapshot.evidence) if (selected.has(link.evidenceId)) {
    for (const ref of [link.sourceId, link.citationId, link.artifactRef, link.experimentRef]) if (ref) selected.add(ref);
  }
  for (const citation of snapshot.citations) if (selected.has(citation.citationId)) selected.add(citation.sourceId);
  const present = new Set<ResearchOutputKind>();
  if (snapshot.sources.some((source) => selected.has(source.sourceId))) present.add("source");
  if (snapshot.citations.some((citation) => selected.has(citation.citationId))) present.add("citation");
  if (snapshot.codeBundles?.some((bundle) => selected.has(bundle.bundleId) && bundle.projectId === task.projectId && bundle.planId === task.planId && bundle.taskId === task.taskId && bundle.files.some((file) => file.kind === "code" && file.bytes > 0))) present.add("code-bundle");
  if ((snapshot.codeReviews ?? []).some((review) => {
    const bundle = snapshot.codeBundles?.find((bundle) => bundle.bundleId === review.bundleId && bundle.projectId === task.projectId && bundle.planId === task.planId && bundle.contentHash === review.bundleContentHash);
    const design = review.designBinding ? snapshot.experimentDesigns?.find((design) => design.designId === review.designBinding!.designId && design.contentHash === review.designBinding!.contentHash && design.planId === task.planId && design.status !== "superseded" && !snapshot.experimentDesigns?.some((item) => item.supersedesDesignId === design.designId)) : undefined;
    return selected.has(review.codeReviewId) && review.projectId === task.projectId && review.planId === task.planId && review.taskId === task.taskId && review.attemptId === task.attemptId && Boolean(bundle) && (!taskRequiresExperimentDesign(snapshot.plan, task.taskId) || Boolean(design)) && codeReadsCoverFiles(review, bundle!, review.files, (snapshot.codeReads ?? []).filter((receipt) => review.codeReadIds.includes(receipt.codeReadId)));
  })) present.add("code-review");
  if (["research", "source-review"].includes(task.kind)) {
    present.delete("source"); present.delete("citation");
    for (const citation of snapshot.citations.filter((citation) => selected.has(citation.citationId))) {
      const content = snapshot.sourceContents.find((content) => content.contentVersionId === citation.contentVersionId && content.sourceId === citation.sourceId);
      const check = citation.verification;
      const locator = citation.locator;
      if (!content || !check?.targetExists || !check.locatorValid || !check.quoteMatches || check.contentHash !== content.contentHash || !locator || typeof locator === "string") continue;
      const chunks = content.chunkIndex.filter((chunk) => (!locator.chunkId || chunk.chunkId === locator.chunkId) && (locator.page === undefined || chunk.page === locator.page) && (locator.startOffset === undefined || chunk.endOffset > locator.startOffset) && (locator.endOffset === undefined || chunk.startOffset < locator.endOffset));
      const readIds = new Set(snapshot.sourceReads.filter((receipt) => receipt.audience === "agent" && receipt.planId === task.planId && receipt.taskId === task.taskId && receipt.attemptId === task.attemptId && receipt.contentVersionId === content.contentVersionId && receipt.contentHash === content.contentHash).flatMap((receipt) => receipt.chunkIds));
      if (chunks.length && chunks.every((chunk) => readIds.has(chunk.chunkId))) { present.add("source"); present.add("citation"); }
    }
  }
  const currentHypotheses = (snapshot.hypotheses ?? []).filter((hypothesis) => !["superseded", "rejected"].includes(hypothesis.status) && !(snapshot.hypotheses ?? []).some((item) => item.supersedesHypothesisId === hypothesis.hypothesisId));
  if (currentHypotheses.some((hypothesis) => selected.has(hypothesis.hypothesisId) && hypothesis.planId === task.planId && hypothesis.taskId === task.taskId && hypothesis.predictions.length > 0 && hypothesis.falsifiers.length > 0)) present.add("hypothesis");
  const taskScope = new Set([task.taskId]);
  if (task.kind === "experiment") {
    const visit = (id: string) => {
      if (taskScope.has(id)) return;
      taskScope.add(id);
      for (const parent of snapshot.plan?.tasks.find((item) => item.taskId === id)?.dependsOn ?? []) visit(parent);
    };
    for (const parent of task.dependsOn) visit(parent);
  }
  const currentDesigns = (snapshot.experimentDesigns ?? []).filter((design) =>
    design.planId === task.planId && design.status !== "superseded" &&
    !(snapshot.experimentDesigns ?? []).some((item) => item.supersedesDesignId === design.designId) &&
    design.hypothesisIds.length > 0 && design.controls.length > 0 && design.primaryMetric &&
    design.repetitions > 0 && design.analysisMethod && design.stoppingRule &&
    design.hypothesisBindings.every((binding) => currentHypotheses.some((hypothesis) =>
      hypothesis.planId === task.planId && hypothesis.hypothesisId === binding.hypothesisId && hypothesis.contentHash === binding.contentHash)));
  const proposals = snapshot.experiments.filter((experiment) => {
    if (experiment.planId !== task.planId || !experiment.taskId || !taskScope.has(experiment.taskId)) return false;
    if (!experiment.designId) return !taskRequiresExperimentDesign(snapshot.plan, experiment.taskId);
    return currentDesigns.some((design) => design.designId === experiment.designId && design.status === "approved" &&
      design.contentHash === experiment.designContentHash && JSON.stringify(design.hypothesisIds) === JSON.stringify(experiment.hypothesisIds));
  });
  const validDesigns = currentDesigns.filter((design) => selected.has(design.designId) && design.taskId === task.taskId);
  if (task.kind === "experiment-design") {
    if (validDesigns.length) present.add("experiment-proposal");
  } else if (proposals.some((experiment) => selected.has(experiment.experimentId))) present.add("experiment-proposal");
  if (snapshot.experimentRuns.some((run) => selected.has(run.runId) && run.state === "completed" && proposals.some((proposal) => proposal.experimentId === run.experimentId))) present.add("completed-run");
  if (snapshot.evaluations.some((evaluation) => selected.has(evaluation.evaluationId) && evaluation.taskId === task.taskId && evaluation.planId === task.planId)) present.add("evaluation");
  if (snapshot.reports.some((report) => selected.has(report.reportId) && report.planId === task.planId && (!task.startedAt || report.generatedAt >= task.startedAt))) present.add("report");
  const missing = [...required].filter((kind) => !present.has(kind));
  if (missing.length) throw new Error(`Task completion is missing required outputs: ${missing.join(", ")}`);
}
