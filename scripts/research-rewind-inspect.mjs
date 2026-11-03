// Local, static inspection only. No target code is imported or executed.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as asar from "@electron/asar";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
if (args.includes("--help")) {
  console.log("node scripts/research-rewind-inspect.mjs --rea <rea-agents/scripts/rea.mjs> [--node <compatible node.exe>] [--installation <Rewind directory>] [--output <new local directory>] [--scope all|shell|plugin]");
  process.exit(0);
}
const rea = option("--rea");
if (!rea) throw new Error("Supply an existing REA entry script with --rea; this command never installs tools.");
const node = option("--node", process.execPath);
const scope = option("--scope", "all");
if (!["all", "shell", "plugin"].includes(scope)) throw new Error("--scope must be all, shell or plugin");
const installation = path.resolve(option("--installation", path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Rewind")));
const output = path.resolve(option("--output", path.join("research", "rewind-analysis-local", new Date().toISOString().replace(/[:.]/g, "-"))));
const archive = path.join(installation, "resources", "app.asar");
const plugin = path.join(installation, "resources", "harness-update-base", "plugin");
await Promise.all([fs.access(rea), fs.access(node), fs.access(archive), fs.access(path.join(plugin, "package.json"))]);
// Refuse overwriting a previous investigation, including its Evidence IDs.
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output);
const slash = (value) => value.replaceAll("\\", "/").replace(/^\/+/, "");
const shellPaths = asar.listPackage(archive).map(slash).filter((name) => !name.split("/").includes("node_modules") && /\.(?:json|[cm]?js|html)$/.test(name));
const pluginPaths = ["package.json", "lib/index.js", "lib/native-worker.cjs", "lib/first-upgrade.cjs"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shellIdentity = shellPaths.map((name) => {
  const bytes = asar.extractFile(archive, name.split("/").join(path.sep));
  return { path: name, bytes: bytes.length, sha256: hash(bytes) };
});
const pluginIdentity = await Promise.all(pluginPaths.map(async (name) => {
  const bytes = await fs.readFile(path.join(plugin, name));
  return { path: name, bytes: bytes.length, sha256: hash(bytes) };
}));
const identity = { schema: "dsh-sci.rewind-static-inspection.v1", inspectedAt: new Date().toISOString(), installation, rea: path.resolve(rea), node, shellPackage: JSON.parse(asar.extractFile(archive, "package.json")), pluginPackage: JSON.parse(await fs.readFile(path.join(plugin, "package.json"), "utf8")), shellIdentity, pluginIdentity, scope: "Selected shipped shell and active Harness plugin sources; no user data, credentials, target execution or network probes. Legacy helpers and bundled dependencies remain outside source selection." };
await fs.writeFile(path.join(output, "identity.json"), JSON.stringify(identity, null, 2) + "\n");
async function analyze(label, target, sources) {
  const selection = path.join(output, `${label}-paths.json`);
  await fs.writeFile(selection, JSON.stringify(sources));
  const stdout = createWriteStream(path.join(output, `${label}-summary.json`), { flags: "wx" });
  const stderr = createWriteStream(path.join(output, `${label}-stderr.txt`), { flags: "wx" });
  const child = spawn(node, [path.resolve(rea), "analyze-javascript-application", target, "--source-paths-json", selection, "--detail", "summary", "--evidence_output", path.join(output, `${label}-evidence.json`), "--format", "json"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const streams = [stdout, stderr].map((stream) => new Promise((resolve, reject) => { stream.once("finish", resolve); stream.once("error", reject); }));
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await Promise.all(streams);
  console.log(JSON.stringify({ label, code, output }));
  return code;
}
const codes = await Promise.all([...(scope !== "plugin" ? [analyze("shell", archive, shellPaths)] : []), ...(scope !== "shell" ? [analyze("plugin", plugin, pluginPaths)] : [])]);
process.exitCode = codes.every((code) => code === 0) ? 0 : 1;
