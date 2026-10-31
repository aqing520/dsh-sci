const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const index = process.argv.indexOf("--case");
const selected = index < 0 ? undefined : process.argv[index + 1];
if (!selected) { console.error("Usage: --case <validation-case> [--out <new-evidence-directory>]"); app.exit(2); }
else app.whenReady().then(async () => {
  let window;
  const timeout = setTimeout(() => app.exit(1), 30000);
  try {
    const [{ loadCaseWorkspace, registerCaseWorkspaceIpc }, { createResearchWindowRegistry, createResearchIpcRegistrar }, { renderCaseDashboard }] = await Promise.all([
      import(pathToFileURL(path.join(root, "scripts/research-case-workspace-core.mjs"))),
      import(pathToFileURL(path.join(root, "desktop/research-access.mjs"))),
      import(pathToFileURL(path.join(root, "desktop/research-case-dashboard.mjs"))),
    ]);
    const context = await loadCaseWorkspace(path.resolve(selected), path.join(root, "research/validation/cases"));
    const before = JSON.stringify(await context.repository.exportProject(context.projectId));
    const registry = createResearchWindowRegistry();
    registerCaseWorkspaceIpc(createResearchIpcRegistrar(ipcMain, registry), context);
    window = new BrowserWindow({ show: false, width: 1150, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, "desktop/research-case-preload.cjs") } });
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(renderCaseDashboard({ directory: context.directory, readOnly: true }));
    registry.bind(window, "read-only", url);
    await window.loadURL(url);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const done=()=>{if(document.documentElement.dataset.ready==='true'){observer.disconnect();clearTimeout(timer);resolve(true)}};const observer=new MutationObserver(done);const timer=setTimeout(()=>{observer.disconnect();reject(new Error(document.getElementById('notice').textContent||'render timeout'))},5000);observer.observe(document.documentElement,{subtree:true,attributes:true,childList:true});done()})`);
    const snapshot = JSON.parse(before), experiment = snapshot.experiments[0];
    assert.ok(experiment, "Choose a case with a proposal");
    const input = { projectId: context.projectId, experimentId: experiment.experimentId, contentHash: experiment.proposalContentHash, approved: true, planId: snapshot.project.planId, taskId: experiment.taskId };
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const observer=new MutationObserver(()=>{if(document.querySelectorAll('.bound-file').length){clearTimeout(timer);observer.disconnect();resolve(true)}});const timer=setTimeout(()=>{observer.disconnect();reject(new Error(document.getElementById('notice').textContent||'preview timeout'))},5000);observer.observe(document.getElementById('case'),{subtree:true,childList:true});[...document.querySelectorAll('button')].find(b=>b.textContent==='查看完整代码和输入').click()})`);
    const state = await window.webContents.executeJavaScript(`(async()=>{const input=${JSON.stringify(input)};const review=await researchCaseApi.review(input);const denied=[];for(const method of ['approveTask','approveExperiment','execute']){try{await researchCaseApi[method](input);denied.push(false)}catch(error){denied.push(String(error).includes('Read-only Research Workspace capability'))}}return {denied,files:review.files.length,renderedFiles:document.querySelectorAll('.bound-file').length,complete:review.files.every(f=>!f.truncated&&f.sha256),disabled:[...document.querySelectorAll('button')].filter(b=>/批准|执行已/.test(b.textContent)).every(b=>b.disabled),hashDisplayed:document.getElementById('case').textContent.includes(input.contentHash),scriptCount:document.querySelectorAll('script').length}})()`);
    assert.ok(state.denied.every(Boolean)); assert.ok(state.complete); assert.ok(state.disabled); assert.ok(state.hashDisplayed); assert.equal(state.renderedFiles, state.files); assert.equal(state.scriptCount, 1);
    const after = JSON.stringify(await context.repository.exportProject(context.projectId));
    assert.equal(after, before);
    const result = { schema: "dsh-sci.case-workspace-smoke.v1", finishedAt: new Date().toISOString(), ok: true, projectId: context.projectId, proposalContentHash: experiment.proposalContentHash, renderer: "Electron", readOnly: true, ...state, snapshotSha256: createHash("sha256").update(before).digest("hex"), authoritativeSnapshotUnchanged: true, approvalsGranted: 0, executionsStarted: 0, existingRuns: snapshot.experimentRuns.length, scientificQuality: "not-reviewed; render/access validation only" };
    const outIndex = process.argv.indexOf("--out");
    if (outIndex >= 0) { const out = path.resolve(process.argv[outIndex + 1]); await fs.mkdir(out, { recursive: false }); await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); const image = await window.webContents.capturePage(); await fs.writeFile(path.join(out, "workspace.png"), image.toPNG(), { flag: "wx" }); }
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
  finally { clearTimeout(timeout); window?.destroy(); app.exit(process.exitCode ?? 0); }
}).catch((error) => { console.error(error); app.exit(1); });
