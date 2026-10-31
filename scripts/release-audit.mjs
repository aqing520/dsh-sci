import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd());
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseRoot = path.join(root, "release");
const version = String(packageJson.version);
let names = [];
try { names = await readdir(releaseRoot); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
const installers = names.filter((name) => /^dsh-sci Setup \d+\.\d+\.\d+\.exe$/i.test(name));
const matching = installers.filter((name) => name.toLowerCase() === `dsh-sci setup ${version}.exe`.toLowerCase());
const stale = installers.filter((name) => !matching.includes(name));
const result = { packageVersion: version, releaseDirectory: releaseRoot, installers, matching, stale, status: matching.length ? (stale.length ? "current-and-stale" : "current") : installers.length ? "stale-only" : "no-installer" };
try { await access(path.join(root, "dist", "src", "harness.js")); result.buildPresent = true; }
catch { result.buildPresent = false; }
console.log(JSON.stringify(result, null, 2));
