import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let windowRef;
let harnessProcess;
let harnessUrl;
let captureMonitor;
let captureStore;
let quitting = false;

function packagedConfigFile() {
  const external = path.join(path.dirname(process.execPath), "dsh-sci.config.json");
  return fs.existsSync(external) ? external : path.join(here, "..", "config", "dsh-sci.config.json");
}

function createWindow(url) {
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
  if (url) {
    windowRef.loadURL(url);
  } else {
    windowRef.loadFile(path.join(here, "index.html"));
  }
}

function createStartupErrorWindow(error) {
  const message = String(error?.stack || error)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;");
  createWindow();
  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;padding:40px;color:#263238;background:#f7f8fa}pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:16px;border-radius:8px}</style><h1>dsh-sci 无法启动</h1><p>官方 DSH Harness 未能启动。请检查安装包和网络，然后重试。</p><pre>${message}</pre>`)}`);
}

function bundledHarnessInvocation() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "app.asar", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
        path.join(process.resourcesPath, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      ]
    : [path.join(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")];
  const script = candidates.find((candidate) => fs.existsSync(candidate));
  return script ? { command: process.execPath, argsPrefix: [script], environment: { ELECTRON_RUN_AS_NODE: "1" } } : undefined;
}

function ensureTokenFansProfile(home) {
  const patchFile = path.join(home, "profiles", "web", "cordis.patch.yml");
  const marker = "# dsh-sci: tokenfans-codex";
  const defaultsMarker = "# dsh-sci: tokenfans-default";
  const patch = `
${marker}
# Keep this route keyless in the profile. The API key is resolved by DSH's
# credential store or by TOKENFANS_API_KEY supplied by the desktop host.
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      tokenfans-codex:
        displayName: "TokenFans Codex"
        apiKeyEnv: TOKENFANS_API_KEY
        api: openai-responses
        baseURL: "https://tokenfans.ai/codex"
        models:
          - id: "gpt-6.1-sol"
`;
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  const current = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";
  if (!current.includes(marker)) fs.writeFileSync(patchFile, `${current.trimEnd()}\n${patch}`, "utf8");
  const latest = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : current;
  if (!latest.includes("# dsh-sci: tokenfans-search-disabled")) {
    fs.writeFileSync(patchFile, `${latest.trimEnd()}\n\n# dsh-sci: tokenfans-search-disabled\n- id: web-search-deepseek\n  disabled: true\n- id: web-deepseek-api\n  disabled: true\n`, "utf8");
  }
  const configured = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : latest;
  if (!configured.includes(defaultsMarker)) {
    fs.writeFileSync(patchFile, `${configured.trimEnd()}\n\n${defaultsMarker}\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: tokenfans-codex\n    model: "gpt-6.1-sol"\n`, "utf8");
  }
}

async function startOfficialHarness() {
  if (process.env.DSH_SCI_RUNTIME === "legacy") return undefined;
  const { startHarness } = await import("../dist/src/harness.js");
  const home = path.join(app.getPath("userData"), "harness");
  const workspace = app.isPackaged ? app.getPath("documents") : process.cwd();
  const { CaptureStore, WorkspaceCaptureMonitor } = await import("../dist/src/capture.js");
  captureStore = new CaptureStore(path.join(app.getPath("userData"), "capture"));
  captureMonitor = new WorkspaceCaptureMonitor(captureStore, workspace);
  await captureMonitor.start();
  ensureTokenFansProfile(home);
  const bundled = bundledHarnessInvocation();
  let tokenFansApiKey = process.env.DSH_SCI_TOKENFANS_API_KEY;
  try {
    const { loadProviderSelection } = await import("../dist/src/config.js");
    const selection = await loadProviderSelection({
      workspace,
      providerId: "tokenfans-codex",
      ...(fs.existsSync(packagedConfigFile()) ? { configFile: packagedConfigFile() } : {}),
    });
    tokenFansApiKey = selection.apiKey ?? tokenFansApiKey;
  } catch (error) {
    console.warn("Could not load the optional TokenFans configuration:", error);
  }
  const result = await startHarness({
    home,
    cwd: workspace,
    command: bundled?.command ?? process.env.DSH_SCI_HARNESS_BIN,
    argsPrefix: bundled?.argsPrefix,
    environment: {
      ...bundled?.environment,
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? "1",
      TOKENFANS_API_KEY: tokenFansApiKey,
    },
  });
  harnessProcess = result.process;
  harnessUrl = result.url;
  return result.url;
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

ipcMain.handle("get-capture-status", async () => captureStore?.readStatus() ?? { schema: "dsh-sci.capture-status.v1", state: "idle", sessionCount: 0 });

ipcMain.handle("choose-folder", async () => {
  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog(windowRef, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    const url = await startOfficialHarness();
    createWindow(url);
  } catch (error) {
    console.error("Official dsh Harness could not start:", error);
    captureMonitor?.stop();
    captureMonitor = undefined;
    if (process.env.DSH_SCI_RUNTIME === "legacy") createWindow();
    else createStartupErrorWindow(error);
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(harnessUrl); });
});

app.on("before-quit", (event) => {
  if (quitting || !harnessProcess) return;
  event.preventDefault();
  quitting = true;
  captureMonitor?.stop();
  import("../dist/src/harness.js")
    .then(({ stopHarness }) => stopHarness(harnessProcess))
    .catch((error) => console.error("Failed to stop dsh Harness:", error))
    .finally(() => { harnessProcess = undefined; app.quit(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
