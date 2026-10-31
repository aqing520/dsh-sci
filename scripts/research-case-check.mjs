import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const protocolPath = path.join(root, "research", "benchmarks", "imputation-v1.json");
const frozen = JSON.parse(await readFile(protocolPath, "utf8"));
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--case") && !(args.length === 1 && args[0].startsWith("--case="))) throw new Error("Usage: research-case-check.mjs [--case <case-directory>]");
const caseArg = args[0] === "--case" ? args[1] : args[0]?.slice(7);
let caseDirectory;
if (caseArg) {
  caseDirectory = await realpath(path.resolve(caseArg));
  const evidenceRoot = await realpath(path.join(root, "research", "validation", "cases"));
  const relative = path.relative(evidenceRoot, caseDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Case directory must be inside research/validation/cases");
}
const protocol = caseDirectory ? JSON.parse(await readFile(path.join(caseDirectory, "protocol.json"), "utf8")) : frozen;
assert.deepEqual(protocol, frozen, "Case protocol differs from the frozen benchmark; retain the discrepancy for review");
assert.equal(protocol.schema, "dsh-sci.research-benchmark.v1");
assert.equal(protocol.caseId, "imputation-v1");
assert.equal(protocol.data.seed, 20261030);
assert.equal(protocol.data.independentReplicates, 100);
assert.deepEqual(protocol.data.missingFractions, [0.1, 0.3, 0.5]);
assert.equal(protocol.analysis.experimentalUnit, "Independent simulation replicate, paired across methods");
assert.equal(protocol.approval.automaticallyApproveTasks, false);
assert.equal(protocol.approval.automaticallyExecuteExperiments, false);
assert.ok(protocol.requiredArtifacts.includes("falsifiable-hypothesis"));
assert.ok(protocol.requiredArtifacts.includes("cross-session-memory-evidence"));
const digest = createHash("sha256").update(JSON.stringify(protocol)).digest("hex");
console.log(JSON.stringify({ schema: "dsh-sci.research-case-check.v1", ok: true, caseId: protocol.caseId, ...(caseDirectory ? { caseDirectory: path.relative(root, caseDirectory).replaceAll("\\", "/") } : {}), protocolVersion: protocol.protocolVersion, protocolSha256: digest, requiredArtifacts: protocol.requiredArtifacts.length, verificationScope: "Frozen protocol integrity only; does not verify design/code compliance, artifact presence or scientific quality." }));
