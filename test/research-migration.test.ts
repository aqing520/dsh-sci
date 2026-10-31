import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { migrateResearchStore, type MigrationCheckpoint } from "../src/research/migration.js";
import { parseMetadataJson, serializeMetadataJson } from "../src/metadata-crypto.js";

async function fileHashes(root: string) {
  const result: Record<string, string> = {};
  for (const name of await readdir(root, { recursive: true, withFileTypes: true })) if (name.isFile()) {
    const file = path.join(name.parentPath, name.name);
    result[path.relative(root, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return result;
}
async function put(root: string, relative: string, value: unknown, passphrase?: string) {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, serializeMetadataJson(value, passphrase));
}

async function fixture(encrypted = false) {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-migration-"));
  const source = path.join(parent, "source"), target = path.join(parent, "target");
  const repository = new ResearchRepository(source, encrypted ? { metadataPassphrase: "migration-pass" } : {});
  const orchestrator = new ResearchOrchestrator(repository);
  const { project } = await orchestrator.createProject("Migration fixture", { plan: { question: "Migration fixture", tasks: [{ taskId: "one", title: "One", objective: "Preserve records", kind: "custom" }] } });
  return { parent, source, target, project, passphrase: encrypted ? "migration-pass" : undefined, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

test("migration copies an encrypted research store with a byte checked backup and preserves budget/recovery gates", async () => {
  const f = await fixture(true);
  try {
    const before = await readdir(f.source, { recursive: true });
    const phases: string[] = [];
    const result = await migrateResearchStore(f.source, f.target, { metadataPassphrase: f.passphrase, checkpoint: (phase) => { phases.push(phase); } });
    assert.equal(result.ok, true); assert.equal(result.projects, 1); assert.deepEqual(phases, ["prepared", "backed-up", "staged", "recovered", "before-commit", "committed"]);
    const reopened = new ResearchRepository(f.target, { metadataPassphrase: f.passphrase });
    assert.equal((await reopened.readProject(f.project.projectId))?.question, "Migration fixture");
    assert.equal((await reopened.readBudget(f.project.projectId))?.usedTaskExecutions, 0);
    assert.equal(parseMetadataJson<{ state: string }>(await readFile(path.join(f.target, "store-format.json"), "utf8"), f.passphrase).state, "ready");
    assert.ok(await readFile(path.join(f.target + ".migration", "journal.json"), "utf8"));
    assert.deepEqual(before.sort(), (await readdir(f.source, { recursive: true })).sort(), "source inventory is unchanged");
    const backup = new ResearchRepository(result.backupRoot, { metadataPassphrase: f.passphrase });
    assert.equal((await backup.readProject(f.project.projectId))?.projectId, f.project.projectId);
    const repeated = await migrateResearchStore(f.source, f.target, { metadataPassphrase: f.passphrase });
    assert.equal(repeated.migrationId, result.migrationId);
  } finally { await f.cleanup(); }
});

test("migration abort leaves source, backup and journal for a retry and refuses a changed source", async () => {
  const f = await fixture();
  try {
    let aborted = false;
    await assert.rejects(migrateResearchStore(f.source, f.target, { checkpoint: (phase) => { if (phase === "staged") { aborted = true; throw new Error("simulated migration interruption"); } } }), /simulated/);
    assert.equal(aborted, true);
    assert.equal(await readdir(f.source, { recursive: true }).then((items) => items.length > 0), true);
    const marker = path.join(f.target + ".migration", "journal.json"); assert.ok(await readFile(marker, "utf8"));
    const changed = path.join(f.source, "projects", f.project.projectId, "project.json"); await writeFile(changed, `${await readFile(changed, "utf8")}\n`, "utf8");
    await assert.rejects(migrateResearchStore(f.source, f.target, {}), /journal|snapshot|changed/u);
  } finally { await f.cleanup(); }
});

test("migration rejects overlapping roots and junctions before creating migration data", async () => {
  const f = await fixture();
  try {
    await assert.rejects(migrateResearchStore(f.source, path.join(f.source, "nested")), /overlap/u);
    const link = path.join(f.source, "projects", "link");
    await symlink(f.parent, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(migrateResearchStore(f.source, f.target), /symbolic|junction/u);
    await assert.rejects(readFile(path.join(f.target + ".migration", "journal.json")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

for (const encrypted of [false, true]) {
  test(`${encrypted ? "encrypted" : "plaintext"} legacy fixture preserves history, repairs derived project index and retains review/budget gates`, async () => {
    const f = await fixture(encrypted);
    try {
      // Hand-authored legacy schema fixture; no current builder fills missing protocol/approval fields.
      await rm(f.source, { recursive: true });
      const legacy = JSON.parse(await readFile(new URL("./fixtures/research-store-v1.json", import.meta.url), "utf8"));
      const base = "projects/legacy-project/";
      for (const [relative, value] of Object.entries({ [base + "project.json"]: legacy.project, [base + "plans/legacy-plan.json"]: legacy.plan, [base + "budget.json"]: legacy.budget, [base + "sources/legacy-source.json"]: legacy.source, [base + "reports/legacy-report.json"]: legacy.report, [base + "experiments/legacy-experiment.json"]: legacy.experiment, [base + "experiment-runs/legacy-run.json"]: legacy.run, "memory/legacy-memory.json": legacy.memory })) await put(f.source, relative, value, f.passphrase);
      await writeFile(path.join(f.source, "index.json"), "{torn-derived-index");
      const before = await fileHashes(f.source);
      const result = await migrateResearchStore(f.source, f.target, { metadataPassphrase: f.passphrase });
      assert.deepEqual(await fileHashes(f.source), before); assert.deepEqual(await fileHashes(result.backupRoot), before);
      const repo = new ResearchRepository(f.target, { metadataPassphrase: f.passphrase }), agent = new ResearchOrchestrator(repo);
      assert.equal((await repo.listProjects()).length, 1); assert.equal(result.recoveredRuns, 1);
      assert.equal((await repo.readExperimentRun("legacy-project", "legacy-run"))?.state, "interrupted");
      assert.equal((await repo.readProject("legacy-project"))?.status, "paused");
      assert.deepEqual(await repo.readBudget("legacy-project"), legacy.budget, "migration cannot refill or upgrade quotas without explicit configuration");
      assert.equal((await repo.readPlan("legacy-project", "legacy-plan"))?.protocolReviewRequired, true);
      assert.equal((await repo.listSources("legacy-project"))[0].reading?.status, "discovered");
      assert.equal((await repo.listSourceReads("legacy-project")).length, 0);
      const report = await agent.reportReviewContext("legacy-project", "legacy-report"); assert.equal(report.status, "stale"); assert.equal(report.canAccept, false);
      assert.equal((await repo.listMemory())[0].confidence, "unrated"); assert.equal((await repo.listMemoryIndexVersions()).length, 0);
      await assert.rejects(agent.activatePlan("legacy-project"), /Legacy.*protocol/u);
      const migratedBeforeRepeat = await fileHashes(f.target);
      await migrateResearchStore(f.source, f.target, { metadataPassphrase: f.passphrase });
      assert.deepEqual(await fileHashes(f.target), migratedBeforeRepeat);
    } finally { await f.cleanup(); }
  });

  test(`${encrypted ? "encrypted" : "plaintext"} migration resumes every durable boundary without publishing partial stores`, async () => {
    for (const stopAt of ["prepared", "backed-up", "staged", "recovered", "before-commit", "committed"] as MigrationCheckpoint[]) {
      const f = await fixture(encrypted);
      try {
        const before = await fileHashes(f.source);
        await assert.rejects(migrateResearchStore(f.source, f.target, { metadataPassphrase: f.passphrase, checkpoint: (phase) => { if (phase === stopAt) throw new Error("fixture power boundary"); } }), /fixture power/u);
        if (stopAt !== "committed") await assert.rejects(readFile(path.join(f.target, "store-format.json")), { code: "ENOENT" });
        const partials = (await readdir(f.target + ".migration")).filter((name) => name.startsWith("stage-"));
        for (const partial of partials) {
          const repo = new ResearchRepository(path.join(f.target + ".migration", partial), { metadataPassphrase: f.passphrase });
          await assert.rejects(repo.listMemory(), /incomplete/u);
          await assert.rejects(repo.saveProject(f.project), /incomplete/u);
        }
        const result = await migrateResearchStore(f.source, f.target, { metadataPassphrase: f.passphrase });
        assert.deepEqual(await fileHashes(f.source), before); assert.deepEqual(await fileHashes(result.backupRoot), before);
        assert.equal((await new ResearchRepository(f.target, { metadataPassphrase: f.passphrase }).listProjects()).length, 1);
      } finally { await f.cleanup(); }
    }
  });
}

test("migration fails closed for torn committed JSON, temporary writes, invalid ledgers, corrupt memory indexes and wrong encryption keys", async () => {
  for (const failure of ["json", "temporary", "ledger", "memory-index", "key"]) {
    const f = await fixture(failure === "key");
    try {
      if (failure === "json") await writeFile(path.join(f.source, "projects", f.project.projectId, "budget.json"), "{committed-torn");
      if (failure === "temporary") await writeFile(path.join(f.source, "projects", f.project.projectId, "budget.json.abandoned.tmp"), "{uncommitted");
      if (failure === "ledger") {
        const file = path.join(f.source, "projects", f.project.projectId, "budget.json");
        const budget = JSON.parse(await readFile(file, "utf8")); budget.usedModelRequests = 7; await writeFile(file, JSON.stringify(budget));
      }
      if (failure === "memory-index") await put(f.source, "memory-indexes/bad.json", { schema: "dsh-sci.research-memory-index.v2", indexId: "bad", dimensions: 2, entryIds: [], entries: [] });
      const before = await fileHashes(f.source);
      await assert.rejects(migrateResearchStore(f.source, f.target, { metadataPassphrase: failure === "key" ? "wrong-pass" : f.passphrase }));
      assert.deepEqual(await fileHashes(f.source), before);
      await assert.rejects(readFile(path.join(f.target, "store-format.json")), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  }
});

test("migration recovers reserved model usage without resetting counters, and refuses a modified backup", async () => {
  const f = await fixture();
  try {
    const repo = new ResearchRepository(f.source);
    const settled = await repo.reserveModelRequest(f.project.projectId, { phase: "planner" });
    await repo.recordModelUsage(f.project.projectId, settled, { inputTokens: 17, outputTokens: 3, totalTokens: 20 });
    await repo.reserveModelRequest(f.project.projectId, { phase: "planner" });
    const before = await fileHashes(f.source);
    const result = await migrateResearchStore(f.source, f.target);
    const budget = await new ResearchRepository(f.target).readBudget(f.project.projectId);
    assert.equal(budget?.schema, "dsh-sci.research-budget.v2");
    if (budget?.schema !== "dsh-sci.research-budget.v2") throw new Error("Expected a metered ledger");
    assert.equal(budget.usedModelRequests, 2); assert.equal(budget.reportedTotalTokens, 20); assert.equal(budget.unknownUsageRequests, 1);
    assert.equal(budget.modelRequests[1].interrupted, true); assert.deepEqual(await fileHashes(f.source), before);
    await writeFile(path.join(result.backupRoot, "index.json"), "{}");
    await assert.rejects(migrateResearchStore(f.source, f.target), /backup hash/u);
  } finally { await f.cleanup(); }
});

test("plaintext and encrypted migrations survive actual child-process termination before publication", async () => {
  for (const encrypted of [false, true]) {
    const f = await fixture(encrypted);
    try {
      const module = new URL("../src/research/migration.ts", import.meta.url).href;
      const script = `import { migrateResearchStore } from ${JSON.stringify(module)}; await migrateResearchStore(${JSON.stringify(f.source)}, ${JSON.stringify(f.target)}, {metadataPassphrase:${JSON.stringify(f.passphrase)},checkpoint(phase){ if(phase==='staged') process.exit(73); }});`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 73);
      await assert.rejects(readFile(path.join(f.target, "store-format.json")), { code: "ENOENT" });
      const result = await migrateResearchStore(f.source, f.target, { metadataPassphrase: f.passphrase });
      assert.equal(result.ok, true); assert.deepEqual(await fileHashes(f.source), await fileHashes(result.backupRoot));
      assert.equal((await new ResearchRepository(f.target, { metadataPassphrase: f.passphrase }).listProjects()).length, 1);
    } finally { await f.cleanup(); }
  }
});

test("store format guards reject future and incomplete layouts on all empty read collections and writes", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ state: "migrating" }, { formatVersion: 2 }, { minimumReaderVersion: 2 }, { schema: "unknown" }]) {
      await put(f.source, "store-format.json", { schema: "dsh-sci.research-store-format.v1", formatVersion: 1, minimumReaderVersion: 1, state: "ready", migrationId: "fixture", ...patch });
      const repo = new ResearchRepository(f.source);
      for (const call of [() => repo.listMemory(), () => repo.listMemoryIndexVersions(), () => repo.listMemoryRetrievals(), () => repo.listSources("missing"), () => repo.listProjects(), () => repo.clearActiveContext(), () => repo.saveProject(f.project)]) await assert.rejects(call, /incompatible|incomplete/u);
    }
  } finally { await f.cleanup(); }
});
