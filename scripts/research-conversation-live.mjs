// Explicit live acceptance: current DSH Agent, real papers and a configured provider.
// Credentials are resolved in this process and never enter the prompt or output files.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseCredentialsDocument } from "@deepseek-ai/dsh-credentials-local";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { ResearchConversations } from "../dist/src/research/conversation.js";
import { startResearchBridge } from "../dist/src/research/bridge.js";
import { startDshSdkClient, installDshResearchSdkProfile } from "../dist/src/research/dsh-sdk.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (!args.includes("--live")) throw new Error("This calls a real provider. Run with --live [--model gpt-6-luna] [--output directory].");
const model = option("--model", "gpt-6-luna");
const baseUrl = option("--base-url", "https://tokenfans.ai/codex");
if (!["https://tokenfans.ai/codex", "https://tokenfans.ai/v1"].includes(baseUrl)) throw new Error("Live acceptance only supports the configured TokenFans service");
const output = path.resolve(option("--output", path.join(root, "research", "validation", `native-live-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
const credentialFile = path.resolve(option("--credentials", path.join(process.env.APPDATA ?? "", "dsh-sci", "harness", ".credentials.yaml")));
let apiKey = process.env.TOKENFANS_API_KEY;
try { apiKey = parseCredentialsDocument(await readFile(credentialFile, "utf8"), credentialFile).refs.get("TOKENFANS_API_KEY") ?? apiKey; }
catch (error) { if (error.code !== "ENOENT") throw new Error("Configured credentials could not be loaded; contents are withheld."); }
if (!apiKey) throw new Error("TokenFans is not configured. Configure it in the application's Models settings first.");
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const workspace = path.join(output, "workspace"), home = path.join(output, "harness");
await mkdir(workspace);
const repository = new ResearchRepository(path.join(output, "research"));
const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: workspace, allowedCommands: [process.execPath] } });
const sessionId = `native-live-reading-${Date.now()}`;
const status = { schema: "dsh-sci.native-live.v1", pid: process.pid, startedAt: new Date().toISOString(), model, provider: "tokenfans-codex", baseUrl, sessionId, output, state: "preparing", scientificReview: "pending" };
const save = async () => writeFile(path.join(output, "status.json"), JSON.stringify(status, null, 2) + "\n");
await save();
let bridge, client;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("Live acceptance interrupted after fifteen minutes; saved evidence is retained.")), 15 * 60_000);
try {
  const papers = [
    { file: "attention-is-all-you-need.pdf", url: "https://arxiv.org/pdf/1706.03762v7" },
    { file: "bert.pdf", url: "https://arxiv.org/pdf/1810.04805v2" },
  ];
  const manifest = [];
  for (const paper of papers) {
    const response = await fetch(paper.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
    if (!response.ok) throw new Error(`Paper acquisition failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Paper server did not return a PDF");
    await writeFile(path.join(workspace, paper.file), bytes);
    manifest.push({ ...paper, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), retrievedAt: new Date().toISOString() });
  }
  await writeFile(path.join(workspace, "source-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  bridge = await startResearchBridge(orchestrator, { conversations: new ResearchConversations(orchestrator) });
  const patch = await installDshResearchSdkProfile(home, { pluginFile: path.join(root, "desktop", "dsh-sci-research-plugin.mjs"), provider: "tokenfans-codex", model, baseUrl });
  await writeFile(patch, (await readFile(patch, "utf8")).replace("You are a research agent. Use persisted evidence, report uncertainty, and return structured task results.", "You are a helpful research-capable agent. Work in the current conversation and answer naturally with verified evidence.") + "\n- id: tools\n  config:\n    mode: native\n");
  client = await startDshSdkClient({ home, cwd: workspace, provider: "tokenfans-codex", model, apiKey, isolateProviderCredentials: true, maxTokens: 8192, signal: controller.signal, environment: { DSH_SCI_EXTERNAL_RUNNER: undefined, DSH_TELEMETRY_DISABLED: "1", DSH_SCI_RESEARCH_ROOT: repository.root, DSH_SCI_RESEARCH_BRIDGE_URL: bridge.url, DSH_SCI_RESEARCH_BRIDGE_TOKEN: bridge.token, DSH_SCI_TOOLS_MODULE_URL: import.meta.resolve("@deepseek-ai/dsh-tools") } });
  apiKey = undefined;
  status.state = "running"; await save();
  console.log(JSON.stringify({ state: status.state, pid: process.pid, output, model }));
  await client.createSession(sessionId, controller.signal);
  const prompt = "请直接在当前对话中研究并比较当前目录的 attention-is-all-you-need.pdf 和 bert.pdf 两篇论文。重点比较注意力可见范围、训练目标与输入表征，并回答：能否直接根据论文报告的 BLEU 和 GLUE 数值判断 BERT 比原 Transformer 更强？请实际阅读相关正文，不要仅靠已有知识或摘要。每篇至少保存两条可定位的原文引用，每条英文引文不超过10个词；保存支撑比较的主张和证据关系。明确比较的范围、不可比之处，以及哪些是原文事实、哪些是你的推断。无需实验，不执行代码。完成后保存进度，在这里用中文正常回答，给出保存的证据引用，不要输出内部任务 JSON。";
  await writeFile(path.join(output, "prompt.txt"), prompt, "utf8");
  await client.prompt(sessionId, prompt, controller.signal);
  await client.wait(sessionId, controller.signal);
  const answer = client.lastAssistantText(sessionId) ?? "";
  await writeFile(path.join(output, "answer.md"), answer + "\n", "utf8");
  const project = (await repository.listProjects()).find((item) => item.mode === "conversation");
  if (!project) throw new Error("The live Agent did not create conversation research");
  const snapshot = await repository.exportProject(project.projectId);
  await writeFile(path.join(output, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
  const checks = { hasOrdinaryAnswer: Boolean(answer && !/^\s*\{/u.test(answer)), twoSources: snapshot.sources.length >= 2, actualReading: new Set(snapshot.sourceReads.filter((read) => read.audience === "agent").map((read) => read.sourceId)).size >= 2, locatedCitations: snapshot.citations.length >= 4 && snapshot.citations.every((citation) => citation.verification?.status === "verbatim-match"), claimsAndEvidence: snapshot.claims.length > 0 && snapshot.evidence.length > 0, noExperiments: snapshot.experimentRuns.length === 0, checkpointSaved: Boolean(await repository.readConversationCheckpoint(project.projectId)) };
  Object.assign(status, { state: "completed", projectId: project.projectId, checks, structuralPass: Object.values(checks).every(Boolean), budget: snapshot.budget, scientificReview: "pending-manual-review-of-answer-and-cited-passages", finishedAt: new Date().toISOString() });
  await save();
  console.log(JSON.stringify({ state: status.state, structuralPass: status.structuralPass, output, projectId: project.projectId, checks, modelRequests: snapshot.budget.usedModelRequests, reportedTokens: snapshot.budget.reportedTotalTokens }));
} catch (error) {
  Object.assign(status, { state: controller.signal.aborted ? "interrupted" : "failed", error: String(error.message ?? error).replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}/giu, "[redacted]"), finishedAt: new Date().toISOString() });
  await save(); process.exitCode = 1;
  console.error(JSON.stringify({ state: status.state, output, error: status.error }));
} finally {
  clearTimeout(timer);
  await client?.close();
  await bridge?.close();
}
