import { app, BrowserWindow, Menu } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const scriptArg = process.argv.findIndex((value) => value.endsWith("research-app-crash-child.cjs"));
const [phase, root] = process.argv.slice(scriptArg >= 0 ? scriptArg + 1 : 2);
const deadline = Date.now() + 60_000;
await import("../desktop/main.mjs");
while (Menu.getApplicationMenu()?.items[0]?.label !== "dsh-sci") {
  if (Date.now() > deadline) throw new Error("Application menu did not become ready");
  await delay(50);
}
await Menu.getApplicationMenu().items[0].submenu.items.find((item) => item.label === "Research Workspace").click();
let workspace;
while (!workspace || !await workspace.webContents.executeJavaScript("Boolean(window.researchApi)").catch(() => false)) {
  workspace = BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Research Workspace" || window.getTitle() === "dsh-sci Research Workspace");
  if (Date.now() > deadline) throw new Error("Research Workspace did not load");
  await delay(50);
}
const evaluate = (script) => workspace.webContents.executeJavaScript(script);
if (phase === "start") {
  const saved = await evaluate(`(async () => {
    const question = 'Survive a whole-app crash without repeating the experiment';
    const result = await researchApi.create({ question, plan: { question, tasks: [
      {taskId:'evidence',title:'Save evidence',objective:'Record a durable checkpoint'},
      {taskId:'experiment',title:'Run experiment',objective:'Run after approval',kind:'experiment',requiresApproval:true,dependsOn:['evidence']}
    ]} });
    const id = result.project.projectId;
    await researchApi.activate(id); await researchApi.startNext(id);
    await researchApi.remember({projectId:id,kind:'note',text:'Evidence checkpoint before application crash',confidence:'high'});
    await researchApi.complete({projectId:id,taskId:'evidence'});
    await researchApi.startNext(id); await researchApi.approve({projectId:id,taskId:'experiment'});
    return {projectId:id};
  })()`);
  const code = "const fs=require('node:fs');const cp=require('node:child_process');fs.appendFileSync('attempts.txt','one\\n');const grandchild=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify({command:process.pid,grandchild:grandchild.pid}));setInterval(()=>{},1000);";
  const experiment = await evaluate(`researchApi.createExperiment(${JSON.stringify({ projectId: saved.projectId, taskId: "experiment", title: "Long-running child tree", command: "node", args: ["-e", code], cwd: path.join(root, "workspace"), outputPaths: ["attempts.txt"], timeoutMs: 60_000 })})`);
  // Synthetic fixture only: follow the same exact-content approval path as the
  // Workspace. The real scientific case never auto-approves its proposal.
  const preview = await evaluate(`researchApi.experimentReview(${JSON.stringify({ projectId: saved.projectId, experimentId: experiment.experimentId })})`);
  assert.equal(preview.proposalContentHash, experiment.proposalContentHash);
  await evaluate(`researchApi.approveExperiment(${JSON.stringify({ projectId: saved.projectId, experimentId: experiment.experimentId, contentHash: preview.proposalContentHash })})`);
  await writeFile(path.join(root, "fixture.json"), JSON.stringify({ ...saved, experimentId: experiment.experimentId }));
  void evaluate(`researchApi.executeExperiment(${JSON.stringify({ ...saved, experimentId: experiment.experimentId, approved: true })})`).catch(async (error) => { await writeFile(path.join(root, "launch-failure.json"), JSON.stringify({ message: String(error.message) })); app.exit(1); });
  console.log(JSON.stringify({ phase: "experiment-requested", pid: process.pid }));
} else {
  const fixture = JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8"));
  const snapshot = await evaluate(`researchApi.exportProject(${JSON.stringify(fixture.projectId)})`);
  assert.equal(snapshot.project.status, "paused");
  assert.equal(snapshot.plan.tasks.find((task) => task.taskId === "evidence").status, "completed");
  assert.equal(snapshot.experimentRuns.length, 1);
  assert.equal(snapshot.experimentRuns[0].state, "interrupted");
  assert.equal(snapshot.events.filter((event) => event.type === "experiment-interrupted").length, 1);
  const memories = await evaluate(`researchApi.searchMemory({query:'Evidence checkpoint',projectId:${JSON.stringify(fixture.projectId)}})`);
  assert.equal(memories.length, 1);
  await evaluate(`researchApi.resume(${JSON.stringify(fixture.projectId)})`);
  const prevented = await evaluate(`researchApi.executeExperiment(${JSON.stringify({ ...fixture, approved: true })}).then(()=>false,error=>String(error).includes('unfinished execution'))`);
  assert.equal(prevented, true);
  const report = await evaluate(`researchApi.generateReport(${JSON.stringify(fixture.projectId)})`);
  assert.ok(report.warnings.some((warning) => warning.includes("no confirmed terminal result")));
  const startup = JSON.parse(await readFile(path.join(root, "user-data", "startup-state.json"), "utf8"));
  assert.equal(startup.previousCleanShutdown, false);
  await writeFile(path.join(root, "recovered.json"), JSON.stringify({ pausedAfterCrash: true, evidenceRetained: true, memoryRetained: true, interruptedRuns: 1, rerunPrevented: true, reportWarns: true, uncleanStartupDetected: true }));
  console.log(JSON.stringify({ phase: "recovered", pid: process.pid }));
  app.quit();
}
