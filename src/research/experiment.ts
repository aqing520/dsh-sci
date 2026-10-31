import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { realpath, stat, readdir, open } from "node:fs/promises";
import { spawnOwnedProcess } from "../owned-process.js";

export interface ExperimentDefinition {
  schema: "dsh-sci.experiment-definition.v1";
  experimentId: string;
  projectId: string;
  planId?: string;
  taskId?: string;
  designId?: string;
  designContentHash?: string;
  codeBundleId?: string;
  hypothesisIds: string[];
  codePaths?: string[];
  codeManifest?: ExperimentFileSnapshot[];
  inputManifest?: ExperimentFileSnapshot[];
  proposalContentHash?: string;
  approval?: ExperimentApproval;
  title: string;
  command: string;
  args: string[];
  cwd?: string;
  inputPaths: string[];
  outputPaths: string[];
  randomSeed?: number;
  timeoutMs: number;
  createdAt: string;
}

export interface ExperimentApproval {
  approvedAt: string;
  proposalContentHash: string;
  bindingHash: string;
  codeManifest: ExperimentFileSnapshot[];
  inputManifest: ExperimentFileSnapshot[];
}

export interface ExperimentReviewFile extends ExperimentFileSnapshot {
  kind: "code" | "input";
  text: string;
  truncated: boolean;
}

/** Trusted review reads only proposal-declared files, never a caller supplied path. */
export async function readExperimentReviewFiles(definition: ExperimentDefinition, policy: ExperimentExecutionPolicy = {}): Promise<ExperimentReviewFile[]> {
  const current = await captureExperimentContent(definition, policy);
  if (definition.proposalContentHash && !sameExperimentContent({ ...definition, bindingHash: definition.proposalContentHash }, current)) throw new Error("experiment content changed; create a new proposal before review");
  const result: ExperimentReviewFile[] = [];
  let remaining = 640 * 1024;
  for (const kind of ["code", "input"] as const) {
    for (const snapshot of kind === "code" ? current.codeManifest : current.inputManifest) {
      const limit = Math.min(remaining, kind === "code" ? 128 * 1024 : 8 * 1024);
      const file = await readBoundFile(snapshot.path, policy.workspaceRoot, limit);
      if (file.sha256 !== snapshot.sha256 || file.bytes !== snapshot.bytes) throw new Error("experiment file changed during review");
      result.push({ ...snapshot, kind, text: file.preview.toString("utf8"), truncated: file.bytes > limit });
      remaining -= file.preview.byteLength;
    }
  }
  const after = await captureExperimentContent(definition, policy);
  if (!sameExperimentContent(current, after)) throw new Error("experiment file changed during review");
  return result;
}

export interface ExperimentRun {
  schema: "dsh-sci.experiment-run.v1";
  runId: string;
  experimentId: string;
  projectId: string;
  taskId?: string;
  state: "running" | "completed" | "failed" | "timed-out" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs?: number;
  error?: string;
  processId?: number;
  manifest: ExperimentManifest;
}

export interface ExperimentFileSnapshot {
  path: string;
  relativePath: string;
  exists: boolean;
  bytes?: number;
  sha256?: string;
}

export interface ExperimentManifest {
  schema: "dsh-sci.experiment-manifest.v1";
  workspaceRoot?: string;
  command: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
  code?: ExperimentFileSnapshot[];
  inputs: ExperimentFileSnapshot[];
  outputs: ExperimentFileSnapshot[];
  codeVersion?: string;
  randomSeed?: number;
  resourceUsage?: {
    inputBytes: number;
    outputBytes: number;
    workspaceBytesBefore?: number;
    workspaceBytesAfter?: number;
    peakMemoryBytes?: number;
    memoryLimitEnforced?: boolean;
  };
}

export interface ExperimentExecutionPolicy {
  workspaceRoot?: string;
  allowedCommands?: string[];
  maxTimeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxWorkspaceBytes?: number;
  maxMemoryBytes?: number;
}

function text(value: unknown, field: string, max = 4000): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`); const result = value.trim(); if (result.length > max) throw new Error(`${field} is too long`); return result; }

export function makeExperimentDefinition(projectId: string, input: { title: string; command: string; args?: string[]; cwd?: string; inputPaths?: string[]; codePaths?: string[]; outputPaths?: string[]; randomSeed?: number; timeoutMs?: number; taskId?: string; designId?: string; codeBundleId?: string; hypothesisIds?: string[] }, now = new Date().toISOString(), experimentId = randomUUID()): ExperimentDefinition {
  const args = (input.args ?? []).map((value, index) => text(value, `experiment.args[${index}]`, 2000));
  const paths = (value: unknown, field: string) => !Array.isArray(value) ? [] : [...new Set(value.map((item, index) => text(item, `${field}[${index}]`, 4000)))].slice(0, 100);
  if (input.randomSeed !== undefined && (!Number.isSafeInteger(input.randomSeed) || input.randomSeed < 0)) throw new Error("experiment.randomSeed must be a non-negative integer");
  const command = text(input.command, "experiment.command", 1000);
  const codePaths = [...new Set([...paths(input.codePaths, "experiment.codePaths"), ...scriptEntryPaths(command, args)])];
  return { schema: "dsh-sci.experiment-definition.v1", experimentId, projectId, taskId: input.taskId ? text(input.taskId, "experiment.taskId", 256) : undefined, designId: input.designId ? text(input.designId, "experiment.designId", 256) : undefined, codeBundleId: input.codeBundleId ? text(input.codeBundleId, "experiment.codeBundleId", 256) : undefined, hypothesisIds: [...new Set((input.hypothesisIds ?? []).map((id) => text(id, "experiment.hypothesisId", 256)))], codePaths, title: text(input.title, "experiment.title", 500), command, args, cwd: input.cwd ? text(input.cwd, "experiment.cwd", 4000) : undefined, inputPaths: paths(input.inputPaths, "experiment.inputPaths"), outputPaths: paths(input.outputPaths, "experiment.outputPaths"), randomSeed: input.randomSeed, timeoutMs: Math.max(100, Math.min(30 * 60_000, Math.floor(input.timeoutMs ?? 120_000))), createdAt: now };
}

// Include conventional interpreter entry files even when a proposal omits codePaths.
// Dynamically imported modules and other dependencies must still be declared.
function scriptEntryPaths(command: string, args: string[]): string[] {
  if (/\.(?:py|js|mjs|cjs)$/iu.test(command)) return [command];
  if (!/^(?:node|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?$/iu.test(path.basename(command))) return [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (["-e", "-p", "--eval", "--print", "-c", "-m"].includes(value) || /^(?:--eval|--print)=/u.test(value)) break;
    if (["-r", "--require", "--import", "--loader"].includes(value)) {
      if (/\.(?:py|js|mjs|cjs)$/iu.test(args[i + 1] ?? "")) files.push(args[i + 1]);
      i++; continue;
    }
    if (value.startsWith("-")) continue;
    if (/\.(?:py|js|mjs|cjs)$/iu.test(value)) files.push(value);
    break;
  }
  return files;
}

export function experimentBindingHash(definition: ExperimentDefinition, codeManifest: ExperimentFileSnapshot[], inputManifest: ExperimentFileSnapshot[]): string {
  const command = { projectId: definition.projectId, planId: definition.planId, taskId: definition.taskId, experimentId: definition.experimentId, command: definition.command, args: definition.args, cwd: definition.cwd, outputPaths: definition.outputPaths, inputPaths: definition.inputPaths, codePaths: definition.codePaths ?? [], codeBundleId: definition.codeBundleId, randomSeed: definition.randomSeed, timeoutMs: definition.timeoutMs, designId: definition.designId, designContentHash: definition.designContentHash, hypothesisIds: definition.hypothesisIds };
  return createHash("sha256").update(JSON.stringify({ command, codeManifest, inputManifest })).digest("hex");
}

export async function captureExperimentContent(definition: ExperimentDefinition, policy: ExperimentExecutionPolicy = {}): Promise<{ codeManifest: ExperimentFileSnapshot[]; inputManifest: ExperimentFileSnapshot[]; bindingHash: string }> {
  const workspaceRoot = policy.workspaceRoot;
  const baseDirectory = definition.cwd ?? workspaceRoot ?? process.cwd();
  const codeManifest = await snapshotFiles(definition.codePaths ?? [], workspaceRoot, baseDirectory);
  const inputManifest = await snapshotFiles(definition.inputPaths ?? [], workspaceRoot, baseDirectory);
  const missing = [...codeManifest, ...inputManifest].filter((item) => !item.exists);
  if (missing.length) throw new Error(`experiment content is missing: ${missing.map((item) => item.relativePath).join(", ")}`);
  return { codeManifest, inputManifest, bindingHash: experimentBindingHash(definition, codeManifest, inputManifest) };
}

export function sameExperimentContent(left: { codeManifest?: ExperimentFileSnapshot[]; inputManifest?: ExperimentFileSnapshot[]; bindingHash?: string }, right: { codeManifest: ExperimentFileSnapshot[]; inputManifest: ExperimentFileSnapshot[]; bindingHash: string }): boolean {
  return left.bindingHash === right.bindingHash && JSON.stringify(left.codeManifest ?? []) === JSON.stringify(right.codeManifest) && JSON.stringify(left.inputManifest ?? []) === JSON.stringify(right.inputManifest);
}

export async function validateExperimentExecution(definition: ExperimentDefinition, policy: ExperimentExecutionPolicy = {}): Promise<void> {
  if (policy.allowedCommands?.length) {
    const command = definition.command.trim();
    const commandName = path.basename(command).toLowerCase();
    const allowed = policy.allowedCommands.some((candidate) => {
      const value = candidate.trim();
      if (!value) return false;
      if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) return path.resolve(value).toLowerCase() === path.resolve(command).toLowerCase();
      return value.toLowerCase() === commandName;
    });
    if (!allowed) throw new Error(`experiment command is not allowed: ${command}`);
  }
  if (policy.maxTimeoutMs !== undefined && definition.timeoutMs > policy.maxTimeoutMs) throw new Error(`experiment timeout exceeds policy limit of ${policy.maxTimeoutMs} ms`);
  for (const [name, value] of [["maxInputBytes", policy.maxInputBytes], ["maxOutputBytes", policy.maxOutputBytes], ["maxWorkspaceBytes", policy.maxWorkspaceBytes], ["maxMemoryBytes", policy.maxMemoryBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`experiment policy ${name} must be a non-negative integer`);
  }
  if (policy.workspaceRoot) {
    const root = path.resolve(await realpath(policy.workspaceRoot));
    const requested = path.resolve(definition.cwd ? await realpath(definition.cwd) : root);
    const relative = path.relative(root, requested);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("experiment cwd must stay inside the workspace");
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL", "VIRTUAL_ENV"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && (allowed.has(key) || key.startsWith("LC_"))));
}

/** Stream a bounded file so a growing input cannot allocate unbounded memory. */
async function readBoundFile(target: string, workspaceRoot?: string, previewLimit = 0) {
  const resolved = await realpath(target);
  if (workspaceRoot) {
    const relative = path.relative(await realpath(workspaceRoot), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("experiment manifest path resolves outside the workspace");
  }
  const file = await open(resolved, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("experiment manifest content must be a regular file");
    const maximum = 100 * 1024 * 1024;
    if (info.size > maximum) throw new Error("experiment manifest file exceeds 100 MiB");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), chunks: Buffer[] = [];
    let bytes = 0, previewBytes = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maximum) throw new Error("experiment manifest file exceeds 100 MiB");
      hash.update(buffer.subarray(0, bytesRead));
      const keep = Math.min(bytesRead, previewLimit - previewBytes);
      if (keep > 0) { chunks.push(Buffer.from(buffer.subarray(0, keep))); previewBytes += keep; }
    }
    return { bytes, sha256: hash.digest("hex"), preview: Buffer.concat(chunks) };
  } finally { await file.close(); }
}

async function snapshotFiles(paths: string[], workspaceRoot?: string, baseDirectory?: string): Promise<ExperimentFileSnapshot[]> {
  const root = workspaceRoot ? path.resolve(await realpath(workspaceRoot)) : undefined;
  const base = baseDirectory ? path.resolve(baseDirectory) : process.cwd();
  const result: ExperimentFileSnapshot[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const target = path.resolve(base, value);
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(key)) continue;
    seen.add(key);
    if (root) {
      const relative = path.relative(root, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("experiment manifest path must stay inside the workspace");
    }
    const relativePath = root ? path.relative(root, target) : target;
    try {
      const info = await stat(target);
      if (!info.isFile()) { result.push({ path: target, relativePath, exists: false }); continue; }
      const content = await readBoundFile(target, root);
      result.push({ path: target, relativePath, exists: true, bytes: content.bytes, sha256: content.sha256 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") result.push({ path: target, relativePath, exists: false });
      else throw error;
    }
  }
  return result;
}

async function measureWorkspaceBytes(root: string, limit?: number): Promise<number> {
  const maximum = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(limit));
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        total += (await stat(target)).size;
        if (total > maximum) throw new Error(`experiment workspace exceeds ${maximum} bytes`);
      }
    }
  };
  await visit(root);
  return total;
}

export interface ProcessMemoryRow { pid: number; parentPid: number; bytes: number; }

export function aggregateProcessTreeMemory(rows: ProcessMemoryRow[], rootPid: number): number | undefined {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return undefined;
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.parentPid, [...(children.get(row.parentPid) ?? []), row.pid]);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!byPid.has(rootPid)) return undefined;
  const pending = [rootPid]; const seen = new Set<number>(); let total = 0;
  while (pending.length) { const current = pending.pop()!; if (seen.has(current)) continue; seen.add(current); total += byPid.get(current)?.bytes ?? 0; pending.push(...(children.get(current) ?? [])); }
  return total;
}

export function processTreeMemoryBytes(pid: number): Promise<number | undefined> {
  const rootPid = Math.floor(pid);
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return Promise.resolve(undefined);
  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress"]
    : ["-e", "-o", "pid=,ppid=,rss="];
  // Windows CIM startup can exceed one second under concurrent workload.
  return new Promise((resolve) => execFile(command, args, { windowsHide: true, timeout: 5_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
    if (error) { resolve(undefined); return; }
    const rows: ProcessMemoryRow[] = [];
    if (process.platform === "win32") {
      try {
        const parsed = JSON.parse(String(stdout));
        for (const item of (Array.isArray(parsed) ? parsed : [parsed])) {
          const processId = Number(item?.ProcessId); const parentPid = Number(item?.ParentProcessId); const bytes = Number(item?.WorkingSetSize);
          if (Number.isSafeInteger(processId) && Number.isSafeInteger(parentPid) && Number.isFinite(bytes) && bytes >= 0) rows.push({ pid: processId, parentPid, bytes });
        }
      } catch { resolve(undefined); return; }
    } else {
      for (const line of String(stdout).split(/\r?\n/gu)) {
        const [processId, parentPid, rssKb] = line.trim().split(/\s+/gu).map(Number);
        if (Number.isSafeInteger(processId) && Number.isSafeInteger(parentPid) && Number.isFinite(rssKb) && rssKb >= 0) rows.push({ pid: processId, parentPid, bytes: rssKb * 1024 });
      }
    }
    resolve(aggregateProcessTreeMemory(rows, rootPid));
  }));
}

function stopProcessTreeByPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.unref();
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
}

function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) { child.kill(); return; }
  stopProcessTreeByPid(child.pid);
}

export interface ExperimentRunOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
  policy?: ExperimentExecutionPolicy;
  codeVersion?: string;
  onPrepared?: (run: ExperimentRun) => Promise<void>;
  onStarted?: (run: ExperimentRun) => Promise<void>;
  beforeLaunch?: (prepared: ExperimentRun) => Promise<void>;
}

export function runExperiment(definition: ExperimentDefinition, options: ExperimentRunOptions = {}): Promise<ExperimentRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const maxOutput = Math.max(1024, Math.min(10 * 1024 * 1024, options.maxOutputBytes ?? options.policy?.maxOutputBytes ?? 1 * 1024 * 1024));
  const workspaceRoot = options.policy?.workspaceRoot;
  const baseDirectory = definition.cwd ?? workspaceRoot ?? process.cwd();
  const manifestBase = async (): Promise<Pick<ExperimentManifest, "code" | "inputs" | "outputs">> => ({ code: await snapshotFiles(definition.codePaths ?? [], workspaceRoot, baseDirectory), inputs: await snapshotFiles(definition.inputPaths ?? [], workspaceRoot, baseDirectory), outputs: await snapshotFiles(definition.outputPaths ?? [], workspaceRoot, baseDirectory) });
  return new Promise((resolve, reject) => {
    void (async () => {
      let initial: Pick<ExperimentManifest, "code" | "inputs" | "outputs">;
      let workspaceBytesBefore: number | undefined;
      try {
        initial = await manifestBase();
        const inputBytes = initial.inputs.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
        if (options.policy?.maxInputBytes !== undefined && inputBytes > options.policy.maxInputBytes) throw new Error(`experiment inputs exceed ${options.policy.maxInputBytes} bytes`);
        if (workspaceRoot && options.policy?.maxWorkspaceBytes !== undefined) workspaceBytesBefore = await measureWorkspaceBytes(workspaceRoot, options.policy.maxWorkspaceBytes);
      } catch (error) { reject(error); return; }
    let stdout = ""; let stderr = ""; let truncated = false; let state: ExperimentRun["state"] = "running"; let settled = false; let peakMemoryBytes: number | undefined; let memoryLimitEnforced: boolean | undefined = options.policy?.maxMemoryBytes === undefined ? undefined : false;
    let resourceError: string | undefined;
    const environment = safeEnvironment();
    const manifest = (outputs: ExperimentFileSnapshot[], workspaceBytesAfter?: number): ExperimentManifest => ({ schema: "dsh-sci.experiment-manifest.v1", workspaceRoot: workspaceRoot ? path.resolve(workspaceRoot) : undefined, command: definition.command, args: [...definition.args], cwd: definition.cwd, environment: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string")), code: initial.code, inputs: initial.inputs, outputs, codeVersion: options.codeVersion, randomSeed: definition.randomSeed, resourceUsage: { inputBytes: initial.inputs.reduce((sum, item) => sum + (item.bytes ?? 0), 0), outputBytes: outputs.reduce((sum, item) => sum + (item.bytes ?? 0), 0), workspaceBytesBefore, workspaceBytesAfter, peakMemoryBytes, memoryLimitEnforced } });
    const finish = async (base: Omit<ExperimentRun, "manifest">) => { try { await startPersisted; } catch { base.state = "failed"; base.error = resourceError; } let outputs: ExperimentFileSnapshot[] = []; let workspaceBytesAfter: number | undefined; try { outputs = (await manifestBase()).outputs; const outputBytes = outputs.reduce((sum, item) => sum + (item.bytes ?? 0), 0); if (options.policy?.maxOutputBytes !== undefined && outputBytes > options.policy.maxOutputBytes) throw new Error(`experiment outputs exceed ${options.policy.maxOutputBytes} bytes`); if (workspaceRoot && options.policy?.maxWorkspaceBytes !== undefined) workspaceBytesAfter = await measureWorkspaceBytes(workspaceRoot, options.policy.maxWorkspaceBytes); } catch (error) { base.error = `${base.error ? `${base.error}; ` : ""}${error instanceof Error ? error.message : String(error)}`; if (base.state === "completed") base.state = "failed"; } resolve({ ...base, manifest: manifest(outputs, workspaceBytesAfter) }); };
    const prepared: ExperimentRun = { schema: "dsh-sci.experiment-run.v1", runId, experimentId: definition.experimentId, projectId: definition.projectId, taskId: definition.taskId, state: "running", startedAt, stdout: "", stderr: "", truncated: false, manifest: manifest([]) };
    try { await options.onPrepared?.(prepared); }
    catch (error) { reject(error); return; }
    if (options.signal?.aborted) { resolve({ ...prepared, state: "cancelled", finishedAt: new Date().toISOString() }); return; }
    try { await options.beforeLaunch?.(prepared); }
    catch (error) {
      resolve({ ...prepared, state: "failed", finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, error: error instanceof Error ? error.message : "Experiment launch verification failed" });
      return;
    }
    if (options.signal?.aborted) { resolve({ ...prepared, state: "cancelled", finishedAt: new Date().toISOString() }); return; }
    const child = spawnOwnedProcess(definition.command, definition.args, { cwd: definition.cwd ?? baseDirectory, shell: false, env: environment });
    const startPersisted = Promise.resolve().then(() => child.pid ? options.onStarted?.({ ...prepared, processId: child.pid }) : undefined).catch((error) => { resourceError = `could not persist experiment start: ${error instanceof Error ? error.message : String(error)}`; state = "failed"; child.kill(); throw error; });
    void startPersisted.catch(() => undefined);
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => { const textChunk = chunk.toString("utf8"); const current = target === "stdout" ? stdout : stderr; const remaining = maxOutput - Buffer.byteLength(current, "utf8"); const next = current + textChunk.slice(0, Math.max(0, remaining)); if (Buffer.byteLength(textChunk, "utf8") > remaining) truncated = true; if (target === "stdout") stdout = next; else stderr = next; };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk)); child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const timer = setTimeout(() => { state = "timed-out"; stopProcessTree(child); }, definition.timeoutMs);
    let samplingMemory = false;
    const sampleMemory = async () => {
      if (!child.pid || settled || samplingMemory) return;
      samplingMemory = true;
      try {
        const bytes = await processTreeMemoryBytes(child.pid);
        // A query can finish after close/abort. It must not change a terminal run
        // or target a PID that Windows may already have reused.
        if (settled || state !== "running") return;
        memoryLimitEnforced = bytes !== undefined;
        if (bytes === undefined) return;
        peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, bytes);
        if (bytes > options.policy!.maxMemoryBytes!) {
          state = "failed";
          resourceError = `experiment process tree exceeded ${options.policy!.maxMemoryBytes} bytes memory`;
          stopProcessTree(child);
        }
      } finally { samplingMemory = false; }
    };
    const memoryTimer = options.policy?.maxMemoryBytes === undefined ? undefined : setInterval(() => { void sampleMemory(); }, 250);
    if (memoryTimer) void sampleMemory();
    const abort = () => { state = "cancelled"; stopProcessTree(child); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); if (memoryTimer) clearInterval(memoryTimer); options.signal?.removeEventListener("abort", abort); void finish({ schema: "dsh-sci.experiment-run.v1", runId, experimentId: definition.experimentId, projectId: definition.projectId, taskId: definition.taskId, processId: child.pid, state: "failed", startedAt, finishedAt: new Date().toISOString(), stdout, stderr, truncated, durationMs: Date.now() - startedMs, error: resourceError ?? error.message }); });
    child.once("close", (exitCode, signal) => { if (settled) return; settled = true; clearTimeout(timer); if (memoryTimer) clearInterval(memoryTimer); options.signal?.removeEventListener("abort", abort); const finalState = state === "running" ? (exitCode === 0 ? "completed" : "failed") : state; void finish({ schema: "dsh-sci.experiment-run.v1", runId, experimentId: definition.experimentId, projectId: definition.projectId, taskId: definition.taskId, processId: child.pid, state: finalState, startedAt, finishedAt: new Date().toISOString(), exitCode, signal: signal ?? undefined, stdout, stderr, truncated, durationMs: Date.now() - startedMs, ...(finalState === "failed" ? { error: resourceError ?? `experiment exited with code ${exitCode ?? "unknown"}` } : {}) }); });
    })();
  });
}
