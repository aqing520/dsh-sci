// Opt-in acceptance check: uses the configured live provider and consumes tokens.
// Kept separate from release:preflight, which remains local and deterministic.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfig } from "../dist/src/provider.js";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { runResearchWithDshAgent } from "../dist/src/research/dsh-sdk.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const steps = Number(process.argv[2] ?? 20);
if (!Number.isInteger(steps) || steps < 2 || steps > 50) throw new Error("Provider smoke requires 2–50 tasks");
const config = await loadProviderConfig({ workspace: root });
if (!config.apiKey?.trim()) throw new Error("Live provider smoke requires a configured API key");
const temp = await mkdtemp(path.join(tmpdir(), "dsh-sci-live-provider-"));
const workspace = path.join(temp, "workspace");
const repositoryRoot = path.join(temp, "research");
const startedAt = new Date().toISOString();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20 * 60_000);
let requests = 0;
let upstreamResponses = 0;
let injectedDisconnects = 0;
let disconnectNext = true;
let completedBeforeRestart = 0;
let server;
let succeeded = false;
let upstreamFailure;
const output = path.join(root, "research", "validation", `live-provider-${Date.now()}.json`);
const summary = { schema: "dsh-sci.live-provider-smoke.v1", startedAt, provider: config.provider, model: config.model, tasks: steps };
try {
  await mkdir(workspace, { recursive: true });
  // The loopback proxy forwards real responses without logging headers or bodies.
  // Dropping a local connection tests recovery while preserving the machine's network settings.
  server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    requests += 1;
    if (disconnectNext) { disconnectNext = false; injectedDisconnects += 1; request.socket.destroy(); return; }
    const requestController = new AbortController();
    const abort = () => requestController.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    response.on("close", () => { if (!response.writableEnded) abort(); });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error("Provider smoke request too large");
        chunks.push(chunk);
      }
      const upstream = await fetch(`${config.baseUrl.replace(/\/+$/u, "")}/responses`, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "text/event-stream" }, body: Buffer.concat(chunks), signal: requestController.signal });
      if (upstream.ok) upstreamResponses += 1;
      else upstreamFailure = upstream.status;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) for await (const chunk of upstream.body) {
        if (response.destroyed) break;
        response.write(chunk);
      }
      response.end();
    } catch {
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end(); }
    } finally { controller.signal.removeEventListener("abort", abort); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const repository = new ResearchRepository(repositoryRoot);
  const orchestrator = new ResearchOrchestrator(repository);
  const question = "Validate reliable task continuation against a live model. This is a synthetic reliability check, not a scientific finding.";
  const { project } = await orchestrator.createProject(question, { plan: { question, tasks: Array.from({ length: steps }, (_, index) => ({ taskId: `step-${index + 1}`, title: `Reliability task ${index + 1}`, objective: `Record that checkpoint ${index + 1} was reached. Return a concise structured completed task result. No external sources, claims, experiments or tools are needed. Do not invent scientific findings.`, kind: "custom", dependsOn: index ? [`step-${index}`] : [], maxAttempts: 3 })) } });
  const options = { projectId: project.projectId, sdkHome: path.join(temp, "sdk-home"), pluginFile: path.join(root, "desktop", "dsh-sci-research-plugin.mjs"), cwd: workspace, provider: config.provider, model: config.model, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: config.apiKey, taskTimeoutMs: 90_000, maxModelSteps: 5, maxTokens: 2048, signal: controller.signal };
  const first = await runResearchWithDshAgent(orchestrator, { ...options, maxSteps: Math.floor(steps / 2) });
  assert.equal(first.status, "step-limit");
  const firstSnapshot = await repository.exportProject(project.projectId);
  completedBeforeRestart = firstSnapshot.plan.tasks.filter((task) => task.status === "completed").length;
  assert.ok(completedBeforeRestart > 0 && completedBeforeRestart < steps);
  const session = await repository.readAgentSession(project.projectId);
  assert.ok(session?.sessionId);
  console.log(JSON.stringify({ phase: "before-restart", completed: completedBeforeRestart, injectedDisconnects }));
  // Reopen both repository and SDK process, using the persisted session and active context.
  const reopened = new ResearchRepository(repositoryRoot);
  assert.ok(await reopened.readActiveContext());
  disconnectNext = true;
  const second = await runResearchWithDshAgent(new ResearchOrchestrator(reopened), { ...options, maxSteps: steps * 2 });
  assert.equal(second.status, "completed");
  const snapshot = await reopened.exportProject(project.projectId);
  assert.equal(snapshot.plan.tasks.filter((task) => task.status === "completed").length, steps);
  assert.equal((await reopened.readAgentSession(project.projectId)).sessionId, session.sessionId);
  for (const task of snapshot.plan.tasks) assert.equal(snapshot.events.filter((event) => event.type === "task-completed" && event.taskId === task.taskId).length, 1);
  assert.equal(injectedDisconnects, 2);
  assert.ok(upstreamResponses >= steps);
  succeeded = true;
} catch (error) {
  // Only fixed local assertion messages are retained; never print SDK/provider payloads.
  summary.failureKind = error?.name ?? "Error";
  summary.upstreamFailureStatus = upstreamFailure;
  summary.diagnosticsDirectory = temp;
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  Object.assign(summary, { ok: succeeded, finishedAt: new Date().toISOString(), completedBeforeRestart, requests, upstreamResponses, injectedDisconnects, verificationScope: "Live upstream model, controlled loopback disconnections, repository reopen and SDK process restart. Does not prove whole-app crash or OS network recovery." });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ...summary, report: output }));
  if (succeeded) await rm(temp, { recursive: true, force: true });
}
