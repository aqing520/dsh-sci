import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface IntegrityEntry { path: string; bytes: number; sha256: string; }
export interface IntegrityManifest {
  schema: "dsh-sci.integrity-manifest.v1" | "dsh-sci.integrity-manifest.v2";
  generatedAt: string;
  entries: IntegrityEntry[];
  algorithm?: "sha256";
  generatorVersion?: string;
  appVersion?: string;
}
export interface IntegrityFailure { path: string; reason: "missing" | "size" | "sha256" | "manifest" | "algorithm" | "version" | "generator"; expected?: string; actual?: string; }
export interface IntegrityVerifyOptions { appVersion?: string; generatorVersion?: string; }

async function assertContained(root: string, file: string): Promise<void> {
  const resolvedRoot = await realpath(root);
  const resolvedFile = await realpath(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Integrity path escapes root");
}

async function digest(file: string): Promise<{ bytes: number; sha256: string }> {
  const data = await readFile(file);
  return { bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
}

export async function createIntegrityManifest(root: string, relativeFiles: string[], options: { appVersion?: string; generatorVersion?: string } = {}): Promise<IntegrityManifest> {
  const resolvedRoot = path.resolve(root);
  const entries: IntegrityEntry[] = [];
  for (const relative of [...new Set(relativeFiles)].sort()) {
    const file = path.resolve(resolvedRoot, relative);
    const normalized = path.relative(resolvedRoot, file);
    if (normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) throw new Error(`Integrity path escapes root: ${relative}`);
    await assertContained(resolvedRoot, file);
    const metadata = await digest(file);
    entries.push({ path: relative.replaceAll("\\", "/"), ...metadata });
  }
  return { schema: "dsh-sci.integrity-manifest.v2", generatedAt: new Date().toISOString(), algorithm: "sha256", generatorVersion: options.generatorVersion ?? "dsh-sci.integrity.v1", ...(options.appVersion ? { appVersion: options.appVersion } : {}), entries };
}

export async function verifyIntegrityManifest(root: string, manifest: IntegrityManifest, options: IntegrityVerifyOptions = {}): Promise<IntegrityFailure[]> {
  const resolvedRoot = path.resolve(root);
  const failures: IntegrityFailure[] = [];
  if (manifest.schema !== "dsh-sci.integrity-manifest.v1" && manifest.schema !== "dsh-sci.integrity-manifest.v2") { failures.push({ path: "<manifest>", reason: "manifest", expected: "dsh-sci.integrity-manifest.v1 or v2", actual: String(manifest.schema) }); return failures; }
  if (manifest.schema === "dsh-sci.integrity-manifest.v2" && manifest.algorithm !== "sha256") { failures.push({ path: "<manifest>", reason: "algorithm", expected: "sha256", actual: String(manifest.algorithm) }); return failures; }
  if (options.generatorVersion && manifest.generatorVersion && manifest.generatorVersion !== options.generatorVersion) failures.push({ path: "<manifest>", reason: "generator", expected: options.generatorVersion, actual: manifest.generatorVersion });
  if (options.appVersion && manifest.appVersion && manifest.appVersion !== options.appVersion) failures.push({ path: "<manifest>", reason: "version", expected: options.appVersion, actual: manifest.appVersion });
  if (failures.length) return failures;
  for (const entry of manifest.entries) {
    const file = path.resolve(resolvedRoot, entry.path);
    const relative = path.relative(resolvedRoot, file);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { failures.push({ path: entry.path, reason: "missing" }); continue; }
    try {
      await assertContained(resolvedRoot, file);
      const link = await lstat(file);
      if (link.isSymbolicLink()) { failures.push({ path: entry.path, reason: "missing" }); continue; }
      const info = await stat(file);
      if (info.size !== entry.bytes) { failures.push({ path: entry.path, reason: "size", expected: String(entry.bytes), actual: String(info.size) }); continue; }
      const actual = (await digest(file)).sha256;
      if (actual !== entry.sha256) failures.push({ path: entry.path, reason: "sha256", expected: entry.sha256, actual });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message === "Integrity path escapes root") failures.push({ path: entry.path, reason: "missing" });
      else throw error;
    }
  }
  return failures;
}
