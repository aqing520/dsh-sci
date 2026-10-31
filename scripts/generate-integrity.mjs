import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIntegrityManifest } from "../dist/src/integrity.js";
import { readFile as readText } from "node:fs/promises";

const [rootArg = ".", outputArg = "dsh-sci.integrity.json", ...files] = process.argv.slice(2);
if (!files.length) throw new Error("Usage: node scripts/generate-integrity.mjs <root> <output> <relative-file> [...files]");
const root = path.resolve(rootArg);
const output = path.resolve(root, outputArg);
let appVersion;
try { appVersion = JSON.parse(await readText(path.join(root, "package.json"))).version; } catch { appVersion = undefined; }
const manifest = await createIntegrityManifest(root, files, { appVersion, generatorVersion: "dsh-sci.integrity.v1" });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${output} with ${manifest.entries.length} entries`);
