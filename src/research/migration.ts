import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptMetadataText, metadataPassphraseFromEnvironment, parseMetadataJson, serializeMetadataJson } from "../metadata-crypto.js";
import { contentDigest } from "./content-digest.js";
import { ResearchRepository } from "./repository.js";
import type { ResearchProject } from "./domain.js";
import { assertCompatibleResearchStore, researchStoreFormatFile, type ResearchStoreFormat } from "./store-format.js";

export type MigrationCheckpoint = "prepared" | "backed-up" | "staged" | "recovered" | "before-commit" | "committed";
export interface ResearchMigrationOptions { metadataPassphrase?: string; signal?: AbortSignal; /** Offline test fault injection, never taken from bridge/IPC. */ checkpoint?: (phase: MigrationCheckpoint) => void | Promise<void>; }
export interface ResearchMigrationResult { schema: "dsh-sci.research-migration-result.v1"; ok: true; migrationId: string; sourceHash: string; backupRoot: string; targetRoot: string; projects: number; recoveredRuns: number; warnings: string[]; }
interface FileEntry { path: string; bytes: number; sha256: string; }
interface Journal { schema: "dsh-sci.research-migration.v1"; migrationId: string; source: string; target: string; sourceFiles: FileEntry[]; sourceHash: string; phase: "prepared" | "backed-up" | "committed"; }
const digest = (value: unknown) => contentDigest(value);
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const exists = async (file: string) => { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
const regularDirectory = async (directory: string) => { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Migration requires regular directories"); return realpath(directory); };
async function assertNoLinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name), info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("Migration refuses symbolic links or junctions");
    if (info.isDirectory()) await assertNoLinks(file);
    else if (!info.isFile()) throw new Error("Migration requires regular files");
  }
}
async function inventory(root: string, signal?: AbortSignal): Promise<FileEntry[]> {
  const files: FileEntry[] = []; let totalBytes = 0;
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      signal?.throwIfAborted(); const name = path.join(relative, entry.name), file = path.join(root, name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error("Migration refuses symbolic links or junctions");
      if (info.isDirectory()) await walk(name); else if (info.isFile()) {
        if (name.endsWith(".tmp")) throw new Error("Research migration found an incomplete temporary write");
        if (files.length >= 50_000 || info.size > 128 * 1024 * 1024 || (totalBytes += info.size) > 1024 * 1024 * 1024) throw new Error("Migration exceeds the 50,000-file, 128 MiB/file or 1 GiB total bound");
        const bytes = await readFile(file); if (bytes.length !== info.size) throw new Error("Research store changed during migration snapshot"); files.push({ path: name.replaceAll(path.sep, "/"), bytes: bytes.length, sha256: hash(bytes) });
      } else throw new Error("Migration requires regular files");
    }
  };
  await walk(""); return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function atomicJson(file: string, value: unknown, passphrase?: string): Promise<void> { const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, serializeMetadataJson(value, passphrase), { flag: "wx" }); await rename(temporary, file); }
async function copySnapshot(source: string, target: string, files: FileEntry[], signal?: AbortSignal): Promise<void> {
  for (const entry of files) {
    signal?.throwIfAborted();
    const destination = path.join(target, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!(await exists(destination))) {
      const bytes = await readFile(path.join(source, entry.path));
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error("Migration source differs from its prepared inventory");
      // Temporary bytes stay outside the snapshot so an interrupted backup resumes cleanly.
      const temporary = path.join(path.dirname(target), `copy-${randomUUID()}.tmp`);
      await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, destination);
    }
    const bytes = await readFile(destination); if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error("Migration snapshot differs from its source inventory");
  }
}
async function validateJsonRecords(root: string, files: FileEntry[], passphrase?: string): Promise<void> {
  for (const entry of files.filter((item) => /\.jsonl?$/u.test(item.path) && item.path !== "index.json" && item.path !== researchStoreFormatFile)) {
    const text = decryptMetadataText(await readFile(path.join(root, entry.path), "utf8"), passphrase);
    for (const line of entry.path.endsWith(".jsonl") ? text.split(/\r?\n/u).filter(Boolean) : [text]) {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid research metadata object");
      const version = /^(dsh-sci\..+)\.v(\d+)$/u.exec(value.schema ?? "");
      const maximum = ["dsh-sci.research-budget", "dsh-sci.research-memory-index", "dsh-sci.research-task-result"].includes(version?.[1] ?? "") ? 2 : 1;
      if (value.schema && (!version || Number(version[2]) > maximum)) throw new Error("Research record format is newer or incompatible; downgrade requires the pre-migration backup");
    }
  }
}

function contains(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

/** Offline, copy-first migration. It preserves an immutable pre-migration backup and never approves or executes research work. */
export async function migrateResearchStore(sourceInput: string, targetInput: string, options: ResearchMigrationOptions = {}): Promise<ResearchMigrationResult> {
  const source = await regularDirectory(path.resolve(sourceInput));
  const requestedTarget = path.resolve(targetInput), parent = await regularDirectory(path.dirname(requestedTarget)), target = path.join(parent, path.basename(requestedTarget));
  const control = `${target}.migration`, backup = path.join(control, "before");
  if ([target, control].some((item) => contains(source, item) || contains(item, source))) throw new Error("Migration source and target must not overlap");
  const passphrase = options.metadataPassphrase ?? metadataPassphraseFromEnvironment(); await assertCompatibleResearchStore(source, passphrase);
  const files = await inventory(source, options.signal), sourceHash = digest(files), journalFile = path.join(control, "journal.json");
  let journal: Journal;
  if (await exists(control)) {
    await regularDirectory(control); await assertNoLinks(control);
    journal = parseMetadataJson<Journal>(await readFile(journalFile, "utf8"), passphrase);
    if (!journal || journal.schema !== "dsh-sci.research-migration.v1" || !/^migration-[a-f0-9-]{36}$/u.test(journal.migrationId) || journal.source !== source || journal.target !== target || journal.sourceHash !== sourceHash || digest(journal.sourceFiles) !== sourceHash || !["prepared", "backed-up", "committed"].includes(journal.phase)) throw new Error("Migration journal does not match the immutable source snapshot");
    if (journal.phase !== "prepared" && (!(await exists(backup)) || digest(await inventory(backup, options.signal)) !== sourceHash)) throw new Error("Pre-migration backup hash mismatch");
  } else {
    if (await exists(target)) throw new Error("Migration target must not exist");
    await mkdir(control);
    journal = { schema: "dsh-sci.research-migration.v1", migrationId: `migration-${randomUUID()}`, source, target, sourceFiles: files, sourceHash, phase: "prepared" };
    await atomicJson(journalFile, journal, passphrase);
  }
  const migrationId = journal.migrationId;
  if (await exists(target)) {
    await regularDirectory(target); await assertCompatibleResearchStore(target, passphrase);
    const marker = parseMetadataJson<ResearchStoreFormat>(await readFile(path.join(target, researchStoreFormatFile), "utf8"), passphrase);
    const result = parseMetadataJson<ResearchMigrationResult>(await readFile(path.join(control, "result.json"), "utf8"), passphrase);
    if (marker.migrationId !== migrationId || result.migrationId !== migrationId || result.sourceHash !== sourceHash || result.targetRoot !== target || result.backupRoot !== backup || result.ok !== true || journal.phase === "prepared") throw new Error("Migration target or result belongs to a different operation");
    await atomicJson(journalFile, { ...journal, phase: "committed" }, passphrase);
    return result;
  }
  if (journal.phase === "committed") throw new Error("Committed migration target is missing");
  const checkpoint = async (phase: MigrationCheckpoint) => { options.signal?.throwIfAborted(); await options.checkpoint?.(phase); options.signal?.throwIfAborted(); };
  await checkpoint("prepared");
  await mkdir(backup, { recursive: true }); await copySnapshot(source, backup, files, options.signal); if (digest(await inventory(backup, options.signal)) !== sourceHash) throw new Error("Pre-migration backup hash mismatch"); await atomicJson(journalFile, { ...journal, phase: "backed-up" }, passphrase); await checkpoint("backed-up");
  await validateJsonRecords(backup, files, passphrase);
  // A retry keeps partial stages as diagnostics and derives a fresh stage from the immutable backup.
  const stage = path.join(control, `stage-${randomUUID()}`);
  await mkdir(stage); await copySnapshot(backup, stage, files, options.signal);
  const marker: ResearchStoreFormat = { schema: "dsh-sci.research-store-format.v1", formatVersion: 1, minimumReaderVersion: 1, state: "migrating", migrationId }; await atomicJson(path.join(stage, researchStoreFormatFile), marker, passphrase); await checkpoint("staged");
  const projects: ResearchProject[] = [];
  await mkdir(path.join(stage, "projects"), { recursive: true });
  const directories: Dirent[] = await readdir(path.join(stage, "projects"), { withFileTypes: true });
  for (const directory of directories) {
    if (!directory.isDirectory()) throw new Error("Unexpected file in research projects directory");
    const project = parseMetadataJson<ResearchProject>(await readFile(path.join(stage, "projects", directory.name, "project.json"), "utf8"), passphrase);
    if (project.schema !== "dsh-sci.research-project.v1" || encodeURIComponent(project.projectId) !== directory.name || typeof project.updatedAt !== "string" || !Number.isFinite(Date.parse(project.updatedAt))) throw new Error("Invalid research project during migration"); projects.push(project);
  }
  await atomicJson(path.join(stage, "index.json"), { schema: "dsh-sci.research-project-index.v1", projects: projects.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) }, passphrase);
  const repository = new ResearchRepository(stage, { metadataPassphrase: passphrase, migrationId });
  for (const project of projects) await repository.exportProject(project.projectId);
  await repository.listMemory(); await repository.listMemoryIndexVersions();
  const recovered = await repository.recoverInterruptedExperiments();
  for (const project of projects) await repository.exportProject(project.projectId);
  await checkpoint("recovered");
  const result: ResearchMigrationResult = { schema: "dsh-sci.research-migration-result.v1", ok: true, migrationId, sourceHash, backupRoot: backup, targetRoot: target, projects: projects.length, recoveredRuns: recovered.length, warnings: ["Downgrade requires the unchanged source or pre-migration backup; older applications cannot be assumed to read the new format.", "Migration does not grant approvals or execute experiments.", "Workspace code, inputs and artifacts outside the research root are not copied; preserve their original paths.", "Close all writers before migration; hash checks are not a cross-process lock."] }; await atomicJson(path.join(control, "result.json"), result, passphrase); await checkpoint("before-commit");
  if (digest(await inventory(source, options.signal)) !== sourceHash || digest(await inventory(backup, options.signal)) !== sourceHash) throw new Error("Source or backup changed before migration commit");
  await atomicJson(path.join(stage, researchStoreFormatFile), { ...marker, state: "ready" }, passphrase);
  if (await exists(target)) throw new Error("Migration target appeared before commit");
  await rename(stage, target); await checkpoint("committed");
  await atomicJson(journalFile, { ...journal, phase: "committed" }, passphrase); return result;
}
