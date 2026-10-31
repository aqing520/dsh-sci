import { createServer } from "node:http";
import { mkdtemp, mkdir, copyFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { startResearchBridge } from "../dist/src/research/bridge.js";
import { runResearchWithDshAgent } from "../dist/src/research/dsh-sdk.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repairIdentity = process.argv.length === 3 && process.argv[2] === "--identity-repair";
const repairReferences = process.argv.length === 3 && process.argv[2] === "--reference-repair";
const repairResult = repairIdentity || repairReferences;
if (process.argv.length > 2 && !repairResult) throw new Error("Usage: research-sdk-smoke.mjs [--identity-repair|--reference-repair]");
const temp = await mkdtemp(path.join(tmpdir(), "dsh-sci-research-sdk-smoke-"));
const workspace = path.join(temp, "workspace");
const sdkHome = path.join(temp, "sdk-home");
const repository = new ResearchRepository(path.join(temp, "research"));
const orchestrator = new ResearchOrchestrator(repository);
let bridge;
let server;
try {
  await mkdir(workspace, { recursive: true });
  bridge = await startResearchBridge(orchestrator);
  const created = await orchestrator.createProject("Official SDK smoke", { plan: { question: "Official SDK smoke", tasks: [{ taskId: "one", title: "One", objective: "Return a deterministic synthetic transport result", kind: "custom" }] } });
  const priorMemory = await orchestrator.remember(created.project.projectId, { text: "Official SDK smoke prior bounded transport memory", kind: "note", confidence: "high", applicability: "Synthetic transport fixture only" });
  const reopened = new ResearchOrchestrator(new ResearchRepository(path.join(temp, "research")));
  let memoryInjected = false;
  let responseAttempts = 0;
  server = createServer(async (request, response) => {
    if (request.url !== "/v1/responses") { response.writeHead(404); response.end(); return; }
    responseAttempts += 1;
    if (responseAttempts === 1) { request.socket.destroy(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body).input;
    const prompt = input?.find?.((item) => item?.role === "user")?.content?.find?.((item) => item?.type === "input_text")?.text ?? "";
    const contextText = prompt.match(/^Retrieved research memory .*?: (.+)$/m)?.[1];
    const memoryContext = contextText ? JSON.parse(contextText) : undefined;
    if (!memoryContext?.memory?.some((entry) => entry.memoryId === priorMemory.memoryId && entry.text === priorMemory.text && entry.applicability === priorMemory.applicability) || !memoryContext.retrievalId || !memoryContext.guidance?.includes("Candidate")) throw new Error("Official SDK prompt did not receive persisted bounded memory context");
    memoryInjected = true;
    const projectId = /Project: ([^\r\n]+)/.exec(prompt)?.[1] ?? created.project.projectId;
    const taskId = /Task: ([^ ]+)/.exec(prompt)?.[1] ?? "one";
    const identity = JSON.parse(prompt.match(/^Exact execution identity: (.+)$/m)[1]);
    if (repairIdentity && responseAttempts === 2) identity.attemptId = "fixture-stale-attempt";
    if (repairResult && responseAttempts > 2 && !JSON.stringify(input).includes("previous task-result JSON was rejected")) throw new Error("SDK did not ask the model to repair its own result");
    if (repairReferences && responseAttempts > 2 && !JSON.stringify(input).includes("unregistered record IDs at indexes [0]")) throw new Error("SDK did not report the invalid reference index");
    const resultText = JSON.stringify({ schema: "dsh-sci.research-task-result.v2", ...identity, projectId, taskId, status: "completed", summary: "Official DSH SDK completed this task.", refs: repairReferences ? [responseAttempts === 2 ? "fixture-unregistered-id" : priorMemory.memoryId] : [], claims: [], evidence: [], nextAction: "continue" });
    const message = { type: "message", id: "msg-smoke", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: resultText }] };
    const events = [
      { type: "response.created", response: { id: "resp-smoke" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: message.id, role: message.role, phase: message.phase, content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: resultText },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp-smoke", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const result = await runResearchWithDshAgent(reopened, { projectId: created.project.projectId, sdkHome, pluginFile: path.join(root, "desktop", "dsh-sci-research-plugin.mjs"), cwd: workspace, provider: "custom", model: "smoke-model", baseUrl, apiKey: "smoke-key", environment: { DSH_SCI_RESEARCH_BRIDGE_URL: bridge.url, DSH_SCI_RESEARCH_BRIDGE_TOKEN: bridge.token, DSH_SCI_TOOLS_MODULE_URL: import.meta.resolve("@deepseek-ai/dsh-tools") }, maxSteps: 2, sessionScope: "plan" });
  const exported = await repository.exportProject(created.project.projectId);
  if (result.status !== "completed" || exported.plan?.tasks[0]?.status !== "completed") throw new Error(`Official SDK smoke did not complete the research task: ${JSON.stringify({ resultStatus: result.status, taskStatus: exported.plan?.tasks[0]?.status, taskError: exported.plan?.tasks[0]?.error, taskSummary: exported.plan?.tasks[0]?.summary, resultReason: result.reason, resultError: result.error })}`);
  const budget = exported.budget;
  if (budget.schema !== "dsh-sci.research-budget.v2" || budget.usedModelRequests !== responseAttempts || budget.reportedTotalTokens !== (repairResult ? 4 : 2) || budget.unknownUsageRequests !== 1 || budget.modelRequests.some((request) => request.status !== "settled")) throw new Error("SDK attempts or retry usage did not match the product model budget");
  const repairs = exported.events.filter((event) => event.type === "task-result-repair-requested");
  if (repairs.length !== (repairResult ? 1 : 0) || exported.plan.tasks[0].attempts !== 1 || exported.events.filter((event) => event.type === "task-completed").length !== 1) throw new Error("SDK result repair was not bounded to the original task attempt and unique completion");
  const injection = (await repository.listMemoryRetrievals()).find((record) => record.purpose === "task-context" && record.injectedMemoryIds?.includes(priorMemory.memoryId));
  if (!memoryInjected || !injection || injection.injectedMemories?.[0].text !== priorMemory.text) throw new Error("SDK memory injection was not bound to a persisted excerpt record");
  console.log(JSON.stringify({ ok: true, resultStatus: result.status, steps: result.steps, providerAttempts: responseAttempts, productModelRequests: budget.usedModelRequests, reportedTokens: budget.reportedTotalTokens, unknownUsageRequests: budget.unknownUsageRequests, taskStatus: exported.plan.tasks[0].status, identityRepairRequests: repairs.filter((event) => event.data?.reason === "stale-result-identity").length, referenceRepairRequests: repairs.filter((event) => event.data?.reason === "unregistered-result-references").length, taskAttempts: exported.plan.tasks[0].attempts, sessionFile: Boolean(await repository.readAgentSession(created.project.projectId)), memoryInjectedAfterRepositoryRestart: memoryInjected, memoryExcerptAuditBound: true, scientificQuality: "not-reviewed; synthetic SDK transport fixture" }));
} finally {
  await new Promise((resolve) => server?.close(() => resolve()));
  await bridge?.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
}
