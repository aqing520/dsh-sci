import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface StartupDiagnostic {
  schema: "dsh-sci.startup-diagnostic.v1";
  createdAt: string;
  platform: NodeJS.Platform;
  arch: string;
  appVersion?: string;
  previousStartupWasUnclean: boolean;
  message: string;
  stack?: string;
}

export function sanitizeDiagnosticText(value: unknown): string {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/([?&](?:token|api[_-]?key|key|secret)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|token)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(?:sk|key|token)[_-][A-Za-z0-9_-]{8,}\b/giu, "[redacted]");
}

export function createStartupDiagnostic(error: unknown, options: { previousStartupWasUnclean: boolean; appVersion?: string; now?: string } = { previousStartupWasUnclean: false }): StartupDiagnostic {
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    schema: "dsh-sci.startup-diagnostic.v1",
    createdAt: options.now ?? new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    appVersion: options.appVersion,
    previousStartupWasUnclean: options.previousStartupWasUnclean,
    message: sanitizeDiagnosticText(source.message),
    stack: source.stack ? sanitizeDiagnosticText(source.stack) : undefined,
  };
}

export async function writeStartupDiagnostic(root: string, diagnostic: StartupDiagnostic): Promise<string> {
  const directory = path.join(path.resolve(root), "startup-diagnostics");
  await mkdir(directory, { recursive: true });
  const stamp = diagnostic.createdAt.replace(/[:.]/g, "-");
  const file = path.join(directory, `startup-${stamp}-${randomUUID()}.json`);
  const temporary = `${file}.tmp`;
  const text = `${JSON.stringify(diagnostic, null, 2)}\n`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
  const latest = path.join(directory, "latest.json");
  const latestTemporary = `${latest}.${randomUUID()}.tmp`;
  await writeFile(latestTemporary, text, "utf8");
  await rename(latestTemporary, latest);
  const history = (await readdir(directory)).filter((name) => name.startsWith("startup-") && name.endsWith(".json")).sort();
  for (const stale of history.slice(0, Math.max(0, history.length - 20))) await rm(path.join(directory, stale), { force: true });
  return file;
}
