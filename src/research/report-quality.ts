import { evidenceReviewBinding, sameEvidenceBinding } from "./evidence-review.js";
import type { ResearchReportInput } from "./report.js";
import { experimentBindingHash } from "./experiment.js";
import path from "node:path";

export interface ReportQualityIssue { code: string; recordId?: string; message: string; }

/** Deterministic integrity gates. Human scientific review is still required. */
export function assessReportEvidence(input: ResearchReportInput): ReportQualityIssue[] {
  const issues: ReportQualityIssue[] = [];
  const add = (code: string, recordId: string | undefined, message: string) => issues.push({ code, ...(recordId ? { recordId } : {}), message });
  const sources = new Map(input.sources.map((value) => [value.sourceId, value]));
  const contents = new Map((input.sourceContents ?? []).map((value) => [value.contentVersionId, value]));
  const citations = new Map(input.citations.map((value) => [value.citationId, value]));
  const claims = new Map(input.claims.map((value) => [value.claimId, value]));
  const runs = new Map((input.experimentRuns ?? []).map((value) => [value.runId, value]));
  const artifacts = new Map((input.artifacts ?? []).map((value) => [value.artifactId, value]));
  const experiments = new Map((input.experiments ?? []).map((value) => [value.experimentId, value]));
  const validCitations = new Set<string>(), supportedClaims = new Set<string>();
  if (!input.claims.length) add("missing-claims", undefined, "No research claims have been recorded; this is an incomplete draft.");
  for (const task of input.plan?.tasks ?? []) if (task.kind !== "report" && !["completed", "skipped"].includes(task.status)) add("unfinished-task", task.taskId, `Task ${task.taskId} is not complete; this report remains a draft.`);
  for (const [collection, records] of Object.entries({ sources: input.sources, citations: input.citations, claims: input.claims, evidence: input.evidence, runs: input.experimentRuns ?? [], artifacts: input.artifacts ?? [], evaluations: input.evaluations ?? [], decisions: input.decisions ?? [], experiments: input.experiments ?? [], hypotheses: input.hypotheses ?? [], designs: input.experimentDesigns ?? [], designReviews: input.designReviews ?? [], evidenceReviews: input.evidenceReviews ?? [] })) {
    if (records.some((record) => record.projectId !== input.project.projectId)) add("foreign-record", undefined, `Report ${collection} contains a record from another project.`);
  }
  for (const citation of input.citations) {
    const source = sources.get(citation.sourceId), content = contents.get(citation.contentVersionId ?? "");
    if (!source || !content || content.projectId !== input.project.projectId || content.sourceId !== source.sourceId || !citation.verification?.targetExists || !citation.verification.locatorValid || !citation.verification.quoteMatches || citation.verification.contentHash !== content.contentHash) add("invalid-citation", citation.citationId, `Citation ${citation.citationId} has not been verified at its saved source content version.`);
    else validCitations.add(citation.citationId);
  }
  for (const claim of input.claims) for (const citationId of claim.citationIds) if (!citations.has(citationId)) add("missing-citation", claim.claimId, `Claim ${claim.claimId} references missing citation ${citationId}.`);
  for (const link of input.evidence) {
    const claim = claims.get(link.claimId), citation = citations.get(link.citationId ?? ""), artifact = artifacts.get(link.artifactRef ?? "");
    if (!claim || (link.sourceId && !sources.has(link.sourceId)) || (link.citationId && !citation) || (link.artifactRef && !artifact) || (link.experimentRef && !runs.has(link.experimentRef))) {
      add("broken-evidence", link.evidenceId, `Evidence ${link.evidenceId} references missing claim, source, citation, artifact or run.`); continue;
    }
    if (link.sourceId || link.citationId) {
      const content = contents.get(citation?.contentVersionId ?? "");
      const review = (input.evidenceReviews ?? []).filter((item) => item.evidenceId === link.evidenceId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt) || b.reviewId.localeCompare(a.reviewId))[0];
      const binding = claim && citation && content ? evidenceReviewBinding(link, claim, citation, content.contentHash) : undefined;
      if (!citation || citation.sourceId !== link.sourceId || !validCitations.has(citation.citationId) || !review || review.actor !== "trusted-workspace" || !binding || !sameEvidenceBinding(review.binding, binding) || !["supported", "refuted"].includes(review.status) || (link.relation === "supports" && review.status !== "supported") || (link.relation === "refutes" && review.status !== "refuted")) add("unreviewed-evidence", link.evidenceId, `Evidence ${link.evidenceId} has no current matching human support review.`);
      else if (link.relation === "supports") supportedClaims.add(claim!.claimId);
    }
    if ((link.artifactRef || link.experimentRef) && ["supports", "refutes"].includes(link.relation)) {
      const run = runs.get(link.experimentRef ?? artifact?.experimentRef ?? ""), experiment = run && experiments.get(run.experimentId);
      const matchedArtifact = artifact ?? [...artifacts.values()].find((item) => item.experimentRef === run?.runId);
      const approval = experiment?.approval;
      const approvalBound = Boolean(
        approval?.proposalContentHash && approval.bindingHash && experiment?.proposalContentHash &&
        approval.proposalContentHash === experiment.proposalContentHash &&
        approval.bindingHash === experiment.proposalContentHash &&
        JSON.stringify(approval.codeManifest ?? []) === JSON.stringify(experiment.codeManifest ?? []) &&
        JSON.stringify(approval.inputManifest ?? []) === JSON.stringify(experiment.inputManifest ?? []) &&
        experimentBindingHash(experiment, approval.codeManifest ?? [], approval.inputManifest ?? []) === approval.bindingHash &&
        run && experimentBindingHash(experiment, run.manifest.code ?? [], run.manifest.inputs) === approval.bindingHash &&
        run.manifest.command === experiment.command && JSON.stringify(run.manifest.args) === JSON.stringify(experiment.args) &&
        run.manifest.cwd === experiment.cwd && run.manifest.randomSeed === experiment.randomSeed,
      );
      // Older executions without a policy root stored an absolute relativePath.
      // The absolute file identity must still match; a hash alone is insufficient.
      const output = run?.manifest.outputs.find((item) => item.exists && item.sha256 === matchedArtifact?.contentHash && item.bytes === matchedArtifact?.bytes && item.path === matchedArtifact?.path && (path.isAbsolute(item.relativePath) || item.relativePath === matchedArtifact?.relativePath));
      if (!run || run.state !== "completed" || run.exitCode !== 0 || !approvalBound || !matchedArtifact || matchedArtifact.experimentRef !== run.runId || !output) add("unconfirmed-run-evidence", link.evidenceId, `Evidence ${link.evidenceId} lacks an approved completed run and a matching registered output.`);
      else if (link.relation === "supports") supportedClaims.add(claim!.claimId);
      if (run && matchedArtifact && !(input.evaluations ?? []).some((evaluation) => evaluation.planId === input.plan?.planId && Boolean(evaluation.planId) && evaluation.experimentRunIds.includes(run.runId) && evaluation.artifactIds.includes(matchedArtifact.artifactId))) add("missing-current-evaluation", link.evidenceId, `Evidence ${link.evidenceId} has no current-plan evaluation bound to this run and artifact.`);
      const design = (input.experimentDesigns ?? []).find((item) => item.designId === experiment?.designId);
      const designReview = (input.designReviews ?? []).filter((item) => item.designId === design?.designId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt) || b.reviewId.localeCompare(a.reviewId))[0];
      const hypotheses = input.hypotheses ?? [];
      if (!design || design.status !== "approved" || design.planId !== experiment?.planId || design.contentHash !== experiment?.designContentHash ||
          (input.experimentDesigns ?? []).some((item) => item.supersedesDesignId === design.designId) ||
          !design.hypothesisBindings.length || design.hypothesisBindings.some((binding) => !hypotheses.some((item) => item.hypothesisId === binding.hypothesisId && item.planId === design.planId && item.contentHash === binding.contentHash && !["superseded", "rejected"].includes(item.status)) || hypotheses.some((item) => item.supersedesHypothesisId === binding.hypothesisId)) ||
          !designReview || designReview.actor !== "trusted-workspace" || designReview.status !== "accepted" || designReview.designContentHash !== design.contentHash || designReview.planId !== design.planId || !Object.values(designReview.criteria).every((value) => value === true)) add("unreviewed-experiment-design", link.evidenceId, `Evidence ${link.evidenceId} lacks an approved design with a current human quality review and hypothesis binding.`);
    }
  }
  for (const claim of input.claims) if (claim.claimType !== "hypothesis" && !supportedClaims.has(claim.claimId)) add("unsupported-claim", claim.claimId, `Claim ${claim.claimId} has no reviewed supporting source or confirmed experiment output.`);
  for (const run of runs.values()) if (["running", "interrupted"].includes(run.state)) add("unfinished-run", run.runId, `Experiment ${run.runId} has no confirmed terminal result (${run.state}).`);
  for (const evaluation of input.evaluations ?? []) {
    for (const runId of evaluation.experimentRunIds) if (!runs.has(runId) || runs.get(runId)!.state !== "completed" || runs.get(runId)!.exitCode !== 0) add("invalid-evaluation-run", evaluation.evaluationId, `Evaluation ${evaluation.evaluationId} references missing or unsuccessful run ${runId}.`);
    for (const artifactId of evaluation.artifactIds) if (!artifacts.has(artifactId)) add("invalid-evaluation-artifact", evaluation.evaluationId, `Evaluation ${evaluation.evaluationId} references missing artifact ${artifactId}.`);
    if (evaluation.metrics.some((metric) => metric.computed?.reviewRequired || metric.computedBootstrap?.reviewRequired)) add("statistics-review", evaluation.evaluationId, `Evaluation ${evaluation.evaluationId} requires manual statistical review.`);
  }
  for (const group of input.memoryConflicts ?? []) if (group.reviewStatus === "unresolved") add("memory-conflict", group.conflictKey, `Memory conflict ${group.conflictKey} remains unresolved.`);
  return issues;
}
