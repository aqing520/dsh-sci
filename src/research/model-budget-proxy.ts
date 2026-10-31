import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readModelUsage, type ModelUsage } from "../model-usage.js";
import { ResearchBudgetConfigurationError, ResearchBudgetExhaustedError, ResearchBudgetPersistenceError } from "./budget.js";
import type { ResearchOrchestrator } from "./orchestrator.js";
import { ResearchStaleExecutionError } from "./result-commit.js";

const MAX_BYTES = 4_000_000;
const MAX_OBSERVATION = 2_000_000;

/** Bounded observation only; no response text or request headers enter storage. */
class UsageObserver {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private data: string[] = [];
  private dataLength = 0;
  private oversized = false;
  private skippingLine = false;
  usage?: ModelUsage;
  constructor(private readonly streaming: boolean) {}
  push(chunk: Uint8Array): void { this.consume(this.decoder.decode(chunk, { stream: true })); }
  finish(): ModelUsage | undefined {
    this.consume(this.decoder.decode());
    if (this.streaming) { if (this.buffer) this.line(this.buffer); this.flush(); }
    else if (!this.oversized) this.observe(this.buffer);
    return this.usage;
  }
  private consume(text: string): void {
    if (!this.streaming) {
      if (!this.oversized && this.buffer.length + text.length <= MAX_OBSERVATION) this.buffer += text;
      else { this.oversized = true; this.buffer = ""; }
      return;
    }
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.skippingLine) this.line(line);
      this.skippingLine = false;
    }
    if (this.buffer.length > MAX_OBSERVATION) { this.buffer = ""; this.skippingLine = true; this.oversized = true; this.data = []; }
  }
  private line(line: string): void {
    if (!line) { this.flush(); return; }
    if (!line.startsWith("data:") || this.oversized) return;
    const text = line.slice(5).replace(/^ /u, "");
    this.dataLength += text.length;
    if (this.dataLength > MAX_OBSERVATION) { this.oversized = true; this.data = []; return; }
    this.data.push(text);
  }
  private flush(): void {
    if (!this.oversized && this.data.length) this.observe(this.data.join("\n"));
    this.data = []; this.dataLength = 0; this.oversized = false;
  }
  private observe(text: string): void {
    if (text === "[DONE]") return;
    try { this.usage = readModelUsage(JSON.parse(text)) ?? this.usage; } catch { /* Malformed/partial usage is unknown. */ }
  }
}

export async function startModelBudgetProxy(orchestrator: ResearchOrchestrator, options: {
  projectId: string; baseUrl: string; apiKey: string; timeoutMs?: number; maxOutputTokens?: number; signal?: AbortSignal;
}) {
  const token = randomBytes(32).toString("hex");
  const route = `/${randomBytes(16).toString("hex")}`;
  const upstreamUrl = new URL(`${options.baseUrl.replace(/\/+$/u, "")}/responses`);
  if (!["http:", "https:"].includes(upstreamUrl.protocol) || upstreamUrl.username || upstreamUrl.password) throw new Error("Invalid model provider URL");
  const expected = Buffer.from(`Bearer ${token}`);
  const controllers = new Set<AbortController>();
  const operations = new Set<Promise<void>>();
  let closed = false;
  let fatalError: Error | undefined;
  let budgetError: ResearchBudgetExhaustedError | undefined;
  const timeoutMs = Math.max(1_000, Math.min(30 * 60_000, options.timeoutMs ?? 120_000));
  const maxTokens = Math.max(1, Math.min(100_000, Math.floor(options.maxOutputTokens ?? 8_192)));
  const send = (response: ServerResponse, status: number, message: string) => {
    if (!response.destroyed && !response.headersSent) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: { type: "research_model_boundary", message } }));
  };
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected) || request.headers.origin !== undefined) { send(response, 401, "Unauthorized"); return; }
    if (closed || request.method !== "POST" || request.url !== `${route}/responses`) { send(response, 404, "Not found"); return; }
    if (budgetError) { send(response, 403, budgetError.message); return; }
    if (fatalError) { send(response, 503, "Research model accounting unavailable"); return; }
    if (controllers.size >= 4) { send(response, 429, "Too many concurrent research requests"); return; }
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { abort(); if (!response.headersSent) send(response, 504, "Research model request timed out"); else response.destroy(); request.destroy(); }, timeoutMs);
    response.on("close", () => { if (!response.writableEnded) abort(); });
    let reservationId: string | undefined;
    let observer: UsageObserver | undefined;
    let settled = false;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { send(response, 413, "Model request too large"); return; }
        chunks.push(Buffer.from(chunk));
      }
      controller.signal.throwIfAborted();
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(response, 400, "Invalid JSON model request"); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { send(response, 400, "Invalid model request"); return; }
      body.max_output_tokens = Math.min(typeof body.max_output_tokens === "number" && Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : maxTokens, maxTokens);
      const project = await orchestrator.repository.readProject(options.projectId);
      const plan = project?.planId ? await orchestrator.repository.readPlan(options.projectId, project.planId) : undefined;
      const task = plan?.tasks.find((item) => item.taskId === project?.activeTaskId);
      if (!task) throw new ResearchBudgetConfigurationError("No active research task for model request");
      reservationId = await orchestrator.reserveModelRequest(options.projectId, { phase: "task", planId: task.planId, taskId: task.taskId, attemptId: task.attemptId });
      controller.signal.throwIfAborted();
      const upstream = await fetch(upstreamUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json", authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(body), signal: controller.signal });
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      observer = new UsageObserver(contentType.includes("text/event-stream"));
      if (upstream.ok) response.writeHead(upstream.status, { "content-type": contentType.includes("text/event-stream") ? "text/event-stream" : "application/json", "cache-control": "no-store" });
      if (upstream.body) for await (const chunk of upstream.body) {
        observer.push(chunk);
        if (upstream.ok && !response.destroyed && !response.write(chunk)) await once(response, "drain", { signal: controller.signal });
      }
      const usage = observer.finish();
      await orchestrator.recordModelUsage(options.projectId, reservationId, usage);
      settled = true;
      if (upstream.ok) response.end();
      else send(response, upstream.status, `Research model provider returned HTTP ${upstream.status}`);
    } catch (error) {
      if (error instanceof ResearchBudgetExhaustedError) { budgetError = error; send(response, 403, error.message); }
      else if (error instanceof ResearchBudgetPersistenceError) { fatalError = error; if (response.headersSent) response.destroy(); else send(response, 503, error.message); }
      else if (error instanceof ResearchStaleExecutionError) { if (response.headersSent) response.destroy(); else send(response, 409, error.message); }
      else if (error instanceof ResearchBudgetConfigurationError) { fatalError = error; if (response.headersSent) response.destroy(); else send(response, 403, error.message); }
      else if (!response.headersSent) send(response, controller.signal.aborted ? 504 : 502, "Research model upstream request failed");
      else response.destroy();
    } finally {
      if (reservationId && !settled && !fatalError) {
        try { await orchestrator.recordModelUsage(options.projectId, reservationId, observer?.finish()); }
        catch (error) { fatalError = error instanceof Error ? error : new ResearchBudgetPersistenceError(); }
      }
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controllers.delete(controller);
    }
  }
  const server = createServer((request, response) => {
    const operation = handle(request, response).catch(() => { fatalError = new ResearchBudgetPersistenceError(); response.destroy(); });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  server.requestTimeout = timeoutMs;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model budget proxy has no address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}${route}`, apiKey: token,
    cancelActiveRequests(): void { for (const controller of controllers) controller.abort(); },
    async waitForIdle(): Promise<void> { await Promise.all([...operations]); if (fatalError) throw fatalError; if (budgetError) throw budgetError; },
    async close(): Promise<void> {
      closed = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.all([...operations]);
    }
  };
}
