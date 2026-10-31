import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Fixed allowlist only: do not persist arbitrary error messages, hosts or URLs.
function transportCode(error) {
  const allowed = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
  const pending = [error];
  for (let index = 0; index < pending.length && index < 12; index += 1) {
    const value = pending[index];
    if (!value || typeof value !== "object") continue;
    if (allowed.has(value.code)) return value.code;
    pending.push(value.cause, ...(Array.isArray(value.errors) ? value.errors.slice(0, 4) : []));
  }
  return "unclassified";
}

// Acceptance instrumentation only. No upstream headers, request contents or
// response text are logged; only statuses, durations and reported usage remain.
export async function startCaseProviderProxy({ config, budget, signal, phase = () => "agent" }) {
  const key = randomBytes(32).toString("hex");
  const state = { requests: [], deniedRequests: 0, budgetExhausted: false };
  const controllers = new Set();
  const expected = Buffer.from(`Bearer ${key}`);
  const server = createServer(async (request, response) => {
    const send = (status, message) => {
      if (!response.destroyed && !response.headersSent) response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message, type: "acceptance_boundary" } }));
    };
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected) || request.headers.origin) { send(401, "Unauthorized"); return; }
    if (request.method !== "POST" || request.url !== "/v1/responses") { send(404, "Not found"); return; }
    if (signal.aborted || state.requests.length >= budget.maxModelRequests) {
      state.deniedRequests += 1;
      state.budgetExhausted = !signal.aborted;
      send(403, "Research case request or time budget exhausted");
      return;
    }
    const entry = { number: state.requests.length + 1, phase: phase(), startedAt: new Date().toISOString(), status: null, usage: null };
    state.requests.push(entry);
    const started = Date.now();
    let failureStage = "read-client-request";
    let abortCause;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = (reason) => { if (!controller.signal.aborted) { abortCause = reason; controller.abort(); } };
    const parentAbort = () => abort("case-aborted");
    signal.addEventListener("abort", parentAbort, { once: true });
    const timer = setTimeout(() => abort("request-timeout"), budget.taskTimeoutMs);
    response.on("close", () => { if (!response.writableEnded) abort("client-disconnected"); });
    let observedText = "";
    const observe = (text) => {
      if (!text || text === "[DONE]") return;
      try {
        const value = JSON.parse(text);
        const usage = value.response?.usage ?? value.usage;
        if (usage && typeof usage === "object") {
          const number = (v) => Number.isFinite(v) && v >= 0 ? v : null;
          entry.usage = { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), totalTokens: number(usage.total_tokens), cachedInputTokens: number(usage.input_tokens_details?.cached_tokens) };
        }
      } catch { /* Partial frames and non-JSON error content are not retained. */ }
    };
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4_000_000) throw new Error("request-size");
        chunks.push(chunk);
      }
      if (signal.aborted) throw new Error("aborted");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // Also cap the planner, which has no per-request token option of its own.
      body.max_output_tokens = Math.min(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : budget.maxOutputTokensPerRequest, budget.maxOutputTokensPerRequest);
      failureStage = "upstream-connect-or-headers";
      const upstream = await fetch(`${config.baseUrl.replace(/\/+$/u, "")}/responses`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      entry.status = upstream.status;
      failureStage = "upstream-body";
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      response.writeHead(upstream.status, { "content-type": contentType });
      const streaming = contentType.includes("text/event-stream");
      const decoder = new TextDecoder();
      if (upstream.body) for await (const chunk of upstream.body) {
        if (response.destroyed) break;
        observedText += decoder.decode(chunk, { stream: true });
        if (streaming) {
          const lines = observedText.split(/\r?\n/u);
          observedText = lines.pop() ?? "";
          for (const line of lines) if (line.startsWith("data:")) observe(line.slice(5).trim());
        }
        // Bounded observation buffer; response bytes are still forwarded intact.
        if (observedText.length > 2_000_000) observedText = "";
        response.write(chunk);
      }
      observedText += decoder.decode();
      observe(streaming ? observedText.replace(/^data:\s*/u, "").trim() : observedText);
      response.end();
    } catch (error) {
      entry.failure = controller.signal.aborted ? "timeout-or-cancel" : "request-or-upstream-failure";
      entry.failureStage = failureStage;
      entry.transportCode = transportCode(error);
      if (abortCause) entry.abortCause = abortCause;
      entry.failureOrigin = entry.status === null ? "local-proxy-before-upstream-response" : "after-upstream-response";
      if (!response.headersSent) send(502, "Research case upstream request failed");
      else response.destroy();
    } finally {
      entry.durationMs = Date.now() - started;
      clearTimeout(timer);
      signal.removeEventListener("abort", parentAbort);
      controllers.delete(controller);
    }
  });
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: key, state,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
