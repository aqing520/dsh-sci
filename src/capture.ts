import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { listWorkspace } from "./workspace.js";
import type { AgentEvent } from "./types.js";

export class CaptureStore {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async appendEvent(sessionId: string, event: AgentEvent): Promise<void> {
    await this.init();
    await appendFile(path.join(this.root, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
  }

  async snapshot(workspaceRoot: string): Promise<{ snapshotId: string; files: Awaited<ReturnType<typeof listWorkspace>> }> {
    const files = await listWorkspace(workspaceRoot, ".", 12);
    const snapshotId = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    await this.init();
    await writeFile(path.join(this.root, `workspace-${snapshotId}.json`), JSON.stringify({ workspaceRoot, snapshotId, files }, null, 2));
    return { snapshotId, files };
  }

  async readSession(sessionId: string): Promise<AgentEvent[]> {
    try {
      const content = await readFile(path.join(this.root, `${sessionId}.jsonl`), "utf8");
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AgentEvent);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
