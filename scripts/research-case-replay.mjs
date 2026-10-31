import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCaseReplayConfig, inspectCaseProtocolBinding } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const caseArg = option("--case");
if (!caseArg) throw new Error("Usage: node scripts/research-case-replay.mjs --case <case-directory> [--run-id <run-id>]");
const caseDirectory = await realpath(path.resolve(caseArg));
const evidenceRoot = await realpath(path.join(root, "research", "validation", "cases"));
const relative = path.relative(evidenceRoot, caseDirectory);
if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Case directory must be inside research/validation/cases");
const [{ verifyReplay, replayDigest }, { bindReplayRun, bindReplayArtifact }, { ResearchRepository }] = await Promise.all([
  import("../dist/src/research/replay.js"), import("../dist/src/research/replay-provenance.js"), import("../dist/src/research/repository.js"),
]);
const protocol = JSON.parse(await readFile(path.join(caseDirectory, "protocol.json"), "utf8"));
const workspace = await realpath(path.join(caseDirectory, "runtime", "workspace"));
const repository = new ResearchRepository(path.join(caseDirectory, "runtime", "research"));
const projects = await repository.listProjects(10_000);
if (projects.length !== 1) throw new Error("Replay case must contain exactly one project");
const snapshot = await repository.exportProject(projects[0].projectId);
if (inspectCaseProtocolBinding(protocol, snapshot.project.question).status !== "bound") throw new Error("Case omitted the complete frozen protocol; retain as historical evidence rather than certify replay");
const binding = bindReplayRun(snapshot, option("--run-id"));
const candidates = binding.artifacts.filter((artifact) => path.basename(artifact.path) === "config.json");
if (candidates.length !== 1) throw new Error("Run must have exactly one registered config.json artifact");
const output = path.dirname(await realpath(candidates[0].path));
const inside = (target) => { const rel = path.relative(workspace, target); if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Replay artifact escapes workspace"); };
inside(output);
const values = new Map(), files = [];
for (const artifact of binding.artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
  const name = path.basename(artifact.path);
  if (!["config.json", "replicates.json", "summary.json"].includes(name) && !/^data-(?:lognormal|normal)-\d+\.json$/u.test(name)) continue;
  if (path.dirname(path.resolve(artifact.path)) !== output || values.has(name)) throw new Error(`Duplicate or misplaced replay artifact: ${name}`);
  const file = await realpath(artifact.path); inside(file);
  const bytes = await readFile(file);
  files.push(bindReplayArtifact(binding, artifact, { path: file, bytes: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") }));
  values.set(name, JSON.parse(bytes.toString("utf8")));
}
const config = values.get("config.json");
assertCaseReplayConfig(protocol, config);
if (config.designId !== binding.design.designId || config.sourceSha256 !== binding.source.contentHash) throw new Error("Output config differs from approved design/source binding");
const rows = values.get("replicates.json"), summaries = values.get("summary.json");
if (!Array.isArray(rows) || !Array.isArray(summaries)) throw new Error("Missing registered replicate/summary arrays");
const data = [...values].filter(([name]) => name.startsWith("data-")).map(([, value]) => value);
const verification = verifyReplay({ config: config.cfg, data, rows, summaries });
const provenance = { projectId: binding.run.projectId, runId: binding.run.runId, experimentId: binding.experiment.experimentId, proposalContentHash: binding.experiment.proposalContentHash, designId: binding.design.designId, designContentHash: binding.design.contentHash, bundleId: binding.bundle.bundleId, sourceSha256: binding.source.contentHash, files };
const result = { schema: "dsh-sci.research-case-replay.v1", caseDirectory: relative.replaceAll("\\", "/"), protocolVersion: protocol.protocolVersion, inputDigest: replayDigest(provenance), provenance, verification, generatedAt: new Date().toISOString() };
const checksDirectory = path.join(caseDirectory, "independent-checks");
await mkdir(checksDirectory, { recursive: true });
await writeFile(path.join(checksDirectory, `${Date.now()}-${result.inputDigest}.json`), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify(result, null, 2));
if (verification.status !== "matched") process.exitCode = 2;
