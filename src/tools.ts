import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertCommandAllowed, assertWritable, canonicalPath } from "./permissions.js";
import { listWorkspace, readWorkspaceFile } from "./workspace.js";
import type { ToolCall, ToolResult, WorkspaceConfig } from "./types.js";

const execAsync = promisify(exec);

export async function executeTool(config: WorkspaceConfig, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "list_files": {
        const relative = typeof call.arguments.relative === "string" ? call.arguments.relative : ".";
        const depth = typeof call.arguments.depth === "number" ? call.arguments.depth : 2;
        return { name: call.name, ok: true, output: JSON.stringify(await listWorkspace(config.root, relative, depth), null, 2) };
      }
      case "read_file": {
        const file = String(call.arguments.path ?? "");
        return { name: call.name, ok: true, output: await readWorkspaceFile(config.root, file) };
      }
      case "write_file": {
        const file = canonicalPath(path.resolve(config.root, String(call.arguments.path ?? "")));
        assertWritable(config.permission, config.root, file);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, String(call.arguments.content ?? ""), "utf8");
        return { name: call.name, ok: true, output: `Wrote ${path.relative(config.root, file)}` };
      }
      case "run_command": {
        assertCommandAllowed(config.permission);
        const result = await execAsync(String(call.arguments.command ?? ""), { cwd: config.root, timeout: config.commandTimeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        return { name: call.name, ok: true, output: `${result.stdout}${result.stderr}` };
      }
    }
  } catch (error) {
    return { name: call.name, ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
  }
}
