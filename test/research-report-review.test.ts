import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { generateResearchReport, reportContentHash, type ResearchReportInput } from "../src/research/report.js";
import { makeResearchEvaluation } from "../src/research/evaluation.js";
import { contentDigest } from "../src/research/content-digest.js";
import { planCommitHash, type ResearchPlanCommit } from "../src/research/plan-commit.js";

test("report review binds the exact report and becomes stale after upstream memory evidence changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-report-review-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Report review binding", { plan: { question: "Report review binding", tasks: [{ taskId: "r", title: "Report", objective: "Write report", kind: "report" }] } });
    const report = await orchestrator.generateReport(project.projectId);
    await assert.rejects(() => orchestrator.reviewReport(project.projectId, report.reportId, { reportContentHash: report.contentHash, status: "accepted", note: "The empty report must remain a draft." }), /blocking evidence warnings/);
    const review = await orchestrator.reviewReport(project.projectId, report.reportId, { reportContentHash: report.contentHash, status: "changes-requested", note: "Add evidence before review." });
    assert.equal(review.actor, "trusted-workspace");
    assert.equal((await orchestrator.currentReportReviews(project.projectId, report.reportId))[0].current, true);
    assert.equal((await orchestrator.readReport(project.projectId, report.reportId)).reviewStatus, "draft");

    await orchestrator.remember(project.projectId, { text: "Mean is preferred under the primary condition.", kind: "claim", conflictKey: "primary-conclusion" });
    await orchestrator.remember(project.projectId, { text: "Median is preferred under the primary condition.", kind: "claim", conflictKey: "primary-conclusion" });
    assert.equal((await orchestrator.currentReportReviews(project.projectId, report.reportId))[0].current, false);
    await assert.rejects(() => orchestrator.reviewReport(project.projectId, report.reportId, { reportContentHash: report.contentHash, status: "accepted" }), /upstream evidence changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("report quality gate keeps unsupported conclusions as draft and exports visible blockers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-report-quality-gate-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Report quality gate", { plan: { question: "Report quality gate", tasks: [{ taskId: "report", title: "Report", objective: "Write a report", kind: "report" }] } });
    const source = await orchestrator.addSource(project.projectId, { title: "Unverified fixture", url: "https://example.test/unverified" });
    const citation = await orchestrator.addCitation(project.projectId, source.sourceId, { locator: "p. 1", quotedText: "Unsupported fixture" });
    const claim = await orchestrator.addClaim(project.projectId, { text: "The fixture proves the conclusion", citationIds: [citation.citationId], claimType: "conclusion" });
    await orchestrator.addEvidence(project.projectId, { claimId: claim.claimId, citationId: citation.citationId, relation: "supports" });
    const report = await orchestrator.generateReport(project.projectId);
    assert.ok(report.qualityIssues?.some((issue) => issue.code === "invalid-citation"));
    assert.ok(report.qualityIssues?.some((issue) => issue.code === "unreviewed-evidence"));
    await assert.rejects(() => orchestrator.reviewReport(project.projectId, report.reportId, { reportContentHash: report.contentHash, status: "accepted", note: "Cannot accept unsupported fixture." }), /blocking evidence warnings/);
    const context = await orchestrator.reportReviewContext(project.projectId, report.reportId);
    assert.equal(context.status, "draft"); assert.equal(context.canAccept, false); assert.ok(context.blockers.length > 0);
    const exported = await orchestrator.exportReport(project.projectId, report.reportId);
    assert.equal(exported.status, "draft"); assert.match(exported.markdown, /DRAFT/); assert.match(exported.html, /data-report-status="draft"/);
    const requested = await orchestrator.reviewReport(project.projectId, report.reportId, { reportContentHash: report.contentHash, status: "changes-requested", note: "Collect and review saved source content." });
    assert.equal(requested.status, "changes-requested");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fully supported source claim can be accepted and remains accepted after read-only export", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-report-accept-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Accept a reviewed source report", { plan: { question: "Accept a reviewed source report", tasks: [{ taskId: "report", title: "Report", objective: "Write a report", kind: "report" }] } });
    const file = path.join(root, "source.txt");
    await writeFile(file, "The measured fixture supports the bounded claim.", "utf8");
    const acquired = await orchestrator.ingestDocument(project.projectId, file);
    await orchestrator.activatePlan(project.projectId);
    await orchestrator.startNextTask(project.projectId);
    const read = await orchestrator.readSource(project.projectId, { sourceId: acquired.source.sourceId }, "agent");
    const citation = await orchestrator.addCitation(project.projectId, acquired.source.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "The measured fixture supports the bounded claim." });
    const claim = await orchestrator.addClaim(project.projectId, { text: "The measured fixture supports the bounded claim", citationIds: [citation.citationId], claimType: "observation" });
    const evidence = await orchestrator.addEvidence(project.projectId, { claimId: claim.claimId, citationId: citation.citationId, relation: "supports" });
    const evidenceContext = await orchestrator.evidenceReviewContext(project.projectId, evidence.evidenceId);
    await orchestrator.reviewEvidence(project.projectId, evidence.evidenceId, { binding: evidenceContext.binding, status: "supported", note: "The saved content and locator support the bounded observation." });
    const report = await orchestrator.generateReport(project.projectId);
    assert.equal(report.qualityIssues?.filter((issue) => /citation|evidence|claim/u.test(issue.code)).length, 0);
    const review = await orchestrator.reviewReport(project.projectId, report.reportId, { reportContentHash: report.contentHash, status: "accepted", note: "Reviewed source content, locator and bounded observation." });
    assert.equal(review.status, "accepted");
    const context = await orchestrator.reportReviewContext(project.projectId, report.reportId);
    assert.equal(context.status, "reviewed"); assert.equal(context.canAccept, true);
    const before = await fileSnapshot(root);
    const exported = await orchestrator.exportReport(project.projectId, report.reportId);
    assert.equal(exported.status, "reviewed"); assert.match(exported.markdown, /Reviewed research report/);
    assert.match(exported.html, /data-report-status="reviewed"/); assert.doesNotMatch(exported.html, /DRAFT \/ 草稿/);
    assert.deepEqual(await fileSnapshot(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fileSnapshot(root: string) {
  const result: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const file = path.join(root, name);
    if ((await stat(file)).isFile()) result[name] = (await readFile(file)).toString("base64");
  }
  return result;
}

async function supportedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-report-boundaries-"));
  const repository = new ResearchRepository(root), orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject("Bounded source report", { plan: { question: "Bounded source report", tasks: [{ taskId: "report", title: "Report", objective: "Report the bounded finding", kind: "report" }] } });
  const file = path.join(root, "source.txt");
  await writeFile(file, "The bounded observation is recorded here.");
  const { source } = await orchestrator.ingestDocument(project.projectId, file);
  const body = (await repository.readSourceContent(project.projectId, source.latestContentVersionId!))!;
  const citation = await orchestrator.addCitation(project.projectId, source.sourceId, { locator: { chunkId: body.chunks[0].chunkId }, quotedText: body.text });
  const claim = await orchestrator.addClaim(project.projectId, { text: "The bounded observation is recorded", citationIds: [citation.citationId], claimType: "observation" });
  const evidence = await orchestrator.addEvidence(project.projectId, { claimId: claim.claimId, citationId: citation.citationId, relation: "supports" });
  const context = await orchestrator.evidenceReviewContext(project.projectId, evidence.evidenceId);
  await orchestrator.reviewEvidence(project.projectId, evidence.evidenceId, { binding: context.binding, status: "supported", note: "Synthetic fixture: the quote directly supports the limited observation." });
  await orchestrator.activatePlan(project.projectId); await orchestrator.startNextTask(project.projectId);
  const report = await orchestrator.generateReport(project.projectId);
  return { root, repository, orchestrator, project, report, source, body, citation, claim, evidence, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("report task completion preserves report freshness and a previous-plan report cannot complete it", async () => {
  const f = await supportedFixture();
  try {
    const wrongPlan = { ...f.report, reportId: "report-foreign-plan", planId: "old-plan" }; wrongPlan.contentHash = reportContentHash(wrongPlan);
    await f.repository.saveReport(wrongPlan);
    await assert.rejects(() => f.orchestrator.completeTask(f.project.projectId, "report", [wrongPlan.reportId]), /missing required outputs: report/);
    await f.orchestrator.completeTask(f.project.projectId, "report", [f.report.reportId]);
    assert.equal((await f.orchestrator.reportReviewContext(f.project.projectId, f.report.reportId)).stale, false);
    await f.orchestrator.reviewReport(f.project.projectId, f.report.reportId, { reportContentHash: f.report.contentHash, status: "accepted", note: "Synthetic fixture reviewed after its report task completed." });
    assert.equal((await f.orchestrator.exportReport(f.project.projectId, f.report.reportId)).status, "reviewed");
  } finally { await f.cleanup(); }
});

test("latest report review wins and retries recover one missing audit event without duplicate reviews", async () => {
  const f = await supportedFixture();
  try {
    const input = { reportContentHash: f.report.contentHash, status: "accepted" as const, note: "Synthetic fixture acceptance." };
    const append = f.repository.appendEvent.bind(f.repository);
    let fail = true;
    f.repository.appendEvent = async (event) => { if (event.type === "report-reviewed" && fail) { fail = false; throw new Error("injected review event failure"); } return append(event); };
    await assert.rejects(() => f.orchestrator.reviewReport(f.project.projectId, f.report.reportId, input), /injected review event failure/);
    const stored = (await f.repository.listReportReviews(f.project.projectId))[0];
    const retried = await f.orchestrator.reviewReport(f.project.projectId, f.report.reportId, input);
    assert.equal(retried.reviewId, stored.reviewId);
    await f.orchestrator.reviewReport(f.project.projectId, f.report.reportId, input);
    assert.equal((await f.repository.listReportReviews(f.project.projectId)).length, 1);
    assert.equal((await f.repository.listEvents(f.project.projectId)).filter((event) => event.type === "report-reviewed").length, 1);
    for (const status of ["rejected", "changes-requested"] as const) {
      await f.orchestrator.reviewReport(f.project.projectId, f.report.reportId, { ...input, status, note: `Synthetic fixture later ${status}.` });
      assert.equal((await f.orchestrator.reportReviewContext(f.project.projectId, f.report.reportId)).status, status);
      assert.match((await f.orchestrator.exportReport(f.project.projectId, f.report.reportId)).markdown, /DRAFT/);
    }
    assert.equal((await f.repository.readReport(f.project.projectId, f.report.reportId))!.contentHash, f.report.contentHash);
  } finally { await f.cleanup(); }
});

test("report snapshots reject overwrite and corruption while unhashed legacy reports remain read-only drafts", async () => {
  const f = await supportedFixture();
  try {
    const changed = { ...f.report, markdown: "changed" }; changed.contentHash = reportContentHash(changed);
    await assert.rejects(() => f.repository.saveReport(changed), /immutable/);
    const file = path.join(f.root, "projects", f.project.projectId, "reports", `${f.report.reportId}.json`);
    await writeFile(file, JSON.stringify({ ...f.report, markdown: "corrupted" }));
    await assert.rejects(() => f.repository.readReport(f.project.projectId, f.report.reportId), /hash mismatch/);
    await assert.rejects(() => f.orchestrator.exportReport(f.project.projectId), /hash mismatch/);
    const legacy = { ...f.report, contentHash: undefined, html: "<p>Legacy snapshot without a heading</p>", reviewStatus: "reviewed" };
    await writeFile(file, JSON.stringify(legacy));
    const before = await fileSnapshot(f.root);
    const context = await f.orchestrator.reportReviewContext(f.project.projectId, f.report.reportId);
    assert.equal(context.stale, true); assert.equal(context.canAccept, false); assert.equal(context.status, "stale");
    const exported = await f.orchestrator.exportReport(f.project.projectId, f.report.reportId);
    assert.match(exported.html, /data-report-status="stale"/); assert.match(exported.markdown, /DRAFT/);
    await assert.rejects(() => f.orchestrator.reviewReport(f.project.projectId, f.report.reportId, { reportContentHash: f.report.contentHash, status: "accepted", note: "Cannot review a legacy unbound snapshot." }), /regeneration/);
    assert.deepEqual(await fileSnapshot(f.root), before);
  } finally { await f.cleanup(); }
});

test("read-only report context and export leave a prepared plan journal unrecovered", async () => {
  const f = await supportedFixture();
  try {
    const beforeProject = (await f.repository.readProject(f.project.projectId))!, beforePlan = (await f.repository.readPlan(f.project.projectId, beforeProject.planId!))!;
    const nextPlan = { ...beforePlan, planId: "next-plan", status: "draft" as const, tasks: beforePlan.tasks.map((task) => ({ ...task, planId: "next-plan", status: "pending" as const })) };
    const commit: ResearchPlanCommit = { schema: "dsh-sci.research-plan-commit.v1", commitId: contentDigest({ projectId: f.project.projectId, beforePlanId: beforePlan.planId, nextPlanId: nextPlan.planId }), projectId: f.project.projectId, status: "prepared", beforeProject, beforePlan, nextProject: { ...beforeProject, planId: nextPlan.planId, iteration: beforeProject.iteration + 1 }, nextPlan, events: [{ schema: "dsh-sci.research-event.v1", eventId: "pending-plan-created", projectId: f.project.projectId, planId: nextPlan.planId, type: "plan-created", at: new Date().toISOString() }], contentHash: "" };
    const { contentHash: _hash, ...body } = commit;
    commit.contentHash = planCommitHash(body); await f.repository.savePlanCommit(commit);
    const before = await fileSnapshot(f.root);
    const context = await f.orchestrator.reportReviewContext(f.project.projectId, f.report.reportId);
    assert.equal(context.canAccept, false); assert.ok(context.blockers.some((value) => /Pending research writes/u.test(value)));
    await f.orchestrator.exportReport(f.project.projectId, f.report.reportId);
    assert.deepEqual(await fileSnapshot(f.root), before);
    assert.equal((await f.repository.readProject(f.project.projectId))!.planId, beforePlan.planId);
  } finally { await f.cleanup(); }
});

test("report evidence anchors and source bindings retain each cited content version rather than the latest body", async () => {
  const f = await supportedFixture();
  try {
    const snapshot = await f.repository.exportProject(f.project.projectId);
    const original = snapshot.sourceContents[0];
    const newer = { ...original, contentVersionId: "content-newer", contentHash: "a".repeat(64) };
    const otherCitation = { ...f.citation, citationId: "citation-newer", contentVersionId: newer.contentVersionId, verification: { ...f.citation.verification!, contentHash: newer.contentHash } };
    const report = generateResearchReport({ ...snapshot, sources: snapshot.sources.map((item) => ({ ...item, latestContentVersionId: newer.contentVersionId })), sourceContents: [original, newer], citations: [f.citation, otherCitation] });
    assert.deepEqual(report.sourceBindings.map((item) => item.contentVersionId).sort(), [original.contentVersionId, newer.contentVersionId].sort());
    assert.equal(report.sourceBindings.find((item) => item.contentVersionId === original.contentVersionId)!.contentHash, original.contentHash);
    assert.match(report.html, new RegExp(`href="#citation-${f.citation.citationId}"`));
    assert.match(report.html, new RegExp(`id="source-${f.source.sourceId}"`));
    assert.ok(report.html.includes(f.body.text)); assert.ok(report.html.includes(f.citation.contentVersionId!));
    const noSecondCitation = generateResearchReport({ ...snapshot, sourceContents: [original, newer] });
    assert.equal(noSecondCitation.sourceBindings.length, 1); assert.equal(noSecondCitation.sourceBindings[0].contentVersionId, original.contentVersionId);
  } finally { await f.cleanup(); }
});

test("experiment report requires approved launch content, output provenance, design review and current evaluation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-report-run-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root, allowedCommands: [process.execPath] } });
    const { project } = await orchestrator.createProject("Synthetic experiment report", { plan: { question: "Synthetic experiment report", tasks: [
      { taskId: "h", title: "Hypothesis", objective: "Specify fixture", kind: "hypothesis" },
      { taskId: "d", title: "Design", objective: "Specify fixture design", kind: "experiment-design", dependsOn: ["h"] },
      { taskId: "x", title: "Run", objective: "Execute fixture", kind: "experiment", dependsOn: ["d"] },
      { taskId: "e", title: "Evaluate", objective: "Check fixture output", kind: "evaluate", dependsOn: ["x"] },
      { taskId: "r", title: "Report", objective: "Report fixture", kind: "report", dependsOn: ["e"] },
    ] } });
    const id = project.projectId;
    await orchestrator.activatePlan(id); await orchestrator.startNextTask(id);
    const hypothesis = await orchestrator.createHypothesis(id, { proposition: "The synthetic program writes 42", scope: "Temporary software fixture only", predictions: ["Output equals 42"], falsifiers: ["Output differs from 42"] });
    await orchestrator.completeTask(id, "h", [hypothesis.hypothesisId]); await orchestrator.startNextTask(id);
    const design = await orchestrator.createExperimentDesign(id, { hypothesisIds: [hypothesis.hypothesisId], dataDescription: "Deterministic software fixture", dataVersion: "v1", experimentalUnit: "one file", independentVariables: ["fixed program"], dependentVariables: ["output"], controls: ["fixed value"], primaryMetric: "output", repetitions: 1, randomization: "not applicable to fixture", missingDataHandling: "fail on missing file", analysisMethod: "exact equality", stoppingRule: "one execution" });
    await orchestrator.reviewExperimentDesign(id, design.designId, { contentHash: design.contentHash, status: "accepted", criteria: { hypothesisTestable: true, analysisUnitMatchesDesign: true, controlsAndComparisonAreAdequate: true, primaryMetricPreSpecified: true, repetitionCountJustified: true, analysisMethodAppropriate: true, stoppingRulePreSpecified: true }, note: "Synthetic software fixture only; no scientific conclusion." });
    await orchestrator.approveExperimentDesign(id, design.designId, design.contentHash);
    await orchestrator.completeTask(id, "d", [design.designId]); await orchestrator.startNextTask(id);
    const code = path.join(root, "fixture.cjs"), output = path.join(root, "output.txt");
    await writeFile(code, "require('node:fs').writeFileSync('output.txt','42');");
    const experiment = await orchestrator.createExperiment(id, { title: "Temporary fixture", taskId: "x", designId: design.designId, command: process.execPath, args: [code], codePaths: [code], outputPaths: [output], cwd: root });
    await orchestrator.approveExperiment(id, experiment.experimentId, experiment.proposalContentHash!);
    const run = await orchestrator.executeExperiment(id, experiment.experimentId, { approved: true }); assert.equal(run.state, "completed");
    const artifact = await orchestrator.registerArtifact(id, { path: output, kind: "table", experimentRef: run.runId });
    await orchestrator.completeTask(id, "x", [run.runId]); await orchestrator.startNextTask(id);
    const evaluation = await orchestrator.recordEvaluation(id, { planId: project.planId, taskId: "e", experimentRunIds: [run.runId], artifactIds: [artifact.artifactId], metrics: [{ name: "output", observed: 42 }], conclusion: "supports", summary: "The software fixture wrote 42", limitations: ["Synthetic software test only"] });
    await orchestrator.completeTask(id, "e", [evaluation.evaluationId]); await orchestrator.startNextTask(id);
    const claim = await orchestrator.addClaim(id, { text: "The synthetic software fixture wrote 42", claimType: "observation" });
    await orchestrator.addEvidence(id, { claimId: claim.claimId, artifactRef: artifact.artifactId, experimentRef: run.runId, relation: "supports" });
    const snapshot: ResearchReportInput = await repository.exportProject(id);
    const report = generateResearchReport(snapshot); assert.deepEqual(report.qualityIssues, []);
    assert.match(report.html, new RegExp(`href="#artifact-${artifact.artifactId}"`));
    await repository.saveReport(report);
    await orchestrator.reviewReport(id, report.reportId, { reportContentHash: report.contentHash, status: "accepted", note: "Synthetic software fixture provenance checked." });
    assert.equal((await orchestrator.reportReviewContext(id, report.reportId)).status, "reviewed");
    const variants: Array<[string, string, (value: ResearchReportInput) => void]> = [
      ["missing approval", "unconfirmed-run-evidence", (v) => { v.experiments![0].approval = undefined; }],
      ["undefined proposal hashes", "unconfirmed-run-evidence", (v) => { v.experiments![0].proposalContentHash = undefined; delete (v.experiments![0].approval as Partial<NonNullable<typeof experiment.approval>>).proposalContentHash; }],
      ["changed approved command", "unconfirmed-run-evidence", (v) => { v.experiments![0].args = ["different.cjs"]; }],
      ["changed launch code", "unconfirmed-run-evidence", (v) => { v.experimentRuns![0].manifest.code![0].sha256 = "a".repeat(64); }],
      ["changed launch command", "unconfirmed-run-evidence", (v) => { v.experimentRuns![0].manifest.args = ["different.cjs"]; }],
      ["same hash at another path", "unconfirmed-run-evidence", (v) => { v.artifacts![0].relativePath = "unrelated.txt"; v.artifacts![0].path = path.join(root, "unrelated.txt"); }],
      ["failed run", "unconfirmed-run-evidence", (v) => { v.experimentRuns![0].state = "failed"; }],
      ["interrupted run", "unfinished-run", (v) => { v.experimentRuns![0].state = "interrupted"; }],
      ["missing output", "unconfirmed-run-evidence", (v) => { v.experimentRuns![0].manifest.outputs = []; }],
      ["old plan evaluation", "missing-current-evaluation", (v) => { v.evaluations![0].planId = "old-plan"; }],
      ["missing evaluation", "missing-current-evaluation", (v) => { v.evaluations = []; }],
      ["missing design review", "unreviewed-experiment-design", (v) => { v.designReviews = []; }],
      ["stale hypothesis", "unreviewed-experiment-design", (v) => { v.hypotheses![0].status = "superseded"; }],
      ["only contextual evidence", "unsupported-claim", (v) => { v.evidence[0].relation = "context"; }],
      ["broken artifact link", "broken-evidence", (v) => { v.evidence[0].artifactRef = "missing-artifact"; }],
      ["eight-repeat uncertainty", "statistics-review", (v) => { v.evaluations = [makeResearchEvaluation(id, { ...evaluation, metrics: [{ name: "paired difference", pairedBootstrap: { differences: [1, 2, 3, 4, 5, 6, 7, 8], seed: 42, resamples: 1000 } }] })]; }],
    ];
    for (const [label, code, mutate] of variants) await t.test(label, () => {
      const changed = structuredClone(snapshot); mutate(changed);
      const draft = generateResearchReport(changed);
      assert.ok(draft.qualityIssues!.some((issue) => issue.code === code), `${label} must block acceptance`);
      assert.notEqual(draft.upstreamHash, report.upstreamHash); assert.equal(draft.reviewStatus, "draft");
    });
    await t.test("legacy absolute output paths still bind the exact file", () => {
      const legacy = structuredClone(snapshot); legacy.experimentRuns![0].manifest.outputs[0].relativePath = output;
      assert.deepEqual(generateResearchReport(legacy).qualityIssues, []);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

