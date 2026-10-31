import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { startHarness, stopHarness } from "../dist/src/harness.js";
import { buildProviderProfilePatch } from "../desktop/provider-profile.mjs";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { startResearchBridge } from "../dist/src/research/bridge.js";
import { setTimeout as delay } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const home = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-harness-"));
const captureRoot = path.join(home, "capture");
const pluginRoot = path.join(home, "plugins");
const smokeArgs = process.argv.slice(2);
if (smokeArgs.length > 1 || smokeArgs.some((arg) => !["--guard", "--guard-ptc"].includes(arg))) throw new Error("Usage: research-harness-smoke.mjs [--guard | --guard-ptc]");
const guardMode = smokeArgs.length === 1;
const guardPtc = smokeArgs[0] === "--guard-ptc";
let harness;
let bridge;

function redact(value) {
  return String(value).replace(/([?&]token=)[^&\s]+/giu, "$1<redacted>");
}

try {
  await mkdir(path.join(home, "profiles", "web"), { recursive: true });
  await mkdir(pluginRoot, { recursive: true });
  const lifecyclePlugin = path.join(pluginRoot, "dsh-sci-lifecycle-plugin.mjs");
  const researchPlugin = path.join(pluginRoot, "dsh-sci-research-plugin.mjs");
  await copyFile(path.join(root, "desktop", "dsh-sci-lifecycle-plugin.mjs"), lifecyclePlugin);
  await copyFile(path.join(root, "desktop", "dsh-sci-research-plugin.mjs"), researchPlugin);
  const repository = new ResearchRepository(path.join(captureRoot, "research"));
  const orchestrator = new ResearchOrchestrator(repository);
  bridge = await startResearchBridge(orchestrator);
  let patch = buildProviderProfilePatch(
    "",
    { provider: "custom", baseUrl: "http://127.0.0.1:1", model: "smoke-model" },
    pathToFileURL(lifecyclePlugin).href,
    pathToFileURL(researchPlugin).href,
  );
  const guardOutput = path.join(home, "guard-probe.json");
  if (guardMode) {
    const probe = path.join(pluginRoot, "research-guard-probe.mjs");
    await copyFile(path.join(root, "scripts", "research-guard-probe.mjs"), probe);
    patch += `\n- insert:\n  - id: dsh-sci-research-guard-probe\n    name: ${JSON.stringify(pathToFileURL(probe).href)}\n`;
    if (guardPtc) patch += "\n- id: tools\n  config:\n    mode: ptc\n";
  }
  await writeFile(path.join(home, "profiles", "web", "cordis.patch.yml"), patch, "utf8");
  harness = await startHarness({
    home,
    cwd: root,
    command: process.execPath,
    argsPrefix: [path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")],
    webPort: 0,
    startupTimeoutMs: 45_000,
    environment: {
      ELECTRON_RUN_AS_NODE: "1",
      DSH_TELEMETRY_DISABLED: "1",
      DSH_SCI_CAPTURE_ROOT: captureRoot,
      DSH_SCI_RESEARCH_ROOT: repository.root,
      DSH_SCI_TOOLS_MODULE_URL: import.meta.resolve("@deepseek-ai/dsh-tools"),
      DSH_SCI_RESEARCH_BRIDGE_URL: bridge.url,
      DSH_SCI_RESEARCH_BRIDGE_TOKEN: bridge.token,
      ...(guardMode ? { DSH_SCI_EXTERNAL_RUNNER: "1", DSH_SCI_GUARD_PROBE_OUTPUT: guardOutput, DSH_SCI_GUARD_EXPECT_MODE: guardPtc ? "ptc" : "native" } : {}),
    },
  });
  const launchResponse = await fetch(harness.url, { redirect: "manual" });
  if (launchResponse.status !== 303) throw new Error(`Harness launch URL returned HTTP ${launchResponse.status}`);
  const cookie = launchResponse.headers.get("set-cookie");
  const cleanUrl = new URL(launchResponse.headers.get("location") ?? "/", harness.url);
  const response = await fetch(cleanUrl, { headers: cookie ? { cookie } : undefined });
  if (!response.ok) throw new Error(`Harness UI returned HTTP ${response.status}`);
  const html = await response.text();
  if (!html.includes("DeepSeek") && !html.includes("dsh")) throw new Error("Harness UI response did not look like DSH Web");
  const create = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "create", question: "M0 smoke question" }) });
  if (!create.ok) throw new Error(`Research bridge create failed with HTTP ${create.status}`);
  const created = await create.json();
  const context = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "context" }) });
  if (!context.ok) throw new Error(`Research bridge context failed with HTTP ${context.status}`);
  const pluginState = JSON.parse(await readFile(path.join(repository.root, "plugin-state.json"), "utf8"));
  if (!Array.isArray(pluginState.tools) || !pluginState.tools.includes("research_action") || pluginState.toolHelper !== "defineTool") throw new Error("Research plugin did not register defineTool-backed research tools in the real Harness");
  const project = await repository.readProject(created.project.projectId);
  if (!project) throw new Error("Created project was not persisted");
  let guard;
  if (guardMode) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try { guard = JSON.parse(await readFile(guardOutput, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      if (harness.process.exitCode !== null) throw new Error("Harness exited during guard probe");
      await delay(100);
    }
    if (!guard?.ok) throw new Error(`Harness guard probe failed: ${JSON.stringify(guard ?? { reason: "no probe report before deadline" })}`);
  }
  console.log(JSON.stringify({ ok: true, harnessUrl: redact(harness.url), uiStatus: response.status, projectId: project.projectId, bridgeActions: ["create", "context"], pluginPatch: true, registeredTools: pluginState.tools, ...(guard ? { guard } : {}) }));
} finally {
  await stopHarness(harness?.process);
  await bridge?.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true });
}
