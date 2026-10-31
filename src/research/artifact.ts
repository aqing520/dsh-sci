import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ResearchArtifactKind = "dataset" | "table" | "plot" | "report" | "code" | "log" | "other";

export interface ResearchArtifact {
  schema: "dsh-sci.research-artifact.v1";
  artifactId: string;
  projectId: string;
  kind: ResearchArtifactKind;
  path: string;
  relativePath: string;
  mediaType: string;
  bytes: number;
  contentHash: string;
  experimentRef?: string;
  metadata: Record<string, string>;
  createdAt: string;
}

const MAX_BYTES = 100 * 1024 * 1024;
const types: Record<string, string> = { ".csv": "text/csv", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".py": "text/x-python", ".ts": "text/typescript", ".js": "text/javascript" };

function id(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`); return value.trim().slice(0, 256).replace(/[^A-Za-z0-9._:-]/gu, "-"); }
function metadata(input: unknown): Record<string, string> { const result: Record<string, string> = {}; if (!input || typeof input !== "object" || Array.isArray(input)) return result; for (const [key, value] of Object.entries(input).slice(0, 100)) if (/^[A-Za-z0-9._:-]{1,128}$/u.test(key) && typeof value === "string") result[key] = value.slice(0, 4000); return result; }

export async function makeResearchArtifact(projectId: string, input: { path: string; kind?: ResearchArtifactKind; experimentRef?: string; metadata?: Record<string, string> }, options: { workspaceRoot: string; now?: string; maxBytes?: number }): Promise<ResearchArtifact> {
  const root = path.resolve(await realpath(options.workspaceRoot));
  const target = path.resolve(await realpath(input.path));
  const relativePath = path.relative(root, target);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("artifact path must stay inside the workspace");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("artifact path must be a regular file");
  const maxBytes = Math.max(1, Math.min(MAX_BYTES, Math.floor(options.maxBytes ?? MAX_BYTES)));
  if (info.size > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes`);
  const buffer = await readFile(target);
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const artifactId = `artifact-${createHash("sha256").update(`${projectId}\0${relativePath}\0${contentHash}`).digest("hex").slice(0, 32)}`;
  return { schema: "dsh-sci.research-artifact.v1", artifactId, projectId, kind: input.kind ?? "other", path: target, relativePath, mediaType: types[path.extname(target).toLowerCase()] ?? "application/octet-stream", bytes: info.size, contentHash, experimentRef: input.experimentRef ? id(input.experimentRef, "artifact.experimentRef") : undefined, metadata: metadata(input.metadata), createdAt: options.now ?? new Date().toISOString() };
}
