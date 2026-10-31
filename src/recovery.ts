import { access, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { encryptMetadataText, metadataPassphraseFromEnvironment, parseMetadataJson, serializeMetadataJson } from "./metadata-crypto.js";

export interface RecoveryAudit {
  schema: "dsh-sci.recovery-audit.v1";
  checkedAt: string;
  root: string;
  exists: boolean;
  healthy: boolean;
  issues: string[];
  files: Record<string, "ok" | "missing" | "invalid">;
  summary: {
    snapshots: number;
    researchRecords: number;
    sessions: number;
    researchRuns: number;
    artifacts: number;
    backupJobs: number;
    pendingBackupJobs: number;
    failedBackupJobs: number;
    latestStartupDiagnostic: boolean;
  };
}

export interface RecoveryRestoreResult {
  schema: "dsh-sci.recovery-restore.v1";
  restoredAt: string;
  targetRoot: string;
  files: number;
  snapshots: number;
  researchRecords: number;
  sessions: number;
  sessionEvents: number;
  artifacts: number;
  backupJobs: number;
  researchRuns: number;
}

type JsonObject = Record<string, any>;

function encodedSegment(value: unknown): string {
  const encoded = encodeURIComponent(String(value));
  return encoded === "." ? "%2E" : encoded === ".." ? "%2E%2E" : encoded;
}

function assertSchema(value: any, schema: string, name: string): void {
  if (!value || typeof value !== "object" || value.schema !== schema) throw new Error(`${name}: unexpected schema`);
}

function assertObservedCalls(run: any, name: string): void {
  // Runs written before correlated-call tracking may omit this field. When it
  // is present, validate every entry so restore cannot silently preserve a
  // malformed call ledger.
  if (run.observedCalls === undefined) return;
  if (!Array.isArray(run.observedCalls)) throw new Error(`${name}.observedCalls: expected an array`);
  for (const [index, call] of run.observedCalls.entries()) {
    const prefix = `${name}.observedCalls[${index}]`;
    if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error(`${prefix}: expected an object`);
    if (!["model", "tool", "unknown"].includes(call.kind)) throw new Error(`${prefix}.kind: unexpected value`);
    if (typeof call.id !== "string" || call.id.length === 0 || call.id.length > 128) throw new Error(`${prefix}.id: expected a non-empty string`);
    if (!Number.isInteger(call.count) || call.count < 1) throw new Error(`${prefix}.count: expected a positive integer`);
    if (!Array.isArray(call.eventTypes) || call.eventTypes.some((type: unknown) => typeof type !== "string")) throw new Error(`${prefix}.eventTypes: expected an array of strings`);
    for (const field of ["firstObservedAt", "lastObservedAt"]) if (typeof call[field] !== "string" || Number.isNaN(Date.parse(call[field]))) throw new Error(`${prefix}.${field}: expected an ISO timestamp`);
    for (const field of ["firstSeq", "lastSeq"]) if (call[field] !== undefined && !Number.isInteger(call[field])) throw new Error(`${prefix}.${field}: expected an integer`);
    if (typeof call.errorObserved !== "boolean") throw new Error(`${prefix}.errorObserved: expected a boolean`);
  }
}

function auditArrayIndex(value: any, field: string, idField: string, issues: string[]): any[] {
  if (value === undefined) return [];
  const items = value[field];
  if (!Array.isArray(items)) { issues.push(`${field}: expected an array`); return []; }
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { issues.push(`${field}[${index}]: expected an object`); continue; }
    if (typeof item[idField] !== "string" || !item[idField].trim()) { issues.push(`${field}[${index}].${idField}: missing`); continue; }
    const id = String(item[idField]);
    if (ids.has(id)) issues.push(`${field}[${index}].${idField}: duplicate ${id}`);
    ids.add(id);
  }
  return items;
}

function auditObservedCalls(runs: any[], issues: string[]): void {
  for (const [index, run] of runs.entries()) {
    try { assertObservedCalls(run, `researchRuns[${index}]`); } catch (error) { issues.push(String(error)); }
  }
}

async function writeRestoreJson(root: string, relative: string, value: unknown, metadataPassphrase?: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, serializeMetadataJson(value, metadataPassphrase), "utf8");
}

async function writeRestoreText(root: string, relative: string, value: string, metadataPassphrase?: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, metadataPassphrase ? encryptMetadataText(value, metadataPassphrase) : value, "utf8");
}

async function ensureEmptyTarget(root: string): Promise<void> {
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink()) throw new Error(`Restore target must not be a symbolic link: ${root}`);
    const entries = await readdir(root);
    if (entries.length) throw new Error(`Restore target must be empty: ${root}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") await mkdir(root, { recursive: true });
    else throw error;
  }
}

/** Restore a previously exported metadata-only audit bundle into an empty capture root. */
export async function restoreAuditBundle(bundleInput: string | unknown, targetRoot: string, options: { metadataPassphrase?: string } = {}): Promise<RecoveryRestoreResult> {
  const metadataPassphrase = options.metadataPassphrase ?? metadataPassphraseFromEnvironment();
  const bundle = typeof bundleInput === "string" ? JSON.parse(bundleInput) as JsonObject : bundleInput as JsonObject;
  assertSchema(bundle, "dsh-sci.audit-bundle.v1", "audit bundle");
  assertSchema(bundle.status, "dsh-sci.capture-status.v1", "audit bundle status");
  assertSchema(bundle.settings, "dsh-sci.capture-settings.v1", "audit bundle settings");
  const snapshots = Array.isArray(bundle.snapshots) ? bundle.snapshots : [];
  const records = Array.isArray(bundle.records) ? bundle.records : [];
  const sessions = Array.isArray(bundle.sessions) ? bundle.sessions : [];
  const researchRuns = Array.isArray(bundle.researchRuns) ? bundle.researchRuns : [];
  const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
  const queue = Array.isArray(bundle.backupQueue) ? bundle.backupQueue : [];
  const publications = Array.isArray(bundle.backupPublications) ? bundle.backupPublications : [];
  const sessionEvents = bundle.sessionEvents && typeof bundle.sessionEvents === "object" && !Array.isArray(bundle.sessionEvents) ? bundle.sessionEvents as Record<string, unknown> : {};
  for (const [index, item] of snapshots.entries()) assertSchema(item, "dsh-sci.workspace-snapshot.v1", `snapshots[${index}]`);
  for (const [index, item] of records.entries()) assertSchema(item, "dsh-sci.research-record.v1", `records[${index}]`);
  for (const [index, item] of sessions.entries()) assertSchema(item, "dsh-sci.session-index.v1", `sessions[${index}]`);
  for (const [index, item] of researchRuns.entries()) {
    assertSchema(item, "dsh-sci.research-run.v1", `researchRuns[${index}]`);
    assertObservedCalls(item, `researchRuns[${index}]`);
  }
  for (const [index, item] of artifacts.entries()) assertSchema(item, "dsh-sci.artifact.v1", `artifacts[${index}]`);
  for (const [index, item] of queue.entries()) assertSchema(item, "dsh-sci.backup-queue-item.v1", `backupQueue[${index}]`);
  for (const [index, item] of publications.entries()) assertSchema(item, "dsh-sci.backup-publication.v1", `backupPublications[${index}]`);
  const snapshotIds = new Set(snapshots.map((snapshot: any) => String(snapshot.snapshotId)));
  const sessionIds = new Set(sessions.map((session: any) => String(session.sessionId)));
  if (bundle.status.lastSnapshot !== undefined && !snapshotIds.has(String(bundle.status.lastSnapshot))) throw new Error("audit bundle status references a missing snapshot");
  for (const [index, record] of records.entries()) if (!snapshotIds.has(String(record.workspaceSnapshotId))) throw new Error(`records[${index}]: references a missing snapshot`);
  for (const sessionId of Object.keys(sessionEvents)) if (!sessionIds.has(String(sessionId))) throw new Error(`sessionEvents[${sessionId}]: references a missing session`);
  for (const [sessionId, events] of Object.entries(sessionEvents)) if (!Array.isArray(events) || events.some((event) => !event || typeof event !== "object" || Array.isArray(event))) throw new Error(`sessionEvents[${sessionId}]: expected an array of objects`);
  const resolvedRoot = path.resolve(targetRoot);
  await ensureEmptyTarget(resolvedRoot);
  const files = { value: 0 };
  const write = async (relative: string, value: unknown) => { await writeRestoreJson(resolvedRoot, relative, value, metadataPassphrase); files.value += 1; };
  await write("capture-status.json", bundle.status);
  await write("capture-settings.json", bundle.settings);
  await write("snapshots/index.json", { schema: "dsh-sci.workspace-snapshot-index.v1", snapshots });
  for (const snapshot of snapshots) await write(path.join("snapshots", `${encodedSegment(snapshot.snapshotId)}.json`), snapshot);
  await write("research-records.json", { schema: "dsh-sci.research-record-index.v1", records });
  for (const record of records) await write(path.join("runs", encodedSegment(record.runId), "research-record.json"), record);
  await write("sessions/index.json", { schema: "dsh-sci.session-index.v1", sessions });
  await write("research-runs/index.json", { schema: "dsh-sci.research-run-index.v1", runs: researchRuns });
  for (const run of researchRuns) await write(path.join("research-runs", encodedSegment(run.runId), "run.json"), run);
  let aggregate = "";
  for (const session of sessions) {
    const id = String(session.sessionId);
    const events = Array.isArray(sessionEvents[id]) ? sessionEvents[id] as JsonObject[] : [];
    const lines = events.map((event) => JSON.stringify(event));
    if (lines.length) aggregate += `${lines.join("\n")}\n`;
    await write(path.join("sessions", encodedSegment(id), "session.json"), session);
    await writeRestoreText(resolvedRoot, path.join("sessions", encodedSegment(id), "events.jsonl"), lines.length ? `${lines.join("\n")}\n` : "", metadataPassphrase); files.value += 1;
  }
  if (aggregate) { await mkdir(path.join(resolvedRoot, "sessions"), { recursive: true }); await writeFile(path.join(resolvedRoot, "sessions", "dsh-session-events.jsonl"), metadataPassphrase ? encryptMetadataText(aggregate, metadataPassphrase) : aggregate, "utf8"); files.value += 1; }
  await write("artifacts/index.json", { schema: "dsh-sci.artifact-index.v1", artifacts });
  await write("backups/queue.json", { schema: "dsh-sci.backup-queue.v1", items: queue });
  await write("backups/publications.json", { schema: "dsh-sci.backup-publication-index.v1", publications });
  const latest = snapshots.find((snapshot: any) => snapshot.snapshotId === bundle.status.lastSnapshot) ?? snapshots.slice().sort((a: any, b: any) => String(b.capturedAt).localeCompare(String(a.capturedAt)))[0];
  if (latest) await write("workspace-index.json", { schema: "dsh-sci.workspace-index.v1", latest: latest.snapshotId, capturedAt: latest.capturedAt, workspaceRoot: latest.workspaceRoot, projectId: latest.projectId, sequence: latest.sequence, files: latest.files });
  const eventCount = Object.values(sessionEvents).reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
  return { schema: "dsh-sci.recovery-restore.v1", restoredAt: new Date().toISOString(), targetRoot: resolvedRoot, files: files.value, snapshots: snapshots.length, researchRecords: records.length, sessions: sessions.length, sessionEvents: eventCount, artifacts: artifacts.length, backupJobs: queue.length, researchRuns: researchRuns.length };
}

async function readJson(root: string, relative: string, files: Record<string, "ok" | "missing" | "invalid">, metadataPassphrase?: string): Promise<any | undefined> {
  try {
    const value = parseMetadataJson(await readFile(path.join(root, relative), "utf8"), metadataPassphrase);
    files[relative] = "ok";
    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { files[relative] = "missing"; return undefined; }
    files[relative] = "invalid";
    throw new Error(`${relative}: ${error instanceof Error && error.name === "MetadataLockedError" ? error.message : "invalid JSON"}`);
  }
}

export async function auditCaptureRoot(root: string, options: { metadataPassphrase?: string } = {}): Promise<RecoveryAudit> {
  const resolvedRoot = path.resolve(root);
  const metadataPassphrase = options.metadataPassphrase ?? metadataPassphraseFromEnvironment();
  const files: Record<string, "ok" | "missing" | "invalid"> = {};
  try { await access(resolvedRoot); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: "dsh-sci.recovery-audit.v1", checkedAt: new Date().toISOString(), root: resolvedRoot, exists: false, healthy: true, issues: [], files, summary: { snapshots: 0, researchRecords: 0, sessions: 0, researchRuns: 0, artifacts: 0, backupJobs: 0, pendingBackupJobs: 0, failedBackupJobs: 0, latestStartupDiagnostic: false } };
    throw error;
  }
  const issues: string[] = [];
  let status: any; let settings: any; let snapshots: any; let records: any; let sessions: any; let researchRuns: any; let artifacts: any; let queue: any; let publications: any;
  for (const [name, target] of [["capture-status.json", "status"], ["capture-settings.json", "settings"], ["snapshots/index.json", "snapshots"], ["research-records.json", "records"], ["sessions/index.json", "sessions"], ["research-runs/index.json", "researchRuns"], ["artifacts/index.json", "artifacts"], ["backups/queue.json", "queue"], ["backups/publications.json", "publications"]] as const) {
    try { const value = await readJson(resolvedRoot, name, files, metadataPassphrase); if (target === "status") status = value; else if (target === "settings") settings = value; else if (target === "snapshots") snapshots = value; else if (target === "records") records = value; else if (target === "sessions") sessions = value; else if (target === "researchRuns") researchRuns = value; else if (target === "artifacts") artifacts = value; else if (target === "queue") queue = value; else publications = value; }
    catch (error) { issues.push(String(error)); }
  }
  if (status && status.schema !== "dsh-sci.capture-status.v1") issues.push("capture-status.json: unexpected schema");
  if (settings && settings.schema !== "dsh-sci.capture-settings.v1") issues.push("capture-settings.json: unexpected schema");
  if (snapshots && snapshots.schema !== "dsh-sci.workspace-snapshot-index.v1") issues.push("snapshots/index.json: unexpected schema");
  if (records && records.schema !== "dsh-sci.research-record-index.v1") issues.push("research-records.json: unexpected schema");
  if (sessions && sessions.schema !== "dsh-sci.session-index.v1") issues.push("sessions/index.json: unexpected schema");
  if (researchRuns && researchRuns.schema !== "dsh-sci.research-run-index.v1") issues.push("research-runs/index.json: unexpected schema");
  if (artifacts && artifacts.schema !== "dsh-sci.artifact-index.v1") issues.push("artifacts/index.json: unexpected schema");
  if (queue && queue.schema !== "dsh-sci.backup-queue.v1") issues.push("backups/queue.json: unexpected schema");
  if (publications && publications.schema !== "dsh-sci.backup-publication-index.v1") issues.push("backups/publications.json: unexpected schema");
  if (files["capture-status.json"] === "missing") issues.push("capture-status.json: missing");
  if (files["capture-settings.json"] === "missing") issues.push("capture-settings.json: missing");
  const snapshotItems = auditArrayIndex(snapshots, "snapshots", "snapshotId", issues);
  const recordItems = auditArrayIndex(records, "records", "runId", issues);
  const sessionItems = auditArrayIndex(sessions, "sessions", "sessionId", issues);
  const researchRunItems = auditArrayIndex(researchRuns, "runs", "runId", issues);
  const artifactItems = auditArrayIndex(artifacts, "artifacts", "artifactId", issues);
  const jobs = Array.isArray(queue?.items) ? queue.items : [];
  if (queue !== undefined && !Array.isArray(queue?.items)) issues.push("backups/queue.json.items: expected an array");
  const snapshotIds = new Set(snapshotItems.map((item: any) => String(item.snapshotId)));
  const sessionIds = new Set(sessionItems.map((item: any) => String(item.sessionId)));
  for (const [index, record] of recordItems.entries()) if (record.workspaceSnapshotId !== undefined && !snapshotIds.has(String(record.workspaceSnapshotId))) issues.push(`records[${index}].workspaceSnapshotId: references missing snapshot`);
  if (status?.lastSnapshot !== undefined && !snapshotIds.has(String(status.lastSnapshot))) issues.push("capture-status.json.lastSnapshot: references missing snapshot");
  for (const [index, run] of researchRunItems.entries()) if (run.sessionId !== undefined && !sessionIds.has(String(run.sessionId))) issues.push(`researchRuns[${index}].sessionId: references missing session`);
  const artifactIds = new Set(artifactItems.map((item: any) => String(item.artifactId)));
  for (const [index, run] of researchRunItems.entries()) if (Array.isArray(run.artifactIds)) for (const artifactId of run.artifactIds) if (!artifactIds.has(String(artifactId))) issues.push(`researchRuns[${index}].artifactIds: references missing artifact ${String(artifactId)}`);
  auditObservedCalls(researchRunItems, issues);
  const pending = jobs.filter((item: any) => ["queued", "running", "retrying"].includes(item?.state));
  let latestStartupDiagnostic = false;
  try { await access(path.join(resolvedRoot, "..", "startup-diagnostics", "latest.json")); latestStartupDiagnostic = true; } catch { /* optional */ }
  return { schema: "dsh-sci.recovery-audit.v1", checkedAt: new Date().toISOString(), root: resolvedRoot, exists: true, healthy: issues.length === 0, issues, files, summary: { snapshots: snapshotItems.length, researchRecords: recordItems.length, sessions: sessionItems.length, researchRuns: researchRunItems.length, artifacts: artifactItems.length, backupJobs: jobs.length, pendingBackupJobs: pending.length, failedBackupJobs: jobs.filter((item: any) => item?.state === "failed").length, latestStartupDiagnostic } };
}
