import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { metadataPassphraseFromEnvironment, parseMetadataJson, serializeMetadataJson } from "../metadata-crypto.js";
import type { ResearchEvent, ResearchPlan, ResearchProject, ResearchTask } from "./domain.js";
import { normalizeResearchSource, type ResearchClaim, type ResearchCitation, type ResearchEvidenceLink, type ResearchSource } from "./evidence.js";
import type { ExperimentDefinition, ExperimentRun } from "./experiment.js";
import type { ResearchArtifact } from "./artifact.js";
import type { ResearchEvaluation } from "./evaluation.js";
import { validateResearchDecision, type ResearchDecision } from "./decision.js";
import { validateResearchReport, type ResearchReport, type ResearchReportReview } from "./report.js";
import { validateReportReview } from "./report-review.js";
import { normalizeResearchMemory, type MemoryIndexVersion, type MemoryRetrievalRecord, type ResearchMemoryEntry } from "./memory.js";
import { validateMemoryIndex } from "./memory-index.js";
import { validateResearchBudget, reserveBudgetModelRequest, settleBudgetModelRequest, ResearchBudgetConfigurationError, ResearchBudgetPersistenceError, ResearchBudgetExhaustedError, type ResearchBudget, type ModelRequestScope } from "./budget.js";
import type { ModelUsage } from "../model-usage.js";
import { validateSourceContent, summarizeSourceContent, type SourceContentVersion, type SourceContentSummary, type SourceReadReceipt, type SourceAcquisition } from "./source-content.js";
import type { ResearchSearchLog } from "./search-log.js";
import type { ResearchEvidenceReview } from "./evidence-review.js";
import { validateResearchHypothesis, type ResearchHypothesis } from "./hypothesis.js";
import { validateExperimentDesign, type ResearchExperimentDesign } from "./experiment-design.js";
import type { ResearchCodeBundle } from "./code-staging.js";
import { validateCodeRead, validateCodeReview, type ResearchCodeRead, type ResearchCodeReview } from "./code-review.js";
import { planStateDigest, validatePlanCommit, type ResearchPlanCommit } from "./plan-commit.js";
import { contentDigest } from "./content-digest.js";
import { validateSourceRelation, type ResearchSourceRelation } from "./source-relation.js";
import { validateDesignReview, type ResearchDesignReview } from "./design-review.js";
import { validateResultCommit, type ResearchResultCommit } from "./result-commit.js";
import { assertCompatibleResearchStore } from "./store-format.js";

const INDEX_FILE = "index.json";
// One desktop writer; share the queue across Repository instances in this process.
const budgetWrites = new Map<string, Promise<unknown>>();
const eventWrites = new Map<string, Promise<void>>();
const securityAuditWrites = new Map<string, Promise<void>>();
const securityAuditWindows = new Map<string, { startedAt: number; count: number; suppressed: number }>();
const securityAuditReasons = ["authentication", "route", "rate-limit", "action-validation-or-execution", "malformed-request", "capability", "project-lookup"] as const;

export interface ResearchSecurityAudit {
  schema: "dsh-sci.research-security-audit.v1";
  auditId: string;
  requestId: string;
  at: string;
  action: string;
  outcome: "accepted" | "rejected";
  reason?: typeof securityAuditReasons[number];
  projectId?: string;
  suppressedRequests?: number;
}

function segment(value: string): string {
  const encoded = encodeURIComponent(value);
  return encoded === "." ? "%2E" : encoded === ".." ? "%2E%2E" : encoded;
}

export interface ResearchRepositoryOptions { metadataPassphrase?: string; /** Trusted offline migrator only; never exposed through bridge/IPC. */ migrationId?: string; }
export type ResearchApprovalItem =
  | { kind: "task"; project: ResearchProject; plan: ResearchPlan; task: ResearchTask }
  | { kind: "experiment"; project: ResearchProject; task?: ResearchTask; experiment: ExperimentDefinition };

/** Durable project/plan/event storage used by both the desktop and DSH plugin. */
export class ResearchRepository {
  readonly root: string;
  readonly metadataPassphrase?: string;
  private initialized = false;
  private compatibility?: Promise<void>;
  private readonly migrationId?: string;
  constructor(root: string, options: ResearchRepositoryOptions = {}) { this.root = path.resolve(root); this.metadataPassphrase = options.metadataPassphrase ?? metadataPassphraseFromEnvironment(); this.migrationId = options.migrationId; }
  private assertCompatible(): Promise<void> { return this.compatibility ??= assertCompatibleResearchStore(this.root, this.metadataPassphrase, this.migrationId); }

  async init(): Promise<void> { await this.assertCompatible(); if (this.initialized) return; await mkdir(path.join(this.root, "projects"), { recursive: true }); this.initialized = true; }

  async saveProject(project: ResearchProject): Promise<void> { await this.writeJson(path.join("projects", segment(project.projectId), "project.json"), project); await this.updateIndex(project); }
  async readProject(projectId: string): Promise<ResearchProject | undefined> { return this.readOptionalJson<ResearchProject>(path.join("projects", segment(projectId), "project.json")); }
  async readBudget(projectId: string): Promise<ResearchBudget | undefined> {
    const budget = await this.readOptionalJson<unknown>(path.join("projects", segment(projectId), "budget.json"));
    return budget === undefined ? undefined : validateResearchBudget(budget, projectId);
  }
  async saveBudget(budget: ResearchBudget): Promise<void> { validateResearchBudget(budget); await this.writeJson(path.join("projects", segment(budget.projectId), "budget.json"), budget); }
  mutateBudget(projectId: string, transform: (previous: ResearchBudget | undefined) => ResearchBudget): Promise<ResearchBudget> {
    const key = path.join(this.root, segment(projectId));
    const operation = (budgetWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const previous = await this.readBudget(projectId);
      const next = transform(previous);
      validateResearchBudget(next, projectId);
      if (next !== previous) await this.saveBudget(next);
      return next;
    });
    budgetWrites.set(key, operation);
    void operation.finally(() => { if (budgetWrites.get(key) === operation) budgetWrites.delete(key); }).catch(() => undefined);
    return operation;
  }
  async reserveModelRequest(projectId: string, scope: ModelRequestScope): Promise<string> {
    let reservationId = "";
    try {
      await this.mutateBudget(projectId, (budget) => {
        if (budget?.schema !== "dsh-sci.research-budget.v2") throw new ResearchBudgetConfigurationError();
        const reserved = reserveBudgetModelRequest(budget, scope);
        reservationId = reserved.reservation.reservationId;
        return reserved.budget;
      });
    } catch (error) {
      if (error instanceof ResearchBudgetConfigurationError || error instanceof ResearchBudgetExhaustedError) throw error;
      throw new ResearchBudgetPersistenceError({ cause: error });
    }
    return reservationId;
  }
  async recordModelUsage(projectId: string, reservationId: string, usage?: ModelUsage): Promise<void> {
    try {
      await this.mutateBudget(projectId, (budget) => {
        if (budget?.schema !== "dsh-sci.research-budget.v2") throw new ResearchBudgetConfigurationError();
        return settleBudgetModelRequest(budget, reservationId, usage);
      });
    } catch (error) { throw new ResearchBudgetPersistenceError({ cause: error }); }
  }
  /** Exclusive startup only. Never call while a provider request may still settle. */
  async recoverModelRequests(projectId: string): Promise<void> {
    await this.mutateBudget(projectId, (budget) => {
      if (!budget || budget.schema === "dsh-sci.research-budget.v1") {
        // Legacy/missing budgets are handled by explicit Workspace configuration.
        if (!budget) throw new ResearchBudgetConfigurationError("Research budget is missing during recovery");
        return budget;
      }
      let recovered = budget;
      for (const request of budget.modelRequests) if (request.status === "reserved") recovered = settleBudgetModelRequest(recovered, request.reservationId, undefined, true);
      return recovered;
    });
  }
  async savePlan(plan: ResearchPlan): Promise<void> { await this.writeJson(path.join("projects", segment(plan.projectId), "plans", `${segment(plan.planId)}.json`), plan); }
  async readPlan(projectId: string, planId: string): Promise<ResearchPlan | undefined> {
    const plan = await this.readOptionalJson<ResearchPlan>(path.join("projects", segment(projectId), "plans", `${segment(planId)}.json`));
    return plan ? { ...plan, protocolReviewRequired: plan.resultProtocol !== "dsh-sci.research-task-result.v2" || plan.tasks.some((task) => task.completionContract?.schema !== "dsh-sci.research-task-contract.v1" || !task.allowedActions || !task.successCriteria || !Number.isSafeInteger(task.stateVersion) || task.stateVersion! < 0 || (task.status === "running" && !task.attemptId)) } : undefined;
  }
  async readResultCommit(projectId: string, submissionId: string): Promise<ResearchResultCommit | undefined> {
    const key = createHash("sha256").update(submissionId).digest("hex");
    const commit = await this.readOptionalJson<ResearchResultCommit>(this.entityPath(projectId, "result-commits", key));
    return commit === undefined ? undefined : validateResultCommit(commit, projectId, submissionId);
  }
  async saveResultCommit(commit: ResearchResultCommit): Promise<void> { validateResultCommit(commit); const key = createHash("sha256").update(commit.submissionId).digest("hex"); await this.writeJson(this.entityPath(commit.projectId, "result-commits", key), commit); }
  async savePlanCommit(commit: ResearchPlanCommit): Promise<void> { validatePlanCommit(commit); await this.writeJson(this.entityPath(commit.projectId, "plan-commits", commit.commitId), commit); }
  private async listPlanCommits(projectId: string): Promise<ResearchPlanCommit[]> {
    await this.assertCompatible();
    const directory = path.join("projects", segment(projectId), "plan-commits");
    let files: string[];
    try { files = await readdir(path.join(this.root, directory)); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => { const commit = validatePlanCommit(await this.readJson<unknown>(path.join(directory, file)), projectId); if (file !== `${commit.commitId}.json`) throw new Error("Research plan journal filename does not match its commit ID"); return commit; }));
  }
  async recoverPlanCommits(projectId: string): Promise<void> {
    for (const commit of await this.listPlanCommits(projectId)) if (commit.status === "prepared") await this.applyPlanCommit(commit);
  }
  async hasPendingPlanCommit(projectId: string): Promise<boolean> { return (await this.listPlanCommits(projectId)).some((commit) => commit.status === "prepared"); }
  async applyPlanCommit(commit: ResearchPlanCommit): Promise<void> {
    validatePlanCommit(commit);
    const currentProject = await this.readProject(commit.projectId), currentPlan = commit.beforePlan ? await this.readPlan(commit.projectId, commit.beforePlan.planId) : undefined;
    const superseded: ResearchPlan | undefined = commit.beforePlan ? { ...commit.beforePlan, status: "superseded", updatedAt: commit.nextPlan.createdAt } : undefined;
    if (!currentProject || ![contentDigest(commit.beforeProject), contentDigest(commit.nextProject)].includes(contentDigest(currentProject)) || (commit.beforePlan && (!currentPlan || ![planStateDigest(commit.beforePlan), planStateDigest(superseded)].includes(planStateDigest(currentPlan))))) throw new Error("Pending plan commit targets changed research state; review required");
    const existing = await this.readPlan(commit.projectId, commit.nextPlan.planId);
    if (existing && planStateDigest(existing) !== planStateDigest(commit.nextPlan)) throw new Error("Pending plan commit would overwrite a changed plan; review required");
    await this.savePlan(commit.nextPlan); if (superseded) await this.savePlan(superseded); await this.saveProject(commit.nextProject);
    if (commit.decision) await this.saveDecision(commit.decision);
    for (const event of commit.events) await this.appendEvent(event);
    const active = await this.readActiveContext();
    if (active?.projectId === commit.projectId && (!active.planId || active.planId === commit.beforePlan?.planId)) await this.clearActiveContext();
    await this.savePlanCommit({ ...commit, status: "committed" });
  }
  private async listResultCommits(projectId: string): Promise<ResearchResultCommit[]> {
    await this.assertCompatible();
    const directory = path.join("projects", segment(projectId), "result-commits");
    let files: string[];
    try { files = await readdir(path.join(this.root, directory)); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
      const commit = validateResultCommit(await this.readJson<unknown>(path.join(directory, file)), projectId);
      if (file !== createHash("sha256").update(commit.submissionId).digest("hex") + ".json") throw new Error("Research result journal filename does not match its submission ID");
      return commit;
    }));
  }
  async hasPendingResultCommit(projectId: string): Promise<boolean> { return (await this.listResultCommits(projectId)).some((commit) => commit.status === "prepared"); }
  /** Exclusive desktop owner only; complete accepted writes before accepting new work. */
  async recoverResultCommits(projectId: string): Promise<void> {
    for (const commit of await this.listResultCommits(projectId)) {
      if (commit.status === "prepared") await this.applyResultCommit(commit);
    }
  }
  async applyResultCommit(commit: ResearchResultCommit): Promise<void> {
    validateResultCommit(commit);
    const current = await this.readProject(commit.projectId);
    if (!current || current.planId !== commit.result.planId) throw new Error("Pending result commit targets a different plan; review required");
    const plan = await this.readPlan(commit.projectId, commit.result.planId);
    const task = plan?.tasks.find((task) => task.taskId === commit.result.taskId);
    const finalTask = commit.plan.tasks.find((task) => task.taskId === commit.result.taskId)!;
    if (!task || task.attemptId !== commit.result.attemptId || (task.stateVersion !== commit.result.expectedTaskVersion && task.stateVersion !== finalTask.stateVersion)) throw new Error("Pending result commit targets a different execution state; review required");
    for (const claim of commit.claims) await this.saveClaim(claim);
    for (const link of commit.evidence) await this.saveEvidenceLink(link);
    await this.savePlan(commit.plan);
    await this.saveProject(commit.project);
    for (const event of commit.events) await this.appendEvent(event);
    if (commit.activeContext) await this.saveActiveContext(commit.activeContext);
    else {
      const active = await this.readActiveContext();
      if (active?.projectId === commit.projectId) await this.clearActiveContext();
    }
    await this.saveResultCommit({ ...commit, status: "committed" });
  }
  async saveSource(source: ResearchSource): Promise<void> { await this.writeJson(this.entityPath(source.projectId, "sources", source.sourceId), source); }
  async readSource(projectId: string, sourceId: string): Promise<ResearchSource | undefined> { const source = await this.readOptionalJson<ResearchSource>(this.entityPath(projectId, "sources", sourceId)); return source ? normalizeResearchSource(source) : undefined; }
  async listSources(projectId: string): Promise<ResearchSource[]> { return (await this.listEntities<ResearchSource>(projectId, "sources")).map(normalizeResearchSource); }
  async saveSearchLog(log: ResearchSearchLog): Promise<void> { await this.writeJson(this.entityPath(log.projectId, "search-logs", log.searchId), log); }
  async listSearchLogs(projectId: string): Promise<ResearchSearchLog[]> { return this.listEntities<ResearchSearchLog>(projectId, "search-logs"); }
  async saveSourceAcquisition(record: SourceAcquisition): Promise<void> { await this.writeJson(this.entityPath(record.projectId, "source-acquisitions", record.acquisitionId), record); }
  async listSourceAcquisitions(projectId: string): Promise<SourceAcquisition[]> { return this.listEntities<SourceAcquisition>(projectId, "source-acquisitions"); }
  async saveSourceRelation(relation: ResearchSourceRelation): Promise<void> { validateSourceRelation(relation, relation.projectId); const old = await this.readSourceRelation(relation.projectId, relation.relationId); if (old && JSON.stringify(old) !== JSON.stringify(relation)) throw new Error("Source relations are immutable"); if (!old) await this.writeJson(this.entityPath(relation.projectId, "source-relations", relation.relationId), relation); }
  async readSourceRelation(projectId: string, relationId: string): Promise<ResearchSourceRelation | undefined> { const value = await this.readOptionalJson<ResearchSourceRelation>(this.entityPath(projectId, "source-relations", relationId)); return value ? validateSourceRelation(value, projectId) : undefined; }
  async listSourceRelations(projectId: string): Promise<ResearchSourceRelation[]> { return (await this.listEntities<ResearchSourceRelation>(projectId, "source-relations")).map((value) => validateSourceRelation(value, projectId)); }
  async saveSourceContent(content: SourceContentVersion): Promise<void> {
    validateSourceContent(content, content.projectId);
    if (!await this.readSource(content.projectId, content.sourceId)) throw new Error("Source content requires a registered source");
    const old = await this.readSourceContent(content.projectId, content.contentVersionId);
    if (old && JSON.stringify(old) !== JSON.stringify(content)) throw new Error("Source content versions are immutable");
    if (!old) await this.writeJson(this.entityPath(content.projectId, "source-content", content.contentVersionId), content);
  }
  async readSourceContent(projectId: string, contentVersionId: string): Promise<SourceContentVersion | undefined> {
    const content = await this.readOptionalJson<SourceContentVersion>(this.entityPath(projectId, "source-content", contentVersionId));
    if (!content) return undefined;
    validateSourceContent(content, projectId);
    if (content.contentVersionId !== contentVersionId) throw new Error("Source content filename does not match its version");
    return content;
  }
  async listSourceContents(projectId: string): Promise<SourceContentSummary[]> {
    const contents = await this.listEntities<SourceContentVersion>(projectId, "source-content");
    return contents.map((content) => summarizeSourceContent(validateSourceContent(content, projectId)));
  }
  async saveSourceRead(receipt: SourceReadReceipt): Promise<void> {
    await this.validateSourceRead(receipt, receipt.projectId);
    const old = await this.readOptionalJson<SourceReadReceipt>(this.entityPath(receipt.projectId, "source-reads", receipt.readId));
    if (old && JSON.stringify(old) !== JSON.stringify(receipt)) throw new Error("Source read receipts are immutable");
    if (!old) await this.writeJson(this.entityPath(receipt.projectId, "source-reads", receipt.readId), receipt);
  }
  async listSourceReads(projectId: string): Promise<SourceReadReceipt[]> {
    const receipts = await this.listEntities<SourceReadReceipt>(projectId, "source-reads");
    return Promise.all(receipts.map((receipt) => this.validateSourceRead(receipt, projectId)));
  }
  private async validateSourceRead(receipt: SourceReadReceipt, projectId: string): Promise<SourceReadReceipt> {
    if (!receipt || receipt.schema !== "dsh-sci.source-read.v1" || receipt.projectId !== projectId || !receipt.readId || !["agent", "workspace"].includes(receipt.audience) || !Array.isArray(receipt.chunkIds) || !receipt.chunkIds.length || receipt.chunkIds.length > 3 || new Set(receipt.chunkIds).size !== receipt.chunkIds.length) throw new Error("Invalid source read receipt");
    const content = await this.readSourceContent(projectId, receipt.contentVersionId);
    if (!content || content.sourceId !== receipt.sourceId || content.contentHash !== receipt.contentHash || receipt.chunkIds.some((id) => !content.chunks.some((chunk) => chunk.chunkId === id))) throw new Error("Source read receipt does not match stored content");
    if (receipt.audience === "agent" && (!receipt.planId || !receipt.taskId || !receipt.attemptId)) throw new Error("Agent reading requires an execution identity");
    return receipt;
  }
  async saveCitation(citation: ResearchCitation): Promise<void> { await this.writeJson(this.entityPath(citation.projectId, "citations", citation.citationId), citation); }
  async readCitation(projectId: string, citationId: string): Promise<ResearchCitation | undefined> { return this.readOptionalJson<ResearchCitation>(this.entityPath(projectId, "citations", citationId)); }
  async listCitations(projectId: string): Promise<ResearchCitation[]> { return this.listEntities<ResearchCitation>(projectId, "citations"); }
  async saveClaim(claim: ResearchClaim): Promise<void> { await this.writeJson(this.entityPath(claim.projectId, "claims", claim.claimId), claim); }
  async readClaim(projectId: string, claimId: string): Promise<ResearchClaim | undefined> { return this.readOptionalJson<ResearchClaim>(this.entityPath(projectId, "claims", claimId)); }
  async listClaims(projectId: string): Promise<ResearchClaim[]> { return this.listEntities<ResearchClaim>(projectId, "claims"); }
  async saveEvidenceLink(link: ResearchEvidenceLink): Promise<void> { await this.writeJson(this.entityPath(link.projectId, "evidence", link.evidenceId), link); }
  async readEvidenceLink(projectId: string, evidenceId: string): Promise<ResearchEvidenceLink | undefined> { return this.readOptionalJson<ResearchEvidenceLink>(this.entityPath(projectId, "evidence", evidenceId)); }
  async listEvidenceLinks(projectId: string): Promise<ResearchEvidenceLink[]> { return this.listEntities<ResearchEvidenceLink>(projectId, "evidence"); }
  async saveHypothesis(hypothesis: ResearchHypothesis): Promise<void> { validateResearchHypothesis(hypothesis, hypothesis.projectId); await this.writeJson(this.entityPath(hypothesis.projectId, "hypotheses", hypothesis.hypothesisId), hypothesis); }
  async readHypothesis(projectId: string, hypothesisId: string): Promise<ResearchHypothesis | undefined> { const value = await this.readOptionalJson<ResearchHypothesis>(this.entityPath(projectId, "hypotheses", hypothesisId)); if (value && value.hypothesisId !== hypothesisId) throw new Error("Hypothesis identity mismatch"); return value ? validateResearchHypothesis(value, projectId) : undefined; }
  async listHypotheses(projectId: string): Promise<ResearchHypothesis[]> { return (await this.listEntities<ResearchHypothesis>(projectId, "hypotheses")).map((value) => validateResearchHypothesis(value, projectId)); }
  async saveExperimentDesign(design: ResearchExperimentDesign): Promise<void> { validateExperimentDesign(design, design.projectId); await this.writeJson(this.entityPath(design.projectId, "experiment-designs", design.designId), design); }
  async readExperimentDesign(projectId: string, designId: string): Promise<ResearchExperimentDesign | undefined> { const value = await this.readOptionalJson<ResearchExperimentDesign>(this.entityPath(projectId, "experiment-designs", designId)); if (value && value.designId !== designId) throw new Error("Design identity mismatch"); return value ? validateExperimentDesign(value, projectId) : undefined; }
  async listExperimentDesigns(projectId: string): Promise<ResearchExperimentDesign[]> { return (await this.listEntities<ResearchExperimentDesign>(projectId, "experiment-designs")).map((value) => validateExperimentDesign(value, projectId)); }
  async saveDesignReview(review: ResearchDesignReview): Promise<void> { validateDesignReview(review, review.projectId); const old = await this.readDesignReview(review.projectId, review.reviewId); if (old && JSON.stringify(old) !== JSON.stringify(review)) throw new Error("Design reviews are immutable"); if (!old) await this.writeJson(this.entityPath(review.projectId, "design-reviews", review.reviewId), review); }
  async readDesignReview(projectId: string, reviewId: string): Promise<ResearchDesignReview | undefined> { const value = await this.readOptionalJson<ResearchDesignReview>(this.entityPath(projectId, "design-reviews", reviewId)); return value ? validateDesignReview(value, projectId) : undefined; }
  async listDesignReviews(projectId: string): Promise<ResearchDesignReview[]> { return (await this.listEntities<ResearchDesignReview>(projectId, "design-reviews")).map((value) => validateDesignReview(value, projectId)); }
  async saveCodeBundle(bundle: ResearchCodeBundle): Promise<void> { await this.writeJson(this.entityPath(bundle.projectId, "code-bundles", bundle.bundleId), bundle); }
  async readCodeBundle(projectId: string, bundleId: string): Promise<ResearchCodeBundle | undefined> { return this.readOptionalJson<ResearchCodeBundle>(this.entityPath(projectId, "code-bundles", bundleId)); }
  async listCodeBundles(projectId: string): Promise<ResearchCodeBundle[]> { return this.listEntities<ResearchCodeBundle>(projectId, "code-bundles"); }
  async saveCodeRead(receipt: ResearchCodeRead): Promise<void> {
    validateCodeRead(receipt, receipt.projectId);
    const bundle = await this.readCodeBundle(receipt.projectId, receipt.bundleId);
    if (!bundle || bundle.contentHash !== receipt.bundleContentHash || !bundle.files.some((file) => file.name === receipt.fileName && file.contentHash === receipt.contentHash)) throw new Error("Code read receipt does not match a registered file");
    const old = await this.readOptionalJson<ResearchCodeRead>(this.entityPath(receipt.projectId, "code-reads", receipt.codeReadId));
    if (old && contentDigest(old) !== contentDigest(receipt)) throw new Error("Code read receipts are immutable");
    if (!old) await this.writeJson(this.entityPath(receipt.projectId, "code-reads", receipt.codeReadId), receipt);
  }
  async listCodeReads(projectId: string): Promise<ResearchCodeRead[]> { return (await this.listEntities<ResearchCodeRead>(projectId, "code-reads")).map((value) => validateCodeRead(value, projectId)); }
  async saveCodeReview(review: ResearchCodeReview): Promise<void> {
    validateCodeReview(review, review.projectId);
    const old = await this.readCodeReview(review.projectId, review.codeReviewId);
    if (old && contentDigest({ ...old, createdAt: undefined }) !== contentDigest({ ...review, createdAt: undefined })) throw new Error("Code reviews are immutable");
    if (!old) await this.writeJson(this.entityPath(review.projectId, "code-reviews", review.codeReviewId), review);
  }
  async readCodeReview(projectId: string, reviewId: string): Promise<ResearchCodeReview | undefined> {
    const value = await this.readOptionalJson<ResearchCodeReview>(this.entityPath(projectId, "code-reviews", reviewId));
    if (value && value.codeReviewId !== reviewId) throw new Error("Code review identity mismatch");
    return value ? validateCodeReview(value, projectId) : undefined;
  }
  async listCodeReviews(projectId: string): Promise<ResearchCodeReview[]> { return (await this.listEntities<ResearchCodeReview>(projectId, "code-reviews")).map((value) => validateCodeReview(value, projectId)); }
  async saveEvidenceReview(review: ResearchEvidenceReview): Promise<void> { await this.writeJson(this.entityPath(review.projectId, "evidence-reviews", review.reviewId), review); }
  async listEvidenceReviews(projectId: string): Promise<ResearchEvidenceReview[]> { return this.listEntities<ResearchEvidenceReview>(projectId, "evidence-reviews"); }
  async saveExperiment(definition: ExperimentDefinition): Promise<void> { await this.writeJson(this.entityPath(definition.projectId, "experiments", definition.experimentId), definition); }
  async readExperiment(projectId: string, experimentId: string): Promise<ExperimentDefinition | undefined> { const value = await this.readOptionalJson<ExperimentDefinition>(this.entityPath(projectId, "experiments", experimentId)); return value ? { ...value, hypothesisIds: value.hypothesisIds ?? [] } : undefined; }
  async listExperiments(projectId: string): Promise<ExperimentDefinition[]> { return (await this.listEntities<ExperimentDefinition>(projectId, "experiments")).map((value) => ({ ...value, hypothesisIds: value.hypothesisIds ?? [] })); }
  async saveExperimentRun(run: ExperimentRun): Promise<void> { await this.writeJson(this.entityPath(run.projectId, "experiment-runs", run.runId), run); }
  async readExperimentRun(projectId: string, runId: string): Promise<ExperimentRun | undefined> { return this.readOptionalJson<ExperimentRun>(this.entityPath(projectId, "experiment-runs", runId)); }
  async listExperimentRuns(projectId: string): Promise<ExperimentRun[]> { return this.listEntities<ExperimentRun>(projectId, "experiment-runs"); }
  /** Call only on exclusive application startup, before accepting new work. */
  async recoverInterruptedExperiments(): Promise<{ projectId: string; runId: string }[]> {
    const recovered: { projectId: string; runId: string }[] = [];
    const projects = await this.listProjects(10_000);
    for (const project of projects) {
      await this.recoverResultCommits(project.projectId);
      await this.recoverPlanCommits(project.projectId);
      if (await this.readBudget(project.projectId)) await this.recoverModelRequests(project.projectId);
      const recoveredProject = await this.readProject(project.projectId);
      const runs = await this.listExperimentRuns(project.projectId);
      for (const run of runs) {
        if (run.state !== "running") continue;
        const existing = (await this.listEvents(project.projectId, 10_000)).find((event) => event.type === "experiment-interrupted" && event.data?.runId === run.runId);
        const interrupted: ExperimentRun = { ...run, state: "interrupted", finishedAt: existing?.at ?? new Date().toISOString(), error: "Application restarted before this experiment produced a terminal run record; execution was not resumed automatically." };
        await this.saveProject({ ...recoveredProject!, status: "paused", lastError: "An experiment was interrupted by application shutdown. Review its outputs and create a new proposal before retrying.", updatedAt: interrupted.finishedAt! });
        if (!existing) await this.appendEvent({ schema: "dsh-sci.research-event.v1", eventId: randomUUID(), projectId: project.projectId, planId: project.planId, taskId: run.taskId, type: "experiment-interrupted", at: interrupted.finishedAt!, data: { runId: run.runId, experimentId: run.experimentId, state: "interrupted", recovered: true } });
        // Commit the terminal state last: a crash in the middle retries the
        // pause/audit safely rather than leaving an unreviewed project active.
        await this.saveExperimentRun(interrupted);
        recovered.push({ projectId: project.projectId, runId: run.runId });
      }
    }
    return recovered;
  }
  async saveArtifact(artifact: ResearchArtifact): Promise<void> { await this.writeJson(this.entityPath(artifact.projectId, "artifacts", artifact.artifactId), artifact); }
  async readArtifact(projectId: string, artifactId: string): Promise<ResearchArtifact | undefined> { return this.readOptionalJson<ResearchArtifact>(this.entityPath(projectId, "artifacts", artifactId)); }
  async listArtifacts(projectId: string): Promise<ResearchArtifact[]> { return this.listEntities<ResearchArtifact>(projectId, "artifacts"); }
  async saveEvaluation(evaluation: ResearchEvaluation): Promise<void> { await this.writeJson(this.entityPath(evaluation.projectId, "evaluations", evaluation.evaluationId), evaluation); }
  async readEvaluation(projectId: string, evaluationId: string): Promise<ResearchEvaluation | undefined> { return this.readOptionalJson<ResearchEvaluation>(this.entityPath(projectId, "evaluations", evaluationId)); }
  async listEvaluations(projectId: string): Promise<ResearchEvaluation[]> { return this.listEntities<ResearchEvaluation>(projectId, "evaluations"); }
  async saveDecision(decision: ResearchDecision): Promise<void> { validateResearchDecision(decision, decision.projectId); const old = await this.readDecision(decision.projectId, decision.decisionId); if (old && JSON.stringify(old) !== JSON.stringify(decision)) throw new Error("Research decisions are immutable"); if (!old) await this.writeJson(this.entityPath(decision.projectId, "decisions", decision.decisionId), decision); }
  async readDecision(projectId: string, decisionId: string): Promise<ResearchDecision | undefined> { const value = await this.readOptionalJson<ResearchDecision>(this.entityPath(projectId, "decisions", decisionId)); return value ? validateResearchDecision(value, projectId) : undefined; }
  async listDecisions(projectId: string): Promise<ResearchDecision[]> { return (await this.listEntities<ResearchDecision>(projectId, "decisions")).map((value) => validateResearchDecision(value, projectId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async saveReport(report: ResearchReport): Promise<void> { validateResearchReport(report, report.projectId); const old = await this.readReport(report.projectId, report.reportId); if (old && contentDigest(old) !== contentDigest(report)) throw new Error("Research reports are immutable; generate a new version"); if (!old) await this.writeJson(this.entityPath(report.projectId, "reports", report.reportId), report); }
  async readReport(projectId: string, reportId: string): Promise<ResearchReport | undefined> { const report = await this.readOptionalJson<ResearchReport>(this.entityPath(projectId, "reports", reportId)); if (report && report.reportId !== reportId) throw new Error("Research report filename does not match its ID"); return report ? validateResearchReport(report, projectId) : undefined; }
  async listReports(projectId: string): Promise<ResearchReport[]> { return (await this.listEntities<ResearchReport>(projectId, "reports")).map((report) => validateResearchReport(report, projectId)); }
  async saveReportReview(review: ResearchReportReview): Promise<void> {
    validateReportReview(review, review.projectId);
    const old = await this.readReportReview(review.projectId, review.reviewId);
    if (old && JSON.stringify(old) !== JSON.stringify(review)) throw new Error("Report reviews are immutable");
    if (!old) await this.writeJson(this.entityPath(review.projectId, "report-reviews", review.reviewId), review);
  }
  async readReportReview(projectId: string, reviewId: string): Promise<ResearchReportReview | undefined> { const value = await this.readOptionalJson<ResearchReportReview>(this.entityPath(projectId, "report-reviews", reviewId)); return value ? validateReportReview(value, projectId) : undefined; }
  async listReportReviews(projectId: string): Promise<ResearchReportReview[]> { return (await this.listEntities<ResearchReportReview>(projectId, "report-reviews")).map((value) => validateReportReview(value, projectId)); }
  async saveMemory(entry: ResearchMemoryEntry): Promise<void> { await this.writeJson(path.join("memory", `${segment(entry.memoryId)}.json`), entry); }
  async listMemory(limit = 10_000): Promise<ResearchMemoryEntry[]> {
    await this.assertCompatible();
    try { const entries = await readdir(path.join(this.root, "memory"), { withFileTypes: true }); const values = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => this.readOptionalJson<ResearchMemoryEntry>(path.join("memory", entry.name)))); return values.filter(Boolean).map((entry) => normalizeResearchMemory(entry!)).slice(-limit) as ResearchMemoryEntry[]; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async saveMemoryIndexVersion(index: MemoryIndexVersion): Promise<void> {
    validateMemoryIndex(index);
    const old = await this.readMemoryIndexVersion(index.indexId);
    if (old && contentDigest({ ...old, builtAt: undefined }) !== contentDigest({ ...index, builtAt: undefined })) throw new Error("Research memory indexes are immutable");
    if (!old) await this.writeJson(path.join("memory-indexes", `${segment(index.indexId)}.json`), index);
  }
  async readMemoryIndexVersion(indexId: string): Promise<MemoryIndexVersion | undefined> { const value = await this.readOptionalJson<MemoryIndexVersion>(path.join("memory-indexes", `${segment(indexId)}.json`)); if (value && value.indexId !== indexId) throw new Error("Research memory index identity mismatch"); return value ? validateMemoryIndex(value) : undefined; }
  async listMemoryIndexVersions(limit = 1000): Promise<MemoryIndexVersion[]> { return (await this.listRootEntities<MemoryIndexVersion>("memory-indexes")).map(validateMemoryIndex).sort((a, b) => a.builtAt.localeCompare(b.builtAt) || a.indexId.localeCompare(b.indexId)).slice(-limit); }
  async saveMemoryRetrieval(record: MemoryRetrievalRecord): Promise<void> {
    const index = await this.readMemoryIndexVersion(record.indexId);
    if (!index || index.provider !== record.provider || index.model !== record.model || index.dimensions !== record.dimensions || index.scopeProjectId !== record.projectId || record.memoryIds.some((id) => !index.entryIds.includes(id)) || record.entryBindings?.some((binding) => !record.memoryIds.includes(binding.memoryId) || contentDigest(index.entries?.find((entry) => entry.memoryId === binding.memoryId)) !== binding.contentHash)) throw new Error("Memory retrieval does not match its index snapshot");
    const old = await this.readOptionalJson<MemoryRetrievalRecord>(path.join("memory-retrievals", `${segment(record.retrievalId)}.json`));
    if (old && contentDigest(old) !== contentDigest(record)) throw new Error("Memory retrieval records are immutable");
    if (!old) await this.writeJson(path.join("memory-retrievals", `${segment(record.retrievalId)}.json`), record);
  }
  async listMemoryRetrievals(limit = 1000): Promise<MemoryRetrievalRecord[]> { return (await this.listRootEntities<MemoryRetrievalRecord>("memory-retrievals")).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.retrievalId.localeCompare(b.retrievalId)).slice(-limit); }
  async saveActiveContext(context: { projectId: string; taskId: string; planId?: string }): Promise<void> { await this.writeJson("active-context.json", { schema: "dsh-sci.research-active-context.v1", ...context, updatedAt: new Date().toISOString() }); }
  async readActiveContext(): Promise<{ projectId: string; taskId: string; planId?: string } | undefined> { return this.readOptionalJson<{ projectId: string; taskId: string; planId?: string }>("active-context.json"); }
  async clearActiveContext(): Promise<void> { await this.assertCompatible(); try { await unlink(path.join(this.root, "active-context.json")); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  async saveAgentSession(projectId: string, sessionId: string, planId?: string): Promise<void> { await this.writeJson(path.join("projects", segment(projectId), ...(planId === undefined ? ["agent-session.json"] : ["agent-sessions", `${segment(planId)}.json`])), { sessionId }); }
  async readAgentSession(projectId: string, planId?: string): Promise<{ sessionId: string } | undefined> { return this.readOptionalJson<{ sessionId: string }>(path.join("projects", segment(projectId), ...(planId === undefined ? ["agent-session.json"] : ["agent-sessions", `${segment(planId)}.json`]))); }
  appendEvent(event: ResearchEvent): Promise<void> {
    const key = path.join(this.root, segment(event.projectId));
    const operation = (eventWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.appendEventInternal(event));
    eventWrites.set(key, operation);
    void operation.finally(() => { if (eventWrites.get(key) === operation) eventWrites.delete(key); }).catch(() => undefined);
    return operation;
  }
  private async appendEventInternal(event: ResearchEvent): Promise<void> {
    await this.init();
    const file = path.join("projects", segment(event.projectId), "events.jsonl");
    await mkdir(path.join(this.root, path.dirname(file)), { recursive: true });
    let previous = "";
    try { previous = await this.readText(file); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const line of previous.split(/\r?\n/u).filter(Boolean)) if (JSON.parse(line).eventId === event.eventId) return;
    const next = `${previous}${JSON.stringify(event)}\n`;
    await this.writeText(file, next);
  }
  async listEvents(projectId: string, limit = 500): Promise<ResearchEvent[]> {
    try { const lines = (await this.readText(path.join("projects", segment(projectId), "events.jsonl"))).split(/\r?\n/).filter(Boolean); return lines.slice(-Math.max(1, limit)).flatMap((line) => { try { return [JSON.parse(line) as ResearchEvent]; } catch { return []; } }); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  /** Bounded, credential-free audit for bridge requests that may not belong to a project. */
  appendSecurityAudit(entry: Omit<ResearchSecurityAudit, "schema" | "auditId" | "at">, maxEntries = 2_000): Promise<void> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry.requestId) || !/^[a-z][a-z0-9-]{1,63}$/u.test(entry.action) || !["accepted", "rejected"].includes(entry.outcome) || (entry.projectId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry.projectId)) || (entry.reason !== undefined && !securityAuditReasons.includes(entry.reason))) throw new Error("Invalid research security audit entry");
    const key = path.join(this.root, "security-audit.jsonl");
    const now = Date.now();
    let window = securityAuditWindows.get(key);
    const suppressedRequests = window && now - window.startedAt >= 60_000 ? window.suppressed : 0;
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, count: 0, suppressed: 0 }; securityAuditWindows.set(key, window);
      if (securityAuditWindows.size > 1000) for (const [oldKey, oldWindow] of securityAuditWindows) if (now - oldWindow.startedAt >= 60_000) securityAuditWindows.delete(oldKey);
    }
    if (++window.count > 240) { window.suppressed++; return Promise.resolve(); }
    // Copy only the approved fields; never spread caller-owned payloads into the log.
    const record: ResearchSecurityAudit = { schema: "dsh-sci.research-security-audit.v1", auditId: randomUUID(), at: new Date(now).toISOString(), requestId: entry.requestId, action: entry.action, outcome: entry.outcome, ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.projectId ? { projectId: entry.projectId } : {}), ...(suppressedRequests ? { suppressedRequests } : {}) };
    const operation = (securityAuditWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      let previous = "";
      try { previous = await this.readText("security-audit.jsonl"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const lines = maxEntries === 1 ? [] : previous.split(/\r?\n/u).filter(Boolean).slice(-(maxEntries - 1));
      await this.writeText("security-audit.jsonl", [...lines, JSON.stringify(record)].join("\n") + "\n");
    });
    securityAuditWrites.set(key, operation);
    void operation.finally(() => { if (securityAuditWrites.get(key) === operation) securityAuditWrites.delete(key); }).catch(() => undefined);
    return operation;
  }
  async listSecurityAudits(limit = 2_000): Promise<ResearchSecurityAudit[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("security audit limit must be between 1 and 10000");
    try { return (await this.readText("security-audit.jsonl")).split(/\r?\n/u).filter(Boolean).slice(-limit).flatMap((line) => { try { const value = JSON.parse(line) as ResearchSecurityAudit; return value.schema === "dsh-sci.research-security-audit.v1" ? [value] : []; } catch { return []; } }); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async listProjects(limit = 100): Promise<ResearchProject[]> {
    try { const value = await this.readJson<{ projects?: ResearchProject[] }>(INDEX_FILE); return (value.projects ?? []).slice(-Math.max(1, limit)).reverse(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.init();
      const entries = await readdir(path.join(this.root, "projects"), { withFileTypes: true });
      const values = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.readProject(entry.name)));
      return values.filter((value): value is ResearchProject => Boolean(value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, limit));
    }
  }
  async listApprovalQueue(limit = 100): Promise<ResearchApprovalItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("approval queue limit must be an integer between 1 and 10000");
    const projects = await this.listProjects(10_000);
    const items: ResearchApprovalItem[] = [];
    for (const project of projects) {
      const plan = project.planId ? await this.readPlan(project.projectId, project.planId) : undefined;
      for (const task of plan?.tasks ?? []) if (task.status === "waiting-approval") items.push({ kind: "task", project, plan: plan!, task });
      const [experiments, runs] = await Promise.all([this.listExperiments(project.projectId), this.listExperimentRuns(project.projectId)]);
      for (const experiment of experiments) {
        if (experiment.planId && experiment.planId !== project.planId) continue;
        if (runs.some((run) => run.experimentId === experiment.experimentId)) continue;
        const task = plan?.tasks.find((task) => task.taskId === experiment.taskId);
        items.push({ kind: "experiment", project, task, experiment });
      }
    }
    const timestamp = (item: ResearchApprovalItem) => item.kind === "task" ? item.task.updatedAt : item.experiment.createdAt;
    return items.sort((a, b) => timestamp(a).localeCompare(timestamp(b))).slice(0, Math.max(1, limit));
  }
  async exportProject(projectId: string): Promise<{ project: ResearchProject; plan?: ResearchPlan; budget?: ResearchBudget; events: ResearchEvent[]; sources: ResearchSource[]; sourceContents: SourceContentSummary[]; sourceReads: SourceReadReceipt[]; searchLogs: ResearchSearchLog[]; evidenceReviews: ResearchEvidenceReview[]; sourceAcquisitions: SourceAcquisition[]; sourceRelations?: ResearchSourceRelation[]; designReviews?: ResearchDesignReview[]; hypotheses: ResearchHypothesis[]; experimentDesigns: ResearchExperimentDesign[]; codeBundles?: ResearchCodeBundle[]; codeReads?: ResearchCodeRead[]; codeReviews?: ResearchCodeReview[]; citations: ResearchCitation[]; claims: ResearchClaim[]; evidence: ResearchEvidenceLink[]; experiments: ExperimentDefinition[]; experimentRuns: ExperimentRun[]; artifacts: ResearchArtifact[]; evaluations: ResearchEvaluation[]; decisions?: ResearchDecision[]; reports: ResearchReport[]; reportReviews?: ResearchReportReview[] }> {
    const project = await this.readProject(projectId); if (!project) throw new Error(`research project not found: ${projectId}`);
    const plan = project.planId ? await this.readPlan(project.projectId, project.planId) : undefined;
    const [sources, citations, claims, evidence, experiments, experimentRuns, artifacts, evaluations, decisions, reports, reportReviews, hypotheses, experimentDesigns, codeBundles] = await Promise.all([this.listSources(projectId), this.listCitations(projectId), this.listClaims(projectId), this.listEvidenceLinks(projectId), this.listExperiments(projectId), this.listExperimentRuns(projectId), this.listArtifacts(projectId), this.listEvaluations(projectId), this.listDecisions(projectId), this.listReports(projectId), this.listReportReviews(projectId), this.listHypotheses(projectId), this.listExperimentDesigns(projectId), this.listCodeBundles(projectId)]);
    return { project, plan, budget: await this.readBudget(projectId), events: await this.listEvents(projectId, 10_000), sources, sourceContents: await this.listSourceContents(projectId), sourceReads: await this.listSourceReads(projectId), searchLogs: await this.listSearchLogs(projectId), evidenceReviews: await this.listEvidenceReviews(projectId), sourceAcquisitions: await this.listSourceAcquisitions(projectId), sourceRelations: await this.listSourceRelations(projectId), designReviews: await this.listDesignReviews(projectId), hypotheses, experimentDesigns, codeBundles, codeReads: await this.listCodeReads(projectId), codeReviews: await this.listCodeReviews(projectId), citations, claims, evidence, experiments, experimentRuns, artifacts, evaluations, decisions, reports, reportReviews };
  }

  private entityPath(projectId: string, collection: string, entityId: string): string { return path.join("projects", segment(projectId), collection, `${segment(entityId)}.json`); }
  private async listEntities<T>(projectId: string, collection: string): Promise<T[]> {
    await this.assertCompatible();
    try {
      const entries = await readdir(path.join(this.root, "projects", segment(projectId), collection), { withFileTypes: true });
      const values = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => this.readOptionalJson<T>(path.join("projects", segment(projectId), collection, entry.name))));
      return values.filter(Boolean) as T[];
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async listRootEntities<T>(collection: string): Promise<T[]> {
    await this.assertCompatible();
    try {
      const entries = await readdir(path.join(this.root, collection), { withFileTypes: true });
      const values = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => this.readOptionalJson<T>(path.join(collection, entry.name))));
      return values.filter(Boolean) as T[];
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private async updateIndex(project: ResearchProject): Promise<void> {
    const projects = (await this.listProjects(10_000)).filter((item) => item.projectId !== project.projectId);
    await this.writeJson(INDEX_FILE, { schema: "dsh-sci.research-project-index.v1", projects: [...projects.reverse(), project].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-10_000) });
  }
  private async writeJson(relative: string, value: unknown): Promise<void> {
    // serializeMetadataJson already applies the metadata envelope. Do not pass
    // it through writeText, which would wrap the envelope a second time.
    await this.writeRawText(relative, serializeMetadataJson(value, this.metadataPassphrase));
  }
  private async readJson<T>(relative: string): Promise<T> { await this.assertCompatible(); return parseMetadataJson<T>(await readFile(path.join(this.root, relative), "utf8"), this.metadataPassphrase); }
  private async readOptionalJson<T>(relative: string): Promise<T | undefined> { try { return await this.readJson<T>(relative); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  private async readText(relative: string): Promise<string> { await this.assertCompatible(); const { decryptMetadataText } = await import("../metadata-crypto.js"); return decryptMetadataText(await readFile(path.join(this.root, relative), "utf8"), this.metadataPassphrase); }
  private async writeText(relative: string, value: string): Promise<void> {
    const { encryptMetadataText } = await import("../metadata-crypto.js");
    await this.writeRawText(relative, this.metadataPassphrase ? encryptMetadataText(value, this.metadataPassphrase) : value);
  }
  private async writeRawText(relative: string, value: string): Promise<void> {
    await this.init();
    const target = path.join(this.root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, "utf8");
    await rename(temporary, target);
  }
}
