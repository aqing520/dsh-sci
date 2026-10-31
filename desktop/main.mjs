import { app, BrowserWindow, Menu, ipcMain, clipboard, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProviderProfilePatch, providerProfileIdentity } from "./provider-profile.mjs";
import { createResearchIpcRegistrar, createResearchWindowRegistry } from "./research-access.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let windowRef;
let harnessProcess;
let harnessUrl;
let captureMonitor;
let captureStore;
let researchRepository;
let researchOrchestrator;
let captureDashboardWindow;
let researchDashboardWindow;
let researchReadOnlyWindow;
const researchWindows = createResearchWindowRegistry();
let backupQueue;
let backupQueueTimer;
let searchProvider;
let quotaProvider;
let serviceProviderName = "unconfigured";
let providerRuntimeConfig = { provider: "unknown", baseUrl: "", model: "", timeoutMs: undefined, keyConfigured: false };
let serviceRuntimeConfig = { baseUrl: "", timeoutMs: undefined, retries: undefined, keyConfigured: false };
let startupStateFile;
let previousStartupWasUnclean = false;
let quitting = false;
let startupErrorWindow;
let startupIpcInstalled = false;
let runtimeSettingsFile;
let runtimeSettings = { schema: "dsh-sci.runtime-settings.v1", provider: {}, service: {} };
let researchBridge;
let researchAgentProviderConfig = { provider: "tokenfans-codex", baseUrl: "", model: "" };
let researchAgentApiKey;
const researchAgentRuns = new Map();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function dashboardServiceStatus() {
  return { configured: Boolean(searchProvider && quotaProvider), provider: serviceProviderName, ...serviceRuntimeConfig };
}

async function applyRuntimeSettings(next) {
  const { updateRuntimeSettings, saveRuntimeSettings } = await import("../dist/src/runtime-settings.js");
  runtimeSettings = updateRuntimeSettings(runtimeSettings, next);
  await saveRuntimeSettings(runtimeSettingsFile, runtimeSettings);
  return runtimeSettings;
}

function packagedConfigFile() {
  const external = path.join(path.dirname(process.execPath), "dsh-sci.config.json");
  return fs.existsSync(external) ? external : path.join(here, "..", "config", "dsh-sci.config.json");
}

function createWindow(url, options = {}) {
  windowRef = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: "dsh-sci",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(options.preload ? { preload: options.preload } : {}),
    },
  });
  if (url) {
    windowRef.loadURL(url);
  }
}

async function openCaptureDashboard() {
  if (captureDashboardWindow && !captureDashboardWindow.isDestroyed()) { captureDashboardWindow.focus(); return; }
  if (!captureStore) return;
  const { renderCaptureDashboard } = await import("./capture-dashboard.mjs");
  const data = await readCaptureDashboardData();
  captureDashboardWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 900, minHeight: 600, title: "dsh-sci Capture History", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(here, "capture-preload.cjs") } });
  captureDashboardWindow.on("closed", () => { captureDashboardWindow = undefined; });
  const html = renderCaptureDashboard({ ...data, provider: providerRuntimeConfig, runtimeSettings, service: dashboardServiceStatus() });
  captureDashboardWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function openResearchDashboard(access = "owner") {
  const current = access === "read-only" ? researchReadOnlyWindow : researchDashboardWindow;
  if (current && !current.isDestroyed()) { current.focus(); return; }
  if (!researchRepository) return;
  const { renderResearchDashboard } = await import("./research-dashboard.mjs");
  const projects = await researchRepository.listProjects(100);
  const window = new BrowserWindow({ width: 1100, height: 760, minWidth: 820, minHeight: 560, title: access === "read-only" ? "Research Workspace (Read Only)" : "dsh-sci Research Workspace", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(here, "research-preload.cjs") } });
  if (access === "read-only") researchReadOnlyWindow = window; else researchDashboardWindow = window;
  window.on("closed", () => { if (access === "read-only") researchReadOnlyWindow = undefined; else researchDashboardWindow = undefined; });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(renderResearchDashboard({ projects, readOnly: access === "read-only" }))}`;
  researchWindows.bind(window, access, url);
  await window.loadURL(url);
}

async function researchDashboardUrl(event) {
  const { renderResearchDashboard } = await import("./research-dashboard.mjs");
  const projects = await researchRepository.listProjects(100);
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(renderResearchDashboard({ projects, readOnly: researchWindows.access(event) === "read-only" }))}`;
  researchWindows.permitDocument(event.sender, url);
  return url;
}

async function readCaptureDashboardData() {
  const { auditCaptureRoot } = await import("../dist/src/recovery.js");
  const status = await captureStore.readStatus();
  if (status.state === "locked") {
    return { status, settings: { schema: "dsh-sci.capture-settings.v1", enabled: false, maxSnapshots: 500, maxResearchRecords: 1000 }, records: [], snapshots: [], sessions: [], researchRuns: [], sessionEvents: {}, backupPublications: [], queueItems: [], artifacts: [], auditExport: undefined, recoveryAudit: await auditCaptureRoot(captureStore.root) };
  }
  const [settings, records, snapshots, sessions, researchRuns, backupPublications, auditExport, queueItems, artifacts, recoveryAudit] = await Promise.all([captureStore.readSettings(), captureStore.listResearchRecords(100), captureStore.listSnapshots(100), captureStore.listSessions(100), captureStore.listResearchRuns(100), captureStore.listBackupPublications(100), captureStore.exportAuditBundle(), backupQueue?.list(100) ?? [], captureStore.listArtifacts(1000), auditCaptureRoot(captureStore.root)]);
  const sessionEvents = Object.fromEntries(await Promise.all(sessions.map(async (session) => [session.sessionId, await captureStore.listSessionEvents(session.sessionId, 100)])));
  return { status, settings, records, snapshots, sessions, researchRuns, sessionEvents, backupPublications, queueItems, artifacts, auditExport, recoveryAudit };
}

async function captureDashboardUrl() {
  const { renderCaptureDashboard } = await import("./capture-dashboard.mjs");
  const data = await readCaptureDashboardData();
  const html = renderCaptureDashboard({ ...data, provider: providerRuntimeConfig, runtimeSettings, service: dashboardServiceStatus() });
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function installCaptureIpc() {
  const assertCaptureWindow = (event) => {
    if (!captureDashboardWindow || event.sender !== captureDashboardWindow.webContents) throw new Error("Capture dashboard is not authorized");
  };
  const assertResearchWindow = (event) => {
    researchWindows.requireWindow(event);
  };
  const researchIpc = createResearchIpcRegistrar(ipcMain, researchWindows, { auditDenied: (record) => researchRepository?.appendSecurityAudit(record) });
  ipcMain.handle("capture:update-settings", async (event, input) => {
    assertCaptureWindow(event);
    if (!captureStore) throw new Error("Capture store is not ready");
    const value = input && typeof input === "object" ? input : {};
    const patch = {};
    if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
    if (typeof value.maxSnapshots === "number" && Number.isFinite(value.maxSnapshots)) patch.maxSnapshots = value.maxSnapshots;
    if (typeof value.maxResearchRecords === "number" && Number.isFinite(value.maxResearchRecords)) patch.maxResearchRecords = value.maxResearchRecords;
    if (typeof value.retentionDays === "number" && Number.isFinite(value.retentionDays)) patch.retentionDays = value.retentionDays;
    return { settings: await captureStore.updateSettings(patch), status: await captureStore.readStatus() };
  });
  ipcMain.handle("runtime:settings", async (event, input) => {
    assertCaptureWindow(event);
    if (!runtimeSettingsFile) throw new Error("Runtime settings are not ready");
    if (input === undefined) return runtimeSettings;
    return applyRuntimeSettings(input);
  });
  ipcMain.handle("capture:cleanup", async (event) => {
    assertCaptureWindow(event);
    if (!captureStore) throw new Error("Capture store is not ready");
    return captureStore.cleanup();
  });
  ipcMain.handle("capture:recovery-audit", async (event) => {
    assertCaptureWindow(event);
    if (!captureStore) throw new Error("Capture store is not ready");
    const { auditCaptureRoot } = await import("../dist/src/recovery.js");
    return auditCaptureRoot(captureStore.root);
  });
  ipcMain.handle("capture:choose-audit-bundle", async (event) => {
    assertCaptureWindow(event);
    const result = await dialog.showOpenDialog(captureDashboardWindow, { properties: ["openFile", "dontAddToRecent"], filters: [{ name: "JSON audit bundle", extensions: ["json"] }] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("capture:choose-restore-target", async (event) => {
    assertCaptureWindow(event);
    const result = await dialog.showOpenDialog(captureDashboardWindow, { properties: ["openDirectory", "createDirectory", "dontAddToRecent"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("capture:restore-bundle", async (event, input) => {
    assertCaptureWindow(event);
    if (!captureStore) throw new Error("Capture store is not ready");
    const bundlePath = typeof input?.bundlePath === "string" ? path.resolve(input.bundlePath) : "";
    const targetRoot = typeof input?.targetRoot === "string" ? path.resolve(input.targetRoot) : "";
    if (!bundlePath || !targetRoot) throw new Error("Choose an audit bundle and an empty target directory");
    if (targetRoot === path.resolve(captureStore.root)) throw new Error("Restore target cannot be the active capture directory");
    const stat = await fs.promises.stat(bundlePath);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Audit bundle must be a regular JSON file no larger than 50 MB");
    const { restoreAuditBundle } = await import("../dist/src/recovery.js");
    return restoreAuditBundle(await fs.promises.readFile(bundlePath, "utf8"), targetRoot);
  });
  ipcMain.handle("capture:refresh", async (event) => {
    assertCaptureWindow(event);
    if (!captureStore) throw new Error("Capture store is not ready");
    return captureDashboardUrl();
  });
  ipcMain.handle("service:search", async (event, query) => {
    assertCaptureWindow(event);
    if (!searchProvider) throw new Error("Search service is not configured");
    return searchProvider.search(typeof query === "string" ? query : "", { limit: 10 });
  });
  ipcMain.handle("service:quota", async (event) => {
    assertCaptureWindow(event);
    if (!quotaProvider) throw new Error("Quota service is not configured");
    return quotaProvider.getQuota();
  });
  ipcMain.handle("capture:search-local", async (event, query) => {
    assertCaptureWindow(event);
    if (!captureStore) throw new Error("Capture store is not ready");
    const input = query && typeof query === "object" ? query : { query: typeof query === "string" ? query : "" };
    const allowedKinds = new Set(["research-run", "research-record", "workspace-snapshot", "session", "session-event", "artifact"]);
    const kind = typeof input.kind === "string" && allowedKinds.has(input.kind) ? input.kind : undefined;
    return captureStore.searchHistory(typeof input.query === "string" ? input.query : "", { limit: 50, offset: typeof input.offset === "number" && Number.isFinite(input.offset) ? input.offset : 0, kind, projectId: typeof input.projectId === "string" ? input.projectId : undefined, sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined, since: typeof input.since === "string" ? input.since : undefined, until: typeof input.until === "string" ? input.until : undefined });
  });
  ipcMain.handle("capture:retry-backup", async (event, jobId) => {
    assertCaptureWindow(event);
    if (!backupQueue) throw new Error("Backup queue is not ready");
    if (typeof jobId !== "string" || jobId.length > 128) throw new Error("Invalid backup job ID");
    const item = await backupQueue.retry(jobId);
    await backupQueue.process();
    return item;
  });
  researchIpc.handle("research:list", async (event, limit) => {
    assertResearchWindow(event);
    if (!researchRepository) throw new Error("Research repository is not ready");
    return researchRepository.listProjects(typeof limit === "number" ? limit : 100);
  });
  researchIpc.handle("research:security-audits", async (event, limit) => { assertResearchWindow(event); if (!researchRepository) throw new Error("Research repository is not ready"); return researchRepository.listSecurityAudits(typeof limit === "number" ? limit : 200); });
  researchIpc.handle("research:refresh", async (event) => { assertResearchWindow(event); return researchDashboardUrl(event); });
  researchIpc.handle("research:open-readonly", async () => { await openResearchDashboard("read-only"); return { opened: true }; });
  researchIpc.handle("research:source-preview", async (_event, input) => { if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.previewSource(String(input?.projectId), { sourceId: String(input?.sourceId), contentVersionId: input?.contentVersionId, offset: input?.offset, limit: input?.limit }); });
  researchIpc.handle("research:approval-queue", async (event) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.listApprovalQueue(1000); });
  researchIpc.handle("research:create", async (event, input) => {
    assertResearchWindow(event);
    if (!researchOrchestrator) throw new Error("Research orchestrator is not ready");
    if (!input || typeof input.question !== "string") throw new Error("Research question is required");
    return researchOrchestrator.createProject(input.question, { title: typeof input.title === "string" ? input.title : undefined, plan: input.plan, budget: input.budget });
  });
  researchIpc.handle("research:budget-read", async (event, projectId) => { assertResearchWindow(event); if (!researchRepository) throw new Error("Research repository is not ready"); if (!await researchRepository.readProject(String(projectId))) throw new Error("Research project not found"); return researchRepository.readBudget(String(projectId)); });
  researchIpc.handle("research:budget-update", async (event, input) => {
    assertResearchWindow(event);
    if (!researchOrchestrator) throw new Error("Research orchestrator is not ready");
    const projectId = String(input?.projectId);
    if (researchAgentRuns.has(projectId)) throw new Error("Cancel the active DSH research run and wait for it to stop before changing the budget");
    return researchOrchestrator.updateBudget(projectId, input?.limits);
  });
  researchIpc.handle("research:activate", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.activatePlan(String(projectId)); });
  researchIpc.handle("research:start-next", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.startNextTask(String(projectId)); });
  researchIpc.handle("research:approve", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.approveTask(String(input?.projectId), String(input?.taskId)); });
  researchIpc.handle("research:complete", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.completeTask(String(input?.projectId), String(input?.taskId), Array.isArray(input?.outputRefs) ? input.outputRefs.filter((value) => typeof value === "string") : []); });
  researchIpc.handle("research:fail", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.failTask(String(input?.projectId), String(input?.taskId), String(input?.error ?? "Research task failed")); });
  researchIpc.handle("research:pause", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.pause(String(projectId)); });
  researchIpc.handle("research:resume", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.resume(String(projectId)); });
  researchIpc.handle("research:replan", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.replan(String(projectId)); });
  researchIpc.handle("research:iterate", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.iterate(String(input?.projectId), String(input?.reason ?? "iteration requested")); });
  researchIpc.handle("research:export", async (event, projectId) => { assertResearchWindow(event); if (!researchRepository) throw new Error("Research repository is not ready"); return researchRepository.exportProject(String(projectId)); });
  researchIpc.handle("research:search", async (event, input) => {
    assertResearchWindow(event);
    if (!researchOrchestrator) throw new Error("Research orchestrator is not ready");
    return researchOrchestrator.searchSources(String(input?.projectId), input?.query, searchProvider, { backend: input?.backend });
  });
  researchIpc.handle("research:add-source", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.addSource(String(input?.projectId), input); });
  researchIpc.handle("research:add-citation", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.addCitation(String(input?.projectId), String(input?.sourceId), input ?? {}); });
  researchIpc.handle("research:add-claim", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.addClaim(String(input?.projectId), input ?? {}); });
  researchIpc.handle("research:add-evidence", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.addEvidence(String(input?.projectId), input ?? {}); });
  researchIpc.handle("research:ingest-document", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.ingestDocument(String(input?.projectId), String(input?.file)); });
  researchIpc.handle("research:reference", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.resolveReference(String(input?.projectId), String(input?.reference)); });
  researchIpc.handle("research:relate-sources", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.relateSources(String(input?.projectId), { fromSourceId: String(input?.fromSourceId), toSourceId: String(input?.toSourceId), kind: input?.kind, countsAsIndependent: input?.countsAsIndependent, note: String(input?.note ?? "") }); });
  researchIpc.handle("research:source-read", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.readSource(String(input?.projectId), { sourceId: String(input?.sourceId), contentVersionId: input?.contentVersionId, offset: input?.offset, limit: input?.limit }, "workspace"); });
  researchIpc.handle("research:evidence-review-context", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.evidenceReviewContext(String(input?.projectId), String(input?.evidenceId)); });
  researchIpc.handle("research:evidence-review", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.reviewEvidence(String(input?.projectId), String(input?.evidenceId), { binding: input?.binding, status: input?.status, note: input?.note }); });
  researchIpc.handle("research:report", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.generateReport(String(projectId)); });
  researchIpc.handle("research:report-read", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.readReport(String(input?.projectId), typeof input?.reportId === "string" ? input.reportId : undefined); });
  researchIpc.handle("research:report-review", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.reviewReport(String(input?.projectId), String(input?.reportId), { reportContentHash: String(input?.reportContentHash ?? ""), status: input?.status, note: typeof input?.note === "string" ? input.note : undefined }); });
  researchIpc.handle("research:report-review-current", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.currentReportReviews(String(input?.projectId), String(input?.reportId)); });
  researchIpc.handle("research:report-review-context", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.reportReviewContext(String(input?.projectId), typeof input?.reportId === "string" ? input.reportId : undefined); });
  researchIpc.handle("research:report-export", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.exportReport(String(input?.projectId), typeof input?.reportId === "string" ? input.reportId : undefined); });
  researchIpc.handle("research:remember", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.remember(String(input?.projectId), input ?? {}); });
  researchIpc.handle("research:memory-search", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.searchMemory(String(input?.query ?? ""), { projectId: typeof input?.projectId === "string" ? input.projectId : undefined, limit: input?.limit, since: typeof input?.since === "string" ? input.since : undefined, until: typeof input?.until === "string" ? input.until : undefined, minConfidence: input?.minConfidence }); });
  researchIpc.handle("research:memory-index-rebuild", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.rebuildMemoryIndex(typeof projectId === "string" ? projectId : undefined); });
  researchIpc.handle("research:memory-retrievals", async (event, limit) => { assertResearchWindow(event); if (!researchRepository) throw new Error("Research repository is not ready"); return researchRepository.listMemoryRetrievals(typeof limit === "number" ? limit : 100); });
  researchIpc.handle("research:memory-conflicts", async (event, projectId) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.listMemoryConflicts(String(projectId)); });
  researchIpc.handle("research:memory-review", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.reviewMemoryConflict(String(input?.projectId), { conflictKey: String(input?.conflictKey ?? ""), status: input?.status, selectedMemoryId: typeof input?.selectedMemoryId === "string" ? input.selectedMemoryId : undefined, note: typeof input?.note === "string" ? input.note : undefined }); });
  researchIpc.handle("research:memory-review-batch", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); if (!Array.isArray(input?.reviews)) throw new Error("memory review batch requires reviews"); return researchOrchestrator.reviewMemoryConflicts(String(input?.projectId), input.reviews.map((review) => ({ conflictKey: String(review?.conflictKey ?? ""), status: review?.status, selectedMemoryId: typeof review?.selectedMemoryId === "string" ? review.selectedMemoryId : undefined, note: typeof review?.note === "string" ? review.note : undefined }))); });
  researchIpc.handle("research:create-experiment", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.createExperiment(String(input?.projectId), input ?? {}); });
  researchIpc.handle("research:approve-experiment", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.approveExperiment(String(input?.projectId), String(input?.experimentId), String(input?.contentHash)); });
  researchIpc.handle("research:experiment-review", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.experimentReview(String(input?.projectId), String(input?.experimentId)); });
  researchIpc.handle("research:approve-experiment-design", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.approveExperimentDesign(String(input?.projectId), String(input?.designId), String(input?.contentHash)); });
  researchIpc.handle("research:review-experiment-design", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.reviewExperimentDesign(String(input?.projectId), String(input?.designId), { contentHash: String(input?.contentHash ?? ""), criteria: input?.criteria, status: input?.status, note: String(input?.note ?? "") }); });
  researchIpc.handle("research:execute-experiment", async (event, input) => { assertResearchWindow(event); if (!researchOrchestrator) throw new Error("Research orchestrator is not ready"); return researchOrchestrator.executeExperiment(String(input?.projectId), String(input?.experimentId), { approved: input?.approved === true }); });
  researchIpc.handle("research:run-agent", async (event, input) => {
    assertResearchWindow(event);
    if (!researchOrchestrator || !researchBridge) throw new Error("Research agent is not ready");
    if (!researchAgentApiKey) throw new Error("Research agent provider API key is not configured");
    const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : "";
    if (!projectId) throw new Error("Research project ID is required");
    if (researchAgentRuns.size) throw new Error("A DSH research run is already active; wait or cancel it first");
    const controller = new AbortController();
    researchAgentRuns.set(projectId, controller);
    const { runResearchWithDshAgent } = await import("../dist/src/research/dsh-sdk.js");
    try { return await runResearchWithDshAgent(researchOrchestrator, {
      projectId,
      sdkHome: path.join(app.getPath("userData"), "research-sdk"),
      pluginFile: path.join(here, "dsh-sci-research-plugin.mjs"),
      cwd: app.isPackaged ? app.getPath("documents") : process.cwd(),
      provider: researchAgentProviderConfig.provider,
      model: researchAgentProviderConfig.model,
      baseUrl: researchAgentProviderConfig.baseUrl,
      apiKey: researchAgentApiKey,
      search: searchProvider,
      environment: {
        DSH_SCI_RESEARCH_BRIDGE_URL: researchBridge.url,
        DSH_SCI_RESEARCH_BRIDGE_TOKEN: researchBridge.token,
        DSH_SCI_RESEARCH_ROOT: researchRepository?.root,
        DSH_SCI_TOOLS_MODULE_URL: import.meta.resolve("@deepseek-ai/dsh-tools"),
      },
      maxSteps: typeof input?.maxSteps === "number" ? input.maxSteps : 20,
      sessionScope: "plan",
      signal: controller.signal,
    }); } finally { researchAgentRuns.delete(projectId); }
  });
  researchIpc.handle("research:cancel-agent", async (event, projectId) => { assertResearchWindow(event); const id = typeof projectId === "string" ? projectId.trim() : ""; const controller = researchAgentRuns.get(id); if (!controller) return { cancelled: false }; controller.abort(new DOMException("Research run cancelled", "AbortError")); return { cancelled: true }; });
}

async function publishLocalMetadataBackup() {
  if (!captureStore || !backupQueue) return;
  try {
    await backupQueue.enqueue();
    await backupQueue.process();
  } catch (error) {
    console.error("Could not publish local metadata backup:", error);
  }
  const previousDashboard = captureDashboardWindow;
  captureDashboardWindow = undefined;
  if (previousDashboard && !previousDashboard.isDestroyed()) previousDashboard.close();
  await openCaptureDashboard();
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "dsh-sci", submenu: [{ label: "Research Workspace", click: () => void openResearchDashboard() }, { label: "Research Workspace (Read Only)", click: () => void openResearchDashboard("read-only") }, { label: "Capture History", click: () => void openCaptureDashboard() }, { label: "Queue Metadata Backup", click: () => void publishLocalMetadataBackup() }, { type: "separator" }, { role: "quit" }] }]));
}

async function createStartupErrorWindow(error) {
  const { createStartupDiagnostic, writeStartupDiagnostic } = await import("../dist/src/startup-diagnostics.js");
  const diagnostic = createStartupDiagnostic(error, { previousStartupWasUnclean, appVersion: app.getVersion() });
  let diagnosticFile;
  try { diagnosticFile = await writeStartupDiagnostic(app.getPath("userData"), diagnostic); }
  catch (writeError) { console.warn("Could not write startup diagnostic:", writeError); }
  const message = JSON.stringify(diagnostic, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  startupErrorWindow = undefined;
  createWindow(undefined, { preload: path.join(here, "startup-preload.cjs") });
  startupErrorWindow = windowRef;
  const recovery = previousStartupWasUnclean ? "检测到上次启动未正常退出，可以先重启应用；本地捕获记录会保留。" : "";
  const exported = JSON.stringify(diagnostic).replaceAll("</", "<\\/");
  const downloadUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(diagnostic, null, 2))}`;
  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;padding:40px;color:#263238;background:#f7f8fa}pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:16px;border-radius:8px}button,a{font:inherit;padding:8px 12px;margin-right:8px;border:1px solid #b9c2cc;border-radius:6px;background:#fff;cursor:pointer;text-decoration:none;color:inherit}button.primary{background:#365d9d;color:#fff;border-color:#365d9d}.path{color:#68707d;font-size:13px;word-break:break-all}</style><h1>dsh-sci 无法启动</h1><p>官方 DSH Harness 未能启动。请检查安装包和网络，然后重试。</p><p>${recovery}</p><p><button class="primary" id="retry">重试启动</button><button id="copy">复制诊断</button><a download="dsh-sci-startup-diagnostic.json" href="${downloadUrl}">下载诊断</a></p><p class="path">诊断文件：${escapeHtml(diagnosticFile ?? "未能写入")}</p><pre id="diagnostic">${message}</pre><script>const diagnostic=${exported};document.getElementById("retry").onclick=()=>window.startupApi?.retry();document.getElementById("copy").onclick=async()=>{await window.startupApi?.copy(JSON.stringify(diagnostic,null,2));document.getElementById("copy").textContent="已复制";};</script>`)}`);
}

function installStartupIpc() {
  if (startupIpcInstalled) return;
  startupIpcInstalled = true;
  ipcMain.handle("startup:retry", (event) => {
    if (!startupErrorWindow || event.sender !== startupErrorWindow.webContents) throw new Error("Startup window is not authorized");
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("startup:copy", (event, value) => {
    if (!startupErrorWindow || event.sender !== startupErrorWindow.webContents) throw new Error("Startup window is not authorized");
    clipboard.writeText(typeof value === "string" ? value : "");
    return true;
  });
}

function markStartupStarted() {
  startupStateFile = path.join(app.getPath("userData"), "startup-state.json");
  fs.mkdirSync(path.dirname(startupStateFile), { recursive: true });
  let previous;
  try { previous = JSON.parse(fs.readFileSync(startupStateFile, "utf8")); } catch { previous = undefined; }
  previousStartupWasUnclean = previous?.cleanShutdown === false;
  fs.writeFileSync(startupStateFile, JSON.stringify({ schema: "dsh-sci.startup-state.v1", startedAt: new Date().toISOString(), cleanShutdown: false, previousCleanShutdown: previous?.cleanShutdown ?? true }, null, 2));
}

function markStartupClean() {
  if (!startupStateFile) return;
  try { fs.writeFileSync(startupStateFile, JSON.stringify({ schema: "dsh-sci.startup-state.v1", cleanShutdown: true, shutdownAt: new Date().toISOString() }, null, 2)); } catch (error) { console.warn("Could not write startup state:", error); }
}

async function verifyOptionalIntegrity() {
  const manifestFile = path.join(path.dirname(process.execPath), "dsh-sci.integrity.json");
  if (!fs.existsSync(manifestFile)) return;
  const { verifyIntegrityManifest } = await import("../dist/src/integrity.js");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const failures = await verifyIntegrityManifest(path.dirname(process.execPath), manifest, { appVersion: app.getVersion(), generatorVersion: "dsh-sci.integrity.v1" });
  if (failures.length) throw new Error(`安装完整性校验失败：${failures.map((failure) => `${failure.path} (${failure.reason})`).join(", ")}`);
}

function bundledHarnessInvocation() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "app.asar", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
        path.join(process.resourcesPath, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      ]
    : [path.join(here, "..", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")];
  const script = candidates.find((candidate) => fs.existsSync(candidate));
  return script ? { command: process.execPath, argsPrefix: [script], environment: { ELECTRON_RUN_AS_NODE: "1" } } : undefined;
}

function ensureProviderProfile(home, providerConfig) {
  const patchFile = path.join(home, "profiles", "web", "cordis.patch.yml");
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  const current = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";
  const lifecycleFile = path.join(home, "plugins", "dsh-sci-lifecycle-plugin.mjs");
  const researchFile = path.join(home, "plugins", "dsh-sci-research-plugin.mjs");
  fs.mkdirSync(path.dirname(lifecycleFile), { recursive: true });
  fs.copyFileSync(path.join(here, "dsh-sci-lifecycle-plugin.mjs"), lifecycleFile);
  fs.copyFileSync(path.join(here, "dsh-sci-research-plugin.mjs"), researchFile);
  const lifecyclePatch = pathToFileURL(lifecycleFile).href;
  const researchPatch = pathToFileURL(researchFile).href;
  fs.writeFileSync(patchFile, buildProviderProfilePatch(current, providerConfig, lifecyclePatch, researchPatch), "utf8");
}

async function startOfficialHarness() {
  const { startHarness } = await import("../dist/src/harness.js");
  const home = path.join(app.getPath("userData"), "harness");
  const workspace = app.isPackaged ? app.getPath("documents") : process.cwd();
  runtimeSettingsFile = path.join(app.getPath("userData"), "runtime-settings.json");
  const { loadRuntimeSettings, runtimeSettingsToEnvironment } = await import("../dist/src/runtime-settings.js");
  runtimeSettings = await loadRuntimeSettings(runtimeSettingsFile);
  const { CaptureStore, WorkspaceCaptureMonitor } = await import("../dist/src/capture.js");
  captureStore = new CaptureStore(path.join(app.getPath("userData"), "capture"));
  const { ResearchRepository } = await import("../dist/src/research/repository.js");
  const { ResearchOrchestrator } = await import("../dist/src/research/orchestrator.js");
  const { createCommandOcrProvider, createHttpOcrProvider, createTesseractOcrProvider } = await import("../dist/src/research/ocr.js");
  const { ModelGateway } = await import("../dist/src/provider.js");
  researchRepository = new ResearchRepository(path.join(app.getPath("userData"), "capture", "research"), { metadataPassphrase: captureStore.metadataPassphrase });
  await researchRepository.recoverInterruptedExperiments();
  process.env.DSH_SCI_CAPTURE_ROOT = path.join(app.getPath("userData"), "capture");
  const bundled = bundledHarnessInvocation();
  let providerConfig = { provider: process.env.DSH_SCI_PROVIDER ?? "tokenfans-codex", baseUrl: process.env.DSH_SCI_BASE_URL ?? "https://tokenfans.ai/codex", model: process.env.DSH_SCI_MODEL ?? "gpt-6.1-sol" };
  let providerApiKey = process.env.DSH_SCI_API_KEY ?? process.env.DSH_SCI_TOKENFANS_API_KEY;
  try {
    const { loadProviderConfig } = await import("../dist/src/config.js");
    providerConfig = await loadProviderConfig({ workspace, env: { ...runtimeSettingsToEnvironment(runtimeSettings), ...process.env }, ...(fs.existsSync(packagedConfigFile()) ? { configFile: packagedConfigFile() } : {}) });
    providerApiKey = providerConfig.apiKey ?? providerApiKey;
  } catch (error) {
    console.warn("Could not load the optional provider configuration:", error);
  }
  let memoryOptions = {};
  researchAgentProviderConfig = { provider: providerConfig.provider, baseUrl: providerConfig.baseUrl, model: providerConfig.model };
  researchAgentApiKey = providerApiKey;
  let researchPlanner;
  if (providerApiKey) researchPlanner = new (await import("../dist/src/research/planner.js")).ModelResearchPlanner(new ModelGateway({ config: providerConfig }), providerConfig.model);
  if (process.env.DSH_SCI_MEMORY_EMBEDDINGS === "1") {
    const { loadMemoryEmbedder } = await import("../dist/src/research/memory-provider.js");
    memoryOptions = { embedder: await loadMemoryEmbedder({ workspace, env: { ...runtimeSettingsToEnvironment(runtimeSettings), ...process.env }, ...(fs.existsSync(packagedConfigFile()) ? { configFile: packagedConfigFile() } : {}) }) };
  }
  const configuredExperimentCommands = (process.env.DSH_SCI_EXPERIMENT_COMMANDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const experimentCommands = configuredExperimentCommands.length
    ? configuredExperimentCommands
    : [process.execPath, "node", "node.exe", "python", "python3", "python.exe", "py"];
  let ocrProvider;
  const ocrCommand = process.env.DSH_SCI_OCR_COMMAND?.trim();
  if (ocrCommand) {
    let ocrArgs = [];
    if (process.env.DSH_SCI_OCR_ARGS) {
      try {
        const parsed = JSON.parse(process.env.DSH_SCI_OCR_ARGS);
        if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("DSH_SCI_OCR_ARGS must be a JSON string array");
        ocrArgs = parsed;
      } catch (error) { throw new Error(`Invalid DSH_SCI_OCR_ARGS: ${error instanceof Error ? error.message : String(error)}`); }
    }
    ocrProvider = createCommandOcrProvider({ command: ocrCommand, args: ocrArgs, provider: process.env.DSH_SCI_OCR_PROVIDER, timeoutMs: Number(process.env.DSH_SCI_OCR_TIMEOUT_MS) || undefined, maxOutputBytes: Number(process.env.DSH_SCI_OCR_MAX_OUTPUT_BYTES) || undefined });
  } else if (["tesseract", "tesseract-ocr"].includes((process.env.DSH_SCI_OCR_PROVIDER ?? "").trim().toLowerCase())) {
    ocrProvider = createTesseractOcrProvider({
      provider: process.env.DSH_SCI_OCR_PROVIDER,
      rendererCommand: process.env.DSH_SCI_PDF_RENDER_COMMAND,
      tesseractCommand: process.env.DSH_SCI_TESSERACT_COMMAND,
      language: process.env.DSH_SCI_TESSERACT_LANGUAGE,
      dpi: Number(process.env.DSH_SCI_TESSERACT_DPI) || undefined,
      maxPages: Number(process.env.DSH_SCI_TESSERACT_MAX_PAGES) || undefined,
      timeoutMs: Number(process.env.DSH_SCI_OCR_TIMEOUT_MS) || undefined,
      maxOutputBytes: Number(process.env.DSH_SCI_OCR_MAX_OUTPUT_BYTES) || undefined,
    });
  } else if (process.env.DSH_SCI_OCR_ENDPOINT?.trim()) {
    ocrProvider = createHttpOcrProvider({
      endpoint: process.env.DSH_SCI_OCR_ENDPOINT,
      apiKey: process.env.DSH_SCI_OCR_API_KEY,
      provider: process.env.DSH_SCI_OCR_PROVIDER,
      timeoutMs: Number(process.env.DSH_SCI_OCR_TIMEOUT_MS) || undefined,
      maxRequestBytes: Number(process.env.DSH_SCI_OCR_MAX_REQUEST_BYTES) || undefined,
    });
  }
  researchOrchestrator = new ResearchOrchestrator(researchRepository, memoryOptions, researchPlanner, {
    experimentPolicy: {
      workspaceRoot: workspace,
      allowedCommands: experimentCommands,
      maxTimeoutMs: 30 * 60_000,
    },
    ocrProvider,
  });
  ensureProviderProfile(home, providerConfig);
  const { BackupQueue } = await import("../dist/src/backup-queue.js");
  const { HttpBackupPublisher, HttpQuotaProvider, HttpSearchProvider, LocalManifestPublisher, loadHttpServiceConfig } = await import("../dist/src/services.js");
  const serviceConfig = await loadHttpServiceConfig({ workspace, env: { ...runtimeSettingsToEnvironment(runtimeSettings), ...process.env }, ...(fs.existsSync(packagedConfigFile()) ? { configFile: packagedConfigFile() } : {}) });
  providerRuntimeConfig = { provider: providerConfig.provider, baseUrl: providerConfig.baseUrl, model: providerConfig.model, timeoutMs: providerConfig.timeoutMs, keyConfigured: Boolean(providerApiKey) };
  serviceProviderName = serviceConfig.provider ?? "http";
  serviceRuntimeConfig = { baseUrl: serviceConfig.baseUrl, timeoutMs: serviceConfig.timeoutMs, retries: serviceConfig.retries, keyConfigured: Boolean(serviceConfig.apiKey) };
  searchProvider = serviceConfig.baseUrl && serviceConfig.apiKey ? new HttpSearchProvider(serviceConfig) : undefined;
  const { startResearchBridge } = await import("../dist/src/research/bridge.js");
  researchBridge = await startResearchBridge(researchOrchestrator, { search: searchProvider });
  process.env.DSH_SCI_RESEARCH_BRIDGE_URL = researchBridge.url;
  process.env.DSH_SCI_RESEARCH_BRIDGE_TOKEN = researchBridge.token;
  quotaProvider = serviceConfig.baseUrl && serviceConfig.apiKey ? new HttpQuotaProvider(serviceConfig) : undefined;
  const publisher = serviceConfig.baseUrl && serviceConfig.apiKey ? new HttpBackupPublisher(serviceConfig) : new LocalManifestPublisher(captureStore.root, { metadataPassphrase: captureStore.metadataPassphrase });
  backupQueue = new BackupQueue(captureStore, publisher);
  try { await backupQueue.process(); }
  catch (error) { console.warn("Could not recover the backup queue at startup:", error); }
  backupQueueTimer = setInterval(() => void backupQueue?.process().catch((error) => console.warn("Backup queue processing failed:", error)), 60_000);
  backupQueueTimer.unref();
  captureMonitor = new WorkspaceCaptureMonitor(captureStore, workspace, 15_000, { provider: providerConfig.provider, model: providerConfig.model });
  await captureMonitor.start();
  const result = await startHarness({
    home,
    cwd: workspace,
    command: bundled?.command ?? process.env.DSH_SCI_HARNESS_BIN,
    argsPrefix: bundled?.argsPrefix,
    // Let the OS choose a free loopback port so a stale Harness process or
    // another local DSH instance cannot make startup fail with EADDRINUSE.
    webPort: 0,
    environment: {
      ...bundled?.environment,
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? "1",
      TOKENFANS_API_KEY: providerProfileIdentity(providerConfig.provider).env === "TOKENFANS_API_KEY" ? providerApiKey : undefined,
      OPENAI_API_KEY: providerProfileIdentity(providerConfig.provider).env === "OPENAI_API_KEY" ? providerApiKey : undefined,
      DSH_SCI_API_KEY: providerProfileIdentity(providerConfig.provider).env === "DSH_SCI_API_KEY" ? providerApiKey : undefined,
      DSH_SCI_RESEARCH_ROOT: researchRepository.root,
      DSH_SCI_TOOLS_MODULE_URL: import.meta.resolve("@deepseek-ai/dsh-tools"),
      DSH_SCI_RESEARCH_BRIDGE_URL: researchBridge.url,
      DSH_SCI_RESEARCH_BRIDGE_TOKEN: researchBridge.token,
    },
  });
  harnessProcess = result.process;
  harnessUrl = result.url;
  return result.url;
}

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  markStartupStarted();
  installStartupIpc();
  try {
    await verifyOptionalIntegrity();
    const url = await startOfficialHarness();
    installCaptureIpc();
    installApplicationMenu();
    createWindow(url);
  } catch (error) {
    console.error("Official dsh Harness could not start:", error);
    captureMonitor?.stop();
    captureMonitor = undefined;
    if (backupQueueTimer) clearInterval(backupQueueTimer);
    backupQueueTimer = undefined;
    await createStartupErrorWindow(error);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && harnessUrl) createWindow(harnessUrl);
  });
});

app.on("before-quit", (event) => {
  if (quitting) return;
  if (!harnessProcess) { if (backupQueueTimer) clearInterval(backupQueueTimer); backupQueueTimer = undefined; markStartupClean(); return; }
  event.preventDefault();
  quitting = true;
  for (const controller of researchAgentRuns.values()) controller.abort(new DOMException("Application shutting down", "AbortError"));
  captureMonitor?.stop();
  if (backupQueueTimer) clearInterval(backupQueueTimer);
  backupQueueTimer = undefined;
  import("../dist/src/harness.js")
    .then(async ({ stopHarness }) => { await researchOrchestrator?.cancelRunningExperiments(); await backupQueue?.waitForIdle(5_000); return stopHarness(harnessProcess); })
    .catch((error) => console.error("Failed to stop dsh Harness:", error))
    .finally(async () => { harnessProcess = undefined; await researchBridge?.close().catch((error) => console.warn("Failed to close research bridge:", error)); researchBridge = undefined; markStartupClean(); app.quit(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
