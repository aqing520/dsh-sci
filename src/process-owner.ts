// Runs only as an isolated Node helper. It never writes research state or logs
// command arguments/environment. Closing the owner's IPC stops the whole tree.
import { spawn, type ChildProcess } from "node:child_process";

let command: ChildProcess | undefined;
let started = false;
let stopping = false;
let finished = false;
let forceTimer: NodeJS.Timeout | undefined;

function signalTree(signal: NodeJS.Signals): void {
  if (!command?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(command.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.on("error", () => command?.kill());
  } else {
    try { process.kill(-command.pid, signal); } catch { command.kill(signal); }
  }
}

function stop(): void {
  if (stopping || finished) return;
  stopping = true;
  if (!command) { process.exit(1); return; }
  signalTree("SIGTERM");
  forceTimer = setTimeout(() => { signalTree("SIGKILL"); }, 1000);
}

function finish(code: number): void {
  if (finished) return;
  finished = true;
  if (forceTimer) clearTimeout(forceTimer);
  process.exitCode = code;
  process.stdin.destroy();
  if (process.connected) process.disconnect?.();
}

process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.once("message", (message: { command?: unknown; args?: unknown; cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean }) => {
  if (started || stopping || typeof message?.command !== "string" || !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== "string")) { finish(1); return; }
  started = true;
  command = spawn(message.command, message.args, { cwd: message.cwd, env: message.env, shell: message.shell === true, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
  process.stdin.pipe(command.stdin!);
  command.stdin!.on("error", () => undefined);
  command.stdout!.pipe(process.stdout);
  command.stderr!.pipe(process.stderr);
  command.once("error", (error: NodeJS.ErrnoException) => { process.stderr.write(`Owned command failed to start (${error.code ?? "unknown"})\n`); finish(127); });
  command.once("close", (code) => { finish(stopping ? 1 : code ?? 1); });
});
