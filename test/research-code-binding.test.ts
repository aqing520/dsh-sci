import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { experimentBindingHash, type ExperimentDefinition } from "../src/research/experiment.js";
import { taskResultIdentity } from "../src/research/task-result.js";
import { codeStagingFailureCode, stageResearchCode } from "../src/research/code-staging.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-code-binding-"));
  const repository = new ResearchRepository(root);
  const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root } });
  const created = await orchestrator.createProject("Run approved staged code", {
    plan: { question: "Run approved staged code", tasks: [{ taskId: "run", title: "Run", objective: "Execute staged code", kind: "experiment", requiresApproval: true }] },
  });
  await orchestrator.activatePlan(created.project.projectId);
  await orchestrator.startNextTask(created.project.projectId);
  await orchestrator.approveTask(created.project.projectId, "run");
  return { root, repository, orchestrator, projectId: created.project.projectId, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function proposal(f: Awaited<ReturnType<typeof fixture>>) {
  const input = { files: [
    { name: "run.cjs", kind: "code" as const, content: "const fs=require('node:fs');fs.writeFileSync('launched.txt',fs.readFileSync('input.txt'));console.log(42)\n" },
    { name: "input.txt", kind: "input" as const, content: "frozen-input\n" },
    { name: "dependencies.lock", kind: "dependency" as const, content: "node-builtins-only\n" },
  ] };
  const bundle = await f.orchestrator.stageCode(f.projectId, input);
  const definition = await f.orchestrator.createExperiment(f.projectId, { title: "Frozen run", taskId: "run", command: process.execPath, args: ["run.cjs"], codeBundleId: bundle.bundleId, outputPaths: ["launched.txt"], randomSeed: 7 });
  return { bundle, definition, input, marker: path.join(bundle.directory, "launched.txt") };
}

test("staging never replaces changed files, and a code revision creates another bundle", async () => {
  const f = await fixture();
  try {
    const { input, bundle } = await proposal(f);
    const target = bundle.files.find((file) => file.kind === "code")!.path;
    await writeFile(target, "locally-edited\n");
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, input), /cannot be overwritten/);
    assert.equal(await readFile(target, "utf8"), "locally-edited\n");
    const revised = await f.orchestrator.stageCode(f.projectId, { files: input.files.map((file) => file.kind === "code" ? { ...file, content: "console.log('revision')\n" } : file) });
    assert.notEqual(revised.bundleId, bundle.bundleId);
    assert.equal(await readFile(target, "utf8"), "locally-edited\n");
  } finally { await f.cleanup(); }
});

test("baseBundleId revisions preserve verified inherited files and create a complete new bundle", async () => {
  const f = await fixture();
  try {
    const initial = await f.orchestrator.stageCode(f.projectId, { files: [
      { name: "run.mjs", kind: "code", content: "export const version = 1;\n" },
      { name: "protocol.json", kind: "input", content: '{"version":1}\n' },
      { name: "deps.lock", kind: "dependency", content: "node-builtins\n" },
    ] });
    const revised = await f.orchestrator.stageCode(f.projectId, { baseBundleId: initial.bundleId, files: [
      { name: "imputation.test.mjs", kind: "code", content: "export const expected = '0.266429208685';\n" },
    ] });
    assert.notEqual(revised.bundleId, initial.bundleId);
    assert.deepEqual(revised.files.map(({ name, kind }) => ({ name, kind })), [
      { name: "deps.lock", kind: "dependency" }, { name: "imputation.test.mjs", kind: "code" }, { name: "protocol.json", kind: "input" }, { name: "run.mjs", kind: "code" },
    ]);
    assert.equal(await readFile(revised.files.find((file) => file.name === "run.mjs")!.path, "utf8"), "export const version = 1;\n");
    assert.equal(await readFile(revised.files.find((file) => file.name === "protocol.json")!.path, "utf8"), '{"version":1}\n');
    const events = await f.repository.listEvents(f.projectId);
    const staged = events.filter((event) => event.type === "code-staged");
    assert.equal(staged.length, 2);
    assert.equal(staged[1].data?.baseBundleId, initial.bundleId);
    assert.equal((staged[1].data as any)?.suppliedFileNames?.[0], "imputation.test.mjs");
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { baseBundleId: "bundle-" + "0".repeat(64), files: [{ name: "run.mjs", kind: "code", content: "changed" }] }), /Code bundle must belong|staged|base/);
    await writeFile(revised.files.find((file) => file.name === "run.mjs")!.path, "tampered\n");
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { baseBundleId: revised.bundleId, files: [{ name: "run.mjs", kind: "code", content: "fixed" }] }), /changed since registration/);
  } finally { await f.cleanup(); }
});

test("incremental revisions enforce limits on the full merge and reject ambiguous replacements without writes", async () => {
  const f = await fixture();
  try {
    const maxFiles = await f.orchestrator.stageCode(f.projectId, { files: [
      { name: "run.mjs", kind: "code", content: "export const version = 1;\n" },
      ...Array.from({ length: 19 }, (_, i) => ({ name: `input-${i}.txt`, kind: "input" as const, content: "fixed" })),
    ] });
    const maxBytes = await f.orchestrator.stageCode(f.projectId, { files: [
      { name: "run.mjs", kind: "code", content: "export const version = 1;\n" },
      ...Array.from({ length: 3 }, (_, i) => ({ name: `large-${i}.txt`, kind: "input" as const, content: "x".repeat(128 * 1024) })),
    ] });
    const before = JSON.stringify(await f.repository.exportProject(f.projectId));
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { baseBundleId: maxFiles.bundleId, files: [{ name: "extra.txt", kind: "input", content: "extra" }] }), /1 to 20 files/);
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { baseBundleId: maxBytes.bundleId, files: [{ name: "large-3.txt", kind: "input", content: "x".repeat(128 * 1024) }] }), /512 KiB/);
    for (const files of [
      [{ name: "RUN.MJS", kind: "code" as const, content: "export const version = 2;" }],
      [{ name: "run.mjs", kind: "input" as const, content: "export const version = 2;" }],
    ]) await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { baseBundleId: maxFiles.bundleId, files }), /exact name and kind/);
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { baseBundleId: maxFiles.bundleId, files: [
      { name: "run.mjs", kind: "code", content: "export const v = 1;" },
      { name: "RUN.MJS", kind: "code", content: "export const v = 2;" },
    ] }), /Duplicate/);
    assert.equal(JSON.stringify(await f.repository.exportProject(f.projectId)), before);
    assert.equal(await readFile(maxFiles.files.find((file) => file.name === "run.mjs")!.path, "utf8"), "export const version = 1;\n");
  } finally { await f.cleanup(); }
});

test("revision bases must be registered in this project and current task dependencies", async () => {
  const f = await fixture();
  try {
    const project = (await f.repository.readProject(f.projectId))!;
    const files = [{ name: "run.mjs", kind: "code" as const, content: "export const version = 1;\n" }];
    const other = await f.orchestrator.createProject("Foreign revision candidate");
    const foreign = await stageResearchCode(f.root, { projectId: other.project.projectId, planId: other.plan.planId, taskId: other.plan.tasks[0].taskId }, { files });
    await f.repository.saveCodeBundle(foreign);
    const unrelated = await stageResearchCode(f.root, { projectId: f.projectId, planId: project.planId!, taskId: "unrelated" }, { files });
    const oldPlan = await stageResearchCode(f.root, { projectId: f.projectId, planId: "old-plan", taskId: "run" }, { files });
    await f.repository.saveCodeBundle(unrelated); await f.repository.saveCodeBundle(oldPlan);
    const before = JSON.stringify(await f.repository.exportProject(f.projectId));
    for (const baseBundleId of [foreign.bundleId, unrelated.bundleId, oldPlan.bundleId]) {
      await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { baseBundleId, files: [{ name: "run.mjs", kind: "code", content: "export const version = 2;" }] }), /current-plan dependencies/);
    }
    assert.equal(JSON.stringify(await f.repository.exportProject(f.projectId)), before);
  } finally { await f.cleanup(); }
});

test("a dependent preparation task can revise its ancestor into its own complete bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-code-revision-dependency-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root } });
    const { project } = await orchestrator.createProject("Revise a prepared candidate", { plan: { question: "Revise a prepared candidate", tasks: [
      { taskId: "prepare", title: "Prepare", objective: "Prepare candidate", kind: "code-preparation" },
      { taskId: "revise", title: "Revise", objective: "Revise candidate", kind: "code-preparation", dependsOn: ["prepare"] },
    ] } });
    await orchestrator.activatePlan(project.projectId); await orchestrator.startNextTask(project.projectId);
    const first = await orchestrator.stageCode(project.projectId, { files: [{ name: "run.mjs", kind: "code", content: "export const version = 1;" }, { name: "protocol.json", kind: "input", content: '{"frozen":true}' }] });
    await orchestrator.completeTask(project.projectId, "prepare", [first.bundleId]);
    await orchestrator.startNextTask(project.projectId);
    const revised = await orchestrator.stageCode(project.projectId, { baseBundleId: first.bundleId, files: [{ name: "run.mjs", kind: "code", content: "export const version = 2;" }] });
    assert.equal(revised.taskId, "revise"); assert.notEqual(revised.bundleId, first.bundleId);
    assert.equal(await readFile(revised.files.find((file) => file.name === "protocol.json")!.path, "utf8"), '{"frozen":true}');
    await orchestrator.completeTask(project.projectId, "revise", [revised.bundleId]);
    const snapshot = await repository.exportProject(project.projectId);
    assert.equal(snapshot.codeReads?.length ?? 0, 0); assert.equal(snapshot.codeReviews?.length ?? 0, 0);
    assert.equal(snapshot.experiments.length, 0); assert.equal(snapshot.experimentRuns.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging rejects junctions before creating files in their target", async () => {
  const f = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "dsh-sci-stage-outside-"));
  try {
    await symlink(outside, path.join(f.root, ".dsh-sci"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { files: [{ name: "run.cjs", kind: "code", content: "console.log(1)" }] }), /symbolic links|junctions/);
    await assert.rejects(() => access(path.join(outside, "experiments")), { code: "ENOENT" });
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test("staging validates every name and size before it writes a bundle", async () => {
  const f = await fixture();
  try {
    for (const name of ["/absolute.py", "C:/outside.py", "a/../run.py", "a//run.py", "CON.txt", "folder./run.py", "a\\run.py"]) {
      await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { files: [{ name, kind: "code", content: "x" }] }), /safe relative/);
    }
    await assert.rejects(() => f.orchestrator.stageCode(f.projectId, { files: [{ name: "run.py", kind: "code", content: "x".repeat(128 * 1024 + 1) }] }), /limit/);
    await assert.rejects(() => access(path.join(f.root, ".dsh-sci")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("an approved proposal executes real staged files and records their manifests", async () => {
  const f = await fixture();
  try {
    const { definition, marker } = await proposal(f);
    await assert.rejects(() => f.orchestrator.executeExperiment(f.projectId, definition.experimentId, { approved: true }), /approval|refused/);
    await assert.rejects(() => f.orchestrator.approveExperiment(f.projectId, definition.experimentId, "stale-view"), /changed/);
    await f.orchestrator.approveExperiment(f.projectId, definition.experimentId, definition.proposalContentHash!);
    const run = await f.orchestrator.executeExperiment(f.projectId, definition.experimentId, { approved: true });
    assert.equal(run.state, "completed");
    assert.equal(await readFile(marker, "utf8"), "frozen-input\n");
    assert.deepEqual(run.manifest.code, definition.codeManifest);
    assert.deepEqual(run.manifest.inputs, definition.inputManifest);
    assert.equal(run.manifest.randomSeed, 7);
  } finally { await f.cleanup(); }
});

test("content changed during durable preparation is refused before any child starts", async () => {
  const f = await fixture();
  try {
    const { definition, bundle, marker } = await proposal(f);
    await f.orchestrator.approveExperiment(f.projectId, definition.experimentId, definition.proposalContentHash!);
    const appendEvent = f.repository.appendEvent.bind(f.repository);
    f.repository.appendEvent = async (event) => {
      await appendEvent(event);
      if (event.type === "experiment-started") await writeFile(bundle.files.find((file) => file.kind === "input")!.path, "changed-during-journal\n");
    };
    const run = await f.orchestrator.executeExperiment(f.projectId, definition.experimentId, { approved: true });
    assert.equal(run.state, "failed");
    assert.equal(run.processId, undefined);
    assert.match(run.error!, /changed|refused/);
    await assert.rejects(() => access(marker), { code: "ENOENT" });
    assert.equal((await f.repository.listExperimentRuns(f.projectId))[0].state, "failed");
  } finally { await f.cleanup(); }
});

test("the binding rejects command edits and all recorded approval fields survive restart", async () => {
  const f = await fixture();
  try {
    const { definition, marker, bundle } = await proposal(f);
    const approved = await f.orchestrator.approveExperiment(f.projectId, definition.experimentId, definition.proposalContentHash!);
    const reopened = new ResearchRepository(f.root);
    assert.deepEqual(await reopened.readCodeBundle(f.projectId, bundle.bundleId), bundle);
    assert.deepEqual((await reopened.readExperiment(f.projectId, definition.experimentId))!.approval, approved.approval);
    await reopened.saveExperiment({ ...approved, args: ["-e", "require('node:fs').writeFileSync('launched.txt','changed')"] });
    await assert.rejects(() => new ResearchOrchestrator(reopened, {}, undefined, { experimentPolicy: { workspaceRoot: f.root } }).executeExperiment(f.projectId, definition.experimentId, { approved: true }), /changed|refused/);
    await assert.rejects(() => access(marker), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("proposal identity binds commands, inputs, code, design, hypotheses and execution options", async () => {
  const f = await fixture();
  try {
    const { definition } = await proposal(f);
    const hash = (candidate: ExperimentDefinition) => experimentBindingHash(candidate, candidate.codeManifest!, candidate.inputManifest!);
    for (const patch of [{ command: "other" }, { args: ["other.cjs"] }, { cwd: f.root }, { inputPaths: [] }, { codePaths: [] }, { outputPaths: [] }, { randomSeed: 8 }, { timeoutMs: 100 }, { designId: "other" }, { designContentHash: "other" }, { hypothesisIds: ["other"] }, { codeBundleId: "other" }]) {
      assert.notEqual(hash({ ...definition, ...patch }), definition.proposalContentHash);
    }
    assert.notEqual(hash({ ...definition, codeManifest: definition.codeManifest!.map((item) => ({ ...item, sha256: "other" })) }), definition.proposalContentHash);
    assert.notEqual(hash({ ...definition, inputManifest: definition.inputManifest!.map((item) => ({ ...item, sha256: "other" })) }), definition.proposalContentHash);
  } finally { await f.cleanup(); }
});

test("legacy independent experiment definitions retain explicit execution approval", async () => {
  const f = await fixture();
  try {
    const definition = await f.orchestrator.createExperiment(f.projectId, { title: "Old definition", command: process.execPath, args: ["-e", "console.log('legacy')"] });
    const { proposalContentHash: _hash, codeManifest: _code, inputManifest: _inputs, ...legacy } = definition;
    await f.repository.saveExperiment(legacy);
    await assert.rejects(() => f.orchestrator.executeExperiment(f.projectId, legacy.experimentId), /explicit approval/);
    assert.equal((await f.orchestrator.executeExperiment(f.projectId, legacy.experimentId, { approved: true })).state, "completed");
  } finally { await f.cleanup(); }
});

test("a script entry omitted from codePaths is still frozen and cannot be replaced after approval", async () => {
  const f = await fixture();
  try {
    const codePath = path.join(f.root, "entry.cjs"), marker = path.join(f.root, "launched.txt");
    await writeFile(codePath, "require('node:fs').writeFileSync('launched.txt','started')\n");
    const definition = await f.orchestrator.createExperiment(f.projectId, { title: "Inferred entry", command: process.execPath, args: [codePath] });
    assert.equal(definition.codeManifest!.length, 1);
    await f.orchestrator.approveExperiment(f.projectId, definition.experimentId, definition.proposalContentHash!);
    await writeFile(codePath, "require('node:fs').writeFileSync('launched.txt','replaced')\n");
    await assert.rejects(() => f.orchestrator.executeExperiment(f.projectId, definition.experimentId, { approved: true }), /changed|refused/);
    await assert.rejects(() => access(marker), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("review returns bounded input previews, rejects changed content, and writes no approval", async () => {
  const f = await fixture();
  try {
    const inputPath = path.join(f.root, "large.txt");
    await writeFile(inputPath, "input ".repeat(3000));
    const definition = await f.orchestrator.createExperiment(f.projectId, { title: "Preview", command: process.execPath, args: ["-e", "console.log(1)"], inputPaths: [inputPath] });
    const before = (await f.repository.listEvents(f.projectId)).length;
    const review = await f.orchestrator.experimentReview(f.projectId, definition.experimentId);
    assert.equal(review.files[0].truncated, true);
    assert.equal(Buffer.byteLength(review.files[0].text), 8 * 1024);
    assert.equal((await f.repository.readExperiment(f.projectId, definition.experimentId))!.approval, undefined);
    assert.equal((await f.repository.listEvents(f.projectId)).length, before);
    await writeFile(inputPath, "changed");
    await assert.rejects(() => f.orchestrator.experimentReview(f.projectId, definition.experimentId), /changed/);
  } finally { await f.cleanup(); }
});

test("missing files and an input link escaping the workspace cannot become an approvable proposal", async () => {
  const f = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "dsh-sci-input-outside-"));
  try {
    const input = { title: "Invalid input", command: process.execPath, args: ["-e", "console.log(1)"] };
    await assert.rejects(() => f.orchestrator.createExperiment(f.projectId, { ...input, inputPaths: ["missing.txt"] }), /missing/);
    await writeFile(path.join(outside, "data.txt"), "external");
    await symlink(outside, path.join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => f.orchestrator.createExperiment(f.projectId, { ...input, inputPaths: ["linked/data.txt"] }), /outside the workspace/);
    assert.equal((await f.repository.listExperiments(f.projectId)).length, 0);
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test("encrypted restart retains the staged code, content approval and an executable binding", async () => {
  const f = await fixture();
  try {
    const encryptedRoot = path.join(f.root, "encrypted-store");
    const options = { metadataPassphrase: "fixture-only-passphrase" };
    const encrypted = new ResearchRepository(encryptedRoot, options);
    const orchestrator = new ResearchOrchestrator(encrypted, {}, undefined, { experimentPolicy: { workspaceRoot: f.root } });
    const { project } = await orchestrator.createProject("Encrypted code", { plan: { question: "Encrypted code", tasks: [{ taskId: "run", title: "run", objective: "run", kind: "experiment" }] } });
    await orchestrator.activatePlan(project.projectId); await orchestrator.startNextTask(project.projectId);
    const bundle = await orchestrator.stageCode(project.projectId, { files: [{ name: "run.cjs", content: "console.log('restored')", kind: "code" }] });
    const definition = await orchestrator.createExperiment(project.projectId, { title: "Encrypted", taskId: "run", command: process.execPath, args: ["run.cjs"], codeBundleId: bundle.bundleId });
    const approved = await orchestrator.approveExperiment(project.projectId, definition.experimentId, definition.proposalContentHash!);
    const reopened = new ResearchRepository(encryptedRoot, options);
    assert.deepEqual(await reopened.readCodeBundle(project.projectId, bundle.bundleId), bundle);
    assert.deepEqual((await reopened.readExperiment(project.projectId, definition.experimentId))!.approval, approved.approval);
    const run = await new ResearchOrchestrator(reopened, {}, undefined, { experimentPolicy: { workspaceRoot: f.root } }).executeExperiment(project.projectId, definition.experimentId, { approved: true });
    assert.equal(run.state, "completed"); assert.match(run.stdout, /restored/);
  } finally { await f.cleanup(); }
});

test("code bundles cannot be attached to a foreign project or an unrelated task", async () => {
  const f = await fixture();
  try {
    const { bundle } = await proposal(f);
    const other = await f.orchestrator.createProject("Other project");
    await assert.rejects(() => f.orchestrator.createExperiment(other.project.projectId, { title: "Foreign", command: process.execPath, codeBundleId: bundle.bundleId }), /current plan\/task/);
    await assert.rejects(() => f.orchestrator.createExperiment(f.projectId, { title: "Unrelated", command: process.execPath, codeBundleId: bundle.bundleId }), /current plan\/task/);
  } finally { await f.cleanup(); }
});

test("code-stage creates an immutable project bundle and rejects unsafe names", async () => {
  const { root, repository, orchestrator, projectId, cleanup } = await fixture();
  try {
    const input = { files: [{ name: "run.mjs", kind: "code" as const, content: "console.log('ok')\n" }, { name: "input.txt", kind: "input" as const, content: "fixed-input\n" }] };
    const bundle = await orchestrator.stageCode(projectId, input);
    assert.equal(bundle.files.length, 2);
    assert.equal((await stat(bundle.directory)).isDirectory(), true);
    assert.equal(await readFile(bundle.files.find((file) => file.name === "run.mjs")!.path, "utf8"), "console.log('ok')\n");
    assert.deepEqual(await orchestrator.stageCode(projectId, input), bundle);
    await assert.rejects(() => orchestrator.stageCode(projectId, { files: [{ name: "../escape.mjs", kind: "code", content: "x" }] }), /safe relative/);
    await assert.rejects(() => orchestrator.stageCode(projectId, { files: [{ name: "run.exe", kind: "code", content: "x" }] }), /extension/);
    await assert.rejects(() => orchestrator.stageCode(projectId, { files: [{ name: "run.mjs", kind: "code", content: "different" }, { name: "RUN.MJS", kind: "code", content: "different" }] }), /Duplicate/);
    assert.equal((await repository.listCodeBundles(projectId)).length, 1);
    assert.equal((await repository.listEvents(projectId)).filter((event) => event.type === "code-staged").length, 1);
    assert.equal((await stat(path.join(root, ".dsh-sci"))).isDirectory(), true);
  } finally { await cleanup(); }
});

test("approval binds command, staged code and input bytes, and mutation fails closed", async () => {
  const { orchestrator, projectId, cleanup } = await fixture();
  try {
    const bundle = await orchestrator.stageCode(projectId, { files: [{ name: "run.mjs", kind: "code", content: "console.log('ok')\n" }, { name: "input.txt", kind: "input", content: "fixed-input\n" }] });
    const codePath = bundle.files.find((file) => file.kind === "code")!.path;
    const inputPath = bundle.files.find((file) => file.kind === "input")!.path;
    const definition = await orchestrator.createExperiment(projectId, { title: "Bound run", command: process.execPath, args: [codePath], taskId: "run", codeBundleId: bundle.bundleId });
    assert.equal(definition.codeManifest?.length, 1);
    assert.equal(definition.inputManifest?.length, 1);
    assert.ok(definition.proposalContentHash);
    const review = await orchestrator.experimentReview(projectId, definition.experimentId);
    assert.equal(review.files.length, 2);
    assert.match(review.files.find((file) => file.kind === "code")!.text, /console\.log/);
    assert.match(review.files.find((file) => file.kind === "input")!.text, /fixed-input/);
    await writeFile(inputPath, "changed-input\n");
    await assert.rejects(() => orchestrator.approveExperiment(projectId, definition.experimentId, definition.proposalContentHash!), /changed|create a new proposal/);
    await writeFile(inputPath, "fixed-input\n");
    const approved = await orchestrator.createExperiment(projectId, { title: "Bound run 2", command: process.execPath, args: [codePath], taskId: "run", codeBundleId: bundle.bundleId });
    await orchestrator.approveExperiment(projectId, approved.experimentId, approved.proposalContentHash!);
    await writeFile(codePath, "console.log('mutated')\n");
    await assert.rejects(() => orchestrator.executeExperiment(projectId, approved.experimentId, { approved: true }), /changed after approval|refused/);
    assert.equal((await orchestrator.repository.listExperimentRuns(projectId)).length, 0);
  } finally { await cleanup(); }
});

test("automatic bridge can stage and propose code but cannot approve it", async () => {
  const { orchestrator, projectId, cleanup } = await fixture();
  const bridge = await startResearchBridge(orchestrator, { runnerProjectId: projectId });
  const call = async (body: Record<string, unknown>) => {
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const staged = await call({ action: "code-stage", files: [{ name: "run.mjs", kind: "code", content: "console.log('ok')\n" }] });
    assert.equal(staged.status, 200);
    const proposed = await call({ action: "experiment", title: "Bridge proposal", command: process.execPath, args: [staged.body.files[0].path], codeBundleId: staged.body.bundleId });
    assert.equal(proposed.status, 200);
    for (const action of ["approve-experiment", "approve", "execute-experiment"]) assert.equal((await call({ action, experimentId: proposed.body.experimentId, contentHash: proposed.body.proposalContentHash })).status, 400);
    await orchestrator.approveExperiment(projectId, proposed.body.experimentId, proposed.body.proposalContentHash);
    const revised = await call({ action: "code-stage", baseBundleId: staged.body.bundleId, files: [{ name: "run.mjs", kind: "code", content: "console.log('new version')\n" }] });
    assert.equal(revised.status, 200); assert.notEqual(revised.body.bundleId, staged.body.bundleId);
    const newProposal = await call({ action: "experiment", title: "Revised proposal", command: process.execPath, args: [revised.body.files[0].path], codeBundleId: revised.body.bundleId });
    assert.equal(newProposal.status, 200);
    assert.notEqual(newProposal.body.proposalContentHash, proposed.body.proposalContentHash);
    assert.notEqual(newProposal.body.approval?.state, "approved");
    await assert.rejects(() => orchestrator.executeExperiment(projectId, newProposal.body.experimentId, { approved: true }), /approval|refused/);
    assert.equal((await orchestrator.repository.listExperimentRuns(projectId)).length, 0);
  } finally { await bridge.close(); await cleanup(); }
});

test("a separate custom code-preparation task can stage complete files without granting execution or approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-code-task-"));
  const repository = new ResearchRepository(root);
  const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root } });
  const { project } = await orchestrator.createProject("Prepare candidate code without execution", { plan: { question: "Prepare candidate code without execution", tasks: [{ taskId: "code", title: "Prepare code", objective: "Save a candidate implementation", kind: "custom" }] } });
  await orchestrator.activatePlan(project.projectId);
  await orchestrator.startNextTask(project.projectId);
  const bridge = await startResearchBridge(orchestrator, { runnerProjectId: project.projectId });
  const call = async (body: Record<string, unknown>) => {
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const content = "import{writeFileSync}from'node:fs';writeFileSync('should-not-exist.txt','executed');\n";
    const invalid = await call({ action: "code-stage", source: "private-body-must-not-be-audited" });
    assert.equal(invalid.status, 400);
    const rejected = (await repository.listEvents(project.projectId)).find((event) => event.type === "research-action-rejected");
    assert.equal(rejected?.data?.failureCode, "files-array");
    assert.ok(!JSON.stringify(rejected).includes("private-body-must-not-be-audited"));
    assert.equal(codeStagingFailureCode(new Error("private host/path/token")), "unclassified");
    const staged = await call({ action: "code-stage", files: [{ name: "run.mjs", kind: "code", content }] });
    assert.equal(staged.status, 200);
    assert.equal(await readFile(staged.body.files[0].path, "utf8"), content);
    assert.equal(staged.body.taskId, "code");
    const proposed = await call({ action: "experiment", title: "Candidate only", command: process.execPath, args: ["run.mjs"], codeBundleId: staged.body.bundleId });
    assert.equal(proposed.status, 200);
    for (const action of ["approve", "approve-experiment", "execute-experiment"]) assert.equal((await call({ action, experimentId: proposed.body.experimentId, contentHash: proposed.body.proposalContentHash })).status, 400);
    await assert.rejects(() => orchestrator.executeExperiment(project.projectId, proposed.body.experimentId, { approved: true }), /approval|refused/);
    await assert.rejects(() => access(path.join(staged.body.directory, "should-not-exist.txt")), { code: "ENOENT" });
    assert.equal((await repository.listExperimentRuns(project.projectId)).length, 0);
    await orchestrator.pause(project.projectId);
    assert.equal((await call({ action: "code-stage", files: [{ name: "other.mjs", kind: "code", content }] })).status, 400);
    await assert.rejects(() => orchestrator.stageCode(project.projectId, { files: [{ name: "other.mjs", kind: "code", content }] }), /active task/);
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

test("source tasks and saved custom tasks without code-stage permission cannot stage code", async () => {
  for (const kind of ["source-review", "custom"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-no-code-task-"));
    try {
      const repository = new ResearchRepository(root);
      const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root } });
      const { project } = await orchestrator.createProject("Restricted task", { plan: { question: "Restricted task", tasks: [{ taskId: "task", title: "Task", objective: "Restricted task", kind }] } });
      await orchestrator.activatePlan(project.projectId);
      const started = await orchestrator.startNextTask(project.projectId);
      if (kind === "custom") await repository.savePlan({ ...started.plan, tasks: started.plan.tasks.map((task) => ({ ...task, allowedActions: task.allowedActions!.filter((action) => action !== "code-stage") })) });
      await assert.rejects(() => orchestrator.stageCode(project.projectId, { files: [{ name: "run.mjs", kind: "code", content: "console.log(1)" }] }), /code-stage permission/);
      assert.equal((await repository.exportProject(project.projectId)).codeBundles?.length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("code-preparation completion requires its own current-plan bundle containing code before any result writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-code-contract-"));
  try {
    const repository = new ResearchRepository(root);
    const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root } });
    const { project } = await orchestrator.createProject("Prepare two independent code candidates", { plan: { question: "Prepare two independent code candidates", tasks: [
      { taskId: "first", title: "Prepare code", objective: "Save a candidate implementation", kind: "code-preparation" },
      { taskId: "second", title: "Prepare more code", objective: "Save a separate implementation", kind: "code-preparation", dependsOn: ["first"] },
    ] } });
    await orchestrator.activatePlan(project.projectId);
    const started = await orchestrator.startNextTask(project.projectId);
    assert.deepEqual(started.task.completionContract?.requiredOutputs, ["code-bundle"]);
    assert.ok(started.task.allowedActions?.includes("code-stage"));
    assert.ok(!started.task.allowedActions?.includes("experiment"));
    const result = { ...taskResultIdentity(started.task), projectId: project.projectId, taskId: "first", status: "completed", summary: "Candidate staged", refs: [], claims: [{ text: "Must not persist before bundle exists" }] };
    await assert.rejects(() => orchestrator.submitTaskResult(project.projectId, result), /missing required outputs: code-bundle/);
    assert.equal((await repository.listClaims(project.projectId)).length, 0);
    const docs = await orchestrator.stageCode(project.projectId, { files: [{ name: "README.md", kind: "dependency", content: "Documentation only" }] });
    await assert.rejects(() => orchestrator.completeTask(project.projectId, "first", [docs.bundleId]), /code-bundle/);
    const bundle = await orchestrator.stageCode(project.projectId, { files: [{ name: "run.mjs", kind: "code", content: "console.log('candidate, not executed')\n" }] });
    await orchestrator.submitTaskResult(project.projectId, { ...result, refs: [bundle.bundleId], claims: [] });
    const next = await orchestrator.startNextTask(project.projectId);
    await assert.rejects(() => orchestrator.completeTask(project.projectId, "second", [bundle.bundleId]), /code-bundle/);
    const own = await orchestrator.stageCode(project.projectId, { files: [{ name: "run.mjs", kind: "code", content: "console.log('second candidate')\n" }] });
    await orchestrator.submitTaskResult(project.projectId, { ...taskResultIdentity(next.task), projectId: project.projectId, taskId: "second", status: "completed", summary: "Second candidate staged", refs: [own.bundleId] });
    const snapshot = await repository.exportProject(project.projectId);
    assert.equal(snapshot.plan?.tasks[1].status, "completed");
    assert.equal(snapshot.experiments.length, 0);
    assert.equal(snapshot.experimentRuns.length, 0);
    assert.equal(snapshot.designReviews?.length ?? 0, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
