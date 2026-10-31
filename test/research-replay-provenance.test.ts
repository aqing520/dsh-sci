import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeProject } from "../src/research/domain.js";
import { makeExperimentDesign } from "../src/research/experiment-design.js";
import { makeExperimentDefinition, experimentBindingHash, type ExperimentRun } from "../src/research/experiment.js";
import { bindReplayRun, bindReplayArtifact } from "../src/research/replay-provenance.js";
import type { ResearchArtifact } from "../src/research/artifact.js";
import type { ResearchCodeBundle } from "../src/research/code-staging.js";

function fixture() {
  const project = makeProject("Synthetic provenance fixture");
  const at = "2026-10-30T01:00:00.000Z", later = "2026-10-30T01:00:01.000Z";
  const root = path.resolve("test-fixture-workspace"), codePath = path.join(root, "run.mjs"), outputPath = path.join(root, "output", "config.json");
  const hash = "a".repeat(64);
  const design = makeExperimentDesign(project.projectId, { planId: "plan", taskId: "design-task", hypothesisIds: ["hypothesis"], hypothesisBindings: [{ hypothesisId: "hypothesis", contentHash: hash }], dataDescription: "Synthetic four-cell fixture", dataVersion: "fixture", experimentalUnit: "replicate", independentVariables: ["method"], dependentVariables: ["loss"], controls: ["paired"], primaryMetric: "MSE", repetitions: 100, randomization: "fixed seed", missingDataHandling: "fixed count", analysisMethod: "paired bootstrap", stoppingRule: "100 repeats" }, at, "design");
  design.status = "approved"; design.approvedAt = at;
  const bundle: ResearchCodeBundle = { schema: "dsh-sci.research-code-bundle.v1", bundleId: "bundle", projectId: project.projectId, planId: "plan", taskId: "design-task", contentHash: hash, directory: root, files: [{ name: "run.mjs", kind: "code", path: codePath, bytes: 10, contentHash: hash }], createdAt: at };
  const experiment = makeExperimentDefinition(project.projectId, { title: "Provenance fixture", command: "node", args: ["run.mjs"], cwd: root, designId: design.designId, codeBundleId: bundle.bundleId, hypothesisIds: design.hypothesisIds, taskId: "run-task", codePaths: [codePath], outputPaths: [path.dirname(outputPath)] }, at);
  experiment.planId = "plan"; experiment.designContentHash = design.contentHash;
  experiment.codeManifest = [{ path: codePath, relativePath: "run.mjs", exists: true, bytes: 10, sha256: hash }]; experiment.inputManifest = [];
  experiment.proposalContentHash = experimentBindingHash(experiment, experiment.codeManifest, experiment.inputManifest);
  experiment.approval = { approvedAt: at, proposalContentHash: experiment.proposalContentHash, bindingHash: experiment.proposalContentHash, codeManifest: structuredClone(experiment.codeManifest), inputManifest: [] };
  const run: ExperimentRun = { schema: "dsh-sci.experiment-run.v1", runId: "run", experimentId: experiment.experimentId, projectId: project.projectId, state: "completed", startedAt: at, finishedAt: later, exitCode: 0, stdout: "", stderr: "", truncated: false, manifest: { schema: "dsh-sci.experiment-manifest.v1", command: experiment.command, args: experiment.args, cwd: root, environment: {}, code: structuredClone(experiment.codeManifest), inputs: [], outputs: [{ path: outputPath, relativePath: "output/config.json", exists: true, bytes: 20, sha256: hash }] } };
  const artifact: ResearchArtifact = { schema: "dsh-sci.research-artifact.v1", artifactId: "artifact", projectId: project.projectId, kind: "dataset", path: outputPath, relativePath: "output/config.json", mediaType: "application/json", bytes: 20, contentHash: hash, experimentRef: run.runId, metadata: {}, createdAt: later };
  return { project, experiments: [experiment], experimentRuns: [run], experimentDesigns: [design], codeBundles: [bundle], artifacts: [artifact] };
}

test("replay binds an approved terminal run and verifies both artifact and terminal manifest hashes", () => {
  const snapshot = fixture(), binding = bindReplayRun(snapshot);
  const artifact = snapshot.artifacts[0];
  assert.equal(binding.run.runId, "run");
  assert.equal(bindReplayArtifact(binding, artifact, { path: artifact.path, bytes: 20, contentHash: artifact.contentHash }).artifactId, "artifact");
  assert.throws(() => bindReplayArtifact(binding, artifact, { path: artifact.path, bytes: 20, contentHash: "b".repeat(64) }), /registered run artifact/);
  binding.run.manifest.outputs[0].sha256 = "c".repeat(64);
  assert.throws(() => bindReplayArtifact(binding, artifact, { path: artifact.path, bytes: 20, contentHash: artifact.contentHash }), /terminal run output manifest/);
});

test("replay refuses missing approvals, edited commands, stale design hashes and unsuccessful runs", () => {
  const mutations = [
    (s: ReturnType<typeof fixture>) => { s.experiments[0].approval = undefined; },
    (s: ReturnType<typeof fixture>) => { s.experiments[0].args = ["other.mjs"]; },
    (s: ReturnType<typeof fixture>) => { s.experimentDesigns[0].contentHash = "b".repeat(64); },
    (s: ReturnType<typeof fixture>) => { s.experimentRuns[0].manifest.code![0].sha256 = "b".repeat(64); },
    (s: ReturnType<typeof fixture>) => { s.codeBundles[0].files[0].contentHash = "b".repeat(64); },
    (s: ReturnType<typeof fixture>) => { s.experimentRuns[0].state = "interrupted"; },
    (s: ReturnType<typeof fixture>) => { s.experimentRuns[0].exitCode = 1; },
    (s: ReturnType<typeof fixture>) => { s.experiments[0].approval!.approvedAt = "2026-10-30T02:00:00Z"; },
    (s: ReturnType<typeof fixture>) => { s.experimentRuns[0].projectId = "foreign-project"; },
  ];
  for (const mutate of mutations) { const s = fixture(); mutate(s); assert.throws(() => bindReplayRun(s, "run")); }
});

test("multiple completed runs require explicit selection; artifact paths cannot choose a run", () => {
  const snapshot = fixture();
  snapshot.experimentRuns.push({ ...snapshot.experimentRuns[0], runId: "second" });
  assert.throws(() => bindReplayRun(snapshot), /exactly one completed run/);
  assert.equal(bindReplayRun(snapshot, "run").run.runId, "run");
  assert.throws(() => bindReplayRun(snapshot, "missing"), /exactly one completed run/);
});
