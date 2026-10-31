import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { listWorkspace, type WorkspaceEntry } from "./workspace.js";
import type { BackupManifest, BackupPublisher } from "./services.js";
import type { BackupQueueItem } from "./backup-queue.js";
import { decryptMetadataText, MetadataLockedError, metadataPassphraseFromEnvironment, parseMetadataJson, serializeMetadataJson } from "./metadata-crypto.js";

export interface WorkspaceSnapshot {
  schema: "dsh-sci.workspace-snapshot.v1";
  snapshotId: string;
  workspaceRoot: string;
  projectId: string;
  sequence: number;
  capturedAt: string;
  files: WorkspaceEntry[];
  changes: { added: string[]; removed: string[]; changed: string[] };
}

export interface ResearchRecord {
  schema: "dsh-sci.research-record.v1";
  runId: string;
  projectId: string;
  status: "completed" | "partial" | "failed";
  createdAt: string;
  workspaceSnapshotId: string;
  sessionId?: string;
  inputs: { status: "unverified"; exactInputBaseline: false; digest?: string };
  execution: { source: "background-workspace-observation"; toolAttribution: "unavailable" | "partial"; provider?: string; model?: string };
  outputs: { status: "background-captured"; files: number; changedFiles: number };
}

export interface CaptureStatus {
  schema: "dsh-sci.capture-status.v1";
  state: "idle" | "capturing" | "error" | "disabled" | "locked";
  enabled: boolean;
  workspaceRoot?: string;
  projectId?: string;
  lastSnapshot?: string;
  lastCapturedAt?: string;
  error?: string;
}

export interface CaptureSettings {
  schema: "dsh-sci.capture-settings.v1";
  enabled: boolean;
  maxSnapshots: number;
  maxResearchRecords: number;
  retentionDays?: number;
}

export interface CleanupResult { snapshotsRemoved: number; recordsRemoved: number; sessionsRemoved: number; }
export interface SessionIndex {
  schema: "dsh-sci.session-index.v1";
  sessionId: string;
  projectId?: string;
  workspaceSnapshotId?: string;
  workspaceRoot?: string;
  cwd?: string;
  origin?: string;
  createdAt?: string;
  disposedAt?: string;
  status?: string;
  eventCount?: number;
  toolAttribution?: "unavailable" | "partial";
  observedPaths?: string[];
  [key: string]: unknown;
}

export type SessionEventRecord = Record<string, unknown>;

export interface ResearchRun {
  schema: "dsh-sci.research-run.v1";
  runId: string;
  sessionId: string;
  projectId?: string;
  workspaceSnapshotId?: string;
  startedAt: string;
  lastObservedAt: string;
  disposedAt?: string;
  state: "active" | "disposed";
  outcome: "unverified";
  inputs: { status: "unverified"; exactInputBaseline: false };
  inputSummary: { status: "unverified"; events: number; observedPaths: number };
  outputSummary: { status: "unverified"; events: number; observedPaths: number };
  execution: { source: "dsh-session-observation"; toolAttribution: "unavailable" | "partial"; provider?: string; model?: string };
  eventCount: number;
  observedPaths: string[];
  artifactIds: string[];
  lastEventType?: string;
  agentStatus?: string;
  eventTypes: Record<string, number>;
  observations: { inputEvents: number; outputEvents: number; toolEvents: number; errorEvents: number; statusEvents: number };
  observedCalls: Array<{ kind: "model" | "tool" | "unknown"; id: string; count: number; eventTypes: string[]; firstObservedAt: string; lastObservedAt: string; firstSeq?: number; lastSeq?: number; errorObserved: boolean }>;
}

export interface ArtifactRecord {
  schema: "dsh-sci.artifact.v1";
  artifactId: string;
  path: string;
  relativePath?: string;
  location: "workspace" | "external";
  kind: string;
  bytes?: number;
  sha256?: string;
  projectId?: string;
  workspaceSnapshotId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observedCount: number;
  sessionIds: string[];
}

export interface LocalHistoryHit {
  kind: "research-run" | "research-record" | "workspace-snapshot" | "session" | "session-event" | "artifact";
  id: string;
  createdAt: string;
  projectId?: string;
  sessionId?: string;
  summary: string;
  value: unknown;
}

export interface AuditBundle {
  schema: "dsh-sci.audit-bundle.v1";
  exportedAt: string;
  status: CaptureStatus;
  settings: CaptureSettings;
  sessions: SessionIndex[];
  researchRuns: ResearchRun[];
  sessionEvents: Record<string, SessionEventRecord[]>;
  records: ResearchRecord[];
  snapshots: WorkspaceSnapshot[];
  backupPublications: BackupPublication[];
  backupQueue: BackupQueueItem[];
  artifacts: ArtifactRecord[];
}

export interface BackupPublication {
  schema: "dsh-sci.backup-publication.v1";
  publicationId: string;
  manifestId?: string;
  projectId: string;
  provider?: string;
  status: "pending" | "published" | "failed";
  uploaded: boolean;
  attemptedAt: string;
  completedAt?: string;
  error?: string;
}

const STATUS_FILE = "capture-status.json";
const SETTINGS_FILE = "capture-settings.json";
const INDEX_FILE = "workspace-index.json";
const SNAPSHOT_INDEX_FILE = path.join("snapshots", "index.json");
const RECORD_INDEX_FILE = "research-records.json";
const BACKUP_PUBLICATION_FILE = path.join("backups", "publications.json");
const BACKUP_QUEUE_FILE = path.join("backups", "queue.json");
const ARTIFACT_INDEX_FILE = path.join("artifacts", "index.json");
const RESEARCH_RUN_INDEX_FILE = path.join("research-runs", "index.json");

function sessionDirectoryName(sessionId: string): string {
  const encoded = encodeURIComponent(String(sessionId));
  return encoded === "." ? "%2E" : encoded === ".." ? "%2E%2E" : encoded;
}

function projectIdFor(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 32);
}

/** Local workspace metadata snapshots. It never uploads source files. */
export class CaptureStore {
  readonly root: string;
  readonly metadataPassphrase?: string;
  private status: CaptureStatus = { schema: "dsh-sci.capture-status.v1", state: "idle", enabled: true };
  private settings: CaptureSettings = { schema: "dsh-sci.capture-settings.v1", enabled: true, maxSnapshots: 500, maxResearchRecords: 1000 };
  private previous = new Map<string, { sha256?: string; bytes: number; kind: string }>();
  private previousWorkspaceRoot?: string;
  private initialized = false;
  private metadataLocked = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(root: string, options: { metadataPassphrase?: string } = {}) {
    this.root = path.resolve(root);
    this.metadataPassphrase = options.metadataPassphrase ?? metadataPassphraseFromEnvironment();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try { await this.initUnlocked(); }
    catch (error: unknown) {
      if (!(error instanceof MetadataLockedError)) throw error;
      this.metadataLocked = true;
      this.status = { ...this.status, state: "locked", enabled: false, error: error.message };
      this.initialized = true;
    }
  }

  private async initUnlocked(): Promise<void> {
    if (this.initialized) return;
    await mkdir(path.join(this.root, "snapshots"), { recursive: true });
    await mkdir(path.join(this.root, "runs"), { recursive: true });
    try { this.settings = { ...this.settings, ...await this.readJson<CaptureSettings>(SETTINGS_FILE) }; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.settings.maxSnapshots = Math.max(1, Math.floor(this.settings.maxSnapshots || 500));
    this.settings.maxResearchRecords = Math.max(1, Math.floor(this.settings.maxResearchRecords || 1000));
    if (typeof this.settings.retentionDays === "number" && Number.isFinite(this.settings.retentionDays) && this.settings.retentionDays > 0) this.settings.retentionDays = Math.min(36_500, Math.floor(this.settings.retentionDays));
    else delete this.settings.retentionDays;
    try {
      const index = await this.readJson<{ workspaceRoot?: string; files?: WorkspaceEntry[] }>(INDEX_FILE);
      this.previousWorkspaceRoot = index.workspaceRoot;
      this.previous = new Map((index.files ?? []).map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes, kind: file.kind }]));
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { this.status = { ...this.status, ...await this.readJson<CaptureStatus>(STATUS_FILE) }; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.status.enabled = this.settings.enabled;
    this.status.state = this.settings.enabled ? (this.status.state === "disabled" ? "idle" : this.status.state) : "disabled";
    this.initialized = true;
    await this.writeJson(SETTINGS_FILE, this.settings);
    await this.writeJson(STATUS_FILE, this.status);
  }

  async setEnabled(enabled: boolean): Promise<CaptureStatus> {
    return this.mutate(() => this.setEnabledInternal(enabled));
  }

  private async setEnabledInternal(enabled: boolean): Promise<CaptureStatus> {
    await this.init();
    this.ensureUnlocked();
    this.settings.enabled = enabled;
    this.status = { ...this.status, enabled, state: enabled ? "idle" : "disabled", error: undefined };
    await this.writeJson(SETTINGS_FILE, this.settings);
    await this.writeJson(STATUS_FILE, this.status);
    return this.status;
  }

  async updateSettings(patch: Partial<Pick<CaptureSettings, "enabled" | "maxSnapshots" | "maxResearchRecords" | "retentionDays">>): Promise<CaptureSettings> {
    return this.mutate(() => this.updateSettingsInternal(patch));
  }

  private async updateSettingsInternal(patch: Partial<Pick<CaptureSettings, "enabled" | "maxSnapshots" | "maxResearchRecords" | "retentionDays">>): Promise<CaptureSettings> {
    await this.init();
    this.ensureUnlocked();
    if (patch.enabled !== undefined) this.settings.enabled = Boolean(patch.enabled);
    if (patch.maxSnapshots !== undefined) this.settings.maxSnapshots = Math.max(1, Math.min(100_000, Math.floor(Number(patch.maxSnapshots) || 1)));
    if (patch.maxResearchRecords !== undefined) this.settings.maxResearchRecords = Math.max(1, Math.min(100_000, Math.floor(Number(patch.maxResearchRecords) || 1)));
    if (patch.retentionDays !== undefined) {
      const days = Number(patch.retentionDays);
      if (Number.isFinite(days) && days > 0) this.settings.retentionDays = Math.min(36_500, Math.floor(days));
      else delete this.settings.retentionDays;
    }
    this.status = { ...this.status, enabled: this.settings.enabled, state: this.settings.enabled ? (this.status.state === "disabled" ? "idle" : this.status.state) : "disabled", error: undefined };
    await this.writeJson(SETTINGS_FILE, this.settings);
    await this.writeJson(STATUS_FILE, this.status);
    await this.enforceRetention();
    return { ...this.settings };
  }

  async readSettings(): Promise<CaptureSettings> { await this.init(); return { ...this.settings }; }

  async snapshot(workspaceRoot: string, options: { sessionId?: string; provider?: string; model?: string; inputDigest?: string } = {}): Promise<WorkspaceSnapshot> {
    return this.mutate(() => this.snapshotInternal(workspaceRoot, options));
  }

  private async snapshotInternal(workspaceRoot: string, options: { sessionId?: string; provider?: string; model?: string; inputDigest?: string } = {}): Promise<WorkspaceSnapshot> {
    await this.init();
    this.ensureUnlocked();
    if (!this.settings.enabled) { this.status = { ...this.status, state: "disabled", enabled: false }; await this.writeJson(STATUS_FILE, this.status); const existing = await this.readIndex(); if (existing) return existing; throw new Error("Capture is disabled"); }
    const resolvedRoot = path.resolve(workspaceRoot);
    if (this.previousWorkspaceRoot && this.previousWorkspaceRoot !== resolvedRoot) this.previous.clear();
    const files = await listWorkspace(resolvedRoot, 12);
    const current = new Map(files.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes, kind: file.kind }]));
    const added = [...current.keys()].filter((key) => !this.previous.has(key));
    const removed = [...this.previous.keys()].filter((key) => !current.has(key));
    const changed = [...current.keys()].filter((key) => {
      const before = this.previous.get(key); const after = current.get(key);
      return before !== undefined && after !== undefined && (before.bytes !== after.bytes || before.sha256 !== after.sha256 || before.kind !== after.kind);
    });
    const capturedAt = new Date().toISOString();
    const snapshotId = createHash("sha256").update(JSON.stringify({ files, workspaceRoot: resolvedRoot })).digest("hex");
    const history = await this.listSnapshots(10000);
    const prior = history.filter((item) => item.workspaceRoot === resolvedRoot).sort((a, b) => b.sequence - a.sequence)[0];
    const sequence = (prior?.sequence ?? 0) + 1;
    const value: WorkspaceSnapshot = { schema: "dsh-sci.workspace-snapshot.v1", snapshotId, workspaceRoot: resolvedRoot, projectId: projectIdFor(resolvedRoot), sequence, capturedAt, files, changes: { added, removed, changed } };
    await this.writeJson(path.join("snapshots", `${snapshotId}.json`), value);
    await this.writeJson(INDEX_FILE, { schema: "dsh-sci.workspace-index.v1", latest: snapshotId, capturedAt, workspaceRoot: resolvedRoot, projectId: value.projectId, sequence, files });
    await this.writeJson(SNAPSHOT_INDEX_FILE, { schema: "dsh-sci.workspace-snapshot-index.v1", snapshots: [...history.filter((item) => item.snapshotId !== snapshotId), value].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).slice(-this.settings.maxSnapshots) });
    this.previous = current; this.previousWorkspaceRoot = resolvedRoot;
    this.status = { ...this.status, state: "capturing", enabled: true, workspaceRoot: resolvedRoot, projectId: value.projectId, lastSnapshot: snapshotId, lastCapturedAt: capturedAt, error: undefined };
    await this.writeJson(STATUS_FILE, this.status);
    await this.writeResearchRecord(value, options);
    await this.enforceRetention();
    return value;
  }

  async readIndex(): Promise<WorkspaceSnapshot | undefined> {
    try {
      const index = await this.readJson<Partial<WorkspaceSnapshot> & { latest?: string }>(INDEX_FILE);
      if (!index.snapshotId && !index.latest) return undefined;
      if (!index.workspaceRoot || !index.capturedAt || !index.files) return undefined;
      return { schema: "dsh-sci.workspace-snapshot.v1", snapshotId: index.snapshotId ?? index.latest!, workspaceRoot: index.workspaceRoot, projectId: index.projectId ?? projectIdFor(index.workspaceRoot), sequence: index.sequence ?? 0, capturedAt: index.capturedAt, files: index.files, changes: { added: [], removed: [], changed: [] } };
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async readSnapshot(snapshotId: string): Promise<WorkspaceSnapshot | undefined> {
    try { return await this.readJson<WorkspaceSnapshot>(path.join("snapshots", `${snapshotId}.json`)); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async listSnapshots(limit = 50): Promise<WorkspaceSnapshot[]> {
    try {
      const index = await this.readJson<{ snapshots?: WorkspaceSnapshot[] }>(SNAPSHOT_INDEX_FILE);
      return (index.snapshots ?? []).slice(-Math.max(1, limit)).reverse();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const names = (await readdir(path.join(this.root, "snapshots"))).filter((name) => name.endsWith(".json") && name !== "index.json");
      const values = await Promise.all(names.map((name) => this.readSnapshot(name.slice(0, -5))));
      return values.filter((value): value is WorkspaceSnapshot => value !== undefined).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, Math.max(1, limit));
    }
  }

  async listResearchRecords(limit = 50): Promise<ResearchRecord[]> {
    try { const value = await this.readJson<{ records?: ResearchRecord[] }>(RECORD_INDEX_FILE); return (value.records ?? []).slice(-Math.max(1, limit)).reverse(); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async queryResearchRecords(query: { projectId?: string; sessionId?: string; since?: string; until?: string; limit?: number } = {}): Promise<ResearchRecord[]> {
    return (await this.listResearchRecords(10000)).filter((record) => (!query.projectId || record.projectId === query.projectId) && (!query.sessionId || record.sessionId === query.sessionId) && (!query.since || record.createdAt >= query.since) && (!query.until || record.createdAt <= query.until)).slice(0, query.limit ?? 100);
  }

  async searchHistory(query: string, options: { limit?: number; offset?: number; kind?: LocalHistoryHit["kind"]; projectId?: string; sessionId?: string; since?: string; until?: string } = {}): Promise<LocalHistoryHit[]> {
    await this.init();
    const terms = String(query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const hits: LocalHistoryHit[] = [];
    const add = (hit: LocalHistoryHit) => {
      if (options.kind && hit.kind !== options.kind) return;
      if (options.projectId && hit.projectId !== options.projectId) return;
      if (options.sessionId && hit.sessionId !== options.sessionId) return;
      if (options.since && hit.createdAt < options.since) return;
      if (options.until && hit.createdAt > options.until) return;
      const text = JSON.stringify(hit.value);
      const lowerText = text.toLocaleLowerCase();
      const index = terms.reduce((current, term) => Math.min(current, lowerText.indexOf(term)), text.length);
      if (index === text.length) return;
      if (!terms.every((term) => lowerText.includes(term))) return;
      const summaryTerm = terms.find((term) => lowerText.includes(term)) ?? terms[0];
      const summaryIndex = lowerText.indexOf(summaryTerm);
      hits.push({ ...hit, summary: text.slice(Math.max(0, summaryIndex - 80), Math.min(text.length, summaryIndex + summaryTerm.length + 120)) });
    };
    for (const record of await this.listResearchRecords(10000)) add({ kind: "research-record", id: record.runId, createdAt: record.createdAt, projectId: record.projectId, sessionId: record.sessionId, summary: "", value: record });
    for (const run of await this.listResearchRuns(10000)) add({ kind: "research-run", id: run.runId, createdAt: run.startedAt, projectId: run.projectId, sessionId: run.sessionId, summary: "", value: run });
    for (const snapshot of await this.listSnapshots(10000)) add({ kind: "workspace-snapshot", id: snapshot.snapshotId, createdAt: snapshot.capturedAt, projectId: snapshot.projectId, summary: "", value: snapshot });
    for (const artifact of await this.listArtifacts(10000)) add({ kind: "artifact", id: artifact.artifactId, createdAt: artifact.lastSeenAt, projectId: artifact.projectId, summary: "", value: artifact });
    for (const session of await this.listSessions(10000)) {
      add({ kind: "session", id: session.sessionId, createdAt: String(session.createdAt ?? ""), projectId: session.projectId, sessionId: session.sessionId, summary: "", value: session });
      for (const event of await this.listSessionEvents(session.sessionId, 10_000)) add({ kind: "session-event", id: `${session.sessionId}:${String((event.event as { seq?: unknown } | undefined)?.seq ?? hits.length)}`, createdAt: typeof event.capturedAt === "string" ? event.capturedAt : String(session.createdAt ?? ""), projectId: session.projectId, sessionId: session.sessionId, summary: "", value: event });
    }
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    return hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit);
  }

  async exportResearchRecords(format: "json" | "jsonl" = "json"): Promise<string> {
    const records = await this.listResearchRecords(10000);
    return format === "jsonl" ? records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "") : JSON.stringify({ schema: "dsh-sci.research-export.v1", records }, null, 2) + "\n";
  }

  async listSessions(limit = 100): Promise<SessionIndex[]> {
    await this.init();
    try {
      const value = await this.readJson<{ sessions?: SessionIndex[] }>(path.join("sessions", "index.json"));
      if (Array.isArray(value.sessions)) return value.sessions.slice(-Math.max(1, limit)).reverse();
      throw Object.assign(new Error("Session index is incomplete"), { code: "ENOENT" });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        const sessionRoot = path.join(this.root, "sessions");
        const entries = await readdir(sessionRoot, { withFileTypes: true });
        const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
          try { return await this.readJson<SessionIndex>(path.join("sessions", entry.name, "session.json")); }
          catch (nested: unknown) { if ((nested as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw nested; }
        }));
        return sessions.filter((session): session is SessionIndex => session !== undefined).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))).slice(0, Math.max(1, limit));
      } catch (nested: unknown) { if ((nested as NodeJS.ErrnoException).code === "ENOENT") return []; throw nested; }
    }
  }

  async listResearchRuns(limit = 100): Promise<ResearchRun[]> {
    await this.init();
    try {
      const value = await this.readJson<{ runs?: ResearchRun[] }>(RESEARCH_RUN_INDEX_FILE);
      return (value.runs ?? []).slice(-Math.max(1, limit)).reverse();
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async listSessionEvents(sessionId: string, limit = 100): Promise<SessionEventRecord[]> {
    await this.init();
    const file = path.join(this.root, "sessions", sessionDirectoryName(String(sessionId)), "events.jsonl");
    try {
      const lines = decryptMetadataText(await readFile(file, "utf8"), this.metadataPassphrase).split(/\r?\n/).filter(Boolean);
      const events: SessionEventRecord[] = [];
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) events.push(value as SessionEventRecord);
        } catch {
          // Ignore a truncated final JSONL line so history remains readable after interruption.
        }
      }
      return events.slice(-Math.max(1, limit));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async listArtifacts(limit = 1000): Promise<ArtifactRecord[]> {
    await this.init();
    try {
      const value = await this.readJson<{ artifacts?: ArtifactRecord[] }>(ARTIFACT_INDEX_FILE);
      return (value.artifacts ?? []).slice(-Math.max(1, limit)).reverse();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async exportAuditBundle(): Promise<string> {
    await this.init();
    const sessions = await this.listSessions(10000);
    const sessionEvents = Object.fromEntries(await Promise.all(sessions.map(async (session) => [session.sessionId, await this.listSessionEvents(session.sessionId, 10000)])));
    const bundle: AuditBundle = { schema: "dsh-sci.audit-bundle.v1", exportedAt: new Date().toISOString(), status: await this.readStatus(), settings: await this.readSettings(), sessions, sessionEvents, researchRuns: await this.listResearchRuns(10000), records: await this.listResearchRecords(10000), snapshots: await this.listSnapshots(10000), backupPublications: await this.listBackupPublications(10000), backupQueue: await this.listBackupQueue(10000), artifacts: await this.listArtifacts(10000) };
    return `${JSON.stringify(bundle, null, 2)}\n`;
  }

  async listBackupPublications(limit = 50): Promise<BackupPublication[]> {
    await this.init();
    try {
      const value = await this.readJson<{ publications?: BackupPublication[] }>(BACKUP_PUBLICATION_FILE);
      return (value.publications ?? []).slice(-Math.max(1, limit)).reverse();
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async listBackupQueue(limit = 100): Promise<BackupQueueItem[]> {
    await this.init();
    try {
      const value = await this.readJson<{ items?: BackupQueueItem[] }>(BACKUP_QUEUE_FILE);
      return (value.items ?? []).slice(-Math.max(1, limit)).reverse();
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async publishMetadataManifest(publisher: BackupPublisher, options: { projectId?: string; workspaceSnapshotIds?: string[]; researchRunIds?: string[] } = {}): Promise<{ manifest: BackupManifest; uploaded: boolean }> {
    return this.mutate(() => this.publishMetadataManifestInternal(publisher, options));
  }

  private async publishMetadataManifestInternal(publisher: BackupPublisher, options: { projectId?: string; workspaceSnapshotIds?: string[]; researchRunIds?: string[] } = {}): Promise<{ manifest: BackupManifest; uploaded: boolean }> {
    await this.init();
    const snapshots = await this.listSnapshots(10000);
    const records = await this.listResearchRecords(10000);
    const projectId = options.projectId ?? this.status.projectId ?? snapshots[0]?.projectId ?? "unknown";
    const publicationId = randomUUID();
    const attemptedAt = new Date().toISOString();
    const pending: BackupPublication = { schema: "dsh-sci.backup-publication.v1", publicationId, projectId, provider: publisher.provider, status: "pending", uploaded: false, attemptedAt };
    await this.writeBackupPublications([...(await this.listBackupPublications(10000)).reverse(), pending]);
    try {
      const result = await publisher.publish({ schema: "dsh-sci.backup-manifest.v1", projectId, workspaceSnapshotIds: options.workspaceSnapshotIds ?? snapshots.map((snapshot) => snapshot.snapshotId), researchRunIds: options.researchRunIds ?? records.map((record) => record.runId), contentPolicy: "metadata-only" });
      const completed: BackupPublication = { ...pending, manifestId: result.manifest.manifestId, status: "published", uploaded: result.uploaded, completedAt: new Date().toISOString() };
      await this.replaceBackupPublication(completed);
      return result;
    } catch (error: unknown) {
      const failed: BackupPublication = { ...pending, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      await this.replaceBackupPublication(failed);
      throw error;
    }
  }

  async cleanup(options: { before?: string; maxSnapshots?: number; maxResearchRecords?: number } = {}): Promise<CleanupResult> {
    return this.mutate(() => this.cleanupInternal(options));
  }

  private async cleanupInternal(options: { before?: string; maxSnapshots?: number; maxResearchRecords?: number } = {}): Promise<CleanupResult> {
    await this.init();
    this.ensureUnlocked();
    const configuredBefore = this.settings.retentionDays ? new Date(Date.now() - this.settings.retentionDays * 86_400_000).toISOString() : undefined;
    const before = options.before ? Date.parse(options.before) : configuredBefore ? Date.parse(configuredBefore) : undefined;
    const snapshots = await this.listSnapshots(10000);
    const keepSnapshots = snapshots.filter((item) => before === undefined || Date.parse(item.capturedAt) >= before).slice(0, options.maxSnapshots ?? this.settings.maxSnapshots);
    const removeSnapshots = snapshots.filter((item) => !keepSnapshots.some((keep) => keep.snapshotId === item.snapshotId));
    await Promise.all(removeSnapshots.map((item) => rm(path.join(this.root, "snapshots", `${item.snapshotId}.json`), { force: true })));
    const records = await this.listResearchRecords(10000);
    const maxRecords = options.maxResearchRecords ?? this.settings.maxResearchRecords;
    const keepRecords = records.filter((item) => before === undefined || Date.parse(item.createdAt) >= before).slice(0, maxRecords);
    const removeRecords = records.filter((item) => !keepRecords.some((keep) => keep.runId === item.runId));
    await Promise.all(removeRecords.map((item) => rm(path.join(this.root, "runs", item.runId), { recursive: true, force: true })));
    const researchRuns = await this.listResearchRuns(10000);
    const keepResearchRuns = researchRuns.filter((run) => before === undefined || Date.parse(run.disposedAt ?? run.lastObservedAt ?? run.startedAt) >= before);
    const removeResearchRuns = researchRuns.filter((run) => !keepResearchRuns.some((keep) => keep.runId === run.runId));
    await Promise.all(removeResearchRuns.map((run) => rm(path.join(this.root, "research-runs", run.runId), { recursive: true, force: true })));
    let sessionsRemoved = 0;
    if (before !== undefined) {
      const sessionsRoot = path.join(this.root, "sessions");
      try {
        const sessionEntries = await readdir(sessionsRoot, { withFileTypes: true });
        for (const sessionEntry of sessionEntries.filter((entry) => entry.isDirectory())) {
          const sessionId = sessionEntry.name;
          try {
            const session = await this.readJson<{ disposedAt?: string; createdAt?: string }>(path.join("sessions", sessionId, "session.json"));
            const timestamp = Date.parse(session.disposedAt ?? session.createdAt ?? "");
            if (Number.isFinite(timestamp) && timestamp < before) { await rm(path.join(sessionsRoot, sessionId), { recursive: true, force: true }); sessionsRemoved += 1; }
          } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const artifacts = await this.listArtifacts(10000);
    const keepArtifacts = artifacts.filter((artifact) => before === undefined || Date.parse(artifact.lastSeenAt) >= before);
    if (keepArtifacts.length !== artifacts.length) await this.writeJson(ARTIFACT_INDEX_FILE, { schema: "dsh-sci.artifact-index.v1", artifacts: keepArtifacts.reverse() });
    await this.writeJson(SNAPSHOT_INDEX_FILE, { schema: "dsh-sci.workspace-snapshot-index.v1", snapshots: keepSnapshots.reverse() });
    await this.writeJson(RECORD_INDEX_FILE, { schema: "dsh-sci.research-record-index.v1", records: keepRecords.reverse() });
    await this.writeJson(RESEARCH_RUN_INDEX_FILE, { schema: "dsh-sci.research-run-index.v1", runs: keepResearchRuns.reverse() });
    await this.rebuildSessionIndex();
    return { snapshotsRemoved: removeSnapshots.length, recordsRemoved: removeRecords.length, sessionsRemoved };
  }

  async readStatus(): Promise<CaptureStatus> {
    await this.init();
    if (this.metadataLocked) return { ...this.status };
    try { return { ...this.status, ...await this.readJson<CaptureStatus>(STATUS_FILE) }; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.status; throw error; }
  }
  async markError(error: unknown): Promise<void> { await this.mutate(async () => { await this.init(); if (this.metadataLocked) return; this.status = { ...this.status, state: "error", error: error instanceof Error ? error.message : String(error) }; await this.writeJson(STATUS_FILE, this.status); }); }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const target = path.join(this.root, file); await mkdir(path.dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, serializeMetadataJson(value, this.metadataPassphrase), "utf8"); await rename(temporary, target);
  }
  private async readJson<T>(file: string): Promise<T> { const target = path.join(this.root, file); const info = await stat(target); if (info.size > 32 * 1024 * 1024) { await rm(target, { force: true }); throw Object.assign(new Error("Oversized metadata index reset"), { code: "ENOENT" }); } return parseMetadataJson<T>(await readFile(target, "utf8"), this.metadataPassphrase); }
  private ensureUnlocked(): void { if (this.metadataLocked) throw new MetadataLockedError(this.status.error); }
  private async writeBackupPublications(publications: BackupPublication[]): Promise<void> { await this.writeJson(BACKUP_PUBLICATION_FILE, { schema: "dsh-sci.backup-publication-index.v1", publications: publications.slice(-1000) }); }
  private async rebuildSessionIndex(): Promise<void> {
    const sessionsRoot = path.join(this.root, "sessions");
    const sessions: SessionIndex[] = [];
    try {
      const entries = await readdir(sessionsRoot, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isDirectory())) {
        try { sessions.push(await this.readJson<SessionIndex>(path.join("sessions", entry.name, "session.json"))); }
        catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    sessions.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    await this.writeJson(path.join("sessions", "index.json"), { schema: "dsh-sci.session-index.v1", sessions });
  }
  private async replaceBackupPublication(publication: BackupPublication): Promise<void> { const publications = (await this.listBackupPublications(10000)).reverse().filter((item) => item.publicationId !== publication.publicationId); await this.writeBackupPublications([...publications, publication]); }
  private async writeResearchRecord(snapshot: WorkspaceSnapshot, options: { sessionId?: string; provider?: string; model?: string; inputDigest?: string }): Promise<void> {
    const newest = await this.listResearchRecords(10000);
    if (newest[0]?.workspaceSnapshotId === snapshot.snapshotId && newest[0]?.sessionId === options.sessionId) return;
    const changedFiles = snapshot.changes.added.length + snapshot.changes.removed.length + snapshot.changes.changed.length;
    const record: ResearchRecord = { schema: "dsh-sci.research-record.v1", runId: randomUUID(), projectId: snapshot.projectId, status: changedFiles > 0 ? "completed" : "partial", createdAt: snapshot.capturedAt, workspaceSnapshotId: snapshot.snapshotId, sessionId: options.sessionId, inputs: { status: "unverified", exactInputBaseline: false, digest: options.inputDigest }, execution: { source: "background-workspace-observation", toolAttribution: "unavailable", provider: options.provider, model: options.model }, outputs: { status: "background-captured", files: snapshot.files.length, changedFiles } };
    await this.writeJson(path.join("runs", `${record.runId}`, "research-record.json"), record);
    await this.writeJson(RECORD_INDEX_FILE, { schema: "dsh-sci.research-record-index.v1", projectId: record.projectId, records: [...newest.reverse(), record].slice(-this.settings.maxResearchRecords) });
  }
  private async enforceRetention(): Promise<void> {
    const snapshots = await this.listSnapshots(10000);
    const records = await this.listResearchRecords(10000);
    const before = this.settings.retentionDays ? new Date(Date.now() - this.settings.retentionDays * 86_400_000).toISOString() : undefined;
    if (before !== undefined || snapshots.length > this.settings.maxSnapshots || records.length > this.settings.maxResearchRecords) await this.cleanupInternal({ before, maxSnapshots: this.settings.maxSnapshots, maxResearchRecords: this.settings.maxResearchRecords });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

export class WorkspaceCaptureMonitor {
  private timer?: NodeJS.Timeout; private running?: Promise<void>;
  constructor(private readonly store: CaptureStore, private readonly workspace: string, private readonly intervalMs = 15_000, private readonly options: { provider?: string; model?: string } = {}) {}
  async start(): Promise<void> { await this.tick(); this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private tick(): Promise<void> { if (this.running) return this.running; this.running = this.store.snapshot(this.workspace, this.options).then(() => undefined).catch(async (error) => { if ((await this.store.readStatus()).state !== "disabled") await this.store.markError(error); }).finally(() => { this.running = undefined; }); return this.running; }
}
