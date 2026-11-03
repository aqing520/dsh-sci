// Real DSH loop and production plugin; deterministic local provider, no paid API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { ResearchConversations } from "../dist/src/research/conversation.js";
import { startResearchBridge } from "../dist/src/research/bridge.js";
import { startDshSdkClient, installDshResearchSdkProfile } from "../dist/src/research/dsh-sdk.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(tmpdir(), "dsh-sci-native-smoke-"));
const workspace = path.join(temp, "workspace"), home = path.join(temp, "home");
const repository = new ResearchRepository(path.join(temp, "research"));
const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: workspace, allowedCommands: [process.execPath] } });
let bridge, server, client;
let requests = 0;
const providerErrors = [];
const usedTools = [];
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("Native conversation smoke exceeded 90 seconds")), 90000);
try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "a.md"), "# Fixture A\nThis fixture compares paired observations. It is not a real paper.\n");
  await writeFile(path.join(workspace, "b.md"), "# Fixture B\nThis fixture compares independent observations. Dependence violates its assumption.\n");
  bridge = await startResearchBridge(orchestrator, { conversations: new ResearchConversations(orchestrator) });
  server = createServer(async (request, response) => {
    try {
      if (request.url !== "/v1/responses") { response.writeHead(404); response.end(); return; }
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const step = requests++;
      assert.ok(step < 9, "Agent must stop after the final prose response");
      assert.ok(input.tools.some((tool) => tool.name === "research_read"), "production named research tools must reach the current model");
      assert.match(JSON.stringify(input), /Research in this conversation/);
      const project = (await repository.listProjects()).find((project) => project.mode === "conversation");
      const snapshot = project ? await repository.exportProject(project.projectId) : undefined;
      let name, args;
      if (step === 0) { name = "research_begin"; args = { question: "Compare the observation-dependence assumptions of the two fixture documents, with actual citations and limitations." }; }
      if (step === 1 || step === 2) { name = "research_read"; args = { file: step === 1 ? "a.md" : "b.md" }; }
      if (step === 3 || step === 4) {
        const contents = await Promise.all(snapshot.sourceContents.map((item) => repository.readSourceContent(project.projectId, item.contentVersionId)));
        const content = contents.find((item) => item.text.includes(step === 3 ? "paired observations" : "independent observations"));
        assert.ok(content);
        assert.ok(JSON.stringify(input.input).includes(step === 3 ? "paired observations" : "independent observations"), "actual text chunks must be delivered to the model before citation");
        name = "research_cite"; args = { sourceId: content.sourceId, contentVersionId: content.contentVersionId, chunkId: content.chunks[0].chunkId, quotedText: step === 3 ? "paired observations" : "independent observations" };
      }
      if (step === 5) { name = "research_claim"; args = { text: "The fixtures assume different observation dependence; neither is a scientifically validated comparison.", claimType: "interpretation", citationIds: snapshot.citations.map((item) => item.citationId) }; }
      if (step === 6) { name = "research_checkpoint"; args = { summary: "Read both documents and saved two exact citations. Paired and independent observation assumptions differ; these are synthetic fixtures, and no experiment ran.", refs: [...snapshot.citations.map((item) => item.citationId), ...snapshot.claims.map((item) => item.claimId)] }; }
      const id = `fixture-${step}`;
      const events = [{ type: "response.created", response: { id } }];
      let item;
      if (name) {
        usedTools.push(name);
        const json = JSON.stringify(args);
        item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: json, status: "completed" };
        events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }, { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: json }, { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: json }, { type: "response.output_item.done", output_index: 0, item });
      } else {
        assert.equal(snapshot.citations.length, 2);
        const text = `两份测试材料分别采用配对观察和独立观察假设，证据位置为 ${snapshot.citations.map((item) => item.citationId).join("、")}。这是合成材料的文本比较，没有运行实验，也不能据此判断科学有效性。`;
        item = { type: "message", id: `msg_${id}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] };
        events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }, { type: "response.output_text.delta", output_index: 0, delta: text }, { type: "response.output_item.done", output_index: 0, item });
      }
      events.push({ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } });
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { providerErrors.push(String(error)); response.writeHead(500); response.end("Synthetic provider assertion failed"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const patch = await installDshResearchSdkProfile(home, { pluginFile: path.join(root, "desktop", "dsh-sci-research-plugin.mjs"), provider: "custom", model: "native-fixture-model", baseUrl: `http://127.0.0.1:${address.port}/v1` });
  await writeFile(patch, (await readFile(patch, "utf8")).replace("You are a research agent. Use persisted evidence, report uncertainty, and return structured task results.", "You are a helpful agent. Answer the user normally using evidence.") + '\n- id: tools\n  config:\n    mode: native\n');
  const launch = () => startDshSdkClient({ home, cwd: workspace, provider: "dsh-sci-custom", model: "native-fixture-model", apiKey: "local-fixture-key", isolateProviderCredentials: true, signal: controller.signal, environment: { DSH_SCI_EXTERNAL_RUNNER: undefined, DSH_TELEMETRY_DISABLED: "1", DSH_SCI_RESEARCH_ROOT: repository.root, DSH_SCI_RESEARCH_BRIDGE_URL: bridge.url, DSH_SCI_RESEARCH_BRIDGE_TOKEN: bridge.token, DSH_SCI_TOOLS_MODULE_URL: import.meta.resolve("@deepseek-ai/dsh-tools") } });
  client = await launch();
  const sessionId = "native-reading-fixture";
  await client.createSession(sessionId, controller.signal);
  await client.prompt(sessionId, "请在当前对话比较 a.md 和 b.md 的方法假设，读正文、提供可核对引用，并解释限制。", controller.signal);
  await client.wait(sessionId, controller.signal).catch((error) => { throw new Error(`${error.message}; provider assertions: ${providerErrors.join("; ")}`); });
  assert.deepEqual(providerErrors, []);
  const project = (await repository.listProjects()).find((project) => project.mode === "conversation");
  const snapshot = await repository.exportProject(project.projectId);
  // The first model call chooses to begin research; subsequent seven calls are metered.
  assert.equal(snapshot.budget.usedModelRequests, 7);
  assert.equal(snapshot.budget.reportedTotalTokens, 56);
  assert.equal(snapshot.budget.unknownUsageRequests, 0);
  assert.equal(snapshot.sourceReads.length, 2);
  assert.equal(snapshot.citations.every((citation) => citation.verification.status === "verbatim-match"), true);
  assert.equal(snapshot.experimentRuns.length, 0);
  const answer = client.lastAssistantText(sessionId);
  assert.match(answer, /配对观察/); assert.doesNotMatch(answer, /research-task-result|^\s*\{/);
  await client.close();
  client = await launch();
  await client.resume(sessionId, controller.signal);
  await client.prompt(sessionId, "继续刚才的研究，只简短说明已有比较与限制，不重复读取或实验。", controller.signal);
  await client.wait(sessionId, controller.signal);
  const resumed = await repository.exportProject(project.projectId);
  assert.equal(resumed.sourceReads.length, 2);
  assert.equal(resumed.budget.usedModelRequests, 8);
  assert.equal(resumed.budget.reportedTotalTokens, 64);
  assert.match(client.lastAssistantText(sessionId), /配对观察/);
  console.log(JSON.stringify({ ok: true, currentSession: sessionId, namedToolCalls: usedTools, modelCalls: requests, meteredResearchCalls: resumed.budget.usedModelRequests, reportedTokens: resumed.budget.reportedTotalTokens, citations: resumed.citations.length, sourceReads: resumed.sourceReads.length, ordinaryProseAnswer: true, resumedAfterHarnessRestart: true, externalRunner: false, verificationScope: "Real DSH Agent loop, production conversation tools, local synthetic provider and documents. No paid API or scientific quality acceptance." }));
} finally {
  clearTimeout(timeout);
  await client?.close();
  await bridge?.close();
  if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(temp, { recursive: true, force: true });
}
