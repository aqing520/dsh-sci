import path from "node:path";
import { AgentRuntime } from "./agent.js";
import { loadProviderSelection } from "./config.js";
import { OpenAIResponsesProvider } from "./provider.js";
import { listWorkspace, readWorkspaceFile } from "./workspace.js";
import type { PermissionMode } from "./types.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function promptArgs(): string {
  const optionsWithValues = new Set(["--workspace", "--permission", "--depth", "--read-file", "--provider", "--base-url", "--model", "--api-key"]);
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const item = process.argv[index];
    if (optionsWithValues.has(item)) {
      index += 1;
      continue;
    }
    if (item.startsWith("--")) continue;
    values.push(item);
  }
  return values.join(" ");
}

const workspace = path.resolve(arg("--workspace") ?? process.cwd());
const permissionValue = arg("--permission") ?? "read-only";
if (!["read-only", "workspace-write", "full-access"].includes(permissionValue)) {
  throw new Error(`Unsupported permission mode: ${permissionValue}`);
}
const permission = permissionValue as PermissionMode;
const prompt = promptArgs();

if (has("--help") || (!prompt && !has("--list-files") && !has("--read-file") && !has("--snapshot"))) {
  console.log("Usage: dsh-sci --workspace <path> --permission <read-only|workspace-write|full-access> <prompt>");
  console.log("       [--provider tokenfans-codex|openai|custom] [--model <model>] [--base-url <url>]");
  console.log("       dsh-sci --workspace <path> --list-files [--depth <n>]");
  console.log("       dsh-sci --workspace <path> --read-file <relative-path>");
  console.log("       dsh-sci --workspace <path> --snapshot");
  process.exit(0);
}

if (has("--list-files")) {
  const depthValue = arg("--depth");
  const depth = depthValue === undefined ? 2 : Number(depthValue);
  if (!Number.isInteger(depth) || depth < 0) throw new Error("--depth must be a non-negative integer");
  console.log(JSON.stringify(await listWorkspace(workspace, ".", depth), null, 2));
} else if (has("--read-file")) {
  const file = arg("--read-file");
  if (!file) throw new Error("--read-file requires a relative path");
  console.log(await readWorkspaceFile(workspace, file));
} else if (has("--snapshot")) {
  const runtime = new AgentRuntime({ root: workspace, permission }, new OpenAIResponsesProvider(await loadProviderSelection({ workspace })));
  console.log(await runtime.snapshot());
} else {
  const runtime = new AgentRuntime({ root: workspace, permission }, new OpenAIResponsesProvider(await loadProviderSelection({
    workspace,
    providerId: arg("--provider"),
    baseUrl: arg("--base-url"),
    model: arg("--model"),
    apiKey: arg("--api-key"),
  })));
  console.log(await runtime.run(prompt));
  console.log(`Snapshot: ${await runtime.snapshot()}`);
}
