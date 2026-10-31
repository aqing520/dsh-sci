import { app, BrowserWindow, ipcMain, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResearchWindowRegistry, createResearchIpcRegistrar } from "../desktop/research-access.mjs";
import { renderCaseDashboard } from "../desktop/research-case-dashboard.mjs";
import { loadCaseWorkspace, registerCaseWorkspaceIpc } from "./research-case-workspace-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Electron may retain switches before the script path in argv; application
// arguments begin at our explicit --case marker, not a fixed array offset.
const args = process.argv.slice(process.argv.indexOf("--case")), index = args.indexOf("--case");
if (index < 0 || !args[index + 1] || args.some((arg, i) => i !== index + 1 && !["--case", "--review", "--disable-gpu", "--no-sandbox"].includes(arg))) throw new Error("Usage: --case <validation-case> [--review]");
const context = await loadCaseWorkspace(path.resolve(args[index + 1]), path.join(root, "research/validation/cases"));
const readOnly = !args.includes("--review");
const registry = createResearchWindowRegistry();
registerCaseWorkspaceIpc(createResearchIpcRegistrar(ipcMain, registry), context);
Menu.setApplicationMenu(null);
const window = new BrowserWindow({ width: 1150, height: 850, minWidth: 820, minHeight: 600, title: "科研案例审阅", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, "desktop/research-case-preload.cjs") } });
const url = "data:text/html;charset=utf-8," + encodeURIComponent(renderCaseDashboard({ directory: context.directory, readOnly }));
registry.bind(window, readOnly ? "read-only" : "owner", url);
await window.loadURL(url);
console.log(JSON.stringify({ case: context.directory, projectId: context.projectId, access: readOnly ? "read-only" : "owner", action: "opened", automaticallyApproved: false, automaticallyExecuted: false }));
app.on("window-all-closed", () => app.quit());
let exiting = false;
app.on("before-quit", (event) => {
  if (exiting) return;
  event.preventDefault(); exiting = true;
  context.orchestrator.cancelRunningExperiments().then(() => app.quit(), (error) => { console.error(error); app.exit(1); });
});
