import type { PathLike } from "node:fs";

export type PermissionMode = "read-only" | "workspace-write" | "full-access";

export type ToolName = "list_files" | "read_file" | "write_file" | "run_command";

export interface WorkspaceConfig {
  root: string;
  permission: PermissionMode;
  stateRoot?: string;
  commandTimeoutMs?: number;
}

export interface ToolCall {
  name: ToolName;
  arguments: Record<string, unknown>;
  callId?: string;
}

export interface ToolResult {
  name: ToolName;
  ok: boolean;
  output: string;
  error?: string;
}

export interface AgentEvent {
  type: "user/message" | "assistant/message" | "tool/call" | "tool/result" | "turn/end";
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export interface ModelProvider {
  respond(input: {
    messages: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
}

export type FilePath = PathLike;
