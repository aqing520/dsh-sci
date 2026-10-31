import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodeSyntaxCheck } from "./code-syntax.js";

export interface StagedResearchFile { name: string; kind: "code" | "input" | "dependency"; path: string; bytes: number; contentHash: string; }
export interface ResearchCodeBundle {
  schema: "dsh-sci.research-code-bundle.v1";
  bundleId: string;
  projectId: string;
  planId: string;
  taskId: string;
  contentHash: string;
  directory: string;
  files: StagedResearchFile[];
  createdAt: string;
  /** Static parsing metadata only; never execution, tests or correctness. */
  syntaxChecks?: CodeSyntaxCheck[];
}
export interface CodeStagingInput { files: Array<{ name: string; content: string; kind: StagedResearchFile["kind"] }>; }
export interface CodeRevisionInput extends CodeStagingInput { baseBundleId?: string; }

/** Fixed diagnostics only: callers must never persist arbitrary exception text. */
export function codeStagingFailureCode(error: unknown): string {
  const codes = new Map([
    ["Code staging requires 1 to 20 files", "files-array"],
    ["Code staging requires safe relative file names", "file-name"],
    ["Unsupported staged file extension", "file-extension"],
    ["Staged files require content and a valid kind", "file-fields"],
    ["Staged content exceeds the 128 KiB file or 512 KiB bundle limit", "content-limit"],
    ["Duplicate staged file name", "duplicate-name"],
    ["Existing staged file differs; it cannot be overwritten", "immutable-content-changed"],
    ["Code staging cannot follow symbolic links or junctions", "symbolic-link"],
    ["Code staging path must stay inside its workspace", "workspace-boundary"],
    ["code staging requires an active task with code-stage permission", "task-permission"],
    ["Code revision requires a registered base bundle ID", "base-bundle"],
    ["Code revision must preserve the exact name and kind of an inherited file", "inherited-file"],
  ]);
  return error instanceof Error ? codes.get(error.message) ?? "unclassified" : "unclassified";
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function assertStagedFileName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length > 160 || !/^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/u.test(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) throw new Error("Code staging requires safe relative file names");
}
function inside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Code staging path must stay inside its workspace");
}
async function directory(root: string, relative: string): Promise<string> {
  let target = root;
  for (const segment of relative.split("/")) {
    target = path.join(target, segment);
    await mkdir(target, { recursive: true });
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Code staging cannot follow symbolic links or junctions");
    inside(root, await realpath(target));
  }
  return target;
}

/** Validate the complete request before reading a base or writing any files. */
export function validateCodeStagingFiles(input: CodeStagingInput) {
  if (!input || !Array.isArray(input.files) || !input.files.length || input.files.length > 20) throw new Error("Code staging requires 1 to 20 files");
  let total = 0;
  const seen = new Set<string>();
  const files = input.files.map((file) => {
    assertStagedFileName(file?.name);
    if (!/\.(py|js|mjs|cjs|json|csv|tsv|txt|md|lock)$/iu.test(file.name)) throw new Error("Unsupported staged file extension");
    if (!["code", "input", "dependency"].includes(file.kind) || typeof file.content !== "string") throw new Error("Staged files require content and a valid kind");
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (!bytes || bytes > 128 * 1024 || (total += bytes) > 512 * 1024) throw new Error("Staged content exceeds the 128 KiB file or 512 KiB bundle limit");
    const key = file.name.toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate staged file name");
    seen.add(key);
    return { ...file, bytes, contentHash: digest(file.content) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** Files are created only in a new content-addressed bundle, never over an
 * application file. A retry may finish an incomplete bundle but not replace bytes. */
export async function stageResearchCode(workspaceRoot: string, scope: { projectId: string; planId: string; taskId: string }, input: CodeStagingInput): Promise<ResearchCodeBundle> {
  const files = validateCodeStagingFiles(input);
  const root = await realpath(workspaceRoot);
  const contentHash = digest(JSON.stringify({ ...scope, files: files.map(({ name, kind, contentHash }) => ({ name, kind, contentHash })) }));
  const bundleId = `bundle-${contentHash}`;
  const base = await directory(root, `.dsh-sci/experiments/${digest(scope.projectId).slice(0, 32)}/${bundleId}`);
  const staged: StagedResearchFile[] = [];
  for (const file of files) {
    const parent = path.posix.dirname(file.name);
    const folder = parent === "." ? base : await directory(base, parent);
    const target = path.join(folder, path.posix.basename(file.name));
    try { await writeFile(target, file.content, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || digest(await readFile(target)) !== file.contentHash) throw new Error("Existing staged file differs; it cannot be overwritten");
    }
    staged.push({ name: file.name, kind: file.kind, path: target, bytes: file.bytes, contentHash: file.contentHash });
  }
  return { schema: "dsh-sci.research-code-bundle.v1", bundleId, ...scope, contentHash, directory: base, files: staged, createdAt: new Date().toISOString() };
}
