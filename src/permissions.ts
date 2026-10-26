import path from "node:path";
import type { PermissionMode } from "./types.js";

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

export function canonicalPath(value: string): string {
  return path.resolve(value);
}

export function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertReadable(root: string, target: string): void {
  if (!containsPath(root, target)) throw new PermissionError(`Path is outside the workspace: ${target}`);
}

export function assertWritable(mode: PermissionMode, root: string, target: string): void {
  if (mode === "read-only") throw new PermissionError("Writes are disabled in read-only mode");
  if (mode === "workspace-write" && !containsPath(root, target)) {
    throw new PermissionError(`workspace-write cannot modify a path outside the workspace: ${target}`);
  }
}

export function assertCommandAllowed(mode: PermissionMode): void {
  if (mode !== "full-access") throw new PermissionError("Command execution requires full-access mode");
}
