import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error The acceptance helper is plain ESM.
import { defaultCredentialFile, loadResumeStatus, writeJsonAtomic, acquireRunLock, savePartialEvidence, runAcceptanceTurn } from "../scripts/research-conversation-live-core.mjs";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";

test("live credentials follow the desktop data directory on Windows, macOS and Linux", () => {
  assert.equal(defaultCredentialFile("win32", { APPDATA: "C:\\Users\\user\\AppData\\Roaming" }, "C:\\Users\\user"), "C:\\Users\\user\\AppData\\Roaming\\dsh-sci\\harness\\.credentials.yaml");
  assert.equal(defaultCredentialFile("darwin", {}, "/Users/user"), "/Users/user/Library/Application Support/dsh-sci/harness/.credentials.yaml");
  assert.equal(defaultCredentialFile("linux", { XDG_CONFIG_HOME: "/custom" }, "/home/user"), "/custom/dsh-sci/harness/.credentials.yaml");
});

test("live resume preserves identity and rejects completed, moved or reconfigured runs", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "dsh-live-resume-"));
  try {
    const status = { schema: "dsh-sci.native-live.v1", sessionId: "same-session", output, model: "gpt-6-luna", baseUrl: "https://tokenfans.ai/v1", state: "interrupted" };
    const file = path.join(output, "status.json");
    await writeJsonAtomic(file, status);
    assert.equal((await loadResumeStatus(output)).sessionId, status.sessionId);
    await assert.rejects(loadResumeStatus(output, { model: "different" }), /original model/);
    await assert.rejects(loadResumeStatus(output, { baseUrl: "different" }), /original model/);
    await writeJsonAtomic(file, { ...status, state: "completed" });
    await assert.rejects(loadResumeStatus(output), /already completed/);
    await writeJsonAtomic(file, { ...status, output: path.join(output, "moved") });
    await assert.rejects(loadResumeStatus(output), /identity/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("live run lock excludes concurrent owners and releases for an explicit retry", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "dsh-live-lock-"));
  try {
    const release = await acquireRunLock(output);
    await assert.rejects(acquireRunLock(output), /running process/);
    await release();
    await (await acquireRunLock(output))();
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("an interrupted live turn resumes the same SDK session without creating another", async () => {
  const calls: string[] = [];
  const status = { sessionId: "original", attempt: 1, sessionCreated: false };
  let interrupted = true;
  const client = {
    createSession: async (id: string) => { calls.push(`create:${id}`); },
    resume: async (id: string) => { calls.push(`resume:${id}`); },
    prompt: async (id: string, text: string) => { calls.push(`prompt:${id}`); if (status.attempt > 1) assert.match(text, /不重置或扩充预算/); },
    wait: async () => { if (interrupted) throw new Error("transport interrupted"); },
  };
  let saved = false;
  await assert.rejects(runAcceptanceTurn(client, status, "compare", undefined, async () => { saved = true; }), /interrupted/);
  assert.equal(saved, true);
  assert.equal(status.sessionCreated, true);
  interrupted = false;
  status.attempt = 2;
  await runAcceptanceTurn(client, status, "compare", undefined, async () => {});
  assert.deepEqual(calls, ["create:original", "prompt:original", "resume:original", "prompt:original"]);
});

test("failure evidence export retains the existing project and budget without mutations", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "dsh-live-partial-"));
  try {
    const repository = new ResearchRepository(path.join(output, "research"));
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("partial evidence");
    await repository.saveProject({ ...project, mode: "conversation", workspaceRoot: output });
    const before = await repository.readBudget(project.projectId);
    const status: Record<string, unknown> = {};
    await savePartialEvidence(repository, output, status, "已读到一部分，研究尚未完成。");
    const snapshot = JSON.parse(await readFile(path.join(output, "snapshot.json"), "utf8"));
    assert.equal(snapshot.project.projectId, project.projectId);
    assert.equal(status.projectId, project.projectId);
    assert.deepEqual(await repository.readBudget(project.projectId), before);
    assert.match(await readFile(path.join(output, "answer.md"), "utf8"), /尚未完成/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
