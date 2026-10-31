import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd());
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const checks = [];

function run(label, command, args, timeoutMs = 10 * 60_000) {
  return new Promise((resolve) => {
    // Node 24 on Windows cannot spawn a .cmd shim with shell:false (EINVAL).
    // All shim arguments here are fixed package scripts, so shell mode is safe.
    const child = spawn(command, args, { cwd: root, shell: command.toLowerCase().endsWith(".cmd"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode, signal, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      resolve({ label, command: [command, ...args].join(" "), exitCode, signal, timedOut, output, tail: output.slice(-4_000), ok: !timedOut && exitCode === 0 });
    };
    const timer = setTimeout(() => { child.kill(); finish(null, "SIGTERM", true); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-40_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", (error) => { stderr = `${stderr}${error instanceof Error ? error.message : String(error)}`; finish(null, undefined); });
    child.once("close", (code, signal) => finish(code, signal));
  });
}

function record(result) {
  checks.push(result);
  return result;
}

async function jsonFromOutput(output) {
  const start = output.indexOf("{");
  if (start < 0) return undefined;
  try { return JSON.parse(output.slice(start)); } catch { return undefined; }
}

record(await run("build", npm, ["run", "build"]));
record(await run("unit tests", npm, ["test"]));
record(await run("Harness smoke", process.execPath, ["scripts/research-harness-smoke.mjs"]));
record(await run("Harness native guard smoke", process.execPath, ["scripts/research-harness-smoke.mjs", "--guard"], 2 * 60_000));
record(await run("Harness PTC default guard smoke", process.execPath, ["scripts/research-harness-smoke.mjs", "--guard-ptc"], 2 * 60_000));
record(await run("SDK smoke", process.execPath, ["scripts/research-sdk-smoke.mjs"]));
record(await run("Research Workspace smoke", npm, ["run", "research:workspace:smoke"]));
record(await run("Research Workspace permissions smoke", npm, ["run", "research:access:smoke"], 2 * 60_000));
record(await run("Electron application crash recovery smoke", npm, ["run", "research:app-crash:smoke"], 3 * 60_000));
record(await run("package smoke", process.execPath, ["scripts/package-smoke.mjs"]));
record(await run("recovery audit", process.execPath, ["scripts/recovery-audit.mjs"]));
const releaseAudit = record(await run("release audit", process.execPath, ["scripts/release-audit.mjs"]));
for (const file of ["desktop/main.mjs", "desktop/dsh-sci-research-plugin.mjs", "desktop/research-dashboard.mjs", "scripts/research-workspace-smoke.mjs", "scripts/research-provider-smoke.mjs", "scripts/research-app-crash-smoke.mjs"]) record(await run(`syntax ${file}`, process.execPath, ["--check", file]));
record(await run("git diff check", "git", ["diff", "--check"]));

const release = await jsonFromOutput(releaseAudit.output);
const warnings = [];
if (release?.stale?.length) warnings.push(`stale installers present: ${release.stale.join(", ")}`);
if (release && !release.matching?.length) warnings.push("no installer matches the current package version; run dist:win only after external release validation");
const failed = checks.filter((check) => !check.ok);
const summary = {
  schema: "dsh-sci.release-preflight.v1",
  checkedAt: new Date().toISOString(),
  packageVersion: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  ok: failed.length === 0,
  failed: failed.map(({ label, exitCode, signal, timedOut }) => ({ label, exitCode, signal, timedOut })),
  warnings,
  releaseAudit: release,
  checks: checks.map(({ label, command, exitCode, signal, timedOut, ok, tail }) => ({ label, command, exitCode, signal, timedOut, ok, tail })),
};
console.log(JSON.stringify(summary, null, 2));
if (failed.length) process.exitCode = 1;
