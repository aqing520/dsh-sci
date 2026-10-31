import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

/** A live IPC connection ties the command lifetime to its desktop/SDK owner. */
export function spawnOwnedProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = {}): ChildProcessWithoutNullStreams {
  const environment = options.env ?? process.env;
  const development = import.meta.url.endsWith(".ts");
  const script = fileURLToPath(new URL(development ? "./process-owner.ts" : "./process-owner.js", import.meta.url));
  const child = spawn(process.execPath, [...(development ? ["--import", import.meta.resolve("tsx")] : []), script], {
    cwd: options.cwd,
    env: { ...environment, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
    shell: false,
  }) as ChildProcessWithoutNullStreams;
  child.once("spawn", () => {
    child.send?.({ command, args, cwd: options.cwd, env: environment, shell: options.shell ?? false }, (error: Error | null) => { if (error) child.kill(); });
  });
  return child;
}
