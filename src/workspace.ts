import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  sha256?: string;
}

// Generated package output can contain Electron asar archives. Inside an
// Electron process those archives are virtual filesystems, so treating them
// as ordinary workspace files can produce false ENOENT errors while hashing.
const ignored = new Set([".git", "node_modules", ".dsh-sci", "dist", "release"]);

function isSensitiveFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.") || name === "dsh-sci.config.json" || /(^|[-_.])(credentials?|secrets?|private-key)([-_.]|$)/iu.test(name) || /\.(pem|key|p12|pfx|crt)$/iu.test(name);
}

function isGeneratedArchive(name: string): boolean {
  return /\.(asar|blockmap)$/iu.test(name);
}

export async function listWorkspace(root: string, depth = 12): Promise<WorkspaceEntry[]> {
  const base = path.resolve(root);
  const target = base;
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${target}`);
  const result: WorkspaceEntry[] = [];
  async function visit(directory: string, level: number): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      if (entry.isFile() && (isSensitiveFile(entry.name) || isGeneratedArchive(entry.name))) continue;
      const full = path.join(directory, entry.name);
      const rel = path.relative(base, full) || ".";
      if (entry.isDirectory()) {
        result.push({ path: rel, kind: "directory", bytes: 0 });
        if (level < depth) await visit(full, level + 1);
      } else if (entry.isFile()) {
        const file = await stat(full);
        result.push({ path: rel, kind: "file", bytes: file.size, sha256: await hashFile(full) });
      }
    }
  }
  await visit(target, 0);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function hashFile(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
