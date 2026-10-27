import { readFile } from "node:fs/promises";
import path from "node:path";

async function readDotEnv(workspace: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(path.join(workspace, ".env.local"), "utf8");
    const values: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return values;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function readJsonConfig(file: string | undefined): Promise<Record<string, string>> {
  if (!file) return {};
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Record<string, string>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadTokenFansApiKey(options: {
  workspace: string;
  configFile?: string;
}): Promise<string | undefined> {
  const candidates = options.configFile ? [options.configFile] : [
    path.join(options.workspace, "dsh-sci.config.json"),
    path.join(options.workspace, "config", "dsh-sci.config.json"),
    path.join(process.cwd(), "dsh-sci.config.json"),
  ];
  let fileConfig: Record<string, string> = {};
  for (const candidate of candidates) {
    fileConfig = await readJsonConfig(candidate);
    if (Object.keys(fileConfig).length > 0) break;
  }
  const dotEnv = await readDotEnv(options.workspace);
  const env = { ...fileConfig, ...dotEnv, ...process.env };
  return env.DSH_SCI_API_KEY ?? env.DSH_SCI_TOKENFANS_API_KEY ?? env.apiKey;
}
