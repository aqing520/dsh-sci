import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { checkCandidateCodeSyntax } from "../src/research/code-syntax.js";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { taskResultIdentity } from "../src/research/task-result.js";

test("static JavaScript parsing does not execute statements, resolve imports or inherit preload hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-parse-only-"));
  const priorNodeOptions = process.env.NODE_OPTIONS;
  const marker = path.join(root, "candidate-executed.txt"), preloadMarker = path.join(root, "preload-executed.txt"), preload = path.join(root, "preload.mjs");
  try {
    await writeFile(preload, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(preloadMarker)},'preloaded');`);
    process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    const module = await checkCandidateCodeSyntax("run.mjs", `import fs from 'node:fs';import './missing-dependency.mjs';fs.writeFileSync(${JSON.stringify(marker)},'ran');throw new Error('must not execute');`);
    assert.equal(module.status, "parsed");
    assert.equal(module.mode, "module");
    const commonjs = await checkCandidateCodeSyntax("run.cjs", `require('missing-dependency');require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
    assert.equal(commonjs.status, "parsed");
    assert.equal(commonjs.mode, "commonjs");
    assert.equal((await checkCandidateCodeSyntax("legacy.js", "return;" )).status, "parsed", ".js may parse as CommonJS without deciding runtime module type");
    await assert.rejects(access(marker), /ENOENT/);
    await assert.rejects(access(preloadMarker), /ENOENT/);
    const invalid = await checkCandidateCodeSyntax("broken.mjs", "export const value = 1;\nfunction broken( {\n");
    assert.equal(invalid.status, "syntax-error");
    assert.ok(invalid.line && invalid.line >= 2);
    assert.ok((invalid.message?.length ?? 0) <= 200);
    assert.equal((await checkCandidateCodeSyntax("run.py", "def broken(:" )).status, "not-checked");
    await assert.rejects(checkCandidateCodeSyntax("large.mjs", "x".repeat(128 * 1024 + 1)), /staged file limit/);
  } finally {
    if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = priorNodeOptions;
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid candidates are preserved with diagnostics and cannot complete code preparation before revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-prepare-syntax-"));
  let bridge: Awaited<ReturnType<typeof startResearchBridge>> | undefined;
  try {
    const repository = new ResearchRepository(root), orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Prepare candidate only", { plan: { question: "Prepare candidate only", tasks: [{ taskId: "code", title: "Prepare", objective: "Prepare complete source", kind: "code-preparation" }] } });
    await orchestrator.activatePlan(project.projectId);
    const started = await orchestrator.startNextTask(project.projectId);
    bridge = await startResearchBridge(orchestrator, { runnerProjectId: project.projectId });
    const stage = async (content: string) => {
      const response = await fetch(bridge!.url, { method: "POST", headers: { authorization: `Bearer ${bridge!.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "code-stage", files: [{ name: "run.mjs", kind: "code", content }] }) });
      assert.equal(response.status, 200);
      return await response.json() as any;
    };
    const broken = await stage("export function broken( {\n");
    assert.equal(broken.syntaxChecks[0].status, "syntax-error");
    const before = await repository.exportProject(project.projectId);
    await assert.rejects(orchestrator.completeTask(project.projectId, "code", [broken.bundleId]), /syntax check requires revision/);
    await assert.rejects(orchestrator.submitTaskResult(project.projectId, { ...taskResultIdentity(started.task!), projectId: project.projectId, taskId: "code", status: "completed", summary: "Invalid syntax cannot complete", refs: [broken.bundleId] }), /syntax check requires revision/);
    assert.deepEqual(await repository.exportProject(project.projectId), before, "rejected completions do not commit task status or claims");
    const revised = await stage("import fs from 'node:fs';fs.writeFileSync('must-not-execute.txt','ran');\n");
    assert.notEqual(revised.bundleId, broken.bundleId);
    assert.equal(revised.syntaxChecks[0].status, "parsed");
    assert.deepEqual(await new ResearchRepository(root).readCodeBundle(project.projectId, revised.bundleId), revised);
    await orchestrator.completeTask(project.projectId, "code", [revised.bundleId]);
    const snapshot = await repository.exportProject(project.projectId);
    assert.equal(snapshot.codeBundles?.length, 2);
    assert.equal(snapshot.experimentRuns.length, 0);
    assert.equal(snapshot.codeReads?.length, 0, "parsing is not Agent code reading");
    assert.equal(snapshot.plan!.tasks[0].status, "completed");
    await assert.rejects(access(path.join(revised.directory, "must-not-execute.txt")), /ENOENT/);
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
