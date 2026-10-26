import https from "node:https";
import type { ModelProvider, ModelResponse, ToolCall } from "./types.js";

export interface ProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
}

async function requestWithHttps(url: string, body: string, apiKey: string): Promise<JsonResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        accept: "application/json",
        "user-agent": "dsh-sci/0.1.0",
      },
      timeout: 120_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
          status: response.statusCode ?? 500,
          async json() {
            try { return JSON.parse(text) as Record<string, unknown>; }
            catch { return { error: { message: text || "Empty response" } }; }
          },
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Request timed out after 120 seconds")));
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function requestJson(url: string, body: string, apiKey: string, signal?: AbortSignal): Promise<JsonResponse> {
  try {
    return await fetch(url, {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
      body,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    try {
      return await requestWithHttps(url, body, apiKey);
    } catch (fallbackError: unknown) {
      const fallbackDetail = fallbackError instanceof Error ? `${fallbackError.name}: ${fallbackError.message}` : String(fallbackError);
      throw new Error(`Network request failed. fetch=${detail}; https=${fallbackDetail}`);
    }
  }
}

export class OpenAIResponsesProvider implements ModelProvider {
  constructor(private readonly options: ProviderOptions) {}

  async respond(input: { messages: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>>; signal?: AbortSignal }): Promise<ModelResponse> {
    if (!this.options.apiKey) {
      return { text: "未配置模型 API Key。当前仍可使用本地工作区检查和快照功能。", toolCalls: [] };
    }
    const endpoint = `${this.options.baseUrl.replace(/\/$/, "")}/responses`;
    const requestBody = JSON.stringify({ model: this.options.model, input: input.messages, tools: input.tools, stream: false });
    const response = await requestJson(endpoint, requestBody, this.options.apiKey, input.signal);
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${JSON.stringify(body)}`);
    const output = Array.isArray(body.output) ? body.output : [];
    const text = output.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as Record<string, unknown>).content;
      return Array.isArray(content) ? content.flatMap((part) => typeof part === "object" && part && "text" in part ? [String((part as Record<string, unknown>).text)] : []) : [];
    }).join("");
    const toolCalls: ToolCall[] = output.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (row.type !== "function_call" || typeof row.name !== "string") return [];
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(row.arguments ?? "{}")); } catch { /* model error is surfaced as empty args */ }
      return [{
        name: row.name as ToolCall["name"],
        arguments: args,
        callId: typeof row.call_id === "string" ? row.call_id : typeof row.id === "string" ? row.id : undefined,
      }];
    });
    return { text, toolCalls, raw: body };
  }
}

export function toolSchemas(): Array<Record<string, unknown>> {
  return [
    { type: "function", name: "list_files", description: "List workspace files", parameters: { type: "object", properties: { relative: { type: "string" }, depth: { type: "integer" } } } },
    { type: "function", name: "read_file", description: "Read a UTF-8 text file in the workspace", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
    { type: "function", name: "write_file", description: "Write a UTF-8 file", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
    { type: "function", name: "run_command", description: "Run a command in the workspace", parameters: { type: "object", required: ["command"], properties: { command: { type: "string" } } } },
  ];
}
