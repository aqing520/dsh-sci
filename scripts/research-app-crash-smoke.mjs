import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import electron from "electron";
import { ResearchRepository } from "../dist/src/research/repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(tmpdir(), "dsh-sci-whole-app-crash-"));
const workspace = path.join(temp, "workspace");
const reportPath = path.join(root, "research", "validation", `app-crash-${Date.now()}.json`);
const exec = promisify(execFile);
let current;
let descendants = [];
let ok = false;
const report = { schema: "dsh-sci.app-crash-smoke.v1", startedAt: new Date().toISOString(), platform: process.platform };

async function waitFor(operation, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await delay(75);
  }
  throw new Error("Whole-app crash smoke observation timed out");
}
async function json(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; } }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
function launch(phase) {
  const child = spawn(electron, ["--no-sandbox", "--disable-gpu", path.join(root, "scripts", "research-app-crash-child.cjs"), phase, temp], {
    cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DSH_SCI_PROVIDER: "custom", DSH_SCI_BASE_URL: "http://127.0.0.1:1/v1", DSH_SCI_MODEL: "crash-smoke", DSH_SCI_API_KEY: "", DSH_SCI_TOKENFANS_API_KEY: "", OPENAI_API_KEY: "", DSH_SCI_SERVICE_API_KEY: "", DSH_SCI_SERVICE_BASE_URL: "", DSH_SCI_METADATA_PASSPHRASE: "", DSH_SCI_MEMORY_EMBEDDINGS: "0" },
  });
  child.stdout.resume();
  let tail = "";
  child.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-6000); });
  child.once("error", () => undefined);
  child.diagnostics = () => tail;
  return child;
}
async function processTree(parentPid) {
  const { stdout } = process.platform === "win32"
    ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { windowsHide: true })
    : await exec("ps", ["-e", "-o", "pid=,ppid="]);
  const rows = process.platform === "win32" ? JSON.parse(stdout).map((row) => [row.ProcessId, row.ParentProcessId]) : stdout.trim().split(/\r?\n/u).map((line) => line.trim().split(/\s+/u).map(Number));
  const ids = new Set([parentPid]);
  let previous;
  do { previous = ids.size; for (const [pid, parent] of rows) if (ids.has(parent)) ids.add(pid); } while (ids.size !== previous);
  return [...ids].filter((pid) => pid !== parentPid);
}
try {
  await mkdir(workspace, { recursive: true });
  current = launch("start");
  const first = current;
  const pids = await waitFor(async () => {
    if (first.exitCode !== null || first.signalCode !== null) throw new Error("Application exited before launching the fixture experiment");
    return json(path.join(workspace, "pids.json"));
  });
  const fixture = await json(path.join(temp, "fixture.json"));
  const repository = new ResearchRepository(path.join(temp, "user-data", "capture", "research"));
  await waitFor(async () => (await repository.listExperimentRuns(fixture.projectId)).some((run) => run.state === "running" && run.processId));
  descendants = await processTree(first.pid);
  assert.ok(descendants.includes(pids.command) && descendants.includes(pids.grandchild));
  assert.equal((await json(path.join(temp, "user-data", "startup-state.json"))).cleanShutdown, false);
  // Kill only Electron's main process. Supervisors must clean up descendants;
  // killing the whole tree here would hide an application-lifetime bug.
  first.kill("SIGKILL");
  await waitFor(() => first.exitCode !== null || first.signalCode !== null, 10_000);
  await waitFor(() => descendants.every((pid) => !isAlive(pid)), 15_000);
  report.crashedDescendantsCleaned = descendants.length;
  assert.equal(await readFile(path.join(workspace, "attempts.txt"), "utf8"), "one\n");
  current = launch("recover");
  await waitFor(async () => {
    const result = await json(path.join(temp, "recovered.json"));
    if (!result && (current.exitCode !== null || current.signalCode !== null)) throw new Error("Application recovery assertions failed");
    return result;
  });
  Object.assign(report, await json(path.join(temp, "recovered.json")));
  await waitFor(() => current.exitCode !== null || current.signalCode !== null, 15_000);
  assert.equal(current.exitCode, 0);
  assert.equal((await json(path.join(temp, "user-data", "startup-state.json"))).cleanShutdown, true);
  assert.equal(await readFile(path.join(workspace, "attempts.txt"), "utf8"), "one\n");
  assert.equal((await repository.listExperimentRuns(fixture.projectId)).length, 1);
  ok = true;
} catch (error) {
  report.failure = error.message;
  report.diagnosticsDirectory = temp;
  if (current) await writeFile(path.join(temp, "electron-stderr.txt"), current.diagnostics());
  process.exitCode = 1;
} finally {
  if (current?.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
  for (const pid of descendants) if (isAlive(pid)) {
    // Only PIDs observed in this test application's tree during this run.
    if (process.platform === "win32") await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    else { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  Object.assign(report, { ok, finishedAt: new Date().toISOString(), verificationScope: "Development Electron application, actual main-process SIGKILL, Harness/experiment descendant cleanup, restart through production startup and trusted Workspace IPC. Does not prove packaged upgrades, power-loss durability, or Linux runtime behavior." });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, reportPath }));
  if (ok) await rm(temp, { recursive: true, force: true });
}
