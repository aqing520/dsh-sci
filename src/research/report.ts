import { randomUUID } from "node:crypto";
import { contentDigest } from "./content-digest.js";
import type { ResearchClaim, ResearchCitation, ResearchEvidenceLink, ResearchSource } from "./evidence.js";
import type { ResearchPlan, ResearchProject } from "./domain.js";
import type { ResearchEvaluation } from "./evaluation.js";
import type { ExperimentDefinition, ExperimentRun } from "./experiment.js";
import type { ResearchArtifact } from "./artifact.js";
import { evidenceReviewBinding, sameEvidenceBinding, type ResearchEvidenceReview } from "./evidence-review.js";
import type { SourceContentSummary } from "./source-content.js";
import type { MemoryConflictGroup } from "./memory.js";
import type { ResearchSourceRelation } from "./source-relation.js";
import type { ResearchDecision } from "./decision.js";
import { assessReportEvidence, type ReportQualityIssue } from "./report-quality.js";
import type { ResearchExperimentDesign } from "./experiment-design.js";
import type { ResearchDesignReview } from "./design-review.js";
import type { ResearchHypothesis } from "./hypothesis.js";

export interface ResearchReport {
  schema: "dsh-sci.research-report.v1";
  reportId: string;
  projectId: string;
  title: string;
  markdown: string;
  html: string;
  claimIds: string[];
  sourceIds: string[];
  evidenceIds: string[];
  evaluationIds: string[];
  decisionIds: string[];
  experimentIds: string[];
  artifactIds: string[];
  memoryConflictKeys?: string[];
  /** Immutable upstream versions used to render this report. */
  sourceBindings: Array<{ sourceId: string; contentVersionId?: string; contentHash?: string }>;
  runBindings: Array<{ runId: string; contentHash: string }>;
  evaluationBindings: Array<{ evaluationId: string; contentHash: string }>;
  decisionBindings: Array<{ decisionId: string; contentHash: string }>;
  artifactBindings: Array<{ artifactId: string; contentHash: string }>;
  contentHash: string;
  upstreamHash: string;
  generatedAt: string;
  warnings: string[];
  planId?: string;
  qualityIssues?: ReportQualityIssue[];
  /** Derived read view; never grants human approval when stored by a caller. */
  reviewStatus?: "draft" | "reviewed";
  reviewId?: string;
}

export function reportContentHash(report: ResearchReport): string {
  const { contentHash: _hash, reviewStatus: _status, reviewId: _reviewId, ...content } = report;
  return contentDigest(content);
}

export function validateResearchReport(report: ResearchReport, projectId?: string): ResearchReport {
  if (!report || report.schema !== "dsh-sci.research-report.v1" || typeof report.reportId !== "string" || !report.reportId || typeof report.projectId !== "string" || (projectId !== undefined && report.projectId !== projectId) || typeof report.markdown !== "string" || typeof report.html !== "string" || !Array.isArray(report.warnings)) throw new Error("Invalid research report");
  // Legacy reports without hashes remain readable, but cannot obtain a current review.
  if (report.contentHash !== undefined && (!/^[a-f0-9]{64}$/u.test(report.contentHash) || reportContentHash(report) !== report.contentHash)) throw new Error("Research report content hash mismatch");
  return report;
}

/** Warnings that prevent a report from being accepted as a final research record. */
export function reportBlockingWarnings(report: Pick<ResearchReport, "warnings" | "qualityIssues">): string[] {
  if (report.qualityIssues) return report.qualityIssues.map((issue) => issue.message);
  const blocking = /(incomplete draft|has not been verified|no current human support review|cannot establish the claim|conflicts with its proposed relation|no confirmed terminal result|references missing|requires manual statistical review|remains unresolved|no citation or evidence link|missing experiment)/iu;
  return report.warnings.filter((warning) => blocking.test(warning));
}

export type ResearchReportReviewStatus = "accepted" | "changes-requested" | "rejected";
export interface ResearchReportReview {
  schema: "dsh-sci.research-report-review.v1";
  reviewId: string;
  projectId: string;
  reportId: string;
  reportContentHash: string;
  status: ResearchReportReviewStatus;
  note?: string;
  actor: "trusted-workspace";
  reviewedAt: string;
}

function esc(value: string): string { return value.replace(/[\[\]\\]/gu, "\\$&"); }
function html(value: string): string { return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;"); }
function safeHref(value: string): string { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? html(url.toString()) : "#"; } catch { return "#"; } }
function anchor(kind: string, id: string): string { return `${kind}-${encodeURIComponent(id)}`; }
function jump(kind: string, id: string): string { return `<a href="#${anchor(kind, id)}">${html(id)}</a>`; }

function locatorText(locator: ResearchCitation["locator"]): string {
  if (!locator) return "";
  if (typeof locator === "string") return locator;
  return [
    locator.page === undefined ? "" : `p. ${locator.page}`,
    locator.section ? `§ ${locator.section}` : "",
    locator.paragraph === undefined ? "" : `para. ${locator.paragraph}`,
    locator.chunkId ? `chunk ${locator.chunkId}` : "",
    locator.startOffset === undefined ? "" : `characters ${locator.startOffset}-${locator.endOffset ?? locator.startOffset}`,
  ].filter(Boolean).join(", ");
}

export interface ResearchReportInput { project: ResearchProject; plan?: ResearchPlan; sources: ResearchSource[]; sourceRelations?: ResearchSourceRelation[]; citations: ResearchCitation[]; claims: ResearchClaim[]; evidence: ResearchEvidenceLink[]; evidenceReviews?: ResearchEvidenceReview[]; sourceContents?: SourceContentSummary[]; evaluations?: ResearchEvaluation[]; decisions?: ResearchDecision[]; hypotheses?: ResearchHypothesis[]; experimentDesigns?: ResearchExperimentDesign[]; designReviews?: ResearchDesignReview[]; experiments?: ExperimentDefinition[]; experimentRuns?: ExperimentRun[]; artifacts?: ResearchArtifact[]; memoryConflicts?: MemoryConflictGroup[]; reportId?: string; now?: string }

export function generateResearchReport(input: ResearchReportInput): ResearchReport {
  const generatedAt = input.now ?? new Date().toISOString();
  const sourceById = new Map(input.sources.map((source) => [source.sourceId, source]));
  const citationById = new Map(input.citations.map((citation) => [citation.citationId, citation]));
  const evidenceByClaim = new Map<string, ResearchEvidenceLink[]>();
  for (const link of input.evidence) evidenceByClaim.set(link.claimId, [...(evidenceByClaim.get(link.claimId) ?? []), link]);
  const references = new Map<string, number>();
  const referenceLines: string[] = [];
  const qualityIssues = assessReportEvidence(input);
  const warnings: string[] = qualityIssues.map((issue) => issue.message);
  if (!input.claims.length) warnings.push("No research claims have been recorded; this is an incomplete draft.");
  const sourceRelations = input.sourceRelations ?? [];
  const sourceRelationLines = sourceRelations.length ? sourceRelations.map((relation) => `- ${relation.kind}: ${relation.fromSourceId} → ${relation.toSourceId} (${relation.countsAsIndependent ? "independent" : "same evidence family"}) — ${relation.note}`) : ["No reviewed source relationships have been recorded."];
  for (const citation of input.citations) {
    if (!citation.contentVersionId || !citation.verification?.locatorValid || !citation.verification.quoteMatches) warnings.push(`Citation ${citation.citationId} has not been verified at a saved source location.`);
  }
  for (const evidence of input.evidence.filter((link) => link.sourceId)) {
    const claim = input.claims.find((claim) => claim.claimId === evidence.claimId);
    const citation = input.citations.find((citation) => citation.citationId === evidence.citationId);
    const content = input.sourceContents?.find((content) => content.contentVersionId === citation?.contentVersionId);
    const binding = claim && citation && content ? evidenceReviewBinding(evidence, claim, citation, content.contentHash) : undefined;
    const latest = (input.evidenceReviews ?? []).filter((review) => review.evidenceId === evidence.evidenceId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];
    if (!binding || !latest || !sameEvidenceBinding(latest.binding, binding)) warnings.push(`Evidence ${evidence.evidenceId} has no current human support review for this claim and citation.`);
    else if (["insufficient", "rejected"].includes(latest.status)) warnings.push(`Evidence ${evidence.evidenceId} was reviewed as ${latest.status}; it cannot establish the claim.`);
    else if ((evidence.relation === "supports" && latest.status !== "supported") || (evidence.relation === "refutes" && latest.status !== "refuted")) warnings.push(`Evidence ${evidence.evidenceId} has a human judgment that conflicts with its proposed relation.`);
  }
  const reference = (sourceId: string) => { if (!references.has(sourceId)) { references.set(sourceId, references.size + 1); const source = sourceById.get(sourceId); if (source) { const quality = source.quality ? ` [authority:${source.quality.authority}; recency:${source.quality.recency}; score:${source.quality.score ?? "unknown"}]` : " [authority:unknown; recency:unknown; score:unknown]"; referenceLines.push(`[${references.get(sourceId)}] ${source.title}${source.url ? ` — ${source.url}` : ""}${source.authors.length ? ` (${source.authors.join(", ")})` : ""}${quality}`); if (!source.quality || source.quality.authority === "unknown" || source.quality.authority === "low") warnings.push(`Source ${source.sourceId} has not been rated authoritative.`); if (source.quality?.score !== undefined && source.quality.score < 0.5) warnings.push(`Source ${source.sourceId} has a low automatic quality score (${source.quality.score}).`); if (source.metadata?.extraction === "ocr-required") warnings.push(`Source ${source.sourceId} requires OCR before its text can be treated as searchable evidence.`); if (source.metadata?.extraction === "ocr") { warnings.push(`Source ${source.sourceId} was extracted with OCR; verify the quoted text against the page image.`); const aggregate = Number(source.metadata.ocrConfidence); if (Number.isFinite(aggregate) && aggregate < 0.8) warnings.push(`Source ${source.sourceId} has low aggregate OCR confidence (${aggregate.toFixed(3)}).`); try { const pageConfidences = JSON.parse(source.metadata.ocrPageConfidences ?? "null"); if (Array.isArray(pageConfidences) && pageConfidences.some((value) => typeof value === "number" && value < 0.7)) warnings.push(`Source ${source.sourceId} contains page-level OCR confidence below 0.7; verify those pages against the scan.`); } catch { /* Ignore malformed optional confidence metadata. */ } } } } return references.get(sourceId)!; };
  const experimentRuns = input.experimentRuns ?? [];
  for (const run of experimentRuns) if (["running", "interrupted"].includes(run.state)) warnings.push(`Experiment ${run.runId} has no confirmed terminal result (${run.state}); review outputs before drawing conclusions.`);
  const artifacts = input.artifacts ?? [];
  const experimentById = new Map((input.experiments ?? []).map((experiment) => [experiment.experimentId, experiment]));
  const runById = new Map(experimentRuns.map((run) => [run.runId, run]));
  const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const claimLines = input.claims.map((claim) => {
    const claimEvidence = evidenceByClaim.get(claim.claimId) ?? [];
    const citations = claim.citationIds.flatMap((citationId) => { const citation = citationById.get(citationId); if (!citation || !sourceById.has(citation.sourceId)) return []; const locator = locatorText(citation.locator); return [`[${reference(citation.sourceId)}${locator ? `, ${esc(locator)}` : ""}]`]; });
    const evidence = claimEvidence.map((link) => {
      if (link.sourceId && sourceById.has(link.sourceId)) return `[${reference(link.sourceId)} ${link.relation}]`;
      if (link.artifactRef) { if (!artifactById.has(link.artifactRef)) warnings.push(`Evidence ${link.evidenceId} references missing artifact ${link.artifactRef}.`); return `[artifact:${link.artifactRef} ${link.relation}]`; }
      if (link.experimentRef) { if (!runById.has(link.experimentRef) && !experimentById.has(link.experimentRef)) warnings.push(`Evidence ${link.evidenceId} references missing experiment ${link.experimentRef}.`); return `[experiment:${link.experimentRef} ${link.relation}]`; }
      return `[${link.relation}]`;
    });
    if (citations.length === 0 && claimEvidence.length === 0) warnings.push(`Claim ${claim.claimId} has no citation or evidence link.`);
    return `- **${claim.claimType} (${claim.confidence})** ${claim.text} ${[...citations, ...evidence].join(" ")}`.trim();
  });
  const evaluations = input.evaluations ?? [];
  const decisions = input.decisions ?? [];
  for (const evaluation of evaluations) for (const metric of evaluation.metrics) {
    if (metric.computed?.reviewRequired) warnings.push(`Evaluation ${evaluation.evaluationId} metric ${metric.name} requires manual statistical review: ${(metric.computed.reviewReasons ?? []).join(" ")}`);
    if (metric.computedBootstrap?.reviewRequired) warnings.push(`Evaluation ${evaluation.evaluationId} metric ${metric.name} requires manual statistical review: ${metric.computedBootstrap.reviewReasons.join(" ")}`);
  }
  const memoryConflicts = input.memoryConflicts ?? [];
  const memoryConflictLines = memoryConflicts.length ? memoryConflicts.map((group) => { if (group.reviewStatus === "unresolved") warnings.push(`Memory conflict ${group.conflictKey} remains unresolved.`); return `- **${group.reviewStatus}** ${group.conflictKey}: ${group.entries.map((entry) => `${entry.memoryId} — ${entry.text}`).join(" | ")}`; }) : ["No memory conflicts have been recorded."];
  const warningLines = warnings.length ? ["", "## Evidence warnings", ...warnings.map((warning) => `- ${warning}`)] : [];
  const evaluationLines = evaluations.map((evaluation) => `- **${evaluation.conclusion}** ${evaluation.summary}${evaluation.metrics.length ? ` (${evaluation.metrics.map((metric) => `${metric.name}=${metric.observed}${metric.expected === undefined ? "" : ` expected ${metric.expected}`}`).join(", ")})` : ""}${evaluation.nextAction ? ` → next: ${evaluation.nextAction}` : ""}`);
  const decisionLines = decisions.map((decision) => `- **${decision.decision}** ${decision.reason} (iteration ${decision.iteration}/${decision.maxIterations}${decision.evaluationId ? `, evaluation ${decision.evaluationId}` : ""})`);
  const completedTasks = input.plan?.tasks.filter((task) => task.kind !== "report" && task.status === "completed") ?? [];
  const methodLines = completedTasks.length ? completedTasks.map((task) => `- ${task.title}: ${task.summary ?? "completed"}`) : ["No completed tasks have been recorded yet."];
  const runLines = experimentRuns.length ? experimentRuns.map((run) => `- ${run.runId}: ${run.state}, exit ${run.exitCode ?? "unknown"}, duration ${run.durationMs ?? "unknown"} ms`) : ["No experiment runs have been recorded yet."];
  const artifactLines = artifacts.length ? artifacts.map((artifact) => `- ${artifact.artifactId}: ${artifact.relativePath} (${artifact.mediaType}, ${artifact.bytes} bytes, SHA-256 ${artifact.contentHash})`) : ["No artifacts have been registered yet."];
  const limitationLines = [...new Set([...evaluations.flatMap((evaluation) => evaluation.limitations), ...warnings])];
  const markdown = [`# ${input.project.title}`, "", `**Research question:** ${input.project.question}`, `**Project status:** ${input.project.status}`, "", "## Summary", `This report contains ${input.claims.length} claims, ${evaluations.length} evaluations, ${decisions.length} decisions, ${experimentRuns.length} experiment runs, and ${artifacts.length} artifacts.`, "", "## Methods", ...methodLines, "", "## Results", ...(claimLines.length ? claimLines : ["No claims have been recorded yet."]), "", "## Evaluations", ...(evaluationLines.length ? evaluationLines : ["No evaluations have been recorded yet."]), "", "## Decisions", ...(decisionLines.length ? decisionLines : ["No iteration decisions have been recorded yet."]), "", "## Experiments", ...runLines, "", "## Artifacts", ...artifactLines, "", "## Source relationships", ...sourceRelationLines, "", "## Memory review", ...memoryConflictLines, "", "## Limitations", ...(limitationLines.length ? limitationLines.map((line) => `- ${line}`) : ["No limitations have been recorded yet."]), "", "## Sources", ...(referenceLines.length ? referenceLines : ["No cited sources have been recorded yet."]), ...warningLines, "", `*Generated at ${generatedAt}. Claims without a citation or evidence link remain visibly flagged for review.*`].join("\n");
  const nodes = [
    ...input.claims.map((claim) => `<li id="${anchor("claim", claim.claimId)}" class="claim"><b>Claim</b> ${html(claim.claimId)}: ${html(claim.text)} ${claim.citationIds.map((id) => jump("citation", id)).join(" ")}</li>`),
    ...input.sources.map((source) => `<li id="${anchor("source", source.sourceId)}" class="source"><b>Source</b> ${html(source.sourceId)}: ${html(source.title)}${source.url ? ` — <a href="${safeHref(source.url)}">${html(source.url)}</a>` : ""}</li>`),
    ...input.citations.map((citation) => `<li id="${anchor("citation", citation.citationId)}"><b>Citation</b> ${html(citation.citationId)} → ${jump("source", citation.sourceId)} · version ${html(citation.contentVersionId ?? "unbound")} · ${html(locatorText(citation.locator))}<blockquote>${html(citation.quotedText ?? "No saved quote")}</blockquote></li>`),
    ...sourceRelations.map((relation) => `<li class="source"><b>Source relation</b> ${html(relation.kind)}: ${html(relation.fromSourceId)} → ${html(relation.toSourceId)} (${relation.countsAsIndependent ? "independent" : "same evidence family"})</li>`),
    ...experimentRuns.map((run) => `<li id="${anchor("run", run.runId)}" class="experiment"><b>Experiment</b> ${html(run.runId)}: ${html(run.state)} · exit ${html(String(run.exitCode ?? "unknown"))} · seed ${html(String(run.manifest.randomSeed ?? "unspecified"))}</li>`),
    ...artifacts.map((artifact) => `<li id="${anchor("artifact", artifact.artifactId)}" class="artifact"><b>Artifact</b> ${html(artifact.artifactId)}: ${html(artifact.relativePath)} (${html(artifact.contentHash)}) ${artifact.experimentRef ? jump("run", artifact.experimentRef) : ""}</li>`),
    ...evaluations.map((evaluation) => `<li id="${anchor("evaluation", evaluation.evaluationId)}" class="evaluation"><b>Evaluation</b> ${html(evaluation.evaluationId)}: ${html(evaluation.conclusion)} — ${html(evaluation.summary)} ${evaluation.experimentRunIds.map((id) => jump("run", id)).join(" ")} ${evaluation.artifactIds.map((id) => jump("artifact", id)).join(" ")}</li>`),
    ...decisions.map((decision) => `<li class="evaluation"><b>Decision</b> ${html(decision.decisionId)}: ${html(decision.decision)} — ${html(decision.reason)}</li>`),
    ...memoryConflicts.map((group) => `<li class="memory"><b>Memory conflict</b> ${html(group.conflictKey)}: ${html(group.reviewStatus)}</li>`),
  ];
  const links = input.evidence.map((link) => `<li>${jump("claim", link.claimId)} <span>—${html(link.relation)}→</span> ${link.citationId ? jump("citation", link.citationId) : link.sourceId ? jump("source", link.sourceId) : link.artifactRef ? jump("artifact", link.artifactRef) : link.experimentRef ? jump("run", link.experimentRef) : "unresolved"}</li>`);
  const htmlWarningBlock = warnings.length ? `<aside class="report-warnings" data-report-status="draft"><h2>DRAFT / 草稿</h2><ul>${[...new Set(warnings)].map((warning) => `<li>${html(warning)}</li>`).join("")}</ul></aside>` : `<aside class="report-warnings" data-report-status="draft"><h2>DRAFT / 草稿</h2><p>Human review is required before this report can be treated as final.</p></aside>`;
  const htmlDocument = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${html(input.project.title)}</title><style>body{font:15px system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#222}li{margin:.45rem 0}.claim{color:#154c79}.source{color:#146b3a}.experiment{color:#795500}.artifact{color:#6a1b9a}.evaluation{color:#8b1e3f}.memory{color:#8a4b08}.report-warnings{border:1px solid #c58b00;background:#fff8df;padding:.8rem 1rem;margin:1rem 0}.report-warnings h2{margin:.1rem 0 .5rem;color:#795500}span{color:#666}</style><h1>${html(input.project.title)}</h1><p><b>Research question:</b> ${html(input.project.question)}</p>${htmlWarningBlock}<h2>Evidence graph</h2><ul>${nodes.join("")}</ul><h2>Links</h2><ul>${links.length ? links.join("") : "<li>No evidence links recorded.</li>"}</ul><h2>Memory review</h2><ul>${memoryConflicts.length ? memoryConflicts.map((group) => `<li>${html(group.conflictKey)} — ${html(group.reviewStatus)}</li>`).join("") : "<li>No memory conflicts have been recorded.</li>"}</ul><p>Generated at ${html(generatedAt)}.</p></html>`;
  const sourceBindings = input.sources.filter((source) => references.has(source.sourceId)).flatMap((source) => {
    const versionIds = [...new Set(input.citations.filter((citation) => citation.sourceId === source.sourceId).map((citation) => citation.contentVersionId))];
    return (versionIds.length ? versionIds : [undefined]).map((contentVersionId) => ({ sourceId: source.sourceId, contentVersionId, contentHash: input.sourceContents?.find((item) => item.sourceId === source.sourceId && item.contentVersionId === contentVersionId)?.contentHash }));
  }).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || (a.contentVersionId ?? "").localeCompare(b.contentVersionId ?? ""));
  const digest = contentDigest;
  const runBindings = experimentRuns.map((run) => ({ runId: run.runId, contentHash: digest(run) })).sort((a, b) => a.runId.localeCompare(b.runId));
  const evaluationBindings = evaluations.map((evaluation) => ({ evaluationId: evaluation.evaluationId, contentHash: digest(evaluation) })).sort((a, b) => a.evaluationId.localeCompare(b.evaluationId));
  const decisionBindings = decisions.map((decision) => ({ decisionId: decision.decisionId, contentHash: digest(decision) })).sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  const artifactBindings = artifacts.map((artifact) => ({ artifactId: artifact.artifactId, contentHash: artifact.contentHash })).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  // Completing the report task must not invalidate the report it just produced.
  const projectBinding = { projectId: input.project.projectId, title: input.project.title, question: input.project.question, planId: input.project.planId, iteration: input.project.iteration };
  const planBinding = input.plan && { planId: input.plan.planId, version: input.plan.version, question: input.plan.question, constraints: input.plan.constraints, tasks: input.plan.tasks.filter((task) => task.kind !== "report") };
  const upstreamHash = digest({ project: projectBinding, plan: planBinding, sources: input.sources, sourceContents: input.sourceContents ?? [], citations: input.citations, claims: input.claims, evidence: input.evidence, evidenceReviews: input.evidenceReviews ?? [], sourceRelations, hypotheses: input.hypotheses ?? [], experimentDesigns: input.experimentDesigns ?? [], designReviews: input.designReviews ?? [], experiments: input.experiments ?? [], experimentRuns, artifacts, evaluations, decisions, memoryConflicts });
  const report: ResearchReport = { schema: "dsh-sci.research-report.v1", reportId: input.reportId ?? `report-${randomUUID()}`, projectId: input.project.projectId, title: input.project.title, markdown, html: htmlDocument, claimIds: input.claims.map((claim) => claim.claimId), sourceIds: [...references.keys()], evidenceIds: input.evidence.map((link) => link.evidenceId), evaluationIds: evaluations.map((evaluation) => evaluation.evaluationId), decisionIds: decisions.map((decision) => decision.decisionId), experimentIds: [...new Set(experimentRuns.map((run) => run.experimentId))], artifactIds: artifacts.map((artifact) => artifact.artifactId), memoryConflictKeys: memoryConflicts.map((group) => group.conflictKey), sourceBindings, runBindings, evaluationBindings, decisionBindings, artifactBindings, upstreamHash, contentHash: "", generatedAt, warnings: [...new Set(warnings)], planId: input.plan?.planId, qualityIssues, reviewStatus: "draft" };
  report.contentHash = reportContentHash(report);
  return report;
}
