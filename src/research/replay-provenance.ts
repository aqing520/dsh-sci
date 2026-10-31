import path from "node:path";
import type { ResearchRepository } from "./repository.js";
import type { ResearchArtifact } from "./artifact.js";
import { experimentBindingHash } from "./experiment.js";

type Snapshot = Pick<Awaited<ReturnType<ResearchRepository["exportProject"]>>, "project" | "experimentRuns" | "experiments" | "experimentDesigns" | "codeBundles" | "artifacts">;

/** Bind replay to a persisted terminal run, never to an output folder name. */
export function bindReplayRun(snapshot: Snapshot, runId?: string) {
  const runs = snapshot.experimentRuns.filter((run) => runId ? run.runId === runId : run.state === "completed");
  if (runs.length !== 1) throw new Error("Replay requires exactly one completed run; supply --run-id when several runs exist");
  const run = runs[0], projectId = snapshot.project.projectId;
  if (run.projectId !== projectId || run.state !== "completed" || run.exitCode !== 0 || !run.finishedAt) throw new Error("Replay requires a successful completed run from this project");
  const experiment = snapshot.experiments.find((item) => item.experimentId === run.experimentId && item.projectId === projectId);
  const approval = experiment?.approval;
  if (!experiment || !approval || !experiment.proposalContentHash || approval.bindingHash !== experiment.proposalContentHash || approval.proposalContentHash !== experiment.proposalContentHash || experimentBindingHash(experiment, approval.codeManifest, approval.inputManifest) !== experiment.proposalContentHash) throw new Error("Replay experiment has no matching immutable content approval");
  const design = snapshot.experimentDesigns.find((item) => item.designId === experiment.designId && item.projectId === projectId);
  if (!design || !design.approvedAt || design.status === "draft" || design.contentHash !== experiment.designContentHash || design.planId !== experiment.planId) throw new Error("Replay experiment does not bind its approved design version");
  const bundle = snapshot.codeBundles?.find((item) => item.bundleId === experiment.codeBundleId && item.projectId === projectId && item.planId === experiment.planId);
  if (!bundle) throw new Error("Replay experiment has no bound staged code bundle");
  const source = bundle.files.find((item) => item.name === "run.mjs" && item.kind === "code");
  if (!source || !approval.codeManifest.some((item) => item.path === source.path && item.sha256 === source.contentHash && item.bytes === source.bytes)) throw new Error("Replay entry point does not match the approved code");
  if (JSON.stringify(run.manifest.code) !== JSON.stringify(approval.codeManifest) || JSON.stringify(run.manifest.inputs) !== JSON.stringify(approval.inputManifest) || run.manifest.command !== experiment.command || JSON.stringify(run.manifest.args) !== JSON.stringify(experiment.args) || run.manifest.cwd !== experiment.cwd) throw new Error("Run launch manifest differs from its approved content");
  for (const date of [run.startedAt, run.finishedAt, approval.approvedAt, design.approvedAt]) if (!Number.isFinite(Date.parse(date))) throw new Error("Replay binding has an invalid timestamp");
  if (Date.parse(approval.approvedAt) > Date.parse(run.startedAt) || Date.parse(design.approvedAt) > Date.parse(run.startedAt) || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) throw new Error("Replay run predates approval or has invalid ordering");
  const artifacts = snapshot.artifacts.filter((item) => item.projectId === projectId && item.experimentRef === run.runId);
  return { run, experiment, design, bundle, source, artifacts };
}

export function bindReplayArtifact(binding: ReturnType<typeof bindReplayRun>, artifact: ResearchArtifact, actual: { path: string; contentHash: string; bytes: number }) {
  if (!binding.artifacts.some((item) => item.artifactId === artifact.artifactId) || artifact.experimentRef !== binding.run.runId || path.resolve(artifact.path) !== path.resolve(actual.path) || artifact.contentHash !== actual.contentHash || artifact.bytes !== actual.bytes) throw new Error("Replay input differs from its registered run artifact");
  const output = binding.run.manifest.outputs.find((item) => path.resolve(item.path) === path.resolve(actual.path));
  if (!output?.exists || output.sha256 !== actual.contentHash || output.bytes !== actual.bytes) throw new Error("Replay input differs from the terminal run output manifest");
  return { artifactId: artifact.artifactId, relativePath: artifact.relativePath.replaceAll("\\", "/"), contentHash: actual.contentHash, bytes: actual.bytes };
}
