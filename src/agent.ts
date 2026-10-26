import { randomUUID } from "node:crypto";
import { CaptureStore } from "./capture.js";
import { executeTool } from "./tools.js";
import { toolSchemas } from "./provider.js";
import type { AgentEvent, ModelProvider, WorkspaceConfig } from "./types.js";

export class AgentRuntime {
  readonly sessionId = randomUUID();
  private readonly capture: CaptureStore;
  constructor(private readonly config: WorkspaceConfig, private readonly provider: ModelProvider) {
    this.capture = new CaptureStore(config.stateRoot ?? `${config.root}/.dsh-sci`);
  }

  async run(prompt: string, maxSteps = 12): Promise<string> {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }];
    await this.event({ type: "user/message", data: { content: prompt } });
    let finalText = "";
    for (let step = 0; step < maxSteps; step += 1) {
      const response = await this.provider.respond({ messages, tools: toolSchemas() });
      if (response.text) {
        finalText += response.text;
        messages.push({ role: "assistant", content: response.text });
        await this.event({ type: "assistant/message", data: { content: response.text, step } });
      }
      if (response.toolCalls.length === 0) break;
      for (const call of response.toolCalls) {
        await this.event({ type: "tool/call", data: call as unknown as Record<string, unknown> });
        if (call.callId) {
          messages.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) });
        }
        const result = await executeTool(this.config, call);
        await this.event({ type: "tool/result", data: result as unknown as Record<string, unknown> });
        const output = result.ok ? result.output : `ERROR: ${result.error}`;
        if (call.callId) {
          messages.push({ type: "function_call_output", call_id: call.callId, output });
        } else {
          messages.push({ role: "tool", name: result.name, content: output });
        }
      }
    }
    await this.event({ type: "turn/end", data: { sessionId: this.sessionId } });
    return finalText;
  }

  async snapshot(): Promise<string> {
    return (await this.capture.snapshot(this.config.root)).snapshotId;
  }

  private async event(input: Pick<AgentEvent, "type" | "data">): Promise<void> {
    await this.capture.appendEvent(this.sessionId, { ...input, timestamp: new Date().toISOString() });
  }
}
