import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let windowRef;

function packagedConfigFile() {
  const external = path.join(path.dirname(process.execPath), "dsh-sci.config.json");
  return fs.existsSync(external) ? external : path.join(here, "..", "config", "dsh-sci.config.json");
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: "dsh-sci",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windowRef.loadFile(path.join(here, "index.html"));
}

ipcMain.handle("run-agent", async (_event, request) => {
  const { AgentRuntime } = await import("../dist/src/agent.js");
  const { OpenAIResponsesProvider } = await import("../dist/src/provider.js");
  const { loadProviderSelection } = await import("../dist/src/config.js");
  const workspace = path.resolve(String(request.workspace || process.cwd()));
  const provider = await loadProviderSelection({
    workspace,
    configFile: packagedConfigFile(),
    providerId: request.providerId,
    baseUrl: request.baseUrl,
    model: request.model,
    apiKey: request.apiKey,
  });
  const runtime = new AgentRuntime({ root: workspace, permission: request.permission || "read-only" }, new OpenAIResponsesProvider(provider));
  const text = await runtime.run(String(request.prompt || ""));
  return { text, snapshot: await runtime.snapshot(), provider: provider.label };
});

ipcMain.handle("get-config", async (_event, request) => {
  const { loadProviderSelection, PROVIDER_PROFILES } = await import("../dist/src/config.js");
  const workspace = path.resolve(String(request?.workspace || process.cwd()));
  const provider = await loadProviderSelection({ workspace, configFile: packagedConfigFile() });
  return {
    profiles: PROVIDER_PROFILES.map(({ id, label, baseUrl, model }) => ({ id, label, baseUrl, model })),
    selected: { providerId: provider.providerId, label: provider.label, baseUrl: provider.baseUrl, model: provider.model, hasApiKey: Boolean(provider.apiKey) },
  };
});

ipcMain.handle("choose-folder", async () => {
  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog(windowRef, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
