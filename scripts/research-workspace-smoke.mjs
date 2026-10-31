import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const timeout = setTimeout(() => { console.error("Research Workspace smoke timed out"); app.exit(1); }, 30_000);
let root;
let window;
try {
  await app.whenReady();
  const [{ ResearchRepository }, { ResearchOrchestrator }, { renderResearchDashboard }] = await Promise.all([
    import("../dist/src/research/repository.js"),
    import("../dist/src/research/orchestrator.js"),
    import("../desktop/research-dashboard.mjs"),
  ]);
  root = await mkdtemp(path.join(tmpdir(), "dsh-sci-workspace-smoke-"));
  const repository = new ResearchRepository(root);
  const orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject("Compare preprocessing methods");
  const approvalProject = await orchestrator.createProject("Approve a reproducible experiment", { plan: { question: "Approve a reproducible experiment", tasks: [{ taskId: "approved-task", title: "Run comparison", objective: "Execute after approval", requiresApproval: true }] } });
  await orchestrator.activatePlan(approvalProject.project.projectId);
  await orchestrator.startNextTask(approvalProject.project.projectId);
  const approvalCode = path.join(root, "approved-run.cjs"), approvalInput = path.join(root, "approved-input.txt"), launchMarker = path.join(root, "workspace-run-marker.txt");
  const approvalCodeText = "const fs=require('node:fs');fs.writeFileSync('workspace-run-marker.txt',fs.readFileSync('approved-input.txt'));console.log(42);\n// <img src=x onerror=window.codeInjected=true>\n";
  await writeFile(approvalCode, approvalCodeText);
  await writeFile(approvalInput, "frozen-ui-input\n");
  const approvalExperiment = await orchestrator.createExperiment(approvalProject.project.projectId, { title: "<img src=x onerror=window.injected=true> Sample count", taskId: "approved-task", command: "node", args: [approvalCode], codePaths: [approvalCode], inputPaths: [approvalInput], outputPaths: [launchMarker], cwd: root });
  const report = await orchestrator.generateReport(project.projectId);
  const first = await orchestrator.remember(project.projectId, { kind: "claim", text: "<img src=x onerror=window.injected=true> Method A improves accuracy", confidence: "high", conflictKey: "comparison" });
  await orchestrator.remember(project.projectId, { kind: "claim", text: "Method B improves accuracy", confidence: "medium", conflictKey: "comparison" });
  await orchestrator.activatePlan(project.projectId);
  await orchestrator.prepareTaskExecution(project.projectId);
  const requestId = await repository.reserveModelRequest(project.projectId, { phase: "planner" });
  await repository.recordModelUsage(project.projectId, requestId, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  const originalBudget = await repository.readBudget(project.projectId);
  const budgetedProject = await orchestrator.pause(project.projectId);
  const sourceFile = path.join(root, "source.txt");
  await writeFile(sourceFile, "<img src=x onerror=window.sourceInjected=true> Method A reduces error in condition X.");
  const acquired = await orchestrator.ingestDocument(project.projectId, sourceFile);
  const relatedSource = await orchestrator.addSource(project.projectId, { kind: "paper", title: "Formal version", url: "https://example.test/formal-version" });
  const designProject = await orchestrator.createProject("Design review UI fixture", { plan: { question: "Design review UI fixture", tasks: [
    { taskId: "h", title: "Hypothesis", objective: "Propose a falsifiable hypothesis", kind: "hypothesis" },
    { taskId: "d", title: "Design", objective: "Propose a reviewable design", kind: "experiment-design", dependsOn: ["h"] },
  ] } });
  await orchestrator.activatePlan(designProject.project.projectId);
  await orchestrator.startNextTask(designProject.project.projectId);
  const designHypothesis = await orchestrator.createHypothesis(designProject.project.projectId, { proposition: "<img src=x onerror=window.designInjected=true> Method A reduces error", scope: "Synthetic UI fixture only", predictions: ["Lower paired error"], falsifiers: ["No lower paired error"] });
  await orchestrator.completeTask(designProject.project.projectId, "h", [designHypothesis.hypothesisId]);
  await orchestrator.startNextTask(designProject.project.projectId);
  const candidateDesign = await orchestrator.createExperimentDesign(designProject.project.projectId, { hypothesisIds: [designHypothesis.hypothesisId], dataDescription: "UI fixture", dataVersion: "v1", experimentalUnit: "paired dataset", independentVariables: ["method"], dependentVariables: ["error"], controls: ["same mask"], primaryMetric: "paired error", repetitions: 100, randomization: "fixed seeds", missingDataHandling: "shared mask", analysisMethod: "paired interval", stoppingRule: "all 100 repetitions" });
  const version = await repository.readSourceContent(project.projectId, acquired.source.latestContentVersionId);
  const citation = await orchestrator.addCitation(project.projectId, acquired.source.sourceId, { locator: { chunkId: version.chunks[0].chunkId }, quotedText: "Method A reduces error in condition X." });
  const sourceClaim = await orchestrator.addClaim(project.projectId, { text: "Method A reduces error in condition X", citationIds: [citation.citationId] });
  const sourceEvidence = await orchestrator.addEvidence(project.projectId, { claimId: sourceClaim.claimId, citationId: citation.citationId, relation: "supports" });
  await orchestrator.remember(project.projectId, { kind: "observation", text: "Bounded source observation for provenance UI", confidence: "medium", refs: [citation.citationId], applicability: "<img src=x onerror=window.memoryScopeInjected=true> Synthetic condition X only" });
  // Separate synthetic report-only project: approvals here never touch a real case.
  const reportProject = await orchestrator.createProject("Report review UI fixture", { plan: { question: "Report review UI fixture", tasks: [{ taskId: "report", title: "Report", objective: "Review the bounded source observation", kind: "report" }] } });
  const reportSourceFile = path.join(root, "report-source.txt");
  await writeFile(reportSourceFile, "The UI fixture records one bounded observation.");
  const reportSource = await orchestrator.ingestDocument(reportProject.project.projectId, reportSourceFile);
  const reportBody = await repository.readSourceContent(reportProject.project.projectId, reportSource.source.latestContentVersionId);
  const reportCitation = await orchestrator.addCitation(reportProject.project.projectId, reportSource.source.sourceId, { locator: { chunkId: reportBody.chunks[0].chunkId }, quotedText: reportBody.text });
  const reportClaim = await orchestrator.addClaim(reportProject.project.projectId, { text: "The UI fixture records one bounded observation", citationIds: [reportCitation.citationId], claimType: "observation" });
  const reportEvidence = await orchestrator.addEvidence(reportProject.project.projectId, { claimId: reportClaim.claimId, citationId: reportCitation.citationId, relation: "supports" });
  await orchestrator.generateReport(reportProject.project.projectId);
  window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: fileURLToPath(new URL("../desktop/research-preload.cjs", import.meta.url)) } });
  const authorized = (event) => assert.equal(event.sender, window.webContents);
  ipcMain.handle("research:export", (event, id) => { authorized(event); return repository.exportProject(id); });
  ipcMain.handle("research:source-read", (event, input) => { authorized(event); return orchestrator.readSource(input.projectId, input, "workspace"); });
  ipcMain.handle("research:evidence-review-context", (event, input) => { authorized(event); return orchestrator.evidenceReviewContext(input.projectId, input.evidenceId); });
  ipcMain.handle("research:evidence-review", (event, input) => { authorized(event); return orchestrator.reviewEvidence(input.projectId, input.evidenceId, input); });
  ipcMain.handle("research:relate-sources", (event, input) => { authorized(event); return orchestrator.relateSources(input.projectId, input); });
  ipcMain.handle("research:memory-conflicts", (event, id) => { authorized(event); return orchestrator.listMemoryConflicts(id); });
  ipcMain.handle("research:security-audits", (event, limit) => { authorized(event); return repository.listSecurityAudits(limit); });
  ipcMain.handle("research:memory-review", (event, input) => { authorized(event); return orchestrator.reviewMemoryConflict(input.projectId, input); });
  ipcMain.handle("research:memory-review-batch", (event, input) => { authorized(event); return orchestrator.reviewMemoryConflicts(input.projectId, input.reviews); });
  ipcMain.handle("research:memory-search", (event, { query, ...options }) => { authorized(event); return orchestrator.searchMemory(query, options); });
  let failMemoryRebuild = false;
  ipcMain.handle("research:memory-index-rebuild", (event, id) => { authorized(event); if (failMemoryRebuild) throw new Error("Synthetic embedding service unavailable"); return orchestrator.rebuildMemoryIndex(id); });
  ipcMain.handle("research:approval-queue", (event) => { authorized(event); return orchestrator.listApprovalQueue(); });
  ipcMain.handle("research:approve", (event, input) => { authorized(event); return orchestrator.approveTask(input.projectId, input.taskId); });
  ipcMain.handle("research:execute-experiment", (event, input) => { authorized(event); return orchestrator.executeExperiment(input.projectId, input.experimentId, { approved: input.approved === true }); });
  ipcMain.handle("research:approve-experiment", (event, input) => { authorized(event); return orchestrator.approveExperiment(input.projectId, input.experimentId, input.contentHash); });
  ipcMain.handle("research:experiment-review", (event, input) => { authorized(event); return orchestrator.experimentReview(input.projectId, input.experimentId); });
  ipcMain.handle("research:approve-experiment-design", (event, input) => { authorized(event); return orchestrator.approveExperimentDesign(input.projectId, input.designId, input.contentHash); });
  ipcMain.handle("research:review-experiment-design", (event, input) => { authorized(event); return orchestrator.reviewExperimentDesign(input.projectId, input.designId, input); });
  ipcMain.handle("research:report-read", (event, input) => { authorized(event); return orchestrator.readReport(input.projectId, input.reportId); });
  ipcMain.handle("research:report-review-context", (event, input) => { authorized(event); return orchestrator.reportReviewContext(input.projectId, input.reportId); });
  ipcMain.handle("research:report-review", (event, input) => { authorized(event); return orchestrator.reviewReport(input.projectId, input.reportId, input); });
  let reportExported;
  ipcMain.handle("research:report-export", async (event, input) => { authorized(event); const result = await orchestrator.exportReport(input.projectId, input.reportId); reportExported?.(result); return result; });
  ipcMain.handle("research:budget-read", (event, id) => { authorized(event); return repository.readBudget(id); });
  ipcMain.handle("research:budget-update", (event, input) => { authorized(event); return orchestrator.updateBudget(input.projectId, input.limits); });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(renderResearchDashboard({ projects: [budgetedProject, approvalProject.project, designProject.project, reportProject.project] })));
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const card = document.querySelector('.project');
    const observer = new MutationObserver(() => { if (card.querySelector('.budget-form')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Budget form did not load')); }, 5000);
    observer.observe(card, { childList: true, subtree: true });
    card.querySelector('[data-action="budget"]').click();
  })`);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.budget-panel');
    const form = panel.querySelector('.budget-form');
    form.elements.maxTaskExecutions.value = '101';
    form.elements.maxWallTimeSeconds.value = '7200';
    form.elements.maxModelRequests.value = '200';
    form.elements.maxModelTokens.value = '2000000';
    const observer = new MutationObserver(() => { if (panel.textContent.includes('预算已保存')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Budget did not save: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true });
    form.requestSubmit();
  })`);
  const persistedBudget = await new ResearchRepository(root).readBudget(project.projectId);
  assert.equal(persistedBudget.usedTaskExecutions, 1);
  assert.equal(persistedBudget.startedAt, originalBudget.startedAt);
  assert.equal(persistedBudget.maxTaskExecutions, 101);
  assert.equal(persistedBudget.maxWallTimeMs, 7_200_000);
  assert.equal(persistedBudget.maxModelRequests, 200);
  assert.equal(persistedBudget.maxModelTokens, 2_000_000);
  assert.equal(persistedBudget.usedModelRequests, 1);
  assert.equal(persistedBudget.reportedTotalTokens, 5);
  assert.equal((await repository.readProject(project.projectId)).status, "paused");
  assert.equal((await repository.listEvents(project.projectId)).filter((event) => event.type === "research-budget-updated").length, 1);
  // Resolve on DOM changes instead of relying on a machine-dependent fixed delay.
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.memory-panel');
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Review form did not load')); }, 5000);
    const observer = new MutationObserver(() => { if (panel.querySelector('.memory-review-form')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    observer.observe(panel, { childList: true, subtree: true });
    document.querySelector('[data-action="review-conflicts"]').click();
  })`);
  const initial = await window.webContents.executeJavaScript(`({ entries: document.querySelectorAll('.conflict-entries .memory-entry').length, injected: Boolean(window.injected), htmlImages: document.querySelectorAll('.memory-panel img').length })`);
  assert.equal(initial.entries, 2);
  assert.equal(initial.injected, false);
  assert.equal(initial.htmlImages, 0);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.memory-panel');
    const batchForm = panel.querySelector('.memory-review-batch-form');
    const group = panel.querySelector('.conflict-group');
    const form = group.querySelector('.memory-review-form');
    batchForm.querySelector('select').value = 'accepted';
    const selected = [...form.querySelectorAll('input[type="radio"]')].find((input) => input.parentElement.textContent.includes('可信度：high'));
    if (!selected) throw new Error('High-confidence conflict entry was not rendered');
    selected.checked = true;
    batchForm.querySelector('input[name="note"]').value = 'Reviewed benchmark evidence';
    const observer = new MutationObserver(() => { if (panel.textContent.includes('审阅状态：accepted')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(document.getElementById('notice').textContent || 'Review did not save')); }, 5000);
    observer.observe(panel, { childList: true, subtree: true });
    batchForm.requestSubmit();
  })`);
  const reopened = new ResearchOrchestrator(new ResearchRepository(root));
  const reopenedConflicts = await reopened.listMemoryConflicts(project.projectId);
  assert.equal(reopenedConflicts[0].reviewStatus, "accepted");
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const form = document.getElementById('memory-search-form');
    const output = document.getElementById('memory-search-results');
    form.elements.query.value = 'accuracy';
    form.elements.projectId.value = ${JSON.stringify(project.projectId)};
    form.elements.minConfidence.value = 'high';
    const observer = new MutationObserver(() => { if (output.textContent.includes('找到')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Memory search did not return: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(output, { childList: true, subtree: true });
    setTimeout(() => form.requestSubmit(), 100);
  })`);
  const searchCount = await window.webContents.executeJavaScript("document.querySelectorAll('#memory-search-results .memory-entry').length");
  assert.equal(searchCount, 1);
  const indexCountBefore = (await repository.listMemoryIndexVersions()).length;
  await window.webContents.executeJavaScript(`document.getElementById('memory-search-form').elements.projectId.value = ''; document.getElementById('memory-index-rebuild').click();`);
  assert.match(await window.webContents.executeJavaScript("document.getElementById('memory-index-status').textContent"), /请先选择/);
  assert.equal((await repository.listMemoryIndexVersions()).length, indexCountBefore);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const status = document.getElementById('memory-index-status');
    const observer = new MutationObserver(() => { if (status.textContent.includes('索引已重建')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Memory rebuild did not finish')); }, 5000);
    observer.observe(status, { childList: true, subtree: true });
    document.getElementById('memory-search-form').elements.projectId.value = ${JSON.stringify(project.projectId)};
    document.getElementById('memory-index-rebuild').click();
  })`);
  assert.match(await window.webContents.executeJavaScript("document.getElementById('memory-index-status').textContent"), /本地词法\/哈希基线/);
  const savedIndexIds = (await repository.listMemoryIndexVersions()).map((index) => index.indexId);
  failMemoryRebuild = true;
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const status = document.getElementById('memory-index-status');
    const observer = new MutationObserver(() => { if (status.textContent.includes('索引重建失败')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Memory rebuild failure was not displayed')); }, 5000);
    observer.observe(status, { childList: true, subtree: true });
    document.getElementById('memory-index-rebuild').click();
  })`);
  assert.deepEqual((await repository.listMemoryIndexVersions()).map((index) => index.indexId), savedIndexIds);
  failMemoryRebuild = false;
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const form = document.getElementById('memory-search-form'); const output = document.getElementById('memory-search-results');
    form.elements.query.value = 'Bounded source observation'; form.elements.minConfidence.value = 'medium';
    const observer = new MutationObserver(() => { if (output.querySelector('.memory-source-binding')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Memory provenance was not rendered')); }, 5000);
    observer.observe(output, { childList: true, subtree: true }); form.requestSubmit();
  })`);
  const memoryProvenance = await window.webContents.executeJavaScript(`({ text: document.getElementById('memory-search-results').textContent, warnings: document.querySelectorAll('#memory-search-results .memory-warnings li').length, injected: Boolean(window.memoryScopeInjected), images: document.querySelectorAll('#memory-search-results img').length })`);
  assert.match(memoryProvenance.text, /Synthetic condition X only/);
  assert.ok(memoryProvenance.text.includes(version.contentVersionId));
  assert.ok(memoryProvenance.warnings > 0);
  assert.equal(memoryProvenance.injected, false); assert.equal(memoryProvenance.images, 0);
  const securityAuditButton = await window.webContents.executeJavaScript("document.getElementById('security-audit') !== null");
  assert.equal(securityAuditButton, true);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const output = document.getElementById('security-audit-output');
    const observer = new MutationObserver(() => { if (!output.hidden) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Security audit panel did not load')); }, 5000);
    observer.observe(output, { attributes: true }); document.getElementById('security-audit').click();
  })`);
  assert.match(await window.webContents.executeJavaScript("document.getElementById('security-audit-output').textContent"), /暂无安全审计记录/);
  await repository.appendSecurityAudit({ requestId: "synthetic-auth-refusal", action: "unknown", outcome: "rejected", reason: "authentication" });
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const output = document.getElementById('security-audit-output');
    const observer = new MutationObserver(() => { if (output.textContent.includes('authentication')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Security audit record was not displayed')); }, 5000);
    observer.observe(output, { childList: true }); document.getElementById('security-audit').click();
  })`);
  console.log(JSON.stringify({ securityAuditViewer: true, securityAuditEmptyState: true, securityAuditRefusalDisplayed: true, scientificQuality: "not-reviewed; synthetic UI fixture" }));
  console.log(JSON.stringify({ memoryProjectRebuild: true, memoryGlobalRebuildRefused: true, memoryRebuildFailurePreservesSnapshots: true, memoryApplicabilityVisible: true, memorySourceVersionVisible: true, memoryWarningsVisible: true, memoryMetadataEscaped: true, scientificQuality: "not-reviewed; synthetic UI fixture" }));
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.getElementById('approval-results');
    const observer = new MutationObserver(() => { if (panel.textContent.includes('待审批：2 项')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Approval queue did not load')); }, 5000);
    observer.observe(panel, { childList: true, subtree: true });
    document.getElementById('approval-project').value = ${JSON.stringify(approvalProject.project.projectId)};
    document.getElementById('load-approvals').click();
  })`);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('#approval-results img').length"), 0);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.getElementById('approval-results');
    const observer = new MutationObserver(() => { if (panel.textContent.includes('待审批：1 项')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Task approval did not save')); }, 5000);
    observer.observe(panel, { childList: true, subtree: true });
    [...panel.querySelectorAll('button')].find((button) => button.textContent === '批准此任务').click();
  })`);
  assert.equal((await repository.listExperimentRuns(approvalProject.project.projectId)).length, 0);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.approve-experiment').disabled"), true);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.getElementById('approval-results');
    const observer = new MutationObserver(() => { if (panel.querySelector('.experiment-content') && !panel.querySelector('.approve-experiment').disabled) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Code review did not load: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true, attributes: true }); panel.querySelector('.review-experiment').click();
  })`);
  const codeView = await window.webContents.executeJavaScript("({text:document.querySelector('.experiment-content').textContent,images:document.querySelectorAll('#approval-results img').length,injected:Boolean(window.codeInjected)})");
  assert.match(codeView.text, /writeFileSync/); assert.match(codeView.text, /frozen-ui-input/); assert.equal(codeView.images, 0); assert.equal(codeView.injected, false);
  await writeFile(approvalInput, "changed-after-preview\n");
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const notice = document.getElementById('notice');
    const observer = new MutationObserver(() => { if (notice.textContent.includes('changed')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Changed proposal was not refused')); }, 5000);
    observer.observe(notice, { childList: true, subtree: true }); document.querySelector('.approve-experiment').click();
  })`);
  assert.equal((await repository.listExperimentRuns(approvalProject.project.projectId)).length, 0);
  assert.equal((await repository.readExperiment(approvalProject.project.projectId, approvalExperiment.experimentId)).approval, undefined);
  await assert.rejects(() => access(launchMarker), { code: "ENOENT" });
  await writeFile(approvalInput, "frozen-ui-input\n");
  await window.webContents.executeJavaScript(`window.researchApi.approveExperiment({projectId:${JSON.stringify(approvalProject.project.projectId)},experimentId:${JSON.stringify(approvalExperiment.experimentId)},contentHash:${JSON.stringify(approvalExperiment.proposalContentHash)}})`);
  await writeFile(approvalCode, approvalCodeText + "// changed after approval\n");
  await assert.rejects(() => window.webContents.executeJavaScript(`window.researchApi.executeExperiment({projectId:${JSON.stringify(approvalProject.project.projectId)},experimentId:${JSON.stringify(approvalExperiment.experimentId)},approved:true})`), /changed|refused/);
  assert.equal((await repository.listExperimentRuns(approvalProject.project.projectId)).length, 0);
  await assert.rejects(() => access(launchMarker), { code: "ENOENT" });
  await writeFile(approvalCode, approvalCodeText);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.getElementById('approval-results');
    const observer = new MutationObserver(() => { if (panel.textContent.includes('待审批：0 项')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Experiment did not finish: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true });
    [...panel.querySelectorAll('button')].find((button) => button.textContent === '批准并执行此实验').click();
  })`);
  const runs = await repository.listExperimentRuns(approvalProject.project.projectId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "completed");
  assert.match(runs[0].stdout, /42/);
  assert.equal(await readFile(launchMarker, "utf8"), "frozen-ui-input\n");
  assert.deepEqual(runs[0].manifest.code, approvalExperiment.codeManifest);
  assert.deepEqual(runs[0].manifest.inputs, approvalExperiment.inputManifest);
  assert.ok((await repository.readExperiment(approvalProject.project.projectId, approvalExperiment.experimentId)).approval);
  const eventCount = (await repository.listEvents(project.projectId)).length;
  const savedReport = await window.webContents.executeJavaScript(`window.researchApi.readReport({projectId: ${JSON.stringify(project.projectId)}})`);
  assert.equal(savedReport.reportId, report.reportId);
  assert.equal((await repository.listEvents(project.projectId)).length, eventCount);
  assert.equal((await repository.listReports(project.projectId)).length, 1);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const card = document.querySelector('.project');
    const observer = new MutationObserver(() => { if (card.querySelector('.source-entry')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Source panel did not open')); }, 5000);
    observer.observe(card, { childList: true, subtree: true });
    card.querySelector('[data-action="sources"]').click();
  })`);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.sources-panel');
    const observer = new MutationObserver(() => { if (panel.querySelector('.source-text')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Source text did not load')); }, 5000);
    observer.observe(panel, { childList: true, subtree: true }); panel.querySelector('.read-source').click();
  })`);
  const sourceView = await window.webContents.executeJavaScript(`({ text: document.querySelector('.source-text').textContent, images: document.querySelectorAll('.sources-panel img').length, injected: Boolean(window.sourceInjected) })`);
  assert.match(sourceView.text, /Method A reduces error/); assert.equal(sourceView.images, 0); assert.equal(sourceView.injected, false);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.sources-panel');
    const observer = new MutationObserver(() => { if (panel.querySelector('.evidence-review-form')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Evidence review did not load: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true }); panel.querySelector('.open-evidence-review').click();
  })`);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.sources-panel'); const form = panel.querySelector('.evidence-review-form');
    form.elements.status.value = 'supported'; form.elements.note.value = 'Synthetic UI fixture: the limited condition X claim matches this quoted statement.';
    const observer = new MutationObserver(() => { if (panel.querySelector('.evidence-review-saved')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Evidence review did not save: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true }); form.requestSubmit();
  })`);
  const reviewContext = await new ResearchOrchestrator(new ResearchRepository(root)).evidenceReviewContext(project.projectId, sourceEvidence.evidenceId);
  assert.equal(reviewContext.reviews.length, 1); assert.equal(reviewContext.reviews[0].current, true);
  assert.equal(reviewContext.reviews[0].status, 'supported'); assert.equal(reviewContext.reviews[0].actor, 'trusted-workspace');
  assert.ok((await repository.listSourceReads(project.projectId)).every((read) => read.audience === 'workspace'));
  assert.equal((await repository.readSource(project.projectId, acquired.source.sourceId)).reading.status, 'discovered');
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.sources-panel'); const form = panel.querySelector('.source-relation-form');
    if (!form) throw new Error('Source relation form did not render');
    form.elements.fromSourceId.value = ${JSON.stringify(acquired.source.sourceId)};
    form.elements.toSourceId.value = ${JSON.stringify(relatedSource.sourceId)};
    form.elements.kind.value = 'preprint-of'; form.elements.countsAsIndependent.checked = false; form.elements.note.value = 'Workspace reviewed same work family';
    const observer = new MutationObserver(() => { if (panel.textContent.includes('preprint-of')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Source relation did not save: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true }); form.requestSubmit();
  })`);
  assert.equal((await repository.listSourceRelations(project.projectId)).length, 1);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const card = [...document.querySelectorAll('.project')].find((item) => item.dataset.project === ${JSON.stringify(designProject.project.projectId)});
    const observer = new MutationObserver(() => { if (card.querySelector('.approve-design')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Design panel did not open: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(card, { childList: true, subtree: true }); card.querySelector('[data-action="designs"]').click();
  })`);
  const designView = await window.webContents.executeJavaScript(`({ images: document.querySelectorAll('.designs-panel img').length, injected: Boolean(window.designInjected), text: document.querySelector('.designs-panel').textContent })`);
  assert.equal(designView.images, 0); assert.equal(designView.injected, false); assert.match(designView.text, /paired dataset/);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.designs-panel'); const form = panel.querySelector('.design-review-form');
    if (!form) throw new Error('Design quality review form did not render');
    for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) checkbox.checked = true;
    form.elements.note.value = 'Synthetic UI review: paired unit, prespecified endpoint, controls and stopping rule are explicit.';
    const observer = new MutationObserver(() => { if (panel.textContent.includes('质量审阅：accepted')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Design quality review did not save: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true }); form.requestSubmit();
  })`);
  const designReviews = await new ResearchRepository(root).listDesignReviews(designProject.project.projectId);
  assert.equal(designReviews.length, 1); assert.equal(designReviews[0].status, 'accepted');
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.designs-panel');
    const observer = new MutationObserver(() => { if (panel.textContent.includes('实验设计 · approved')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Design approval did not save: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(panel, { childList: true, subtree: true }); panel.querySelector('.approve-design').click();
  })`);
  const savedDesign = await new ResearchRepository(root).readExperimentDesign(designProject.project.projectId, candidateDesign.designId);
  assert.equal(savedDesign.status, 'approved'); assert.equal(savedDesign.contentHash, candidateDesign.contentHash); assert.ok(savedDesign.approvedAt);
  assert.equal((await repository.listExperimentRuns(designProject.project.projectId)).length, 0);
  const revisedDesign = await orchestrator.createExperimentDesign(designProject.project.projectId, { ...candidateDesign, dataVersion: "v2", supersedesDesignId: candidateDesign.designId, changeReason: "Synthetic revision to check expired review display" });
  // The successor alone must invalidate review display, including partial status updates.
  await repository.saveExperimentDesign(savedDesign);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const card = [...document.querySelectorAll('.project')].find((item) => item.dataset.project === ${JSON.stringify(designProject.project.projectId)});
    const panel = card.querySelector('.designs-panel');
    const observer = new MutationObserver(() => { if ([...panel.querySelectorAll('.design-entry')].some((entry) => entry.dataset.designId === ${JSON.stringify(revisedDesign.designId)})) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Revised design did not render')); }, 5000);
    observer.observe(panel, { childList: true, subtree: true }); card.querySelector('[data-action="designs"]').click();
  })`);
  const staleDesignView = await window.webContents.executeJavaScript(`(() => {
    const entry = [...document.querySelectorAll('.design-entry')].find((item) => item.dataset.designId === ${JSON.stringify(candidateDesign.designId)});
    return { expired: entry.textContent.includes('质量审阅：accepted（已过期）'), reviewDisabled: entry.querySelector('.design-review-form button').disabled };
  })()`);
  assert.equal(staleDesignView.expired, true); assert.equal(staleDesignView.reviewDisabled, true);
  const reportProjectId = reportProject.project.projectId;
  const openReportReview = () => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const card = [...document.querySelectorAll('.project')].find((item) => item.dataset.project === ${JSON.stringify(reportProjectId)});
    const old = card.querySelector('.report-review-panel');
    const observer = new MutationObserver(() => { if (card.querySelector('.report-review-panel') && card.querySelector('.report-review-panel') !== old) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Report review did not open: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(card, { childList: true, subtree: true }); card.querySelector('[data-action="report-review"]').click();
  })`);
  await openReportReview();
  const draftView = await window.webContents.executeJavaScript(`({ text: document.querySelector('.report-review-panel').textContent, acceptedDisabled: document.querySelector('.report-review-form option[value="accepted"]').disabled })`);
  assert.match(draftView.text, /状态：draft/); assert.match(draftView.text, /定稿阻塞/); assert.equal(draftView.acceptedDisabled, true);
  const reportEvidenceContext = await orchestrator.evidenceReviewContext(reportProjectId, reportEvidence.evidenceId);
  await orchestrator.reviewEvidence(reportProjectId, reportEvidence.evidenceId, { binding: reportEvidenceContext.binding, status: "supported", note: "Synthetic fixture only: the saved quote supports this bounded observation." });
  const supportedReport = await orchestrator.generateReport(reportProjectId);
  await openReportReview();
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.report-review-form option[value="accepted"]').disabled`), false);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const card = [...document.querySelectorAll('.project')].find((item) => item.dataset.project === ${JSON.stringify(reportProjectId)});
    const form = card.querySelector('.report-review-form'); form.elements.status.value = 'accepted'; form.elements.note.value = 'Synthetic UI fixture: checked the bounded source, locator and observation.';
    const observer = new MutationObserver(() => { if (card.querySelector('.report-review-saved') && card.querySelector('.report-review-panel').textContent.includes('状态：reviewed')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Report review did not save: ' + document.getElementById('notice').textContent)); }, 5000);
    observer.observe(card, { childList: true, subtree: true }); form.requestSubmit();
  })`);
  assert.equal((await repository.listReportReviews(reportProjectId)).length, 1);
  await orchestrator.addClaim(reportProjectId, { text: "A new unsupported claim makes the prior snapshot stale", claimType: "conclusion" });
  await openReportReview();
  const staleReportView = await window.webContents.executeJavaScript(`({ text: document.querySelector('.report-review-panel').textContent, disabled: document.querySelector('.report-review-form button').disabled, acceptedDisabled: document.querySelector('.report-review-form option[value="accepted"]').disabled })`);
  assert.match(staleReportView.text, /状态：stale/); assert.equal(staleReportView.disabled, true); assert.equal(staleReportView.acceptedDisabled, true);
  const beforeExport = { reports: (await repository.listReports(reportProjectId)).length, events: await repository.listEvents(reportProjectId), reviews: await repository.listReportReviews(reportProjectId), report: await repository.readReport(reportProjectId, supportedReport.reportId) };
  window.webContents.session.on("will-download", (event) => event.preventDefault());
  for (const action of ["report-markdown", "report-html"]) {
    const exported = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Report download IPC was not called")), 5000); reportExported = (result) => { clearTimeout(timer); resolve(result); }; });
    await window.webContents.executeJavaScript(`(() => { const card = [...document.querySelectorAll('.project')].find((item) => item.dataset.project === ${JSON.stringify(reportProjectId)}); card.querySelector('[data-action="${action}"]').click(); })()`);
    const result = await exported;
    assert.equal(result.status, "stale"); assert.match(result.markdown, /DRAFT/); assert.match(result.html, /data-report-status="stale"/);
  }
  reportExported = undefined;
  assert.deepEqual({ reports: (await repository.listReports(reportProjectId)).length, events: await repository.listEvents(reportProjectId), reviews: await repository.listReportReviews(reportProjectId), report: await repository.readReport(reportProjectId, supportedReport.reportId) }, beforeExport);
  console.log(JSON.stringify({ reportDraftGate: true, reportHumanReviewPersisted: true, reportStaleAfterUpstreamChange: true, staleReportReviewDisabled: true, reportDownloadsUseReadOnlyExport: true, scientificQuality: "not-reviewed; synthetic UI fixture" }));
  console.log(JSON.stringify({ codeContentPreview: true, codeContentEscaped: true, contentReviewBeforeApproval: true, changedInputRefusedBeforeApproval: true, changedCodeRefusedAfterApproval: true, refusedChangesStartNoProcess: true, contentApprovalPersisted: true, runManifestBound: true, scientificQuality: "not-reviewed; synthetic UI fixture" }));
  console.log(JSON.stringify({ designReview: true, designQualityReviewPersisted: true, staleDesignReviewDisplayed: true, staleDesignReviewDisabled: true, designApprovalPersisted: true, designEscaped: true, designApprovalDoesNotExecute: true, scientificQuality: "not-reviewed; synthetic UI fixture" }));
  console.log(JSON.stringify({ ok: true, renderer: "Electron", conflicts: 2, reviewPersisted: true, searchHits: 1, escapedMemory: true, approvalQueue: true, approvedExperiment: true, reportReadOnly: true, budgetPersisted: true, budgetCountersPreserved: true, budgetDoesNotResume: true, sourceReadBounded: true, sourceEscaped: true, evidenceReviewPersisted: true, workspaceDoesNotCompleteAgentReading: true, scientificQuality: "not-reviewed; synthetic UI fixture" }));
} catch (error) {
  console.error(error?.stack ?? JSON.stringify(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  window?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
  app.exit(process.exitCode ?? 0);
}
