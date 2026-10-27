import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let windowRef;
let harnessProcess;
let harnessUrl;
let captureMonitor;
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
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (url) {
    windowRef.loadURL(url);
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
  const lifecycleFile = path.join(home, "plugins", "dsh-sci-lifecycle-plugin.mjs");
  fs.mkdirSync(path.dirname(lifecycleFile), { recursive: true });
  fs.copyFileSync(path.join(here, "dsh-sci-lifecycle-plugin.mjs"), lifecycleFile);
  const lifecyclePatch = pathToFileURL(lifecycleFile).href;
  const finalPatch = fs.readFileSync(patchFile, "utf8");
  const lifecycleBlock = `# dsh-sci: lifecycle-plugin\n- insert:\n  - id: dsh-sci-lifecycle\n    name: ${JSON.stringify(lifecyclePatch)}\n# dsh-sci: lifecycle-plugin-end`;
  const lifecyclePattern = /# dsh-sci: lifecycle-plugin\n[\\s\\S]*?(?:# dsh-sci: lifecycle-plugin-end|$)/;
  const withoutLifecycle = lifecyclePattern.test(finalPatch)
    ? finalPatch.replace(lifecyclePattern, "").trimEnd()
    : finalPatch.trimEnd();
  fs.writeFileSync(patchFile, `${withoutLifecycle}\n\n${lifecycleBlock}\n`, "utf8");
}

async function startOfficialHarness() {
  const { startHarness } = await import("../dist/src/harness.js");
  const home = path.join(app.getPath("userData"), "harness");
  const workspace = app.isPackaged ? app.getPath("documents") : process.cwd();
  const { CaptureStore, WorkspaceCaptureMonitor } = await import("../dist/src/capture.js");
  const captureStore = new CaptureStore(path.join(app.getPath("userData"), "capture"));
  captureMonitor = new WorkspaceCaptureMonitor(captureStore, workspace);
  await captureMonitor.start();
  process.env.DSH_SCI_CAPTURE_ROOT = path.join(app.getPath("userData"), "capture");
  ensureTokenFansProfile(home);
  const bundled = bundledHarnessInvocation();
  let tokenFansApiKey = process.env.DSH_SCI_TOKENFANS_API_KEY;
  try {
    const { loadTokenFansApiKey } = await import("../dist/src/config.js");
    const configuredKey = await loadTokenFansApiKey({
      workspace,
      ...(fs.existsSync(packagedConfigFile()) ? { configFile: packagedConfigFile() } : {}),
    });
    tokenFansApiKey = configuredKey ?? tokenFansApiKey;
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

app.whenReady().then(async () => {
  try {
    const url = await startOfficialHarness();
    createWindow(url);
  } catch (error) {
    console.error("Official dsh Harness could not start:", error);
    captureMonitor?.stop();
    captureMonitor = undefined;
    createStartupErrorWindow(error);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && harnessUrl) createWindow(harnessUrl);
  });
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
