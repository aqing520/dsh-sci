import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BackupPublisher } from "./services.js";
import type { CaptureStore } from "./capture.js";
import { parseMetadataJson, serializeMetadataJson } from "./metadata-crypto.js";

export type BackupQueueState = "queued" | "running" | "retrying" | "published" | "failed";

export interface BackupQueueItem {
  schema: "dsh-sci.backup-queue-item.v1";
  jobId: string;
  projectId: string;
  workspaceSnapshotIds: string[];
  researchRunIds: string[];
  state: BackupQueueState;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  manifestId?: string;
  uploaded?: boolean;
  lastError?: string;
  completedAt?: string;
}

export interface BackupQueueResult {
  processed: number;
  published: number;
  retrying: number;
  failed: number;
  pending: number;
}

const QUEUE_FILE = path.join("backups", "queue.json");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error ? (error as { retryable?: unknown }).retryable !== false : true;
}

/** Durable, provider-neutral backup work queue. It only calls the injected publisher. */
export class BackupQueue {
  readonly root: string;
  private readonly queueFile: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private processing?: Promise<BackupQueueResult>;

  constructor(private readonly store: CaptureStore, private readonly publisher: BackupPublisher, options: { maxAttempts?: number; baseDelayMs?: number } = {}) {
    this.root = store.root;
    this.queueFile = path.join(this.root, QUEUE_FILE);
    this.maxAttempts = Math.max(1, Math.min(10, Math.floor(options.maxAttempts ?? 3)));
    this.baseDelayMs = Math.max(0, Math.min(86_400_000, Math.floor(options.baseDelayMs ?? 1_000)));
  }

  async list(limit = 100): Promise<BackupQueueItem[]> {
    return this.store.listBackupQueue(limit);
  }

  async exportState(): Promise<string> {
    return `${JSON.stringify({ schema: "dsh-sci.backup-queue.v1", items: await this.read() }, null, 2)}\n`;
  }

  async retry(jobId: string): Promise<BackupQueueItem> {
    if (this.processing) await this.processing;
    const items = await this.read();
    const index = items.findIndex((item) => item.jobId === jobId);
    if (index < 0) throw new Error("Backup job not found");
    const current = items[index];
    if (current.state !== "failed") throw new Error("Only failed backup jobs can be retried");
    const retried: BackupQueueItem = { ...current, state: "queued", attempts: 0, updatedAt: new Date().toISOString(), nextAttemptAt: undefined, lastError: undefined, completedAt: undefined, manifestId: undefined, uploaded: undefined };
    items[index] = retried;
    await this.write(items);
    return retried;
  }

  async enqueue(options: { projectId?: string; force?: boolean } = {}): Promise<BackupQueueItem> {
    if (this.processing) await this.processing;
    await this.store.readSettings();
    const items = await this.read();
    if (!options.force) {
      const existing = items.find((item) => ["queued", "running", "retrying"].includes(item.state));
      if (existing) return existing;
    }
    const status = await this.store.readStatus();
    const snapshots = await this.store.listSnapshots(10_000);
    const records = await this.store.listResearchRecords(10_000);
    const now = new Date().toISOString();
    const item: BackupQueueItem = {
      schema: "dsh-sci.backup-queue-item.v1",
      jobId: randomUUID(),
      projectId: options.projectId ?? status.projectId ?? "unknown",
      workspaceSnapshotIds: snapshots.map((snapshot) => snapshot.snapshotId),
      researchRunIds: records.map((record) => record.runId),
      state: "queued",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      createdAt: now,
      updatedAt: now,
    };
    await this.write([...items, item]);
    return item;
  }

  async process(options: { now?: Date } = {}): Promise<BackupQueueResult> {
    if (this.processing) return this.processing;
    this.processing = this.processInternal(options);
    try { return await this.processing; }
    finally { this.processing = undefined; }
  }

  async waitForIdle(timeoutMs = 5_000): Promise<boolean> {
    const active = this.processing;
    if (!active) return true;
    const timeout = Math.max(0, Math.floor(timeoutMs));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([active, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout); })]);
      return this.processing === undefined;
    } finally { if (timer) clearTimeout(timer); }
  }

  private async processInternal(options: { now?: Date } = {}): Promise<BackupQueueResult> {
    const now = options.now ?? new Date();
    let items = await this.read();
    let processed = 0;
    let published = 0;
    let retrying = 0;
    let failed = 0;
    for (let index = 0; index < items.length; index += 1) {
      let item = items[index];
      if (item.state === "published" || item.state === "failed") continue;
      if (item.state === "retrying" && item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now.getTime()) continue;
      if (item.state === "running") {
        item = { ...item, state: item.attempts < item.maxAttempts ? "retrying" : "failed", updatedAt: now.toISOString(), nextAttemptAt: item.attempts < item.maxAttempts ? now.toISOString() : undefined, lastError: item.lastError ?? "Previous backup worker stopped before completion" };
        items[index] = item;
        if (item.state === "failed") { failed += 1; continue; }
      }
      item = { ...item, state: "running", attempts: item.attempts + 1, updatedAt: now.toISOString(), nextAttemptAt: undefined };
      items[index] = item;
      await this.write(items);
      processed += 1;
      try {
        const result = await this.store.publishMetadataManifest(this.publisher, { projectId: item.projectId, workspaceSnapshotIds: item.workspaceSnapshotIds, researchRunIds: item.researchRunIds });
        const completed = { ...item, state: "published" as const, manifestId: result.manifest.manifestId, uploaded: result.uploaded, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: undefined };
        items[index] = completed;
        published += 1;
      } catch (error) {
        const canRetry = isRetryable(error) && item.attempts < item.maxAttempts;
        const retryAt = new Date(now.getTime() + this.baseDelayMs * (2 ** Math.max(0, item.attempts - 1))).toISOString();
        items[index] = { ...item, state: canRetry ? "retrying" : "failed", updatedAt: new Date().toISOString(), nextAttemptAt: canRetry ? retryAt : undefined, lastError: errorMessage(error), completedAt: canRetry ? undefined : new Date().toISOString() };
        if (canRetry) retrying += 1;
        else failed += 1;
      }
      await this.write(items);
    }
    const pending = items.filter((item) => ["queued", "running", "retrying"].includes(item.state)).length;
    return { processed, published, retrying, failed, pending };
  }

  private async read(): Promise<BackupQueueItem[]> {
    try {
      const value = parseMetadataJson<{ items?: BackupQueueItem[] }>(await readFile(this.queueFile, "utf8"), this.store.metadataPassphrase);
      return Array.isArray(value.items) ? value.items : [];
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(items: BackupQueueItem[]): Promise<void> {
    await mkdir(path.dirname(this.queueFile), { recursive: true });
    const temporary = `${this.queueFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, serializeMetadataJson({ schema: "dsh-sci.backup-queue.v1", items: items.slice(-1000) }, this.store.metadataPassphrase), "utf8");
    await rename(temporary, this.queueFile);
  }
}

