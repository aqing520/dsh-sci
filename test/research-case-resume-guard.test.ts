import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
// @ts-expect-error The development protocol helper is plain ESM.
import { caseProtocolBinding } from "../scripts/research-case-protocol.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const casesRoot = path.join(root, "research/validation/cases");

async function inventory(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function visit(current: string) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else entries[path.relative(directory, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
    }
  }
  await visit(directory);
  return entries;
}

async function fixture() {
  await mkdir(casesRoot, { recursive: true });
  const directory = await mkdtemp(path.join(casesRoot, "resume-guard-fixture-"));
  const relative = path.relative(casesRoot, directory);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const workspace = path.join(directory, "runtime/workspace");
  await mkdir(workspace, { recursive: true });
  const protocol = JSON.parse(await readFile(new URL("../research/benchmarks/imputation-v1.json", import.meta.url), "utf8"));
  const question = "Synthetic offline recovery fixture\n" + caseProtocolBinding(protocol);
  const input = { question, tasks: [
    { taskId: "read", title: "Read", objective: "Save evidence", kind: "source-review" as const, maxAttempts: 2, dependsOn: [] },
    { taskId: "hypothesis", title: "Hypothesis", objective: "Save candidate", kind: "hypothesis" as const, dependsOn: ["read"] },
    { taskId: "design", title: "Design", objective: "Save draft", kind: "experiment-design" as const, dependsOn: ["hypothesis"] },
  ], constraints: { maxIterations: 2, maxTaskAttempts: 2 } };
  const repository = new ResearchRepository(path.join(directory, "runtime/research"));
  const orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject(question, { plan: input });
  await orchestrator.activatePlan(project.projectId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await orchestrator.startNextTask(project.projectId);
    await orchestrator.failTask(project.projectId, "read", "Synthetic transport failure");
  }
  await orchestrator.pause(project.projectId);
  const budget = (await repository.readBudget(project.projectId))!;
  await repository.saveBudget({ ...budget, startedAt: "2020-01-01T00:00:00.000Z" });
  await writeFile(path.join(directory, "summary.json"), JSON.stringify({ projectId: project.projectId }));
  await writeFile(path.join(directory, "protocol.json"), JSON.stringify(protocol));
  await writeFile(path.join(directory, "snapshot.json"), JSON.stringify({ project: { projectId: "stale", status: "completed" } }));
  const proposal = path.join(directory, "material-revision-001/proposed-plan-input.json");
  await mkdir(path.dirname(proposal));
  await writeFile(proposal, JSON.stringify(input));
  await mkdir(path.join(directory, "material-revision-002"));
  return { directory, repository, project, input, proposal };
}

test("case resume refuses exhausted budget before loading provider configuration", async () => {
  const text = await readFile(new URL("../scripts/research-case-resume.mjs", import.meta.url), "utf8");
  const budgetGuard = text.indexOf("Research budget is exhausted or expired");
  const providerLoad = text.indexOf("const config = await loadProviderConfig");
  assert.ok(budgetGuard >= 0);
  assert.ok(providerLoad < 0 || budgetGuard < providerLoad, "budget guard must precede provider startup");
});

test("offline preparation reads authoritative failures, skips missing proposals, and preserves all case bytes", async () => {
  const f = await fixture();
  try {
    const before = await inventory(f.directory);
    const { stdout } = await execFileAsync(process.execPath, ["scripts/research-case-prepare-resume.mjs", "--case", f.directory], { cwd: root });
    const checkpoint = JSON.parse(stdout);
    assert.equal(checkpoint.projectId, f.project.projectId);
    assert.equal(checkpoint.projectStatus, "paused");
    assert.equal(checkpoint.proposalValidation.ok, true);
    assert.equal(checkpoint.recoveryRequirements.newPlanRequired, true);
    assert.deepEqual(checkpoint.recoveryRequirements.exhaustedTasks, [{ taskId: "read", attempts: 2, maxAttempts: 2 }]);
    assert.equal(checkpoint.budget.wallBudgetExpired, true);
    assert.equal(checkpoint.proposalPath.endsWith("material-revision-001/proposed-plan-input.json"), true);
    assert.deepEqual(await inventory(f.directory), before);
    const written = await execFileAsync(process.execPath, ["scripts/research-case-prepare-resume.mjs", "--case", f.directory, "--write"], { cwd: root });
    const saved = JSON.parse(written.stdout);
    const output = path.resolve(root, saved.outputPath);
    const after = await inventory(f.directory);
    const extra = Object.keys(after).filter((file) => !(file in before));
    assert.deepEqual(extra, [path.relative(f.directory, output)]);
    delete after[extra[0]!];
    assert.deepEqual(after, before, "only the checkpoint file may be created");
    const document = JSON.parse(await readFile(output, "utf8"));
    assert.equal(document.snapshotSha256, checkpoint.snapshotSha256);
    assert.equal(document.counts.experimentRuns, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("offline preparation rejects digest-only protocol substitution without modifying research state", async () => {
  const f = await fixture();
  try {
    const changed = { ...f.input, question: "Frozen protocol SHA-256: df9304ae0c2028fa300c0412f57f11ecb7c56fe95c04eae31833d2adfcb0d042" };
    await writeFile(f.proposal, JSON.stringify(changed));
    const before = await inventory(f.directory);
    await assert.rejects(execFileAsync(process.execPath, ["scripts/research-case-prepare-resume.mjs", "--case", f.directory], { cwd: root }), (error: any) => {
      assert.equal(error.code, 1);
      const checkpoint = JSON.parse(error.stdout);
      assert.equal(checkpoint.proposalValidation.ok, false);
      assert.match(checkpoint.proposalValidation.issues.join(" "), /full case protocol/);
      return true;
    });
    assert.deepEqual(await inventory(f.directory), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("live resume rejects a running project's expired budget with no provider reservations or case writes", async () => {
  const f = await fixture();
  try {
    await f.repository.saveProject({ ...(await f.repository.readProject(f.project.projectId))!, status: "researching" });
    const before = await inventory(f.directory);
    await assert.rejects(execFileAsync(process.execPath, ["scripts/research-case-resume.mjs", "--case", f.directory, "--run"], { cwd: root }), (error: any) => {
      assert.match(error.stderr, /Research budget is exhausted or expired/);
      assert.doesNotMatch(error.stderr, /No model provider|apiKey|fetch failed/);
      return true;
    });
    assert.deepEqual(await inventory(f.directory), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("offline plan commit is explicit, model-free, and preserves the old plan", async () => {
  const text = await readFile(new URL("../scripts/research-case-commit-offline-plan.mjs", import.meta.url), "utf8");
  assert.match(text, /offline-plan-commit\.v1/);
  assert.match(text, /modelCalls: 0/);
  assert.match(text, /approvalsChanged: false/);
  assert.match(text, /experimentsStarted: 0/);
  assert.match(text, /supersedesPlanId/);
  assert.match(text, /--expected-plan/);
  assert.match(text, /--proposal-sha256/);
  assert.match(text, /action: previousCommit \? "already-committed" : shouldCommit \? "committed" : "preview"/);
  assert.doesNotMatch(text, /loadProviderConfig|runResearchWithDshAgent|updateBudget/);
});
