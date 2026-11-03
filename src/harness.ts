import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { spawnOwnedProcess } from "./owned-process.js";

export interface HarnessLaunchOptions {
  home: string;
  cwd?: string;
  command?: string;
  argsPrefix?: string[];
  environment?: Record<string, string | undefined>;
  version?: string;
  startupTimeoutMs?: number;
  /** Optional fixed web port; 0 asks the OS for an available port. */
  webPort?: number;
}

export interface HarnessLaunchResult {
  url: string;
  command: string;
  args: string[];
  process: ChildProcess;
}

const DEFAULT_VERSION = "0.2.1-rc.2";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Extract the authenticated loopback URL printed by the official dsh web app. */
export function parseHarnessUrl(line: string): string | undefined {
  const match = /dsh web:\s+(https?:\/\/127\.0\.0\.1(?::\d+)?\/\?token=[^\s]+)/i.exec(line);
  return match?.[1];
}

/** Resolve the command used to start dsh without hiding it behind shell syntax. */
export function resolveHarnessCommand(command = process.env.DSH_SCI_HARNESS_BIN): { command: string; argsPrefix: string[] } {
  if (command) return { command, argsPrefix: [] };
  if (process.platform === "win32") return { command: "dsh.cmd", argsPrefix: [] };
  return { command: "dsh", argsPrefix: [] };
}

function spawnDsh(options: HarnessLaunchOptions, command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawnOwnedProcess(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.environment, DSH_HOME: options.home },
    shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
  });
}

async function waitForUrl(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  let output = "";
  let diagnostics = "";
  const rememberDiagnostics = (chunk: Buffer | string) => {
    diagnostics = (diagnostics + String(chunk)).slice(-8_192);
  };
  const diagnosticMessage = () => diagnostics.replace(/([?&]token=)[^&\s]+/gi, "$1<redacted>").trim();
  const onData = (chunk: Buffer | string): string | undefined => {
    rememberDiagnostics(chunk);
    output += String(chunk);
    const lines = output.split(/\r?\n/);
    output = lines.pop() ?? "";
    for (const line of lines) {
      const url = parseHarnessUrl(line);
      if (url) return url;
    }
    return parseHarnessUrl(output);
  };

  let settled = false;
  let resolveUrl: (url: string) => void = () => undefined;
  let rejectUrl: (error: Error) => void = () => undefined;
  const urlPromise = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject; });
  const onStdout = (chunk: Buffer | string) => { const url = onData(chunk); if (url) resolveUrl(url); };
  const onStderr = (chunk: Buffer | string) => { const url = onData(chunk); if (url) resolveUrl(url); };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!settled) {
      const detail = diagnosticMessage();
      rejectUrl(new Error(`dsh exited before startup (code=${String(code)}, signal=${String(signal)})${detail ? `\n${detail}` : ""}`));
    }
  };
  const onError = (error: Error) => {
    if (!settled) rejectUrl(error);
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.once("exit", onExit);
  // Attach before waiting for the spawn event. On Windows the Harness can
  // print its URL immediately after spawn; waiting first can lose that line.
  child.once("error", onError);

  const timer = setTimeout(() => {
    const detail = diagnosticMessage();
    rejectUrl(new Error(`dsh did not become ready within ${timeoutMs} ms${detail ? `\n${detail}` : ""}`));
  }, timeoutMs);
  try {
    const url = await urlPromise;
    settled = true;
    return url;
  } finally {
    clearTimeout(timer);
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
    child.off("exit", onExit);
    child.off("error", onError);
    // Keep draining the pipes after startup. The Harness emits diagnostic
    // output while serving requests; leaving these pipes paused can eventually
    // fill the OS buffer and stall the child process.
    child.stdout.resume();
    child.stderr.resume();
  }
}

function reserveLoopbackPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not reserve a loopback port")); return; }
      resolve({ port: address.port, release: () => new Promise((closeResolve, closeReject) => server.close((error) => error ? closeReject(error) : closeResolve())) });
    });
  });
}

async function startWithReservedPort(options: HarnessLaunchOptions, command: string, argsPrefix: string[]): Promise<{ url: string; process: ChildProcessWithoutNullStreams; args: string[] }> {
  const reservation = options.webPort === undefined || options.webPort === 0 ? await reserveLoopbackPort() : undefined;
  const port = reservation?.port ?? options.webPort!;
  // The child must own the listener before it can report readiness.
  await reservation?.release();
  const args = [...argsPrefix, "web", "--no-open", "--port", String(port)];
  const child = spawnDsh(options, command, args);
  try {
    const url = await waitForUrl(child, options.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { url, process: child, args };
  } catch (error) {
    child.kill();
    throw error;
  }
}

/** Start the official dsh Web profile and wait for its authenticated URL. */
export async function startHarness(options: HarnessLaunchOptions): Promise<HarnessLaunchResult> {
  const resolved = resolveHarnessCommand(options.command);
  const version = options.version ?? DEFAULT_VERSION;
  try {
    const result = await startWithReservedPort(options, resolved.command, options.argsPrefix ?? resolved.argsPrefix);
    return { url: result.url, command: resolved.command, args: result.args, process: result.process };
  } catch (error) {
    if (options.command) throw error;
    const fallbackCommand = process.platform === "win32" ? "npx.cmd" : "npx";
    const fallbackPrefix = ["--yes", `@deepseek-ai/dsh@${version}`];
    try {
      const result = await startWithReservedPort(options, fallbackCommand, fallbackPrefix);
      return { url: result.url, command: fallbackCommand, args: result.args, process: result.process };
    } catch (startupError) {
      throw startupError;
    }
  }
}

export async function stopHarness(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
