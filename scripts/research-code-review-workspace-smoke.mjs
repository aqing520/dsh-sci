import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { renderResearchDashboard } from "../desktop/research-dashboard.mjs";

const timeout = setTimeout(() => { console.error("Code review Workspace smoke timed out"); app.exit(1); }, 30000);
let root, window;
try {
  root = await mkdtemp(path.join(tmpdir(), "dsh-code-review-ui-"));
  const repository = new ResearchRepository(root);
  const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: root } });
  const created = await orchestrator.createProject("Synthetic static review display", { plan: { question: "Synthetic static review display", tasks: [
    { taskId: "code", title: "Prepare", objective: "Save a harmless fixture", kind: "code-preparation" },
    { taskId: "review", title: "Review", objective: "Save fixture findings", kind: "code-review", dependsOn: ["code"] },
  ] } });
  const projectId = created.project.projectId;
  await orchestrator.activatePlan(projectId); await orchestrator.startNextTask(projectId);
  const bundle = await orchestrator.stageCode(projectId, { files: [{ name: "run.mjs", kind: "code", content: "// Static UI fixture, never executed.\nconst value = 1;\n" }] });
  await orchestrator.completeTask(projectId, "code", [bundle.bundleId]); await orchestrator.startNextTask(projectId);
  await orchestrator.readCode(projectId, { bundleId: bundle.bundleId, fileName: "run.mjs" });
  const untrusted = '<img src=x onerror="window.reviewTextExecuted=true">';
  const review = await orchestrator.reviewCode(projectId, { bundleId: bundle.bundleId, summary: "Static fixture " + untrusted, findings: [{ severity: "warning", fileName: "run.mjs", startOffset: 0, endOffset: 10, message: "Fixture finding " + untrusted, recommendation: "Human review required" }], limitations: ["Synthetic UI fixture only"] });
  const before = JSON.stringify(await repository.exportProject(projectId));
  window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: fileURLToPath(new URL("../desktop/research-preload.cjs", import.meta.url)) } });
  ipcMain.handle("research:export", (event, id) => { assert.equal(event.sender, window.webContents); return repository.exportProject(id); });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(renderResearchDashboard({ projects: [created.project] })));
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Static review did not render: '+document.getElementById('notice').textContent)); }, 5000);
    const observer = new MutationObserver(() => { if(document.querySelector('.code-review-entry')) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
    observer.observe(document.getElementById('projects'), { childList: true, subtree: true });
    document.querySelector('[data-action="designs"]').click();
  })`);
  const state = await window.webContents.executeJavaScript(`(() => {
    const entry=document.querySelector('.code-review-entry');
    return {text:entry.textContent, injected:window.reviewTextExecuted===true, images:entry.querySelectorAll('img').length, buttons:entry.querySelectorAll('button').length};
  })()`);
  assert.ok(state.text.includes(review.codeReviewId)); assert.ok(state.text.includes(bundle.contentHash)); assert.ok(state.text.includes("not-reviewed")); assert.ok(state.text.includes(untrusted));
  assert.equal(state.injected, false); assert.equal(state.images, 0); assert.equal(state.buttons, 0);
  assert.equal(JSON.stringify(await repository.exportProject(projectId)), before);
  console.log(JSON.stringify({ ok: true, renderer: "Electron", staticFindingsDisplayed: true, boundHashDisplayed: true, candidateTextEscaped: true, noApprovalButton: true, authoritativeSnapshotUnchanged: true, experimentRuns: 0, scientificQuality: "not-reviewed; synthetic UI fixture" }));
} catch (error) { console.error(error?.stack ?? String(error)); process.exitCode = 1; }
finally { clearTimeout(timeout); window?.destroy(); if(root) await rm(root,{recursive:true,force:true}); app.exit(process.exitCode ?? 0); }
