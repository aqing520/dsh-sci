// Starts the production main in an isolated workspace. No test IPC channels are installed.
const { app, BrowserWindow, Menu } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");

const projectRoot = path.resolve(__dirname, "..");
let temp, passed = false;
const result = { schema: "dsh-sci.research-access-smoke.v1", startedAt: new Date().toISOString(), platform: process.platform, scientificQuality: "not-reviewed; synthetic access fixture" };
const outputIndex = process.argv.indexOf("--out"), outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : undefined;
const deadline = Date.now() + 90_000;
async function waitFor(operation) { while (Date.now() < deadline) { const value = await operation(); if (value) return value; await delay(50); } throw new Error("Production Research Workspace access smoke timed out"); }

(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sci-access-main-"));
  const workspace = path.join(temp, "workspace"); await fs.mkdir(workspace);
  app.setPath("userData", path.join(temp, "user-data")); process.chdir(workspace);
  Object.assign(process.env, { DSH_SCI_PROVIDER: "custom", DSH_SCI_BASE_URL: "http://127.0.0.1:1/v1", DSH_SCI_MODEL: "access-smoke", DSH_SCI_API_KEY: "", DSH_SCI_TOKENFANS_API_KEY: "", OPENAI_API_KEY: "", DSH_SCI_SERVICE_API_KEY: "", DSH_SCI_SERVICE_BASE_URL: "", DSH_SCI_METADATA_PASSPHRASE: "", DSH_SCI_MEMORY_EMBEDDINGS: "0" });
  app.on("browser-window-created", (_event, window) => {
    window.hide();
    window.webContents.on("will-prevent-unload", () => { result.unloadPrevented = true; });
  });
  await app.whenReady();
  await import(pathToFileURL(path.join(projectRoot, "desktop/main.mjs")));
  await waitFor(() => Menu.getApplicationMenu()?.items[0]?.label === "dsh-sci");
  const menu = Menu.getApplicationMenu().items[0].submenu;
  await menu.items.find((item) => item.label === "Research Workspace").click();
  const owner = await waitFor(async () => { for (const window of BrowserWindow.getAllWindows()) if (await window.webContents.executeJavaScript("Boolean(window.researchApi && document.getElementById('create'))").catch(() => false)) return window; });
  const sourceFile = path.join(workspace, "source.txt");
  await fs.writeFile(sourceFile, "<img src=x onerror=window.sourceInjected=true> Bounded source preview for a read-only research session.");
  const fixture = await owner.webContents.executeJavaScript(`(async () => {
    const question = '<img src=x onerror=window.projectInjected=true> Synthetic read-only access';
    const created = await researchApi.create({ question, plan: { question, tasks: [{ taskId: 'gate', title: 'Waiting for review', objective: 'Do not execute', requiresApproval: true }] } });
    const projectId = created.project.projectId;
    const acquired = await researchApi.ingestDocument({ projectId, file: ${JSON.stringify(sourceFile)} });
    await researchApi.activate(projectId); await researchApi.startNext(projectId);
    const report = await researchApi.generateReport(projectId);
    await researchApi.remember({projectId,kind:'note',text:'Stored access fixture memory'});
    return {projectId,sourceId:acquired.source.sourceId,contentVersionId:acquired.source.latestContentVersionId,reportId:report.reportId};
  })()`);
  const readSnapshot = () => owner.webContents.executeJavaScript(`researchApi.exportProject(${JSON.stringify(fixture.projectId)})`);
  const before = await readSnapshot();
  await owner.webContents.executeJavaScript("researchApi.openReadOnly()");
  const reader = await waitFor(async () => { for (const window of BrowserWindow.getAllWindows()) if (window !== owner && await window.webContents.executeJavaScript("document.documentElement.dataset.researchAccess === 'read-only' && Boolean(window.researchApi)").catch(() => false)) return window; });
  assert.equal(await reader.webContents.executeJavaScript("Boolean(document.getElementById('create'))"), false);
  const { researchIpcPolicies } = await import(pathToFileURL(path.join(projectRoot, "desktop/research-access.mjs")));
  const preload = await fs.readFile(path.join(projectRoot, "desktop/research-preload.cjs"), "utf8");
  const methods = [...preload.matchAll(/(\w+):[^\n]*ipcRenderer\.invoke\("(research:[^"]+)"/gu)].map((match) => ({ method: match[1], channel: match[2] }));
  const writeMethods = methods.filter((item) => researchIpcPolicies[item.channel] === "write");
  assert.equal(writeMethods.length, Object.values(researchIpcPolicies).filter((permission) => permission === "write").length);
  const denied = await reader.webContents.executeJavaScript(`(async () => {
    const methods = ${JSON.stringify(writeMethods)};
    const input = { ...${JSON.stringify(fixture)}, taskId:'gate',question:'forged',role:'owner',access:'owner',approved:true,text:'must not write',kind:'note' };
    const results = [];
    for (const {method,channel} of methods) {
      try { await researchApi[method](input); results.push({channel,denied:false}); }
      catch(error) { results.push({channel,denied:String(error).includes('Read-only Research Workspace capability')}); }
    }
    return results;
  })()`);
  assert.ok(denied.every((entry) => entry.denied), JSON.stringify(denied)); result.deniedWriteChannels = denied.length;
  const reads = await reader.webContents.executeJavaScript(`(async () => {
    const f=${JSON.stringify(fixture)};
    const snapshot=await researchApi.exportProject(f.projectId);
    const preview=await researchApi.previewSource({...f,limit:2});
    const report=await researchApi.readReport(f);
    const review=await researchApi.reportReviewContext(f);
    const exported=await researchApi.exportReport(f);
    const budget=await researchApi.readBudget(f.projectId);
    return {projectId:snapshot.project.projectId,preview,reportId:report.reportId,reportStatus:review.status,exportStatus:exported.status,budgetProjectId:budget.projectId};
  })()`);
  assert.equal(reads.projectId, fixture.projectId); assert.equal(reads.reportId, fixture.reportId); assert.equal(reads.preview.preview, true);
  assert.equal(reads.preview.chunks.length, 1); assert.equal(reads.budgetProjectId, fixture.projectId);
  await reader.webContents.executeJavaScript("document.querySelector('[data-action=sources]').click()");
  await waitFor(() => reader.webContents.executeJavaScript("[...document.querySelectorAll('.output button')].some(button=>button.textContent==='预览正文')"));
  await reader.webContents.executeJavaScript("[...document.querySelectorAll('.output button')].find(button=>button.textContent==='预览正文').click()");
  await waitFor(() => reader.webContents.executeJavaScript("document.querySelector('.output').textContent.includes('Bounded source preview')"));
  assert.equal(await reader.webContents.executeJavaScript("Boolean(window.sourceInjected || window.projectInjected || document.querySelector('img'))"), false);
  const refreshUrl = await reader.webContents.executeJavaScript("researchApi.refresh({access:'owner'})");
  await reader.loadURL(refreshUrl);
  assert.equal(await reader.webContents.executeJavaScript("document.documentElement.dataset.researchAccess"), "read-only");
  assert.equal(await reader.webContents.executeJavaScript("researchApi.remember({role:'owner'}).then(()=>false,error=>String(error).includes('Read-only'))"), true);
  assert.deepEqual(await readSnapshot(), before, "read-only calls and rejected mutations leave the project unchanged");
  const { ResearchRepository } = await import(pathToFileURL(path.join(projectRoot, "dist/src/research/repository.js")));
  const repository = new ResearchRepository(path.join(temp, "user-data/capture/research"));
  assert.equal((await repository.listMemoryIndexVersions()).length, 0); assert.equal((await repository.listMemoryRetrievals()).length, 0);
  assert.equal(await reader.webContents.executeJavaScript(`researchApi.previewSource({...${JSON.stringify(fixture)},offset:-1}).then(()=>false,error=>String(error).includes('offset'))`), true);
  const rogue = new BrowserWindow({ show:false, webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(projectRoot,"desktop/research-preload.cjs")} });
  await rogue.loadURL(owner.webContents.getURL());
  assert.equal(await rogue.webContents.executeJavaScript("researchApi.list().then(()=>false,error=>String(error).includes('not authorized'))"), true);
  assert.equal(await rogue.webContents.executeJavaScript("researchApi.approve({role:'owner'}).then(()=>false,error=>String(error).includes('not authorized'))"), true);
  rogue.destroy();
  const windowsBefore = BrowserWindow.getAllWindows().length;
  await reader.webContents.executeJavaScript("window.open('https://example.invalid/')"); await delay(100);
  assert.equal(BrowserWindow.getAllWindows().length, windowsBefore);
  // Main-process loadURL deliberately bypasses will-navigate; the IPC document check must still reject it.
  await reader.loadURL("data:text/html;charset=utf-8,<title>Untrusted replacement</title>");
  assert.equal(await reader.webContents.executeJavaScript("researchApi.list().then(()=>false,error=>String(error).includes('not authorized'))"), true);
  const audits = await repository.listSecurityAudits();
  assert.ok(audits.some((entry) => entry.reason === "capability")); assert.ok(audits.some((entry) => entry.reason === "authentication"));
  assert.deepEqual(await readSnapshot(), before);
  Object.assign(result, { ownerCreatesFixture:true,readOnlyReads:true,sourcePreviewEscaped:true,projectUnchanged:true,noMemoryIndexWrites:true,refreshPreservesReadOnly:true,unboundWindowRejected:true,replacementDocumentRejected:true,popupsDenied:true,denialsAudited:true,verificationScope:"Production main, actual registered IPC, production preload, owner/read-only/unbound Electron windows; synthetic project only. No packaged-upgrade or scientific-quality acceptance." });
  passed = true;
})().catch((error) => { result.failure = error.stack ?? String(error); result.diagnosticsDirectory = temp; process.exitCode = 1; }).finally(async () => {
  const save = () => {
    if (outputPath) require("node:fs").writeFileSync(outputPath,JSON.stringify(result,null,2)+"\n");
    console.log(JSON.stringify(result));
  };
  const shutdownTimer = setTimeout(() => {
    Object.assign(result, { ok:false, normalShutdown:false, failure:result.failure ?? "Production main did not finish normal shutdown within 20 seconds", diagnosticsDirectory:temp, finishedAt:new Date().toISOString() });
    save(); app.exit(1);
  }, 20_000);
  app.once("will-quit", () => {
    clearTimeout(shutdownTimer);
    Object.assign(result, { ok:passed, normalShutdown:true, finishedAt:new Date().toISOString() });
    save();
    // Leave the isolated profile for diagnostics; files can remain locked until Electron exits.
  });
  app.quit();
});
