import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { listWorkspace } from "./workspace.js";

export interface WorkspaceSnapshot {
  schema: "dsh-sci.workspace-snapshot.v1";
  snapshotId: string;
  workspaceRoot: string;
  capturedAt: string;
  files: Awaited<ReturnType<typeof listWorkspace>>;
  changes: { added: string[]; removed: string[]; changed: string[] };
}

export interface ResearchRecord {
  schema: "dsh-sci.research-record.v1";
  runId: string;
  projectId: string;
  status: "completed" | "partial";
  createdAt: string;
  workspaceSnapshotId: string;
  inputs: { status: "unverified"; exactInputBaseline: false };
  execution: { source: "background-workspace-observation"; toolAttribution: "unavailable" };
  outputs: { status: "background-captured"; files: number };
}

export interface CaptureStatus {
  schema: "dsh-sci.capture-status.v1";
  state: "idle" | "capturing" | "error";
  workspaceRoot?: string;
  lastSnapshot?: string;
  lastCapturedAt?: string;
  error?: string;
}

const STATUS_FILE = "capture-status.json";
const INDEX_FILE = "workspace-index.json";

/** Local workspace metadata snapshots. It never uploads source files. */
export class CaptureStore {
  readonly root: string;
  private status: CaptureStatus = { schema: "dsh-sci.capture-status.v1", state: "idle" };
  private previous = new Map<string, { sha256?: string; bytes: number; kind: string }>();
  private initialized = false;

  constructor(root: string) { this.root = path.resolve(root); }
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(path.join(this.root, "snapshots"), { recursive: true });
    await mkdir(path.join(this.root, "runs"), { recursive: true });
    try {
      const index = JSON.parse(await readFile(path.join(this.root, INDEX_FILE), "utf8")) as { files?: Awaited<ReturnType<typeof listWorkspace>> };
      this.previous = new Map((index.files ?? []).map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes, kind: file.kind }]));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try { this.status = JSON.parse(await readFile(path.join(this.root, STATUS_FILE), "utf8")) as CaptureStatus; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.initialized = true;
    await this.writeJson(STATUS_FILE, this.status);
  }
  async snapshot(workspaceRoot: string): Promise<WorkspaceSnapshot> {
    await this.init();
    const files = await listWorkspace(workspaceRoot, 12);
    const current = new Map(files.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes, kind: file.kind }]));
    const added = [...current.keys()].filter((key) => !this.previous.has(key));
    const removed = [...this.previous.keys()].filter((key) => !current.has(key));
    const changed = [...current.keys()].filter((key) => {
      const before = this.previous.get(key); const after = current.get(key);
      return before !== undefined && after !== undefined && (before.bytes !== after.bytes || before.sha256 !== after.sha256 || before.kind !== after.kind);
    });
    const snapshotId = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    const value: WorkspaceSnapshot = { schema: "dsh-sci.workspace-snapshot.v1", snapshotId, workspaceRoot: path.resolve(workspaceRoot), capturedAt: new Date().toISOString(), files, changes: { added, removed, changed } };
    await this.writeJson(path.join("snapshots", `${snapshotId}.json`), value);
    await this.writeJson(INDEX_FILE, { schema: "dsh-sci.workspace-index.v1", latest: snapshotId, capturedAt: value.capturedAt, workspaceRoot: value.workspaceRoot, files });
    this.previous = current;
    this.status = { ...this.status, state: "capturing", workspaceRoot: value.workspaceRoot, lastSnapshot: snapshotId, lastCapturedAt: value.capturedAt, error: undefined };
    await this.writeJson(STATUS_FILE, this.status);
    await this.writeResearchRecord(value);
    return value;
  }
  async readIndex(): Promise<WorkspaceSnapshot | undefined> {
    try {
      const index = JSON.parse(await readFile(path.join(this.root, INDEX_FILE), "utf8")) as { latest?: string; workspaceRoot?: string; capturedAt?: string; files?: WorkspaceSnapshot["files"] };
      if (!index.latest || !index.workspaceRoot || !index.capturedAt || !index.files) return undefined;
      return { schema: "dsh-sci.workspace-snapshot.v1", snapshotId: index.latest, workspaceRoot: index.workspaceRoot, capturedAt: index.capturedAt, files: index.files, changes: { added: [], removed: [], changed: [] } };
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async listResearchRecords(limit = 50): Promise<ResearchRecord[]> {
    const indexFile = path.join(this.root, "research-records.json");
    try {
      const value = JSON.parse(await readFile(indexFile, "utf8")) as { records?: ResearchRecord[] };
      return (value.records ?? []).slice(-Math.max(1, limit)).reverse();
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async readStatus(): Promise<CaptureStatus> {
    try { return JSON.parse(await readFile(path.join(this.root, STATUS_FILE), "utf8")) as CaptureStatus; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.status; throw error; }
  }
  async markError(error: unknown): Promise<void> { this.status = { ...this.status, state: "error", error: error instanceof Error ? error.message : String(error) }; await this.writeJson(STATUS_FILE, this.status); }
  private async writeJson(file: string, value: unknown): Promise<void> {
    const target = path.join(this.root, file); await mkdir(path.dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, target);
  }
  private async writeResearchRecord(snapshot: WorkspaceSnapshot): Promise<void> {
    const records = await this.listResearchRecords(1000);
    const previous = records[0];
    if (previous?.workspaceSnapshotId === snapshot.snapshotId) return;
    const record: ResearchRecord = {
      schema: "dsh-sci.research-record.v1", runId: randomUUID(), projectId: createHash("sha256").update(snapshot.workspaceRoot).digest("hex").slice(0, 32), status: snapshot.changes.added.length + snapshot.changes.removed.length + snapshot.changes.changed.length > 0 ? "completed" : "partial", createdAt: snapshot.capturedAt, workspaceSnapshotId: snapshot.snapshotId,
      inputs: { status: "unverified", exactInputBaseline: false }, execution: { source: "background-workspace-observation", toolAttribution: "unavailable" }, outputs: { status: "background-captured", files: snapshot.files.length },
    };
    await this.writeJson(path.join("runs", `${record.runId}`, "research-record.json"), record);
    await this.writeJson("research-records.json", { schema: "dsh-sci.research-record-index.v1", projectId: record.projectId, records: [...records.reverse(), record].slice(-1000) });
  }
}

export class WorkspaceCaptureMonitor {
  private timer?: NodeJS.Timeout; private running?: Promise<void>;
  constructor(private readonly store: CaptureStore, private readonly workspace: string, private readonly intervalMs = 15_000) {}
  async start(): Promise<void> { await this.tick(); this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private tick(): Promise<void> { if (this.running) return this.running; this.running = this.store.snapshot(this.workspace).then(() => undefined).catch((error) => this.store.markError(error)).finally(() => { this.running = undefined; }); return this.running; }
}
